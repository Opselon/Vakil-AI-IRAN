namespace Vakil_AI_IRAN.Controls;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — The app's bottom navigation bar (دفتر وکیل / وکلا / مشاوره‌ها /
//             حساب): the standard one-handed mobile home surface. Vector tab
//             icons (active/idle pair), Persian captions, haptic + slide
//             feedback, thumb-zone placement, and — importantly — it HIDES
//             while the on-screen keyboard is open (SetKeyboardOpen) so the
//             composer keeps the whole bottom zone to itself.
// OWNER     — coordinator (HD redesign).
// CONSUMES  — IMarketplaceCoordinator via events only (the host page wires
//             TabSelected to navigation; this control never swaps pages).
// PROVIDES  — BottomTabBar with `Active` (TabKey) + `TabSelected` event.
// INVARIANTS— Pure-code control (no XAML), 44dp+ targets, all colors read the
//             live theme at build time and repaint on ApplyTheme().
// EXTEND    — a new tab = one TabSpec line + one route mapping in the host page.
// ═══════════════════════════════════════════════════════════════════════════

using VakilAI.Application.Contracts;
using Vakil_AI_IRAN.Rendering;

public enum TabKey { Chat, Lawyers, Consultations, Account }

public sealed class BottomTabBar : Border
{
    private sealed record TabSpec(TabKey Key, string Label, string IconActive, string IconIdle);

    private static readonly TabSpec[] Specs =
    {
        new(TabKey.Chat,          "دفتر وکیل",  "ic_tab_home_active.png",     "ic_tab_home_idle.png"),
        new(TabKey.Lawyers,       "وکلا",       "ic_tab_lawyers_active.png",  "ic_tab_lawyers_idle.png"),
        new(TabKey.Consultations, "مشاوره‌ها",  "ic_tab_consults_active.png", "ic_tab_consults_idle.png"),
        new(TabKey.Account,       "حساب",       "ic_tab_account_active.png",  "ic_tab_account_idle.png"),
    };

    private readonly Grid _row;
    private TabKey _active;

    /// <summary>Raised when a tab is selected (fires for the active tab too — hosts decide).</summary>
    public event Action<TabKey>? TabSelected;

    public BottomTabBar()
    {
        // Surface distinct from the page ground, hairline above, no shadow
        // (shadows cost per-frame blur on Android near the live composer).
        StrokeThickness = 1;
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle
        {
            CornerRadius = new CornerRadius(24, 24, 0, 0)
        };
        Padding = new Thickness(6, 6, 6, 10);

        _row = new Grid { ColumnSpacing = 2 };
        for (int i = 0; i < Specs.Length; i++)
            _row.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
        Content = _row;

        BuildTabs();
        ApplyTheme();
    }

    /// <summary>Host calls this when the signed-in identity changes role/kind.</summary>
    public TabKey Active
    {
        get => _active;
        set { if (_active != value) { _active = value; Repaint(); } }
    }

    /// <summary>Keyboard visibility: the bar collapses while the IME is up.</summary>
    public void SetKeyboardOpen(bool open)
    {
        IsVisible = !open;
    }

    private void BuildTabs()
    {
        _row.Children.Clear();
        for (int i = 0; i < Specs.Length; i++)
        {
            var spec = Specs[i];
            var icon = new Image
            {
                Source = ImageSource.FromFile(spec.IconActive),
                WidthRequest = 23,
                HeightRequest = 23,
                HorizontalOptions = LayoutOptions.Center,
                InputTransparent = true
            };
            var label = new Label
            {
                Text = spec.Label,
                FontFamily = "VazirmatnMedium",
                FontSize = 10.5,
                HorizontalTextAlignment = TextAlignment.Center,
                InputTransparent = true
            };
            var cell = new VerticalStackLayout
            {
                Spacing = 3,
                Padding = new Thickness(0, 7, 0, 5),
                VerticalOptions = LayoutOptions.Center,
                Children = { icon, label }
            };
            var tab = new TapBorder
            {
                BackgroundColor = Colors.Transparent,
                StrokeThickness = 0,
                Content = cell,
                VerticalOptions = LayoutOptions.Fill
            };
            SemanticProperties.SetDescription(tab, spec.Label);
            int idx = i;
            tab.Tapped += (_, _) =>
            {
                Active = spec.Key;
                TabSelected?.Invoke(spec.Key);
            };
            _row.Children.Add(tab);
            Grid.SetColumn(tab, idx);
        }
        Repaint();
    }

    private void Repaint()
    {
        var activeInk = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#4F46E5");
        var idleInk = Palette.IsDark ? Color.Parse("#8CA3C7") : Color.Parse("#5B6B82");

        for (int i = 0; i < Specs.Length && i < _row.Children.Count; i++)
        {
            var spec = Specs[i];
            bool on = spec.Key == _active;
            if (_row.Children[i] is TapBorder tab && tab.Content is VerticalStackLayout cell
                && cell.Children.Count >= 2)
            {
                if (cell.Children[0] is Image img)
                    img.Source = ImageSource.FromFile(on ? spec.IconActive : spec.IconIdle);
                if (cell.Children[1] is Label lbl)
                {
                    lbl.TextColor = on ? activeInk : idleInk;
                    lbl.FontFamily = on ? "VazirmatnBold" : "VazirmatnMedium";
                }
                tab.Scale = on ? 1 : 0.94;
            }
        }
    }

    /// <summary>Re-read the palette after an OS theme flip (hosts call from RequestedThemeChanged).</summary>
    public void ApplyTheme()
    {
        BackgroundColor = Palette.IsDark ? Color.Parse("#0E1728") : Color.Parse("#FFFFFF");
        Stroke = new SolidColorBrush(Palette.Hairline);
        Repaint();
    }
}
