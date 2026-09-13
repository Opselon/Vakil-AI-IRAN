using System.Text.Json;
using VakilAI.Application.Contracts;
using VakilAI.Infrastructure.Api;
using Xunit;

namespace VakilAI.Core.Tests;

/// <summary>
/// Base-address validation + the camelCase JSON contract the server (server/src/app_api.js /
/// dist/worker.js) reads: body.token, body.text, body.imageBase64, body.audioBase64.
/// </summary>
public class HttpFactoryTests
{
    // ────────────────────────────── ResolveBaseUrl ──────────────────────────────

    [Fact]
    public void ResolveBaseUrl_Null_FallsBackToHttpsDefault()
        => Assert.Equal(HttpClientFactory.DefaultBaseUrl, HttpClientFactory.ResolveBaseUrl(null));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveBaseUrl_Blank_FallsBackToHttpsDefault(string configured)
        => Assert.Equal(HttpClientFactory.DefaultBaseUrl, HttpClientFactory.ResolveBaseUrl(configured));

    [Fact]
    public void ResolveBaseUrl_Default_IsHttpsAndSlashTerminated()
    {
        Assert.Equal("https://vakil-app.samerkhaldounmarefi.workers.dev/", HttpClientFactory.DefaultBaseUrl);
        Assert.EndsWith("/", HttpClientFactory.ResolveBaseUrl(null));
    }

    [Fact]
    public void ResolveBaseUrl_AppendsTrailingSlash()
        => Assert.Equal("https://api.example.com/", HttpClientFactory.ResolveBaseUrl("https://api.example.com"));

    [Fact]
    public void ResolveBaseUrl_KeepsSingleTrailingSlash()
        => Assert.Equal("https://api.example.com/v1/", HttpClientFactory.ResolveBaseUrl("https://api.example.com/v1/"));

    [Fact]
    public void ResolveBaseUrl_TrimsSurroundingWhitespace()
        => Assert.Equal("https://api.example.com/", HttpClientFactory.ResolveBaseUrl("  https://api.example.com  "));

    [Theory]
    [InlineData("http://api.example.com/")]        // plaintext rejected (defense-in-depth)
    [InlineData("http://localhost:8787")]
    [InlineData("ftp://files.example.com/")]
    [InlineData("garbage")]
    [InlineData("://nope")]
    [InlineData("https://")]                       // scheme-only is not absolute-usable
    [InlineData("javascript:alert(1)")]
    public void ResolveBaseUrl_RejectsNonHttpsOrGarbage(string configured)
        => Assert.Throws<InvalidOperationException>(() => HttpClientFactory.ResolveBaseUrl(configured));

    // ───────────────────────────────── Create() ─────────────────────────────────

    [Fact]
    public void Create_WiresResolvedBaseAddressAndDefaults()
    {
        using var client = HttpClientFactory.Create("https://vakil-ai.workers.dev");
        Assert.Equal(new Uri("https://vakil-ai.workers.dev/"), client.BaseAddress);
        Assert.Equal(Timeout.InfiniteTimeSpan, client.Timeout); // per-call CTS governs
        Assert.Equal(new Version(2, 0), client.DefaultRequestVersion);
        Assert.Contains("application/json", client.DefaultRequestHeaders.Accept.Select(v => v.MediaType));
        Assert.Contains("gzip", client.DefaultRequestHeaders.AcceptEncoding.Select(v => v.Value));
        Assert.Contains("br", client.DefaultRequestHeaders.AcceptEncoding.Select(v => v.Value));
    }

    [Fact]
    public void Create_RejectsHttpConfiguredUrl()
        => Assert.Throws<InvalidOperationException>(() => HttpClientFactory.Create("http://insecure.example/"));

    // ─────────────────────────── JSON wire contract ───────────────────────────

    [Fact]
    public void ChatRequest_Serializes_WithServerFieldNames_AndOmitsNulls()
    {
        var json = JsonSerializer.Serialize(new ChatRequest("tk", "سوال"), AppApiClient.JsonOpts);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("token", out var t));   // server: body.token
        Assert.Equal("tk", t.GetString());
        Assert.True(root.TryGetProperty("text", out _));         // server: body.text
        Assert.False(root.TryGetProperty("imageBase64", out _)); // nulls omitted → hasImage=false on server
        Assert.False(root.TryGetProperty("imageMime", out _));
        Assert.False(root.TryGetProperty("audioBase64", out _));
        Assert.False(root.TryGetProperty("audioMime", out _));
    }

    [Fact]
    public void ChatRequest_ImagePayload_UsesImageBase64FieldName()
    {
        var json = JsonSerializer.Serialize(
            new ChatRequest("tk", "caption", ImageBase64: "AAb=", ImageMime: "image/jpeg"),
            AppApiClient.JsonOpts);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("AAb=", doc.RootElement.GetProperty("imageBase64").GetString()); // server: body.imageBase64
        Assert.Equal("image/jpeg", doc.RootElement.GetProperty("imageMime").GetString());
    }

    [Fact]
    public void ChatRequest_AudioPayload_UsesAudioBase64FieldName()
    {
        var json = JsonSerializer.Serialize(
            new ChatRequest("tk", "", AudioBase64: "AAI=", AudioMime: "audio/webm"),
            AppApiClient.JsonOpts);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("AAI=", doc.RootElement.GetProperty("audioBase64").GetString()); // server: body.audioBase64
        Assert.Equal("audio/webm", doc.RootElement.GetProperty("audioMime").GetString());
    }

    [Fact]
    public void VerifyRequest_Serializes_CamelCase()
    {
        var json = JsonSerializer.Serialize(new VerifyRequest("dev", "code", "نام", "android"), AppApiClient.JsonOpts);
        using var doc = JsonDocument.Parse(json);
        foreach (var name in new[] { "deviceId", "code", "name", "platform" })
            Assert.True(doc.RootElement.TryGetProperty(name, out _), $"server expects '{name}'");
    }

    [Fact]
    public void QuickActionRequest_Serializes_CamelCase()
    {
        var json = JsonSerializer.Serialize(new QuickActionRequest("tk", "cmd_limit"), AppApiClient.JsonOpts);
        using var doc = JsonDocument.Parse(json);
        Assert.True(doc.RootElement.TryGetProperty("token", out _));
        Assert.True(doc.RootElement.TryGetProperty("action", out _));
        Assert.False(doc.RootElement.TryGetProperty("contextText", out _));
    }

    [Fact]
    public void ChatResponse_RoundTrips_ServerDeliveredPayload()
    {
        // Mirrors the server's ok=true chat payload (worker.js writes camelCase).
        const string serverJson = """
        {
          "ok": true,
          "kind": "chat",
          "format": "markdown",
          "chunks": ["الف", "ب"],
          "keyboard": [[{ "text": "ادامه", "action": "cmd_more", "style": "primary" }]],
          "quota": { "allowed": true, "remaining": 7, "dailyLimit": 10, "resetHint": "۱۶ ساعت" },
          "costless": false,
          "thinkingFrames": ["⏳ ..."],
          "page": null
        }
        """;
        var res = JsonSerializer.Deserialize<ChatResponse>(serverJson, AppApiClient.JsonOpts)!;

        Assert.True(res.Ok);
        Assert.Equal("chat", res.Kind);
        Assert.Equal(new[] { "الف", "ب" }, res.Chunks);
        Assert.Equal("ادامه", Assert.Single(Assert.Single(res.Keyboard!)).Text);
        Assert.Equal(7, res.Quota!.Remaining);
        Assert.Equal(10, res.Quota.DailyLimit);
        Assert.Equal("۱۶ ساعت", res.Quota.ResetHint);
        Assert.False(res.Costless!.Value);
        Assert.Single(res.ThinkingFrames!);
        Assert.Null(res.Page);
    }

    [Fact]
    public void ChatResponse_RoundTrips_ServerErrorPayload()
    {
        const string serverJson = """
        { "ok": false, "code": "VALIDATION", "message": "⚠️ کوتاه است", "costless": true }
        """;
        var res = JsonSerializer.Deserialize<ChatResponse>(serverJson, AppApiClient.JsonOpts)!;
        Assert.False(res.Ok);
        Assert.Equal("VALIDATION", res.Code);
        Assert.True(res.Costless!.Value);
        Assert.Null(res.Chunks);
    }

    [Fact]
    public void ChatResponse_MissingOptionalFields_DeserializeToNull()
    {
        var res = JsonSerializer.Deserialize<ChatResponse>("""{ "ok": true, "kind": "chat", "text": "x" }""",
            AppApiClient.JsonOpts)!;
        Assert.True(res.Ok);
        Assert.Null(res.Quota);
        Assert.Null(res.Keyboard);
        Assert.Null(res.Format);
        Assert.Equal("x", res.Text);
    }

    [Fact]
    public void AppApiException_CarriesCodeAndStatus()
    {
        var e = new AppApiException("UNAUTHORIZED", "unauthorized", 401);
        Assert.Equal("UNAUTHORIZED", e.Code);
        Assert.Equal(401, e.HttpStatus);
        Assert.Equal("unauthorized", e.Message);
    }
}
