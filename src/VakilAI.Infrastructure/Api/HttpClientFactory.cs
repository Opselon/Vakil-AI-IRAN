using System.Reflection;
using VakilAI.Application.Contracts;

namespace VakilAI.Infrastructure.Api;

/// <summary>
/// HttpClient factory wired for production: HTTP/2, compressions, sane timeouts,
/// per-base-address handler reuse. TLS: default system trust store + cert pinning
/// is enforced on the server side via Cloudflare; the client additionally rejects
/// plaintext http:// base addresses (defense-in-depth against misconfiguration).
/// </summary>
public static class HttpClientFactory
{
    public const string DefaultBaseUrl = "https://vakil-ai.workers.dev/";

    public static string ResolveBaseUrl(string? configured)
    {
        var url = string.IsNullOrWhiteSpace(configured) ? DefaultBaseUrl : configured.Trim();
        if (!url.EndsWith('/')) url += "/";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("آدرس سرور باید HTTPS معتبر باشد: " + url);
        return url;
    }

    public static HttpClient Create(string? configuredBaseUrl = null)
    {
        var handler = new SocketsHttpHandler
        {
            AutomaticDecompression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Deflate | System.Net.DecompressionMethods.Brotli,
            EnableMultipleHttp2Connections = true,
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(60),
            ConnectTimeout = TimeSpan.FromSeconds(10),
            KeepAlivePingDelay = TimeSpan.FromSeconds(20),
            KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
        };

        // HttpVersionDecompression only exists on newer runtimes (net11+); set it by
        // reflection so this assembly compiles against net10.0 and still upgrades
        // automatically when it runs on a runtime that has the property.
        TryEnableHttpVersionDecompression(handler);

        var client = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = new Uri(ResolveBaseUrl(configuredBaseUrl)),
            Timeout = Timeout.InfiniteTimeSpan // per-call CTS governs
        };
        client.DefaultRequestVersion = new Version(2, 0);
        client.DefaultRequestHeaders.Add("Accept", "application/json");
        client.DefaultRequestHeaders.AcceptEncoding.Add(new("gzip"));
        client.DefaultRequestHeaders.AcceptEncoding.Add(new("br"));
        client.DefaultRequestHeaders.AcceptEncoding.Add(new("deflate"));
        return client;
    }

    private static void TryEnableHttpVersionDecompression(SocketsHttpHandler handler)
    {
        try
        {
            var prop = handler.GetType().GetProperty("HttpVersionDecompression");
            if (prop is null || !prop.CanWrite) return;

            var enumType = prop.PropertyType;
            object? value = null;
            foreach (var name in enumType.GetEnumNames())
            {
                if (string.Equals(name, "All", StringComparison.OrdinalIgnoreCase))
                {
                    value = Enum.Parse(enumType, name);
                    break;
                }
            }

            if (value is null)
            {
                long combined = 0;
                foreach (var v in enumType.GetEnumValues())
                    combined |= Convert.ToInt64(v);
                value = Enum.ToObject(enumType, combined);
            }

            prop.SetValue(handler, value);
        }
        catch
        {
            // older/unsupported runtime — AutomaticDecompression above already covers HTTP/1.1
        }
    }
}
