using VakilAI.Application.Contracts;
using VakilAI.Domain.Entities;
using VakilAI.Domain.Repositories;
using VakilAI.Domain.ValueObjects;

namespace VakilAI.Application.Services;

public sealed record ChatStateChanged(
    IReadOnlyList<ChatMessage> Messages,
    QuotaSnapshot? Quota,
    bool IsBusy,
    string? BusyHint,
    IReadOnlyList<ChatButton>? MainMenu,
    bool DraftingMode,
    string? Error);

/// <summary>
/// THE SMART ENGINE — orchestrates every interaction through the Vakil API only:
/// validation → quota state → animated thinking frames → server call → persist → render.
/// The app has zero platform-chat dependencies; the API is its single source of truth.
/// All transcripts live on-device (SQLite) grouped into CONVERSATION THREADS —
/// the server is stateless per request and never learns thread ids. An empty
/// thread renders the client-side welcome; the engine no longer seeds a fake
/// assistant message into the history (design §10: the empty state is a view).
/// </summary>
public sealed class ChatService : IChatService
{
    private readonly IAppApi _api;
    private readonly IChatRepository _repo;
    private readonly IConversationRepository _threads;
    private readonly IDraftingRepository _drafts;
    private readonly ITokenStore _tokens;
    private readonly IConnectivity _net;
    private readonly ILogger _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private List<ChatMessage> _messages = new();
    private long _threadId;
    private string _threadTitle = Conversation.Untitled;
    private bool _threadCanAutoTitle;   // fresh + placeholder-titled thread (see SwitchToAsync)
    private QuotaSnapshot? _quota;
    private bool _busy;
    private string? _busyHint;
    private bool _drafting;
    private IReadOnlyList<ChatButton>? _mainMenu;
    private string? _error;
    private IReadOnlyList<ChatButton> _lastActionButtons = Array.Empty<ChatButton>();
    private CancellationTokenSource? _active;      // the in-flight request's linked CTS
    private CancellationTokenSource? _userStop;    // cancelled only by StopAsync()

    public event EventHandler<ChatStateChanged>? Changed;

    public ChatService(IAppApi api, IChatRepository repo, IConversationRepository threads,
        IDraftingRepository drafts, ITokenStore tokens, IConnectivity net, ILogger log)
    {
        _api = api; _repo = repo; _threads = threads; _drafts = drafts;
        _tokens = tokens; _net = net; _log = log;
    }

    public IReadOnlyList<ChatMessage> Messages => _messages;
    public QuotaSnapshot? Quota => _quota;
    public bool DraftingMode => _drafting;
    public bool IsBusy => _busy;
    public long ActiveThreadId => _threadId;
    public string ActiveThreadTitle => _threadTitle;

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        // A fresh page session must not replay the previous one's failure state:
        // a sticky "SESSION_EXPIRED" here bounced a user who JUST signed back in
        // (audit 2.2 login-kick loop). Per-request errors still publish normally.
        _error = null;
        await _repo.InitializeAsync();

        if (_threadId != 0)
        {
            // A thread was already chosen (history → open → Chat re-entry):
            // just reload its messages; do NOT jump back to the newest thread.
            var reloaded = await _repo.GetThreadMessagesAsync(_threadId, 250, ct);
            _messages = reloaded.ToList();
            if (_mainMenu is null || _mainMenu.Count == 0)
                _mainMenu = MainMenuButtons();
            Publish();
            return;
        }

        var conversations = await _threads.ListAsync(ct);
        var newest = conversations.FirstOrDefault();
        if (newest is null)
            newest = await _threads.CreateAsync(Conversation.Untitled, ct);

        await SwitchToAsync(newest.Id, ct);
        if (_mainMenu is null || _mainMenu.Count == 0)
            _mainMenu = MainMenuButtons();
        Publish();
    }

    /// <summary>
    /// Wipes the in-memory + on-device transcript (all threads) so the next
    /// InitializeAsync() starts a clean conversation. Call ONLY on a true
    /// account switch (a new signed-in account replacing another on this
    /// device) — never mid-request. Fixes the V1 audit finding that the shared
    /// SQLite store carried one user's legal Q&A into another user's session.
    /// </summary>
    public async Task ResetAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            try { await _repo.ClearAllAsync(ct); } catch (Exception e) { _log.Warn("reset clear: " + e.Message); }
            try { await _drafts.ResetAsync(ct); } catch (Exception e) { _log.Warn("reset drafts: " + e.Message); }
            _messages = new List<ChatMessage>();
            _threadId = 0;
            _threadTitle = Conversation.Untitled;
            _quota = null;
            _mainMenu = null;
            _drafting = false;
            _error = null;
            Publish();
        }
        finally { _gate.Release(); }
    }

    // ────────────────────────── thread management ──────────────────────────

    public Task<IReadOnlyList<Conversation>> ListThreadsAsync(CancellationToken ct = default) =>
        _threads.ListAsync(ct);

    public Task<IReadOnlyList<Conversation>> SearchThreadsAsync(string query, CancellationToken ct = default) =>
        string.IsNullOrWhiteSpace(query) ? _threads.ListAsync(ct) : _threads.SearchAsync(query, ct);

    public async Task NewThreadAsync(CancellationToken ct = default)
    {
        // Reuse the current thread while it is still empty — "new chat" twice
        // in a row must not litter the index with empty conversations.
        if (_threadId != 0 && _messages.Count == 0) return;
        await _gate.WaitAsync(ct);
        try
        {
            var fresh = await _threads.CreateAsync(Conversation.Untitled, ct);
            await SwitchToAsync(fresh.Id, ct);
            Publish();
        }
        finally { _gate.Release(); }
    }

    public async Task OpenThreadAsync(long id, CancellationToken ct = default)
    {
        if (id == _threadId) return;
        await _gate.WaitAsync(ct);
        try
        {
            await SwitchToAsync(id, ct);
            Publish();
        }
        finally { _gate.Release(); }
    }

    public async Task RenameThreadAsync(long id, string title, CancellationToken ct = default)
    {
        var clean = title.Trim();
        if (clean.Length is < 1 or > 80) return;
        await _threads.RenameAsync(id, clean, ct);
        if (id == _threadId) _threadTitle = clean;
    }

    public Task TogglePinThreadAsync(long id, bool pinned, CancellationToken ct = default) =>
        _threads.SetPinnedAsync(id, pinned, ct);

    public async Task DeleteThreadAsync(long id, CancellationToken ct = default)
    {
        await _threads.DeleteAsync(id, ct);
        if (id != _threadId) return;
        // deleting what we are looking at: fall back to the newest remaining, else a fresh one
        var rest = await _threads.ListAsync(ct);
        var next = rest.FirstOrDefault() ?? await _threads.CreateAsync(Conversation.Untitled, ct);
        await SwitchToAsync(next.Id, ct);
        Publish();
    }

    /// <summary>Cancel the in-flight generation (user stop). The typed message
    /// stays; the server answer simply never arrives — no fake error bubble.</summary>
    public void StopGeneration()
    {
        _userStop?.Cancel();
    }

    private async Task SwitchToAsync(long threadId, CancellationToken ct)
    {
        _threadId = threadId;
        var convo = await _threads.GetAsync(threadId, ct);
        _threadTitle = convo?.Title ?? Conversation.Untitled;
        var loaded = await _repo.GetThreadMessagesAsync(threadId, 250, ct);
        _messages = loaded.ToList();
        // Auto-title only makes sense for a still-empty thread whose name is a
        // placeholder — including the backfilled legacy bucket, which is only
        // "legacy" while it actually holds pre-threads messages.
        _threadCanAutoTitle = _messages.Count == 0
            && (_threadTitle == Conversation.Untitled || _threadTitle == Conversation.LegacyTitle);
        _drafting = _messages.Any(m => m.Kind == MessageKind.Drafting) &&
                    _messages.OrderByDescending(m => m.CreatedAtMs).FirstOrDefault()?.Kind == MessageKind.Drafting;
    }

    public async Task<string?> RestoreFromServerAsync(CancellationToken ct = default)
    {
        var token = await _tokens.GetTokenAsync();
        if (string.IsNullOrEmpty(token)) return null;
        try
        {
            var res = await _api.HistoryAsync(token, ct);
            return res.Ok && res.Items is { Length: > 0 } ? $"{res.Items.Length} پیام" : null;
        }
        catch (Exception e) { _log.Warn("history mirror failed: " + e.Message); return null; }
    }

    // ────────────────────────── user text (main chat) ──────────────────────────

    public Task SendTextAsync(string text, CancellationToken ct = default) =>
        RunAsync(async tok =>
        {
            var token = await RequireTokenAsync();
            var trimmed = text.Trim();
            AddLocal(MessageRole.User, MessageKind.Chat, trimmed, RenderFormat.Markdown, null, Array.Empty<ChatButton>(), tok);
            return await _api.ChatAsync(new ChatRequest(token, trimmed), tok);
        }, ct);

    public Task SendVoiceAsync(CapturedAudio audio, string caption, CancellationToken ct = default) =>
        RunAsync(async tok =>
        {
            var token = await RequireTokenAsync();
            AddLocal(MessageRole.User, MessageKind.Chat,
                string.IsNullOrWhiteSpace(caption) ? "پیام صوتی" : caption, RenderFormat.Markdown, null, Array.Empty<ChatButton>(), tok);
            return await _api.ChatAsync(new ChatRequest(token, caption,
                AudioBase64: Convert.ToBase64String(audio.Data), AudioMime: audio.MimeType), tok);
        }, ct);

    public Task SendImageAsync(CapturedImage image, string caption, CancellationToken ct = default) =>
        RunAsync(async tok =>
        {
            var token = await RequireTokenAsync();
            AddLocal(MessageRole.User, MessageKind.Chat,
                string.IsNullOrWhiteSpace(caption) ? "تصویر سند" : caption, RenderFormat.Markdown, null, Array.Empty<ChatButton>(), tok);
            return await _api.ChatAsync(new ChatRequest(token, caption,
                ImageBase64: Convert.ToBase64String(image.Data), ImageMime: image.MimeType), tok);
        }, ct);

    // ────────────────────────── button router ──────────────────────────

    public Task InvokeActionAsync(ChatButton button, string? contextText = null, CancellationToken ct = default) =>
        RunAsync(async tok =>
        {
            var token = await RequireTokenAsync();
            return await _api.QuickActionAsync(new QuickActionRequest(token, button.Action, contextText), tok);
        }, ct);

    // ────────────────────────── core pipeline ──────────────────────────

    private async Task RunAsync(Func<CancellationToken, Task<ChatResponse>> call, CancellationToken ct)
    {
        if (!await _gate.WaitAsync(TimeSpan.FromSeconds(60), ct)) return;
        try
        {
            _busy = true; _error = null; _busyHint = null;
            Publish();

            if (_threadId == 0)   // defensive: engine used before InitializeAsync (legacy paths)
            {
                var start = await _threads.CreateAsync(Conversation.Untitled, ct);
                await SwitchToAsync(start.Id, ct);
            }

            if (!_net.IsOnline)
            {
                _error = ErrorNoInternet;
                _busy = false; Publish();
                return;
            }

            var thinking = StartThinkingBubble();
            var stop = _userStop = new CancellationTokenSource();
            using var linked = _active = CancellationTokenSource.CreateLinkedTokenSource(ct, stop.Token);
            linked.CancelAfter(TimeSpan.FromSeconds(45));

            ChatResponse res;
            try { res = await call(linked.Token); }
            catch (OperationCanceledException)
            {
                // A user stop is NOT a server timeout: no error bubble, just end busy.
                if (!stop.IsCancellationRequested)
                    thinking.SetResult(null, "پاسخ سرور به زمان محدود رسید. سوال شما حفظ شده است — دوباره بفرستید.");
                else
                    thinking.Drop();
                _busy = false; Publish(); return;
            }
            catch (AppApiException e) when (e.HttpStatus == 401)
            {
                await _tokens.ClearAsync();
                thinking.SetResult(null, "نشست شما منقضی شده است. برای ادامه دوباره وارد حساب شوید.");
                _error = "SESSION_EXPIRED";
                _busy = false; Publish();
                return;
            }
            catch (Exception e)
            {
                _log.Error("engine call failed: " + e);
                thinking.SetResult(null, "ارتباط با سرور برقرار نشد. لطفاً چند لحظه دیگر تلاش کنید.");
                _busy = false; Publish();
                return;
            }
            finally
            {
                _active = null;
                stop.Dispose();
                _userStop = null;
            }

            thinking.FinishFrames();

            if (!res.Ok)
            {
                HandleBusinessError(res, thinking);
                _busy = false; Publish();
                return;
            }

            _quota = MapQuota(res.Quota) ?? _quota;
            var format = string.Equals(res.Format, "html", StringComparison.OrdinalIgnoreCase) ? RenderFormat.Html : RenderFormat.Markdown;

            switch (res.Kind)
            {
                case "page":
                    HandlePage(res, format, thinking);
                    break;

                case "action_result":
                    {
                        var texts = res.Chunks is { Length: > 0 } ? res.Chunks : new[] { res.Text ?? "" };
                        for (int i = 0; i < texts.Length; i++)
                            await InsertLocalAsync(Build(texts[i], format, MessageKind.Action, MapButtons(res.Keyboard), nowMs: NowMs() + i));
                        _busyHint = null;
                        break;
                    }

                case "drafting":
                    {
                        _drafting = true;
                        var txt = res.Text ?? res.Chunks?.FirstOrDefault() ?? "";
                        await InsertLocalAsync(Build(txt, format, MessageKind.Drafting, MapButtons(res.Keyboard)));
                        break;
                    }

                case "draft_cancelled":
                    {
                        _drafting = false;
                        await _drafts.ResetAsync();
                        await InsertLocalAsync(Build(res.Text ?? "از حالت تنظیم متن خارج شدید.", RenderFormat.Markdown, MessageKind.Page,
                            MapButtons(res.Keyboard)));
                        break;
                    }

                default: // chat
                    {
                        var texts = res.Chunks is { Length: > 0 } ? res.Chunks : new[] { res.Text ?? "" };
                        var buttons = MapButtons(res.Keyboard);
                        var frames = res.ThinkingFrames ?? Array.Empty<string>();
                        for (int i = 0; i < texts.Length; i++)
                        {
                            var last = i == texts.Length - 1;
                            await InsertLocalAsync(Build(texts[i], format, MessageKind.Chat, last ? buttons : Array.Empty<ChatButton>(),
                                frames.Length > 0 ? frames : null, NowMs() + i));
                        }
                        if (buttons.Count > 0) _lastActionButtons = buttons;
                        break;
                    }
            }
        }
        finally
        {
            _busy = false;
            _gate.Release();
            Publish();
        }
    }

    private void HandlePage(ChatResponse res, RenderFormat format, ThinkingBubble thinking)
    {
        thinking.Drop();
        var buttons = MapButtons(res.Keyboard);
        var text = res.Text ?? "";

        switch (res.Page)
        {
            case "main_menu":
                _mainMenu = buttons.Count > 0 ? buttons : MainMenuButtons();
                _drafting = false;
                break;
            case "start" or "welcome":
                if (_mainMenu is null || _mainMenu.Count == 0) _mainMenu = buttons;
                break;
            case "draft_intro":
                _drafting = true;
                break;
            case "exit_draft":
                _drafting = false;
                break;
        }

        // Design §93: the decorative menu/welcome pages must not pollute the
        // transcript — their KEYBOARD above is already consumed into _mainMenu
        // (and rendered as the persistent action strip), the bubble is dropped.
        // Every other page (help/terms/about/limit/contact/draft_intro/…) carries
        // real information and inserts normally.
        if (res.Page is "main_menu" or "start" or "welcome") return;

        _ = InsertLocalAsync(Build(text, format, MessageKind.Page, buttons, pageId: res.Page));
    }

    private void HandleBusinessError(ChatResponse res, ThinkingBubble thinking)
    {
        thinking.Drop();
        var msg = res.Message ?? "خطای نامشخص.";
        if (res.Costless == true)
        {
            // validation warning — server did NOT charge quota; render as warning bubble
            _ = InsertLocalAsync(Build(msg, res.Format == "markdown" ? RenderFormat.Markdown : RenderFormat.Html,
                MessageKind.Warning, Array.Empty<ChatButton>(), failed: true));
        }
        else if (res.Code == "LIMIT")
        {
            _ = InsertLocalAsync(Build(msg, RenderFormat.Markdown, MessageKind.Warning, Array.Empty<ChatButton>(), failed: true));
            _error = "LIMIT";
        }
        else
        {
            _ = InsertLocalAsync(Build(msg, RenderFormat.Markdown, MessageKind.Warning, Array.Empty<ChatButton>(), failed: true));
        }
    }

    private ChatMessage Build(string text, RenderFormat format, MessageKind kind,
        IReadOnlyList<ChatButton> buttons, IReadOnlyList<string>? frames = null, long? nowMs = null,
        bool failed = false, string? pageId = null) => new()
    {
        Id = NewLocalId(),
        ThreadId = _threadId,
        Role = MessageRole.Assistant,
        Kind = kind,
        Text = text,
        Format = format,
        Buttons = buttons,
        ThinkingFrames = frames ?? Array.Empty<string>(),
        CreatedAtMs = nowMs ?? NowMs(),
        IsFailed = failed,
        LinkedAction = pageId
    };

    private static IReadOnlyList<ChatButton> MapButtons(KeyboardDto[][]? keyboard) =>
        keyboard is null ? Array.Empty<ChatButton>() :
        keyboard.SelectMany(row => row)
                .Where(b => !string.IsNullOrWhiteSpace(b?.Action) && !string.IsNullOrWhiteSpace(b?.Text))
                .Select(MapButton).ToList();

    public static ChatButton MapButton(KeyboardDto b) => new(
        b.Text, b.Action,
        b.Style?.ToLowerInvariant() switch { "success" => ButtonStyle.Success, "danger" => ButtonStyle.Danger, _ => ButtonStyle.Primary });

    private static QuotaSnapshot? MapQuota(QuotaDto? q) =>
        q is null ? null : new QuotaSnapshot(q.Allowed, q.Remaining, q.DailyLimit, q.Remaining >= 9999);

    // ────────────────────────── thinking animation (API-provided frames) ────────────────────────

    private sealed class ThinkingBubble
    {
        private readonly ChatService _owner;
        private readonly TaskCompletionSource _done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long _id;
        private bool _visible;
        private int _frame;
        private volatile bool _finished;
        public IReadOnlyList<string> Frames { get; } = DefaultFrames;
        public static IReadOnlyList<string> DefaultFrames { get; } =
        [
            "در حال تحقیق و بررسی پرونده شما، لطفاً شکیبا باشید...",
            "در حال جستجو در رویه‌های قضایی و پرونده‌های مشابه...",
            "در حال تطبیق قوانین با شرایط شما و انجام تحلیل نهایی...",
            "در حال تنظیم و نگارش پاسخ حقوقی مستند..."
        ];

        public ThinkingBubble(ChatService owner)
        {
            _owner = owner;
            _id = NewLocalId();
            _visible = true;
            _ = AnimateLoop();
        }

        private async Task AnimateLoop()
        {
            while (!_finished && _visible)
            {
                await Task.Delay(2500);
                if (_finished || !_visible) break;
                _frame = (_frame + 1) % Frames.Count;
                var hint = Frames[_frame];
                _owner._busyHint = hint;
                _owner.Publish();
            }
        }

        public void Drop() { _finished = true; _visible = false; }

        public void FinishFrames() { Drop(); }

        public void SetResult(string? text, string? fallbackError)
        {
            Drop();
            _owner._busyHint = null;
            if (fallbackError is not null)
                _ = _owner.InsertLocalAsync(new ChatMessage
                {
                    Id = NewLocalId(), ThreadId = _owner._threadId,
                    Role = MessageRole.Assistant, Kind = MessageKind.Warning,
                    Text = fallbackError, Format = RenderFormat.Markdown, CreatedAtMs = NowMs(), IsFailed = true
                });
        }
    }

    private ThinkingBubble StartThinkingBubble() => new(this);

    // ────────────────────────── local persistence ──────────────────────────

    private async Task InsertLocalAsync(ChatMessage m)
    {
        var saved = await _repo.AddAsync(m);
        _messages.Add(saved with { Id = saved.Id != 0 ? saved.Id : m.Id });
        Trim();
    }

    private void AddLocal(MessageRole role, MessageKind kind, string text, RenderFormat format,
        IReadOnlyList<string>? frames, IReadOnlyList<ChatButton> buttons, CancellationToken ct)
    {
        var m = new ChatMessage
        {
            Id = NewLocalId(), ThreadId = _threadId, Role = role, Kind = kind, Text = text,
            Format = format, CreatedAtMs = NowMs(), ThinkingFrames = frames ?? Array.Empty<string>(), Buttons = buttons
        };
        _messages.Add(m);
        Trim();
        _ = SafeAdd(m);
        Publish();

        async Task SafeAdd(ChatMessage msg)
        {
            try
            {
                await _repo.AddAsync(msg);
                // First real message titles a placeholder-named empty thread.
                if (_threadCanAutoTitle && msg.Role == MessageRole.User)
                {
                    _threadCanAutoTitle = false;
                    _threadTitle = msg.Text.Length <= 48 ? msg.Text : msg.Text[..48].TrimEnd() + "…";
                    await _threads.RenameAsync(_threadId, _threadTitle);
                }
            }
            catch (Exception e) { _log.Warn("persist user msg failed: " + e.Message); }
        }
    }

    private void Trim()
    {
        if (_messages.Count > 250) _messages = _messages[^250..];
    }

    // ────────────────────────── main menu (server-delivered keyboard) ──────────────────────────

    public static IReadOnlyList<ChatButton> MainMenuButtons() => new[]
    {
        // No emoji in labels — the app chrome renders the vector icon per action key.
        new ChatButton("وضعیت حساب من", "cmd_limit", ButtonStyle.Primary),
        new ChatButton("تماس فوری با وکیل", "cmd_contact", ButtonStyle.Success),
        new ChatButton("تنظیم قرارداد و لایحه", "cmd_drafting", ButtonStyle.Primary),
        new ChatButton("راهنمای کامل", "cmd_help", ButtonStyle.Success),
        new ChatButton("قوانین و مقررات", "cmd_terms", ButtonStyle.Danger),
        new ChatButton("درباره تکنولوژی ما", "cmd_about", ButtonStyle.Primary),
    };

    public IReadOnlyList<ChatButton> CurrentMenu => _mainMenu ?? MainMenuButtons();

    public const string ErrorNoInternet = "اتصال اینترنت برقرار نیست. شبکه را بررسی کنید؛ متن شما حفظ شده است.";

    private async Task<string> RequireTokenAsync()
    {
        var token = await _tokens.GetTokenAsync() ?? throw new AppApiException("NO_TOKEN", "جلسه فعال نیست", 401);
        return token;
    }

    private static long NewLocalId() => DateTime.UtcNow.Ticks;
    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private void Publish() => Changed?.Invoke(this, new ChatStateChanged(
        _messages.AsReadOnly(), _quota, _busy, _busyHint, CurrentMenu, _drafting, _error));
}

public interface IChatService
{
    event EventHandler<ChatStateChanged> Changed;
    IReadOnlyList<ChatMessage> Messages { get; }
    QuotaSnapshot? Quota { get; }
    bool DraftingMode { get; }
    bool IsBusy { get; }
    long ActiveThreadId { get; }
    string ActiveThreadTitle { get; }
    Task InitializeAsync(CancellationToken ct = default);
    Task<string?> RestoreFromServerAsync(CancellationToken ct = default);
    Task SendTextAsync(string text, CancellationToken ct = default);
    Task SendVoiceAsync(CapturedAudio audio, string caption, CancellationToken ct = default);
    Task SendImageAsync(CapturedImage image, string caption, CancellationToken ct = default);
    Task InvokeActionAsync(ChatButton button, string? contextText = null, CancellationToken ct = default);
    void StopGeneration();

    // conversation threads (device-local)
    Task<IReadOnlyList<Conversation>> ListThreadsAsync(CancellationToken ct = default);
    Task<IReadOnlyList<Conversation>> SearchThreadsAsync(string query, CancellationToken ct = default);
    Task NewThreadAsync(CancellationToken ct = default);
    Task OpenThreadAsync(long id, CancellationToken ct = default);
    Task RenameThreadAsync(long id, string title, CancellationToken ct = default);
    Task TogglePinThreadAsync(long id, bool pinned, CancellationToken ct = default);
    Task DeleteThreadAsync(long id, CancellationToken ct = default);
}
