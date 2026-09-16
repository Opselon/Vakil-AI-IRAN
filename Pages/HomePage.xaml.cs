using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Rendering;
using Vakil_AI_IRAN.Services;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Entities;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// The AI-first front door. Reads only what is REAL: chat threads (local),
/// consultations (server), the lawyer directory route. Every section hides
/// itself when empty — no fabricated cards. Quick actions are compact tonal
/// rows with vector icons (§343), not a colored button wall.
/// </summary>
public partial class HomePage : ContentPage
{
    private readonly IChatService _chat;
    private readonly IMarketplaceCoordinator? _marketplace;
    private readonly IMarketplaceApi? _api;
    private readonly ITokenStore? _tokens;

    private bool _loadedOnce;

    public HomePage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _chat = sp.GetRequiredService<IChatService>();
        _marketplace = sp.GetService<IMarketplaceCoordinator>();
        _api = sp.GetService<IMarketplaceApi>();
        _tokens = sp.GetService<ITokenStore>();

        TabBar.Active = TabKey.Home;
        TabBar.TabSelected += OnTabSelected;
        BuildQuickActions();
    }

    private void OnTabSelected(TabKey key)
    {
        var mkt = _marketplace;
        if (mkt is null) return;
        switch (key)
        {
            case TabKey.Home: break;
            case TabKey.Chat: mkt.OpenChat(focusComposer: true); break;
            case TabKey.Lawyers: mkt.Navigate(MarketplaceRoute.Lawyers); break;
            case TabKey.Account: _ = AccountMenu.OpenAsync(this, mkt); break;
        }
    }

    // ────────────────────────── quick actions (§31) ──────────────────────────

    private void BuildQuickActions()
    {
        (string Label, string Icon, Action Go)[] actions =
        {
            (UiText.AnalyzeDocument, "ic_doc.png",        () => _marketplace?.OpenChat(focusComposer: true)),
            (UiText.DraftDocument,   "ic_pen.png",        () => _marketplace?.OpenChat(focusComposer: true)),
            (UiText.MyConsultations, "ic_tab_consults_active.png", () => _marketplace?.Navigate(MarketplaceRoute.Consultations)),
            (UiText.FindLawyer,      "ic_tab_lawyers_active.png",  () => _marketplace?.Navigate(MarketplaceRoute.Lawyers)),
        };
        foreach (var (label, icon, go) in actions)
        {
            var row = new TapBorder
            {
                BackgroundColor = Palette.IsDark ? Color.Parse("#111C2E") : Color.Parse("#FFFFFF"),
                Stroke = new SolidColorBrush(Palette.Hairline),
                StrokeThickness = 1,
                StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 16 },
                Padding = new Thickness(13, 10),
                Content = new HorizontalStackLayout
                {
                    Spacing = 10,
                    Children =
                    {
                        new Image { Source = ImageSource.FromFile(icon), WidthRequest = 19, HeightRequest = 19, VerticalOptions = LayoutOptions.Center, InputTransparent = true },
                        new Label { Text = label, FontFamily = "VazirmatnMedium", FontSize = 14, TextColor = Palette.Ink, VerticalOptions = LayoutOptions.Center, InputTransparent = true },
                        new Label { Text = "‹", FontSize = 17, TextColor = Palette.Muted, VerticalOptions = LayoutOptions.Center,
                                    HorizontalOptions = LayoutOptions.End, InputTransparent = true }
                    }
                }
            };
            // RTL: the ‹ glyph points toward content start (right side) — correct for "باز کنید".
            SemanticProperties.SetDescription(row, label);
            row.Tapped += (_, _) => { UiMotion.TapHaptic(); go(); };
            QuickActions.Children.Add(row);
        }
    }

    // ────────────────────────── entry points ──────────────────────────

    private void OnAskTapped(object? sender, TappedEventArgs e)
    {
        UiMotion.TapHaptic();
        _marketplace?.OpenChat(focusComposer: true);
    }

    private void OnContinueChatTapped(object? sender, TappedEventArgs e) =>
        _marketplace?.OpenChat();

    private ConsultationDto? _liveConsultation;

    private void OnContinueConsultTapped(object? sender, TappedEventArgs e)
    {
        if (_liveConsultation is not null)
            _marketplace?.Navigate(MarketplaceRoute.ConsultChat, _liveConsultation);
        else
            _marketplace?.Navigate(MarketplaceRoute.Consultations);
    }

    // ────────────────────────── data ──────────────────────────

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        GreetingLabel.Text = UiText.Greeting(VakilTime.InTehran(DateTimeOffset.UtcNow));

        try { await LoadThreadsAsync(); } catch (Exception ex) { Debug.WriteLine("home threads: " + ex); }
        try { await LoadConsultationAsync(); } catch (Exception ex) { Debug.WriteLine("home consult: " + ex); }

        if (!_loadedOnce)
        {
            _loadedOnce = true;
            var views = new View[] { AskCard, QuickActions };
            for (int i = 0; i < views.Length; i++)
                _ = UiMotion.RiseInAsync(views[i], delayMs: (uint)(i * 80), rise: 12, durationMs: 240);
        }
    }

    private async Task LoadThreadsAsync()
    {
        var threads = (await _chat.ListThreadsAsync())
            .Where(t => t.MessageCount > 0)
            .ToList();

        ContinueChatCard.IsVisible = false;
        RecentList.Children.Clear();
        if (threads.Count == 0)
        {
            ContinueSection.IsVisible = ContinueConsultCard.IsVisible;
            RecentSection.IsVisible = false;
            return;
        }

        // newest non-pinned thread = "continue"; the next two = recent list
        var newest = threads[0];
        ContinueChatTitle.Text = newest.Title;
        ContinueChatCard.IsVisible = true;
        ContinueSection.IsVisible = true;

        foreach (var t in threads.Skip(1).Take(3))
        {
            var row = new TapBorder
            {
                BackgroundColor = Colors.Transparent,
                StrokeThickness = 0,
                Padding = new Thickness(4, 8),
                Content = new HorizontalStackLayout
                {
                    Spacing = 8,
                    Children =
                    {
                        new Image { Source = ImageSource.FromFile("ic_chat_arrow.png"), WidthRequest = 14, HeightRequest = 14, VerticalOptions = LayoutOptions.Center, InputTransparent = true },
                        new Label { Text = t.Title, FontFamily = "VazirmatnRegular", FontSize = 13.5, TextColor = Palette.Muted,
                                    MaxLines = 1, LineBreakMode = LineBreakMode.TailTruncation, WidthRequest = 280, VerticalOptions = LayoutOptions.Center, InputTransparent = true }
                    }
                }
            };
            SemanticProperties.SetDescription(row, t.Title);
            var captured = t.Id;
            row.Tapped += (_, _) => _marketplace?.OpenChat(captured);
            RecentList.Children.Add(row);
        }
        RecentSection.IsVisible = RecentList.Children.Count > 0;
    }

    private async Task LoadConsultationAsync()
    {
        ContinueConsultCard.IsVisible = false;
        if (_api is null || _tokens is null || _marketplace is null || !_marketplace.Current.IsSignedIn)
        {
            ContinueSection.IsVisible = ContinueChatCard.IsVisible;
            return;
        }
        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrWhiteSpace(token)) return;

        var res = await _api.ConsultationsAsync(token);
        var live = res.Consultations?
            .FirstOrDefault(c => c.Status is ConsultationStatus.Active or ConsultationStatus.Paid
                or ConsultationStatus.Created or ConsultationStatus.PaymentPending);
        if (live is null) { ContinueSection.IsVisible = ContinueChatCard.IsVisible; return; }
        _liveConsultation = live;

        var amClient = _marketplace.Current.UserId == live.ClientUserId;
        ContinueConsultTitle.Text = (amClient ? "مشاوره با " : "مشاوره با موکل ") + (amClient ? live.LawyerName ?? "وکیل" : live.ClientName ?? "موکل");
        ContinueConsultSub.Text = live.Status switch
        {
            ConsultationStatus.Active => "گفتگو فعال — ادامه دهید",
            ConsultationStatus.Paid => "پرداخت شده — آماده شروع",
            _ => "در انتظار پرداخت — ادامه‌ی رزرو"
        };
        ContinueConsultCard.IsVisible = true;
        ContinueSection.IsVisible = true;
    }
}
