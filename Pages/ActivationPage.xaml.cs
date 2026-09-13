using System.Diagnostics;
using Vakil_AI_IRAN.Controls;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Repositories;
using VakilAI.Domain.ValueObjects;

using Microsoft.Extensions.DependencyInjection;
using IConnectivity = VakilAI.Application.Contracts.IConnectivity;

namespace Vakil_AI_IRAN.Pages;

public partial class ActivationPage : ContentPage
{
    private readonly IAppApi _api;
    private readonly IDeviceIdentity _identity;
    private readonly ITokenStore _tokens;
    private readonly IDeviceStore _deviceStore;
    private readonly IConnectivity _net;
    private readonly ChatService _chat;
    private CancellationTokenSource _cts = new();
    private bool _busy;
    private bool _ambience;

    public ActivationPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _api = sp.GetRequiredService<IAppApi>();
        _identity = sp.GetRequiredService<IDeviceIdentity>();
        _tokens = sp.GetRequiredService<ITokenStore>();
        _deviceStore = sp.GetRequiredService<IDeviceStore>();
        _net = sp.GetRequiredService<IConnectivity>();
        _chat = sp.GetRequiredService<ChatService>();
    }

    protected override void OnAppearing()
    {
        base.OnAppearing();
        _ = EntranceAsync();
        _ = PrefillNameAsync();
    }

    private async Task PrefillNameAsync()
    {
        try
        {
            var saved = await _deviceStore.GetUserNameAsync();
            if (!string.IsNullOrWhiteSpace(saved)) NameEntry.Text = saved;
        }
        catch (Exception e) { Debug.WriteLine("prefill: " + e); }
    }

    // ────────────────────────── entrance + ambience ──────────────────────────

    private async Task EntranceAsync()
    {
        try
        {
            LogoHalo.Opacity = 0;
            LogoHalo.Scale = 0.55;
            HeroBlock.Opacity = 0;
            HeroBlock.TranslationY = 18;

            await LogoHalo.FadeToAsync(1, 420, Easing.CubicOut);
            await LogoHalo.ScaleToAsync(1, 560, Easing.SpringOut);
            await HeroBlock.FadeToAsync(1, 260, Easing.CubicOut);
            await HeroBlock.TranslateToAsync(0, 0, 340, Easing.CubicOut);

            var cards = new VisualElement[] { Feature1, Feature2, Feature3, FormCard };
            for (int i = 0; i < cards.Length; i++)
                _ = UiMotion.RiseInAsync((View)cards[i], delayMs: (uint)(i * 110));

            StartAmbience();
        }
        catch (Exception e) { Debug.WriteLine("entrance: " + e); }
    }

    private void StartAmbience()
    {
        if (_ambience && !_cts.IsCancellationRequested) return; // already running
        // OnDisappearing (or a sign-out) cancelled the previous loop set — start fresh.
        if (_cts.IsCancellationRequested)
        {
            _cts.Dispose();
            _cts = new CancellationTokenSource();
        }
        _ambience = true;

        // aurora blobs drift on slow offset phases
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await AuroraIndigo.TranslateToAsync(26, 18, 5200, Easing.SinInOut);
            await AuroraIndigo.TranslateToAsync(0, 0, 5200, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await UiMotion.SleepAsync(900, ct);
            await AuroraViolet.TranslateToAsync(-22, 26, 6100, Easing.SinInOut);
            await AuroraViolet.TranslateToAsync(0, 0, 6100, Easing.SinInOut);
        });
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await UiMotion.SleepAsync(1600, ct);
            await AuroraGold.ScaleToAsync(1.14, 5600, Easing.SinInOut);
            await AuroraGold.ScaleToAsync(1, 5600, Easing.SinInOut);
        });
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await UiMotion.SleepAsync(2300, ct);
            await AuroraCyan.TranslateToAsync(18, -20, 6800, Easing.SinInOut);
            await AuroraCyan.TranslateToAsync(0, 0, 6800, Easing.SinInOut);
        });

        // the gold ring turns very slowly; the emblem breathes inside it
        UiMotion.Loop(_cts.Token, async ct =>
        {
            LogoRing.Rotation = 0;
            await LogoRing.RotateToAsync(360, 26000, Easing.Linear);
            ct.ThrowIfCancellationRequested();
        });
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await LogoEmblem.ScaleToAsync(1.06, 1700, Easing.SinInOut);
            await LogoEmblem.ScaleToAsync(1, 1700, Easing.SinInOut);
        });
    }

    private async void OnActivateClicked(object? sender, EventArgs e)
    {
        if (_busy) return;

        var code = CodeEntry.Text?.Trim() ?? string.Empty;
        var name = string.IsNullOrWhiteSpace(NameEntry.Text) ? "کاربر وکیل" : NameEntry.Text.Trim();

        if (!ActivationCode.IsValid(code))
        {
            await FailAsync("کد فعال‌سازی را کامل وارد کنید.");
            return;
        }
        if (!_net.IsOnline)
        {
            await FailAsync("اتصال اینترنت برقرار نیست.");
            return;
        }

        _busy = true;
        SetBusyUi(true);
        ActivateCard.Scale = 0.96;

        try
        {
            var deviceId = await _identity.GetOrCreateAsync();
            var platform = await _identity.PlatformNameAsync();
            var res = await _api.VerifyAsync(new VerifyRequest(deviceId.Value, code, name, platform));

            if (res.Ok && !string.IsNullOrWhiteSpace(res.Token))
            {
                await _tokens.SaveTokenAsync(res.Token!);
                await _deviceStore.SaveUserNameAsync(name);
                _cts.Cancel(); // stop ambience — the exit animation owns the page now
                _ambience = false;
                await EnterChatAsync();
                return;
            }

            await FailAsync(res.Message ?? "کد فعال‌سازی معتبر نیست یا مهلت آن پایان یافته است.");
        }
        catch (Exception ex)
        {
            Debug.WriteLine("verify: " + ex);
            await FailAsync("ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.");
        }
        finally
        {
            _busy = false;
            SetBusyUi(false);
        }
    }

    private async Task EnterChatAsync()
    {
        try
        {
            var chat = MauiProgram.Services.GetRequiredService<ChatPage>();

            // polished hand-off: the form dissolves, the window swaps, chat rises in
            _ = RootStack.FadeToAsync(0, 190, Easing.CubicIn);
            _ = RootStack.ScaleToAsync(1.03, 190, Easing.CubicIn);
            await Task.Delay(200);

            if (Application.Current?.Windows.Count > 0)
                Application.Current.Windows[0].Page = chat;
        }
        catch (Exception e)
        {
            Debug.WriteLine("enter chat: " + e);
            StartAmbience(); // navigation failed — the looping aurora restarts on this page
            await FailAsync("باز شدن دفتر وکیل ناموفق بود.");
        }
    }

    private async Task FailAsync(string message)
    {
        StatusMessage.Text = message;
        StatusMessage.IsVisible = true;
        StatusMessage.Opacity = 0;
        await StatusMessage.FadeToAsync(1, 200);
        _ = ActivateCard.TranslateToAsync(-7, 0, 40, Easing.Linear);
        _ = ShakeAsync();
        CodeEntry.Focus();
    }

    private async Task ShakeAsync()
    {
        try
        {
            foreach (var dx in new[] { -7.0, 7, -5, 5, -2, 0 })
                await ActivateCard.TranslateToAsync(dx, 0, 45, Easing.Linear);
        }
        catch (Exception e) { Debug.WriteLine("shake: " + e.Message); }
    }

    private void SetBusyUi(bool busy)
    {
        BusyRing.IsRunning = busy;
        BusyRing.IsVisible = busy;
        ActivateCard.IsEnabled = !busy;
        CtaLabel.Text = busy ? "در حال بررسی کد…" : "ورود به دفتر وکیل";
        if (!busy) ActivateCard.Scale = 1;
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts.Cancel(); // every ambience loop is token-bound — nothing leaks behind the next page
    }
}
