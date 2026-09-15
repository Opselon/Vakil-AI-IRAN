using System.Diagnostics;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Entities;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Rendering;
using Vakil_AI_IRAN.Services;

using Microsoft.Extensions.DependencyInjection;
using IMediaPicker = VakilAI.Application.Contracts.IMediaPicker;
using FlexDirection = Microsoft.Maui.Layouts.FlexDirection;
using FlexWrap = Microsoft.Maui.Layouts.FlexWrap;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// The AI surface. All conversational state lives in <see cref="ChatService"/>;
/// this page renders published snapshots (throttled, main thread), owns the
/// shared <see cref="ChatComposer"/>, the honest empty state, scroll discipline
/// and the voice/attach flows. Every ambient animation is bound to
/// <see cref="_cts"/> — nothing loops after unload.
/// </summary>
public partial class ChatPage : ContentPage
{
    private readonly ChatService _service;
    private readonly ActivationGate _gate;
    private readonly IMarketplaceCoordinator? _marketplace;
    private readonly IMediaPicker _picker;
    private readonly IAudioRecorder _recorder;
    private readonly List<long> _renderedIds = new();
    private CancellationTokenSource _cts = new(); // revivable: push-stack reuses instances
    private Border? _typingBubble;
    private Label? _typingHint;
    private IReadOnlyList<ChatButton>? _renderedMenu;
    private bool? _statusBusy;
    private ChatStateChanged? _pending;
    private int _flushScheduled;
    private bool _initialized;

    private ChatComposer _composer = null!;
    private readonly HashSet<long> _actionedRows = new();

    // scroll discipline: auto-stick unless the user scrolled up; pill invites back
    private bool _stickToBottom = true;
    private bool _programmaticScroll;
    private double _lastScrollY;
    private bool _pendingNewMessage;

    // voice recording
    private CancellationTokenSource? _recCts;
    private bool _recording;
    private bool _recStopArmed;

    public ChatPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _service = sp.GetRequiredService<ChatService>();
        _gate = sp.GetRequiredService<ActivationGate>();
        _picker = sp.GetRequiredService<IMediaPicker>();
        _recorder = sp.GetRequiredService<IAudioRecorder>();
        // Optional by design: the marketplace coordinator may fail to construct —
        // the AI chat must keep working exactly as before.
        _marketplace = sp.GetService<IMarketplaceCoordinator>();
        _service.Changed += OnStateChanged;

        if (_marketplace is null)
            TabBar.IsVisible = false; // legacy build — chat unchanged, no chrome without a navigator
        else
            TabBar.TabSelected += OnTabSelected;

        BuildComposer();
        BuildPromptChips();

        Application.Current!.RequestedThemeChanged += OnThemeChanged;
    }

    // ────────────────────────── composer wiring ──────────────────────────

    private void BuildComposer()
    {
        _composer = new ChatComposer(
            showAttach: true,
            showMic: _recorder.IsAvailable,
            placeholder: "سوال حقوقی خود را بنویسید…")
        {
            Margin = new Thickness(0)
        };
        _composer.SendRequested += text => _ = SendTextAsync(text);
        _composer.StopRequested += () =>
        {
            _service.StopGeneration();
        };
        _composer.AttachRequested += () => _ = OnAttachClickedAsync();
        _composer.MicRequested += () => _ = OnMicClickedAsync();
        _composer.KeyboardVisibilityChanged += open => TabBar.SetKeyboardOpen(open);
        _composer.AttachmentRemoveRequested += () => { _pendingAttachment = null; _composer.HideAttachment(); };
        _composer.RecordingCancelRequested += () => _ = FinishVoiceAsync(cancel: true);
        _composer.TextChangedLive += DraftStore.Save;
        ComposerSlot.Children.Add(_composer);
    }

    private void BuildPromptChips()
    {
        foreach (var (label, prefill) in UiText.PromptChips)
        {
            var chip = new TapBorder
            {
                Style = GetStyle("MenuChip"),
                HorizontalOptions = LayoutOptions.Start,
                Content = new HorizontalStackLayout
                {
                    Spacing = 6,
                    VerticalOptions = LayoutOptions.Center,
                    Children =
                    {
                        new Image { Source = ImageSource.FromFile("ic_chat_arrow.png"), WidthRequest = 14, HeightRequest = 14, VerticalOptions = LayoutOptions.Center, InputTransparent = true },
                        new Label { Text = label, FontFamily = "VazirmatnMedium", FontSize = 12.5, VerticalOptions = LayoutOptions.Center, InputTransparent = true,
                                    TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3") }
                    }
                }
            };
            SemanticProperties.SetDescription(chip, label);
            var captured = prefill;
            chip.Tapped += async (_, _) =>
            {
                EmptyState.IsVisible = false;
                _composer.Text = captured;
                _composer.FocusInput();
                await Task.Delay(120);
            };
            PromptChips.Children.Add(chip);
        }
    }

    private CapturedImage? _pendingAttachment;

    private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
    {
        if (Handler is null) return;
        TabBar.ApplyTheme();
        _composer?.ApplyTheme();
        ResetTranscript();
        if (_pending is not null) Flush();
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        if (_detachedOnLeave)
        {
            _detachedOnLeave = false;
            _service.Changed += OnStateChanged;   // re-attach after a leave/return cycle
            if (_cts.IsCancellationRequested)
            {
                _cts.Dispose();
                _cts = new CancellationTokenSource();
            }
            StartStatusPulse();
        }

        UpdateThreadHeader();
        if (_initialized) return;
        _initialized = true;

        EntranceAsync();

        try
        {
            // thread hand-offs from the coordinator (History opened one / Home focused ask)
            var mkt = _marketplace as MarketplaceCoordinator;
            if (mkt is not null && mkt.PendingChatThreadId != 0)
            {
                var thread = mkt.PendingChatThreadId;
                mkt.PendingChatThreadId = 0;
                await _service.OpenThreadAsync(thread);
            }
            if (mkt is not null && mkt.FocusComposerOnNextChat)
            {
                mkt.FocusComposerOnNextChat = false;
                _ = Task.Delay(350).ContinueWith(_ => MainThread.BeginInvokeOnMainThread(() => _composer.FocusInput()));
            }

            await _service.InitializeAsync();
            await Task.Delay(60);

            // restore a saved draft if this is a fresh empty thread (§74)
            var draft = DraftStore.Load();
            if (draft.Length > 0 && _service.Messages.Count == 0)
            {
                _composer.Text = draft;
                DraftBanner.IsVisible = true;
                _ = DraftBanner.FadeToAsync(1, 260);
                _ = Task.Delay(2600).ContinueWith(_ => MainThread.BeginInvokeOnMainThread(
                    () => DraftBanner.IsVisible = false));
            }

            ScrollToEnd(animate: false);
        }
        catch (Exception e)
        {
            Debug.WriteLine("chat init: " + e);
        }
    }

    private void OnTabSelected(TabKey key)
    {
        var mkt = _marketplace;
        if (mkt is null) return;
        switch (key)
        {
            case TabKey.Home:
                mkt.Navigate(MarketplaceRoute.Home);
                break;
            case TabKey.Chat:
                break; // already here
            case TabKey.Lawyers:
                mkt.Navigate(MarketplaceRoute.Lawyers);
                break;
            case TabKey.Account:
                _ = AccountMenu.OpenAsync(this, mkt);
                break;
        }
    }

    // ────────────────────────── header actions ──────────────────────────

    private async void OnTitleTapped(object? sender, TappedEventArgs e)
    {
        if (_service.ActiveThreadId == 0) return;
        var name = await DisplayPromptAsync("تغییر نام گفتگو", "یک نام کوتاه برای این گفتگو:",
            accept: "ذخیره", cancel: "انصراف", initialValue: _service.ActiveThreadTitle, maxLength: 60);
        if (!string.IsNullOrWhiteSpace(name))
        {
            await _service.RenameThreadAsync(_service.ActiveThreadId, name);
            UpdateThreadHeader();
        }
    }

    private async void OnNewChatTapped(object? sender, TappedEventArgs e)
    {
        _ = UiMotion.PressPopAsync(NewChatBtn);
        UiMotion.TapHaptic();
        DraftStore.Clear();
        await _service.NewThreadAsync();
        ResetTranscript();
        UpdateThreadHeader();
        ScrollToEnd(animate: false);
    }

    private void OnHistoryTapped(object? sender, TappedEventArgs e)
    {
        _ = UiMotion.PressPopAsync(HistoryBtn);
        UiMotion.TapHaptic();
        _marketplace?.Navigate(MarketplaceRoute.History);
    }

    private void OnNewMessagePillTapped(object? sender, TappedEventArgs e)
    {
        _stickToBottom = true;
        NewMessagePill.IsVisible = false;
        ScrollToEnd(animate: true);
    }

    private void UpdateThreadHeader()
    {
        if (!_initialized && _service.ActiveThreadId == 0) { ThreadTitleLabel.Text = UiText.AiName; return; }
        ThreadTitleLabel.Text = string.IsNullOrWhiteSpace(_service.ActiveThreadTitle)
            ? UiText.AiName : _service.ActiveThreadTitle;
    }

    // ────────────────────────── entrance + ambience ──────────────────────────

    private async void EntranceAsync()
    {
        try
        {
            await UiMotion.RiseInAsync(HeaderCard, rise: 18, durationMs: 260);
            await UiMotion.RiseInAsync(ComposerSlot, rise: 16, durationMs: 240);
            StartStatusPulse();
        }
        catch (Exception e) { Debug.WriteLine("entrance: " + e); }
    }

    /// <summary>The connection dot breathes while the page is open; token-bound so
    /// it stops on leave and can be restarted (fresh _cts) when pushed back to.</summary>
    private void StartStatusPulse()
    {
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await StatusDot.FadeToAsync(0.4, 900, Easing.SinInOut);
            await StatusDot.FadeToAsync(1, 900, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });
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
        _composer.SetBusy(state.IsBusy);
        UpdateThreadHeader();

        // empty state is a view — visible only with nothing in the transcript
        EmptyState.IsVisible = state.Messages.Count == 0 && !state.IsBusy;

#if DEBUG
        DevStatus(state);
#endif

        if (state.Error == "SESSION_EXPIRED")
            _ = SignOutToActivationAsync();
        if (state.Error == ChatService.ErrorNoInternet)
        {
            // never wipe the conversation on network loss (§156) — draft is kept
            _ = DisplaySnack(UiText.ErrNetwork);
        }
    }

#if DEBUG
    private void DevStatus(ChatStateChanged state)
    {
        // Compact dev indicator rides the status chip (no viewport-eating banner).
        if (Services.DevFlags.SkipAuth && _marketplace?.Current.IsSignedIn != true)
        {
            QuotaChipLabel.Text = "توسعه";
            StatusDot.Color = (Color)Application.Current!.Resources["Caution"]!;
        }
    }
#endif

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
#if DEBUG
        if (Services.DevFlags.SkipAuth && _marketplace?.Current.IsSignedIn != true) return; // dev chip wins
#endif
        if (quota is null)
        {
            QuotaChipLabel.Text = UiText.QuotaReady;
            return;
        }
        QuotaChipLabel.Text = quota.IsUnlimited
            ? "نامحدود"
            : UiText.QuotaFaDigits($"{quota.Used}/{quota.DailyLimit} امروز");
    }

    // ────────────────────────── reply-keyboard drawer ──────────────────────────

    private void RenderMenu(IReadOnlyList<ChatButton>? menu)
    {
        if (menu is null || menu.Count == 0) return;
        if (ReferenceEquals(_renderedMenu, menu)) return;
        if (_renderedMenu is not null && _renderedMenu.SequenceEqual(menu)) return;
        _renderedMenu = menu;

        MenuChips.Children.Clear();
        foreach (var cb in menu)
        {
            var captured = cb;
            var chip = MakeChip(ActionIcons.CleanLabel(cb.Text),
                () => RunQuietly(() => _service.InvokeActionAsync(captured)), cb);
            MenuChips.Children.Add(chip);
            _ = UiMotion.RiseInAsync(chip, delayMs: (uint)(MenuChips.Children.Count * 40), rise: 8, durationMs: 180);
        }
        MenuStrip.IsVisible = true;
    }

    /// <summary>Shared strip-chip factory: icon + label inside a TapBorder
    /// (44dp floor + press + haptic + semantics). No emoji — vector icons.</summary>
    private Border MakeChip(string text, Func<Task> action, ChatButton? source = null)
    {
        var content = new HorizontalStackLayout { Spacing = 6, VerticalOptions = LayoutOptions.Center };
        if (source is not null)
        {
            var (icon, _) = ActionIcons.For(source);
            content.Children.Add(new Image
            {
                Source = ImageSource.FromFile(icon),
                WidthRequest = 15,
                HeightRequest = 15,
                VerticalOptions = LayoutOptions.Center,
                InputTransparent = true
            });
        }
        content.Children.Add(new Label
        {
            Text = text,
            FontFamily = "VazirmatnMedium",
            FontSize = 12.5,
            VerticalOptions = LayoutOptions.Center,
            InputTransparent = true,
            TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3")
        });
        var chip = new TapBorder
        {
            Style = GetStyle("MenuChip"),
            Content = content
        };
        SemanticProperties.SetDescription(chip, text);
        chip.Tapped += async (_, _) => await action();
        return chip;
    }

    // ────────────────────────── transcript ──────────────────────────

    private const int MaxRenderedRows = 90;
    private int _renderBase; // index in the message list where the rendered window starts

    private void AppendMessages(IReadOnlyList<ChatMessage> messages)
    {
        bool aligned = _renderBase + _renderedIds.Count <= messages.Count;
        if (aligned)
            for (int k = 0; k < _renderedIds.Count; k++)
                if (_renderedIds[k] != messages[_renderBase + k].Id) { aligned = false; break; }
        if (!aligned) ResetTranscript();

        if (_renderedIds.Count == 0 && messages.Count > MaxRenderedRows)
            _renderBase = messages.Count - MaxRenderedRows;

        int pending = messages.Count - (_renderBase + _renderedIds.Count);
        int overflow = _renderedIds.Count + pending - MaxRenderedRows;
        for (int d = 0; d < overflow; d++)
        {
            MessagesStack.Children.RemoveAt(0);
            _renderedIds.RemoveAt(0);
            _renderBase++;
        }

        int first = _renderBase + _renderedIds.Count;
        bool appended = messages.Count > first;
        for (int i = first; i < messages.Count; i++)
        {
            var m = messages[i];
            _renderedIds.Add(m.Id);
            var row = BuildRow(m);
            int insertAt = _typingBubble is null
                ? MessagesStack.Children.Count
                : Math.Max(0, MessagesStack.Children.Count - 1);
            MessagesStack.Children.Insert(insertAt, row);
            _ = AnimateInAsync(row, i - first);
        }

        if (appended)
        {
            if (_stickToBottom)
                ScrollToEnd(animate: true);
            else
                ShowNewMessagePill();
        }
    }

    private void ResetTranscript()
    {
        MessagesStack.Clear();
        _renderedIds.Clear();
        _renderBase = 0;
        _typingBubble = null;
        _typingHint = null;
        _actionedRows.Clear();
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
            bubble.Stroke = new SolidColorBrush((Color)Application.Current!.Resources["Danger"]!);
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

            // subtle per-answer actions (§15): copy only — real, one-tap.
            if (!message.IsFailed && !string.IsNullOrWhiteSpace(message.Text))
                row.Children.Add(BuildAnswerActions(message));
        }

        if (message.Buttons.Count > 0)
            row.Children.Add(BuildButtons(message.Buttons));

        var caption = new Label
        {
            Text = FormatTime(message.CreatedAtMs) + KindBadge(message.Kind),
            Style = GetStyle("Caption"),
            HorizontalOptions = user ? LayoutOptions.Start : LayoutOptions.End
        };
        row.Children.Add(caption);
        return row;
    }

    /// <summary>Copy affordance under an AI answer — a small quiet icon row.</summary>
    private View BuildAnswerActions(ChatMessage message)
    {
        var id = message.Id;
        _actionedRows.Add(id);
        var copy = new TapBorder
        {
            BackgroundColor = Colors.Transparent,
            StrokeThickness = 0,
            Padding = new Thickness(8, 4),
            MinimumHeightRequest = 40,
            HorizontalOptions = LayoutOptions.End,
            Content = new HorizontalStackLayout
            {
                Spacing = 5,
                Children =
                {
                    new Image { Source = ImageSource.FromFile("ic_terms.png"), WidthRequest = 13, HeightRequest = 13, VerticalOptions = LayoutOptions.Center, InputTransparent = true },
                    new Label { Text = UiText.CopyAnswer, FontFamily = "VazirmatnMedium", FontSize = 11.5, VerticalOptions = LayoutOptions.Center, InputTransparent = true,
                                TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3") }
                }
            }
        };
        SemanticProperties.SetDescription(copy, UiText.CopyAnswer);
        var body = message.Text;
        copy.Tapped += async (_, _) =>
        {
            try
            {
                await Clipboard.Default.SetTextAsync(MarkdownToPlainText(body));
                UiMotion.TapHaptic();
                await DisplaySnack(UiText.Copied);
            }
            catch (Exception e) { Debug.WriteLine("copy: " + e.Message); }
        };
        return copy;
    }

    private static string MarkdownToPlainText(string md) => RichBlockRenderer.ToPlainTextStatic(md);

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

    /// <summary>Kind marker in the caption line — plain Persian words, no legacy emoji.</summary>
    private static string KindBadge(MessageKind kind) => kind switch
    {
        MessageKind.Drafting => "  · در حال تنظیم",
        MessageKind.Warning => "  · هشدار",
        MessageKind.Page => "  · منو",
        MessageKind.Action => "  · اقدام",
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
            var (icon, iconOn) = ActionIcons.For(cb);
            bool filled = ActionIcons.IsFilled(cb);
            var b = new Button
            {
                Text = ActionIcons.CleanLabel(cb.Text),
                ImageSource = ImageSource.FromFile(filled ? iconOn : icon),
                Style = GetStyle(ActionIcons.StyleKey(cb)),
                Margin = new Thickness(3),
                MinimumHeightRequest = 44,
                FontFamily = "VazirmatnBold",
                FontSize = 13.5,
                Padding = new Thickness(14, 8)
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

            if (_stickToBottom) ScrollToEnd(animate: true);
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

    private async Task SendTextAsync(string text)
    {
        if (_service.IsBusy) return;
        EmptyState.IsVisible = false;
        _stickToBottom = true;
        NewMessagePill.IsVisible = false;
        DraftStore.Clear();
        var attachment = _pendingAttachment;
        _pendingAttachment = null;
        _composer.HideAttachment();
        if (attachment is not null)
            await RunQuietly(() => _service.SendImageAsync(attachment, text));
        else
            await RunQuietly(() => _service.SendTextAsync(text));
    }

    private async Task OnAttachClickedAsync()
    {
        if (_service.IsBusy) return;
        try
        {
            var image = await _picker.PickDocumentPhotoAsync(1280);
            if (image is null) return;
            _pendingAttachment = image;
            _composer.ShowAttachment("تصویر سند", uploading: false);
            _composer.FocusInput();
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

    private async Task OnMicClickedAsync()
    {
        if (_recording) { await FinishVoiceAsync(cancel: false); return; }
        if (!await _recorder.HasPermissionAsync())
        {
            await DisplayAlertAsync("پیام صوتی", "اجازه‌ی دسترسی به میکروفون داده نشد.", "باشه");
            return;
        }
        try
        {
            await _recorder.StartAsync();
        }
        catch (Exception ex)
        {
            Debug.WriteLine("mic start: " + ex);
            await DisplayAlertAsync("پیام صوتی", "شروع ضبط ممکن نشد.", "باشه");
            return;
        }

        _recording = true;
        _recStopArmed = false;
        _composer.ShowRecording(true);
        _recCts = new CancellationTokenSource();
        _ = RecorderTimerAsync(_recCts.Token);
    }

    private async Task RecorderTimerAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            while (!_recStopArmed && !ct.IsCancellationRequested)
            {
                var t = sw.Elapsed;
                _composer.UpdateRecordingTime(UiText.QuotaFaDigits($"{(int)t.TotalMinutes:00}:{t.Seconds:00}"));
                await Task.Delay(400, ct);
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task FinishVoiceAsync(bool cancel)
    {
        if (!_recording) return;
        _recStopArmed = true;
        _recCts?.Cancel();
        _composer.ShowRecording(false);
        _recording = false;
        try
        {
            if (cancel) { await _recorder.CancelAsync(); return; }
            var clip = await _recorder.StopAndCaptureAsync();
            EmptyState.IsVisible = false;
            _stickToBottom = true;
            await RunQuietly(() => _service.SendVoiceAsync(clip, _composer.Text));
            _composer.Text = string.Empty;
        }
        catch (InvalidOperationException)
        {
            await DisplaySnack("ضبط خیلی کوتاه بود؛ دوباره امتحان کنید.");
        }
        catch (Exception ex)
        {
            Debug.WriteLine("voice send: " + ex);
            await DisplaySnack(UiText.ErrServerUnreachable);
        }
    }

    /// <summary>Called by the recording-strip cancel (host wiring).</summary>
    public void CancelRecording() => _ = FinishVoiceAsync(cancel: true);

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

        // V1: the coordinator owns sign-out + routing (clears both vaults and lands
        // on Auth). Without it, the pre-marketplace behaviour is preserved exactly.
        if (_marketplace is not null)
        {
            await _marketplace.SignOutAsync(toAuthScreen: true);
            return;
        }

        await _gate.SignOutAsync();
        MainThread.BeginInvokeOnMainThread(() =>
        {
            var app = Application.Current;
            if (app is not null && app.Windows.Count > 0)
                app.Windows[0].Page = new NavigationPage(MauiProgram.Services.GetRequiredService<ActivationPage>());
        });
    }

    // ────────────────────────── scroll discipline ──────────────────────────

    private void OnScrolled(object? sender, ScrolledEventArgs e)
    {
        if (_programmaticScroll) { _lastScrollY = e.ScrollY; return; }
        double delta = _lastScrollY - e.ScrollY;
        _lastScrollY = e.ScrollY;
        double bottom = Math.Max(0, MessagesStack.Height - MessagesScroll.Height);
        // scrolled meaningfully up away from the bottom → stop sticking (§328)
        if (delta > 24 && e.ScrollY < bottom - 40)
        {
            _stickToBottom = false;
        }
        else if (e.ScrollY >= bottom - 40)
        {
            _stickToBottom = true;
            if (_pendingNewMessage) { _pendingNewMessage = false; NewMessagePill.IsVisible = false; }
        }
    }

    private void ShowNewMessagePill()
    {
        _pendingNewMessage = true;
        NewMessagePill.IsVisible = true;
        _ = NewMessagePill.FadeToAsync(1, 160);
    }

    private void ScrollToEnd(bool animate)
    {
        if (MessagesStack.Children.Count == 0) return;
        if (MessagesStack.Children[^1] is not Element last) return;
        _programmaticScroll = true;
        _ = ScrollClearFlagAsync(last, animate);
    }

    private async Task ScrollClearFlagAsync(Element last, bool animate)
    {
        try { await MessagesScroll.ScrollToAsync(last, ScrollToPosition.End, animate); }
        catch (Exception e) { Debug.WriteLine("scroll: " + e.Message); }
        // let the animated settle finish before the next user-scroll is trusted
        await Task.Delay(animate ? 340 : 80);
        _programmaticScroll = false;
    }

    private static async Task AnimateInAsync(View row, int stagger)
    {
        row.Opacity = 0;
        row.TranslationY = 14;
        await Task.Delay(Math.Min(stagger, 5) * 45);
        await row.FadeToAsync(1, 240, Easing.CubicOut);
        await row.TranslateToAsync(0, 0, 280, Easing.SpringOut);
    }

    private async Task DisplaySnack(string message)
    {
        try { await DisplayAlertAsync("", message, "باشه"); }
        catch (Exception e) { Debug.WriteLine("snack: " + e.Message); }
    }

    // ────────────────────────── helpers ──────────────────────────

    private static Style GetStyle(string key)
    {
        var resources = Application.Current!.Resources;
        if (resources.TryGetValue(key, out var value) && value is Style style)
            return style;
        throw new InvalidOperationException("missing app style: " + key);
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts.Cancel(); // status pulse + typing dots stop with the page
        if (_recording) _ = FinishVoiceAsync(cancel: true);
        _detachedOnLeave = true;
        _service.Changed -= OnStateChanged;
    }

    private bool _detachedOnLeave;

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
