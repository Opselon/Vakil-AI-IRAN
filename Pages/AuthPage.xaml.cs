using System.Diagnostics;
using System.Text.RegularExpressions;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Services;
using VakilAI.Application.Contracts;
using VakilAI.Domain.Repositories;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Maui.Authentication;
using IConnectivity = VakilAI.Application.Contracts.IConnectivity;

namespace Vakil_AI_IRAN.Pages;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — The signed-out entry screen: signup (client/lawyer role), login,
//             Google sign-in and the legacy activation-code compat expander.
// OWNER     — Agent 10 (UX integration).
// CONSUMES  — IMarketplaceCoordinator (session + navigation authority — this
//             page NEVER touches the token vault or swaps Window.Page itself)
//             and IMarketplaceApi only through it / for the Google credential
//             exchange. Visual system = ActivationPage (aurora + glass + UiMotion).
// PROVIDES  — DI-resolvable page for MarketplaceRoute.Auth.
// INVARIANTS— 1) Validation mirrors the SERVER codes (app_module_auth.js):
//                email regex, username [a-z0-9_.]{3,20}, password ≥8 + letter
//                + digit, displayName 2..40. Local checks are UX sugar; the
//                server answer always wins.
//             2) A lawyer is NOT auto-verified — the caption says so, and the
//                role card never claims otherwise.
//             3) Google path stays REAL: it produces a credential and posts it
//                through the typed port; only the OAuth URL/callback config is
//                pending (Preferences key `vakil.google.client.id`, §2.3).
// EXTEND    — recovery/2FA rows belong here once /auth/password/reset ships.
// ═══════════════════════════════════════════════════════════════════════════

public partial class AuthPage : ContentPage
{
    // server-side regexes (app_module_auth.js) mirrored for inline feedback
    private static readonly Regex EmailRx = new(@"^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$", RegexOptions.CultureInvariant);
    private static readonly Regex UsernameRx = new(@"^[a-z0-9_.]{3,20}$", RegexOptions.CultureInvariant);

    private readonly IMarketplaceCoordinator _coordinator;
    private readonly IMarketplaceApi _api;
    private readonly IDeviceStore _deviceStore;
    private readonly IConnectivity _net;

    private CancellationTokenSource _cts = new();
    private bool _busy;
    private bool _ambience;
    private bool _lawyerRole;   // default = client ("من موکل هستم")
    private bool _legacyOpen;

    /// <summary>Fresh token source when the page is re-shown after a sign-out cancelled the loops.</summary>
    private CancellationToken RestartLoopToken()
    {
        if (_cts.IsCancellationRequested)
        {
            _cts.Dispose();
            _cts = new CancellationTokenSource();
        }
        return _cts.Token;
    }

    public AuthPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _coordinator = sp.GetRequiredService<IMarketplaceCoordinator>();
        _api = sp.GetRequiredService<IMarketplaceApi>();
        _deviceStore = sp.GetRequiredService<IDeviceStore>();
        _net = sp.GetRequiredService<IConnectivity>();
    }

    protected override void OnAppearing()
    {
        base.OnAppearing();
        _ = EntranceAsync();
        _ = PrefillAsync();
        ApplyThemeSelections();
        // a signed-out legacy session may still want the old chat path
        BackToChatLink.IsVisible = _coordinator.Current.Kind == AccountKind.LegacyActivation
                                   && _coordinator.Current.IsSignedIn;
#if DEBUG
        DevSkipAuthRow.IsVisible = true;
        DevSkipAuthLabel.Text = Services.DevFlags.SkipAuth
            ? "حالت توسعه: ورود بدون حساب — فعال (برای لغو بزنید)"
            : "حالت توسعه: ورود بدون حساب (موقت)";
#endif
    }

    // ────────────────────────── entrance + ambience ──────────────────────────

    private async Task EntranceAsync()
    {
        try
        {
            LogoHalo.Opacity = 0;
            LogoHalo.Scale = 0.6;
            HeroBlock.Opacity = 0;
            HeroBlock.TranslationY = 18;

            await LogoHalo.FadeToAsync(1, 380, Easing.CubicOut);
            await LogoHalo.ScaleToAsync(1, 520, Easing.SpringOut);
            await HeroBlock.FadeToAsync(1, 240, Easing.CubicOut);
            await HeroBlock.TranslateToAsync(0, 0, 320, Easing.CubicOut);

            var cards = new View[] { TabsCard, SignupCard, LoginCard, GoogleCard, LegacyHeader };
            for (int i = 0; i < cards.Length; i++)
                _ = UiMotion.RiseInAsync(cards[i], delayMs: (uint)(i * 90));

            StartAmbience();
        }
        catch (Exception e) { Debug.WriteLine("auth entrance: " + e); }
    }

    private void StartAmbience()
    {
        if (_ambience && !_cts.IsCancellationRequested) return;
        _ambience = true;
        var token = RestartLoopToken(); // fresh token for a re-shown page (ActivationPage pattern)

        UiMotion.Loop(token, async ct =>
        {
            await AuroraIndigo.TranslateToAsync(24, 16, 5400, Easing.SinInOut);
            await AuroraIndigo.TranslateToAsync(0, 0, 5400, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });
        UiMotion.Loop(token, async ct =>
        {
            await UiMotion.SleepAsync(900, ct);
            await AuroraViolet.TranslateToAsync(-20, 24, 6300, Easing.SinInOut);
            await AuroraViolet.TranslateToAsync(0, 0, 6300, Easing.SinInOut);
        });
        UiMotion.Loop(token, async ct =>
        {
            await UiMotion.SleepAsync(1500, ct);
            await AuroraGold.ScaleToAsync(1.12, 5600, Easing.SinInOut);
            await AuroraGold.ScaleToAsync(1, 5600, Easing.SinInOut);
        });
        UiMotion.Loop(token, async ct =>
        {
            await UiMotion.SleepAsync(2200, ct);
            await AuroraCyan.TranslateToAsync(16, -18, 6800, Easing.SinInOut);
            await AuroraCyan.TranslateToAsync(0, 0, 6800, Easing.SinInOut);
        });
        UiMotion.Loop(token, async ct =>
        {
            await LogoDisc.ScaleToAsync(1.05, 1800, Easing.SinInOut);
            await LogoDisc.ScaleToAsync(1, 1800, Easing.SinInOut);
        });
    }

    private async Task PrefillAsync()
    {
        try
        {
            var saved = await _deviceStore.GetUserNameAsync();
            if (!string.IsNullOrWhiteSpace(saved) && string.IsNullOrWhiteSpace(NameEntry.Text))
            {
                NameEntry.Text = saved;
                LegacyNameEntry.Text = saved;
            }
        }
        catch (Exception e) { Debug.WriteLine("auth prefill: " + e); }
    }

    // ────────────────────────── tab switching ──────────────────────────

    private void OnTabSignupTapped(object? sender, TappedEventArgs e) => SwitchTab(signup: true);
    private void OnTabLoginTapped(object? sender, TappedEventArgs e) => SwitchTab(signup: false);

    private void SwitchTab(bool signup)
    {
        if (signup == SignupCard.IsVisible) return;
        SignupCard.IsVisible = signup;
        LoginCard.IsVisible = !signup;
        ClearStatus();
        ApplyThemeSelections();
        _ = UiMotion.RiseInAsync(signup ? SignupCard : LoginCard, durationMs: 220, rise: 12);
    }

    // ────────────────────────── role picker ──────────────────────────

    private void OnRoleClient(object? sender, TappedEventArgs e) => SelectRole(lawyer: false);
    private void OnRoleLawyer(object? sender, TappedEventArgs e) => SelectRole(lawyer: true);

    private void SelectRole(bool lawyer)
    {
        if (_lawyerRole == lawyer) return;
        _lawyerRole = lawyer;
        ApplyThemeSelections();
        _ = UiMotion.PressPopAsync(lawyer ? RoleLawyerCard : RoleClientCard);
    }

    /// <summary>Re-applies selection/error colors (also used after a theme flip).</summary>
    private void ApplyThemeSelections()
    {
        var selected = (Microsoft.Maui.Controls.Brush)Application.Current!.Resources["CtaBrush"];
        RoleClientCard.Stroke = _lawyerRole
            ? new SolidColorBrush(Color.Parse("#27395C"))
            : selected;
        RoleClientCard.StrokeThickness = 1.6;
        RoleLawyerCard.Stroke = _lawyerRole
            ? selected
            : new SolidColorBrush(Color.Parse("#27395C"));
        RoleLawyerCard.StrokeThickness = 1.6;
        RoleClientTick.Source = ImageSource.FromFile(_lawyerRole ? "ic_radio_off.png" : "ic_check_gold.png");
        RoleLawyerTick.Source = ImageSource.FromFile(_lawyerRole ? "ic_check_gold.png" : "ic_radio_off.png");
    }

    // ────────────────────────── password visibility ──────────────────────────

    private void OnToggleSignupPassword(object? sender, TappedEventArgs e)
    {
        SignupPasswordEntry.IsPassword = !SignupPasswordEntry.IsPassword;
        SignupEye.Source = ImageSource.FromFile(SignupPasswordEntry.IsPassword ? "ic_eye.png" : "ic_eye_off.png");
        _ = UiMotion.PressPopAsync(SignupEyeBtn);
    }

    private void OnToggleLoginPassword(object? sender, TappedEventArgs e)
    {
        LoginPasswordEntry.IsPassword = !LoginPasswordEntry.IsPassword;
        LoginEye.Source = ImageSource.FromFile(LoginPasswordEntry.IsPassword ? "ic_eye.png" : "ic_eye_off.png");
        _ = UiMotion.PressPopAsync(LoginEyeBtn);
    }

    // ────────────────────────── validation ──────────────────────────

    private bool ValidateSignup()
    {
        bool ok = true;

        var name = NameEntry.Text?.Trim() ?? string.Empty;
        if (name.Length is < 2 or > 40)
        {
            FieldFail(NameCard, NameError, "نام نمایشی باید بین ۲ تا ۴۰ نویسه باشد.");
            ok = false;
        }
        else FieldOk(NameCard, NameError);

        var email = EmailEntry.Text?.Trim() ?? string.Empty;
        var username = UsernameEntry.Text?.Trim() ?? string.Empty;
        if (email.Length == 0 && username.Length == 0)
        {
            FieldFail(EmailCard, EmailError, "برای ثبت‌نام وارد کردن ایمیل یا نام کاربری الزامی است.");
            ok = false;
        }
        else if (email.Length > 0 && !EmailRx.IsMatch(email))
        {
            FieldFail(EmailCard, EmailError, "قالب ایمیل معتبر نیست. نشانی کامل ایمیل را وارد کنید.");
            ok = false;
        }
        else FieldOk(EmailCard, EmailError);

        if (username.Length > 0 && !UsernameRx.IsMatch(username))
        {
            FieldFail(UsernameCard, UsernameError, "نام کاربری باید ۳ تا ۲۰ نویسه باشد: حرف کوچک انگلیسی، رقم، نقطه یا زیرخط.");
            ok = false;
        }
        else FieldOk(UsernameCard, UsernameError);

        var password = SignupPasswordEntry.Text ?? string.Empty;
        if (!PasswordLooksValid(password))
        {
            FieldFail(SignupPasswordCard, SignupPasswordError, "رمز عبور باید حداقل ۸ نویسه باشد و شامل یک حرف و یک رقم.");
            ok = false;
        }
        else FieldOk(SignupPasswordCard, SignupPasswordError);

        return ok;
    }

    private bool ValidateLogin()
    {
        bool ok = true;
        var identifier = LoginIdentifierEntry.Text?.Trim() ?? string.Empty;
        if (identifier.Length == 0)
        {
            FieldFail(LoginIdentifierCard, LoginIdentifierError, "ایمیل یا نام کاربری خود را وارد کنید.");
            ok = false;
        }
        else FieldOk(LoginIdentifierCard, LoginIdentifierError);

        if (string.IsNullOrEmpty(LoginPasswordEntry.Text))
        {
            FieldFail(LoginPasswordCard, LoginPasswordError, "رمز عبور را وارد کنید.");
            ok = false;
        }
        else FieldOk(LoginPasswordCard, LoginPasswordError);
        return ok;
    }

    private static bool PasswordLooksValid(string password) =>
        password.Length >= 8 &&
        password.Any(char.IsLetter) &&
        password.Any(char.IsDigit);

    private void FieldFail(Border card, Label error, string message)
    {
        card.Stroke = new SolidColorBrush(Color.Parse("#EF4444"));
        card.StrokeThickness = 1.6;
        error.Text = message;
        error.IsVisible = true;
    }

    private void FieldOk(Border card, Label error)
    {
        card.Stroke = new SolidColorBrush(Hairline);
        card.StrokeThickness = 1;
        error.Text = string.Empty;
        error.IsVisible = false;
    }

    /// <summary>Resting hairline colour for the current app theme (AppTheme.xaml tokens).</summary>
    private static Color Hairline =>
        Application.Current?.RequestedTheme == AppTheme.Dark
            ? Color.Parse("#1E2C42")   // HairlineDark
            : Color.Parse("#CBD5E1");  // HairlineLight

    // ────────────────────────── signup ──────────────────────────

    private async void OnSignupClicked(object? sender, TappedEventArgs e)
    {
        if (_busy) return;
        if (!ValidateSignup()) { _ = ShakeCardAsync(SignupCta); return; }
        if (!EnsureOnline()) return;

        var email = EmailEntry.Text?.Trim() ?? string.Empty;
        var username = UsernameEntry.Text?.Trim() ?? string.Empty;
        var request = new SignupRequest(
            Email: email.Length > 0 ? email : null,
            Username: username.Length > 0 ? username : null,
            Password: SignupPasswordEntry.Text ?? string.Empty,
            DisplayName: NameEntry.Text?.Trim() ?? string.Empty,
            Role: _lawyerRole ? "lawyer" : "client");

        _busy = true;
        SetBusy(SignupBusyRing, SignupCta, SignupCtaLabel, true, "در حال ساخت حساب…");
        try
        {
            var res = await _api.SignupAsync(request, _cts.Token);
            if (res.Ok && res.User is not null && !string.IsNullOrWhiteSpace(res.Token))
            {
                var welcome = _lawyerRole
                    ? "حساب وکیل ساخته شد — پرونده شما در صف بررسی تیم است."
                    : "خوش آمدید! دفتر وکیل باز می‌شود…";
                await StatusAsync(welcome, success: true);
                await _coordinator.AdoptSessionAsync(res.Token!, res.User, MarketplaceRoute.Home, _cts.Token);
                return;
            }
            await StatusAsync(res.Message ?? "ساخت حساب ممکن نشد. دوباره تلاش کنید.");
            _ = ShakeCardAsync(SignupCta);
        }
        catch (OperationCanceledException) { /* navigating away */ }
        catch (Exception ex)
        {
            Debug.WriteLine("signup: " + ex);
            await StatusAsync("ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.");
        }
        finally
        {
            _busy = false;
            SetBusy(SignupBusyRing, SignupCta, SignupCtaLabel, false, "ساخت حساب و ورود به دفتر");
        }
    }

    // ────────────────────────── login ──────────────────────────

    private async void OnLoginClicked(object? sender, TappedEventArgs e)
    {
        if (_busy) return;
        if (!ValidateLogin()) { _ = ShakeCardAsync(LoginCta); return; }
        if (!EnsureOnline()) return;

        var request = new LoginRequest(
            Identifier: LoginIdentifierEntry.Text?.Trim() ?? string.Empty,
            Password: LoginPasswordEntry.Text ?? string.Empty);

        _busy = true;
        SetBusy(LoginBusyRing, LoginCta, LoginCtaLabel, true, "در حال ورود…");
        try
        {
            var res = await _api.LoginAsync(request, _cts.Token);
            if (res.Ok && res.User is not null && !string.IsNullOrWhiteSpace(res.Token))
            {
                await StatusAsync("خوش آمدید — دفتر وکیل باز می‌شود…", success: true);
                await _coordinator.AdoptSessionAsync(res.Token!, res.User, MarketplaceRoute.Home, _cts.Token);
                return;
            }
            await StatusAsync(res.Message ?? "ایمیل/نام کاربری یا رمز عبور درست نیست.");
            _ = ShakeCardAsync(LoginCta);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Debug.WriteLine("login: " + ex);
            await StatusAsync("ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.");
        }
        finally
        {
            _busy = false;
            SetBusy(LoginBusyRing, LoginCta, LoginCtaLabel, false, "ورود به حساب");
        }
    }

    // ────────────────────────── Google ──────────────────────────

    /// <summary>
    /// Real, single-function integration point (§2.3): fetch a Google ID token
    /// over WebAuthenticator, then post {credential} through the typed port.
    /// When `vakil.google.client.id` is not configured (or the platform callback
    /// is missing) it fails with an honest message instead of pretending.
    /// Swapping in the official Google SDK later = replace THIS method body only.
    /// </summary>
    private async void OnGoogleClicked(object? sender, TappedEventArgs e)
    {
        if (_busy) return;
        if (!EnsureOnline()) return;

        var clientId = GoogleClientId();
        if (string.IsNullOrWhiteSpace(clientId))
        {
            await _coordinator.NotifyAsync("ورود با Google",
                "پیکربندی گوگل آماده نشده است. کلید کلاینت (GOOGLE_CLIENT_ID) را در تنظیمات سرور و کلید " +
                "`vakil.google.client.id` دستگاه قرار دهید تا این دکمه فعال شود.");
            return;
        }

        _busy = true;
        GoogleBusyRing.IsRunning = true;
        GoogleBusyRing.IsVisible = true;
        GoogleCard.IsEnabled = false;
        try
        {
            var authUrl = new Uri($"https://accounts.google.com/o/oauth2/v2/auth?client_id={Uri.EscapeDataString(clientId)}" +
                                  "&redirect_uri=" + Uri.EscapeDataString(GoogleCallback) +
                                  "&response_type=id_token&scope=openid%20email%20profile" +
                                  "&prompt=select_account&nonce=" + Guid.NewGuid().ToString("N"));

            var result = await WebAuthenticator.Default.AuthenticateAsync(authUrl, new Uri(GoogleCallback));

            var credential = result?.IdToken ?? result?.AccessToken;
            if (string.IsNullOrWhiteSpace(credential))
            {
                await StatusAsync("ورود با Google تکمیل نشد.");
                return;
            }

            var res = await _api.GoogleLoginAsync(new GoogleLoginRequest(credential), _cts.Token);
            if (res.Code == "CONFIG_PENDING")
            {
                await _coordinator.NotifyAsync("ورود با Google",
                    res.Message ?? "پیکربندی گوگل آماده نشده است. زودتر فعالش می‌کنیم.");
                return;
            }
            if (res.Ok && res.User is not null && !string.IsNullOrWhiteSpace(res.Token))
            {
                await StatusAsync("با حساب گوگل وارد شدید — دفتر وکیل باز می‌شود…", success: true);
                await _coordinator.AdoptSessionAsync(res.Token!, res.User, MarketplaceRoute.Home, _cts.Token);
                return;
            }
            await StatusAsync(res.Message ?? "حساب گوگل به وکیل‌جی‌پی متصل نشد.");
        }
        catch (TaskCanceledException)
        {
            Debug.WriteLine("google flow cancelled by user");
        }
        catch (Exception ex)
        {
            Debug.WriteLine("google: " + ex);
            await _coordinator.NotifyAsync("ورود با Google",
                "پیکربندی گوگل آماده نشده است — در این نسخه از ایمیل/نام کاربری استفاده کنید.\n\n" +
                "جزئیات فنی فقط برای گزارش: " + ex.GetType().Name);
        }
        finally
        {
            _busy = false;
            GoogleBusyRing.IsRunning = false;
            GoogleBusyRing.IsVisible = false;
            GoogleCard.IsEnabled = true;
        }
    }

    // Developer-facing config (Preferences = the documented local override; the
    // server keeps its own GOOGLE_CLIENT_ID secret — §2.3 forbids hardcoding).
    private static string? GoogleClientId()
    {
        try
        {
            var v = Preferences.Default.Get("vakil.google.client.id", string.Empty);
            return string.IsNullOrWhiteSpace(v) ? null : v;
        }
        catch { return null; }
    }

    /// <summary>
    /// Redirect/callback the Google consent screen points at. The worker's
    /// /auth/google handler reads the ID token from the fragment; Agent 2's
    /// module documents the final value — one swap here when it lands.
    /// </summary>
    private const string GoogleCallback = "https://vakil.app/.auth/google/callback";

    // ────────────────────────── legacy activation (compat) ──────────────────────────

    private void OnLegacyToggled(object? sender, TappedEventArgs e)
    {
        _legacyOpen = !_legacyOpen;
        LegacyBody.IsVisible = _legacyOpen;
        LegacyChevron.Rotation = _legacyOpen ? 90 : 0; // RTL: closed points left-ish
        if (_legacyOpen) _ = UiMotion.RiseInAsync(LegacyBody, durationMs: 220, rise: 10);
    }

    private async void OnLegacyActivated(object? sender, TappedEventArgs e)
    {
        if (_busy) return;
        var code = LegacyCodeEntry.Text?.Trim() ?? string.Empty;
        if (code.Length == 0)
        {
            await StatusAsync("کد فعال‌سازی را وارد کنید.");
            return;
        }
        if (!EnsureOnline()) return;

        _busy = true;
        SetBusy(LegacyBusyRing, LegacyCta, LegacyCtaLabel, true, "در حال بررسی کد…");
        try
        {
            var error = await _coordinator.ActivateWithCodeAsync(code, LegacyNameEntry.Text ?? string.Empty, _cts.Token);
            if (error is null)
            {
                await StatusAsync("کد معتبر است — دفتر وکیل باز می‌شود…", success: true);
                return; // coordinator already navigated to Chat
            }
            await StatusAsync(error);
            _ = ShakeCardAsync(LegacyCta);
        }
        finally
        {
            _busy = false;
            SetBusy(LegacyBusyRing, LegacyCta, LegacyCtaLabel, false, "ورود با کد");
        }
    }

    /// <summary>Keeps the pre-V1 path reachable: a legacy token already in the vault can simply continue.</summary>
    private void OnBackToChatTapped(object? sender, TappedEventArgs e) =>
        _coordinator.Navigate(MarketplaceRoute.Chat);

    // ────────────────────────── dev mechanism (visible + functional in DEBUG only;
    // the handler must exist in every config because the XAML always references it)

    private void OnToggleSkipAuth(object? sender, TappedEventArgs e)
    {
#if DEBUG
        Services.DevFlags.SkipAuth = !Services.DevFlags.SkipAuth;
        DevSkipAuthLabel.Text = Services.DevFlags.SkipAuth
            ? "حالت توسعه: ورود بدون حساب — فعال (برای لغو بزنید)"
            : "حالت توسعه: ورود بدون حساب (موقت)";
        if (Services.DevFlags.SkipAuth)
            _coordinator.Navigate(MarketplaceRoute.Chat);
        else
            _ = _coordinator.NotifyAsync("حالت توسعه", "ورود بدون حساب خاموش شد؛ از این پس به صفحه ورود بازمی‌گردیم.");
#endif
    }

    // ────────────────────────── feedback helpers ──────────────────────────

    private bool EnsureOnline()
    {
        if (_net.IsOnline) return true;
        _ = StatusAsync("اتصال اینترنت برقرار نیست.");
        return false;
    }

    private void SetBusy(ActivityIndicator ring, Border cta, Label label, bool busy, string busyText)
    {
        ring.IsRunning = busy;
        ring.IsVisible = busy;
        cta.IsEnabled = !busy;
        if (busy)
        {
            label.Text = busyText;
            cta.Scale = 0.96;
            return;
        }
        // resting label per CTA — the caller passes the busy text only
        if (ReferenceEquals(cta, SignupCta)) label.Text = "ساخت حساب و ورود به دفتر";
        else if (ReferenceEquals(cta, LoginCta)) label.Text = "ورود به حساب";
        else if (ReferenceEquals(cta, LegacyCta)) label.Text = "ورود با کد";
        cta.Scale = 1;
    }

    private async Task StatusAsync(string message, bool success = false)
    {
        StatusMessage.Text = message;
        // Theme-tuned inks: raw #EF4444/#10B981 fail AA as text on light surfaces.
        var dark = Application.Current?.RequestedTheme == AppTheme.Dark;
        StatusMessage.TextColor = Color.Parse(success
            ? (dark ? "#34D399" : "#047857")
            : (dark ? "#F87171" : "#B91C1C"));
        StatusMessage.IsVisible = true;
        StatusMessage.Opacity = 0;
        await StatusMessage.FadeToAsync(1, 200);
    }

    private void ClearStatus()
    {
        StatusMessage.IsVisible = false;
        StatusMessage.Text = string.Empty;
    }

    private async Task ShakeCardAsync(Border card)
    {
        try
        {
            foreach (var dx in new[] { -7.0, 7, -5, 5, -2, 0 })
                await card.TranslateToAsync(dx, 0, 45, Easing.Linear);
        }
        catch (Exception e) { Debug.WriteLine("shake: " + e.Message); }
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts.Cancel(); // ambience + in-flight API calls stop with the page
        _ambience = false;
    }
}
