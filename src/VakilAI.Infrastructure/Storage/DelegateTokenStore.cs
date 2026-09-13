namespace VakilAI.Infrastructure.Storage;

using VakilAI.Application.Contracts;

/// <summary>
/// Platform-agnostic <see cref="ITokenStore"/> that delegates persistence to caller-supplied
/// callbacks. The MAUI host wires these to <c>SecureStorage</c> (keychain / keystore), while tests
/// can wire them to a dictionary. This keeps VakilAI.Infrastructure free of any platform SDK so the
/// xUnit project can reference it on plain <c>net10.0</c>.
/// </summary>
/// <remarks>
/// The last known value is cached so a repeated <see cref="GetTokenAsync"/> after a
/// <see cref="SaveTokenAsync"/> does not have to hit the (comparatively slow) platform keystore.
/// All cache access is guarded by a lock; the backing delegates may still be called concurrently.
/// </remarks>
public sealed class DelegateTokenStore(Func<Task<string?>> get, Func<string, Task> set, Func<Task> clear) : ITokenStore
{
    private readonly object _gate = new();

    /// <summary>Most recent token known to this instance (null = signed out / unknown).</summary>
    private volatile string? _cache;

    /// <summary>The vault/session token, or <c>null</c> when the user is not activated yet.</summary>
    public async Task<string?> GetTokenAsync()
    {
        lock (_gate)
        {
            if (_cache is not null)
            {
                return _cache;
            }
        }

        string? stored;
        try
        {
            stored = await get().ConfigureAwait(false);
        }
        catch (KeyNotFoundException)
        {
            // Some secure-storage backends signal "no such entry" this way.
            stored = null;
        }

        lock (_gate)
        {
            _cache = stored;
        }

        return stored;
    }

    /// <summary>Persist a freshly issued session token and refresh the in-memory cache.</summary>
    public async Task SaveTokenAsync(string token)
    {
        ArgumentNullException.ThrowIfNull(token);

        await set(token).ConfigureAwait(false);

        lock (_gate)
        {
            _cache = token;
        }
    }

    /// <summary>
    /// Remove the stored token (sign-out). Failures to delete are swallowed: after this call the
    /// session is considered gone regardless of what the keystore reports.
    /// </summary>
    public async Task ClearAsync()
    {
        try
        {
            await clear().ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Nothing is stored any more as far as the app is concerned.
        }

        lock (_gate)
        {
            _cache = null;
        }
    }
}
