namespace VakilAI.Application.Contracts;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Coordinator-owned marketplace seams for the MAUI client:
//             (a) AccountSession — which signed-in identity the app holds and
//                 where it is stored; (b) IMarketplaceCoordinator — the
//                 navigation/auth brain pages are allowed to call.
// OWNER     — COORDINATOR ONLY (Agent 10 IMPLEMENTS IMarketplaceCoordinator).
// CONSUMES  — ITokenStore (Ports.cs), IMarketplaceApi (this folder), and the
//             Vakil_AI_IRAN.Pages types resolved via MauiProgram.Services.
// PROVIDES  — AccountSession + IMarketplaceCoordinator + MarketplaceRoute.
// INVARIANTS— Application layer stays platform- and page-free: the coordinator
//             is implemented in the MAUI app project, so these signatures must
//             not reference ContentPage/Window types. Roles/verification come
//             from the SERVER user object only — never a client-set flag.
// EXTEND    — New cross-page need = one method here, implemented once in
//             Services/MarketplaceCoordinator.cs, wired in MauiProgram.
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>Where the active identity lives. Priority: account > legacy activation.</summary>
public enum AccountKind
{
    None,
    /// <summary>Email/username or Google account (app_accounts row, has role).</summary>
    Account,
    /// <summary>Legacy activation-code session (app_devices row only, no role).</summary>
    LegacyActivation
}

/// <summary>
/// The signed-in identity, read/written by the coordinator, persisted in
/// SecureStorage alongside the bearer token. Null fields simply mean "unknown
/// until /auth/me confirms" — pages must not invent defaults.
/// </summary>
public sealed record AccountSession(
    AccountKind Kind,
    string? Token,
    long? UserId,
    string? DisplayName,
    string? Role,                       // client | lawyer | admin (server-owned)
    string? VerificationStatus,         // pending | verified | rejected | suspended (lawyers)
    DateTimeOffset? SavedAt)
{
    public static AccountSession Anonymous { get; } = new(AccountKind.None, null, null, null, null, null, null);
    public bool IsSignedIn => Kind != AccountKind.None && !string.IsNullOrEmpty(Token);
    public bool IsLawyer => Role == "lawyer";
    public bool IsAdmin => Role == "admin";
    public bool IsVerifiedLawyer => IsLawyer && VerificationStatus == "verified";
}

/// <summary>Screen keys the coordinator can navigate to. Keep additive.</summary>
public enum MarketplaceRoute
{
    Home,               // AI-first dashboard: ask entry + recent work + quick actions (tab root)
    Chat,               // existing AI chat (must keep working for legacy sessions)
    Auth,               // signup / login / Google (entry for signed-out users)
    History,            // conversation threads: search / open / rename / pin / delete
    Lawyers,            // marketplace directory
    LawyerProfile,      // public profile (id passed)
    Consultations,      // my consultations list (both directions)
    ConsultChat,        // paid lawyer conversation (id passed)
    LawyerOffice,       // lawyer-side: profile editor + inbox (role-gated)
    Payments,           // transactions / earnings
    Account             // profile, role switch, sign out
}

/// <summary>
/// The ONLY cross-page navigation + session authority in the app. Pages never
/// swap Window/Page or write the session vault themselves; they ask this.
/// Implementation lives in the app project (Services/MarketplaceCoordinator.cs)
/// because it owns MAUI page types.
/// </summary>
public interface IMarketplaceCoordinator
{
    /// <summary>Current identity (cheap, cached). Fires <see cref="SessionChanged"/> on change.</summary>
    AccountSession Current { get; }
    event EventHandler<AccountSession>? SessionChanged;

    /// <summary>Load persisted session (token + cached identity) at startup. Idempotent.</summary>
    Task RestoreAsync(CancellationToken ct = default);

    /// <summary>Persist token + server user after signup/login/google, then navigate to `after`.</summary>
    Task AdoptSessionAsync(string token, MarketplaceUser user, MarketplaceRoute after, CancellationToken ct = default);

    /// <summary>Revalidate cached identity against /auth/me (also refreshes quota view).</summary>
    Task<AccountSession> RefreshAsync(CancellationToken ct = default);

    /// <summary>Clear vault + cache; navigates to Auth (or keeps the chat for legacy sign-out).</summary>
    Task SignOutAsync(bool toAuthScreen = true);

    /// <summary>Sign in with the legacy activation code (compat path). Returns error message or null.</summary>
    Task<string?> ActivateWithCodeAsync(string code, string displayName, CancellationToken ct = default);

    /// <summary>Ask a lawyer for a consultation then route to the pay/chat screen. Returns error text or null.</summary>
    Task<string?> StartConsultationAsync(long lawyerUserId, CancellationToken ct = default);

    /// <summary>Single navigation entry point (knows how to show Chat vs modal pages).</summary>
    void Navigate(MarketplaceRoute route, object? argument = null);

    /// <summary>Open the AI chat, optionally on a specific thread (History → Chat)
    /// and with the composer focused (Home ask-entry). threadId 0 = current/newest.</summary>
    void OpenChat(long threadId = 0, bool focusComposer = false);

    /// <summary>Pop the back stack when there is one; otherwise route to
    /// <paramref name="fallback"/>. Detail pages call this from their back chip
    /// so Android's gesture-back and the in-app chip always agree.</summary>
    void NavigateBack(MarketplaceRoute fallback);

    /// <summary>Shared toast/alert surface so no page calls DisplayAlertAsync directly.</summary>
    Task NotifyAsync(string title, string message, string cancel = "باشه");
}
