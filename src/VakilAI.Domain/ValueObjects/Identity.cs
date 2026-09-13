namespace VakilAI.Domain.ValueObjects;

/// <summary>Stable device identity used for app activation and quota binding.</summary>
public sealed record DeviceId(string Value)
{
    public const int MinLength = 6;
    public const int MaxLength = 64;

    public static bool IsValid(string? raw) =>
        !string.IsNullOrWhiteSpace(raw) && raw.Trim().Length is >= MinLength and <= MaxLength;

    public bool IsValidValue => IsValid(Value);
}

/// <summary>Opaque bearer token issued by POST /api/v1/auth/verify.</summary>
public sealed record AccessToken(string Value, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt)
{
    public bool IsExpired(DateTimeOffset now) => now >= ExpiresAt.AddMinutes(-5);
}

/// <summary>Activation code entered by the user (APP_CHANNEL_CODE on the server).</summary>
public sealed record ActivationCode(string Value)
{
    public static bool IsValid(string? raw) =>
        !string.IsNullOrWhiteSpace(raw) && raw.Trim().Length is >= 4 and <= 32;
}

/// <summary>Tehran-aware clock helper (quota resets at Tehran midnight).</summary>
public static class TehranTime
{
    private static readonly TimeZoneInfo Tehran = GetTehranZone();

    public static DateTime NowTehran() => TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, Tehran);

    public static string CountdownToMidnightTehran()
    {
        var now = NowTehran();
        var midnight = now.Date.AddDays(1);
        var left = midnight - now;
        return $"{(int)left.TotalHours} ساعت و {left.Minutes} دقیقه و {left.Seconds} ثانیه";
    }

    public static int SecondsToMidnightTehran()
    {
        var now = NowTehran();
        return (int)(now.Date.AddDays(1) - now).TotalSeconds;
    }

    private static TimeZoneInfo GetTehranZone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Tehran"); }
        catch
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById("Iran Standard Time"); }
            catch { return TimeZoneInfo.CreateCustomTimeZone("Tehran", TimeSpan.FromHours(3.5), "Tehran", "Tehran"); }
        }
    }
}
