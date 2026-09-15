using Android.App;
using Android.Content.PM;
using Android.OS;
using Android.Views;

namespace Vakil_AI_IRAN
{
    // WindowSoftInputMode: declare adjustResize explicitly (SystemDefault lets some
    // OEM skins pan or clip). This is what keeps the chat/consult ComposerBar pinned
    // above the on-screen keyboard on every Android phone instead of loading behind
    // it or dragging the whole transcript off-screen when the IME opens.
    [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
        WindowSoftInputMode = SoftInput.AdjustResize | SoftInput.StateUnspecified,
        ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
    public class MainActivity : MauiAppCompatActivity
    {
        static MainActivity? _current;

        protected override void OnCreate(Bundle? savedInstanceState)
        {
            base.OnCreate(savedInstanceState);
            _current = this;
            ApplySystemBars();
        }

        protected override void OnResume()
        {
            base.OnResume();
            ApplySystemBars();
        }

        /// <summary>Paints the status bar with the page ground color of the CURRENT
        /// app theme (dark #0B1220 / light #EEF2FA) and flips the icon color to match.
        /// Called again by App on RequestedThemeChanged so a mid-session theme flip
        /// never leaves a white strip above the midnight header.</summary>
        public static void ApplySystemBars()
        {
            var act = _current;
            if (act?.Window is not { } w) return;
            try
            {
                // RequestedTheme compared via ToString() — AppTheme's CLR namespace
                // varies across the MAUI 10 packs; the enum name "Light" is stable.
                bool light = Microsoft.Maui.Controls.Application.Current?.RequestedTheme.ToString() == "Light";

                // The version guards below are real (SdkInt checks), but the platform
                // analyzers still flag the guarded calls (CA1416/CA1422) — suppress
                // narrowly rather than globally.
#pragma warning disable CA1416, CA1422
                // SetStatusBarColor is deprecated on API 35 (edge-to-edge enforced)
                // and is a documented no-op there; guard the call by version anyway
                // so the analyzer is honest and future Androids cannot throw.
                if (Build.VERSION.SdkInt < BuildVersionCodes.VanillaIceCream)
                {
                    w.SetStatusBarColor(Android.Graphics.Color.ParseColor(light ? "#EEF2FA" : "#0B1220"));
                    w.SetNavigationBarColor(Android.Graphics.Color.ParseColor(light ? "#FFFFFF" : "#0B1220"));
                }

                if (Build.VERSION.SdkInt >= BuildVersionCodes.R && w.InsetsController is { } controller)
                {
                    // API 30+; APPEARANCE_LIGHT_STATUS_BARS = 0x10. Below 30 the painted
                    // bar color is enough — the icon inversion is a nicety, not a fault.
                    const int appearanceLightStatusBars = 16;
                    controller.SetSystemBarsAppearance(
                        light ? appearanceLightStatusBars : 0, appearanceLightStatusBars);
                }
#pragma warning restore CA1416, CA1422
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("system bars: " + ex.Message); }
        }
    }
}
