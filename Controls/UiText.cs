namespace Vakil_AI_IRAN.Controls;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — The single source of CLIENT-OWNED Persian UI copy (§120–127,
//             240–252). Server-delivered text stays server-delivered (always
//             passed through ActionIcons.CleanLabel); this file owns welcome
//             prompts, empty states, errors, CTA verbs and section headers.
// INVARIANTS— Professional legal tone: no marketing jargon, no fake
//             confidence language, outcome-describing CTAs, no emoji.
// ═══════════════════════════════════════════════════════════════════════════

public static class UiText
{
    // ── app identity ──
    public const string AppName = "وکیل هوشمند ایران";
    public const string AiName = "وکیل AI";

    // ── Home ──
    public static string Greeting(DateTime nowTehran) => nowTehran.Hour switch
    {
        < 12 => "صبح بخیر",
        < 17 => "ظهر بخیر",
        _ => "شب بخیر"
    };
    public const string HomeAskEntry = "سوال حقوقی خود را بپرسید…";
    public const string HomeAskHint = "پاسگ گام‌به‌گام، با استناد به قوانین و رویه‌های قضایی.";
    public const string HomeQuickActions = "دسترسی سریع";
    public const string HomeContinue = "ادامه‌ی کار";
    public const string HomeRecentChats = "گفتگوهای اخیر";
    public const string HomeNextConsult = "مشاوره‌ی فعال شما";

    // quick-action rows (§31 — five real destinations, nothing invented)
    public const string AskAi = "پرسش از وکیل AI";
    public const string AnalyzeDocument = "تحلیل تصویر قرارداد یا دادنامه";
    public const string DraftDocument = "تنظیم قرارداد و لایحه";
    public const string FindLawyer = "یافتن وکیل متخصص";
    public const string MyConsultations = "مشاوره‌های من";

    // ── AI surface (chat) ──
    public const string ChatEmptyQuestion = "چطور کمکتان می‌کنم؟";
    public const string NewChat = "گفتگوی تازه";
    public const string History = "تاریخچه‌ی گفتگوها";
    public const string RenameThread = "تغییر نام گفتگو";
    public const string DeleteThread = "حذف گفتگو";
    public const string DeleteThreadConfirm = "این گفتگو و همه‌ی پیام‌هایش از این دستگاه حذف شود؟ این کار بازگشت ندارد.";
    public const string PinThread = "سنجاق کردن";
    public const string UnpinThread = "برداشتن سنجاق";
    public const string SearchChats = "جستجو در گفتگوها";
    public const string NoChatsYet = "هنوز گفتگویی شروع نکرده‌اید";
    public const string NewMessagePill = "پیام تازه";
    public const string StopGenerating = "توقف";
    public const string Send = "ارسال";
    public const string RemoveAttachment = "حذف پیوست";
    public const string AttachmentImage = "پیوست تصویر";
    public const string AttachImage = "افزودن تصویر سند";
    public const string VoiceMessage = "پیام صوتی";
    public const string RecordingHint = "در حال ضبط — برای ارسال «فرستادن» و برای لغو «لغو» را بزنید";
    public const string VoiceUnavailable = "ضبط صوت روی این دستگاه در دسترس نیست. سوال خود را بنویسید یا تصویر سند بفرستید.";
    public const string DraftingModeChip = "حالت تنظیم متن فعال است — «لغو» را بزنید تا خارج شوید";

    // empty-state prompt chips (§10/11 — max four, all map to real behavior)
    public static readonly (string Label, string Prefill)[] PromptChips =
    {
        ("سوال حقوقی بپرسم", "سوال حقوقی‌ام این است: "),
        ("قرارداد را بررسی کن", "این قرارداد را بررسی کن و بگو کجاها به ضرر من است: "),
        ("لایحه بنویسم", "برای تنظیم لایحه کمکم کن. موضوع پرونده: "),
        ("قانون مرتبط را پیدا کن", "قوانین و آرای مرتبط با این موضوع را پیدا کن: "),
    };

    // ── states (§71–73, error copy always: what happened → what to do) ──
    public const string ErrNetwork = "به اینترنت متصل نیستید. اتصال را برقرار کنید؛ متن شما حفظ می‌شود.";
    public const string ErrServerUnreachable = "ارتباط با سرور ممکن نشد. چند لحظه دیگر دوباره بزنید.";
    public const string ErrTimeout = "پاسخ سرور طول کشید و بسته شد. سوال شما حفظ شده است — دوباره بفرستید.";
    public const string ErrSessionExpired = "نشست شما منقضی شده است. برای ادامه دوباره وارد حساب شوید.";
    public const string ErrLimit = "سهم امروزتان پایان یافته است. از نیمه‌شب به وقت تهران تازه می‌شود.";
    public const string Retry = "تلاش دوباره";
    public const string CopyAnswer = "کپی پاسخ";
    public const string Copied = "کپی شد";
    public const string ThinkingSteps = "مراحل تحلیل";

    // ── trust (§17, 128) — honest, contextual, once ──
    public const string AiDisclaimer = "پاسخ‌ها راهنمای اولیه‌اند و جای وکیل را نمی‌گیرند؛ برای اقدام حقوقی مهم با وکیل مشورت کنید.";

    // ── quota chip (§131) ──
    public const string QuotaReady = "آماده‌ی گفتگو";
    public static string QuotaUsed(int used, int limit) => $"{used} از {limit} امروز";
    public static string QuotaFaDigits(string s) =>
        string.Concat(s.Select(ch => ch is >= '0' and <= '9' ? (char)('۰' + (ch - '0')) : ch));

    // ── legacy conversation bucket (migration backfill title) ──
    public const string LegacyConversationTitle = "گفتگوهای پیشین";
}
