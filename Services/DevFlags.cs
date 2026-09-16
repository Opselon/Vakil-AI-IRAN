namespace Vakil_AI_IRAN.Services;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Dev-only feature flags, persisted in Preferences so a toggle
//             survives an app restart but is INVISIBLE and INERT in release
//             builds. Today: SkipAuth — boot routes straight to Chat and
//             marketplace auth walls are bypassed so the main page can be
//             reviewed without an account.
// OWNER     — coordinator.
// INVARIANTS— Every member is compiled under #if DEBUG: a release APK cannot
//             skip auth even if the preference key was injected by hand,
//             because nothing reads it. The property setter/getter never
//             throws (Preferences can fail during early platform init).
// EXTEND    — new dev flag = one DEBUG property here + a toggle row in the
//             AuthPage dev panel (also #if DEBUG).
// ═══════════════════════════════════════════════════════════════════════════

public static class DevFlags
{
    /// <summary>True in debug builds when the developer chose "ورود بدون حساب".
    /// Release: the whole body is compiled out, so the literal cannot even reach
    /// the assembly metadata (verified by byte-scan of the release dll).</summary>
    public static bool SkipAuth
    {
        get
        {
#if DEBUG
            try { return Microsoft.Maui.Storage.Preferences.Default.Get(SkipAuthKey, false); }
            catch { return false; }
#else
            return false;
#endif
        }
        set
        {
#if DEBUG
            try { Microsoft.Maui.Storage.Preferences.Default.Set(SkipAuthKey, value); }
            catch { /* non-persistent in this failure mode — fine for a dev flag */ }
#endif
        }
    }

#if DEBUG
    private const string SkipAuthKey = "vakil.dev.skipAuth";
#endif
}
