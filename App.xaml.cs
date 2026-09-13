using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Pages;

namespace Vakil_AI_IRAN;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        // Follow the system light/dark setting (AppTheme.Unspecified = no override).
        UserAppTheme = AppTheme.Unspecified;
    }

    // No Shell: the window starts on the animated boot page and swaps to Activation
    // or Chat once the stored session token is read (fast — SecureStorage is local).
    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(new Controls.BootPage()) { Title = "وکیل هوشمند ایران" };
        _ = RouteAsync(window);
        return window;
    }

    private static async Task RouteAsync(Window window)
    {
        Page start;
        try
        {
            var gate = MauiProgram.Services.GetRequiredService<ActivationGate>();
            start = await gate.HasActiveSessionAsync()
                ? (Page)MauiProgram.Services.GetRequiredService<ChatPage>()
                : MauiProgram.Services.GetRequiredService<ActivationPage>();
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("route failed: " + e);
            start = MauiProgram.Services.GetRequiredService<ActivationPage>();
        }

        // hold the boot scene for its full beat (~1.1s) so the swap never flashes
        await Task.Delay(1100);
        await MainThread.InvokeOnMainThreadAsync(() => window.Page = start);
    }
}
