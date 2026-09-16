using VakilAI.Domain.Entities;

namespace Vakil_AI_IRAN.Controls;

/// <summary>
/// Maps server quick-action keys (and the local marketplace entries) to the
/// bundled vector icon pair — replacing every emoji in tappable chrome. Unknown
/// actions get a neutral chat-arrow so a new server action never looks broken.
/// The "_on" variant is for filled/accented surfaces (white ink).
/// </summary>
public static class ActionIcons
{
    public static (string Icon, string IconOn) For(ChatButton button)
    {
        var a = button.Action ?? string.Empty;
        return a switch
        {
            "cmd_contact" or "support_chat" => ("ic_phone.png", "ic_phone_on.png"),
            "cmd_drafting" => ("ic_pen.png", "ic_pen_on.png"),
            "buy_subscription" or "refresh_limit" or "cmd_limit" => ("ic_wallet.png", "ic_wallet_on.png"),
            "cmd_about" or "cmd_terms" => ("ic_terms.png", "ic_terms_on.png"),
            "cmd_help" or "faq" or "main_menu" => ("ic_grid.png", "ic_grid_on.png"),
            "deep_analysis" or "court_simulator" or "interrogation_sim"
                or "financial_risk" or "opponent_claims" or "legal_opportunities" or "dos_and_donts"
                => ("ic_action_bolt.png", "ic_action_bolt_on.png"),
            _ => a.StartsWith("ai_act|", StringComparison.Ordinal)
                ? ("ic_action_bolt.png", "ic_action_bolt_on.png")
                : ("ic_chat_arrow.png", "ic_chat_arrow.png")
        };
    }

    /// <summary>Style token for the filled action buttons under message bubbles.
    /// Premium hierarchy (§343): only the primary keeps a brand fill; success/danger
    /// render tonal so a six-button answer never looks like a rainbow wall.</summary>
    public static string StyleKey(ChatButton button) => button.Style switch
    {
        ButtonStyle.Success => "BtnTonal",
        ButtonStyle.Danger => "BtnDestructiveTonal",
        _ => "PrimaryBg"
    };

    /// <summary>Filled (brand-color) buttons need the white ink variant of the icon;
    /// tonal/quiet surfaces take the colored strokes.</summary>
    public static bool IsFilled(ChatButton button) => button.Style == ButtonStyle.Primary;

    /// <summary>Server chip labels still carry legacy emoji prefixes ("✍️ تنظیم…").
    /// The chrome now owns the icon, so strip any leading emoji/symbol cluster.</summary>
    public static string CleanLabel(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? string.Empty;
        int i = 0;
        while (i < text.Length && IsGlyph(text[i])) i++;
        while (i < text.Length && (text[i] == ' ' || text[i] == ' ')) i++;
        return i == 0 ? text : text[i..];
    }

    /// <summary>Heading emoji cleanup used by the rich-text renderer (server
    /// headings arrive as "⚖️ موضوع" — the accent rule replaces the glyph).</summary>
    public static string CleanHeading(string? text) => CleanLabel(text);

    // Emoji/symbol prefixes seen in server labels: BMP dingbats, variation
    // selector, ZWJ, and UTF-16 lead surrogates of the astral emoji blocks.
    private static bool IsGlyph(char c) =>
        c is (char)0xFE0F or (char)0x200D
        or >= '☀' and <= '➿'
        or >= '\uD83C' and <= '\uD83E';
}
