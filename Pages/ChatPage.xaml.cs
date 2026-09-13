using System.Diagnostics;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Entities;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Rendering;

using Microsoft.Extensions.DependencyInjection;
using IMediaPicker = VakilAI.Application.Contracts.IMediaPicker;
using FlexDirection = Microsoft.Maui.Layouts.FlexDirection;
using FlexWrap = Microsoft.Maui.Layouts.FlexWrap;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// The chat surface. All conversational state lives in <see cref="ChatService"/>;
/// this page only renders the published snapshots (throttled, on the main thread)
/// and dispatches user intent back to the engine.
/// Every ambient animation is bound to <see cref="_cts"/> — nothing loops after unload.
/// </summary>
public partial class ChatPage : ContentPage
{
    private readonly ChatService _service;
    private readonly ActivationGate _gate;
    private readonly IMediaPicker _picker;
    private readonly List<long> _renderedIds = new();
    private readonly CancellationTokenSource _cts = new();
    private Border? _typingBubble;
    private Label? _typingHint;
    private IReadOnlyList<ChatButton>? _renderedMenu;
    private bool? _statusBusy;
    private ChatStateChanged? _pending;
    private int _flushScheduled;
    private bool _initialized;

    public ChatPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _service = sp.GetRequiredService<ChatService>();
        _gate = sp.GetRequiredService<ActivationGate>();
        _picker = sp.GetRequiredService<IMediaPicker>();
        _service.Changed += OnStateChanged;
        // rich-text bubbles bake their colors at build time (Palette) — when the OS
        // flips the theme we rebuild the transcript so inks follow the new surface.
        Application.Current!.RequestedThemeChanged += OnThemeChanged;
    }

    private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
    {
        if (Handler is null) return;
        ResetTranscript();
        if (_pending is not null) Flush();
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        if (_initialized) return;
        _initialized = true;

        EntranceAsync();

        try
        {
            await _service.InitializeAsync();
            await Task.Delay(60);
            ScrollToEnd(animate: false);
        }
        catch (Exception e)
        {
            Debug.WriteLine("chat init: " + e);
        }
    }

    private async void EntranceAsync()
    {
        try
        {
            await UiMotion.RiseInAsync(HeaderCard, rise: 22, durationMs: 300);
            await UiMotion.RiseInAsync(ComposerCard, rise: 18, durationMs: 260);

            // the connection dot breathes while the page is open
            UiMotion.Loop(_cts.Token, async ct =>
            {
                await StatusDot.FadeToAsync(0.35, 900, Easing.SinInOut);
                await StatusDot.FadeToAsync(1, 900, Easing.SinInOut);
                ct.ThrowIfCancellationRequested();
            });
        }
        catch (Exception e) { Debug.WriteLine("entrance: " + e); }
    }

    // ────────────────────────── reactive rebuild (throttled) ──────────────────────────

    private void OnStateChanged(object? sender, ChatStateChanged state)
    {
        _pending = state;
        if (Interlocked.Exchange(ref _flushScheduled, 1) == 0)
            MainThread.BeginInvokeOnMainThread(Flush);
    }

    private void Flush()
    {
        Interlocked.Exchange(ref _flushScheduled, 0);
        var state = _pending;
        if (state is null || Handler is null) return;
        try { Render(state); }
        catch (Exception e) { Debug.WriteLine("render failed: " + e); }
    }

    private void Render(ChatStateChanged state)
    {
        HeaderSubtitle.Text = state.DraftingMode
            ? "حالت تنظیم لوایح فعال — برای خروج «لغو» را بزنید"
            : state.IsBusy && !string.IsNullOrWhiteSpace(state.BusyHint)
                ? state.BusyHint
                : "دستیار حقوقی ۲۴ ساعته شما";

        UpdateStatusLight(state.IsBusy);
        RenderQuota(state.Quota);
        RenderMenu(state.MainMenu);
        AppendMessages(state.Messages);
        UpdateTyping(state);

        if (state.Error == "SESSION_EXPIRED")
            _ = SignOutToActivationAsync();
    }

    private void UpdateStatusLight(bool busy)
    {
        if (_statusBusy == busy) return;
        _statusBusy = busy;
        StatusDot.Color = busy
            ? Color.Parse("#FBBF24")     // amber while thinking
            : Color.Parse("#34D399");    // green when ready
    }

    private void RenderQuota(QuotaSnapshot? quota)
    {
        if (quota is null)
        {
            QuotaChipLabel.Text = "آماده گفتگو";
            return;
        }

        QuotaChipLabel.Text = quota.IsUnlimited
            ? "♾️ نامحدود"
            : $"{quota.Used}/{quota.DailyLimit} مشاوره امروز";
    }

    // ────────────────────────── quick-action menu strip ──────────────────────────

    private void RenderMenu(IReadOnlyList<ChatButton>? menu)
    {
        if (menu is null || menu.Count == 0) return;
        if (ReferenceEquals(_renderedMenu, menu)) return;
        if (_renderedMenu is not null && _renderedMenu.SequenceEqual(menu)) return;
        _renderedMenu = menu;

        MenuChips.Children.Clear();
        foreach (var cb in menu)
        {
            var chip = new Border
            {
                Style = GetStyle("MenuChip"),
                Content = new Label
                {
                    Text = cb.Text,
                    FontFamily = "VazirmatnMedium",
                    FontSize = 12.5,
                    TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3")
                }
            };

            var captured = cb;
            var tap = new TapGestureRecognizer();
            tap.Tapped += async (_, _) =>
            {
                _ = UiMotion.PressPopAsync(chip);
                await RunQuietly(() => _service.InvokeActionAsync(captured));
            };
            chip.GestureRecognizers.Add(tap);

            MenuChips.Children.Add(chip);
            _ = UiMotion.RiseInAsync(chip, delayMs: (uint)(MenuChips.Children.Count * 45), rise: 10, durationMs: 200);
        }
        MenuStrip.IsVisible = true;
    }

    // ────────────────────────── transcript ──────────────────────────

    private void AppendMessages(IReadOnlyList<ChatMessage> messages)
    {
        // Append-only fast path; rebuild fully if the transcript was replaced/reset.
        if (_renderedIds.Count > messages.Count)
            ResetTranscript();
        else
        {
            for (int i = 0; i < _renderedIds.Count; i++)
            {
                if (_renderedIds[i] != messages[i].Id)
                {
                    ResetTranscript();
                    break;
                }
            }
        }

        int first = _renderedIds.Count;
        for (int i = first; i < messages.Count; i++)
        {
            var m = messages[i];
            _renderedIds.Add(m.Id);
            var row = BuildRow(m);
            // keep the live typing bubble pinned at the very bottom of the transcript
            int insertAt = _typingBubble is null
                ? MessagesStack.Children.Count
                : Math.Max(first, MessagesStack.Children.Count - 1);
            MessagesStack.Children.Insert(insertAt, row);
            _ = AnimateInAsync(row, i - first);
        }

        if (messages.Count > first)
            ScrollToEnd(animate: true);
    }

    private void ResetTranscript()
    {
        MessagesStack.Clear();
        _renderedIds.Clear();
        _typingBubble = null;
        _typingHint = null;
    }

    // ────────────────────────── bubble construction ──────────────────────────

    private View BuildRow(ChatMessage message)
    {
        bool user = message.Role == MessageRole.User;

        var bubble = new Border
        {
            Style = GetStyle(user ? "UserBubble" : "ChatBubble"),
            Content = BuildBody(message)
        };
        if (message.IsFailed)
        {
            bubble.Stroke = new SolidColorBrush(Color.Parse("#EF4444"));
            bubble.StrokeThickness = 1.4;
        }

        var row = new VerticalStackLayout { Spacing = 3, Padding = new Thickness(0, 2) };

        if (user)
        {
            row.Children.Add(bubble);
        }
        else
        {
            // assistant: bubble in a star column + avatar pinned to the LEFT edge.
            // In RTL, column 0 renders rightmost, so bubble | avatar reads correctly
            // and the bubble still wraps at MaximumWidth without clipping the avatar.
            var withAvatar = new Grid
            {
                ColumnDefinitions =
                {
                    new ColumnDefinition(GridLength.Star),
                    new ColumnDefinition(GridLength.Auto)
                },
                ColumnSpacing = 8
            };
            var avatar = Avatar();
            withAvatar.Children.Add(bubble);
            withAvatar.Children.Add(avatar);
            Grid.SetColumn(avatar, 1);
            row.Children.Add(withAvatar);
        }

        if (message.Buttons.Count > 0)
            row.Children.Add(BuildButtons(message.Buttons));

        row.Children.Add(new Label
        {
            Text = FormatTime(message.CreatedAtMs) + KindBadge(message.Kind),
            Style = GetStyle("Caption"),
            HorizontalOptions = user ? LayoutOptions.Start : LayoutOptions.End
        });
        return row;
    }

    /// <summary>The AI spark badge that rides next to every assistant bubble.</summary>
    private static Border Avatar() => new()
    {
        WidthRequest = 30,
        HeightRequest = 30,
        VerticalOptions = LayoutOptions.Start,
        BackgroundColor = Color.Parse("#16233D"),
        Stroke = new SolidColorBrush(Color.Parse("#27395C")),
        StrokeThickness = 1,
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 9 },
        Content = new Image
        {
            Source = "ic_ai_spark.png",
            WidthRequest = 18,
            HeightRequest = 18,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center
        }
    };

    private static View BuildBody(ChatMessage message)
    {
        if (message.Role == MessageRole.User)
        {
            return new Label
            {
                Text = message.Text,
                FontFamily = "VazirmatnRegular",
                FontSize = 15,
                TextColor = Color.Parse("#FFFFFF"),
                LineHeight = 1.4,
                LineBreakMode = LineBreakMode.WordWrap
            };
        }
        return RichBlockRenderer.Build(message);
    }

    private static string KindBadge(MessageKind kind) => kind switch
    {
        MessageKind.Drafting => "  ✍️ در حال تنظیم",
        MessageKind.Warning => "  ⚠️",
        MessageKind.Page => "  📄 منو",
        MessageKind.Action => "  ⚡",
        _ => string.Empty
    };

    private View BuildButtons(IReadOnlyList<ChatButton> buttons)
    {
        var wrap = new FlexLayout
        {
            Direction = FlexDirection.Row,
            Wrap = FlexWrap.Wrap,
            Margin = new Thickness(-3)
        };

        foreach (var cb in buttons)
        {
            var b = new Button
            {
                Text = cb.Text,
                Style = GetStyle(cb.Style switch
                {
                    ButtonStyle.Success => "SuccessBg",
                    ButtonStyle.Danger => "DangerBg",
                    _ => "PrimaryBg"
                }),
                Margin = new Thickness(3),
                MinimumHeightRequest = 44
            };

            b.Pressed += (_, _) => _ = b.ScaleToAsync(0.94, 90, Easing.CubicOut);
                        b.Released += (_, _) => _ = b.ScaleToAsync(1, 150, Easing.SpringOut);

            var captured = cb;
            b.Clicked += async (_, _) => await RunQuietly(() => _service.InvokeActionAsync(captured));
            wrap.Children.Add(b);
        }
        return wrap;
    }

    // ────────────────────────── typing indicator ──────────────────────────

    private void UpdateTyping(ChatStateChanged state)
    {
        if (state.IsBusy)
        {
            if (_typingBubble is null)
            {
                var dots = new HorizontalStackLayout { Spacing = 6, Margin = new Thickness(4, 6, 0, 0) };
                for (int i = 0; i < 3; i++)
                {
                    var dot = new BoxView
                    {
                        Color = Color.Parse("#818CF8"),
                        WidthRequest = 9,
                        HeightRequest = 9,
                        CornerRadius = 5,
                        Opacity = 0.25
                    };
                    dots.Children.Add(dot);
                    _ = PulseAsync(dot, delayMs: i * 220);
                }

                _typingHint = new Label
                {
                    Text = state.BusyHint ?? "در حال پردازش…",
                    Style = GetStyle("Caption")
                };

                var inner = new VerticalStackLayout { Spacing = 2, Children = { _typingHint, dots } };

                var bubble = new Border
                {
                    Style = GetStyle("ChatBubble"),
                    Content = inner
                };

                // same left-edge bubble+avatar pair as normal assistant rows
                var withAvatar = new HorizontalStackLayout
                {
                    Spacing = 8,
                    HorizontalOptions = LayoutOptions.End
                };
                withAvatar.Children.Add(bubble);
                withAvatar.Children.Add(Avatar());

                _typingBubble = new Border
                {
                    BackgroundColor = Colors.Transparent,
                    StrokeThickness = 0,
                    StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 0 },
                    Padding = 0,
                    HorizontalOptions = LayoutOptions.Fill,
                    Content = withAvatar
                };
            }
            else if (_typingHint is not null)
            {
                _typingHint.Text = state.BusyHint ?? "در حال پردازش…";
            }

            if (!_typingBubble.IsInStack(MessagesStack))
                MessagesStack.Children.Add(_typingBubble);

            ScrollToEnd(animate: true);
        }
        else if (_typingBubble is not null)
        {
            MessagesStack.Children.Remove(_typingBubble);
            _typingBubble = null;
            _typingHint = null;
        }
    }

    private async Task PulseAsync(BoxView dot, int delayMs)
    {
        try
        {
            await Task.Delay(delayMs, _cts.Token);
            while (dot.Parent is not null && !_cts.IsCancellationRequested)
            {
                await dot.FadeToAsync(1, 300, Easing.SinOut);
                                await dot.FadeToAsync(0.25, 320, Easing.SinIn);
            }
        }
        catch (Exception e) { Debug.WriteLine("pulse: " + e.Message); }
    }

    // ────────────────────────── composer actions ──────────────────────────

    private async void OnSendClicked(object? sender, EventArgs e) => await SendCurrentTextAsync();

    private async void OnComposerCompleted(object? sender, EventArgs e) => await SendCurrentTextAsync();

    private async Task SendCurrentTextAsync()
    {
        var text = ComposerEditor.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return;
        if (_service.IsBusy) return;

        ComposerEditor.Text = string.Empty;
        _ = UiMotion.PressPopAsync(SendBtn);
        await RunQuietly(() => _service.SendTextAsync(text));
    }

    private async void OnAttachClicked(object? sender, EventArgs e)
    {
        if (_service.IsBusy) return;
        _ = UiMotion.PressPopAsync(AttachBtn);
        try
        {
            var image = await _picker.PickDocumentPhotoAsync(1280);
            if (image is null) return;
            var caption = ComposerEditor.Text?.Trim() ?? string.Empty;
            ComposerEditor.Text = string.Empty;
            await _service.SendImageAsync(image, caption);
        }
        catch (InvalidOperationException io)
        {
            await DisplayAlertAsync("تصویر سند", io.Message ?? "انتخاب تصویر ناموفق بود.", "باشه");
        }
        catch (Exception ex)
        {
            Debug.WriteLine("attach: " + ex);
            await DisplayAlertAsync("تصویر سند", "انتخاب یا خواندن تصویر ممکن نشد.", "باشه");
        }
    }

    private async void OnMicClicked(object? sender, EventArgs e)
    {
        _ = UiMotion.PressPopAsync(MicBtn);
        await DisplayAlertAsync("پیام صوتی",
            "ارسال ویس در بروزرسانی بعدی فعال می‌شود. فعلاً سوال خود را بنویسید یا تصویر سند بفرستید. 🖊️",
            "باشه");
    }

    // ────────────────────────── helpers ──────────────────────────

    private static Style GetStyle(string key)
    {
        var resources = Application.Current!.Resources;
        if (resources.TryGetValue(key, out var value) && value is Style style)
            return style;
        throw new InvalidOperationException("missing app style: " + key);
    }

    private async Task RunQuietly(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e)
        {
            Debug.WriteLine("action: " + e);
            await DisplayAlertAsync("خطا", "برقراری ارتباط ممکن نشد؛ چند لحظه دیگر تلاش کنید.", "باشه");
        }
    }

    private async Task SignOutToActivationAsync()
    {
        _service.Changed -= OnStateChanged;
        _cts.Cancel();
        await _gate.SignOutAsync();
        MainThread.BeginInvokeOnMainThread(() =>
        {
            var app = Application.Current;
            if (app is not null && app.Windows.Count > 0)
                app.Windows[0].Page = MauiProgram.Services.GetRequiredService<ActivationPage>();
        });
    }

    private void ScrollToEnd(bool animate)
    {
        if (MessagesStack.Children.Count == 0) return;
        if (MessagesStack.Children[^1] is not Element last) return;
        _ = MessagesScroll.ScrollToAsync(last, ScrollToPosition.End, animate);
    }

    private static async Task AnimateInAsync(View row, int stagger)
    {
        row.Opacity = 0;
        row.TranslationY = 14;
        await Task.Delay(Math.Min(stagger, 5) * 45);
        await row.FadeToAsync(1, 240, Easing.CubicOut);
        await row.TranslateToAsync(0, 0, 280, Easing.SpringOut);
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts.Cancel(); // status pulse + typing dots stop with the page
    }

    protected override void OnHandlerChanging(HandlerChangingEventArgs args)
    {
        base.OnHandlerChanging(args);
        if (args.NewHandler is null && Application.Current is not null)
            Application.Current.RequestedThemeChanged -= OnThemeChanged;
    }

    private static string FormatTime(long unixMs)
    {
        try
        {
            return VakilTime.InTehran(DateTimeOffset.FromUnixTimeMilliseconds(unixMs)).ToString("HH:mm");
        }
        catch { return string.Empty; }
    }
}

internal static class ChatPageExtensions
{
    public static bool IsInStack(this VisualElement element, VerticalStackLayout stack)
    {
        for (int i = stack.Children.Count - 1; i >= 0; i--)
            if (ReferenceEquals(stack.Children[i], element)) return true;
        return false;
    }
}

internal static class VakilTime
{
    public static DateTime InTehran(DateTimeOffset instant)
    {
        try
        {
            return TimeZoneInfo.ConvertTime(instant, TimeZoneInfo.FindSystemTimeZoneById("Asia/Tehran")).DateTime;
        }
        catch
        {
            try
            {
                return TimeZoneInfo.ConvertTime(instant, TimeZoneInfo.FindSystemTimeZoneById("Iran Standard Time")).DateTime;
            }
            catch
            {
                return instant.ToOffset(TimeSpan.FromHours(3.5)).DateTime;
            }
        }
    }
}
