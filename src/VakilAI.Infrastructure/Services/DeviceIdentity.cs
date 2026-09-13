namespace VakilAI.Infrastructure.Services;

using VakilAI.Application.Contracts;
using VakilAI.Domain.Repositories;
using VakilAI.Domain.ValueObjects;

/// <summary>
/// Resolves the app's stable device identifier and a human-readable platform label.
/// The platform name is injected (the MAUI host reads <c>DeviceInfo</c> once at composition time)
/// so this class stays free of platform APIs and can be unit tested anywhere.
/// </summary>
public sealed class DeviceIdentity(IDeviceStore store, IRng rng, string platformName = "unknown") : IDeviceIdentity
{
    /// <summary>Prefix for identifiers minted by this service.</summary>
    public const string Prefix = "d-";

    /// <summary>Entropy of a minted identifier, in bytes (16 bytes = 32 lowercase hex chars).</summary>
    public const int IdEntropyBytes = 16;

    /// <inheritdoc />
    /// <remarks>The value is persisted on first use, so the id survives app restarts and updates.</remarks>
    public async Task<DeviceId> GetOrCreateAsync()
    {
        var existing = await store.GetDeviceIdAsync().ConfigureAwait(false);
        if (existing is not null && DeviceId.IsValid(existing.Value))
        {
            return existing;
        }

        var created = new DeviceId(Prefix + rng.NextHex(IdEntropyBytes));
        await store.SaveDeviceIdAsync(created).ConfigureAwait(false);
        return created;
    }

    /// <inheritdoc />
    /// <remarks>Pure: returns the label supplied at construction, never touches platform APIs.</remarks>
    public Task<string> PlatformNameAsync() => Task.FromResult(
        string.IsNullOrWhiteSpace(platformName) ? "unknown" : platformName.Trim());
}
