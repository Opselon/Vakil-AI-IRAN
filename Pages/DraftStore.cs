namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// Composer draft persistence (§74): a typed question must survive navigation,
/// a closed keyboard, even a crash — Preferences is enough (single string).
/// Synchronous on purpose: IPreferences has no async surface and the composer
/// saves on every keystroke. Cleared on send and on explicit new-chat.
/// </summary>
internal static class DraftStore
{
    private const string Key = "vakil.chat.draft";

    public static void Save(string? text)
    {
        try { Microsoft.Maui.Storage.Preferences.Default.Set(Key, text ?? string.Empty); }
        catch { /* a lost draft must never break typing */ }
    }

    public static string Load()
    {
        try { return Microsoft.Maui.Storage.Preferences.Default.Get(Key, string.Empty); }
        catch { return string.Empty; }
    }

    public static void Clear()
    {
        try { Microsoft.Maui.Storage.Preferences.Default.Remove(Key); }
        catch { }
    }
}
