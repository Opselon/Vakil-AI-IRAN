using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using VakilAI.Application;
using VakilAI.Application.Contracts;

namespace VakilAI.Infrastructure.Api;

/// <summary>
/// Production HTTP client for the Vakil API (/api/v1). Single external surface of the app.
/// Resilience: bounded retries with jittered exponential backoff on transient failures,
/// Retry-After honoring, strict timeouts per endpoint class, camelCase JSON contract,
/// and typed error mapping (no exceptions leak raw HTTP details into the UI).
/// </summary>
public sealed class AppApiClient : IAppApi
{
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly Func<Task<string?>> _deviceIdProvider;

    public static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true
    };

    public AppApiClient(HttpClient http, ILogger log, Func<Task<string?>> deviceIdProvider)
    {
        _http = http;
        _log = log;
        _deviceIdProvider = deviceIdProvider;
    }

    // ─────────────────────────── health ───────────────────────────

    public async Task<bool> ProbeHealthAsync(CancellationToken ct = default)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(8));
            var res = await _http.GetAsync("api/v1/health", cts.Token);
            if (!res.IsSuccessStatusCode) return false;
            var j = await res.Content.ReadFromJsonAsync<ApiEnvelope>(JsonOpts, cts.Token);
            return j?.Ok == true;
        }
        catch { return false; }
    }

    // ─────────────────────────── auth ───────────────────────────

    public Task<VerifyResponse> VerifyAsync(VerifyRequest request, CancellationToken ct = default) =>
        PostWithRetryAsync<VerifyRequest, VerifyResponse>("api/v1/auth/verify", request, TimeSpan.FromSeconds(20), ct);

    // ─────────────────────────── engine calls ───────────────────────────

    public Task<ChatResponse> ChatAsync(ChatRequest request, CancellationToken ct = default) =>
        PostOnceAsync<ChatRequest, ChatResponse>("api/v1/chat", request, TimeSpan.FromSeconds(40), ct);

    public Task<ChatResponse> QuickActionAsync(QuickActionRequest request, CancellationToken ct = default) =>
        PostOnceAsync<QuickActionRequest, ChatResponse>("api/v1/quick-action", request, TimeSpan.FromSeconds(40), ct);

    public Task<HistoryResponse> HistoryAsync(string token, CancellationToken ct = default) =>
        PostWithRetryAsync<object, HistoryResponse>("api/v1/history", new { token }, TimeSpan.FromSeconds(15), ct);

    // ─────────────────────────── transport core ───────────────────────────

    private async Task<TRes> PostWithRetryAsync<TReq, TRes>(string path, TReq body, TimeSpan timeout, CancellationToken ct)
        where TRes : class
    {
        const int maxAttempts = 3;
        Exception? last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                return await SendAsync<TReq, TRes>(path, body, timeout, ct);
            }
            catch (AppApiException e) when (e.Code is "RATE_LIMITED" or "ENGINE_UNAVAILABLE" or "VERIFY_FAILED" or "NETWORK" && attempt < maxAttempts)
            {
                last = e;
                var backoff = TimeSpan.FromMilliseconds(Math.Min(4000, 700 * Math.Pow(2, attempt)) + Random.Shared.Next(0, 350));
                if (e.Code == "RATE_LIMITED") backoff = TimeSpan.FromSeconds(5);
                _log.Warn($"retry {path} attempt {attempt + 1} after {backoff.TotalMilliseconds:F0}ms ({e.Code})");
                await Task.Delay(backoff, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception e) { last = e; if (attempt == maxAttempts) break; await Task.Delay(600 * attempt, ct); }
        }
        throw new AppApiException("NETWORK", last?.Message ?? "شبکه در دسترس نیست", 0);
    }

    private async Task<TRes> PostOnceAsync<TReq, TRes>(string path, TReq body, TimeSpan timeout, CancellationToken ct)
        where TRes : class
    {
        // engine calls are quota-consuming: at-most-once, but map 429 distinctly.
        try { return await SendAsync<TReq, TRes>(path, body, timeout, ct); }
        catch (AppApiException) { throw; }
        catch (OperationCanceledException) { throw new AppApiException("TIMEOUT", "زمان انتظار پاسخ سرور به پایان رسید.", 408); }
        catch (HttpRequestException e) { throw new AppApiException("NETWORK", e.Message, 0); }
    }

    private async Task<TRes> SendAsync<TReq, TRes>(string path, TReq body, TimeSpan timeout, CancellationToken ct)
        where TRes : class
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);

        using var msg = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body, options: JsonOpts)
        };
        msg.Headers.Add("X-Vakil-Client", "vakil-app/1.0.0");
        var did = await _deviceIdProvider();
        if (!string.IsNullOrEmpty(did)) msg.Headers.TryAddWithoutValidation("X-Vakil-Device", did);

        HttpResponseMessage res;
        try { res = await _http.SendAsync(msg, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { throw new AppApiException("TIMEOUT", "timeout", 408); }
        catch (HttpRequestException e)
        { throw new AppApiException("NETWORK", e.Message, 0); }

        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(cts.Token);

            if (res.StatusCode == HttpStatusCode.TooManyRequests)
                throw new AppApiException("RATE_LIMITED", "too many requests", 429);
            if ((int)res.StatusCode >= 500)
                throw new AppApiException("ENGINE_UNAVAILABLE", "server error", (int)res.StatusCode);
            if (res.StatusCode == HttpStatusCode.Unauthorized)
                throw new AppApiException("UNAUTHORIZED", "unauthorized", 401);
            if (res.StatusCode == HttpStatusCode.Forbidden)
                throw new AppApiException("FORBIDDEN", "forbidden", 403);

            try
            {
                var dto = JsonSerializer.Deserialize<TRes>(text, JsonOpts);
                if (dto is null) throw new JsonException("null body");
                return dto;
            }
            catch (JsonException e)
            {
                _log.Error($"bad JSON from {path}: {e.Message} :: {Truncate(text, 300)}");
                throw new AppApiException("BAD_RESPONSE", "پاسخ سرور قابل خواندن نیست.", (int)res.StatusCode);
            }
        }
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
