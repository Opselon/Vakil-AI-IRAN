using VakilAI.Application.Contracts;
using VakilAI.Domain.ValueObjects;
using VakilAI.Infrastructure.Storage;

using Microsoft.Maui.Storage;

namespace Vakil_AI_IRAN;

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
