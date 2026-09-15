using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Maui.Storage;
using VakilAI.Application;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Repositories;
using VakilAI.Infrastructure.Api;
using VakilAI.Infrastructure.Security;
using VakilAI.Infrastructure.Services;
using VakilAI.Infrastructure.Storage;
using Vakil_AI_IRAN.Services;

using AppLogger = VakilAI.Application.ILogger;
using IConnectivity = VakilAI.Application.Contracts.IConnectivity;
using IMediaPicker = VakilAI.Application.Contracts.IMediaPicker;

namespace Vakil_AI_IRAN;

public static class MauiProgram
{
    /// <summary>Root service provider — pages resolve their dependencies from here
    /// (the app deliberately avoids Shell + x:Arguments DI for XAML reliability).</summary>
    public static IServiceProvider Services { get; private set; } = null!;

    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
                fonts.AddFont("Vazirmatn-Regular.ttf", "VazirmatnRegular");
                fonts.AddFont("Vazirmatn-Medium.ttf", "VazirmatnMedium");
                fonts.AddFont("Vazirmatn-Bold.ttf", "VazirmatnBold");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif

        var services = builder.Services;

        // ───────────────── platform → application adapters ─────────────────
        services.AddSingleton<AppLogger, MauiLoggerAdapter>();

        // Optional server override (dev/demo builds): hidden setting in Preferences,
        // otherwise the production default baked into Infrastructure.
        services.AddSingleton(_ =>
        {
            string? configured = null;
            try
            {
                var v = Preferences.Default.Get("vakil.server.url", string.Empty);
                if (!string.IsNullOrWhiteSpace(v)) configured = v;
            }
            catch { /* essentials not ready */ }
            return HttpClientFactory.Create(configured);
        });

        services.AddSingleton<IAppApi>(sp => new AppApiClient(
            sp.GetRequiredService<HttpClient>(),
            sp.GetRequiredService<AppLogger>(),
            async () => (await sp.GetRequiredService<IDeviceStore>().GetDeviceIdAsync())?.Value));

        // Marketplace surface (auth/lawyers/consultations/payments/admin) — V1.
        // UI pages must consume IMarketplaceApi; never a raw HttpClient.
        services.AddSingleton<IMarketplaceApi>(sp => new MarketplaceApiClient(
            sp.GetRequiredService<HttpClient>(),
            sp.GetRequiredService<AppLogger>(),
            async () => (await sp.GetRequiredService<IDeviceStore>().GetDeviceIdAsync())?.Value));

        services.AddSingleton<IRng>(_ => CryptoRng.Shared);
        services.AddSingleton<IDeviceStore>(_ => new DelegateDeviceStore(
            read: key =>
            {
                var v = Preferences.Default.Get(key, string.Empty);
                return Task.FromResult(string.IsNullOrEmpty(v) ? null : v);
            },
            write: (key, value) =>
            {
                Preferences.Default.Set(key, value);
                return Task.CompletedTask;
            },
            CryptoRng.Shared));
        services.AddSingleton<IDeviceIdentity>(sp => new DeviceIdentity(
            sp.GetRequiredService<IDeviceStore>(),
            sp.GetRequiredService<IRng>(),
            PlatformLabel()));

        services.AddSingleton<ITokenStore>(_ => VaultTokenStore.Create());

        // db path is resolved lazily (first resolve) so FileSystem runs after platform init
        services.AddSingleton<IChatRepository>(sp => new SqliteChatRepository(
            Path.Combine(FileSystem.AppDataDirectory, "vakil-chat.db3"), sp.GetRequiredService<AppLogger>()));
        // Conversations (threads) live in the SAME db/connection as messages —
        // one owner for deletes of a thread + its rows (privacy invariant).
        services.AddSingleton<IConversationRepository>(sp => (IConversationRepository)sp.GetRequiredService<IChatRepository>());
        services.AddSingleton<IDraftingRepository>(sp => new SqliteSettingsStore(
            Path.Combine(FileSystem.AppDataDirectory, "vakil-chat.db3"), sp.GetRequiredService<AppLogger>()));

        services.AddSingleton<IConnectivity, MauiConnectivity>();

        // Mic capture lands in the next release — the UI shows an honest "not yet"
        // notice via NullAudioRecorder (IsAvailable=false) instead of failing mid-recording.
        services.AddSingleton<IAudioRecorder>(_ => NullAudioRecorder.Shared);
        services.AddSingleton<IMediaPicker, MauiMediaPicker>();

        // ───────────────── application services + presentation ─────────────────
        services.AddSingleton<ChatService>(sp => new ChatService(
            sp.GetRequiredService<IAppApi>(),
            sp.GetRequiredService<IChatRepository>(),
            sp.GetRequiredService<IConversationRepository>(),
            sp.GetRequiredService<IDraftingRepository>(),
            sp.GetRequiredService<ITokenStore>(),
            sp.GetRequiredService<IConnectivity>(),
            sp.GetRequiredService<AppLogger>()));
        services.AddSingleton<IChatService>(sp => sp.GetRequiredService<ChatService>());
        services.AddSingleton<ActivationGate>();

        // ───────── marketplace session + navigation authority (Agent 10) ─────────
        // Singleton: every page asks this for the current identity, and it is the
        // ONLY writer of the identity cache + swapper of Window.Page. The concrete
        // type is registered too so App can read `Restored` during the boot beat.
        services.AddSingleton<MarketplaceCoordinator>();
        services.AddSingleton<IMarketplaceCoordinator>(sp => sp.GetRequiredService<MarketplaceCoordinator>());

        services.AddTransient<Pages.ActivationPage>();   // kept for compat (legacy gate + App fallback)
        services.AddTransient<Pages.ChatPage>();
        services.AddTransient<Pages.AuthPage>();
        services.AddTransient<Pages.ConsultChatPage>();
        services.AddTransient<Pages.LawyersPage>();       // Agent 5's pages — types exist at edit time
        services.AddTransient<Pages.LawyerProfilePage>();
        services.AddTransient<Pages.ConsultationsPage>(); // coordinator's consultation hub (soft-resolved route Consultations)
        // NOTE(Agent 10): if a later refactor removes either Agent 5 page, delete its
        // line here — the coordinator resolves those routes by type name at runtime
        // and degrades to an honest "به‌زودی" notice when the type is absent.

        var app = builder.Build();
        Services = app.Services;
        return app;
    }

    private static string PlatformLabel()
    {
        var raw = DeviceInfo.Platform.ToString();
        if (raw.Contains("Android", StringComparison.OrdinalIgnoreCase)) return "android";
        if (raw.Contains("Win", StringComparison.OrdinalIgnoreCase)) return "windows";
        if (raw.Contains("iOS", StringComparison.OrdinalIgnoreCase)) return "ios";
        if (raw.Contains("MacCatalyst", StringComparison.OrdinalIgnoreCase)) return "mac";
        return raw.ToLowerInvariant();
    }
}

/// <summary>Bridges the tiny VakilAI.Application logger onto Microsoft.Extensions.Logging.</summary>
internal sealed class MauiLoggerAdapter(ILogger<MauiLoggerAdapter> inner) : VakilAI.Application.ILogger
{
    public void Info(string message) => inner.LogInformation("{VakilLog}", message);
    public void Warn(string message) => inner.LogWarning("{VakilLog}", message);
    public void Error(string message) => inner.LogError("{VakilLog}", message);
}
