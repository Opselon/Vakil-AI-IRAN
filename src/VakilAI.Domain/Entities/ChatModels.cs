namespace VakilAI.Domain.Entities;

public enum MessageRole { User, Assistant, System }
public enum MessageKind { Chat, Action, Page, Drafting, Warning }
public enum RenderFormat { Markdown, Html }
public enum ButtonStyle { Primary, Success, Danger }

/// <summary>A chat action button delivered by the Vakil API keyboard.</summary>
public sealed record ChatButton(string Text, string Action, ButtonStyle Style)
{
    public bool IsDynamicAction => Action.StartsWith("ai_act|", StringComparison.Ordinal);
    public string ActionTitle => IsDynamicAction ? Action["ai_act|".Length..] : Text;
}

/// <summary>One chat message (persisted locally — the client is the source of truth).</summary>
public sealed record ChatMessage
{
    public required long Id { get; init; }
    public required MessageRole Role { get; init; }
    public MessageKind Kind { get; init; } = MessageKind.Chat;
    public required string Text { get; init; }
    public RenderFormat Format { get; init; } = RenderFormat.Markdown;
    public long CreatedAtMs { get; init; }
    public string? LinkedAction { get; init; }
    public IReadOnlyList<ChatButton> Buttons { get; init; } = Array.Empty<ChatButton>();
    public bool IsStreaming { get; init; }
    public bool IsFailed { get; init; }
    public string? EngineLabel { get; init; }

    /// <summary>Per-message transcript of the animated thinking frames (server-provided).</summary>
    public IReadOnlyList<string> ThinkingFrames { get; init; } = Array.Empty<string>();

    /// <summary>Conversation this message belongs to (0 = pre-threads sentinel —
    /// the SQLite migration backfills every legacy row into conversation 1, so
    /// a live message never carries 0).</summary>
    public long ThreadId { get; init; }
}

/// <summary>One local AI conversation (threads are device-owned; the server is
/// stateless per request and never learns thread ids).</summary>
public sealed record Conversation
{
    /// <summary>Title of the backfilled bucket that owns every pre-threads message.</summary>
    public const string LegacyTitle = "گفتگوهای پیشین";
    public const string Untitled = "گفتگوی تازه";

    public required long Id { get; init; }
    public required string Title { get; init; }
    public long CreatedAtMs { get; init; }
    public long UpdatedAtMs { get; init; }
    public bool Pinned { get; init; }
    public int MessageCount { get; init; }
    public string? LastSnippet { get; init; }
}

/// <summary>Daily quota snapshot (mirrors 👤 وضعیت حساب من page semantics).
/// Presentation (chip text, tone color) lives in the UI layer — this is pure
/// arithmetic; the legacy ASCII/emoji progress meter was removed with the
/// design-system pass (status color comes from PercentUsed thresholds in UI).</summary>
public sealed record QuotaSnapshot(bool Allowed, int? Remaining, int DailyLimit, bool IsUnlimited = false)
{
    public int Used => Remaining.HasValue ? Math.Max(0, DailyLimit - Remaining.Value) : 0;
    public double PercentUsed => DailyLimit <= 0 ? 0 : Math.Clamp(Used * 100.0 / DailyLimit, 0, 100);
}
