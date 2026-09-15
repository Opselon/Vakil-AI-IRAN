using System.Diagnostics;

namespace Vakil_AI_IRAN.Controls;

/// <summary>
/// Shared motion primitives. Every loop here is cancellation-token bound so an
/// animation can never outlive the element that started it (leaked loops were the
/// cause of background CPU burn on Android in earlier builds).
/// </summary>
public static class UiMotion
{
    /// <summary>Standard entrance: fade + rise with a soft overshoot.</summary>
    public static async Task RiseInAsync(View view, uint delayMs = 0, uint durationMs = 260, double rise = 16)
    {
        if (view is null) return;
        try
        {
            view.Opacity = 0;
            view.TranslationY = rise;
            if (delayMs > 0) await Task.Delay((int)delayMs);
            if (view.Handler is null) return; // page vanished while we waited
            await view.FadeToAsync(1, durationMs, Easing.CubicOut);
            await view.TranslateToAsync(0, 0, durationMs + 40, Easing.SpringOut);
        }
        catch (Exception e) { Debug.WriteLine("rise: " + e.Message); }
    }

    /// <summary>Press feedback that works for Buttons (Pressed/Released) and Borders (pointer/tap).</summary>
    public static async Task PressPopAsync(VisualElement element, double to = 0.955)
    {
        if (element is not View v) return;
        try
        {
            await v.ScaleToAsync(to, 90, Easing.CubicOut);
            await v.ScaleToAsync(1, 170, Easing.SpringOut);
        }
        catch (Exception e) { Debug.WriteLine("press: " + e.Message); }
    }

    /// <summary>
    /// Runs <paramref name="cycle"/> forever (awaiting between rounds) until the token
    /// is cancelled. Exceptions end the loop quietly instead of crashing the app.
    /// </summary>
    public static void Loop(CancellationToken token, Func<CancellationToken, Task> cycle)
    {
        _ = RunAsync();

        async Task RunAsync()
        {
            try
            {
                while (!token.IsCancellationRequested)
                    await cycle(token);
            }
            catch (OperationCanceledException) { /* expected on unload */ }
            catch (Exception e) { Debug.WriteLine("loop: " + e.Message); }
        }
    }

    /// <summary>Delay that throws OperationCanceledException when the loop stops.</summary>
    public static Task SleepAsync(int ms, CancellationToken token) => Task.Delay(ms, token);

    /// <summary>Light tick on an accepted tap. The class lives under
    /// Microsoft.Maui.Devices and is unsupported on some platforms — those
    /// throw PlatformNotSupportedException and stay silent here.</summary>
    public static void TapHaptic()
    {
        try { Microsoft.Maui.Devices.HapticFeedback.Default.Perform(Microsoft.Maui.Devices.HapticFeedbackType.Click); }
        catch { /* haptics are a bonus, never a crash surface */ }
    }
}
