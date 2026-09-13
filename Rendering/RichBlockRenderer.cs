using VakilAI.Application.RichText;
using VakilAI.Domain.Entities;

namespace Vakil_AI_IRAN.Rendering;

/// <summary>
/// Resolves design tokens for the CURRENT app theme at control-build time.
/// Color-typed reads only — never hands a SolidColorBrush to a Color property.
/// </summary>
internal static class Palette
{
    public static bool IsDark => Application.Current?.RequestedTheme == AppTheme.Dark;

    public static Color Ink => Get("InkDark", "InkLight");
    public static Color Muted => Get("InkMuted", "InkMutedLight");
    public static Color Accent => IsDark ? FromHex("#818CF8") : FromHex("#4F46E5");
    public static Color QuoteFill => IsDark ? FromHex("#131F33") : FromHex("#EEF2FA");
    public static Color QuoteBar => IsDark ? FromHex("#818CF8") : FromHex("#6366F1");
    public static Color CodeBack => IsDark ? FromHex("#0D1117") : FromHex("#0D1117");
    public static Color CodeInk => FromHex("#A5D6FF");
    public static Color ThinkingBack => IsDark ? FromHex("#0E1728") : FromHex("#F4F6FB");
    public static Color ThinkingStroke => IsDark ? FromHex("#27395C") : FromHex("#CBD5E1");
    public static Color HeadingInk => IsDark ? FromHex("#A5B4FC") : FromHex("#4338CA");
    public static Color Hairline => Get("HairlineDark", "HairlineLight");

    private static Color Get(string darkKey, string lightKey) =>
        Resolve(IsDark ? darkKey : lightKey) ?? FromHex(IsDark ? "#E6EDF7" : "#0B1220");

    private static Color? Resolve(string key)
    {
        if (Application.Current?.Resources.TryGetValue(key, out var v) == true && v is Color c)
            return c;
        return null;
    }

    private static Color FromHex(string hex) => Color.Parse(hex);
}

/// <summary>
/// Turns the RenderBlock tree produced by <see cref="RichTextParser"/> into a native
/// vertical stack of MAUI controls — headings, RTL quotes with a gradient side bar,
/// code panels, bulleted/numbered lists and inline-styled paragraphs (bold/italic/mono/strike).
/// The whole tree inherits the page FlowDirection, so bidi text lands correctly.
/// Colors follow the live app theme through <see cref="Palette"/>.
/// </summary>
public static class RichBlockRenderer
{
    private const string TextFamily = "VazirmatnRegular";

    public static View Build(ChatMessage message)
    {
        var stack = new VerticalStackLayout { Spacing = 8 };
        var blocks = RichTextParser.Parse(message.Text, message.Format);

        if (blocks.Count == 0)
        {
            stack.Children.Add(Body(message.Text ?? string.Empty));
            return stack;
        }

        foreach (var block in blocks)
            stack.Children.Add(BuildBlock(block));

        if (message.ThinkingFrames.Count > 0)
            stack.Children.Add(ThinkingLog(message.ThinkingFrames));

        return stack;
    }

    private static View BuildBlock(RenderBlock block) => block switch
    {
        HeadingBlock h => Heading(h.Title),
        QuoteBlock q => Quote(q.Text),
        CodeBlock c => Code(c.Text),
        ListBlock l => List(l),
        ParagraphBlock p => Paragraph(p),
        _ => Body(string.Empty)
    };

    private static View ThinkingLog(IReadOnlyList<string> frames)
    {
        // "🧠 تحلیل" caption + the frame chain rendered as animated-feel step chips
        var chips = new HorizontalStackLayout { Spacing = 5 };
        foreach (var f in frames.TakeLast(6))
        {
            chips.Children.Add(new Border
            {
                BackgroundColor = Palette.QuoteFill,
                Stroke = new SolidColorBrush(Palette.ThinkingStroke),
                StrokeThickness = 1,
                Padding = new Thickness(8, 3),
                StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 10 },
                Content = new Label
                {
                    Text = f,
                    FontFamily = TextFamily,
                    FontSize = 10.5,
                    TextColor = Palette.Muted
                }
            });
        }

        return new Border
        {
            BackgroundColor = Palette.ThinkingBack,
            Stroke = new SolidColorBrush(Palette.ThinkingStroke),
            StrokeThickness = 1,
            Padding = new Thickness(10, 7),
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
            Content = new VerticalStackLayout
            {
                Spacing = 5,
                Children =
                {
                    new Label
                    {
                        Text = "🧠 مراحل تحلیل",
                        FontFamily = "VazirmatnMedium",
                        FontSize = 11,
                        TextColor = Palette.Accent
                    },
                    new ScrollView
                    {
                        Orientation = ScrollOrientation.Horizontal,
                        HorizontalScrollBarVisibility = ScrollBarVisibility.Never,
                        Content = chips
                    }
                }
            }
        };
    }

    private static View Heading(string title)
    {
        // accent rule + bold title, like a modern legal doc header
        var row = new HorizontalStackLayout { Spacing = 8 };
        row.Children.Add(new BoxView
        {
            Color = Palette.Accent,
            WidthRequest = 4,
            HeightRequest = 18,
            CornerRadius = 2,
            VerticalOptions = LayoutOptions.Center
        });
        row.Children.Add(new Label
        {
            Text = title,
            FontFamily = "VazirmatnBold",
            FontSize = 17,
            TextColor = Palette.HeadingInk,
            LineBreakMode = LineBreakMode.WordWrap,
            VerticalOptions = LayoutOptions.Center
        });
        return row;
    }

    private static Border Quote(string text) => new()
    {
        BackgroundColor = Palette.QuoteFill,
        StrokeThickness = 0,
        Padding = new Thickness(12, 8, 12, 8),
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
        Content = new HorizontalStackLayout
        {
            Spacing = 10,
            Children =
            {
                new BoxView
                {
                    Color = Palette.QuoteBar,
                    WidthRequest = 3.5,
                    CornerRadius = 2,
                    VerticalOptions = LayoutOptions.Fill
                },
                new Label
                {
                    Text = text,
                    FontFamily = TextFamily,
                    FontAttributes = FontAttributes.Italic,
                    FontSize = 14,
                    TextColor = Palette.Muted,
                    LineBreakMode = LineBreakMode.WordWrap,
                    VerticalOptions = LayoutOptions.Center
                }
            }
        }
    };

    private static Border Code(string text) => new()
    {
        BackgroundColor = Palette.CodeBack,
        Stroke = new SolidColorBrush(Palette.Hairline),
        StrokeThickness = 1,
        Padding = new Thickness(12, 10),
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
        Content = new Label
        {
            Text = text,
            FontFamily = TextFamily,
            FontSize = 13,
            TextColor = Palette.CodeInk,
            LineBreakMode = LineBreakMode.WordWrap
        }
    };

    private static View List(ListBlock list)
    {
        var rows = new VerticalStackLayout { Spacing = 5 };
        var index = 1;
        foreach (var item in list.Items)
        {
            var isOrdered = list.Ordered;
            var bulletView = isOrdered
                ? (View)new Label
                {
                    Text = ToFa(index),
                    FontFamily = "VazirmatnBold",
                    FontSize = 12,
                    TextColor = Palette.Accent,
                    WidthRequest = 22,
                    HeightRequest = 22,
                    HorizontalTextAlignment = TextAlignment.Center,
                    VerticalTextAlignment = TextAlignment.Center,
                    BackgroundColor = Palette.Accent.WithAlpha(0.16f)
                }
                : new Border
                {
                    WidthRequest = 7,
                    HeightRequest = 7,
                    BackgroundColor = Palette.Accent,
                    StrokeThickness = 0,
                    StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 4 },
                    VerticalOptions = LayoutOptions.Center,
                    HorizontalOptions = LayoutOptions.Center,
                    Margin = new Thickness(8, 0)
                };
            index++;

            var body = Paragraph(item);
            rows.Children.Add(new HorizontalStackLayout
            {
                Spacing = 9,
                Children = { bulletView, body }
            });
        }
        return rows;
    }

    private static Label Paragraph(ParagraphBlock paragraph)
    {
        var ink = Palette.Ink;
        var formatted = new FormattedString();
        foreach (var span in paragraph.Spans)
        {
            if (span.Text.Length == 0) continue;
            formatted.Spans.Add(new Microsoft.Maui.Controls.Span
            {
                Text = span.Text,
                FontFamily = TextFamily,
                FontSize = 15,
                TextColor = span.Style == SpanStyle.Mono ? Palette.Accent : ink,
                LineHeight = 1.45,
                FontAttributes = span.Style switch
                {
                    SpanStyle.Bold => FontAttributes.Bold,
                    SpanStyle.Italic => FontAttributes.Italic,
                    SpanStyle.BoldItalic => FontAttributes.Bold | FontAttributes.Italic,
                    _ => FontAttributes.None
                },
                TextDecorations = span.Style == SpanStyle.Strike
                    ? TextDecorations.Strikethrough
                    : TextDecorations.None
            });
        }

        if (formatted.Spans.Count == 0)
            formatted.Spans.Add(new Microsoft.Maui.Controls.Span { Text = paragraph.PlainText, FontFamily = TextFamily, FontSize = 15, TextColor = ink, LineHeight = 1.45 });

        return new Label
        {
            FormattedText = formatted,
            HorizontalOptions = LayoutOptions.Fill,
            LineBreakMode = LineBreakMode.WordWrap
        };
    }

    private static Label Body(string text) => new()
    {
        Text = text,
        FontFamily = TextFamily,
        FontSize = 15,
        TextColor = Palette.Ink,
        LineBreakMode = LineBreakMode.WordWrap
    };

    /// <summary>Persian digits keep ordered lists reading naturally in RTL.</summary>
    private static string ToFa(int number)
    {
        const string Digits = "۰۱۲۳۴۵۶۷۸۹";
        var s = number.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var chars = new char[s.Length];
        for (int i = 0; i < s.Length; i++)
            chars[i] = char.IsAsciiDigit(s[i]) ? Digits[s[i] - '0'] : s[i];
        return new string(chars) + ".";
    }
}
