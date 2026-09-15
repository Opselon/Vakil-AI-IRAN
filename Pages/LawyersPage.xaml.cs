using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Rendering;
using Vakil_AI_IRAN.Services;   // IMarketplaceRouteArgument (coordinator hand-off seam)
using VakilAI.Application.Contracts;

namespace Vakil_AI_IRAN.Pages;

/// <summary>
/// Lawyer marketplace directory (Agent 5). Renders ONLY what <see cref="IMarketplaceApi"/>
/// returns: verified lawyers from /lawyers/list plus /lawyers/categories. Nothing is
/// invented — no seeded rows, no rating/review block (that infrastructure does not exist
/// in V1). Cards are built in code-behind (the ChatPage row pattern) so a card can carry
/// avatar, chips and badges without a CollectionView template fighting RTL.
/// All four states are designed: loading (skeletons), content, empty, error + retry.
/// </summary>
public partial class LawyersPage : ContentPage, IMarketplaceRouteArgument
{
    private const int CardMaxWidth = 520;
    private const int DebounceMs = 350;

    private static readonly (string Key, string Label)[] Sorts =
    {
        ("experience", "بیشترین سابقه"),
        ("price_asc", "ارزان‌ترین مشاوره"),
        ("price_desc", "گران‌ترین مشاوره"),
        ("recent", "جدیدترین‌ها")
    };

    private static readonly (int? Cap, string Label)[] PriceBands =
    {
        (null, "بدون سقف قیمت"),
        (200_000, "تا ۲۰۰٬۰۰۰ تومان"),
        (500_000, "تا ۵۰۰٬۰۰۰ تومان"),
        (1_000_000, "تا ۱٬۰۰۰٬۰۰۰ تومان"),
        (3_000_000, "تا ۳٬۰۰۰٬۰۰۰ تومان")
    };

    private readonly IMarketplaceApi _api;
    private readonly ITokenStore _tokens;

    /// <summary>Resolved best-effort: Agent 10 registers it. The directory still browses
    /// without it — only the cross-page hand-off is disabled.</summary>
    private readonly IMarketplaceCoordinator? _nav;

    /// <summary>Ambient loops (aurora drift + skeleton pulse) — cancelled on disappear.</summary>
    private CancellationTokenSource _ambient = new();
    /// <summary>Search debounce timer; superseded by every keystroke.</summary>
    private CancellationTokenSource _debounce = new();
    /// <summary>In-flight list request; one at a time, cancelled on disappear/supersede.</summary>
    private CancellationTokenSource? _request;

    private readonly List<LawyerListItem> _lawyers = new();
    private readonly List<(Border Chip, string Slug)> _chips = new();
    private LawyerCategory[] _categories = Array.Empty<LawyerCategory>();

    private string _categorySlug = "";          // "" = the «همه» chip
    private string _sort = "experience";
    private int? _maxPrice;
    private bool _loading;
    private bool _reloadQueued;
    private bool _busyOpen;                     // one card tap at a time
    private bool _started;

    public LawyersPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _api = sp.GetRequiredService<IMarketplaceApi>();
        _tokens = sp.GetRequiredService<ITokenStore>();
        _nav = TryResolveOptional<IMarketplaceCoordinator>();
        BuildFilterPickers();

        // Tab root: the bottom bar is this screen's chrome. Without the
        // coordinator there is nowhere to navigate — hide it (legacy builds).
        if (_nav is null)
            TabBar.IsVisible = false;
        else
        {
            TabBar.Active = TabKey.Lawyers;
            TabBar.TabSelected += OnTabSelected;
        }
        Application.Current!.RequestedThemeChanged += OnAppThemeChanged;
    }

    private void OnAppThemeChanged(object? sender, AppThemeChangedEventArgs e)
    {
        if (Handler is not null) TabBar.ApplyTheme();
    }

    protected override void OnHandlerChanging(HandlerChangingEventArgs args)
    {
        base.OnHandlerChanging(args);
        if (args.NewHandler is null)
            Application.Current!.RequestedThemeChanged -= OnAppThemeChanged;
    }

    private void OnTabSelected(TabKey key)
    {
        var nav = _nav;
        if (nav is null) return;
        switch (key)
        {
            case TabKey.Home: nav.Navigate(MarketplaceRoute.Home); break;
            case TabKey.Chat: nav.OpenChat(); break;
            case TabKey.Lawyers: break; // already here
            case TabKey.Account: _ = AccountMenu.OpenAsync(this, nav); break;
        }
    }

    /// <summary>Optional service: never crash a page because the coordinator is not wired yet.</summary>
    internal static T? TryResolveOptional<T>() where T : class
    {
        try { return MauiProgram.Services.GetRequiredService<T>(); }
        catch (Exception e)
        {
            Debug.WriteLine($"optional service {typeof(T).Name} unavailable: {e.Message}");
            return null;
        }
    }

    /// <summary>
    /// Deep-link / menu hand-off from the coordinator (the route argument may carry a
    /// starting category slug). Applied before the page becomes the window root, so the
    /// first load is already filtered. Optional — a plain Navigate(Lawyers) works too.
    /// </summary>
    public void ReceiveRouteArgument(object? argument)
    {
        switch (argument)
        {
            case string s when !string.IsNullOrWhiteSpace(s):
                _categorySlug = s.Trim();
                break;
            case LawyerCategory cat:
                _categorySlug = cat.Slug;
                break;
            default:
                break;
        }
    }

    // ────────────────────────── lifecycle ──────────────────────────

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        _ambient = new CancellationTokenSource();
        EntranceAsync();
        StartAmbience();

        if (_started)
        {
            // returning from a profile (the coordinator swaps root pages) — refresh so
            // availability and price stay honest
            await ReloadAsync();
            return;
        }
        _started = true;

        ShowLoading();
        await LoadCategoriesAsync();
        await ReloadAsync();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        CancelRequest();
        CancelDebounce();
        _ambient.Cancel(); // aurora drift + skeleton pulses stop with the page
    }

    private async void EntranceAsync()
    {
        try
        {
            await UiMotion.RiseInAsync(HeaderCard, rise: 22, durationMs: 300);
            await ResultsStack.FadeToAsync(1, 240, Easing.CubicOut);
        }
        catch (Exception e) { Debug.WriteLine("entrance: " + e.Message); }
    }

    /// <summary>The ActivationPage aurora drift: four blobs on slow offset phases.</summary>
    private void StartAmbience()
    {
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await AuroraIndigo.TranslateToAsync(24, 16, 5400, Easing.SinInOut);
            await AuroraIndigo.TranslateToAsync(0, 0, 5400, Easing.SinInOut);
            ct.ThrowIfCancellationRequested();
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(900, ct);
            await AuroraViolet.TranslateToAsync(-20, 22, 6300, Easing.SinInOut);
            await AuroraViolet.TranslateToAsync(0, 0, 6300, Easing.SinInOut);
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(1500, ct);
            await AuroraGold.ScaleToAsync(1.12, 5800, Easing.SinInOut);
            await AuroraGold.ScaleToAsync(1, 5800, Easing.SinInOut);
        });
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            await UiMotion.SleepAsync(2200, ct);
            await AuroraCyan.TranslateToAsync(16, -18, 7000, Easing.SinInOut);
            await AuroraCyan.TranslateToAsync(0, 0, 7000, Easing.SinInOut);
        });
    }

    // ────────────────────────── data ──────────────────────────

    private async Task LoadCategoriesAsync()
    {
        try
        {
            var res = await _api.CategoriesAsync(await PeekTokenAsync(), _ambient.Token);
            _categories = res.Ok ? res.Categories ?? Array.Empty<LawyerCategory>() : Array.Empty<LawyerCategory>();
            SpecialtyNames.Warm(_categories);   // slug→Persian map for cards + profile chips
        }
        catch (OperationCanceledException) { return; }
        catch (Exception e)
        {
            Debug.WriteLine("categories: " + e.Message);
            _categories = Array.Empty<LawyerCategory>();   // strip stays hidden — search still works
        }
        await MainThread.InvokeOnMainThreadAsync(RenderCategories);
    }

    /// <summary>
    /// Serialized reload: a request that starts while one is in flight sets
    /// <see cref="_reloadQueued"/> instead of racing it, so the newest filter state wins.
    /// </summary>
    private async Task ReloadAsync()
    {
        if (_loading)
        {
            _reloadQueued = true;
            return;
        }
        _loading = true;
        try
        {
            do
            {
                _reloadQueued = false;
                await LoadOnceAsync();
            }
            while (_reloadQueued && !_ambient.IsCancellationRequested);
        }
        finally
        {
            _loading = false;
            _reloadQueued = false;
        }
    }

    private async Task LoadOnceAsync()
    {
        CancelRequest();
        var cts = _request = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        // snapshot the filter state this request is made with
        var query = NullIfBlank(SearchEntry.Text);
        var category = NullIfBlank(_categorySlug);
        var sort = _sort;
        var maxPrice = _maxPrice;
        var token = await PeekTokenAsync();

        try
        {
            var res = await _api.LawyersAsync(
                new LawyerListRequest(
                    Token: token,
                    Query: query,
                    Category: category,
                    City: null,
                    MaxPrice: maxPrice,
                    Sort: sort),
                cts.Token);

            if (cts.IsCancellationRequested || !ReferenceEquals(_request, cts)) return;

            if (query != NullIfBlank(SearchEntry.Text) || category != NullIfBlank(_categorySlug)
                || sort != _sort || maxPrice != _maxPrice)
            {
                _reloadQueued = true;   // the filters moved while we waited — ask again
                return;
            }

            if (!res.Ok)
            {
                ShowError(res.Message ?? "دریافت فهرست وکلا ممکن نشد. لطفاً دوباره تلاش کنید.");
                return;
            }

            _lawyers.Clear();
            _lawyers.AddRange(res.Lawyers ?? Array.Empty<LawyerListItem>());
            RenderResults(res.Total);
        }
        catch (OperationCanceledException)
        {
            // superseded by a newer keystroke, or the page closed — no state change
        }
        catch (Exception e)
        {
            Debug.WriteLine("lawyers: " + e);
            if (!cts.IsCancellationRequested)
                ShowError("ارتباط با سرور برقرار نشد. اتصال اینترنت خود را بررسی کنید.");
        }
        finally
        {
            if (ReferenceEquals(_request, cts)) _request = null;
            cts.Dispose();
        }
    }

    private void CancelRequest()
    {
        var cts = _request;
        if (cts is null) return;
        _request = null;
        try { cts.Cancel(); } catch (ObjectDisposedException) { /* already finished */ }
    }

    private void CancelDebounce()
    {
        var cts = _debounce;
        _debounce = new CancellationTokenSource();
        // cancel only: a pending Task.Delay still holds a registration on it and the
        // GC finalizes it once the cancelled delay unwinds (same pattern as ActivationPage)
        try { cts.Cancel(); } catch (ObjectDisposedException) { }
    }

    private async Task<string?> PeekTokenAsync()
    {
        // An absent token is honest: the directory endpoints take it optionally, and a
        // signed-out or legacy-activation visitor simply browses the public list.
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

    private static string? NullIfBlank(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    // ────────────────────────── header controls ──────────────────────────

    private void BuildFilterPickers()
    {
        foreach (var (_, label) in Sorts) SortPicker.Items.Add(label);
        SortPicker.SelectedIndex = 0;
        foreach (var (_, label) in PriceBands) PricePicker.Items.Add(label);
        PricePicker.SelectedIndex = 0;
        FilterRow.IsVisible = true;
    }

    private void RenderCategories()
    {
        CategoryChips.Children.Clear();
        _chips.Clear();
        CategoryStrip.IsVisible = _categories.Length > 0;
        if (_categories.Length == 0) return;

        CategoryChips.Children.Add(MakeCategoryChip("همه", ""));
        foreach (var c in _categories)
        {
            var label = string.IsNullOrWhiteSpace(c.NameFa) ? (c.NameEn ?? c.Slug) : c.NameFa;
            CategoryChips.Children.Add(MakeCategoryChip(label, c.Slug));
        }
    }

    private Border MakeCategoryChip(string label, string slug)
    {
        var text = new Label
        {
            Text = label,
            FontFamily = "VazirmatnMedium",
            FontSize = 12.5,
            VerticalOptions = LayoutOptions.Center
        };
        var chip = new Border
        {
            Style = GetStyle("MenuChip"),
            Content = text
        };
        _chips.Add((chip, slug));
        PaintChip(chip, text, active: slug == _categorySlug);

        var captured = slug;
        var tap = new TapGestureRecognizer();
        tap.Tapped += async (_, _) =>
        {
            if (_categorySlug == captured) return;
            _categorySlug = captured;
            RepaintChips();
            _ = UiMotion.PressPopAsync(chip);
            ShowLoading();
            await ReloadAsync();
        };
        chip.GestureRecognizers.Add(tap);

        var index = CategoryChips.Children.Count;
        _ = UiMotion.RiseInAsync(chip, delayMs: (uint)(index * 40), rise: 8, durationMs: 190);
        return chip;
    }

    private void RepaintChips()
    {
        foreach (var (chip, slug) in _chips)
        {
            if (chip.Content is Label label)
                PaintChip(chip, label, slug == _categorySlug);
        }
    }

    /// <summary>Selected chip = gradient CTA surface; unselected = plain MenuChip.</summary>
    private static void PaintChip(Border chip, Label text, bool active)
    {
        if (active)
        {
            chip.Background = GetBrush("CtaBrush");
            chip.Stroke = new SolidColorBrush(Color.Parse("#66FFFFFF"));
            chip.StrokeThickness = 1;
            text.TextColor = Color.Parse("#FFFFFF");
        }
        else
        {
            chip.Background = new SolidColorBrush(Palette.IsDark
                ? Color.Parse("#141F33")    // SurfaceElevatedDark
                : Color.Parse("#FFFFFF"));  // SurfaceLightAlt
            chip.Stroke = new SolidColorBrush(Palette.Hairline);
            chip.StrokeThickness = 1;
            text.TextColor = Palette.IsDark ? Color.Parse("#A5B4FC") : Color.Parse("#3730A3");
        }
    }

    private async void OnSearchTextChanged(object? sender, TextChangedEventArgs e)
    {
        // ~350ms debounce: every keystroke supersedes the pending request instead of
        // firing one list call per character.
        CancelDebounce();
        var cts = _debounce;
        try
        {
            await Task.Delay(DebounceMs, cts.Token);
        }
        catch (OperationCanceledException) { return; }
        if (!ReferenceEquals(_debounce, cts)) return;  // a newer keystroke owns the refresh
        ShowLoading(skeletons: 2);
        await ReloadAsync();
    }

    private async void OnSearchCompleted(object? sender, EventArgs e)
    {
        CancelDebounce();
        SearchEntry.Unfocus();
        ShowLoading();
        await ReloadAsync();
    }

    private async void OnSortChanged(object? sender, EventArgs e)
    {
        var i = SortPicker.SelectedIndex;
        if (i < 0 || i >= Sorts.Length) return;
        _sort = Sorts[i].Key;
        ShowLoading();
        await ReloadAsync();
    }

    private async void OnPriceChanged(object? sender, EventArgs e)
    {
        var i = PricePicker.SelectedIndex;
        if (i < 0 || i >= PriceBands.Length) return;
        _maxPrice = PriceBands[i].Cap;
        ShowLoading();
        await ReloadAsync();
    }

    private async Task ExplainMissingCoordinatorAsync()
    {
        // Pages never swap Window.Page themselves — navigation is the coordinator's job.
        await DisplayAlertAsync("جای‌گیری",
            "مسئول ناوبری بازارگاه هنوز در MauiProgram ثبت نشده است. این صفحه پس از اتصال هماهنگ‌کننده باز می‌شود.",
            "باشه");
    }

    // ────────────────────────── the four states ──────────────────────────

    private void ShowLoading(int skeletons = 4)
    {
        ResultsStack.Clear();
        CountChip.IsVisible = false;
        for (int i = 0; i < skeletons; i++)
            ResultsStack.Children.Add(BuildSkeletonCard(i));
    }

    private void ShowError(string message)
    {
        ResultsStack.Clear();
        CountChip.IsVisible = false;

        var notice = new Border
        {
            Style = GetStyle("GlassCard"),
            MaximumWidthRequest = CardMaxWidth,
            HorizontalOptions = LayoutOptions.Center,
            Content = new VerticalStackLayout
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
                        Text = "این خطا به معنی نبودِ وکیل نیست — دوباره تلاش کنید.",
                        Style = GetStyle("Caption"),
                        HorizontalTextAlignment = TextAlignment.Center
                    }
                }
            }
        };

        var retry = CtaBorder("تلاش دوباره", async () =>
        {
            ShowLoading();
            await ReloadAsync();
        });

        var stack = new VerticalStackLayout { Spacing = 14 };
        stack.Children.Add(notice);
        stack.Children.Add(retry);
        ResultsStack.Children.Add(stack);
        _ = UiMotion.RiseInAsync(stack, rise: 12, durationMs: 240);
    }

    private void ShowEmpty()
    {
        ResultsStack.Clear();
        CountChip.IsVisible = false;

        var plate = new Border
        {
            Style = GetStyle("IconPlate"),
            WidthRequest = 62,
            HeightRequest = 62,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 31 },
            HorizontalOptions = LayoutOptions.Center,
            Content = new Image
            {
                Source = "ic_shield.png",
                WidthRequest = 30,
                HeightRequest = 30,
                HorizontalOptions = LayoutOptions.Center,
                VerticalOptions = LayoutOptions.Center
            }
        };
        SemanticProperties.SetDescription(plate, "نشان تأیید پلتفرم");

        var card = new Border
        {
            Style = GetStyle("GlassCard"),
            MaximumWidthRequest = CardMaxWidth,
            HorizontalOptions = LayoutOptions.Center,
            Content = new VerticalStackLayout
            {
                Spacing = 8,
                Children =
                {
                    new Label
                    {
                        Text = "هنوز وکیل تأییدشده‌ای در این دسته وجود ندارد…",
                        FontFamily = "VazirmatnBold",
                        FontSize = 16,
                        LineHeight = 1.4,
                        HorizontalTextAlignment = TextAlignment.Center,
                        TextColor = Palette.Ink
                    },
                    new Label
                    {
                        Text = "این فهرست تنها وکلای تأییدشده را نشان می‌دهد و خالی بودن آن طبیعی است؛ " +
                               "برگه‌ی «افزودن وکیل» و بررسی اسناد پس از راه‌افتادن میز کار وکیل فعال می‌شود.",
                        Style = GetStyle("Caption"),
                        LineHeight = 1.7,
                        HorizontalTextAlignment = TextAlignment.Center
                    }
                }
            }
        };

        var stack = new VerticalStackLayout { Spacing = 16, Padding = new Thickness(0, 26, 0, 10) };
        stack.Children.Add(plate);
        stack.Children.Add(card);
        ResultsStack.Children.Add(stack);
        _ = UiMotion.RiseInAsync(stack, rise: 14, durationMs: 280);
    }

    private void RenderResults(int total)
    {
        if (_lawyers.Count == 0)
        {
            ShowEmpty();
            return;
        }

        ResultsStack.Clear();
        CountChip.IsVisible = true;
        CountChipLabel.Text = $"{Persian(Math.Max(total, _lawyers.Count))} وکیل";

        // one muted roadmap line — V1 never renders a rating or review block
        ResultsStack.Children.Add(new Label
        {
            Text = "نقشه راه: امتیاز و نظرات پس از تکمیل زیرساخت افزوده می‌شود",
            Style = GetStyle("Caption"),
            HorizontalTextAlignment = TextAlignment.Center,
            Opacity = 0.8
        });

        int i = 0;
        foreach (var lawyer in _lawyers)
        {
            var card = BuildLawyerCard(lawyer);
            ResultsStack.Children.Add(card);
            _ = UiMotion.RiseInAsync(card, delayMs: (uint)(Math.Min(i, 6) * 70), rise: 12, durationMs: 230);
            i++;
        }

        // a new filter set starts reading from the top
        _ = ResultsScroll.ScrollToAsync(0, 0, true);
    }

    // ────────────────────────── lawyer card ──────────────────────────

    private View BuildLawyerCard(LawyerListItem l)
    {
        var body = BuildCardBody(l);
        var grid = new Grid
        {
            ColumnDefinitions =
            {
                new ColumnDefinition(GridLength.Auto),
                new ColumnDefinition(GridLength.Star)
            },
            ColumnSpacing = 12
        };
        grid.Children.Add(BuildAvatar(l)); // column 0 renders rightmost under RTL flow
        grid.Children.Add(body);
        Grid.SetColumn(body, 1);

        var card = new Border
        {
            Style = GetStyle("GlassCard"),
            MaximumWidthRequest = CardMaxWidth,
            HorizontalOptions = LayoutOptions.Center,
            Content = grid
        };

        var tap = new TapGestureRecognizer();
        tap.Tapped += async (_, _) => await OpenProfileAsync(l, card);
        card.GestureRecognizers.Add(tap);
        SemanticProperties.SetDescription(card, $"{l.DisplayName} — {MetaLine(l)} — {PriceLine(l)}");
        return card;
    }

    private async Task OpenProfileAsync(LawyerListItem l, Border card)
    {
        if (_busyOpen) return;
        _busyOpen = true;
        _ = UiMotion.PressPopAsync(card);
        try
        {
            _ = card.FadeToAsync(0.6, 110, Easing.CubicIn);
            if (_nav is null)
            {
                await ExplainMissingCoordinatorAsync();
                return;
            }

            // the coordinator owns every cross-page move (it swaps the window root and
            // hands the userId over through IMarketplaceRouteArgument)
            _nav.Navigate(MarketplaceRoute.LawyerProfile, l.UserId);
        }
        catch (Exception e)
        {
            Debug.WriteLine("open profile: " + e);
            await DisplayAlertAsync("پروفایل وکیل", "باز کردن پروفایل ممکن نشد. دوباره تلاش کنید.", "باشه");
        }
        finally
        {
            _ = card.FadeToAsync(1, 220, Easing.CubicOut);
            _busyOpen = false;
        }
    }

    /// <summary>Published photo when the lawyer uploaded one (initials stay underneath, so
    /// a dead URL degrades to initials instead of an empty circle). Never a stock face.</summary>
    private static View BuildAvatar(LawyerListItem l)
    {
        var verified = string.Equals(l.VerificationStatus, "verified", StringComparison.OrdinalIgnoreCase);

        return new Border
        {
            WidthRequest = 64,
            HeightRequest = 64,
            VerticalOptions = LayoutOptions.Start,
            BackgroundColor = Colors.Transparent,
            Stroke = verified ? GetBrush("GoldBrush") : new SolidColorBrush(Palette.Hairline),
            StrokeThickness = verified ? 1.6 : 1,
            Padding = 2,
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 32 },
            Content = Disc(l.PhotoUrl, Initials(l.DisplayName), 60, 19)
        };
    }

    /// <summary>Shared avatar disc for both pages: initials plate + optional photo clipped
    /// into the same circle. A dead URL degrades to the initials plate underneath.</summary>
    internal static View Disc(string? photoUrl, string initials, double size, double initialsSize)
    {
        var grid = new Grid
        {
            WidthRequest = size,
            HeightRequest = size,
            BackgroundColor = Colors.Transparent,
            Clip = new Microsoft.Maui.Controls.Shapes.EllipseGeometry
            {
                Center = new Point(size / 2, size / 2),
                RadiusX = size / 2,
                RadiusY = size / 2
            }
        };

        grid.Children.Add(new Border
        {
            StrokeThickness = 0,
            Background = GetBrush("HeaderGradientBrush"),
            StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = size / 2 },
            Content = new Label
            {
                Text = initials,
                FontFamily = "VazirmatnBold",
                FontSize = initialsSize,
                TextColor = Color.Parse("#FFFFFF"),
                HorizontalOptions = LayoutOptions.Center,
                VerticalOptions = LayoutOptions.Center
            }
        });

        if (!string.IsNullOrWhiteSpace(photoUrl))
        {
            grid.Children.Add(new Image
            {
                Source = photoUrl.Trim(),
                Aspect = Aspect.AspectFill,
                WidthRequest = size,
                HeightRequest = size,
                HorizontalOptions = LayoutOptions.Center,
                VerticalOptions = LayoutOptions.Center
            });
        }
        return grid;
    }

    private static View BuildCardBody(LawyerListItem l)
    {
        var stack = new VerticalStackLayout { Spacing = 5 };

        var nameRow = new HorizontalStackLayout { Spacing = 7 };
        nameRow.Children.Add(new Label
        {
            Text = string.IsNullOrWhiteSpace(l.DisplayName) ? "وکیل" : l.DisplayName,
            FontFamily = "VazirmatnBold",
            FontSize = 15.5,
            VerticalOptions = LayoutOptions.Center,
            LineBreakMode = LineBreakMode.TailTruncation,
            TextColor = Palette.Ink
        });
        if (string.Equals(l.VerificationStatus, "verified", StringComparison.OrdinalIgnoreCase))
            nameRow.Children.Add(MarketplaceUi.VerifiedBadge());
        stack.Children.Add(nameRow);

        if (!string.IsNullOrWhiteSpace(l.Title))
            stack.Children.Add(new Label
            {
                Text = l.Title.Trim(),
                FontFamily = "VazirmatnMedium",
                FontSize = 12.5,
                TextColor = Palette.Accent,
                LineBreakMode = LineBreakMode.TailTruncation
            });

        var meta = MetaLine(l);
        if (meta.Length > 0)
            stack.Children.Add(new Label
            {
                Text = meta,
                Style = GetStyle("Caption"),
                LineBreakMode = LineBreakMode.TailTruncation
            });

        var chips = BuildSpecialtyChips(l.Specialties);
        if (chips is not null) stack.Children.Add(chips);

        stack.Children.Add(new Label
        {
            Text = PriceLine(l),
            FontFamily = "VazirmatnMedium",
            FontSize = 13,
            TextColor = Palette.IsDark ? Color.Parse("#F8E7A1") : Color.Parse("#9A741C")
        });

        var statusRow = new HorizontalStackLayout { Spacing = 6, Margin = new Thickness(0, 3, 0, 0) };
        var statusColor = l.IsAvailable ? Color.Parse("#34D399") : Palette.Muted;
        statusRow.Children.Add(new BoxView
        {
            Color = statusColor,
            WidthRequest = 8,
            HeightRequest = 8,
            CornerRadius = 4,
            VerticalOptions = LayoutOptions.Center
        });
        statusRow.Children.Add(new Label
        {
            Text = l.IsAvailable ? "پاسخگو" : "در حال حاضر پاسخگو نیست",
            FontFamily = "VazirmatnMedium",
            FontSize = 11.5,
            VerticalOptions = LayoutOptions.Center,
            TextColor = statusColor
        });
        stack.Children.Add(statusRow);

        return stack;
    }

    private static View? BuildSpecialtyChips(string[]? specialties)
    {
        var list = MarketplaceUi.Clean(specialties);
        if (list.Length == 0) return null;

        var wrap = new FlexLayout
        {
            Direction = Microsoft.Maui.Layouts.FlexDirection.Row,
            Wrap = Microsoft.Maui.Layouts.FlexWrap.Wrap,
            Margin = new Thickness(-3)
        };
        foreach (var s in list.Take(3))
            wrap.Children.Add(MarketplaceUi.MiniChip(SpecialtyNames.Of(s)));
        if (list.Length > 3)
            wrap.Children.Add(MarketplaceUi.MiniChip($"+{Persian(list.Length - 3)}", muted: true));
        return wrap;
    }

    private Border BuildSkeletonCard(int index)
    {
        var body = new VerticalStackLayout { Spacing = 10, VerticalOptions = LayoutOptions.Center };
        body.Children.Add(MarketplaceUi.SkeletonLine(190));
        body.Children.Add(MarketplaceUi.SkeletonLine(120));
        body.Children.Add(MarketplaceUi.SkeletonLine(230));

        var grid = new Grid
        {
            ColumnDefinitions =
            {
                new ColumnDefinition(GridLength.Auto),
                new ColumnDefinition(GridLength.Star)
            },
            ColumnSpacing = 12
        };
        grid.Children.Add(MarketplaceUi.SkeletonDisc(64));
        grid.Children.Add(body);
        Grid.SetColumn(body, 1);

        var card = new Border
        {
            Style = GetStyle("GlassCard"),
            MaximumWidthRequest = CardMaxWidth,
            HorizontalOptions = LayoutOptions.Center,
            Opacity = 0.7,
            Content = grid
        };

        // breathe while attached; the loop ends quietly once the card is replaced
        UiMotion.Loop(_ambient.Token, async ct =>
        {
            if (card.Parent is null) throw new OperationCanceledException();
            await card.FadeToAsync(0.35, (uint)(720 + index * 140), Easing.SinInOut);
            if (card.Parent is null) throw new OperationCanceledException();
            await card.FadeToAsync(0.75, (uint)(720 + index * 140), Easing.SinInOut);
        });
        return card;
    }

    // ────────────────────────── shared copy helpers ──────────────────────────

    private static string MetaLine(LawyerListItem l)
    {
        var bits = new List<string>();
        if (!string.IsNullOrWhiteSpace(l.City)) bits.Add(l.City.Trim());
        if (l.ExperienceYears is int y && y > 0) bits.Add($"{Persian(y)} سال سابقه");
        return string.Join(" · ", bits);
    }

    private static string PriceLine(LawyerListItem l)
    {
        var duration = $"مشاوره {Persian(l.DurationMinutes)} دقیقه";
        return l.PriceToman is int p && p > 0
            ? $"{duration} — {Persian(p)} تومان"
            : $"{duration} — قیمت توافقی";
    }

    internal static string Initials(string? name)
    {
        var parts = (name ?? string.Empty)
            .Split(new[] { ' ', '\t', '\u200c' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return "وکیل";
        if (parts.Length == 1) return parts[0].Length <= 2 ? parts[0] : parts[0][..2];
        return $"{parts[0][0]} {parts[^1][0]}";
    }

    internal static Border CtaBorder(string text, Func<Task> action, double height = 52)
    {
        // TapBorder: 44dp floor + press-pop + haptic + screen-reader name for every
        // marketplace CTA, from one place.
        var border = new TapBorder
        {
            Style = GetStyle("CtaCard"),
            HeightRequest = height,
            Content = new Label
            {
                Text = text,
                FontFamily = "VazirmatnBold",
                FontSize = 15,
                TextColor = Color.Parse("#FFFFFF"),
                HorizontalOptions = LayoutOptions.Center,
                VerticalOptions = LayoutOptions.Center
            }
        };
        SemanticProperties.SetDescription(border, text);
        border.Tapped += async (_, _) => await action();
        return border;
    }

    /// <summary>Persian digits with the Persian thousands separator — the UI is all-Persian.</summary>
    internal static string Persian(long value)
    {
        var s = value.ToString("#,0", System.Globalization.CultureInfo.InvariantCulture);
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (ch is >= '0' and <= '9') sb.Append((char)('۰' + (ch - '0')));
            else if (ch == ',') sb.Append('٬');
            else sb.Append(ch);
        }
        return sb.ToString();
    }

    internal static Style GetStyle(string key)
    {
        if (Application.Current!.Resources.TryGetValue(key, out var value) && value is Style style)
            return style;
        throw new InvalidOperationException("missing app style: " + key);
    }

    internal static Brush GetBrush(string key)
    {
        if (Application.Current!.Resources.TryGetValue(key, out var value) && value is Brush brush)
            return brush;
        return new SolidColorBrush(Palette.Accent);
    }
}

/// <summary>
/// Small shared visual vocabulary for the two marketplace pages (Agent 5 owns both),
/// so the directory card and the profile hero never drift apart. Color-typed reads only —
/// never a Brush handed to a Color property (see the AppTheme.xaml header note).
/// </summary>
internal static class MarketplaceUi
{
    public static string[] Clean(string[]? values) =>
        (values ?? Array.Empty<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    public static Border SkeletonLine(double width, double height = 12) => new Border
    {
        BackgroundColor = Palette.QuoteFill,
        StrokeThickness = 0,
        WidthRequest = width,
        HeightRequest = height,
        HorizontalOptions = LayoutOptions.Start,
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 6 }
    };

    public static Border SkeletonDisc(double size) => new Border
    {
        WidthRequest = size,
        HeightRequest = size,
        VerticalOptions = LayoutOptions.Start,
        BackgroundColor = Palette.QuoteFill,
        Stroke = new SolidColorBrush(Palette.Hairline),
        StrokeThickness = 1,
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = size / 2 }
    };

    public static View MiniChip(string text, bool muted = false) => new Border
    {
        BackgroundColor = muted
            ? (Palette.IsDark ? Color.Parse("#16233D") : Color.Parse("#EEF2FA"))
            : (Palette.IsDark ? Color.Parse("#1A2740") : Color.Parse("#EEF2FF")),
        Stroke = new SolidColorBrush(Palette.Hairline),
        StrokeThickness = 1,
        Padding = new Thickness(10, 4),
        Margin = new Thickness(3),
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 12 },
        Content = new Label
        {
            Text = text,
            FontFamily = "VazirmatnMedium",
            FontSize = 12,
            TextColor = muted ? Palette.Muted : Palette.Accent
        }
    };

    /// <summary>Platform-verification shield — rendered only when the server says verified.</summary>
    public static View VerifiedBadge() => new Border
    {
        BackgroundColor = Palette.IsDark ? Color.Parse("#16233D") : Color.Parse("#FFFBEB"),
        Stroke = LawyersPage.GetBrush("GoldBrush"),
        StrokeThickness = 1,
        Padding = new Thickness(8, 3),
        VerticalOptions = LayoutOptions.Center,
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 11 },
        Content = new HorizontalStackLayout
        {
            Spacing = 4,
            Children =
            {
                new Image { Source = "ic_shield.png", WidthRequest = 13, HeightRequest = 13 },
                new Label
                {
                    Text = "تأیید شده توسط وکیل‌جی‌پی",
                    FontFamily = "VazirmatnMedium",
                    FontSize = 10.5,
                    VerticalOptions = LayoutOptions.Center,
                    TextColor = Palette.IsDark ? Color.Parse("#F8E7A1") : Color.Parse("#9A741C")
                }
            }
        }
    };
}

/// <summary>
/// Slug → Persian display-name cache for lawyer specialties/languages
/// (integration ask Agent 5 #1, solved client-side: /lawyers/categories is
/// already fetched, so no server/contract change was needed). Unmapped slugs
/// (languages like 'fa', 'en', or a category the dictionary lacks) resolve via
/// a small built-in table first and otherwise show as-is — never a blank chip.
/// </summary>
internal static class SpecialtyNames
{
    private static readonly Dictionary<string, string> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fa"] = "فارسی", ["en"] = "انگلیسی", ["ar"] = "عربی", ["fr"] = "فرانسه‌ای", ["tr"] = "ترکی",
        ["ur"] = "اردو", ["ku"] = "کردی", ["az"] = "ترکی آذربایجانی"
    };

    public static void Warm(LawyerCategory[] categories)
    {
        foreach (var cat in categories ?? Array.Empty<LawyerCategory>())
        {
            if (string.IsNullOrWhiteSpace(cat.Slug)) continue;
            var name = string.IsNullOrWhiteSpace(cat.NameFa) ? (cat.NameEn ?? cat.Slug) : cat.NameFa;
            Map[cat.Slug] = name;
        }
    }

    public static string Of(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug)) return slug;
        return Map.TryGetValue(slug.Trim(), out var name) && !string.IsNullOrWhiteSpace(name) ? name : slug;
    }
}
