using VakilAI.Domain.Entities;
using VakilAI.Domain.ValueObjects;

namespace VakilAI.Application.Contracts;

// ────────────────────────── API wire DTOs (server: /api/v1) ──────────────────────────
// Field names MUST match server/src/app_api.js exactly.

public sealed record ApiEnvelope(bool Ok, string? Code = null, string? Message = null);

public sealed record VerifyRequest(string DeviceId, string Code, string Name, string Platform);

public sealed record QuotaDto(bool Allowed, int? Remaining, int DailyLimit, string? ResetHint);

public sealed record VerifyResponse(bool Ok, string? Token, long? UserId, QuotaDto? Quota, string? Code = null, string? Message = null);

public sealed record ChatRequest(string Token, string Text, string? ImageBase64 = null, string? ImageMime = null, string? AudioBase64 = null, string? AudioMime = null);

/// <summary>kind=chat | drafting | draft_cancelled | page | action_result; ok=false ⇒ code+message.</summary>
public sealed record ChatResponse(
    bool Ok,
    string? Kind,
    string? Format,
    string[]? Chunks,
    string? Text,
    KeyboardDto[][]? Keyboard,
    QuotaDto? Quota,
    string? Code,
    string? Message,
    bool? Costless,
    bool? Fallback,
    string[]? ThinkingFrames,
    string? Page);

public sealed record KeyboardDto(string Text, string Action, string Style);

public sealed record QuickActionRequest(string Token, string Action, string? ContextText = null);

public sealed record HistoryItem(string Role, string Content, long CreatedAt);

public sealed record HistoryResponse(bool Ok, HistoryItem[]? Items, string? Code = null);

// ────────────────────────── Port: HTTP gateway ──────────────────────────

public sealed class AppApiException(string code, string message, int httpStatus) : Exception(message)
{
    public string Code { get; } = code;
    public int HttpStatus { get; } = httpStatus;
}

public interface IAppApi
{
    Task<bool> ProbeHealthAsync(CancellationToken ct = default);
    Task<VerifyResponse> VerifyAsync(VerifyRequest request, CancellationToken ct = default);
    Task<ChatResponse> ChatAsync(ChatRequest request, CancellationToken ct = default);
    Task<ChatResponse> QuickActionAsync(QuickActionRequest request, CancellationToken ct = default);
    Task<HistoryResponse> HistoryAsync(string token, CancellationToken ct = default);
    /// <summary>Raw SSE-ish progress: not used in v1 (server sends final payload).</summary>
}

// ────────────────────────── Port: session/keys ──────────────────────────

public interface ITokenStore
{
    Task<string?> GetTokenAsync();
    Task SaveTokenAsync(string token);
    Task ClearAsync();
}

// ────────────────────────── Port: platform media ──────────────────────────

public sealed record CapturedAudio(byte[] Data, string MimeType, int DurationSeconds);
public sealed record CapturedImage(byte[] Data, string MimeType, int MaxDimension);

public interface IAudioRecorder
{
    bool IsAvailable { get; }
    Task<bool> HasPermissionAsync();
    Task StartAsync(CancellationToken ct = default);
    Task<CapturedAudio> StopAndCaptureAsync(CancellationToken ct = default);
    Task CancelAsync();
}

public interface IMediaPicker
{
    Task<CapturedImage?> PickDocumentPhotoAsync(int maxDimension = 1280, CancellationToken ct = default);
}

// ────────────────────────── Port: environment ──────────────────────────

public interface IDeviceIdentity
{
    Task<DeviceId> GetOrCreateAsync();
    Task<string> PlatformNameAsync();
}

public interface IConnectivity
{
    bool IsOnline { get; }
    event EventHandler<bool>? Changed;
}

/// <summary>Cryptographic random for device ids / local keys.</summary>
public interface IRng
{
    string NextHex(int bytes);
}
