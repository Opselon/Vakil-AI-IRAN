using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Pages;
using VakilAI.Application.Contracts;
using VakilAI.Domain.Repositories;

using AppLogger = VakilAI.Application.ILogger;

namespace Vakil_AI_IRAN.Services;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Implements IMarketplaceCoordinator: the single session +
//             navigation authority of the app. Owns the marketplace identity
//             (AccountSession), restores it at boot, adopts it after
//             signup/login/Google, runs the legacy activation-code compat
//             path, and swaps root pages on the window.
//             (IMarketplaceRouteArgument lives in ActivationGate.cs, root
//             namespace, so every page sees it without an extra using.)
// OWNER     — Agent 10 (UX integration).
// CONSUMES  — ITokenStore (SAME vault the chat engine reads — the bearer
//             token is never duplicated), IMarketplaceApi (typed port),
//             IAppApi.VerifyAsync (legacy /auth/verify), IDeviceIdentity +
//             IDeviceStore (device id, saved display name), SessionVault
//             (ActivationGate.cs) for the cached identity JSON.
// PROVIDES  — IMarketplaceCoordinator + IMarketplaceRouteArgument (pages that
//             accept a Navigate() argument implement it).
// NAVIGATION MODEL —
//             The window root is always a NavigationPage. Chat/Auth are ROOT
//             routes: Navigate() pops any pushed detail pages and makes the
//             new root the stack base (fresh NavigationPage when the wrapper
//             type changes). Every other route PUSHES onto the stack, so
//             Android's system back / edge gesture and the in-app back chips
//             share one real back stack (audit fix: previously every page was
//             a root swap with no stack, which made back navigation a dead
//             single-chip path). Detail pages call NavigateBack(fallback).
// INVARIANTS— 1) A legacy activation-code session (token in vault, no
//                app_accounts row) MUST restore as AccountKind.LegacyActivation
//                and route straight to Chat — behaviour identical to pre-V1.
//             2) The token lives ONLY in ITokenStore; SecureStorage gets just
//                a non-secret identity cache (no token is ever persisted in
//                the JSON — only a fingerprint to detect staleness).
//             3) Cold network must never lock the user out: hydration
//                failures keep the cached/provisional identity.
//             4) role / verificationStatus come from the SERVER only.
// EXTEND    — new screen = one MarketplaceRoute member + one map line below;
//             if the page type may not exist yet (parallel agents), go
//             through ResolveSoftPage() — it degrades to an honest notice.
// ═══════════════════════════════════════════════════════════════════════════

public sealed class MarketplaceCoordinator : IMarketplaceCoordinator
{
    private readonly IServiceProvider _services;
    private readonly ITokenStore _tokens;
    private readonly IMarketplaceApi _api;
    private readonly IAppApi _appApi;
    private readonly IDeviceIdentity _identity;
    private readonly IDeviceStore _deviceStore;
    private readonly AppLogger _log;

    private readonly object _stateGate = new();
    private AccountSession _current = AccountSession.Anonymous;
    private bool _restored;

    public event EventHandler<AccountSession>? SessionChanged;

    public AccountSession Current
    {
        get { lock (_stateGate) return _current; }
    }

    public MarketplaceCoordinator(
        IServiceProvider services,
        ITokenStore tokens,
        IMarketplaceApi api,
        IAppApi appApi,
        IDeviceIdentity identity,
        IDeviceStore deviceStore,
        AppLogger log)
    {
        _services = services;
        _tokens = tokens;
        _api = api;
        _appApi = appApi;
        _identity = identity;
        _deviceStore = deviceStore;
        _log = log;
    }

    // ────────────────────────── restore / hydrate ──────────────────────────

    /// <summary>
    /// Boot-time identity load. Fast path first (vault token + cached identity →
    /// usable within milliseconds so the window swap never waits on the network),
    /// then best-effort /auth/me hydration bounded by <paramref name="ct"/>.
    /// A token with no app_accounts row keeps/gets AccountKind.LegacyActivation,
    /// which routes to Chat exactly like the pre-marketplace app did.
    /// </summary>
    public async Task RestoreAsync(CancellationToken ct = default)
    {
        try
        {
            var token = await _tokens.GetTokenAsync();

            if (string.IsNullOrWhiteSpace(token))
            {
                await SessionVault.ClearAsync();
                SetSession(AccountSession.Anonymous);
                _restored = true;
                return;
            }

            // provisional: cached identity if fresh, else legacy-activation
            // (the conservative default — it keeps the chat reachable offline).
            var cached = await SessionVault.LoadAsync(Fingerprint(token));
            var provisional = cached is not null
                ? new AccountSession(cached.Kind, token, cached.UserId, cached.DisplayName,
                    cached.Role, cached.VerificationStatus, cached.SavedAt)
                : new AccountSession(AccountKind.LegacyActivation, token, null,
                    await TrySavedNameAsync(), null, null, DateTimeOffset.UtcNow);
            SetSession(provisional);
            _restored = true;

            // hydrate from the server (optional — failure must not gate boot)
            try
            {
                var res = await _api.MeAsync(token, ct);
                if (res.Ok && res.User is not null)
                {
                    // The server is the authority on WHICH identity this is: an
                    // app_accounts row reports password/google, a legacy
                    // activation-only session reports ['activation'] (Agent 1's
                    // compat seam — it never 404s). Kind drives the label only;
                    // BOTH route to Chat, so the old flow is untouched.
                    var legacy = IsLegacyOnly(res.User);
                    var hydrated = new AccountSession(
                        legacy ? AccountKind.LegacyActivation : AccountKind.Account,
                        token,
                        res.User.UserId,
                        res.User.DisplayName,
                        legacy ? null : res.User.Role,
                        legacy ? null : res.User.VerificationStatus,
                        DateTimeOffset.UtcNow);
                    SetSession(hydrated, persist: true);
                }
                else if (res.Code is "UNAUTHORIZED" or "TOKEN_INVALID" or "TOKEN_EXPIRED" or "ACCOUNT_NOT_FOUND")
                {
                    // The server rejects the token outright. Chat keeps its own
                    // 401 handling exactly as before, so only relabel the kind.
                    SetSession(provisional with { Kind = AccountKind.LegacyActivation });
                }
                // any other business code (rate limit etc.) → keep provisional.
            }
            catch (OperationCanceledException) { /* boot budget spent — cache serves */ }
            catch (Exception e)
            {
                _log.Warn("coordinator hydration failed (offline ok): " + e.Message);
            }
        }
        catch (Exception e)
        {
            Debug.WriteLine("coordinator restore: " + e);
            _restored = true; // never leave the app stuck "unrestored"
        }
    }

    public async Task<AccountSession> RefreshAsync(CancellationToken ct = default)
    {
        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrWhiteSpace(token))
        {
            SetSession(AccountSession.Anonymous, persist: true);
            return Current;
        }
        try
        {
            var res = await _api.MeAsync(token, ct);
            if (res.Ok && res.User is not null)
            {
                var legacy = IsLegacyOnly(res.User);
                var fresh = new AccountSession(
                    legacy ? AccountKind.LegacyActivation : AccountKind.Account,
                    token, res.User.UserId, res.User.DisplayName,
                    legacy ? null : res.User.Role,
                    legacy ? null : res.User.VerificationStatus,
                    DateTimeOffset.UtcNow);
                SetSession(fresh, persist: true);
            }
            else if (res.Code is "UNAUTHORIZED" or "TOKEN_INVALID" or "TOKEN_EXPIRED")
            {
                // Dead token (expired/revoked/banned): drop the session so
                // marketplace pages stop re-trying it (audit: dead-token loop).
                // Chat keeps its own SESSION_EXPIRED route; this covers the rest
                // of the app. ACCOUNT_SUSPENDED arrives as Ok=false too — same
                // outcome: the vault token is worthless, clear it and re-auth.
                _log.Warn("coordinator refresh: token rejected (" + res.Code + ") — signing out");
                await SignOutAsync(toAuthScreen: true);
            }
        }
        catch (AppApiException e) when (e.Code is "UNAUTHORIZED")
        {
            // HTTP 401 path (the envelope carried no code): same treatment.
            _log.Warn("coordinator refresh: 401 — signing out");
            await SignOutAsync(toAuthScreen: true);
        }
        catch (Exception e)
        {
            _log.Warn("coordinator refresh failed: " + e.Message);
        }
        return Current;
    }

    // ────────────────────────── adopt / sign out ──────────────────────────

    public async Task AdoptSessionAsync(string token, MarketplaceUser user, MarketplaceRoute after, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(user);

        // Account-switch hygiene (audit: shared on-device SQLite carried the old
        // account's AI transcript into the new session; ChatRow has no owner
        // column). Only between two ACCOUNT identities — a legacy activation
        // session keeps its transcript (pre-V1 behaviour, INVARIANT 1).
        // Identity CHANGE (not sign-in per se) is the privacy boundary: a
        // different marketplace account taking over this device wipes the shared
        // transcript. Sign-out keeps data so an EXPIRED-token user who logs back
        // in sees their own history. The persisted last-account id survives
        // SignOutAsync clearing the in-memory session, enabling the same-person
        // detection below. Legacy activation sessions never wipe (INVARIANT 1).
        var prev = Current;
        var differentIdentity = prev.Kind == AccountKind.Account
            ? user.UserId != prev.UserId
            : LastAccountUserId() != 0 && !LastAccountMatches(user.UserId);
        if (differentIdentity)
            await ResetChatAsync("account-switch");

        await _tokens.SaveTokenAsync(token); // SAME vault the chat engine reads → zero regression
        RememberLastAccount(user.UserId);
        var session = new AccountSession(AccountKind.Account, token, user.UserId, user.DisplayName,
            user.Role, user.VerificationStatus, DateTimeOffset.UtcNow);
        SetSession(session, persist: true);
        Navigate(after);
    }

    public async Task SignOutAsync(bool toAuthScreen = true)
    {
        var wasAccount = Current.Kind == AccountKind.Account;
        var dyingToken = await _tokens.GetTokenAsync();
        try { await _tokens.ClearAsync(); }
        catch (Exception e) { Debug.WriteLine("signout token: " + e); }
        // Invalidate server-side too (audit: local-clear left the 60-day bearer
        // spendable). Fire-and-forget: offline sign-out must never block or fail.
        if (!string.IsNullOrWhiteSpace(dyingToken))
        {
            _ = Task.Run(async () =>
            {
                try { await _api.LogoutAsync(dyingToken); }
                catch (Exception e) { Debug.WriteLine("server logout (best-effort): " + e.Message); }
            });
        }
        await SessionVault.ClearAsync();
        SetSession(AccountSession.Anonymous);
        // Cross-account privacy is enforced at the IDENTITY CHANGE instead of
        // here (AdoptSessionAsync resets the transcript when a DIFFERENT account
        // signs in). Wiping on sign-out would destroy a legitimate user's own
        // history every time a token merely expires. The device display-name
        // hint is cleared for accounts (prefill leak, audit 2.1) — legacy keeps
        // its prefill exactly as before → INVARIANT 1.
        if (wasAccount)
        {
            try { await _deviceStore.SaveUserNameAsync(string.Empty); }
            catch (Exception e) { Debug.WriteLine("signout name: " + e); }
        }
        if (toAuthScreen)
            Navigate(MarketplaceRoute.Auth);
    }

    /// <summary>Persisted id of the last MARKETPLACE account to own this device's
    /// transcript. Survives sign-out so a same-person re-login after token expiry
    /// is not mistaken for an identity change. Preferences (not SecureStorage):
    /// non-secret — just the owner id the transcript is about.</summary>
    private const string LastAccountKey = "vakil.session.lastAccount";

    private static long LastAccountUserId()
    {
        try { return Microsoft.Maui.Storage.Preferences.Default.Get(LastAccountKey, 0L); }
        catch { return 0; }
    }

    private static void RememberLastAccount(long userId)
    {
        try { Microsoft.Maui.Storage.Preferences.Default.Set(LastAccountKey, userId); }
        catch (Exception e) { Debug.WriteLine("remember account: " + e); }
    }

    private static bool LastAccountMatches(long userId) => userId != 0 && LastAccountUserId() == userId;

    /// <summary>Best-effort ChatService transcript reset (never throws, never blocks navigation).</summary>
    private async Task ResetChatAsync(string reason)
    {
        try
        {
            var chat = _services.GetRequiredService<VakilAI.Application.Services.ChatService>();
            await chat.ResetAsync();
        }
        catch (Exception e)
        {
            _log.Warn($"chat reset ({reason}) failed: {e.Message}");
        }
    }

    // ────────────────────────── legacy activation (compat) ──────────────────────────

    /// <summary>
    /// Compat path only: delegates to the existing IAppApi.VerifyAsync contract
    /// unchanged, stores the token in the SAME vault, and labels the session
    /// LegacyActivation. Returns a presentable Persian error or null on success.
    /// </summary>
    public async Task<string?> ActivateWithCodeAsync(string code, string displayName, CancellationToken ct = default)
    {
        try
        {
            var name = string.IsNullOrWhiteSpace(displayName) ? "کاربر وکیل" : displayName.Trim();
            var deviceId = await _identity.GetOrCreateAsync();
            var platform = await _identity.PlatformNameAsync();
            var res = await _appApi.VerifyAsync(new VerifyRequest(deviceId.Value, code.Trim(), name, platform), ct);

            if (res.Ok && !string.IsNullOrWhiteSpace(res.Token))
            {
                await _tokens.SaveTokenAsync(res.Token!);
                try { await _deviceStore.SaveUserNameAsync(name); }
                catch (Exception e) { Debug.WriteLine("save name: " + e); }

                var session = new AccountSession(AccountKind.LegacyActivation, res.Token,
                    res.UserId, name, null, null, DateTimeOffset.UtcNow);
                SetSession(session, persist: true);
                Navigate(MarketplaceRoute.Chat);
                return null;
            }
            return res.Message ?? "کد فعال‌سازی معتبر نیست یا مهلت آن پایان یافته است.";
        }
        catch (Exception e)
        {
            Debug.WriteLine("legacy activate: " + e);
            return "ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.";
        }
    }

    // ────────────────────────── consultations ──────────────────────────

    public async Task<string?> StartConsultationAsync(long lawyerUserId, CancellationToken ct = default)
    {
        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrWhiteSpace(token))
            return "برای شروع مشاوره ابتدا وارد حساب خود شوید.";

        try
        {
            var idempotencyKey = "app-" + Guid.NewGuid().ToString("N");
            var res = await _api.ConsultationCreateAsync(
                new ConsultationCreateRequest(token, lawyerUserId, null, idempotencyKey), ct);

            if (res.Ok && res.Consultation is not null)
            {
                // hand over the whole response — ConsultChatPage reads the honest
                // devModeNotice + price quote out of it before it starts polling
                Navigate(MarketplaceRoute.ConsultChat, res);
                return null;
            }
            return res.Message ?? "ثبت درخواست مشاوره ممکن نشد. کمی دیگر دوباره تلاش کنید.";
        }
        catch (AppApiException e) when (e.Code is "NETWORK" or "TIMEOUT")
        {
            return "ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.";
        }
        catch (Exception e)
        {
            Debug.WriteLine("start consultation: " + e);
            return "ثبت درخواست مشاوره ممکن نشد.";
        }
    }

    // ────────────────────────── chat thread hand-off ──────────────────────────

    /// <summary>Thread the ChatPage should open on its next InitializeAsync
    /// (set by the History page; ChatPage clears it on take). 0 = no request.</summary>
    public long PendingChatThreadId { get; set; }

    /// <summary>Ask the user to open Chat; an optional thread id survives the re-root.</summary>
    public void OpenChat(long threadId = 0, bool focusComposer = false)
    {
        PendingChatThreadId = threadId;
        FocusComposerOnNextChat = focusComposer;
        Navigate(MarketplaceRoute.Chat);
    }

    /// <summary>Home's ask-entry: open Chat with the composer focused (§417).</summary>
    public bool FocusComposerOnNextChat { get; set; }

    // ────────────────────────── navigation ──────────────────────────

    /// <summary>Routes that OWN the stack — the tab roots of the app (everything
    /// else is a pushed detail page with a poppable back path). Home/Chat/Lawyers
    /// carry the BottomTabBar; Consultations and History are pushed details.</summary>
    private static bool IsRootRoute(MarketplaceRoute route) =>
        route is MarketplaceRoute.Home or MarketplaceRoute.Chat or MarketplaceRoute.Auth
            or MarketplaceRoute.Lawyers;

    /// <summary>
    /// See the header note: root routes rebuild the stack base, detail routes
    /// PUSH so the system back gesture works. Chat stays reachable for legacy
    /// sessions (route Chat).
    /// </summary>
    public void Navigate(MarketplaceRoute route, object? argument = null)
    {
        Page? page = route switch
        {
            MarketplaceRoute.Home => Hard<HomePage>(route),
            MarketplaceRoute.Chat => Hard<ChatPage>(route),
            MarketplaceRoute.Auth => Hard<AuthPage>(route),
            MarketplaceRoute.ConsultChat => Hard<ConsultChatPage>(route),
            MarketplaceRoute.History => Soft(route, "ConversationsPage"),
            // Agent 5 / later pages: soft-resolved so this file compiles and
            // ships before their types exist.
            MarketplaceRoute.Lawyers => Soft(route, "LawyersPage"),
            MarketplaceRoute.LawyerProfile => Soft(route, "LawyerProfilePage"),
            MarketplaceRoute.Consultations => Soft(route, "ConsultationsPage"),
            MarketplaceRoute.LawyerOffice => Soft(route, "HostPage"),
            MarketplaceRoute.Payments => Soft(route, "PaymentsPage"),
            MarketplaceRoute.Account => Soft(route, "AccountPage"),
            _ => null
        };

        if (page is null) return; // Soft() already told the user

        if (page is IMarketplaceRouteArgument withArg)
        {
            try { withArg.ReceiveRouteArgument(argument); }
            catch (Exception e) { Debug.WriteLine("route arg: " + e); }
        }

        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                var window = Application.Current?.Windows.Count > 0 ? Application.Current.Windows[0] : null;
                if (window is null) return;

                if (!IsRootRoute(route) && window.Page is NavigationPage nav)
                {
                    // Detail route over an existing stack: push (animated, poppable).
                    _ = nav.PushAsync(page);
                    return;
                }

                // Root route (or no stack yet): the page becomes the new stack base.
                // Rebuilding the wrapper is the predictable choice — every page
                // already sets NavigationPage.HasNavigationBar="False" itself, so
                // this looks pixel-identical to the old root swap.
                window.Page = new NavigationPage(page);
            }
            catch (Exception e)
            {
                Debug.WriteLine("navigate swap: " + e);
                try
                {
                    if (Application.Current?.Windows.Count > 0)
                        Application.Current.Windows[0].Page = new NavigationPage(page);
                }
                catch (Exception e2) { Debug.WriteLine("navigate fallback: " + e2); }
            }
        });
    }

    /// <inheritdoc/>
    public void NavigateBack(MarketplaceRoute fallback)
    {
        MainThread.BeginInvokeOnMainThread(async () =>
        {
            try
            {
                if (Application.Current?.Windows.Count > 0 &&
                    Application.Current.Windows[0].Page is NavigationPage nav &&
                    nav.Navigation.NavigationStack.Count > 1)
                {
                    await nav.PopAsync();
                    return;
                }
            }
            catch (Exception e) { Debug.WriteLine("navigate back: " + e); }
            Navigate(fallback); // no stack → go home the explicit way
        });
    }

    private Page? Hard<TPage>(MarketplaceRoute route) where TPage : Page
    {
        try
        {
            return _services.GetRequiredService<TPage>();
        }
        catch (Exception e)
        {
            Debug.WriteLine($"navigate {route}: " + e);
            _ = NotifyAsync("خطا", "باز شدن این صفحه ممکن نشد.");
            return null;
        }
    }

    /// <summary>
    /// Resolves a page whose CLR type may not exist yet (parallel agents).
    /// Missing → honest Persian notice instead of a crash; present → DI transient
    /// if registered, else a parameterless/default-constructor creation.
    /// </summary>
    private Page? Soft(MarketplaceRoute route, string typeName)
    {
        var full = "Vakil_AI_IRAN.Pages." + typeName;
        Type? type = AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetType(full, throwOnError: false))
            .FirstOrDefault(t => t is not null);

        if (type is null)
        {
            _ = NotifyAsync("به‌زودی", "این بخش در بروزرسانی بعدی فعال می‌شود.");
            return null;
        }
        try
        {
            var page = _services.GetService(type) as Page
                ?? ActivatorUtilities.CreateInstance(_services, type) as Page;
            if (page is null)
                _ = NotifyAsync("خطا", "باز شدن این صفحه ممکن نشد.");
            return page;
        }
        catch (Exception e)
        {
            Debug.WriteLine($"soft page {typeName}: " + e);
            _ = NotifyAsync("خطا", "باز شدن این صفحه ممکن نشد.");
            return null;
        }
    }

    // ────────────────────────── notifications ──────────────────────────

    public async Task NotifyAsync(string title, string message, string cancel = "باشه")
    {
        try
        {
            await MainThread.InvokeOnMainThreadAsync(async () =>
            {
                var page = ActivePage();
                if (page is not null)
                    await page.DisplayAlertAsync(title, message, cancel);
            });
        }
        catch (Exception e)
        {
            Debug.WriteLine("notify: " + e);
        }
    }

    private static Page? ActivePage()
    {
        var page = Application.Current?.Windows.FirstOrDefault()?.Page;
        // walk to the front-most page if a navigation wrapper ever appears
        while (page is NavigationPage nav && nav.CurrentPage is not null && !ReferenceEquals(nav.CurrentPage, page))
            page = nav.CurrentPage;
        return page;
    }

    // ────────────────────────── session state helpers ──────────────────────────

    private void SetSession(AccountSession session, bool persist = false)
    {
        AccountSession previous;
        lock (_stateGate)
        {
            previous = _current;
            _current = session;
        }
        if (persist && session.Kind == AccountKind.Account && !string.IsNullOrEmpty(session.Token))
            _ = SessionVault.SaveAsync(PersistedIdentity.From(session, Fingerprint(session.Token!)));

        if (!ReferenceEquals(previous, session) && previous != session)
        {
            try { SessionChanged?.Invoke(this, session); }
            catch (Exception e) { Debug.WriteLine("session event: " + e); }
        }
    }

    private async Task<string?> TrySavedNameAsync()
    {
        try { return await _deviceStore.GetUserNameAsync(); }
        catch { return null; }
    }

    private static string Fingerprint(string token)
    {
        // cheap staleness check — NOT a secret; the token itself never lands in the cache JSON
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToBase64String(hash)[..10];
    }

    /// <summary>
    /// Server-declared legacy session: Agent 1's /auth/me compat seam reports
    /// authMethods ['activation'] (and no email/username) for a uid that has no
    /// app_accounts row. Such a session must keep behaving exactly like the
    /// pre-marketplace app — chat first, marketplace features gated.
    /// </summary>
    private static bool IsLegacyOnly(MarketplaceUser user)
    {
        var methods = user.AuthMethods;
        if (methods is { Length: > 0 })
        {
            var hasAccountCredential = methods.Any(m => m is "password" or "google");
            if (!hasAccountCredential && methods.Contains("activation")) return true;
        }
        return string.IsNullOrWhiteSpace(user.Email)
               && string.IsNullOrWhiteSpace(user.Username)
               && string.IsNullOrWhiteSpace(user.VerificationStatus);
    }

    /// <summary>True once RestoreAsync has produced at least a provisional session.</summary>
    public bool Restored
    {
        get { lock (_stateGate) return _restored; }
    }
}

/// <summary>
/// Non-secret identity cache persisted next to the token vault (see SessionVault in ActivationGate.cs).
/// </summary>
internal sealed record PersistedIdentity(
    AccountKind Kind,
    long? UserId,
    string? DisplayName,
    string? Role,
    string? VerificationStatus,
    string TokenFingerprint,
    DateTimeOffset SavedAt)
{
    public static PersistedIdentity From(AccountSession s, string fingerprint) =>
        new(s.Kind, s.UserId, s.DisplayName, s.Role, s.VerificationStatus, fingerprint,
            s.SavedAt ?? DateTimeOffset.UtcNow);
}
