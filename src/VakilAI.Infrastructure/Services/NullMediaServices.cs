namespace VakilAI.Infrastructure.Services;

using VakilAI.Application.Contracts;

/// <summary>
/// <see cref="IAudioRecorder"/> for platforms or builds where microphone capture is not wired up
/// (for example the desktop/test host). It always reports "unavailable", so the UI can hide the
/// voice button instead of failing at capture time.
/// </summary>
public sealed class NullAudioRecorder : IAudioRecorder
{
    /// <summary>Message carried by every unsupported operation.</summary>
    public const string UnsupportedMessage = "unsupported";

    /// <summary>Shared instance — the type holds no state.</summary>
    public static NullAudioRecorder Shared { get; } = new();

    /// <inheritdoc />
    public bool IsAvailable => false;

    /// <inheritdoc />
    public Task<bool> HasPermissionAsync() => Task.FromResult(false);

    /// <inheritdoc />
    public Task StartAsync(CancellationToken ct = default) =>
        Task.FromException(new InvalidOperationException(UnsupportedMessage));

    /// <inheritdoc />
    public Task<CapturedAudio> StopAndCaptureAsync(CancellationToken ct = default) =>
        Task.FromException<CapturedAudio>(new InvalidOperationException(UnsupportedMessage));

    /// <inheritdoc />
    public Task CancelAsync() => Task.CompletedTask;
}

/// <summary>
/// <see cref="IMediaPicker"/> that never returns a photo. Used when camera/gallery capture is not
/// available on the host; callers already treat <c>null</c> as "the user picked nothing".
/// </summary>
public sealed class NullMediaPicker : IMediaPicker
{
    /// <summary>Shared instance — the type holds no state.</summary>
    public static NullMediaPicker Shared { get; } = new();

    /// <inheritdoc />
    public Task<CapturedImage?> PickDocumentPhotoAsync(int maxDimension = 1280, CancellationToken ct = default) =>
        Task.FromResult<CapturedImage?>(null);
}

/// <summary>
/// <see cref="IConnectivity"/> that always reports online. Handy on desktop and in tests, where
/// there is no network-status source to poll; <see cref="Changed"/> therefore never fires.
/// </summary>
public sealed class AlwaysOnlineConnectivity : IConnectivity
{
    /// <summary>Shared instance — the type holds no state.</summary>
    public static AlwaysOnlineConnectivity Shared { get; } = new();

    /// <inheritdoc />
    public bool IsOnline => true;

    /// <inheritdoc />
    /// <remarks>Deliberately empty: this implementation has no source of connectivity updates.</remarks>
    public event EventHandler<bool>? Changed
    {
        add { }
        remove { }
    }
}
