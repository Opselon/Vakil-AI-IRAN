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

        var signOut = await host.DisplayAlertAsync("حساب کاربری",
            who + "\n" + role + "\n\nمی‌خواهید از حساب خارج شوید؟ گفتگوی این دستگاه تنها با ورود یک حسابِ دیگر پاک می‌شود.",
            "خروج از حساب", "ادامه با این حساب");
        if (signOut)
            await mkt.SignOutAsync();
    }
}
