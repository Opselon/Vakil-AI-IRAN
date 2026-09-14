using System.Text.Json;
using VakilAI.Application;
using VakilAI.Application.Contracts;

namespace VakilAI.Infrastructure.Api;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Typed HTTP client for the Vakil marketplace API (auth, lawyers,
//             consultations, payments, admin). Implements IMarketplaceApi over
//             the same worker base address as AppApiClient.
// OWNER     — COORDINATOR ONLY. UI agents consume IMarketplaceApi; add DTOs
//             through MARKETPLACE_INTEGRATION_REQUESTS.md.
// CONSUMES  — the HttpClient singleton from MauiProgram (shared base address +
//             HTTP/2 + decompression, see HttpClientFactory), ILogger, and the
//             DTO records in MarketplaceContracts.cs.
// PROVIDES  — IMarketplaceApi. Business rejections deserialize to Ok=false +
//             Code/Message (presentable Persian); transport failures throw
//             AppApiException(NETWORK/TIMEOUT/RATE_LIMITED/BAD_RESPONSE),
//             mirroring AppApiClient semantics exactly.
// INVARIANTS— at-most-once for money/chat verbs (no retry), bounded retry for
//             read-only directory calls. Token travels in the JSON body — the
//             server contract predates Authorization headers; do not "modernise"
//             one side alone.
// EXTEND    — new endpoint = one record in the contracts file + one line here.
// ═══════════════════════════════════════════════════════════════════════════

public sealed class MarketplaceApiClient(HttpClient http, ILogger log, Func<Task<string?>> deviceIdProvider) : IMarketplaceApi
{
    private static readonly JsonSerializerOptions JsonOpts = AppApiClient.JsonOpts;

    // ────────────────────────── auth ──────────────────────────

    public Task<MarketplaceAuthResponse> SignupAsync(SignupRequest r, CancellationToken ct = default) =>
        PostAsync<SignupRequest, MarketplaceAuthResponse>("api/v1/auth/signup", r, TimeSpan.FromSeconds(25), retry: true, ct);

    public Task<MarketplaceAuthResponse> LoginAsync(LoginRequest r, CancellationToken ct = default) =>
        PostAsync<LoginRequest, MarketplaceAuthResponse>("api/v1/auth/login", r, TimeSpan.FromSeconds(20), retry: true, ct);

    public Task<MarketplaceAuthResponse> GoogleLoginAsync(GoogleLoginRequest r, CancellationToken ct = default) =>
        PostAsync<GoogleLoginRequest, MarketplaceAuthResponse>("api/v1/auth/google", r, TimeSpan.FromSeconds(25), retry: false, ct);

    public Task<MarketplaceAuthResponse> MeAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, MarketplaceAuthResponse>("api/v1/auth/me", new { token }, TimeSpan.FromSeconds(12), retry: true, ct);

    public Task<MarketplaceAuthResponse> LogoutAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, MarketplaceAuthResponse>("api/v1/auth/logout", new { token }, TimeSpan.FromSeconds(10), retry: false, ct);

    public Task<MarketplaceAuthResponse> SetPasswordAsync(string token, string newPassword, CancellationToken ct = default) =>
        PostAsync<object, MarketplaceAuthResponse>("api/v1/auth/password/set", new { token, newPassword }, TimeSpan.FromSeconds(20), retry: false, ct);

    // ────────────────────────── lawyers ──────────────────────────

    public Task<LawyerCategoriesResponse> CategoriesAsync(string? token, CancellationToken ct = default) =>
        PostAsync<object, LawyerCategoriesResponse>("api/v1/lawyers/categories", new { token }, TimeSpan.FromSeconds(12), retry: true, ct);

    public Task<LawyerListResponse> LawyersAsync(LawyerListRequest r, CancellationToken ct = default) =>
        PostAsync<LawyerListRequest, LawyerListResponse>("api/v1/lawyers/list", r, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<LawyerProfileResponse> LawyerProfileAsync(long userId, string token, CancellationToken ct = default) =>
        PostAsync<object, LawyerProfileResponse>("api/v1/lawyers/get", new { userId, token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<LawyerProfileResponse> LawyerProfileBySlugAsync(string slug, string token, CancellationToken ct = default) =>
        PostAsync<object, LawyerProfileResponse>("api/v1/lawyers/get", new { slug, token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<LawyerProfileResponse> MyLawyerProfileAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, LawyerProfileResponse>("api/v1/lawyers/me", new { token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<LawyerProfileResponse> ApplyAsLawyerAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, LawyerProfileResponse>("api/v1/lawyers/apply", new { token }, TimeSpan.FromSeconds(20), retry: false, ct);

    public Task<LawyerProfileResponse> SaveLawyerProfileAsync(LawyerSaveRequest r, CancellationToken ct = default) =>
        PostAsync<LawyerSaveRequest, LawyerProfileResponse>("api/v1/lawyers/save", r, TimeSpan.FromSeconds(20), retry: false, ct);

    // ────────────────────────── consultations ──────────────────────────

    public Task<ConsultationCreateResponse> ConsultationCreateAsync(ConsultationCreateRequest r, CancellationToken ct = default) =>
        PostAsync<ConsultationCreateRequest, ConsultationCreateResponse>("api/v1/consultations/create", r, TimeSpan.FromSeconds(25), retry: false, ct);

    public Task<ConsultationPayResponse> ConsultationPayAsync(ConsultationPayRequest r, CancellationToken ct = default) =>
        PostAsync<ConsultationPayRequest, ConsultationPayResponse>("api/v1/consultations/pay", r, TimeSpan.FromSeconds(30), retry: false, ct);

    public Task<ConsultationListResponse> ConsultationsAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, ConsultationListResponse>("api/v1/consultations/list", new { token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<ConsultationMessagesResponse> ConsultationMessagesAsync(string token, long consultationId, long afterId, CancellationToken ct = default) =>
        PostAsync<object, ConsultationMessagesResponse>("api/v1/consultations/messages", new { token, consultationId, afterId }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<ConsultationMessagesResponse> ConsultationSendAsync(ConsultationSendRequest r, CancellationToken ct = default) =>
        PostAsync<ConsultationSendRequest, ConsultationMessagesResponse>("api/v1/consultations/send", r, TimeSpan.FromSeconds(20), retry: false, ct);

    public Task<ConsultationListResponse> ConsultationCompleteAsync(string token, long consultationId, CancellationToken ct = default) =>
        PostAsync<object, ConsultationListResponse>("api/v1/consultations/complete", new { token, consultationId }, TimeSpan.FromSeconds(20), retry: false, ct);

    // ────────────────────────── payments ──────────────────────────

    public Task<PaymentHistoryResponse> PaymentHistoryAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, PaymentHistoryResponse>("api/v1/payments/history", new { token }, TimeSpan.FromSeconds(15), retry: true, ct);

    // ────────────────────────── admin foundation ──────────────────────────

    public Task<AdminOverviewResponse> AdminOverviewAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, AdminOverviewResponse>("api/v1/admin/overview", new { token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<AdminUsersResponse> AdminUsersAsync(string token, string? filter, CancellationToken ct = default) =>
        PostAsync<object, AdminUsersResponse>("api/v1/admin/users/list", new { token, filter }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<AdminLawyersResponse> AdminPendingLawyersAsync(string token, CancellationToken ct = default) =>
        PostAsync<object, AdminLawyersResponse>("api/v1/admin/lawyers/pending", new { token }, TimeSpan.FromSeconds(15), retry: true, ct);

    public Task<AdminDecisionResponse> AdminDecideAsync(AdminDecisionRequest r, CancellationToken ct = default) =>
        PostAsync<AdminDecisionRequest, AdminDecisionResponse>("api/v1/admin/lawyers/decide", r, TimeSpan.FromSeconds(20), retry: false, ct);

    // ────────────────────────── transport core ──────────────────────────

    /// <summary>
    /// POST + deserialize. retry=true = bounded 3-attempt backoff for idempotent reads
    /// (signup/login included: the server dedups on email/username so a replayed
    /// network retry can't create a second account). Money/chat verbs use retry=false.
    /// </summary>
    private async Task<TRes> PostAsync<TReq, TRes>(string path, TReq body, TimeSpan timeout, bool retry, CancellationToken ct)
        where TRes : class
    {
        const int maxAttempts = 3;
        Exception? last = null;
        for (int attempt = 1; attempt <= (retry ? maxAttempts : 1); attempt++)
        {
            try { return await SendAsync<TReq, TRes>(path, body, timeout, ct); }
            catch (AppApiException e) when (retry && e.Code is "RATE_LIMITED" or "ENGINE_UNAVAILABLE" or "NETWORK" && attempt < maxAttempts)
            {
                last = e;
                var backoff = TimeSpan.FromMilliseconds(Math.Min(3000, 500 * Math.Pow(2, attempt)) + Random.Shared.Next(0, 250));
                log.Warn($"marketplace retry {path} #{attempt + 1} after {backoff.TotalMilliseconds:F0}ms ({e.Code})");
                await Task.Delay(backoff, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception e) { last = e; if (!retry || attempt == maxAttempts) break; await Task.Delay(500 * attempt, ct); }
        }
        throw new AppApiException("NETWORK", last?.Message ?? "شبکه در دسترس نیست", 0);
    }

    private async Task<TRes> SendAsync<TReq, TRes>(string path, TReq body, TimeSpan timeout, CancellationToken ct)
        where TRes : class
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);

        using var msg = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(JsonSerializer.Serialize(body, JsonOpts), System.Text.Encoding.UTF8, "application/json")
        };
        msg.Headers.Add("X-Vakil-Client", "vakil-app/1.1.0");
        var did = await deviceIdProvider();
        if (!string.IsNullOrEmpty(did)) msg.Headers.TryAddWithoutValidation("X-Vakil-Device", did);

        HttpResponseMessage res;
        try { res = await http.SendAsync(msg, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new AppApiException("TIMEOUT", "timeout", 408); }
        catch (HttpRequestException e) { throw new AppApiException("NETWORK", e.Message, 0); }

        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(cts.Token);
            if (res.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
                throw new AppApiException("RATE_LIMITED", "too many requests", 429);
            if ((int)res.StatusCode >= 500)
                throw new AppApiException("ENGINE_UNAVAILABLE", "server error", (int)res.StatusCode);

            try
            {
                var dto = JsonSerializer.Deserialize<TRes>(text, JsonOpts);
                if (dto is null) throw new JsonException("null body");
                return dto;
            }
            catch (JsonException e)
            {
                log.Error($"bad marketplace JSON from {path}: {e.Message} :: {Truncate(text, 300)}");
                throw new AppApiException("BAD_RESPONSE", "پاسخ سرور قابل خواندن نیست.", (int)res.StatusCode);
            }
        }
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
