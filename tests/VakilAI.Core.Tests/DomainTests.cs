using VakilAI.Domain.Entities;
using VakilAI.Domain.ValueObjects;
using Xunit;

namespace VakilAI.Core.Tests;

/// <summary>
/// Value-object / entity semantics that the «وضعیت حساب من» page and the activation flow rely on.
/// </summary>
public class DomainTests
{
    // ─────────────────────────────── QuotaSnapshot ───────────────────────────────

    [Theory]
    [InlineData(100, 0, 100)]   // nothing left → 100% used
    [InlineData(100, 50, 50)]
    [InlineData(100, 90, 10)]
    [InlineData(100, 100, 0)]
    [InlineData(3, 2, 33.3333)]
    public void Quota_PercentUsed_MirrorsRemainingOfDailyLimit(int limit, int remaining, double expected)
    {
        var q = new QuotaSnapshot(true, remaining, limit);
        Assert.Equal(expected, q.PercentUsed, 2);
        Assert.Equal(limit - remaining, q.Used);
    }

    [Fact]
    public void Quota_NullRemaining_ReportsZeroUsage()
    {
        var q = new QuotaSnapshot(Allowed: false, Remaining: null, DailyLimit: 100);
        Assert.Equal(0, q.Used);
        Assert.Equal(0, q.PercentUsed);
    }

    [Fact]
    public void Quota_OverCreditedRemaining_NeverGoesNegative()
    {
        var q = new QuotaSnapshot(true, 120, 100);
        Assert.Equal(0, q.Used);
        Assert.Equal(0, q.PercentUsed);
    }

    [Fact]
    public void Quota_PercentUsed_ZeroLimit_IsZero()
    {
        Assert.Equal(0, new QuotaSnapshot(true, 5, 0).PercentUsed);
        Assert.Equal(0, new QuotaSnapshot(false, null, 0).PercentUsed);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(10)]
    [InlineData(50)]
    [InlineData(100)]
    public void Quota_PercentUsed_MonotonicAcrossUsage(int percent)
    {
        // The ASCII/emoji progress meter left Domain with the design-system pass
        // (presentation lives in the UI quota chip); PercentUsed is the source.
        Assert.Equal(percent, new QuotaSnapshot(true, 100 - percent, 100).PercentUsed, 0);
    }

    [Fact]
    public void Quota_AllowedFalse_StillReportsUsage()
    {
        var q = new QuotaSnapshot(false, 0, 100);
        Assert.False(q.Allowed);
        Assert.Equal(100, q.PercentUsed);
    }

    [Fact]
    public void Quota_IsUnlimited_DefaultsFalseAndIsIndependentOfUsage()
    {
        Assert.False(new QuotaSnapshot(true, 0, 100).IsUnlimited);
        Assert.True(new QuotaSnapshot(true, 0, 100, IsUnlimited: true).IsUnlimited);
    }

    [Fact]
    public void Quota_IsRecordWithByValueEquality()
    {
        Assert.Equal(new QuotaSnapshot(true, 5, 10), new QuotaSnapshot(true, 5, 10));
        Assert.NotEqual(new QuotaSnapshot(true, 5, 10), new QuotaSnapshot(true, 6, 10));
    }

    // ──────────────────────────────── DeviceId ────────────────────────────────

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("abcde", false)]        // 5 < MinLength
    [InlineData("abcdef", true)]        // exactly MinLength
    [InlineData("a b c d e", true)]     // 9 chars incl. spaces after trim
    [InlineData("  abcdefgh  ", true)]  // padded, trimmed length 8
    [InlineData("abcd", false)]
    public void DeviceId_MinLengthValidation(string? raw, bool expected)
        => Assert.Equal(expected, DeviceId.IsValid(raw));

    [Theory]
    [InlineData(6, true)]
    [InlineData(64, true)]
    [InlineData(65, false)]
    [InlineData(200, false)]
    public void DeviceId_MaxLengthValidation(int length, bool expected)
        => Assert.Equal(expected, DeviceId.IsValid(new string('d', length)));

    [Fact]
    public void DeviceId_ConstantsMatchServerContract()
    {
        Assert.Equal(6, DeviceId.MinLength);
        Assert.Equal(64, DeviceId.MaxLength);
    }

    [Fact]
    public void DeviceId_InstanceIsValidProperty_IsShadowedByStaticMethod()
    {
        // `new DeviceId("...").IsValid` does not compile: member lookup binds the static
        // IsValid(string?) method group, so the instance property is unreachable from C#
        // callers (see deviations). Assert the equivalent through the static helper.
        var id = new DeviceId("  abcdef  ");
        Assert.True(DeviceId.IsValid(id.Value));
        Assert.False(DeviceId.IsValid(new DeviceId("short").Value));
        Assert.False(DeviceId.IsValid(new DeviceId(" ").Value));
    }

    [Fact]
    public void DeviceId_RecordKeepsRawValue()
        => Assert.Equal("  abcdef  ", new DeviceId("  abcdef  ").Value);

    // ──────────────────────────── ActivationCode ────────────────────────────

    [Theory]
    [InlineData(3, false)]   // below the 4-char floor
    [InlineData(4, true)]
    [InlineData(32, true)]
    [InlineData(33, false)]  // above the 32-char ceiling
    public void ActivationCode_LengthWindow(int length, bool expected)
        => Assert.Equal(expected, ActivationCode.IsValid(new string('7', length)));

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("ABCD", true)]
    [InlineData(" 1234 ", true)]   // trimmed to 4
    public void ActivationCode_BlankAndPaddedInputs(string? raw, bool expected)
        => Assert.Equal(expected, ActivationCode.IsValid(raw));

    // ─────────────────────────────── AccessToken ───────────────────────────────

    private static readonly DateTimeOffset Issue = new(2026, 9, 13, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void AccessToken_IsExpired_HasFiveMinuteSafetyWindow()
    {
        var tok = new AccessToken("t", Issue, Issue.AddHours(1)); // expires 13:00
        Assert.False(tok.IsExpired(Issue));                        // 12:00 — fresh
        Assert.False(tok.IsExpired(Issue.AddMinutes(54)));         // 12:54 — 6 min left
        Assert.True(tok.IsExpired(Issue.AddMinutes(55)));          // 12:55 — exactly 5 min left
        Assert.True(tok.IsExpired(Issue.AddMinutes(59)));          // 12:59 — inside window
        Assert.True(tok.IsExpired(Issue.AddHours(1)));             // 13:00 — expired
        Assert.True(tok.IsExpired(Issue.AddHours(2)));             // long past
    }

    [Fact]
    public void AccessToken_AlreadyExpiredToken_IsExpiredImmediately()
    {
        var tok = new AccessToken("t", Issue, Issue.AddMinutes(-1));
        Assert.True(tok.IsExpired(Issue));
    }

    [Fact]
    public void AccessToken_WindowIsInclusiveOfTheBoundaryMinute()
    {
        var expires = Issue.AddMinutes(30);
        var tok = new AccessToken("t", Issue, expires);
        Assert.False(tok.IsExpired(expires.AddMinutes(-5).AddSeconds(-1)));
        Assert.True(tok.IsExpired(expires.AddMinutes(-5)));
    }

    [Fact]
    public void AccessToken_KeepsBearerValue()
        => Assert.Equal("opaque", new AccessToken("opaque", Issue, Issue.AddMinutes(1)).Value);

    // ──────────────────────────────── TehranTime ────────────────────────────────

    [Fact]
    public void TehranTime_NowTehran_IsAheadOfUtcByIranOffset()
    {
        var utc = DateTime.UtcNow;
        var local = TehranTime.NowTehran();
        var delta = local - utc;
        Assert.InRange(delta.TotalHours, 3, 5); // +03:30 standard, +04:00 if a DST rule is ever restored
    }

    [Fact]
    public void TehranTime_Countdown_IsPersianAndNonEmpty()
    {
        var s = TehranTime.CountdownToMidnightTehran();
        Assert.False(string.IsNullOrWhiteSpace(s));
        Assert.Contains("ساعت", s);
        Assert.Contains("دقیقه", s);
        Assert.Contains("ثانیه", s);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(23)]
    public void TehranTime_Countdown_DigitsArePlainNonNegative(int _)
    {
        var s = TehranTime.CountdownToMidnightTehran();
        Assert.DoesNotContain("-", s);
        Assert.Matches(@"\d+\s*ساعت", s);
    }

    [Fact]
    public void TehranTime_SecondsToMidnight_IsWithinOneDay()
    {
        for (var i = 0; i < 5; i++)
        {
            var left = TehranTime.SecondsToMidnightTehran();
            Assert.InRange(left, 0, 86_400);
        }
    }

    [Fact]
    public void TehranTime_SecondsAndCountdownAgree()
    {
        // The two helpers read the clock separately, so allow a one-step drift.
        var seconds = TehranTime.SecondsToMidnightTehran();
        var hours = int.Parse(TehranTime.CountdownToMidnightTehran().Split(' ')[0]);
        Assert.InRange(seconds / 3600 - hours, -1, 1);
    }

    [Fact]
    public void TehranTime_Countdown_RespectsTotalSecondsOfTheDay()
    {
        var left = TehranTime.SecondsToMidnightTehran();
        Assert.InRange(left, 1, 86_400);
    }

    // ──────────────────────────────── ChatButton ────────────────────────────────

    [Fact]
    public void ChatButton_StaticAction_UsesTextAsTitle()
    {
        var b = new ChatButton("👤 وضعیت حساب من", "cmd_limit", ButtonStyle.Primary);
        Assert.False(b.IsDynamicAction);
        Assert.Equal(b.Text, b.ActionTitle);
    }

    [Fact]
    public void ChatButton_DynamicAiAction_ExposesStrippedTitle()
    {
        var b = new ChatButton("ai_act|defense", "ai_act|defense", ButtonStyle.Success);
        Assert.True(b.IsDynamicAction);
        Assert.Equal("defense", b.ActionTitle);
    }

    [Theory]
    [InlineData("AI_ACT|x", false)]     // prefix match is ordinal / case-sensitive
    [InlineData("xai_act|y", false)]
    [InlineData("ai_act|", true)]
    public void ChatButton_DynamicPrefixMatching(string action, bool dynamic)
        => Assert.Equal(dynamic, new ChatButton("t", action, ButtonStyle.Primary).IsDynamicAction);

    [Fact]
    public void ChatButton_DynamicTitle_EmptySuffix_IsEmptyString()
        => Assert.Equal("", new ChatButton("t", "ai_act|", ButtonStyle.Danger).ActionTitle);

    // ─────────────────────────────── ChatMessage ───────────────────────────────

    [Fact]
    public void ChatMessage_DefaultsMatchMarkdownChatBubbleSemantics()
    {
        var m = new ChatMessage { Id = 1, Role = MessageRole.User, Text = "salam" };
        Assert.Equal(MessageKind.Chat, m.Kind);
        Assert.Equal(RenderFormat.Markdown, m.Format);
        Assert.Empty(m.Buttons);
        Assert.Empty(m.ThinkingFrames);
        Assert.False(m.IsStreaming);
        Assert.False(m.IsFailed);
        Assert.Null(m.EngineLabel);
        Assert.Null(m.LinkedAction);
        Assert.Equal(0, m.CreatedAtMs);
    }

    [Fact]
    public void RenderFormat_HtmlAndMarkdownAreTheOnlyWireFormats()
        => Assert.Equal(new[] { RenderFormat.Markdown, RenderFormat.Html },
            (RenderFormat[])Enum.GetValues(typeof(RenderFormat)));

    [Fact]
    public void MessageKinds_CoverEveryServerKind()
    {
        Assert.Equal(5, Enum.GetValues<MessageKind>().Length);
        Assert.Contains(MessageKind.Warning, Enum.GetValues<MessageKind>());
        Assert.Contains(MessageKind.Drafting, Enum.GetValues<MessageKind>());
    }
}
