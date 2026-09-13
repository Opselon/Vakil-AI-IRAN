using VakilAI.Domain.Entities;

namespace VakilAI.Application.RichText;

public enum SpanStyle { None, Bold, Italic, BoldItalic, Mono, Strike }

/// <summary>Minimal styled text run — the chat UI composes these into styled spans.</summary>
public sealed record RenderSpan(string Text, SpanStyle Style = SpanStyle.None);

/// <summary>Block model for one assistant bubble rendered by the app.</summary>
public abstract record RenderBlock;
public sealed record HeadingBlock(string Title) : RenderBlock;
public sealed record QuoteBlock(string Text) : RenderBlock;
public sealed record CodeBlock(string Text) : RenderBlock;
public sealed record ListBlock(bool Ordered, IReadOnlyList<ParagraphBlock> Items) : RenderBlock;
public sealed record ParagraphBlock(IReadOnlyList<RenderSpan> Spans) : RenderBlock
{
    public string PlainText => string.Concat(Spans.Select(s => s.Text));
    public bool IsEmpty => Spans.Count == 0 || Spans.All(s => string.IsNullOrWhiteSpace(s.Text));
}

/// <summary>
/// Renders the two rich-text formats the Vakil API declares per message:
///  • "markdown" — lightweight rich text (*bold*, _italic_, `mono`, &gt; quote, - list)
///  • "html"     — styled subset (&lt;b&gt;, &lt;i&gt;, &lt;u&gt;, &lt;s&gt;, &lt;code&gt;, &lt;pre&gt;, &lt;blockquote&gt;)
/// The parser is total: malformed input degrades gracefully to plain text.
/// Built for RTL Persian first: bidi marks are normalized, emoji bullets preserved.
/// </summary>
public static class RichTextParser
{
    public static IReadOnlyList<RenderBlock> Parse(string? text, RenderFormat format)
    {
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<RenderBlock>();
        return format == RenderFormat.Html ? ParseHtml(text) : ParseRichText(text);
    }

    // ─────────────────────────── "markdown" format ───────────────────────────

    public static IReadOnlyList<RenderBlock> ParseRichText(string text)
    {
        var blocks = new List<RenderBlock>();
        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');

        foreach (var para in SplitParagraphs(normalized))
        {
            var lines = para.Split('\n');
            var paraLines = new List<string>();
            foreach (var raw in lines)
            {
                var line = raw.TrimEnd();
                if (line.Length == 0) { FlushPara(blocks, paraLines); paraLines = new List<string>(); continue; }

                if (line.TrimStart().StartsWith("```")) { FlushPara(blocks, paraLines); paraLines = new List<string>(); continue; }

                var heading = TryHeading(line);
                if (heading is not null)
                {
                    FlushPara(blocks, paraLines); paraLines = new List<string>();
                    blocks.Add(new HeadingBlock(heading));
                    continue;
                }

                if (line.StartsWith('•') || line.StartsWith("- ") || line.StartsWith("* "))
                {
                    FlushPara(blocks, paraLines); paraLines = new List<string>();
                    var item = line.StartsWith('•') ? line[1..].TrimStart() : line[2..].TrimStart();
                    blocks.Add(new ListBlock(false, new[] { new ParagraphBlock(ParseInline(item)) }));
                    continue;
                }

                var ordered = System.Text.RegularExpressions.Regex.Match(line, @"^(\d+)[\).\u0648]\s+(.*)$");
                if (ordered.Success)
                {
                    FlushPara(blocks, paraLines); paraLines = new List<string>();
                    blocks.Add(new ListBlock(true, new[] { new ParagraphBlock(ParseInline(ordered.Groups[2].Value)) }));
                    continue;
                }

                paraLines.Add(line);
            }
            FlushPara(blocks, paraLines);
        }
        return MergeConsecutiveLists(blocks);
    }

    private static void FlushPara(List<RenderBlock> blocks, List<string> lines)
    {
        if (lines.Count == 0) return;
        var joined = string.Join('\n', lines);
        if (joined.Trim().Length == 0) return;
        if (lines.All(l => l.TrimStart().StartsWith('>')))
        {
            var quote = string.Join('\n', lines.Select(l => l.TrimStart().TrimStart('>').TrimStart()));
            blocks.Add(new QuoteBlock(quote));
            return;
        }
        blocks.Add(new ParagraphBlock(ParseInline(joined)));
    }

    public static List<RenderSpan> ParseInline(string? text)
    {
        var spans = new List<RenderSpan>();
        if (string.IsNullOrEmpty(text)) return spans;

        var sb = new System.Text.StringBuilder();
        void Flush(SpanStyle style)
        {
            if (sb.Length == 0) return;
            spans.Add(new RenderSpan(sb.ToString(), style));
            sb.Clear();
        }

        int i = 0;
        while (i < text.Length)
        {
            char c = text[i];

            // escape: \* \_ \`
            if (c == '\\' && i + 1 < text.Length && "*_`~".IndexOf(text[i + 1]) >= 0)
            {
                sb.Append(text[i + 1]); i += 2; continue;
            }

            // `mono`
            if (c == '`')
            {
                int end = text.IndexOf('`', i + 1);
                if (end > i + 1) { Flush(SpanStyle.None); spans.Add(new RenderSpan(text[(i + 1)..end], SpanStyle.Mono)); i = end + 1; continue; }
            }

            // ***bold italic*** / **bold**
            if (c == '*' && i + 1 < text.Length && text[i + 1] == '*')
            {
                bool triple = i + 2 < text.Length && text[i + 2] == '*';
                var closer = triple ? "***" : "**";
                int contentStart = i + closer.Length;
                int end = text.IndexOf(closer, contentStart, StringComparison.Ordinal);
                if (end > contentStart)
                {
                    Flush(SpanStyle.None);
                    var inner = text[contentStart..end];
                    var style = triple ? SpanStyle.BoldItalic : SpanStyle.Bold;
                    foreach (var s in ParseInline(inner))
                        spans.Add(new RenderSpan(s.Text, s.Style == SpanStyle.None ? style : s.Style));
                    i = end + closer.Length; continue;
                }
            }

            // *bold*  (rich-text convention used by the Vakil assistant)
            if (c == '*')
            {
                int end = FindCloser(text, i + 1, '*');
                if (end > i + 1)
                {
                    Flush(SpanStyle.None);
                    spans.Add(new RenderSpan(text[(i + 1)..end], SpanStyle.Bold));
                    i = end + 1; continue;
                }
            }

            // _italic_
            if (c == '_')
            {
                int end = FindCloser(text, i + 1, '_');
                if (end > i + 1)
                {
                    Flush(SpanStyle.None);
                    spans.Add(new RenderSpan(text[(i + 1)..end], SpanStyle.Italic));
                    i = end + 1; continue;
                }
            }

            // ~~strike~~
            if (c == '~' && i + 1 < text.Length && text[i + 1] == '~')
            {
                int end = text.IndexOf("~~", i + 2, StringComparison.Ordinal);
                if (end > i + 2)
                {
                    Flush(SpanStyle.None);
                    spans.Add(new RenderSpan(text[(i + 2)..end], SpanStyle.Strike));
                    i = end + 2; continue;
                }
            }

            sb.Append(c); i++;
        }
        Flush(SpanStyle.None);
        return spans.Count > 0 ? spans : new List<RenderSpan> { new(text) };
    }

    private static int FindCloser(string text, int from, char marker)
    {
        for (int k = from; k < text.Length; k++)
        {
            if (text[k] == '\\') { k++; continue; }
            if (text[k] == marker) return k;
        }
        return -1;
    }

    private static string? TryHeading(string line)
    {
        var t = line.TrimStart();
        if (!t.StartsWith('#')) return null;
        int n = 0; while (n < t.Length && t[n] == '#' && n < 6) n++;
        if (n == 0 || n >= t.Length || t[n] != ' ') return null;
        var title = t[n..].Trim().Trim('*');
        return title.Length == 0 ? null : title;
    }

    // ─────────────────────────── "html" format ───────────────────────────

    private static readonly HashSet<string> AllowedTags = new(StringComparer.OrdinalIgnoreCase)
        { "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "blockquote", "br", "a" };

    public static IReadOnlyList<RenderBlock> ParseHtml(string html)
    {
        var blocks = new List<RenderBlock>();
        var currentPara = new List<RenderSpan>();
        var styleStack = new Stack<SpanStyle>();
        styleStack.Push(SpanStyle.None);
        var sb = new System.Text.StringBuilder();
        var quoteBuf = new System.Text.StringBuilder();
        bool inQuote = false, inPre = false;

        void AddText(string chunk)
        {
            if (chunk.Length == 0) return;
            if (inQuote) { quoteBuf.Append(chunk); return; }
            sb.Append(chunk);
        }

        void FlushRun()
        {
            if (sb.Length == 0) return;
            currentPara.Add(new RenderSpan(sb.ToString(), styleStack.Peek()));
            sb.Clear();
        }

        void FlushPara()
        {
            FlushRun();
            var merged = Coalesce(currentPara);
            if (merged.Count > 0)
                blocks.Add(inPre ? new CodeBlock(merged[0].Text) : (RenderBlock)new ParagraphBlock(merged));
            currentPara.Clear();
            inPre = false;
        }

        int i = 0;
        var text = html.Replace("\r\n", "\n");

        while (i < text.Length)
        {
            if (text[i] == '<')
            {
                int gt = text.IndexOf('>', i);
                if (gt < 0) { AddText("<"); i++; continue; }
                var tagRaw = text[(i + 1)..gt].Trim();
                bool closing = tagRaw.StartsWith('/');
                var name = (closing ? tagRaw[1..] : tagRaw).Split(' ', '/')[0].ToLowerInvariant();

                if (!AllowedTags.Contains(name)) { i = gt + 1; continue; }

                if (name == "br")
                {
                    FlushRun();
                    currentPara.Add(new RenderSpan("\n", styleStack.Peek()));
                    i = gt + 1; continue;
                }

                if (!closing)
                {
                    FlushRun();
                    var style = name switch
                    {
                        "b" or "strong" => SpanStyle.Bold,
                        "i" or "em" => SpanStyle.Italic,
                        "s" or "strike" or "del" => SpanStyle.Strike,
                        "code" or "pre" => SpanStyle.Mono,
                        _ => styleStack.Peek()
                    };
                    styleStack.Push(Merge(styleStack.Peek(), style));
                    if (name == "blockquote") inQuote = true;
                    if (name == "pre") inPre = true;
                }
                else
                {
                    FlushRun();
                    if (styleStack.Count > 1) styleStack.Pop();
                    if (name == "blockquote")
                    {
                        blocks.Add(new QuoteBlock(quoteBuf.ToString().Trim()));
                        quoteBuf.Clear();
                        inQuote = false;
                    }
                    if (name == "pre") FlushPara();
                }
                i = gt + 1;
                continue;
            }

            if (text[i] == '\n' && !inQuote)
            {
                FlushRun();
                currentPara.Add(new RenderSpan("\n", styleStack.Peek()));
                i++; continue;
            }

            if (text[i] == '&')
            {
                var (decoded, consumed) = DecodeEntity(text, i);
                AddText(decoded);
                i += consumed;
                continue;
            }

            AddText(text[i].ToString());
            i++;
        }

        FlushPara();
        if (quoteBuf.Length > 0) blocks.Add(new QuoteBlock(quoteBuf.ToString().Trim()));

        return blocks.Where(b => b is not ParagraphBlock p || !p.IsEmpty).ToList();
    }

    private static SpanStyle Merge(SpanStyle outer, SpanStyle inner) => (outer, inner) switch
    {
        (SpanStyle.None, _) or (_, SpanStyle.None) => inner == SpanStyle.None ? outer : inner,
        (SpanStyle.Bold, SpanStyle.Italic) or (SpanStyle.Italic, SpanStyle.Bold) => SpanStyle.BoldItalic,
        _ => inner
    };

    private static IReadOnlyList<RenderSpan> Coalesce(List<RenderSpan> spans)
    {
        var outSpans = new List<RenderSpan>();
        foreach (var s in spans)
        {
            if (outSpans.Count > 0 && outSpans[^1].Style == s.Style)
                outSpans[^1] = outSpans[^1] with { Text = outSpans[^1].Text + s.Text };
            else outSpans.Add(s);
        }
        return outSpans;
    }

    private static (string, int) DecodeEntity(string text, int at)
    {
        int semi = text.IndexOf(';', at, 5);
        if (semi < 0 || semi - at > 10) return ("&", 1);
        var ent = text[(at + 1)..semi];
        switch (ent)
        {
            case "amp": return ("&", semi - at + 1);
            case "lt": return ("<", semi - at + 1);
            case "gt": return (">", semi - at + 1);
            case "quot": return ("\"", semi - at + 1);
            case "apos": return ("'", semi - at + 1);
            case "nbsp": return (" ", semi - at + 1);
        }
        if (ent.StartsWith('#') && int.TryParse(ent.AsSpan(1), out var cp) && cp is > 0 and < 0x110000)
            return (char.ConvertFromUtf32(cp), semi - at + 1);
        return ("&", 1);
    }

    private static List<string> SplitParagraphs(string text)
    {
        var parts = new List<string>();
        var buf = new System.Text.StringBuilder();
        foreach (var line in text.Split('\n'))
        {
            if (line.Trim().Length == 0)
            {
                if (buf.Length > 0) { parts.Add(buf.ToString()); buf.Clear(); }
                continue;
            }
            if (buf.Length > 0) buf.Append('\n');
            buf.Append(line);
        }
        if (buf.Length > 0) parts.Add(buf.ToString());
        return parts;
    }

    private static IReadOnlyList<RenderBlock> MergeConsecutiveLists(List<RenderBlock> blocks)
    {
        var result = new List<RenderBlock>();
        foreach (var b in blocks)
        {
            if (b is ListBlock lb && result.Count > 0 && result[^1] is ListBlock prev && prev.Ordered == lb.Ordered)
                result[^1] = new ListBlock(prev.Ordered, prev.Items.Concat(lb.Items).ToList());
            else result.Add(b);
        }
        return result;
    }

    /// <summary>Strip styling to plain text (search, previews, notifications).</summary>
    public static string ToPlainText(string? text, RenderFormat format)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        if (format == RenderFormat.Html)
        {
            var s = System.Text.RegularExpressions.Regex.Replace(text,
                @"</?(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|br|a)(\s[^>]*)?/?>",
                "", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            s = s.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&nbsp;", " ").Replace("&amp;", "&");
            return s.Trim();
        }
        return System.Text.RegularExpressions.Regex.Replace(text, @"(\*\*\*|\*\*|\*|_|`|~~)", "").Trim();
    }
}
