namespace VakilAI.Infrastructure.Security;

using System.Security.Cryptography;
using System.Text;

using VakilAI.Application.Contracts;

/// <summary>
/// <see cref="IRng"/> backed by the operating system CSPRNG
/// (<see cref="RandomNumberGenerator.Fill"/>). Pure BCL, so it behaves identically on
/// Android, iOS, Windows and inside unit tests.
/// </summary>
public sealed class CryptoRng : IRng
{
    /// <summary>Largest request served in one buffer allocation; bigger requests are looped.</summary>
    private const int MaxChunkBytes = 256;

    private static readonly char[] HexDigits = "0123456789abcdef".ToCharArray();

    /// <summary>Shared instance — the type holds no state.</summary>
    public static CryptoRng Shared { get; } = new();

    /// <inheritdoc />
    /// <exception cref="ArgumentOutOfRangeException">Thrown when <paramref name="bytes"/> is not positive.</exception>
    public string NextHex(int bytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(bytes);

        var builder = new StringBuilder(bytes * 2);
        var buffer = new byte[Math.Min(bytes, MaxChunkBytes)];

        var remaining = bytes;
        while (remaining > 0)
        {
            var take = Math.Min(remaining, buffer.Length);
            RandomNumberGenerator.Fill(take == buffer.Length ? buffer : buffer.AsSpan(0, take));

            for (var i = 0; i < take; i++)
            {
                var b = buffer[i];
                builder.Append(HexDigits[b >> 4]);
                builder.Append(HexDigits[b & 0x0F]);
            }

            remaining -= take;
        }

        return builder.ToString();
    }
}
