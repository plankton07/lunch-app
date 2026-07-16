using System.Text.RegularExpressions;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;

[ApiController]
[Route("api/[controller]")]
public class RoomsController : ControllerBase
{
    private readonly RoomService _service;
    private readonly IHubContext<UpdateHub> _hub;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly YogiyoMenuImportService _yogiyoMenuImportService;

    public RoomsController(
        RoomService service,
        IHubContext<UpdateHub> hub,
        IHttpClientFactory httpClientFactory,
        YogiyoMenuImportService yogiyoMenuImportService)
    {
        _service = service;
        _hub = hub;
        _httpClientFactory = httpClientFactory;
        _yogiyoMenuImportService = yogiyoMenuImportService;
    }

    // 이름 유효성 검사 (한글, 영문, 공백만 허용)
    private bool IsValidName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        return Regex.IsMatch(name, @"^[a-zA-Z가-힣ㄱ-ㅎㅏ-ㅣ\s]+$");
    }

    private bool TryGetOwnerToken(out string ownerToken)
    {
        ownerToken = Request.Headers["X-Order-Owner"].ToString().Trim();
        return Guid.TryParse(ownerToken, out _);
    }

    // ================= 방 목록 =================
    [HttpGet]
    public IActionResult GetAll()
    {
        return Ok(_service.GetAll());
    }

    // ================= 방 조회 =================
    [HttpGet("{id}")]
    public IActionResult Get(string id)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        var hasOwnerToken = TryGetOwnerToken(out var ownerToken);
        return Ok(new
        {
            room.Id,
            room.Title,
            room.Host,
            room.Link,
            room.DeliveryFee,
            room.CouponDiscount,
            room.IsOrderClosed,
            Participants = room.Participants.Select(participant => new
            {
                participant.Id,
                participant.Name,
                participant.Menu,
                participant.Amount,
                participant.Donation,
                participant.Paid,
                CanManage = hasOwnerToken && string.Equals(participant.OwnerToken, ownerToken, StringComparison.Ordinal)
            })
        });
    }

    // ================= 요기요 링크 미리보기 =================
    [HttpGet("{id}/yogiyo-preview")]
    public async Task<IActionResult> GetYogiyoPreview(string id)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (!Uri.TryCreate(room.Link, UriKind.Absolute, out var link) ||
            link.Scheme != Uri.UriSchemeHttps ||
            !(link.Host.Equals("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
              link.Host.EndsWith(".yogiyo.co.kr", StringComparison.OrdinalIgnoreCase)))
        {
            return BadRequest("유효한 요기요 HTTPS 링크가 필요합니다.");
        }

        try
        {
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 5,
                AutomaticDecompression = DecompressionMethods.All
            };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
            using var request = new HttpRequestMessage(HttpMethod.Get, link);
            request.Headers.UserAgent.ParseAdd("LunchApp/1.0 link-preview");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

            var finalUrl = response.RequestMessage?.RequestUri;
            if (finalUrl == null || finalUrl.Scheme != Uri.UriSchemeHttps ||
                !(finalUrl.Host.Equals("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
                  finalUrl.Host.EndsWith(".yogiyo.co.kr", StringComparison.OrdinalIgnoreCase)))
            {
                return BadRequest("요기요 링크가 아닌 페이지로 이동했습니다.");
            }

            if (!response.IsSuccessStatusCode)
            {
                return StatusCode((int)response.StatusCode, "요기요 페이지 정보를 불러오지 못했습니다.");
            }

            if (response.Content.Headers.ContentLength is > 1_000_000)
            {
                return BadRequest("미리보기 페이지가 너무 큽니다.");
            }

            var html = await response.Content.ReadAsStringAsync();
            var title = GetMetaValue(html, "og:title") ?? GetTitle(html) ?? "요기요 주문 페이지";
            var description = GetMetaValue(html, "og:description") ?? GetMetaValue(html, "description");
            var image = GetMetaValue(html, "og:image");

            return Ok(new { title, description, image, url = room.Link });
        }
        catch (HttpRequestException)
        {
            return StatusCode(502, "요기요 페이지 연결에 실패했습니다.");
        }
        catch (TaskCanceledException)
        {
            return StatusCode(504, "요기요 페이지 응답 시간이 초과되었습니다.");
        }
    }

    // ================= 공개 페이지 메뉴 후보 추출 =================
    [HttpGet("{id}/yogiyo-menu-candidates")]
    public async Task<IActionResult> GetYogiyoMenuCandidates(string id)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (!Uri.TryCreate(room.Link, UriKind.Absolute, out var link) ||
            link.Scheme != Uri.UriSchemeHttps ||
            !(link.Host.Equals("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
              link.Host.EndsWith(".yogiyo.co.kr", StringComparison.OrdinalIgnoreCase)))
        {
            return BadRequest("유효한 요기요 HTTPS 링크가 필요합니다.");
        }

        try
        {
            var result = await _yogiyoMenuImportService.ImportAsync(link, HttpContext.RequestAborted);
            return Ok(new { items = result.Items, attempts = result.Attempts });
        }
        catch (YogiyoMenuImportException exception)
        {
            return StatusCode(exception.StatusCode, exception.Message);
        }
    }

    private static async Task<string> GetYogiyoHtml(Uri link)
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            AutomaticDecompression = DecompressionMethods.All
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        using var request = new HttpRequestMessage(HttpMethod.Get, link);
        request.Headers.UserAgent.ParseAdd("LunchApp/1.0 menu-preview");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

        var finalUrl = response.RequestMessage?.RequestUri;
        if (finalUrl == null || finalUrl.Scheme != Uri.UriSchemeHttps ||
            !(finalUrl.Host.Equals("yogiyo.co.kr", StringComparison.OrdinalIgnoreCase) ||
              finalUrl.Host.EndsWith(".yogiyo.co.kr", StringComparison.OrdinalIgnoreCase)))
        {
            throw new HttpRequestException("요기요 링크가 아닌 페이지로 이동했습니다.");
        }

        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > 1_000_000)
        {
            throw new HttpRequestException("미리보기 페이지가 너무 큽니다.");
        }

        return await response.Content.ReadAsStringAsync();
    }

    private static IEnumerable<object> ExtractMenuCandidates(string html)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (Match match in Regex.Matches(html,
                     "(?:\\\"name\\\"|\\\"menuName\\\"|\\\"title\\\")\\s*:\\s*\\\"(?<name>(?:\\\\.|[^\\\"])*)\\\"[^{}]{0,500}?(?:\\\"price\\\"|\\\"basePrice\\\"|\\\"amount\\\")\\s*:\\s*\\\"?(?<price>\\d{3,7})\\\"?",
                     RegexOptions.IgnoreCase))
        {
            var name = DecodeJsonString(match.Groups["name"].Value);
            if (int.TryParse(match.Groups["price"].Value, out var price) && IsMenuCandidate(name, price) && seen.Add($"{name}\0{price}"))
            {
                yield return new { name, price };
            }
        }

        foreach (Match match in Regex.Matches(html,
                     @"(?<name>[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s·+&()\-]{1,50})\s*(?:<[^>]+>\s*){0,3}(?<price>[1-9]\d{2,6})\s*원",
                     RegexOptions.IgnoreCase))
        {
            var name = WebUtility.HtmlDecode(match.Groups["name"].Value).Trim();
            if (int.TryParse(match.Groups["price"].Value, out var price) && IsMenuCandidate(name, price) && seen.Add($"{name}\0{price}"))
            {
                yield return new { name, price };
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

    private static string? GetMetaValue(string html, string property)
    {
        var escapedProperty = Regex.Escape(property);
        var match = Regex.Match(html,
            "<meta\\s+[^>]*(?:property|name)\\s*=\\s*['\\\"]" + escapedProperty + "['\\\"][^>]*content\\s*=\\s*['\\\"](?<value>[^'\\\"]+)['\\\"][^>]*>",
            RegexOptions.IgnoreCase);

        match = match.Success ? match : Regex.Match(html,
            "<meta\\s+[^>]*content\\s*=\\s*['\\\"](?<value>[^'\\\"]+)['\\\"][^>]*(?:property|name)\\s*=\\s*['\\\"]" + escapedProperty + "['\\\"][^>]*>",
            RegexOptions.IgnoreCase);

        return match.Success ? WebUtility.HtmlDecode(match.Groups["value"].Value).Trim() : null;
    }

    private static string? GetTitle(string html)
    {
        var match = Regex.Match(html, @"<title[^>]*>(?<value>.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return match.Success ? WebUtility.HtmlDecode(match.Groups["value"].Value).Trim() : null;
    }

    // ================= 방 생성 =================
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRoomRequest req)
    {
        if (!IsValidName(req.Title))
        {
            return BadRequest("방 이름은 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (!IsValidName(req.Host))
        {
            return BadRequest("방장 이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (!Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("삭제 비밀번호는 숫자 4자리여야 합니다.");
        }

        var room = new Room
        {
            Title = req.Title,
            Host = req.Host,
            Link = req.Link,
            DeletePassword = req.Password
        };

        _service.GetAll().Add(room);

        await _hub.Clients.All.SendAsync("Update");

        return Ok(room);
    }

    // ================= 참여 =================
    [HttpPost("{id}/join")]
    public async Task<IActionResult> Join(string id, [FromBody] Participant p)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();
        if (room.IsOrderClosed) return StatusCode(409, "주문이 마감되어 새 주문을 추가할 수 없습니다.");
        if (!TryGetOwnerToken(out var ownerToken)) return BadRequest("주문 소유자 정보가 필요합니다.");

        if (!IsValidName(p.Name))
        {
            return BadRequest("참여자 이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (p.Amount <= 0)
        {
            return BadRequest("주문 금액은 0보다 커야 합니다.");
        }
        if (p.Donation < 0)
        {
            return BadRequest("기부 금액은 0원 이상이어야 합니다.");
        }

        var participant = new Participant
        {
            Name = p.Name,
            Menu = p.Menu,
            Amount = p.Amount,
            Donation = p.Donation,
            OwnerToken = ownerToken
        };
        room.Participants.Add(participant);

        await _hub.Clients.All.SendAsync("Update");

        return Ok(new { participant.Id });
    }

    // ================= 참가자 개별 수정 =================
    [HttpPut("{id}/participants/{pid}")]
    public async Task<IActionResult> UpdateParticipant(string id, string pid, [FromBody] Participant updated)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();
        if (room.IsOrderClosed) return StatusCode(409, "주문이 마감되어 주문을 수정할 수 없습니다.");

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();
        if (!TryGetOwnerToken(out var ownerToken) || !string.Equals(p.OwnerToken, ownerToken, StringComparison.Ordinal))
        {
            return StatusCode(403, "본인이 추가한 주문만 수정할 수 있습니다.");
        }

        if (!IsValidName(updated.Name))
        {
            return BadRequest("이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (updated.Amount <= 0)
        {
            return BadRequest("주문 금액은 0보다 커야 합니다.");
        }
        if (updated.Donation < 0)
        {
            return BadRequest("기부 금액은 0원 이상이어야 합니다.");
        }

        p.Name = updated.Name;
        p.Menu = updated.Menu;
        p.Amount = updated.Amount;
        p.Donation = updated.Donation;

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 참가자 개별 삭제 =================
    [HttpDelete("{id}/participants/{pid}")]
    public async Task<IActionResult> DeleteParticipant(string id, string pid)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();
        if (room.IsOrderClosed) return StatusCode(409, "주문이 마감되어 주문을 삭제할 수 없습니다.");

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();
        if (!TryGetOwnerToken(out var ownerToken) || !string.Equals(p.OwnerToken, ownerToken, StringComparison.Ordinal))
        {
            return StatusCode(403, "본인이 추가한 주문만 삭제할 수 있습니다.");
        }

        room.Participants.Remove(p);

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 체크 =================
    [HttpPost("{id}/toggle/{pid}")]
    public async Task<IActionResult> Toggle(string id, string pid)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();
        if (!TryGetOwnerToken(out var ownerToken) || !string.Equals(p.OwnerToken, ownerToken, StringComparison.Ordinal))
        {
            return StatusCode(403, "본인이 추가한 주문만 입금 상태를 변경할 수 있습니다.");
        }

        p.Paid = !p.Paid;

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 요기요 정산 설정 =================
    [HttpPut("{id}/settlement")]
    public async Task<IActionResult> UpdateSettlement(string id, [FromBody] SettlementRequest req)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (req == null || !Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("관리 비밀번호는 숫자 4자리여야 합니다.");
        }

        if (!string.Equals(room.DeletePassword, req.Password, StringComparison.Ordinal))
        {
            return StatusCode(403, "관리 비밀번호가 일치하지 않습니다.");
        }

        if (req.DeliveryFee < 0 || req.CouponDiscount < 0)
        {
            return BadRequest("배달비와 쿠폰 할인은 0원 이상이어야 합니다.");
        }

        room.DeliveryFee = req.DeliveryFee;
        room.CouponDiscount = req.CouponDiscount;

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 주문 마감 관리 =================
    [HttpPut("{id}/order-closing")]
    public async Task<IActionResult> UpdateOrderClosing(string id, [FromBody] OrderClosingRequest req)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (req == null || !Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("관리 비밀번호는 숫자 4자리여야 합니다.");
        }

        if (!string.Equals(room.DeletePassword, req.Password, StringComparison.Ordinal))
        {
            return StatusCode(403, "관리 비밀번호가 일치하지 않습니다.");
        }

        room.IsOrderClosed = req.IsOrderClosed;
        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 삭제 =================
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, [FromBody] DeleteRoomRequest req)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (req == null || !Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("삭제 비밀번호는 숫자 4자리여야 합니다.");
        }

        if (!string.Equals(room.DeletePassword, req.Password, StringComparison.Ordinal))
        {
            return StatusCode(403, "삭제 비밀번호가 일치하지 않습니다.");
        }

        _service.Delete(id);

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }
}
