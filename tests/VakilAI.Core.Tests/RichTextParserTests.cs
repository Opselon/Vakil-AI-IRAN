using VakilAI.Application.RichText;
using VakilAI.Domain.Entities;
using Xunit;

namespace VakilAI.Core.Tests;

/// <summary>
/// Covers both rich-text formats the Vakil API declares per message ("markdown" / "html")
/// plus ToPlainText (search + notification previews).
/// </summary>
public class RichTextParserTests
{
    private static IReadOnlyList<RenderBlock> Md(string? text) => RichTextParser.Parse(text, RenderFormat.Markdown);
    private static IReadOnlyList<RenderBlock> Html(string? text) => RichTextParser.Parse(text, RenderFormat.Html);

    private static ParagraphBlock SingleParagraph(IReadOnlyList<RenderBlock> blocks)
    {
        var block = Assert.Single(blocks);
        return Assert.IsType<ParagraphBlock>(block);
    }

    // ─────────────────────────────── dispatch ───────────────────────────────

    [Fact]
    public void Parse_NullOrWhitespace_ReturnsNoBlocks()
    {
        Assert.Empty(RichTextParser.Parse(null, RenderFormat.Markdown));
        Assert.Empty(RichTextParser.Parse("   ", RenderFormat.Html));
        Assert.Empty(RichTextParser.Parse("\r\n", RenderFormat.Markdown));
    }

    [Fact]
    public void Parse_HtmlFormat_IsRoutedToHtmlParser()
    {
        var blocks = RichTextParser.Parse("<b>x</b>", RenderFormat.Html);
        var span = Assert.Single(SingleParagraph(blocks).Spans);
        Assert.Equal(SpanStyle.Bold, span.Style);
    }

    // ───────────────────────────── markdown: spans ─────────────────────────

    [Theory]
    [InlineData("**bold**", "bold", SpanStyle.Bold)]
    [InlineData("*bold*", "bold", SpanStyle.Bold)]
    [InlineData("***both***", "both", SpanStyle.BoldItalic)]
    [InlineData("_italic_", "italic", SpanStyle.Italic)]
    [InlineData("`mono`", "mono", SpanStyle.Mono)]
    [InlineData("~~gone~~", "gone", SpanStyle.Strike)]
    public void Markdown_SingleStyledRun_ProducesOneStyledSpan(string source, string text, SpanStyle style)
    {
        var span = Assert.Single(SingleParagraph(Md(source)).Spans);
        Assert.Equal(style, span.Style);
        Assert.Equal(text, span.Text);
    }

    [Fact]
    public void Markdown_MixedRun_PreservesPlainNeighbours()
    {
        var para = SingleParagraph(Md("normal **bold** tail"));
        Assert.Collection(para.Spans,
            s => { Assert.Equal(SpanStyle.None, s.Style); Assert.Equal("normal ", s.Text); },
            s => { Assert.Equal(SpanStyle.Bold, s.Style); Assert.Equal("bold", s.Text); },
            s => { Assert.Equal(SpanStyle.None, s.Style); Assert.Equal(" tail", s.Text); });
        Assert.Equal("normal bold tail", para.PlainText);
    }

    [Fact]
    public void Markdown_EscapedStar_IsLiteralText()
    {
        var span = Assert.Single(SingleParagraph(Md(@"a \*b\* c")).Spans);
        Assert.Equal(SpanStyle.None, span.Style);
        Assert.Equal("a *b* c", span.Text);
    }

    [Fact]
    public void Markdown_EscapedUnderscore_IsLiteralText()
    {
        var span = Assert.Single(SingleParagraph(Md(@"\_x\_")).Spans);
        Assert.Equal("_x_", span.Text);
    }

    [Fact]
    public void Markdown_NestedItalicInsideBold_KeepsInnerStyle()
    {
        var para = SingleParagraph(Md("**outer *inner* end**"));
        Assert.Contains(para.Spans, s => s.Style == SpanStyle.Bold && s.Text.Contains("outer"));
        Assert.Contains(para.Spans, s => s.Text.Contains("inner"));
    }

    // ───────────────────────────── markdown: blocks ─────────────────────────

    [Theory]
    [InlineData("# Title", "Title")]
    [InlineData("## Sub title", "Sub title")]
    [InlineData("### **Deep**", "Deep")]
    [InlineData("###### Six", "Six")]
    public void Markdown_HeadingLine_BecomesHeadingBlock(string source, string title)
    {
        var block = Assert.IsType<HeadingBlock>(Assert.Single(Md(source)));
        Assert.Equal(title, block.Title);
    }

    [Theory]
    [InlineData("#NoSpace")]
    [InlineData("####### SevenIsTooMany")]
    [InlineData("#")]
    public void Markdown_NonHeadingHashLines_DegradeToParagraph(string source)
    {
        var para = SingleParagraph(Md(source));
        Assert.StartsWith("#", para.PlainText);
    }

    [Theory]
    [InlineData("- item")]
    [InlineData("* item")]
    [InlineData("• item")]
    public void Markdown_BulletLine_BecomesUnorderedListBlock(string source)
    {
        var list = Assert.IsType<ListBlock>(Assert.Single(Md(source)));
        Assert.False(list.Ordered);
        var item = Assert.Single(list.Items);
        Assert.Equal("item", item.PlainText);
    }

    [Theory]
    [InlineData("1. first")]
    [InlineData("2) second")]
    [InlineData("۱. سوم")]
    [InlineData("۱۲. دوازدهم")]
    public void Markdown_NumberedLine_BecomesOrderedListBlock(string source)
    {
        var list = Assert.IsType<ListBlock>(Assert.Single(Md(source)));
        Assert.True(list.Ordered);
        Assert.False(string.IsNullOrWhiteSpace(Assert.Single(list.Items).PlainText));
    }

    [Fact]
    public void Markdown_ConsecutiveBullets_AreMergedIntoOneList()
    {
        var list = Assert.IsType<ListBlock>(Assert.Single(Md("- a\n- b\n- c")));
        Assert.False(list.Ordered);
        Assert.Equal(3, list.Items.Count);
        Assert.Equal(new[] { "a", "b", "c" }, list.Items.Select(i => i.PlainText).ToArray());
    }

    [Fact]
    public void Markdown_ConsecutiveNumberedItems_AreMergedAndOrdered()
    {
        var list = Assert.IsType<ListBlock>(Assert.Single(Md("1. a\n2. b")));
        Assert.True(list.Ordered);
        Assert.Equal(2, list.Items.Count);
    }

    [Fact]
    public void Markdown_OrderedThenUnordered_DoNotMerge()
    {
        var blocks = Md("1. a\n- b");
        Assert.Collection(blocks,
            b => Assert.True(Assert.IsType<ListBlock>(b).Ordered),
            b => Assert.False(Assert.IsType<ListBlock>(b).Ordered));
    }

    [Fact]
    public void Markdown_ListItems_GetInlineStyling()
    {
        var list = Assert.IsType<ListBlock>(Assert.Single(Md("- **must** read")));
        var item = Assert.Single(list.Items);
        Assert.Equal(SpanStyle.Bold, item.Spans[0].Style);
        Assert.Equal("must", item.Spans[0].Text);
        Assert.Equal("must read", item.PlainText);
    }

    [Fact]
    public void Markdown_QuoteLine_BecomesQuoteBlockWithMarkerStripped()
    {
        var quote = Assert.IsType<QuoteBlock>(Assert.Single(Md("> hello")));
        Assert.Equal("hello", quote.Text);
    }

    [Fact]
    public void Markdown_ConsecutiveQuoteLines_JoinOneQuoteBlock()
    {
        var quote = Assert.IsType<QuoteBlock>(Assert.Single(Md("> line one\n> line two")));
        Assert.Equal("line one\nline two", quote.Text);
    }

    [Fact]
    public void Markdown_FenceMarkers_AreNeverEmittedAsText()
    {
        var blocks = Md("```\ncourt order text\n```");
        Assert.DoesNotContain(blocks, b => b is ParagraphBlock p && p.PlainText.Contains("```"));
        Assert.Contains(blocks, b => b is ParagraphBlock p && p.PlainText.Contains("court order text"));
    }

    [Fact]
    public void Markdown_BlankLineSeparatesParagraphs()
    {
        var blocks = Md("para one\n\npara two");
        Assert.Equal(2, blocks.Count);
        Assert.Equal("para one", Assert.IsType<ParagraphBlock>(blocks[0]).PlainText);
        Assert.Equal("para two", Assert.IsType<ParagraphBlock>(blocks[1]).PlainText);
    }

    [Fact]
    public void Markdown_PlainText_PassesThroughUnchanged()
    {
        var para = SingleParagraph(Md("سلام چطور می‌توانم کمکتان کنم؟"));
        var span = Assert.Single(para.Spans);
        Assert.Equal(SpanStyle.None, span.Style);
        Assert.Equal("سلام چطور می‌توانم کمکتان کنم؟", span.Text);
    }

    // ──────────────────────────── total-ness (no throw) ─────────────────────

    [Theory]
    [InlineData("**unclosed")]
    [InlineData("*star")]
    [InlineData("a*b")]
    [InlineData("abc*")]
    [InlineData("_italic")]
    [InlineData("`mono")]
    [InlineData("~~strike")]
    [InlineData("***")]
    [InlineData("** **")]
    [InlineData("\\")]
    [InlineData("- ")]
    [InlineData("   ")]
    [InlineData("\n\n\n")]
    [InlineData("۱.")]
    [InlineData(">")]
    [InlineData("#*")]
    public void Markdown_MalformedInput_NeverThrowsAndAlwaysYieldsBlocks(string source)
    {
        var ex = Record.Exception(() => Md(source));
        Assert.Null(ex);
        Assert.NotEmpty(Md(source + "\nmore text"));
    }

    [Theory]
    [InlineData("<b>")]
    [InlineData("</b>")]
    [InlineData("<<<>>>")]
    [InlineData("<b>x</i>")]
    [InlineData("<blockquote>unclosed")]
    [InlineData("<pre>unclosed")]
    [InlineData("<")]
    [InlineData("<3")]
    [InlineData("&notanentity;")]
    [InlineData("<b><i>x</i>")]
    public void Html_MalformedInput_NeverThrows(string source)
    {
        Assert.Null(Record.Exception(() => Html(source)));
    }

    [Theory]
    [InlineData("&")]
    [InlineData("&lt;")]
    [InlineData("&gt;")]
    [InlineData("x&")]
    [InlineData("&amp")]
    public void Html_AmpEntityNearEndOfInput_DegradesGracefully(string source)
    {
        // Regression pin: DecodeEntity used to call text.IndexOf(';', at, 5), which threw
        // ArgumentOutOfRangeException when fewer than 5 chars remained after '&'. The parser
        // documents totality ("malformed input degrades gracefully") — parsing must never throw.
        var ex = Record.Exception(() => Html(source));
        Assert.Null(ex);
    }

    [Fact]
    public void Markdown_UnclosedBold_IsKeptAsLiteralText()
    {
        var para = SingleParagraph(Md("**unclosed tail"));
        Assert.Equal("**unclosed tail", para.PlainText);
    }

    [Fact]
    public void Html_UnclosedBold_StylesRemainAndTextSurvives()
    {
        var para = SingleParagraph(Html("<b>shout"));
        var span = Assert.Single(para.Spans);
        Assert.Equal("shout", span.Text);
        Assert.Equal(SpanStyle.Bold, span.Style);
    }

    // ───────────────────────────────── html ─────────────────────────────────

    [Theory]
    [InlineData("<b>bold</b>", SpanStyle.Bold)]
    [InlineData("<strong>bold</strong>", SpanStyle.Bold)]
    [InlineData("<i>ital</i>", SpanStyle.Italic)]
    [InlineData("<em>ital</em>", SpanStyle.Italic)]
    [InlineData("<s>gone</s>", SpanStyle.Strike)]
    [InlineData("<del>gone</del>", SpanStyle.Strike)]
    [InlineData("<code>mono</code>", SpanStyle.Mono)]
    public void Html_StylingTags_MapToSpanStyles(string source, SpanStyle style)
    {
        var span = Assert.Single(SingleParagraph(Html(source)).Spans);
        Assert.Equal(style, span.Style);
        Assert.False(span.Text.Contains('<'));
    }

    [Fact]
    public void Html_BoldItalicNesting_CollapsesToBoldItalic()
    {
        var para = SingleParagraph(Html("<b><i>x</i></b>"));
        var span = Assert.Single(para.Spans);
        Assert.Equal(SpanStyle.BoldItalic, span.Style);
        Assert.Equal("x", span.Text);
    }

    [Fact]
    public void Html_ItalicBoldNesting_CollapsesToBoldItalic()
    {
        var para = SingleParagraph(Html("<i><b>y</b></i>"));
        Assert.Equal(SpanStyle.BoldItalic, Assert.Single(para.Spans).Style);
    }

    [Fact]
    public void Html_TextAfterClosingTag_IsPreservedAsPlainSpan()
    {
        var para = SingleParagraph(Html("<b>bold</b>after"));
        Assert.Collection(para.Spans,
            s => { Assert.Equal(SpanStyle.Bold, s.Style); Assert.Equal("bold", s.Text); },
            s => { Assert.Equal(SpanStyle.None, s.Style); Assert.Equal("after", s.Text); });
    }

    [Fact]
    public void Html_UnknownTags_AreDroppedButTextSurvives()
    {
        var para = SingleParagraph(Html("<div>hello</div>"));
        var span = Assert.Single(para.Spans);
        Assert.Equal("hello", span.Text);
        Assert.Equal(SpanStyle.None, span.Style);
    }

    [Fact]
    public void Html_AttributedUnknownTag_IsDropped()
    {
        var para = SingleParagraph(Html("<section class=\"x\">body</section>"));
        Assert.Equal("body", para.PlainText);
    }

    [Fact]
    public void Html_LinkTag_KeepsLabelWithoutMarkup()
    {
        var para = SingleParagraph(Html("<a href=\"https://vakil-ai.workers.dev/\">court</a>"));
        Assert.Equal("court", para.PlainText);
    }

    [Fact]
    public void Html_Blockquote_BecomesQuoteBlock()
    {
        var quote = Assert.IsType<QuoteBlock>(Assert.Single(Html("<blockquote>استدلال</blockquote>")));
        Assert.Equal("استدلال", quote.Text);
    }

    [Fact]
    public void Html_BlockquoteWithMarkup_FlattensToQuoteText()
    {
        var blocks = Html("before<hr-ish><blockquote>quoted</blockquote>after");
        Assert.Contains(blocks, b => b is QuoteBlock q && q.Text == "quoted");
        Assert.Contains(blocks, b => b is ParagraphBlock p && p.PlainText.Contains("before"));
        Assert.Contains(blocks, b => b is ParagraphBlock p && p.PlainText.Contains("after"));
    }

    [Fact]
    public void Html_PreMultiLine_BecomesSingleCodeBlock()
    {
        var block = Assert.IsType<CodeBlock>(Assert.Single(Html("<pre>\nline1\nline2\n</pre>")));
        Assert.Equal("line1\nline2", block.Text.Trim());
    }

    [Fact]
    public void Html_PreSingleLine_BecomesCodeBlock()
    {
        var block = Assert.IsType<CodeBlock>(Assert.Single(Html("<pre>material</pre>")));
        Assert.Equal("material", block.Text);
    }

    [Fact]
    public void Html_AmpEntity_IsDecoded()
    {
        var para = SingleParagraph(Html("قانون &amp; آیین‌نامه"));
        Assert.Equal("قانون & آیین‌نامه", para.PlainText);
    }

    [Theory]
    [InlineData("a &lt;b&gt; c", "a <b> c")]
    [InlineData("x &lt; y", "x < y")]
    [InlineData("5 &gt; 3", "5 > 3")]
    public void Html_AngleBracketEntities_AreDecoded(string source, string expected)
    {
        Assert.Equal(expected, SingleParagraph(Html(source)).PlainText);
    }

    [Fact]
    public void Html_LongerEntities_AreDecoded()
    {
        // Regression pin: the old ';' search window (5 chars) made &quot; / &apos; /
        // &nbsp; / &#nnn; unreachable. Fixed window is 11 chars, so they decode now.
        Assert.Equal("\"", SingleParagraph(Html("&quot;")).PlainText);
        Assert.Equal("'", SingleParagraph(Html("&apos;")).PlainText);
        Assert.Equal("a\u00A0b", SingleParagraph(Html("a&nbsp;b")).PlainText); // NBSP codepoint, not a space
        Assert.Equal("ا", SingleParagraph(Html("&#1575;")).PlainText);
    }

    [Fact]
    public void Html_BrTag_BecomesLineBreakInText()
    {
        Assert.Equal("a\nb", SingleParagraph(Html("a<br>b")).PlainText);
    }

    [Fact]
    public void Html_EmptyParagraphsAreFilteredOut()
    {
        Assert.Empty(Html("<div></div>"));
        Assert.Empty(Html("   "));
    }

    [Fact]
    public void Html_MixedQuoteAndStyledParagraph_BothBlocksPresent()
    {
        var blocks = Html("<blockquote>q</blockquote><b>label</b> value");
        Assert.Contains(blocks, b => b is QuoteBlock);
        var para = Assert.IsType<ParagraphBlock>(blocks.Last());
        Assert.Contains(para.Spans, s => s.Style == SpanStyle.Bold && s.Text == "label");
        Assert.Contains(para.Spans, s => s.Text.Contains("value"));
    }

    // ─────────────────────────────── ToPlainText ────────────────────────────

    [Theory]
    [InlineData("a **b** c", "a b c")]
    [InlineData("*bold* and _ital_", "bold and ital")]
    [InlineData("`code` here", "code here")]
    [InlineData("~~struck~~", "struck")]
    [InlineData("***all***", "all")]
    [InlineData("- list item", "- list item")]
    [InlineData("> quoted", "> quoted")]
    public void ToPlainText_Markdown_StripsStyleMarkersOnly(string source, string expected)
        => Assert.Equal(expected, RichTextParser.ToPlainText(source, RenderFormat.Markdown));

    [Theory]
    [InlineData("<b>bold</b>", "bold")]
    [InlineData("x <i>y</i> z", "x y z")]
    [InlineData("<pre>code</pre>", "code")]
    [InlineData("<blockquote>q</blockquote>", "q")]
    [InlineData("a &amp; b", "a & b")]
    [InlineData("<br/>", "")]
    public void ToPlainText_Html_StripsTags(string source, string expected)
        => Assert.Equal(expected, RichTextParser.ToPlainText(source, RenderFormat.Html));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void ToPlainText_EmptyInput_ReturnsEmpty(string? source)
    {
        Assert.Equal("", RichTextParser.ToPlainText(source, RenderFormat.Markdown));
        Assert.Equal("", RichTextParser.ToPlainText(source, RenderFormat.Html));
    }

    [Fact]
    public void ToPlainText_LeavesPersianTextIntact()
    {
        const string fa = "۱. **سوال متنی:** لطفاً سوال خود را کامل بنویسید.";
        Assert.Equal("۱. سوال متنی: لطفاً سوال خود را کامل بنویسید.",
            RichTextParser.ToPlainText(fa, RenderFormat.Markdown));
    }
}
