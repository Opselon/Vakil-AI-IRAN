using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Controls;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Entities;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// Local conversation index (§24): recent + pinned threads with search, open,
/// rename, pin, delete (confirm only on delete — §369). Opening a thread hands
/// the id to the coordinator, which re-roots Chat onto it (Chat keeps state in
/// ChatService, the single thread authority).
/// </summary>
public partial class ConversationsPage : ContentPage
{
    private readonly IChatService _chat;
    private readonly IMarketplaceCoordinator? _nav;
    private readonly List<Conversation> _all = new();

    public ConversationsPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _chat = sp.GetRequiredService<IChatService>();
        _nav = sp.GetService<IMarketplaceCoordinator>();
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        try
        {
            _all.Clear();
            _all.AddRange(await _chat.ListThreadsAsync());
            RenderList();
        }
        catch (Exception e) { Debug.WriteLine("history load: " + e); }
    }

    private async void OnSearchChanged(object? sender, TextChangedEventArgs e)
    {
        try
        {
            var q = e.NewTextValue?.Trim() ?? string.Empty;
            _all.Clear();
            _all.AddRange(q.Length >= 2 ? await _chat.SearchThreadsAsync(q) : await _chat.ListThreadsAsync());
            RenderList();
        }
        catch (Exception ex) { Debug.WriteLine("history search: " + ex); }
    }

    private void RenderList()
    {
        Body.Children.Clear();
        var threads = _all.Where(t => t.MessageCount > 0 || t.Id == _chat.ActiveThreadId).ToList();
        if (threads.Count == 0)
        {
            Body.Children.Add(new VerticalStackLayout
            {
                Spacing = 8,
                Margin = new Thickness(0, 40, 0, 0),
                Children =
                {
                    new Image { Source = ImageSource.FromFile("ic_history.png"), WidthRequest = 40, HeightRequest = 40, HorizontalOptions = LayoutOptions.Center },
                    new Label { Text = UiText.NoChatsYet, FontFamily = "VazirmatnBold", FontSize = 15, HorizontalTextAlignment = TextAlignment.Center,
                                TextColor = Palette.Ink }
                }
            });
            return;
        }

        bool printedPinnedHeader = false, printedRecentHeader = false;
        foreach (var group in new[] { (Key: "pinned", Label: "سنجاق‌شده"), (Key: "recent", Label: "اخیر") })
        {
            var rows = group.Key == "pinned"
                ? threads.Where(t => t.Pinned).ToList()
                : threads.Where(t => !t.Pinned).ToList();
            if (rows.Count == 0) continue;
            foreach (var t in rows)
            {
                if (group.Key == "pinned" && !printedPinnedHeader)
                {
                    Body.Children.Add(Header(UiText.PinThread));
                    printedPinnedHeader = true;
                }
                if (group.Key == "recent" && !printedRecentHeader)
                {
                    Body.Children.Add(Header(UiText.HomeRecentChats));
                    printedRecentHeader = true;
                }
                Body.Children.Add(BuildRow(t));
            }
        }
    }

    private static Label Header(string text) => new()
    {
        Text = text,
        Style = (Style)Application.Current!.Resources["TypeLabel"],
        Margin = new Thickness(4, 12, 4, 2)
    };

    private View BuildRow(Conversation t)
    {
        var card = new Border
        {
            Style = (Style)Application.Current!.Resources["GlassCard"],
            Padding = new Thickness(14, 11)
        };

        var title = new Label
        {
            Text = (t.Pinned ? "📌 " : "") + (string.IsNullOrWhiteSpace(t.Title) ? Conversation.Untitled : t.Title),
            FontFamily = "VazirmatnBold",
            FontSize = 14.5,
            TextColor = Palette.Ink,
            MaxLines = 1,
            LineBreakMode = LineBreakMode.TailTruncation
        };
        var sub = new Label
        {
            Text = RelativeTime(t.UpdatedAtMs) + "  ·  " + UiText.QuotaFaDigits(t.MessageCount.ToString()) + " پیام",
            Style = (Style)Application.Current.Resources["Caption"]
        };

        card.Content = new VerticalStackLayout { Spacing = 3, Children = { title, sub } };

        var tap = new TapGestureRecognizer();
        tap.Tapped += async (_, _) => { _ = UiMotion.PressPopAsync(card); UiMotion.TapHaptic(); Open(t); };
        card.GestureRecognizers.Add(tap);

        var longPress = new TapGestureRecognizer { NumberOfTapsRequired = 2 };
        longPress.Tapped += async (_, _) => await ActionsAsync(t);
        card.GestureRecognizers.Add(longPress);

        SemanticProperties.SetDescription(card, t.Title);
        return card;
    }

    private void Open(Conversation t) => _nav?.OpenChat(t.Id);

    private async Task ActionsAsync(Conversation t)
    {
        const string cRename = "تغییر نام", cPin = "سنجاق", cUnpin = "برداشتن سنجاق", cDelete = "حذف", cCancel = "انصراف";
        var choice = await DisplayActionSheetAsync(t.Title, cCancel, null,
            cRename, (t.Pinned ? cUnpin : cPin) + " ", cDelete);
        switch (choice)
        {
            case cRename:
                var name = await DisplayPromptAsync(UiText.RenameThread, "یک نام کوتاه:",
                    accept: "ذخیره", cancel: "انصراف", initialValue: t.Title, maxLength: 60);
                if (!string.IsNullOrWhiteSpace(name)) await _chat.RenameThreadAsync(t.Id, name);
                break;
            case cPin:
            case cUnpin:
                await _chat.TogglePinThreadAsync(t.Id, !t.Pinned);
                break;
            case cDelete:
                var go = await DisplayAlertAsync(UiText.DeleteThread, UiText.DeleteThreadConfirm, UiText.DeleteThread, "انصراف");
                if (go) await _chat.DeleteThreadAsync(t.Id);
                break;
            default: return;
        }
        _all.Clear();
        _all.AddRange(await _chat.ListThreadsAsync());
        RenderList();
    }

    private static string RelativeTime(long unixMs)
    {
        try
        {
            var then = VakilTime.InTehran(DateTimeOffset.FromUnixTimeMilliseconds(unixMs));
            var span = DateTime.Now - then;
            if (span.TotalMinutes < 1) return "همین حالا";
            if (span.TotalHours < 1) return UiText.QuotaFaDigits($"{(int)span.TotalMinutes} دقیقه پیش");
            if (span.TotalDays < 1) return UiText.QuotaFaDigits($"{(int)span.TotalHours} ساعت پیش");
            if (span.TotalDays < 7) return UiText.QuotaFaDigits($"{(int)span.TotalDays} روز پیش");
            return then.ToString("yyyy/MM/dd");
        }
        catch { return string.Empty; }
    }

    private async void OnBackTapped(object? sender, TappedEventArgs e)
    {
        if (_nav is null) return;
        try { _nav.NavigateBack(MarketplaceRoute.Chat); }
        catch (Exception ex) { Debug.WriteLine("back: " + ex); }
    }

    private void OnNewTapped(object? sender, TappedEventArgs e)
    {
        UiMotion.TapHaptic();
        _nav?.OpenChat(focusComposer: true);
    }

    private static class Palette
    {
        public static Color Ink => Application.Current?.RequestedTheme == AppTheme.Light
            ? Color.Parse("#0B1220") : Color.Parse("#E6EDF7");
    }
}
