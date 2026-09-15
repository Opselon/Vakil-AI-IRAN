using VakilAI.Application.Contracts;

namespace Vakil_AI_IRAN.Controls;

/// <summary>
/// The "حساب" bottom-tab sheet, shared by every page that hosts a BottomTabBar
/// (Chat, Lawyers, Consultations). Signed-out → routes to Auth; signed-in →
/// identity summary with a guarded sign-out. Pages never duplicate this text —
/// one honest copy of the privacy note everywhere.
/// </summary>
public static class AccountMenu
{
    public static async Task OpenAsync(Page host, IMarketplaceCoordinator? mkt)
    {
        if (mkt is null) return;
        var session = mkt.Current;

        if (!session.IsSignedIn)
        {
            mkt.Navigate(MarketplaceRoute.Auth);
            return;
        }

        var who = session.DisplayName ?? "کاربر وکیل";
        var role = session.Kind == AccountKind.LegacyActivation
            ? "نشست قدیمی با کد فعال‌سازی (بدون حساب)"
            : session.Role switch
            {
                "lawyer" when session.IsVerifiedLawyer => "وکیل تأییدشده",
                "lawyer" => "وکیل — در صف بررسی تیم",
                "admin" => "مدیر سامانه",
                _ => "موکل"
            };

        // Organized sheet (§69): identity rows + actions, one confirm — only the
        // destructive one. The old multi-line alert buried the choice in prose.
        const string signOut = "خروج از حساب";
        const string keepGoing = "ادامه با این حساب";
        var choice = await host.DisplayActionSheetAsync(
            who + "  ·  " + role, keepGoing, null, signOut);
        if (choice == signOut)
        {
            var go = await host.DisplayAlertAsync("خروج از حساب",
                "گفتگوی این دستگاه تنها با ورود یک حسابِ دیگر پاک می‌شود.",
                "خروج", "انصراف");
            if (go)
                await mkt.SignOutAsync();
        }
    }
}
