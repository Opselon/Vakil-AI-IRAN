using VakilAI.Application.Contracts;
using VakilAI.Domain.ValueObjects;
using VakilAI.Infrastructure.Storage;

using System.Text.Json;
using Microsoft.Maui.Storage;
using Vakil_AI_IRAN.Services;

namespace Vakil_AI_IRAN;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Decides whether the app may open straight into the chat or must
//             show a gate first (unchanged pre-V1 semantics), hosts the token
//             vault wiring, and since V1 also carries the marketplace identity
//             cache (SessionVault) + the cross-page route-argument contract.
// OWNER     — Agent 10 (UX integration); ActivationGate itself: original app.
// PROVIDES  — ActivationGate (compat) + VaultTokenStore + SessionVault +
//             IMarketplaceRouteArgument. The route-argument interface lives in
//             the ROOT namespace on purpose: every page (this app + Agent 5)
//             resolves it through its enclosing namespace with no extra using.
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// Implemented by pages that accept a <see cref="VakilAI.Application.Contracts.IMarketplaceCoordinator.Navigate"/>
/// argument (e.g. ConsultChatPage gets a ConsultationDto/long id, LawyerProfilePage
/// a userId). The coordinator calls this BEFORE the page becomes the window root.
/// </summary>
public interface IMarketplaceRouteArgument
{
    void ReceiveRouteArgument(object? argument);
}

/// <summary>
/// Decides whether the app may open straight into the chat or must show the
/// activation gate first. A session is active when a token is stored; the server
/// probe is best-effort only (a cold network must never lock the user out of
/// their on-device transcript).
/// </summary>
public sealed class ActivationGate(IAppApi api, ITokenStore tokens)
{
    public const string TokenKey = "vakil.session.token";

    public async Task<bool> HasActiveSessionAsync()
    {
        try
        {
            var token = await tokens.GetTokenAsync();
            return !string.IsNullOrWhiteSpace(token);
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("gate failed: " + e);
            return false;
        }
    }

    /// <summary>Soft health check used for the header connection dot.</summary>
    public Task<bool> ServerReachableAsync(CancellationToken ct = default) =>
        api.ProbeHealthAsync(ct);

    /// <summary>Clears the session so the next launch lands on the activation page.</summary>
    public Task SignOutAsync() => tokens.ClearAsync();
}

/// <summary>
/// <see cref="ITokenStore"/> over the platform keystore (SecureStorage). Reads that
/// the vault rejects are treated as "no token" so a corrupt entry never bricks the app.
/// </summary>
internal static class VaultTokenStore
{
    public static ITokenStore Create() => new DelegateTokenStore(
        get: async () =>
        {
            try { return await SecureStorage.Default.GetAsync(ActivationGate.TokenKey); }
            catch (Exception e)
            {
                System.Diagnostics.Debug.WriteLine("vault read: " + e.Message);
                return null;
            }
        },
        set: async token =>
        {
            await SecureStorage.Default.SetAsync(ActivationGate.TokenKey, token);
        },
        clear: () =>
        {
            try { SecureStorage.Default.Remove(ActivationGate.TokenKey); } catch { /* nothing stored */ }
            return Task.CompletedTask;
        });
}

/// <summary>
/// Non-secret marketplace IDENTITY cache (role / display name / user id) stored in
/// SecureStorage under its OWN key — the bearer token itself is never written here
/// (it lives only in <see cref="VaultTokenStore"/>, so the chat engine keeps reading
/// exactly one token as before). A fingerprint of the token is saved with the record
/// so a cache that belongs to an older session is ignored instead of mislabelled.
/// </summary>
internal static class SessionVault
{
    private const string IdentityKey = "vakil.session.account";

    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web);

    public static async Task SaveAsync(PersistedIdentity identity)
    {
        try
        {
            var json = JsonSerializer.Serialize(identity, Opts);
            await SecureStorage.Default.SetAsync(IdentityKey, json);
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("session vault save: " + e.Message);
        }
    }

    /// <summary>Returns the cached identity only when it belongs to <paramref name="tokenFingerprint"/>.</summary>
    public static async Task<PersistedIdentity?> LoadAsync(string tokenFingerprint)
    {
        try
        {
            var json = await SecureStorage.Default.GetAsync(IdentityKey);
            if (string.IsNullOrWhiteSpace(json)) return null;
            var loaded = JsonSerializer.Deserialize<PersistedIdentity>(json, Opts);
            if (loaded is null || !string.Equals(loaded.TokenFingerprint, tokenFingerprint, StringComparison.Ordinal))
                return null;
            return loaded;
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("session vault read: " + e.Message);
            return null;
        }
    }

    public static Task ClearAsync()
    {
        try { SecureStorage.Default.Remove(IdentityKey); } catch { /* nothing stored */ }
        return Task.CompletedTask;
    }
}
