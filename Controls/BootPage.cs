using System.Diagnostics;

namespace Vakil_AI_IRAN.Controls;

/// <summary>
/// The dark boot/splash page shown while the stored session is read. Carries the
/// brand emblem with a breathing gold halo and a shimmer sweep. All loops are
/// cancellation-bound — nothing animates after the page is replaced.
/// </summary>
public sealed class BootPage : ContentPage
{
    private readonly CancellationTokenSource _cts = new();
    private readonly Border _halo;
    private readonly Border _shimmer;
    private readonly Border _emblem;
    private readonly Label _title;
    private readonly ActivityIndicator _spinner;

    public BootPage()
    {
        BackgroundColor = Color.Parse("#0B1220");
        FlowDirection = FlowDirection.RightToLeft;

        _emblem = new Border
        {
            WidthRequest = 108,
            HeightRequest = 108,
            BackgroundColor = Colors.Transparent,
            Stroke = new SolidColorBrush(Color.Parse("#2ED4AF37")),
            StrokeThickness = 1,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 32 },
            HorizontalOptions = LayoutOptions.Center,
            Content = new Image
            {
                Source = "ic_emblem.png",
                WidthRequest = 58,
                HeightRequest = 58,
                HorizontalOptions = LayoutOptions.Center,
                VerticalOptions = LayoutOptions.Center
            }
        };
        SemanticProperties.SetDescription(_emblem, "نشان وکیل هوشمند ایران");

        _halo = new Border
        {
            WidthRequest = 190,
            HeightRequest = 190,
            Background = (Brush)Application.Current!.Resources["AuroraGoldBrush"],
            StrokeThickness = 0,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 95 },
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
            InputTransparent = true
        };

        _shimmer = new Border
        {
            WidthRequest = 46,
            HeightRequest = 108,
            Background = (Brush)Application.Current!.Resources["ShimmerBrush"],
            StrokeThickness = 0,
            Rotation = 18,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
            InputTransparent = true
        };

        _title = new Label
        {
            Text = "وکیل هوشمند ایران",
            FontFamily = "VazirmatnBold",
            FontSize = 19,
            TextColor = Color.Parse("#E6EDF7"),
            HorizontalTextAlignment = TextAlignment.Center
        };

        _spinner = new ActivityIndicator
        {
            IsRunning = true,
            Color = Color.Parse("#6366F1"),
            HorizontalOptions = LayoutOptions.Center
        };

        var emblemStack = new Grid
        {
            WidthRequest = 108,
            HeightRequest = 108,
            HorizontalOptions = LayoutOptions.Center,
            // keeps the shimmer sweep inside the rounded emblem silhouette
            Clip = new Microsoft.Maui.Controls.Shapes.RectangleGeometry { Rect = new Rect(0, 0, 108, 108) }
        };
        emblemStack.Children.Add(_emblem);
        emblemStack.Children.Add(_shimmer);

        Content = new Grid
        {
            Children =
            {
                // ambient aurora behind everything
                new Border
                {
                    WidthRequest = 340,
                    HeightRequest = 340,
                    Background = (Brush)Application.Current!.Resources["AuroraIndigoBrush"],
                    StrokeThickness = 0,
                    StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 170 },
                    HorizontalOptions = LayoutOptions.Start,
                    VerticalOptions = LayoutOptions.Start,
                    TranslationX = -90,
                    TranslationY = -70,
                    InputTransparent = true
                },
                new Border
                {
                    WidthRequest = 300,
                    HeightRequest = 300,
                    Background = (Brush)Application.Current!.Resources["AuroraVioletBrush"],
                    StrokeThickness = 0,
                    StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 150 },
                    HorizontalOptions = LayoutOptions.End,
                    VerticalOptions = LayoutOptions.End,
                    TranslationX = 80,
                    TranslationY = 60,
                    InputTransparent = true
                },
                _halo,
                new VerticalStackLayout
                {
                    VerticalOptions = LayoutOptions.Center,
                    HorizontalOptions = LayoutOptions.Center,
                    Spacing = 20,
                    Padding = 28,
                    Children =
                    {
                        emblemStack,
                        new VerticalStackLayout
                        {
                            Spacing = 4,
                            Children =
                            {
                                _title,
                                new Label
                                {
                                    Text = "در حال آماده‌سازی دفتر وکیل…",
                                    Style = (Style)Application.Current!.Resources["Caption"],
                                    HorizontalTextAlignment = TextAlignment.Center
                                }
                            }
                        },
                        _spinner
                    }
                }
            }
        };

        Loaded += (_, _) => StartAmbience();
    }

    private void StartAmbience()
    {
        // halo breathes, emblem floats, shimmer sweeps — all bound to _cts
        UiMotion.Loop(_cts.Token, async ct =>
        {
            await _halo.ScaleToAsync(1.12, 1600, Easing.SinInOut);
            await _halo.ScaleToAsync(1, 1600, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });

        UiMotion.Loop(_cts.Token, async ct =>
        {
            await _emblem.TranslateToAsync(0, -5, 1400, Easing.SinInOut);
            await _emblem.TranslateToAsync(0, 0, 1400, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });

        UiMotion.Loop(_cts.Token, async ct =>
        {
            _shimmer.TranslationX = -90;
            _shimmer.Opacity = 0;
            await _shimmer.FadeToAsync(0.9, 220);
            await _shimmer.TranslateToAsync(90, 0, 1500, Easing.SinInOut);
            await _shimmer.FadeToAsync(0, 260);
            await UiMotion.SleepAsync(700, ct);
        });

        _ = UiMotion.RiseInAsync(_title, delayMs: 260);
    }

    protected override bool OnBackButtonPressed()
    {
        _cts.Cancel();
        return base.OnBackButtonPressed();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _cts.Cancel();
        _cts.Dispose();
    }
}
