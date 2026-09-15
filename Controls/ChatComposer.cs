using Vakil_AI_IRAN.Rendering;

namespace Vakil_AI_IRAN.Controls;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — THE product component (§6/06): one shared AI chat composer used
//             by every conversational surface (Chat, ConsultChat). Purpose is
//             singular — ASK — so nothing navigational lives inside it (§9).
// LAYOUT    — [attach ○] [ auto-growing input — the visual star ] [mic ○]
//             [send disc → stop square while generating]. A recording strip
//             and an attachment chip row render above the field when active.
// BEHAVIOR  — send fires on Enter only with text present; busy swaps send→stop
//             (working cancellation, §426); mic visibility follows
//             IAudioRecorder.IsAvailable (never fake the capability); hosts get
//             FocusChanged to collapse chrome (tab bars) while the IME is up;
//             keyboard-safe (§8): never covered, never jumping — hosts keep the
//             control in the bottom grid row and Android runs adjustResize.
// OWNER     — coordinator (premium rebuild). Pure code — no XAML partials.
// ═══════════════════════════════════════════════════════════════════════════

public sealed class ChatComposer : Border
{
    private readonly Editor _input;
    private readonly TapBorder _attachBtn, _micBtn, _sendBtn;
    private readonly Image _sendIcon, _attachIcon, _micIcon;
    private readonly Grid _fieldRow;
    private readonly VerticalStackLayout _root;
    private readonly HorizontalStackLayout _recordingRow, _attachmentRow;
    private readonly Border _recPill;
    private readonly Label _recTimer, _recHint, _attachChipLabel;
    private readonly ActivityIndicator _attachSpinner;

    /// <summary>Non-empty trimmed text the user committed (send tap / Enter).</summary>
    public event Action<string>? SendRequested;

    /// <summary>Stop square tapped while busy — host cancels the generation.</summary>
    public event Action? StopRequested;

    /// <summary>Attach circle tapped — host opens its source sheet.</summary>
    public event Action? AttachRequested;

    /// <summary>Mic circle tapped — host runs the record flow (only fires when visible).</summary>
    public event Action? MicRequested;

    /// <summary>IME opened/closed around the composer — hosts collapse tab bars etc.</summary>
    public event Action<bool>? KeyboardVisibilityChanged;

    /// <summary>Live text changes (draft persistence hooks).</summary>
    public event Action<string>? TextChangedLive;

    public string Text
    {
        get => _input.Text?.Trim() ?? string.Empty;
        set { _input.Text = value; }
    }

    /// <summary>Contextual placeholder (locked-room copy, focus hints).</summary>
    public string Placeholder
    {
        get => _input.Placeholder;
        set => _input.Placeholder = value;
    }

    public bool InputEnabled
    {
        get => _input.IsEnabled;
        set
        {
            _input.IsEnabled = value;
            _attachBtn.IsEnabled = value;
            _micBtn.IsEnabled = value;
            _sendBtn.IsEnabled = value || _busy; // while busy it remains the stop button
        }
    }

    public ChatComposer(bool showAttach = true, bool showMic = true, string placeholder = "سوال حقوقی خود را بنویسید…")
    {
        Style = (Style)Application.Current!.Resources["ComposerBar"];

        _input = new Editor
        {
            Style = (Style)Application.Current.Resources["ComposerEditor"],
            Placeholder = placeholder
        };
        _input.TextChanged += (_, e) =>
        {
            TextChangedLive?.Invoke(e.NewTextValue ?? string.Empty);
            // Enter-as-send stays on the mobile chat convention; Editor's Completed
            // is unreliable, so newline paste only triggers send from a lone \n.
            if (e.NewTextValue == "\n") { _input.Text = string.Empty; TrySend(); }
        };
        _input.Completed += (_, _) => TrySend();
        _input.Focused += (_, _) => KeyboardVisibilityChanged?.Invoke(true);
        _input.Unfocused += (_, _) => KeyboardVisibilityChanged?.Invoke(false);

        _attachIcon = ThemedIcon("ic_attach_light.png", "ic_attach_dark.png");
        _attachBtn = CircleButton(_attachIcon, UiText.AttachImage, () => AttachRequested?.Invoke());

        _micIcon = ThemedIcon("ic_mic_light.png", "ic_mic_dark.png");
        _micBtn = CircleButton(_micIcon, UiText.VoiceMessage, () => MicRequested?.Invoke());
        _micBtn.IsVisible = showMic;

        _sendIcon = new Image
        {
            Source = ImageSource.FromFile("ic_send.png"),
            WidthRequest = 20,
            HeightRequest = 20,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
            InputTransparent = true
        };
        _sendBtn = new TapBorder
        {
            Style = (Style)Application.Current.Resources["SendCircle"],
            Content = _sendIcon,
            VerticalOptions = LayoutOptions.End
        };
        SemanticProperties.SetDescription(_sendBtn, UiText.Send);
        _sendBtn.Tapped += (_, _) =>
        {
            if (_busy) { StopRequested?.Invoke(); SetStopVisual(true); return; }
            TrySend();
        };

        var inputPlate = new Border
        {
            Style = (Style)Application.Current.Resources["EntryCard"],
            BackgroundColor = Palette.IsDark
                ? Color.Parse("#141F33")   // SurfaceElevatedDark
                : Color.Parse("#F4F6FB"),  // ComposerLight
            Padding = new Thickness(10, 2),
            Content = _input
        };

        _fieldRow = new Grid
        {
            ColumnDefinitions =
            {
                new ColumnDefinition(GridLength.Auto),
                new ColumnDefinition(GridLength.Star),
                new ColumnDefinition(GridLength.Auto),
                new ColumnDefinition(GridLength.Auto)
            },
            ColumnSpacing = 8
        };
        _fieldRow.Children.Add(_attachBtn);
        _fieldRow.Children.Add(inputPlate);
        _fieldRow.Children.Add(_micBtn);
        _fieldRow.Children.Add(_sendBtn);
        Grid.SetColumn(inputPlate, 1);
        Grid.SetColumn(_micBtn, 2);
        Grid.SetColumn(_sendBtn, 3);
        if (!showAttach) _attachBtn.IsVisible = false;

        // recording strip (§151): state + duration + send/cancel, no hidden gestures
        _recTimer = new Label
        {
            Text = "۰۰:۰۰",
            FontFamily = "VazirmatnMedium",
            FontSize = 13,
            TextColor = Color.Parse("#FFFFFF"),
            VerticalOptions = LayoutOptions.Center
        };
        _recPill = new Border
        {
            BackgroundColor = (Color)Application.Current.Resources["Danger"]!,
            StrokeThickness = 0,
            Padding = new Thickness(12, 6),
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 14 },
            Content = new HorizontalStackLayout
            {
                Spacing = 8,
                Children =
                {
                    new BoxView { Color = Colors.White, WidthRequest = 10, HeightRequest = 10, CornerRadius = 5, VerticalOptions = LayoutOptions.Center },
                    _recTimer
                }
            }
        };
        _recHint = new Label { Text = UiText.RecordingHint, Style = (Style)Application.Current.Resources["Caption"], VerticalOptions = LayoutOptions.Center };
        var recCancel = new TapBorder
        {
            BackgroundColor = Colors.Transparent,
            StrokeThickness = 0,
            Padding = new Thickness(10, 4),
            Content = new Label
            {
                Text = "لغو",
                FontFamily = "VazirmatnMedium",
                FontSize = 12.5,
                TextColor = (Color)Application.Current.Resources["DangerInkDark"]!,
                VerticalOptions = LayoutOptions.Center,
                InputTransparent = true
            }
        };
        SemanticProperties.SetDescription(recCancel, "لغو ضبط");
        recCancel.Tapped += (_, _) => RecordingCancelRequested?.Invoke();
        _recordingRow = new HorizontalStackLayout { Spacing = 6, IsVisible = false, Children = { _recPill, _recHint, recCancel } };

        // attachment chip (image only until the backend takes more — honest):
        // filename + spinner + remove; retry surfaces as the host re-showing it.
        _attachSpinner = new ActivityIndicator
        {
            IsRunning = true,
            IsVisible = false,
            WidthRequest = 16,
            HeightRequest = 16,
            Color = Palette.Accent,
            VerticalOptions = LayoutOptions.Center
        };
        _attachChipLabel = new Label
        {
            FontFamily = "VazirmatnMedium",
            FontSize = 12,
            TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3"),
            VerticalOptions = LayoutOptions.Center,
            LineBreakMode = LineBreakMode.TailTruncation,
            MaxLines = 1
        };
        var removeChip = new Label
        {
            Text = "حذف",
            FontFamily = "VazirmatnMedium",
            FontSize = 12,
            TextColor = (Color)Application.Current.Resources["DangerInkDark"]!,
            VerticalOptions = LayoutOptions.Center,
            InputTransparent = true
        };
        var removeBtn = new TapBorder
        {
            BackgroundColor = Colors.Transparent,
            StrokeThickness = 0,
            Padding = new Thickness(8, 2),
            MinimumHeightRequest = 32,
            Content = removeChip
        };
        SemanticProperties.SetDescription(removeBtn, UiText.RemoveAttachment);
        removeBtn.Tapped += (_, _) => AttachmentRemoveRequested?.Invoke();
        _attachmentRow = new HorizontalStackLayout
        {
            Spacing = 6,
            IsVisible = false,
            Padding = new Thickness(2, 0, 2, 2),
            Children = { _attachSpinner, _attachChipLabel, removeBtn }
        };

        _root = new VerticalStackLayout { Spacing = 8, Children = { _attachmentRow, _recordingRow, _fieldRow } };
        Content = _root;
    }

    /// <summary>Host removes the pending attachment (or the chip is stale).</summary>
    public event Action? AttachmentRemoveRequested;

    /// <summary>"لغو" on the recording strip — host discards the take.</summary>
    public event Action? RecordingCancelRequested;

    private bool _busy;
    private bool _stopVisual;

    private TapBorder CircleButton(Image icon, string semantic, Action onClick)
    {
        var b = new TapBorder
        {
            Style = (Style)Application.Current!.Resources["IconCircle"]!,
            VerticalOptions = LayoutOptions.End,
            Content = icon
        };
        SemanticProperties.SetDescription(b, semantic);
        b.Tapped += (_, _) => onClick();
        return b;
    }

    private static Image ThemedIcon(string light, string dark)
    {
        var img = new Image
        {
            WidthRequest = 21,
            HeightRequest = 21,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
            Source = ImageSource.FromFile(Palette.IsDark ? dark : light),
            InputTransparent = true
        };
        return img;
    }

    /// <summary>Re-read palette-dependent parts after an OS theme flip (hosts forward
    /// RequestedThemeChanged here).</summary>
    public void ApplyTheme()
    {
        _attachIcon.Source = ImageSource.FromFile(Palette.IsDark ? "ic_attach_dark.png" : "ic_attach_light.png");
        _micIcon.Source = ImageSource.FromFile(Palette.IsDark ? "ic_mic_dark.png" : "ic_mic_light.png");
        _attachChipLabel.TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3");
        _attachSpinner.Color = Palette.Accent;
    }

    // ────────────────────────── states ──────────────────────────

    public void SetBusy(bool busy)
    {
        _busy = busy;
        _input.IsEnabled = !busy;
        // The send disc stays live while busy — it IS the stop button then (§426).
        if (!busy) SetStopVisual(false);
    }

    private void SetStopVisual(bool stop)
    {
        if (_stopVisual == stop) return;
        _stopVisual = stop;
        SemanticProperties.SetDescription(_sendBtn, stop ? UiText.StopGenerating : UiText.Send);
        _ = _sendIcon.FadeToAsync(0, 90).ContinueWith(_ =>
        {
            _sendIcon.Source = ImageSource.FromFile(stop ? "ic_stop.png" : "ic_send.png");
            _ = _sendIcon.FadeToAsync(1, 120);
        });
    }

    public void SetMicVisible(bool visible) => _micBtn.IsVisible = visible;

    // ────────────────────────── recording ──────────────────────────

    public void ShowRecording(bool on) => _recordingRow.IsVisible = on;

    public void UpdateRecordingTime(string persianMmSs) => _recTimer.Text = persianMmSs;

    // ────────────────────────── attachment chip ──────────────────────────

    public void ShowAttachment(string fileName, bool uploading)
    {
        _attachmentRow.IsVisible = true;
        _attachChipLabel.Text = fileName;
        _attachSpinner.IsVisible = uploading;
    }

    public void HideAttachment() => _attachmentRow.IsVisible = false;

    // ────────────────────────── focus ──────────────────────────

    /// <summary>Ask the platform to focus the input (opens the IME). Best-effort:
    /// MAUI's Focus() may refuse while the page is still attaching — hosts retry
    /// once after a short delay when the tap came from a not-yet-shown page.</summary>
    public bool FocusInput() => _input.Focus();

    private void TrySend()
    {
        var text = Text;
        if (text.Length == 0 || _busy) return;
        _input.Text = string.Empty;
        _ = UiMotion.PressPopAsync(_sendBtn);
        UiMotion.TapHaptic();
        SendRequested?.Invoke(text);
    }
}
