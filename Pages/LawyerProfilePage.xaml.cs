using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Rendering;
using Vakil_AI_IRAN.Services;   // IMarketplaceRouteArgument (coordinator hand-off seam)
using VakilAI.Application.Contracts;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// Public lawyer profile (Agent 5). Fed only by <see cref="IMarketplaceApi"/> — every line
/// is server data: verified badge, self-declared bio, price, languages, availability.
/// Nothing is invented: no ratings, no review counts, no consultation statistics, and the
/// text sections carry an explicit "declared by the lawyer themself" caption.
/// Shell-free: the ctor takes no arguments; the caller hands the identity over through
/// <see cref="Open(long,string?)"/> / <see cref="OpenArgument"/> after construction.
/// States: loading (skeletons + ring), content, error (+ retry). An unavailable profile is
/// an error state here, not an empty one — /lawyers/get only answers for verified lawyers.
/// </summary>
public partial class LawyerProfilePage : ContentPage, IMarketplaceRouteArgument
{
    private const int SectionMaxWidth = 560;

    private readonly IMarketplaceApi _api;
    private readonly ITokenStore _tokens;

    /// <summary>Resolved best-effort: Agent 10 registers it (owns StartConsultationAsync).</summary>
    private readonly IMarketplaceCoordinator? _nav;

    private CancellationTokenSource _ambient = new();
    private CancellationTokenSource? _request;

    private long _userId;
    private string? _slug;
    private LawyerProfileResponse? _profile;
    private LawyerReviewsResponse? _reviews;   // wave 2: public book reviews (server /reviews/lawyer)
    private bool _loading;
    private bool _loadAttempted;
    private bool _bookRequested;
    private bool _identityGiven;   // an id/argument reached us before the page was shown

    public LawyerProfilePage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _api = sp.GetRequiredService<IMarketplaceApi>();
        _tokens = sp.GetRequiredService<ITokenStore>();
        _nav = LawyersPage.TryResolveOptional<IMarketplaceCoordinator>();
    }

    /// <summary>Direct hand-off (used by callers that hold the page instance, e.g. a
    /// coordinator that resolves the page then hands over the id). Safe before or after load.</summary>
    public void Open(long userId, string? slug = null)
    {
        _identityGiven = true;
        if (userId > 0) _userId = userId;
        if (!string.IsNullOrWhiteSpace(slug)) _slug = slug.Trim();
        if (Handler is not null) _ = LoadAsync();  // otherwise OnAppearing loads once attached
    }

    /// <summary>Called by the coordinator BEFORE this page becomes the window root
    /// (see MarketplaceCoordinator.IMarketplaceRouteArgument) — also used by the
    /// directory's fallback push, which calls <see cref="Open"/> directly.</summary>
    public void ReceiveRouteArgument(object? argument) => OpenArgument(argument);

    /// <summary>Boxed-argument flavour for <c>Navigate(MarketplaceRoute.LawyerProfile, arg)</c>.</summary>
    public void OpenArgument(object? argument)
    {
        switch (argument)
        {
            case long l when l > 0: Open(l); break;
            case int i when i > 0: Open(i); break;
            case string s when long.TryParse(s, out var parsed) && parsed > 0: Open(parsed); break;
            case string s when !string.IsNullOrWhiteSpace(s): Open(0, s); break; // slug-only deep link
            case LawyerListItem item: Open(item.UserId, item.Slug); break;
            default: break; // OnAppearing then shows its honest "no lawyer selected" state
        }
    }

    // ────────────────────────── lifecycle ──────────────────────────

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        if (_ambient.IsCancellationRequested) _ambient = new CancellationTokenSource();
        EntranceAsync();
        StartAmbience();

        if (!_identityGiven)
        {
            // opened with no argument: a signed-in lawyer still lands on their own profile,
            // anyone else gets a plain explanation instead of a fabricated page.
            var session = _nav?.Current;
            if (session is { UserId: long uid } && uid > 0) _userId = uid;
            else
            {
                ShowError("مشخصی وکیل مورد نظر ارسال نشده است. از فهرست وکلا یک وکیل را انتخاب کنید.");
                return;
            }
        }

        if (_profile is null && !_loadAttempted && (_userId > 0 || !string.IsNullOrWhiteSpace(_slug)))
            await LoadAsync();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        try { _request?.Cancel(); } catch (ObjectDisposedException) { }
        _ambient.Cancel(); // aurora drift stops with the page
    }

    private async void EntranceAsync()
    {
        try
        {
            await UiMotion.RiseInAsync(HeaderCard, rise: 22, durationMs: 300);
            await ProfileStack.FadeToAsync(1, 240, Easing.CubicOut);
        }
        catch (Exception e) { Debug.WriteLine("entrance: " + e.Message); }
    }

    private void StartAmbience()
    {
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await AuroraIndigo.TranslateToAsync(22, 14, 5600, Easing.SinInOut);
            await AuroraIndigo.TranslateToAsync(0, 0, 5600, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(800, ct);
            await AuroraViolet.TranslateToAsync(-18, 20, 6400, Easing.SinInOut);
            await AuroraViolet.TranslateToAsync(0, 0, 6400, Easing.SinInOut);
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(1400, ct);
            await AuroraGold.ScaleToAsync(1.1, 5900, Easing.SinInOut);
            await AuroraGold.ScaleToAsync(1, 5900, Easing.SinInOut);
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(2100, ct);
            await AuroraCyan.TranslateToAsync(14, -16, 7200, Easing.SinInOut);
            await AuroraCyan.TranslateToAsync(0, 0, 7200, Easing.SinInOut);
        });
    }

    // ────────────────────────── load ──────────────────────────

    private async Task LoadAsync()
    {
        if (_loading) return;
        if (_userId <= 0 && string.IsNullOrWhiteSpace(_slug)) return;
        _loading = true;
        _loadAttempted = true;

        try { _request?.Cancel(); } catch (ObjectDisposedException) { }
        var cts = _request = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        ShowLoading();
        var token = await PeekTokenAsync() ?? string.Empty;

        try
        {
            var res = string.IsNullOrWhiteSpace(_slug)
                ? await _api.LawyerProfileAsync(_userId, token, cts.Token)
                : await _api.LawyerProfileBySlugAsync(_slug!, token, cts.Token);

            if (cts.IsCancellationRequested || !ReferenceEquals(_request, cts)) return;

            if (!res.Ok || res.UserId is not long uid)
            {
                _profile = null;
                ShowError(res.Message ??
                    "این پروفایل در دسترس نیست — فهرست تنها وکلای تأییدشده را نشان می‌دهد.");
                return;
            }

            _profile = res;
            _userId = uid;
            if (!string.IsNullOrWhiteSpace(res.Slug)) _slug = res.Slug;

            // wave 2: reviews ride along with the profile (failure is silent — the
            // section simply renders the honest empty state).
            _reviews = null;
            try { _reviews = await _api.ReviewsForLawyerAsync(uid, cts.Token); }
            catch (Exception re2) { Debug.WriteLine("reviews: " + re2); }
            if (cts.IsCancellationRequested || !ReferenceEquals(_request, cts)) return;

            Render();
        }
        catch (OperationCanceledException)
        {
            // a newer request owns the page now
        }
        catch (Exception e)
        {
            Debug.WriteLine("profile: " + e);
            if (!cts.IsCancellationRequested)
                ShowError("ارتباط با سرور برقرار نشد. اتصال اینترنت خود را بررسی کنید.");
        }
        finally
        {
            _loading = false;
            if (ReferenceEquals(_request, cts)) _request = null;
            cts.Dispose();
        }
    }

    private async Task<string?> PeekTokenAsync()
    {
        try
        {
            var session = _nav?.Current;
            if (!string.IsNullOrWhiteSpace(session?.Token)) return session!.Token;
            return await _tokens.GetTokenAsync();
        }
        catch (Exception e)
        {
            Debug.WriteLine("token: " + e.Message);
            return null;
        }
    }

    // ────────────────────────── states ──────────────────────────

    private void ShowLoading()
    {
        ProfileStack.Clear();

        var hero = Section(new VerticalStackLayout
        {
            Spacing = 12,
            Children =
            {
                MarketplaceUi.SkeletonDisc(96),
                MarketplaceUi.SkeletonLine(220, 16),
                MarketplaceUi.SkeletonLine(150, 12),
                MarketplaceUi.SkeletonLine(290, 12)
            }
        });

        var card = Section(new VerticalStackLayout
        {
            Spacing = 12,
            Children =
            {
                MarketplaceUi.SkeletonLine(240, 14),
                MarketplaceUi.SkeletonLine(320, 12),
                MarketplaceUi.SkeletonLine(190, 12)
            }
        });

        var ring = new ActivityIndicator
        {
            IsRunning = true,
            Color = Palette.Accent,
            HorizontalOptions = LayoutOptions.Center,
            Margin = new Thickness(0, 4, 0, 0)
        };

        ProfileStack.Children.Add(hero);
        ProfileStack.Children.Add(card);
        ProfileStack.Children.Add(ring);

        _ = UiMotion.RiseInAsync(hero, rise: 12, durationMs: 240);
        _ = UiMotion.RiseInAsync(card, delayMs: 90, rise: 12, durationMs: 240);
    }

    private void ShowError(string message)
    {
        ProfileStack.Clear();

        var notice = Section(new VerticalStackLayout
        {
            Spacing = 10,
            Children =
            {
                new Image { Source = ImageSource.FromFile("ic_warning.png"), WidthRequest = 26, HeightRequest = 26, HorizontalOptions = LayoutOptions.Center },
                new Label
                {
                    Text = message,
                    FontFamily = "VazirmatnMedium",
                    FontSize = 14,
                    LineHeight = 1.45,
                    HorizontalTextAlignment = TextAlignment.Center,
                    TextColor = Palette.Ink
                },
                new Label
                {
                    Text = "بازگشت به فهرست وکلا و انتخاب دوباره، معمول‌ترین راه‌حل است.",
                    Style = LawyersPage.GetStyle("Caption"),
                    HorizontalTextAlignment = TextAlignment.Center
                }
            }
        });

        var retry = LawyersPage.CtaBorder("تلاش دوباره", async () =>
        {
            _loadAttempted = false;
            await LoadAsync();
        }, height: 48);
        retry.MaximumWidthRequest = 260;
        retry.HorizontalOptions = LayoutOptions.Center;

        var stack = new VerticalStackLayout { Spacing = 14 };
        stack.Children.Add(notice);
        stack.Children.Add(retry);
        ProfileStack.Children.Add(stack);
        _ = UiMotion.RiseInAsync(stack, rise: 12, durationMs: 240);
    }

    // ────────────────────────── content ──────────────────────────

    private void Render()
    {
        var p = _profile;
        if (p is null) return;

        HeaderText.Text = string.IsNullOrWhiteSpace(p.DisplayName) ? "پروفایل وکیل" : p.DisplayName;
        HeaderSubtext.Text = string.IsNullOrWhiteSpace(p.City)
            ? "پروفایل عمومی درگاه وکلا"
            : $"پروفایل عمومی · {p.City}";

        ProfileStack.Clear();
        ProfileStack.Children.Add(BuildHero(p));

        if (p.IsSelf)
            ProfileStack.Children.Add(BuildOwnerBanner(p));

        ProfileStack.Children.Add(BuildPriceCard(p));
        ProfileStack.Children.Add(BuildTextSection("درباره‌ی وکیل", BuildBio(p)));

        var specialties = BuildChipSection("تخصص‌ها", (p.Specialties ?? Array.Empty<string>()).Select(SpecialtyNames.Of).ToArray());
        if (specialties is not null) ProfileStack.Children.Add(specialties);

        var languages = BuildChipSection("زبان‌ها", (p.Languages ?? Array.Empty<string>()).Select(SpecialtyNames.Of).ToArray());
        if (languages is not null) ProfileStack.Children.Add(languages);

        ProfileStack.Children.Add(BuildAvailability(p));
        ProfileStack.Children.Add(BuildReviewsSection());

        // honesty caption: everything above except the shield is lawyer-declared
        ProfileStack.Children.Add(new Label
        {
            Text = "خودشناسه / اعلام‌شده توسط خود وکیل — صحت متن‌ها بر عهده‌ی وکیل است. " +
                   "نشان «تأیید شده توسط وکیل‌جی‌پی» تنها بررسی پلتفرم را می‌رساند.",
            Style = LawyersPage.GetStyle("Caption"),
            LineHeight = 1.7,
            HorizontalTextAlignment = TextAlignment.Center,
            Margin = new Thickness(6, 4, 6, 0)
        });

        int i = 0;
        foreach (var child in ProfileStack.Children)
        {
            if (child is View v)
                _ = UiMotion.RiseInAsync(v, delayMs: (uint)(Math.Min(i, 6) * 70), rise: 12, durationMs: 230);
            i++;
        }
    }

    private View BuildHero(LawyerProfileResponse p)
    {
        var nameRow = new HorizontalStackLayout { Spacing = 8 };
        nameRow.Children.Add(new Label
        {
            Text = string.IsNullOrWhiteSpace(p.DisplayName) ? "وکیل" : p.DisplayName,
            FontFamily = "VazirmatnBold",
            FontSize = 21,
            VerticalOptions = LayoutOptions.Center,
            TextColor = Palette.Ink
        });
        if (string.Equals(p.VerificationStatus, "verified", StringComparison.OrdinalIgnoreCase))
            nameRow.Children.Add(MarketplaceUi.VerifiedBadge());

        var info = new VerticalStackLayout { Spacing = 4 };
        info.Children.Add(nameRow);

        if (!string.IsNullOrWhiteSpace(p.Title))
            info.Children.Add(new Label
            {
                Text = p.Title.Trim(),
                FontFamily = "VazirmatnMedium",
                FontSize = 14,
                TextColor = Palette.Accent
            });

        var meta = new List<string>();
        if (!string.IsNullOrWhiteSpace(p.City)) meta.Add($"شهر: {p.City.Trim()}");
        if (!string.IsNullOrWhiteSpace(p.Jurisdiction)) meta.Add($"حوزه‌ی وکالت: {p.Jurisdiction.Trim()}");
        if (p.ExperienceYears is int years && years > 0) meta.Add($"{LawyersPage.Persian(years)} سال سابقه");
        if (meta.Count > 0)
            info.Children.Add(new Label
            {
                Text = string.Join(" · ", meta),
                Style = LawyersPage.GetStyle("Caption"),
                LineHeight = 1.5
            });

        var grid = new Grid
        {
            ColumnDefinitions =
            {
                new ColumnDefinition(GridLength.Auto),
                new ColumnDefinition(GridLength.Star)
            },
            ColumnSpacing = 14
        };
        var avatar = LawyersPage.Disc(p.PhotoUrl, LawyersPage.Initials(p.DisplayName), 92, 26);
        grid.Children.Add(new Border
        {
            WidthRequest = 96,
            HeightRequest = 96,
            VerticalOptions = LayoutOptions.Start,
            BackgroundColor = Colors.Transparent,
            Stroke = string.Equals(p.VerificationStatus, "verified", StringComparison.OrdinalIgnoreCase)
                ? LawyersPage.GetBrush("GoldBrush")
                : new SolidColorBrush(Palette.Hairline),
            StrokeThickness = string.Equals(p.VerificationStatus, "verified", StringComparison.OrdinalIgnoreCase) ? 1.8 : 1,
            Padding = 2,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 48 },
            Content = avatar
        });
        grid.Children.Add(info);
        Grid.SetColumn(info, 1);

        return Section(grid);
    }

    /// <summary>Price + duration + the page's single primary action.</summary>
    private Border BuildPriceCard(LawyerProfileResponse p)
    {
        var stack = new VerticalStackLayout { Spacing = 8 };

        stack.Children.Add(new Label
        {
            Text = "مشاوره",
            FontFamily = "VazirmatnBold",
            FontSize = 15,
            TextColor = Palette.Ink
        });

        var duration = Persian(p.DurationMinutes ?? 45);
        stack.Children.Add(new Label
        {
            Text = p.PriceToman is int price && price > 0
                ? $"مشاوره {duration} دقیقه — {Persian(price)} تومان"
                : $"مشاوره {duration} دقیقه — قیمت توافقی",
            FontFamily = "VazirmatnMedium",
            FontSize = 14,
            LineHeight = 1.5,
            TextColor = Palette.IsDark ? Color.Parse("#F8E7A1") : Color.Parse("#9A741C")
        });

        stack.Children.Add(new Label
        {
            Text = "هزینه در لحظه‌ی ثبت درخواست مشاوره تأیید می‌شود؛ پرداخت در گام بعدی انجام می‌شود.",
            Style = LawyersPage.GetStyle("Caption"),
            LineHeight = 1.6
        });

        if (!p.IsSelf)
        {
            var cta = LawyersPage.CtaBorder(
                p.IsAvailable ? "رزرو مشاوره" : "در حال حاضر پذیرای رزرو نیست",
                () => BookAsync());
            if (!p.IsAvailable)
            {
                cta.Opacity = 0.55;
                cta.IsEnabled = false;
            }
            stack.Children.Add(cta);
        }

        return Section(stack);
    }

    /// <summary>Delegates to the coordinator (it owns create + payment routing) and surfaces
    /// the returned Persian error text verbatim — never a silent failure.</summary>
    private async Task BookAsync()
    {
        if (_bookRequested) return;
        if (_userId <= 0) return;
        _bookRequested = true;

        try
        {
            if (_nav is null)
            {
                await DisplayAlertAsync("رزرو مشاوره",
                    "مسئول ناوبری بازارگاه هنوز ثبت نشده است؛ امکان رزرو پس از اتصال هماهنگ‌کننده فعال می‌شود.",
                    "باشه");
                return;
            }

            var error = await _nav.StartConsultationAsync(_userId, _ambient.Token);
            if (error is not null)
                await DisplayAlertAsync("رزرو مشاوره", error, "باشه");
            // on success the coordinator swaps the page away — nothing left to render here
        }
        catch (OperationCanceledException) { /* the page was closed mid-request */ }
        catch (Exception e)
        {
            Debug.WriteLine("book: " + e);
            await DisplayAlertAsync("رزرو مشاوره",
                "برقراری ارتباط ممکن نشد؛ چند لحظه دیگر تلاش کنید.", "باشه");
        }
        finally
        {
            _bookRequested = false;
        }
    }

    /// <summary>Owner-only strip: the server verdict + admin note + the V1 editor stub.</summary>
    private Border BuildOwnerBanner(LawyerProfileResponse p)
    {
        var stack = new VerticalStackLayout { Spacing = 8 };

        stack.Children.Add(new Label
        {
            Text = "این پروفایل شماست",
            FontFamily = "VazirmatnBold",
            FontSize = 14,
            TextColor = Palette.Ink
        });

        stack.Children.Add(new Label
        {
            Text = $"وضعیت تأیید: {VerificationLabel(p.VerificationStatus)}",
            FontFamily = "VazirmatnMedium",
            FontSize = 13,
            TextColor = VerificationColor(p.VerificationStatus)
        });

        if (!string.IsNullOrWhiteSpace(p.VerificationNote))
            stack.Children.Add(new Label
            {
                Text = $"یادداشت کارشناس: {p.VerificationNote.Trim()}",
                Style = LawyersPage.GetStyle("Caption"),
                LineHeight = 1.6
            });

        stack.Children.Add(new Label
        {
            Text = "هر ویرایش پروفایل، وضعیت تأیید را به «در صف بررسی» برمی‌گرداند.",
            Style = LawyersPage.GetStyle("Caption"),
            LineHeight = 1.6
        });

        // V1: the editor itself is Agent 10's LawyerOffice — this button only says so.
        var edit = LawyersPage.CtaBorder("ویرایش پروفایل", () => DisplayAlertAsync(
            "ویرایش پروفایل",
            "ویرایش در گام بعدی فعال می‌شود — میز کار وکیل این دکمه را به فرم پروفایل وصل می‌کند.",
            "باشه"), height: 46);
        stack.Children.Add(edit);

        return new Border
        {
            Style = LawyersPage.GetStyle("GlassCard"),
            HorizontalOptions = LayoutOptions.Center,
            MaximumWidthRequest = SectionMaxWidth,
            Stroke = new SolidColorBrush(Palette.IsDark ? Color.Parse("#2A3C5E") : Color.Parse("#DDE3FF")),
            Content = stack
        };
    }

    // ────────────────────────── reviews (wave 2) ──────────────────────────

    private View BuildReviewsSection()
    {
        var stack = new VerticalStackLayout { Spacing = 8 };
        var head = new HorizontalStackLayout { Spacing = 8 };
        head.Children.Add(SectionTitle("نظرات مشتریان"));
        var r = _reviews;
        if (r is { Ok: true, Count: > 0 })
        {
            var avg = Math.Round(r.Average ?? 0, 1);
            var filled = (int)avg;
            var avgText = new string(avg.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture)
                .Select(ch => ch is >= '0' and <= '9' ? (char)('۰' + (ch - '0')) : ch).ToArray());
            head.Children.Add(new Label
            {
                Text = new string('★', filled) + new string('☆', 5 - filled) +
                       "  " + avgText + " (از " + Persian(r.Count) + " نظر)",
                FontFamily = "VazirmatnMedium", FontSize = 12.5,
                TextColor = Palette.Token("Gold"),
                VerticalOptions = LayoutOptions.Center
            });
        }
        stack.Children.Add(head);

        var rows = r is { Ok: true, Reviews: { Length: > 0 } list } ? list : Array.Empty<ReviewDto>();
        if (rows.Length == 0)
        {
            stack.Children.Add(new Label
            {
                Text = r?.Ok == true
                    ? "هنوز نظری ثبت نشده است. نظر فقط پس از پایان مشاورهی پرداخت‌شده قابل ثبت است."
                    : "نظرات در حال حاضر دسترس نیستند.",
                Style = LawyersPage.GetStyle("Caption")
            });
        }
        foreach (var item in rows.Take(10))
        {
            var row = new VerticalStackLayout { Spacing = 2 };
            row.Children.Add(new Label
            {
                Text = new string('★', item.Rating) + new string('☆', 5 - item.Rating) +
                       "   " + (item.ReviewerName ?? "مشتری"),
                FontFamily = "VazirmatnMedium", FontSize = 13,
                TextColor = Palette.Ink
            });
            if (!string.IsNullOrWhiteSpace(item.Comment))
                row.Children.Add(new Label
                {
                    Text = item.Comment, FontFamily = "VazirmatnRegular", FontSize = 12.5,
                    TextColor = Palette.Muted, LineBreakMode = LineBreakMode.WordWrap
                });
            stack.Children.Add(row);
            stack.Children.Add(new BoxView { HeightRequest = 1, Color = Palette.Hairline });
        }
        if (rows.Length > 10)
            stack.Children.Add(new Label
            {
                Text = "+ " + Persian(rows.Length) + " مورد (نمایش 10 تای تازه)",
                Style = LawyersPage.GetStyle("Caption")
            });
        return Section(stack);
    }

    private Border BuildTextSection(string title, View body)
    {
        var stack = new VerticalStackLayout { Spacing = 8 };
        stack.Children.Add(SectionTitle(title));
        stack.Children.Add(body);
        return Section(stack);
    }

    private Border? BuildChipSection(string title, string[]? values)
    {
        var list = MarketplaceUi.Clean(values);
        if (list.Length == 0) return null;

        var wrap = new FlexLayout
        {
            Direction = Microsoft.Maui.Layouts.FlexDirection.Row,
            Wrap = Microsoft.Maui.Layouts.FlexWrap.Wrap,
            Margin = new Thickness(-3)
        };
        foreach (var v in list)
            wrap.Children.Add(MarketplaceUi.MiniChip(v));

        var stack = new VerticalStackLayout { Spacing = 8 };
        stack.Children.Add(SectionTitle(title));
        stack.Children.Add(wrap);
        return Section(stack);
    }

    private static Label SectionTitle(string title) => new Label
    {
        Text = title,
        FontFamily = "VazirmatnBold",
        FontSize = 14,
        TextColor = Palette.Ink
    };

    private Border Section(View content) => new Border
    {
        Style = LawyersPage.GetStyle("GlassCard"),
        HorizontalOptions = LayoutOptions.Center,
        MaximumWidthRequest = SectionMaxWidth,
        Content = content
    };

    private static View BuildBio(LawyerProfileResponse p)
    {
        if (string.IsNullOrWhiteSpace(p.Bio))
            return new Label
            {
                Text = "این وکیل هنوز متن معرفی منتشر نکرده است.",
                Style = LawyersPage.GetStyle("Caption"),
                LineHeight = 1.6
            };

        return new Label
        {
            Text = p.Bio.Trim(),
            FontFamily = "VazirmatnRegular",
            FontSize = 14,
            LineHeight = 1.75,
            TextColor = Palette.Ink
        };
    }

    private Border BuildAvailability(LawyerProfileResponse p)
    {
        var dotColor = p.IsAvailable ? Color.Parse("#34D399") : Palette.Muted;

        var row = new HorizontalStackLayout { Spacing = 8 };
        row.Children.Add(new BoxView
        {
            Color = dotColor,
            WidthRequest = 10,
            HeightRequest = 10,
            CornerRadius = 5,
            VerticalOptions = LayoutOptions.Center
        });
        row.Children.Add(new Label
        {
            Text = p.IsAvailable ? "در حال حاضر پذیرای مشاوره است" : "در حال حاضر پاسخگو نیست",
            FontFamily = "VazirmatnMedium",
            FontSize = 13.5,
            VerticalOptions = LayoutOptions.Center,
            TextColor = dotColor
        });

        var stack = new VerticalStackLayout { Spacing = 8 };
        stack.Children.Add(SectionTitle("وضعیت پاسخگویی"));
        stack.Children.Add(row);

        if (!string.IsNullOrWhiteSpace(p.AvailabilityNote))
            stack.Children.Add(new Label
            {
                Text = p.AvailabilityNote.Trim(),
                Style = LawyersPage.GetStyle("Caption"),
                LineHeight = 1.7
            });

        return Section(stack);
    }

    // TapBorder already provides press-pop + haptic feedback for this chip.
    private async void OnBackClicked(object? sender, TappedEventArgs e)
    {
        // Real back stack: pop back to the directory we were pushed from; if we
        // were deep-linked as a root, re-route there explicitly.
        _ambient.Cancel();
        if (_nav is null)
        {
            await DisplayAlertAsync("جای‌گیری",
                "مسئول ناوبری بازارگاه هنوز ثبت نشده است.", "باشه");
            return;
        }
        try { _nav.NavigateBack(MarketplaceRoute.Lawyers); }
        catch (Exception ex) { Debug.WriteLine("back: " + ex.Message); }
    }

    // ────────────────────────── copy helpers ──────────────────────────

    private static string VerificationLabel(string? status) => status switch
    {
        "verified" => "تأییدشده توسط پلتفرم",
        "pending" => "در صف بررسی اسناد",
        "rejected" => "تأیید نشد",
        "suspended" => "تأیید معلق شده",
        null or "" => "نامشخص",
        var other => other
    };

    private static Color VerificationColor(string? status) => status switch
    {
        "verified" => Color.Parse("#34D399"),
        "pending" => Color.Parse("#F59E0B"),
        "rejected" or "suspended" => Color.Parse("#EF4444"),
        _ => Palette.Muted
    };

    private static string Persian(long value) => LawyersPage.Persian(value);
}
