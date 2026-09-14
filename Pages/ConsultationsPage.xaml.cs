using System.Diagnostics;
using VakilAI.Application.Contracts;
using Vakil_AI_IRAN.Controls;   // UiMotion

using Microsoft.Extensions.DependencyInjection;

namespace Vakil_AI_IRAN.Pages;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Code-behind for Pages/ConsultationsPage.xaml: pulls the
//             consultation list (both directions, server decides membership)
//             and renders lifecycle chips, unread badges and remaining time.
// OWNER     — coordinator (the page MarketplaceRoute.Consultations resolves to).
// CONSUMES  — IMarketplaceApi, ITokenStore, IMarketplaceCoordinator — resolved
//             from MauiProgram.Services; no raw HttpClient, no Window swap here.
// PROVIDES  — Vakil_AI_IRAN.Pages.ConsultationsPage (DI transient).
// INVARIANTS— status text comes from ConsultationDto.Status ONLY (never a
//             client-inferred paid/active flag); empty list → designed empty
//             state; animations use *Async APIs (zero CS0618).
// EXTEND    — the row builder is one method; new lifecycle states need only a
//             StatusChip case + palette entry.
// ═══════════════════════════════════════════════════════════════════════════

public partial class ConsultationsPage : ContentPage
{
    private readonly IMarketplaceApi _api;
    private readonly ITokenStore _tokens;
    private readonly IMarketplaceCoordinator? _coordinator;

    private ConsultationDto[] _all = Array.Empty<ConsultationDto>();
    private string _filter = "all";           // all | active | awaiting | finished
    private bool _loaded;
    private CancellationTokenSource? _cts;

    public ConsultationsPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _api = sp.GetRequiredService<IMarketplaceApi>();
        _tokens = sp.GetRequiredService<ITokenStore>();
        _coordinator = sp.GetRequiredService<IMarketplaceCoordinator>();
        RenderFilters();
        RenderAccount();
    }

    protected override void OnAppearing()
    {
        base.OnAppearing();
        RenderAccount();   // hydration may have completed since ctor — never show a stale identity
        if (!_loaded)
            _ = LoadAsync();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts?.Cancel();
    }

    // ────────────────────────── loading ──────────────────────────

    private async Task LoadAsync()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = await SafeTokenAsync();

        SetState(LoadingBlock);
        if (string.IsNullOrEmpty(token))
        {
            ShowError("برای مشاهده مشاوره‌ها وارد حساب خود شوید.");
            return;
        }

        try
        {
            var res = await _api.ConsultationsAsync(token, _cts.Token);
            if (res.Ok)
            {
                _all = res.Consultations ?? Array.Empty<ConsultationDto>();
                RenderList();
            }
            else
            {
                ShowError(res.Message ?? "در حال حاضر لیست مشاوره‌ها در دسترس نیست.");
            }
        }
        catch (Exception e)
        {
            Debug.WriteLine("consultations load: " + e);
            ShowError("ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.");
        }
        _loaded = true;
    }

    private async Task<string> SafeTokenAsync()
    {
        try { return await _tokens.GetTokenAsync() ?? string.Empty; }
        catch (Exception e) { Debug.WriteLine("token: " + e); return string.Empty; }
    }

    // ────────────────────────── account block ──────────────────────────

    private void RenderAccount()
    {
        var s = _coordinator?.Current;
        AccountName.Text = s?.DisplayName is { Length: > 0 } n ? n : "کاربر وکیل";

        AccountMeta.Children.Clear();
        if (s?.Kind == AccountKind.LegacyActivation)
            AccountMeta.Children.Add(MetaPill("نشست قدیمی با کد فعال‌سازی (بدون حساب)", muted: true));
        else
        {
            AccountMeta.Children.Add(MetaPill(s?.Role switch
            {
                "lawyer" => "وکیل",
                "admin" => "مدیر سامانه",
                _ => "موکل"
            }, accent: true));
            if (s?.IsLawyer == true)
                AccountMeta.Children.Add(MetaPill(s.VerificationStatus switch
                {
                    "verified" => "تأیید شده توسط وکیل‌جی‌پی",
                    "rejected" => "رد شده — قابل بازبینی",
                    "suspended" => "معلق",
                    _ => "در انتظار بررسی"
                }, muted: s.VerificationStatus != "verified"));
        }

        AccountActions.Children.Clear();
        if (s is { IsSignedIn: true } && s.Kind != AccountKind.LegacyActivation)
        {
            if (s.IsLawyer)
            {
                // The self-profile page is the ONLY surface that renders the
                // admin verificationNote (rejection reason) — make it reachable
                // even while the profile is still pending (audit 2.8).
                var selfId = s.UserId ?? 0;
                AccountActions.Add(ActionChip("🪪 پروفایل من", () => { _coordinator?.Navigate(MarketplaceRoute.LawyerProfile, selfId); return Task.CompletedTask; }));
                AccountActions.Add(ActionChip("🛠 میز وکیل", () => { _coordinator?.Navigate(MarketplaceRoute.LawyerOffice); return Task.CompletedTask; }));
            }
            else if (!s.IsAdmin)
                AccountActions.Add(ActionChip("⚖️ عضویت به‌عنوان وکیل", ApplyAsLawyerAsync));
            AccountActions.Add(ActionChip("🚪 خروج", SignOutAsync));
        }
    }

    private static Border MetaPill(string text, bool accent = false, bool muted = false) => new()
    {
        Style = (Microsoft.Maui.Controls.Style)GetResource("MetaChip"),
        Content = new Label
        {
            Text = text,
            FontFamily = "VazirmatnMedium",
            FontSize = 11.5,
            TextColor = muted
                ? (Color)GetResource("InkMuted")!
                : (Color)(accent ? GetResource("AccentSoft")! : GetResource("InkMuted")!)
        }
    };

    private View ActionChip(string text, Func<Task> onClick)
    {
        var chip = new Border { Style = (Microsoft.Maui.Controls.Style)GetResource("MenuChip") };
        chip.Content = new Label
        {
            Text = text,
            FontFamily = "VazirmatnMedium",
            FontSize = 12.5,
            Padding = new Thickness(8, 3),
            TextColor = (Color)GetResource("AccentSoft")!
        };
        var tap = new TapGestureRecognizer();
        tap.Tapped += async (_, _) => await RunChip(chip, onClick);
        chip.GestureRecognizers.Add(tap);
        return chip;
    }

    private async Task RunChip(Border chip, Func<Task> action)
    {
        chip.IsEnabled = false;
        try { await UiMotion.PressPopAsync(chip); await action(); }
        catch (Exception e) { Debug.WriteLine("chip: " + e); }
        finally { chip.IsEnabled = true; }
    }

    private async Task ApplyAsLawyerAsync()
    {
        var token = await SafeTokenAsync();
        if (string.IsNullOrEmpty(token)) return;
        try
        {
            var res = await _api.ApplyAsLawyerAsync(token);
            if (res.Ok)
            {
                await _coordinator!.RefreshAsync();
                RenderAccount();
                await _coordinator.NotifyAsync("عضویت به‌عنوان وکیل",
                    res.Message ?? "پروفایل شما ساخته شد و در وضعیت «در انتظار بررسی» است. پس از تأیید تیم وکیل‌جی‌پی، در دفترچه وکلا نمایش داده می‌شود.");
            }
            else
            {
                await _coordinator!.NotifyAsync("عضویت به‌عنوان وکیل", res.Message ?? "اقدام ممکن نشد.");
            }
        }
        catch (Exception e)
        {
            Debug.WriteLine("apply lawyer: " + e);
            await _coordinator!.NotifyAsync("عضویت وکیل", "اقدام ممکن نشد؛ چند لحظه دیگر تلاش کنید.");
        }
    }

    private async Task SignOutAsync()
    {
        if (_coordinator is null) return;
        var go = await DisplayAlertAsync("خروج", "از حساب خود خارج می‌شوید؟", "بله", "انصراف");
        if (go) await _coordinator.SignOutAsync();
    }

    // ────────────────────────── filters ──────────────────────────

    private void RenderFilters()
    {
        FilterRow.Children.Clear();
        foreach (var (key, label) in new[]
        {
            ("all", "همه"), ("active", "جاری"), ("awaiting", "در انتظار پرداخت"), ("finished", "پایان‌یافته")
        })
        {
            var selected = key == _filter;
            var chip = new Border
            {
                Background = selected ? (Color)GetResource("Accent")! : Colors.Transparent,
                Stroke = selected ? Colors.Transparent : (Color)GetResource("HairlineDark")!,
                StrokeThickness = selected ? 0 : 1,
                StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 16 },
                Padding = new Thickness(12, 6)
            };
            chip.Content = new Label
            {
                Text = label,
                FontFamily = "VazirmatnMedium",
                FontSize = 12.5,
                TextColor = selected ? Colors.White : (Color)GetResource("InkMuted")!
            };
            var captured = key;
            var tap = new TapGestureRecognizer();
            tap.Tapped += async (_, _) =>
            {
                if (_filter == captured) return;
                _filter = captured;
                RenderFilters();
                RenderList();
                await UiMotion.PressPopAsync(chip);
            };
            chip.GestureRecognizers.Add(tap);
            FilterRow.Children.Add(chip);
        }
    }

    private ConsultationDto[] Filtered() => _filter switch
    {
        "active" => _all.Where(c => c.Status is ConsultationStatus.Active or ConsultationStatus.Paid).ToArray(),
        "awaiting" => _all.Where(c => c.Status is ConsultationStatus.Created or ConsultationStatus.PaymentPending).ToArray(),
        "finished" => _all.Where(c => ConsultationStatus.IsFinished(c.Status)).ToArray(),
        _ => _all
    };

    // ────────────────────────── list ──────────────────────────

    private void RenderList()
    {
        var rows = Filtered();
        if (_all.Length == 0)
        {
            SetState(EmptyBlock);
            return;
        }
        SetState(ListBlock);
        ListBlock.Children.Clear();
        if (rows.Length == 0)
        {
            ListBlock.Children.Add(new Label
            {
                Text = "موردی در این نمایه وجود ندارد.",
                Style = (Microsoft.Maui.Controls.Style)GetResource("Caption"),
                HorizontalTextAlignment = TextAlignment.Center,
                Margin = new Thickness(0, 18)
            });
            return;
        }
        foreach (var c in rows)
            ListBlock.Children.Add(BuildRow(c));
    }

    private View BuildRow(ConsultationDto c)
    {
        var amClient = _coordinator?.Current?.UserId == c.ClientUserId;
        var counterpart = amClient ? c.LawyerName ?? "وکیل" : c.ClientName ?? "موکل";

        var card = new Border { Style = (Microsoft.Maui.Controls.Style)GetResource("GlassCard") };
        var stack = new VerticalStackLayout { Spacing = 6 };

        var top = new Grid { ColumnDefinitions = { new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) } };
        var title = new Label
        {
            Text = (amClient ? "مشاوره با " : "مشاوره با موکل ") + counterpart,
            FontFamily = "VazirmatnBold",
            FontSize = 14.5,
            TextColor = Ink(),
            LineBreakMode = LineBreakMode.TailTruncation
        };
        Grid.SetColumn(title, 0);
        var chip = StatusChip(c.Status);
        Grid.SetColumn(chip, 1);
        top.Children.Add(title);
        top.Children.Add(chip);
        stack.Children.Add(top);

        var meta = new HorizontalStackLayout { Spacing = 8 };
        meta.Children.Add(MetaPill(PriceText(c), muted: true));
        if (c.DurationMinutes > 0)
            meta.Children.Add(MetaPill($"{Fa(c.DurationMinutes)} دقیقه", muted: true));
        if (c.Status == ConsultationStatus.Active && c.EndsAt is long ends)
        {
            var left = ends - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var mins = Math.Max(1, (int)(left / 60000));
            meta.Children.Add(MetaPill(left > 0 ? $"پایان تا {Fa(mins)} دقیقه" : "در حال پایان", accent: true));
        }
        if (!amClient && c.UnreadForMe > 0)
            meta.Children.Add(MetaPill($"{Fa(c.UnreadForMe)} پیام تازه", accent: true));
        stack.Children.Add(meta);

        if (c.Status is ConsultationStatus.Created or ConsultationStatus.PaymentPending)
        {
            var hintRow = new Grid
            {
                ColumnDefinitions =
                {
                    new ColumnDefinition(GridLength.Star),
                    new ColumnDefinition(GridLength.Auto)
                }
            };
            hintRow.Children.Add(new Label
            {
                Text = "برای شروع گفتگو، هزینه مشاوره را پرداخت کنید.",
                Style = (Microsoft.Maui.Controls.Style)GetResource("Caption"),
                VerticalOptions = LayoutOptions.Center
            });
            if (amClient)
            {
                // wave 2: unpaid rows belong to the client until paid — cancelling is free
                var cancel = new Border
                {
                    Background = Color.Parse("#C9828E").WithAlpha(0.14f),
                    Stroke = Color.Parse("#C9828E").WithAlpha(0.55f),
                    StrokeThickness = 1,
                    StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
                    Padding = new Thickness(10, 3),
                    VerticalOptions = LayoutOptions.Center,
                    Content = new Label { Text = "لغو مشاوره", FontFamily = "VazirmatnMedium", FontSize = 11, TextColor = Color.Parse("#C9828E") }
                };
                Grid.SetColumn(cancel, 1);
                var cancelTap = new TapGestureRecognizer();
                cancelTap.Tapped += async (_, _) => await CancelAsync(c.Id);
                cancel.GestureRecognizers.Add(cancelTap);
                hintRow.Children.Add(cancel);
            }
            stack.Children.Add(hintRow);
        }

        card.Content = stack;

        var tap = new TapGestureRecognizer();
        tap.Tapped += async (_, _) =>
        {
            await UiMotion.PressPopAsync(card);
            _coordinator?.Navigate(MarketplaceRoute.ConsultChat, c);
        };
        card.GestureRecognizers.Add(tap);
        return card;
    }

    private static View StatusChip(string status)
    {
        var (text, color) = status switch
        {
            ConsultationStatus.Active => ("در جریان", Color.Parse("#34D399")),
            ConsultationStatus.Paid => ("پرداخت شده — آماده شروع", Color.Parse("#818CF8")),
            ConsultationStatus.PaymentPending or ConsultationStatus.Created => ("در انتظار پرداخت", Color.Parse("#F59E0B")),
            ConsultationStatus.Completed => ("پایان یافته", Color.Parse("#94A3B8")),
            ConsultationStatus.Cancelled => ("لغو شده", Color.Parse("#94A3B8")),
            ConsultationStatus.Expired => ("منقضی شده", Color.Parse("#94A3B8")),
            ConsultationStatus.Refunded => ("مسترد شده", Color.Parse("#22D3EE")),
            ConsultationStatus.Failed => ("ناموفق", Color.Parse("#EF4444")),
            _ => (status, Color.Parse("#94A3B8"))
        };
        return new Border
        {
            Background = color.WithAlpha(0.14f),
            Stroke = color.WithAlpha(0.45f),
            StrokeThickness = 1,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
            Padding = new Thickness(9, 3),
            VerticalOptions = LayoutOptions.Center,
            Content = new Label { Text = text, FontFamily = "VazirmatnMedium", FontSize = 11, TextColor = color }
        };
    }

    private string PriceText(ConsultationDto c) =>
        c.PriceToman > 0 ? $"{Fa(c.PriceToman)} تومان" : "قیمت توافقی";

    // ────────────────────────── state helpers ──────────────────────────

    private void SetState(View visible)
    {
        LoadingBlock.IsVisible = ReferenceEquals(visible, LoadingBlock);
        ErrorCard.IsVisible = ReferenceEquals(visible, ErrorCard);
        EmptyBlock.IsVisible = ReferenceEquals(visible, EmptyBlock);
        ListBlock.IsVisible = ReferenceEquals(visible, ListBlock);
        if (visible is not Border)
            _ = visible.FadeToAsync(1, 220, Easing.CubicOut);
    }

    private void ShowError(string message)
    {
        ErrorMessage.Text = message;
        SetState(ErrorCard);
    }

    private static object GetResource(string key) =>
        Application.Current!.Resources[key];

    private static Color Ink() => Application.Current?.RequestedTheme == AppTheme.Light
        ? (Color)GetResource("InkLight")!
        : (Color)GetResource("InkDark")!;

    // Persian digits for counts (UI is fully RTL Persian).
    private static string Fa(int n) =>
        string.Concat(n.ToString(System.Globalization.CultureInfo.InvariantCulture)
            .Select(ch => ch is >= '0' and <= '9' ? (char)('۰' + (ch - '0')) : ch));

    // ────────────────────────── events ──────────────────────────

    /// <summary>Client cancels an unpaid consultation (server: CREATED/PAYMENT_PENDING -> CANCELLED).</summary>
    private async Task CancelAsync(long consultationId)
    {
        var go = await DisplayAlertAsync("لغو مشاوره",
            "این مشاوره لغو شود؟ تا زمانی پرداخت نکرده‌اید، لغو هیچ هزینه‌ای ندارد.",
            "لغو مشاوره", "برگشت");
        if (!go) return;
        try
        {
            var token = await SafeTokenAsync();
            if (string.IsNullOrWhiteSpace(token)) return;
            var resp = await _api.CancelConsultationAsync(new ConsultationCancelRequest(token, consultationId));
            if (resp.Ok)
            {
                if (resp.Consultation is { } fresh)
                    _all = _all.Select(x => x.Id == fresh.Id ? fresh : x).ToArray();
                RenderList();
                await DisplayAlertAsync("لغو شد", resp.Message ?? "مشاوره لغو شد.", "باشه");
            }
            else
            {
                await DisplayAlertAsync("شکست", resp.Message ?? "امکان لغو وجود ندارد.", "باشه");
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine("consult cancel: " + ex);
            await DisplayAlertAsync("خطا", "لغو مشاوره ممکن نشد. لطفاً دوباره تلاش کنید.", "باشه");
        }
    }

    private async void OnBackClicked(object? sender, EventArgs e)
    {
        if (sender is Border b) await UiMotion.PressPopAsync(b);
        _coordinator?.Navigate(MarketplaceRoute.Chat);
    }

    private async void OnRefreshClicked(object? sender, EventArgs e)
    {
        if (sender is Border b) await UiMotion.PressPopAsync(b);
        _loaded = false;
        await LoadAsync();
    }

    private void OnBrowseLawyersClicked(object? sender, EventArgs e) =>
        _coordinator?.Navigate(MarketplaceRoute.Lawyers);
}
