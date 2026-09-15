using System.Windows.Input;
using Microsoft.Maui.Controls;

namespace Vakil_AI_IRAN.Controls;

/// <summary>
/// A Border that IS a button: 44dp touch floor (Android/iOS guideline), press-pop
/// + haptics, 350ms double-tap debounce, and — critically — child views are made
/// InputTransparent so the whole surface (not an inner label) receives the tap.
/// Without this, a Border whose content is a Label let the LABEL swallow the
/// gesture (the classic "tap the edge, nothing happens" bug), and screen
/// readers announced nothing. Prefer this over Border+TapGestureRecognizer
/// everywhere; use Command/Tapped exactly like a Button.
/// </summary>
public class TapBorder : Border
{
    /// <summary>Raised after the press feedback started and the bound Command ran.
    /// EventHandler&lt;TappedEventArgs&gt; so pages reuse their existing
    /// (object?, TappedEventArgs) handlers unchanged.</summary>
    public event EventHandler<TappedEventArgs>? Tapped;

    /// <summary>Seconds of silence before a second tap is accepted (anti double-fire).</summary>
    public double DebounceSeconds { get; set; } = 0.35;

    /// <summary>Light selection haptic on each accepted tap (best effort).</summary>
    public bool EnableHaptics { get; set; } = true;

    /// <summary>Fires only when Command can execute; keeps the pop animation even when disabled.</summary>
    public static readonly BindableProperty CommandProperty = BindableProperty.Create(
        nameof(Command), typeof(ICommand), typeof(TapBorder));

    public ICommand? Command
    {
        get => (ICommand?)GetValue(CommandProperty);
        set => SetValue(CommandProperty, value);
    }

    public static readonly BindableProperty CommandParameterProperty = BindableProperty.Create(
        nameof(CommandParameter), typeof(object), typeof(TapBorder));

    public object? CommandParameter
    {
        get => GetValue(CommandParameterProperty);
        set => SetValue(CommandParameterProperty, value);
    }

    private DateTime _lastTap = DateTime.MinValue;

    public TapBorder()
    {
        // Touch floor is a HARD minimum, not a style hint (mobile medium rule).
        MinimumHeightRequest = 44;
        MinimumWidthRequest = 44;

        var tap = new TapGestureRecognizer { NumberOfTapsRequired = 1 };
        tap.Tapped += OnInternalTapped;
        GestureRecognizers.Add(tap);

        // Children (Label/Image/…) would otherwise eat the gesture: route all
        // pointer input to this border instead. Re-applied on every Content swap.
        PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == ContentProperty.PropertyName) NeutralizeChildren();
        };
        Loaded += (_, _) => NeutralizeChildren();
    }

    /// <summary>Marks every child view InputTransparent (never this border).
    /// One level deep is enough — grids/stacks inside a chip surface pass the
    /// hit-test to their own children, but with the direct child transparent
    /// and the border itself handling the tap, the whole surface is reliable.</summary>
    private void NeutralizeChildren()
    {
        if (Content is not View v) return;
        v.InputTransparent = true;
        if (v is Layout l)
            foreach (var c in l.Children)
                if (c is View cv) cv.InputTransparent = true;
    }

    private void OnInternalTapped(object? sender, TappedEventArgs e)
    {
        // Button semantics: a disabled control ignores taps (pages toggle
        // IsEnabled for busy states; a raw Border+tap would not honor that).
        if (!IsEnabled) return;

        var now = DateTime.UtcNow;
        if ((now - _lastTap).TotalSeconds < DebounceSeconds) return;
        _lastTap = now;

        _ = UiMotion.PressPopAsync(this);
        if (EnableHaptics) UiMotion.TapHaptic();

        var cmd = Command;
        if (cmd?.CanExecute(CommandParameter) == true)
        {
            try { cmd.Execute(CommandParameter); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("TapBorder command: " + ex); }
        }
        Tapped?.Invoke(this, new TappedEventArgs(null));
    }
}
