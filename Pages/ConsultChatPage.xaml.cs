using System.Diagnostics;
using Vakil_AI_IRAN.Controls;
using Vakil_AI_IRAN.Services;
using VakilAI.Application.Contracts;

using Microsoft.Extensions.DependencyInjection;

namespace Vakil_AI_IRAN.Pages;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Private paid consultation room (client ↔ lawyer). Header shows
//             the counterparty, lifecycle chip and remaining time; the body is
//             a two-sided transcript; PAYMENT_PENDING shows the price + pay CTA
//             with the honest devModeNotice.
// OWNER     — Agent 10 (UX integration).
// CONSUMES  — IMarketplaceApi (typed port only — no HttpClient here),
//             IMarketplaceCoordinator (identity + navigation + alerts) and
//             ITokenStore (the SAME vault the chat engine reads).
// PROVIDES  — DI-resolvable page for MarketplaceRoute.ConsultChat; accepts a
//             ConsultationCreateResponse / ConsultationDto / long / string id
//             via IMarketplaceRouteArgument.
// POLLS     — V1 is pull-only (spec §2.6): /consultations/messages after the
//             last seen id every ~4s while visible; lifecycle refresh through
//             /consultations/list. Loops bound to _poll — OnDisappearing stops
//             them, OnAppearing restarts. No WebSockets, no retry storms.
// INVARIANTS— 1) Never fabricate lawyer replies, ratings or status: an empty
//                transcript says so out loud. 2) The server owns membership —
//                FORBIDDEN/NOT_FOUND means "stop, show, go back", not retry.
//             3) Finished sessions are read-only transcripts.
// EXTEND    — "پایان مشاوره" (lawyer closes the session) = one header chip +
//             ConsultationCompleteAsync; a real payment provider swaps into
//             OnPayClicked without touching this file's state machine.
// ═══════════════════════════════════════════════════════════════════════════

public partial class ConsultChatPage : ContentPage, IMarketplaceRouteArgument
{
    private const int PollMilliseconds = 4000;

    private readonly IMarketplaceCoordinator _coordinator;
    private readonly IMarketplaceApi _api;
    private readonly ITokenStore _tokens;

    private CancellationTokenSource _poll = new();
    private long _consultationId;
    private ConsultationDto? _consultation;
    private string? _devNotice;         // from /consultations/create — shown honestly
    private long _lastSeenMessageId;
    private int _lastPullCount = -1;    // messages in the most recent pull (-1 = none yet)
    private readonly HashSet<long> _renderedIds = new();
    private bool _paying;
    private bool _reviewOffered;      // wave 2: post-complete review offer, once per page
    private bool _sending;
    private bool _fatalNotice;          // FORBIDDEN / NOT_FOUND — stop polling
    private bool _stickyNotice;         // success/dev-provider line survives pulls until a real error

    private ChatComposer _composer = null!;

    public ConsultChatPage()
    {
        InitializeComponent();
        var sp = MauiProgram.Services;
        _coordinator = sp.GetRequiredService<IMarketplaceCoordinator>();
        _api = sp.GetRequiredService<IMarketplaceApi>();
        _tokens = sp.GetRequiredService<ITokenStore>();

        // Shared composer, text-only: this room polls — no mic, no fake voice.
        _composer = new ChatComposer(showAttach: false, showMic: false,
            placeholder: "پیام خود را بنویسید…")
        {
            InputEnabled = false
        };
        _composer.SendRequested += text => _ = SendAsync(text);
        ComposerSlot.Children.Add(_composer);
    }

    /// <summary>Called by the coordinator before this page becomes the window root.</summary>
    public void ReceiveRouteArgument(object? argument)
    {
        switch (argument)
        {
            case ConsultationCreateResponse created:
                _consultation = created.Consultation;
                _devNotice = created.DevModeNotice;
                if (created.Consultation is not null) _consultationId = created.Consultation.Id;
                break;
            case ConsultationDto dto:
                _consultation = dto;
                _consultationId = dto.Id;
                break;
            case ConsultationListResponse list:
                _consultation = list.Consultations?.FirstOrDefault();
                if (_consultation is not null) _consultationId = _consultation.Id;
                break;
            case long l:
                _consultationId = l;
                break;
            case string s when long.TryParse(s, out var parsed):
                _consultationId = parsed;
                break;
        }
    }

    // ────────────────────────── lifecycle ──────────────────────────

    protected override void OnAppearing()
    {
        base.OnAppearing();
        _ = EntranceAsync();
        RestartPoll();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        _poll.Cancel(); // every pull is token-bound — nothing polls behind the next page
    }

    private void RestartPoll()
    {
        if (_poll.IsCancellationRequested)
        {
            _poll.Dispose();
            _poll = new CancellationTokenSource();
        }
        _ = PollLoopAsync(_poll.Token);
        _ = TickClockAsync(_poll.Token);
    }

    private async Task EntranceAsync()
    {
        try
        {
            await UiMotion.RiseInAsync(HeaderCard, rise: 20, durationMs: 260);
            await UiMotion.RiseInAsync(ComposerSlot, rise: 16, durationMs: 240);
            if (_devNotice is not null) ShowNotice(_devNotice);
        }
        catch (Exception e) { Debug.WriteLine("consult entrance: " + e); }
    }

    // ────────────────────────── polling ──────────────────────────

    /// <summary>
    /// Sequential pull loop. No re-entrancy guard is needed: RestartPoll cancels
    /// the previous loop first, and every wait in here is token-bound, so at most
    /// one iteration of an old loop may overlap the new one (idempotent reads).
    /// </summary>
    private async Task PollLoopAsync(CancellationToken ct)
    {
        if (_consultationId == 0)
        {
            ShowNotice("مشاوره‌ای برای نمایش وجود ندارد.");
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            var token = await _tokens.GetTokenAsync();
            if (string.IsNullOrWhiteSpace(token))
            {
                ShowNotice("برای دیدن این گفتگو وارد حساب خود شوید.");
                _coordinator.Navigate(MarketplaceRoute.Auth);
                return;
            }

            var status = _consultation?.Status;
            var pending = status is ConsultationStatus.Created or ConsultationStatus.PaymentPending or null;

            // 1) transcript pull — only while the server says it is entitled
            //    (PAID / ACTIVE / COMPLETED). Unpaid rooms answer NOT_ACTIVE,
            //    so we skip the call instead of hammering a 409.
            var readable = status is ConsultationStatus.Paid or ConsultationStatus.Active
                           or ConsultationStatus.Completed;
            if (readable && !_fatalNotice)
            {
                try
                {
                    var res = await _api.ConsultationMessagesAsync(token, _consultationId, _lastSeenMessageId, ct);
                    await ApplyMessagesAsync(res, ct);
                }
                catch (OperationCanceledException) { return; }
                catch (Exception e)
                {
                    Debug.WriteLine("consult poll: " + e); // transient network — keep transcript
                }
            }

            // 2) lifecycle refresh. When the transcript pull above already ran,
            //    its response carried the fresh consultation DTO (ApplyMessages
            //    sets _consultation) — the full /list fan-out is then REDUNDANT
            //    (audit 2.6: ~200 D1 reads per tick for nothing). Only unpaid /
            //    unreadable rooms need the list probe to discover pay-from-elsewhere.
            if (!readable)
                await RefreshFromListAsync(token, ct);
            UpdateStatus();

            // wave 2: landing on an already-COMPLETED, unreviewed row → offer once
            if (_consultation?.Status == ConsultationStatus.Completed) _ = OfferReviewAsync();

            if (_fatalNotice) return; // membership lost — stop, notice explains

            // a closed consultation is a read-only transcript: drain the pages,
            // then stop pulling (an empty page means we are caught up)
            if (ConsultationStatus.IsFinished(_consultation?.Status) && _lastPullCount == 0) return;

            try { await Task.Delay(pending ? PollMilliseconds * 2 : PollMilliseconds, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task ApplyMessagesAsync(ConsultationMessagesResponse res, CancellationToken ct)
    {
        if (!res.Ok)
        {
            if (res.Code is "FORBIDDEN" or "NOT_FOUND")
            {
                _fatalNotice = true;
                ShowNotice(res.Message ?? "شما به این گفتگو دسترسی ندارید.");
                return;
            }
            if (res.Code == "NOT_ACTIVE")
            {
                _consultation = res.Consultation ?? _consultation; // status moved — re-derive
                return;
            }
            if (!string.IsNullOrWhiteSpace(res.Message)) ShowNotice(res.Message);
            return;
        }

        if (!_stickyNotice) HideNotice();  // the honest dev-payment line must not flicker away
        _lastPullCount = res.Messages?.Length ?? 0;
        if (res.Consultation is not null) _consultation = res.Consultation;

        var page = res.Messages;
        if (page is { Length: > 0 })
        {
            EmptyHint.IsVisible = false;
            foreach (var m in page)
            {
                ct.ThrowIfCancellationRequested();
                if (m.Id <= _lastSeenMessageId) continue; // id-ASC pages only move forward
                _lastSeenMessageId = m.Id;
                if (_renderedIds.Add(m.Id))
                {
                    TrimOlderRows();
                    var row = BuildRow(m);
                    MessagesStack.Children.Add(row);
                    _ = AnimateInAsync(row);
                }
            }
            ScrollToEnd();
        }
        else if (_renderedIds.Count == 0)
        {
            EmptyHint.IsVisible = true;
        }
    }

    // Constant-cost rendering: keep only the newest bubbles as views. Long
    // consultations previously re-measured the whole stack on every 4s pull.
    // EmptyHint is pinned at index 0 of the XAML stack — skip it when trimming.
    private const int MaxRenderedRows = 80;

    private void TrimOlderRows()
    {
        while (CountRows() > MaxRenderedRows)
        {
            int firstRowIndex = ReferenceEquals(MessagesStack.Children[0], EmptyHint) ? 1 : 0;
            if (firstRowIndex >= MessagesStack.Children.Count) break;
            MessagesStack.Children.RemoveAt(firstRowIndex);
        }
    }

    private int CountRows()
    {
        int n = 0;
        foreach (var c in MessagesStack.Children)
            if (!ReferenceEquals(c, EmptyHint)) n++;
        return n;
    }

    private async void OnRefundClicked(object? sender, TappedEventArgs e) => await RefundAsync();

    /// <summary>Wave 2: one-shot review offer for the booking client once a
    /// consultation is COMPLETED and unreviewed. Server re-checks everything.</summary>
    private async Task OfferReviewAsync()
    {
        var c = _consultation;
        var myUid = _coordinator.Current.UserId;
        if (_reviewOffered || c is null || myUid is null || c.ClientUserId != myUid.Value
            || c.Status != ConsultationStatus.Completed)
            return;
        _reviewOffered = true;
        try
        {
            var token = await _tokens.GetTokenAsync() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(token)) return;
            var mine = await _api.MyReviewsAsync(token, c.Id);
            if (!mine.Ok || mine.Count > 0) return;   // reviewed or hidden — no nag

            var labels = new[] { 5, 4, 3, 2, 1 };
            var options = labels.Select(n => n + " ★").ToArray();
            var choice = await DisplayActionSheetAsync(
                "ثبت نظر دربارهٔ مشاوره", "انصراف", null, options);
            var idx = Array.IndexOf(options, choice);
            if (idx < 0) return;

            string? comment = null;
            try
            {
                var typed = await DisplayPromptAsync("توضیح (اختیاری)",
                    "چند کلمه دربارهٔ تجربهٔ مشاوره…", accept: "ادامه", cancel: "بی‌مزید",
                    keyboard: Keyboard.Chat);
                if (!string.IsNullOrWhiteSpace(typed)) comment = typed.Trim();
            }
            catch (Exception) { /* prompt unsupported on this surface — rating-only submit */ }

            var res = await _api.SubmitReviewAsync(
                new ReviewSubmitRequest(token, c.Id, labels[idx], comment));
            ShowNotice(res.Ok
                ? "نظر شما ثبت شد و در پروفایل وکیل نمایش داده می‌شود. سپاس."
                : res.Message ?? "ثبت نظر ممکن نشد.", success: res.Ok);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("review offer: " + ex);
        }
    }


    /// <summary>Client refund while PAID (session not started). Server rules:
    /// devtest provider only, CAS on payments.status, payment_splits stay as ledger.</summary>
    private async Task RefundAsync()
    {
        var c = _consultation;
        if (c is null || _closing) return;
        var go = await DisplayAlertAsync("استرداد پرداخت",
            "جلسه را آغاز نکرده‌اید؛ پرداخت برگشت داده می‌شود و مشاوره «بازگشت داده شده» می‌گردد. ادامه دهم؟",
            "استرداد", "انصراف");
        if (!go) return;
        _closing = true;
        UpdateStatus();
        try
        {
            var token = await _tokens.GetTokenAsync() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(token)) return;
            var resp = await _api.RefundConsultationAsync(new ConsultationRefundRequest(token, c.Id));
            if (resp.Ok)
            {
                if (resp.Consultation is { } fresh) _consultation = fresh;
                await RefreshFromListAsync(token, _poll.Token);
                var toman = resp.RefundAmountToman.ToString("#,##0", System.Globalization.CultureInfo.InvariantCulture);
                ShowNotice(resp.Message ?? ("مبلغ " + toman + " تومان بازگشت داده شد."), success: true);
            }
            else
            {
                ShowNotice(resp.Message ?? "امکان استرداد وجود ندارد.");
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine("consult refund: " + ex);
            ShowNotice("استرداد ممکن نشد. لطفاً دوباره تلاش کنید.");
        }
        finally
        {
            _closing = false;
            UpdateStatus();
        }
    }

    private async Task RefreshFromListAsync(string token, CancellationToken ct)
    {
        try
        {
            var list = await _api.ConsultationsAsync(token, ct);
            if (!list.Ok)
            {
                if (list.Code is "FORBIDDEN" or "UNAUTHORIZED")
                {
                    _fatalNotice = true;
                    ShowNotice(list.Message ?? "شما به این گفتگو دسترسی ندارید.");
                }
                return;
            }
            var row = list.Consultations?.FirstOrDefault(c => c.Id == _consultationId);
            if (row is not null) _consultation = row;
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { Debug.WriteLine("consult list: " + e); }
    }

    // ────────────────────────── rendering ──────────────────────────

    private View BuildRow(ConsultationMessageDto m)
    {
        bool mine = IsMine(m);

        var bubble = new Border
        {
            Style = GetStyle(mine ? "UserBubble" : "ChatBubble"),
            Content = new Label
            {
                Text = m.Body,
                FontFamily = "VazirmatnRegular",
                FontSize = 15,
                LineHeight = 1.4,
                TextColor = mine ? Color.Parse("#FFFFFF") : PaletteInk(),
                LineBreakMode = LineBreakMode.WordWrap
            }
        };

        var who = string.IsNullOrWhiteSpace(m.SenderName)
            ? (mine ? "شما" : PeerNameLabel.Text)
            : m.SenderName;

        var row = new VerticalStackLayout { Spacing = 3, Padding = new Thickness(0, 2) };
        row.Children.Add(bubble);
        row.Children.Add(new Label
        {
            Text = FormatTime(m.CreatedAt) + (string.IsNullOrWhiteSpace(who) ? "" : "  ·  " + who),
            Style = GetStyle("Caption"),
            HorizontalOptions = mine ? LayoutOptions.Start : LayoutOptions.End
        });
        return row;
    }

    private static Color PaletteInk() =>
        Application.Current?.RequestedTheme == AppTheme.Dark
            ? Color.Parse("#E6EDF7") : Color.Parse("#0B1220");

    /// <summary>Whose bubble is this? Sides come from the server row / session id only.</summary>
    private bool IsMine(ConsultationMessageDto m)
    {
        // Server-authoritative flag (audit 2.6): correct even when the viewer is
        // simultaneously the booking client AND a lawyer (old role-fallback
        // mislabelled counterpart bubbles in that case).
        if (m.Mine) return true;
        var myId = _coordinator.Current.UserId;
        if (myId is not null && m.SenderUserId != 0)
            return m.SenderUserId == myId.Value;

        // identity not hydrated (edge case) — fall back to the role the server tagged
        return m.SenderRole == (_coordinator.Current.IsLawyer ? "lawyer" : "client");
    }

    private void UpdateStatus()
    {
        var c = _consultation;
        var status = c?.Status;

        // counterparty: a lawyer sees the client's name, everyone else sees the lawyer
        bool iAmLawyer = _coordinator.Current.IsLawyer && c is not null
                         && _coordinator.Current.UserId == c.LawyerUserId;
        PeerNameLabel.Text = (iAmLawyer ? c?.ClientName : c?.LawyerName)
                             ?? (iAmLawyer ? "موکل" : "وکیل مشاور");
        PeerRoleLabel.Text = iAmLawyer ? "مشاوره با موکل" : "گفتگوی خصوصی با وکیل";

        var (chip, writable, closed) = status switch
        {
            ConsultationStatus.Created => ("در انتظار پرداخت", false, false),
            ConsultationStatus.PaymentPending => ("در انتظار پرداخت", false, false),
            ConsultationStatus.Paid => ("پرداخت شد — آمادهٔ شروع", true, false),
            ConsultationStatus.Active => ("گفتگو فعال", true, false),
            ConsultationStatus.Completed => ("مشاوره پایان یافت", false, true),
            ConsultationStatus.Expired => ("زمان مشاوره پایان یافت", false, true),
            ConsultationStatus.Cancelled => ("مشاوره لغو شد", false, true),
            ConsultationStatus.Refunded => ("بازگشت وجه انجام شد", false, true),
            ConsultationStatus.Failed => ("پرداخت ناموفق", false, true),
            _ => ("…", false, false)
        };
        StatusLabel.Text = chip;
        StatusChip.BackgroundColor = status switch
        {
            ConsultationStatus.Active or ConsultationStatus.Paid => Color.Parse("#1F3E2F"),
            ConsultationStatus.Created or ConsultationStatus.PaymentPending => Color.Parse("#4A3410"),
            _ => Color.Parse("#3A1B24")
        };

        ComposerSlot.IsVisible = !closed && c is not null;
        var canTalk = writable && c is not null;
        _composer.InputEnabled = canTalk && !_sending;
        _composer.Placeholder = canTalk ? "پیام خود را بنویسید…" : "این گفتگو پیام تازه نمی‌پذیرد.";

        // early-close is offered only while the room is live/paid (server mirrors
        // this rule; CONSULTATION_CLOSED answers otherwise)
        CloseBtn.IsVisible = writable && c is not null && !_closing;

        // wave 2: refund offered to the BOOKING CLIENT while PAID (before start).
        var myUid = _coordinator.Current.UserId;
        RefundChip.IsVisible = c is not null && myUid is not null
                               && c.ClientUserId == myUid.Value
                               && status == ConsultationStatus.Paid && !_closing;
        if (_closing) CloseBtnLabel.Text = "در حال پایان…";

        var pending = status is ConsultationStatus.Created or ConsultationStatus.PaymentPending;
        PaymentCard.IsVisible = pending;
        if (pending && c is not null)
        {
            PriceLabel.Text = ToFa(c.PriceToman.ToString("#,0", System.Globalization.CultureInfo.InvariantCulture));
            DurationLabel.Text = "مدت جلسه: " + ToFa(c.DurationMinutes.ToString()) + " دقیقه — پس از پرداخت، گفتگو شروع می‌شود.";
            // the dev/test provider label is never hidden (spec §2.5)
            DevNoticeLabel.Text = _devNotice ?? "پرداخت در این نسخه با سرویس آزمایشی (devtest) شبیه‌سازی می‌شود.";
            DevNoticeLabel.IsVisible = true;
        }

        UpdateRemaining();
    }

    private void UpdateRemaining()
    {
        var c = _consultation;
        var ends = c?.EndsAt;
        if (c is null || ends is null || c.Status != ConsultationStatus.Active)
        {
            TimeLeftLabel.IsVisible = false;
            return;
        }
        var left = DateTimeOffset.FromUnixTimeMilliseconds(ends.Value) - DateTimeOffset.UtcNow;
        TimeLeftLabel.IsVisible = true;
        TimeLeftLabel.Text = left.TotalSeconds <= 0
            ? "زمان گفتگو به پایان رسیده…"
            : $"باقی‌مانده {ToFa($"{(int)left.TotalHours:00}:{left.Minutes:00}")}";
    }

    private async Task TickClockAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                UpdateRemaining();
                await Task.Delay(15000, ct);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { Debug.WriteLine("consult clock: " + e); }
    }

    // ────────────────────────── payment ──────────────────────────

    private bool _closing;

    private async void OnCompleteClicked(object? sender, TappedEventArgs e)
    {
        if (_closing || _consultation is null) return;
        var go = await DisplayAlertAsync("پایان مشاوره",
            "با پایان مشاوره، پنجرهٔ گفتگو بسته می‌شود و پیام تازه پذیرفته نمی‌شود. ادامه می‌دهید؟",
            "پایان مشاوره", "انصراف");
        if (!go) return;
        _closing = true;
        UpdateStatus();
        try
        {
            var token = await _tokens.GetTokenAsync() ?? string.Empty;
            var res = await _api.ConsultationCompleteAsync(token, _consultation.Id, _poll.Token);
            var fresh = res.Consultations is { Length: > 0 } ? res.Consultations[0] : _consultation;
            _consultation = fresh;
            ShowNotice(res.Ok
                ? "مشاوره به پایان رسید. متن گفتگو به‌عنوان سوابق قابل مشاهده است."
                : res.Message ?? "پایان مشاوره ممکن نشد. دوباره تلاش کنید.");
            if (res.Ok) _ = OfferReviewAsync();   // wave 2: client rates right after close
        }
        catch (Exception ex)
        {
            Debug.WriteLine("consult complete: " + ex);
            ShowNotice("پایان مشاوره ممکن نشد. لطفاً دوباره تلاش کنید.");
        }
        finally
        {
            _closing = false;
            UpdateStatus();
        }
    }

    private async void OnPayClicked(object? sender, TappedEventArgs e)
    {
        if (_paying || _consultation is null) return;
        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrWhiteSpace(token))
        {
            await _coordinator.NotifyAsync("پرداخت", "ابتدا وارد حساب خود شوید.");
            return;
        }

        _paying = true;
        PayBusyRing.IsRunning = true;
        PayBusyRing.IsVisible = true;
        PayCta.IsEnabled = false;
        PayCtaLabel.Text = "در حال پرداخت…";
        try
        {
            var res = await _api.ConsultationPayAsync(
                new ConsultationPayRequest(token, _consultation.Id, "pay-" + Guid.NewGuid().ToString("N")), _poll.Token);

            if (res.Ok && res.Consultation is not null)
            {
                _consultation = res.Consultation;
                UpdateStatus();
                ClearTranscript();   // entitlement just opened — pull from the start
                ShowNotice(_devNotice ?? "پرداخت انجام شد — گفتگو باز است. این پرداخت با سرویس آزمایشی انجام شد.",
                    success: true);
            }
            else
            {
                // honest server/dev notice, never a fake success
                ShowNotice(res.Message ?? "پرداخت انجام نشد. دوباره تلاش کنید.");
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Debug.WriteLine("consult pay: " + ex);
            ShowNotice("ارتباط با سرویس پرداخت ممکن نشد. لحظاتی دیگر دوباره تلاش کنید.");
        }
        finally
        {
            _paying = false;
            PayBusyRing.IsRunning = false;
            PayBusyRing.IsVisible = false;
            PayCta.IsEnabled = true;
            PayCtaLabel.Text = "پرداخت و شروع گفتگو";
        }
    }

    // ────────────────────────── sending ──────────────────────────

    private async Task SendAsync(string typed)
    {
        if (_sending || _consultation is null) return;
        var text = (typed ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(text)) return;
        if (!ConsultationStatus.IsWritable(_consultation.Status))
        {
            ShowNotice("این گفتگو پیام تازه نمی‌پذیرد.");
            return;
        }

        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrWhiteSpace(token)) return;

        _sending = true;
        _composer.InputEnabled = false;
        try
        {
            var res = await _api.ConsultationSendAsync(
                new ConsultationSendRequest(token, _consultation.Id, text), _poll.Token);
            await ApplyMessagesAsync(res, _poll.Token);
            UpdateStatus();
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Debug.WriteLine("consult send: " + ex);
            ShowNotice("ارسال پیام ممکن نشد. دوباره تلاش کنید.");
        }
        finally
        {
            _sending = false;
            _composer.InputEnabled = ConsultationStatus.IsWritable(_consultation?.Status);
        }
    }

    private void OnBackTapped(object? sender, TappedEventArgs e) =>
        _coordinator.NavigateBack(MarketplaceRoute.Chat);

    // ────────────────────────── helpers ──────────────────────────

    private void ShowNotice(string message, bool success = false)
    {
        _stickyNotice = success;
        NoticeLabel.Text = message;
        NoticeBar.Stroke = new SolidColorBrush(Color.Parse(success ? "#10B981" : "#F59E0B"));
        NoticeBar.IsVisible = true;
        NoticeBar.Opacity = 0;
        _ = NoticeBar.FadeToAsync(1, 200);
    }

    /// <summary>Wipes the rendered transcript so the next pull starts from id 0.</summary>
    private void ClearTranscript()
    {
        _lastSeenMessageId = 0;
        _lastPullCount = -1;
        _renderedIds.Clear();
        // keep the XAML-declared empty hint, drop every generated row
        for (int i = MessagesStack.Children.Count - 1; i >= 0; i--)
            if (!ReferenceEquals(MessagesStack.Children[i], EmptyHint))
                MessagesStack.Children.RemoveAt(i);
        EmptyHint.IsVisible = true;
    }

    private void HideNotice()
    {
        _stickyNotice = false;
        NoticeBar.IsVisible = false;
        NoticeLabel.Text = string.Empty;
    }

    private void ScrollToEnd()
    {
        if (MessagesStack.Children.Count == 0) return;
        if (MessagesStack.Children[^1] is not Element last) return;
        _ = MessagesScroll.ScrollToAsync(last, ScrollToPosition.End, true);
    }

    private static async Task AnimateInAsync(View row)
    {
        try
        {
            row.Opacity = 0;
            row.TranslationY = 12;
            await row.FadeToAsync(1, 220, Easing.CubicOut);
            await row.TranslateToAsync(0, 0, 260, Easing.SpringOut);
        }
        catch (Exception e) { Debug.WriteLine("consult anim: " + e.Message); }
    }

    private static Style GetStyle(string key)
    {
        var resources = Application.Current!.Resources;
        if (resources.TryGetValue(key, out var value) && value is Style style)
            return style;
        throw new InvalidOperationException("missing app style: " + key);
    }

    private static string FormatTime(long unixMs)
    {
        try
        {
            return ToFa(VakilTime.InTehran(DateTimeOffset.FromUnixTimeMilliseconds(unixMs)).ToString("HH:mm"));
        }
        catch { return string.Empty; }
    }

    /// <summary>Latin digits → Persian digits (keeps separators, commas and colon).</summary>
    private static string ToFa(string s)
    {
        var buf = new char[s.Length];
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            buf[i] = c is >= '0' and <= '9' ? (char)('۰' + (c - '0')) : c;
        }
        return new string(buf);
    }
}
