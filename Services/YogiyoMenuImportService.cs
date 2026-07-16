using System.Net;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

public sealed class YogiyoMenuImportService : IAsyncDisposable
{
    private const int MaxAttempts = 3;
    private static readonly TimeSpan ImportCooldown = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan NavigationTimeout = TimeSpan.FromSeconds(8);
    private readonly SemaphoreSlim _importGate = new(1, 1);
    private readonly SemaphoreSlim _browserGate = new(1, 1);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastImportByUrl = new();
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task<YogiyoMenuImportResult> ImportAsync(Uri link, CancellationToken cancellationToken)
    {
        await _importGate.WaitAsync(cancellationToken);

        try
        {
            var now = DateTimeOffset.UtcNow;
            if (_lastImportByUrl.TryGetValue(link.AbsoluteUri, out var lastImport) && now - lastImport < ImportCooldown)
            {
                var remainingSeconds = Math.Ceiling((ImportCooldown - (now - lastImport)).TotalSeconds);
                throw new YogiyoMenuImportException(429, $"메뉴 수집은 30초에 한 번만 요청할 수 있습니다. {remainingSeconds}초 후 다시 시도해 주세요.");
            }

            _lastImportByUrl[link.AbsoluteUri] = now;
            Exception? lastException = null;

            for (var attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                try
                {
                    var items = await ImportOnceAsync(link, cancellationToken);
                    return new YogiyoMenuImportResult(items, attempt);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (PlaywrightException exception)
                {
                    lastException = exception;
                }
                catch (TimeoutException exception)
                {
                    lastException = exception;
                }

                if (attempt < MaxAttempts)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt), cancellationToken);
                }
            }

            throw new YogiyoMenuImportException(
                502,
                $"요기요 메뉴를 {MaxAttempts}회 시도했지만 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
                lastException);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        finally
        {
            _importGate.Release();
        }
    }

    private async Task<IReadOnlyList<YogiyoMenuItem>> ImportOnceAsync(Uri link, CancellationToken cancellationToken)
    {
        var browser = await GetBrowserAsync();
        await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            Locale = "ko-KR",
            ViewportSize = new ViewportSize { Width = 390, Height = 844 },
            UserAgent = "LunchApp Menu Importer/1.0"
        });

        await context.RouteAsync("**/*", async route =>
        {
            var type = route.Request.ResourceType;
            if (type is "image" or "media" or "font")
            {
                await route.AbortAsync();
                return;
            }

            await route.ContinueAsync();
        });

        var responseBodies = new List<string>();
        var page = await context.NewPageAsync();
        page.SetDefaultNavigationTimeout((float)NavigationTimeout.TotalMilliseconds);
        page.SetDefaultTimeout((float)NavigationTimeout.TotalMilliseconds);

        page.Response += async (_, response) =>
        {
            if (!response.Url.Contains("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
                !response.Headers.TryGetValue("content-type", out var contentType) ||
                !contentType.Contains("application/json", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            try
            {
                var body = await response.TextAsync();
                if (body.Length <= 1_000_000)
                {
                    responseBodies.Add(body);
                }
            }
            catch (PlaywrightException)
            {
            }
        };

        await page.GotoAsync(link.ToString(), new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = (float)NavigationTimeout.TotalMilliseconds
        });
        await page.WaitForTimeoutAsync(800);

        if (!IsYogiyoUrl(page.Url))
        {
            throw new PlaywrightException("요기요 링크가 아닌 페이지로 이동했습니다.");
        }

        var pageContent = await page.ContentAsync();
        var pageText = await page.Locator("body").InnerTextAsync();
        var items = ExtractMenuCandidates([pageContent, pageText, .. responseBodies])
            .Take(50)
            .ToList();

        return items;
    }

    private async Task<IBrowser> GetBrowserAsync()
    {
        if (_browser?.IsConnected == true)
        {
            return _browser;
        }

        await _browserGate.WaitAsync();
        try
        {
            if (_browser?.IsConnected == true)
            {
                return _browser;
            }

            _playwright ??= await Playwright.CreateAsync();
            _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true
            });
            return _browser;
        }
        finally
        {
            _browserGate.Release();
        }
    }

    private static bool IsYogiyoUrl(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var url) &&
               url.Scheme == Uri.UriSchemeHttps &&
               (url.Host.Equals("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
                url.Host.EndsWith(".yogiyo.co.kr", StringComparison.OrdinalIgnoreCase));
    }

    private static IEnumerable<YogiyoMenuItem> ExtractMenuCandidates(IEnumerable<string> sources)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var source in sources)
        {
            foreach (Match match in Regex.Matches(source,
                         "(?:\\\"name\\\"|\\\"menuName\\\"|\\\"title\\\")\\s*:\\s*\\\"(?<name>(?:\\\\.|[^\\\"])*)\\\"[^{}]{0,500}?(?:\\\"price\\\"|\\\"basePrice\\\"|\\\"amount\\\")\\s*:\\s*\\\"?(?<price>\\d{3,7})\\\"?",
                         RegexOptions.IgnoreCase))
            {
                var name = DecodeJsonString(match.Groups["name"].Value);
                if (int.TryParse(match.Groups["price"].Value, out var price) && IsMenuCandidate(name, price) && seen.Add($"{name}\0{price}"))
                {
                    yield return new YogiyoMenuItem(name, price);
                }
            }

            foreach (Match match in Regex.Matches(source,
                         @"(?<name>[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s·+&()\-]{1,50})\s*(?:<[^>]+>\s*){0,3}(?<price>[1-9]\d{2,6})\s*원",
                         RegexOptions.IgnoreCase))
            {
                var name = WebUtility.HtmlDecode(match.Groups["name"].Value).Trim();
                if (int.TryParse(match.Groups["price"].Value, out var price) && IsMenuCandidate(name, price) && seen.Add($"{name}\0{price}"))
                {
                    yield return new YogiyoMenuItem(name, price);
                }
            }
        }
    }

    private static string DecodeJsonString(string value)
    {
        try
        {
            return JsonSerializer.Deserialize<string>($"\"{value}\"")?.Trim() ?? string.Empty;
        }
        catch (JsonException)
        {
            return value.Trim();
        }
    }

    private static bool IsMenuCandidate(string name, int price)
    {
        return name.Length is >= 2 and <= 60 && price is >= 500 and <= 1_000_000;
    }

    public async ValueTask DisposeAsync()
    {
        if (_browser != null)
        {
            await _browser.DisposeAsync();
        }

        _playwright?.Dispose();
        _importGate.Dispose();
        _browserGate.Dispose();
    }
}

public sealed record YogiyoMenuItem(string Name, int Price);
public sealed record YogiyoMenuImportResult(IReadOnlyList<YogiyoMenuItem> Items, int Attempts);

public sealed class YogiyoMenuImportException : Exception
{
    public YogiyoMenuImportException(int statusCode, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        StatusCode = statusCode;
    }

    public int StatusCode { get; }
}
