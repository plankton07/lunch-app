using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddSignalR();
builder.Services.AddHttpClient();

builder.Services.AddSingleton<RoomService>();
builder.Services.AddSingleton<YogiyoMenuImportService>();

var app = builder.Build();
app.Urls.Add("http://0.0.0.0:5268");

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapControllers();

// 👉 SignalR 연결
app.MapHub<UpdateHub>("/hub");

app.Run();
