using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Pages;
using VakilAI.Application.Contracts;

namespace Vakil_AI_IRAN;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        // Follow the system light/dark setting (AppTheme.Unspecified = no override).
        UserAppTheme = AppTheme.Unspecified;
    }

    // No Shell: the window starts on the animated boot page and swaps once the
    // marketplace coordinator has read the persisted session (VAKIL_V1_SPEC §5).
    //   token in vault (account OR legacy activation) → Chat  — the pre-V1 rule,
    //                                                     zero behavioural change
    //   nothing stored                                 → Auth  (signup/login/Google)
    // The decision waits only on the LOCAL vault read; the /auth/me hydration
    // continues in the background and refreshes the cached identity afterwards,
    // so a cold network can never delay or lock the user out of their chat.
    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(new Controls.BootPage()) { Title = "وکیل هوشمند ایران" };
        _ = RouteAsync(window);
        return window;
    }

    private static async Task RouteAsync(Window window)
    {
        var startedAt = Environment.TickCount64;
        Page start;
        try
        {
            // Fire restore without blocking the boot beat: the vault read is
            // local and lands in milliseconds (provisional session → Restored),
            // while /auth/me hydration keeps running in the background and
            // updates the session (SessionChanged) — routing depends ONLY on
            // "is there a token", exactly the pre-V1 rule.
            var coordinator = MauiProgram.Services.GetRequiredService<Services.MarketplaceCoordinator>();
            _ = coordinator.RestoreAsync();

            await Task.Delay(1100); // hold the boot scene so the swap never flashes
            while (!coordinator.Restored && Environment.TickCount64 - startedAt < 2600)
                await Task.Delay(60);

            start = coordinator.Current.IsSignedIn
                ? (Page)MauiProgram.Services.GetRequiredService<ChatPage>()
                : MauiProgram.Services.GetRequiredService<AuthPage>();

            // Audit 2.4 (slow keystore): if we had to route BEFORE the restore
            // finished and landed on Auth while a session actually exists, the
            // SessionChanged hook below swaps once — a very slow vault read must
            // never strand a signed-in legacy user on the signup screen.
            if (!coordinator.Restored && start is AuthPage)
            {
                void OnSession(object? s, VakilAI.Application.Contracts.AccountSession sess)
                {
                    if (!sess.IsSignedIn) return;
                    coordinator.SessionChanged -= OnSession;
                    MainThread.BeginInvokeOnMainThread(() =>
                    {
                        try
                        {
                            if (window.Page is AuthPage)
                                window.Page = MauiProgram.Services.GetRequiredService<ChatPage>();
                        }
                        catch (Exception ex) { System.Diagnostics.Debug.WriteLine("re-route: " + ex); }
                    });
                }
                coordinator.SessionChanged += OnSession;
            }
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("route failed: " + e);
            // last-resort fallback = the exact pre-marketplace gate (legacy token
            // → Chat, otherwise the activation screen). The chat can never be
            // bricked by the new layer failing.
            try
            {
                var gate = MauiProgram.Services.GetRequiredService<ActivationGate>();
                start = await gate.HasActiveSessionAsync()
                    ? (Page)MauiProgram.Services.GetRequiredService<ChatPage>()
                    : MauiProgram.Services.GetRequiredService<ActivationPage>();
            }
            catch
            {
                start = MauiProgram.Services.GetRequiredService<ActivationPage>();
            }
        }

        var remaining = 1100 - (Environment.TickCount64 - startedAt);
        if (remaining > 0) await Task.Delay((int)remaining);
        await MainThread.InvokeOnMainThreadAsync(() => window.Page = start);
    }
}
