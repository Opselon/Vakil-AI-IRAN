using VakilAI.Application;
using VakilAI.Application.Contracts;
using VakilAI.Application.Services;
using VakilAI.Domain.Entities;
using VakilAI.Domain.Repositories;
using Xunit;

namespace VakilAI.Core.Tests;

/// <summary>
/// Drives ChatService through its ports with lightweight in-memory fakes. All fakes return
/// already-completed tasks, so the awaited pipeline (including the service's fire-and-forget
/// inserts) is synchronous and assertions can run straight after each await.
/// The fakes are thread-aware: messages carry ThreadId, conversations live in a fake index.
/// </summary>
public class ChatServiceTests
{
    // ─────────────────────────────── fakes ───────────────────────────────

    private sealed class FakeApi : IAppApi
    {
        public readonly List<ChatRequest> ChatRequests = new();
        public readonly List<QuickActionRequest> ActionRequests = new();
        public readonly Queue<Func<ChatRequest, ChatResponse>> ChatReplies = new();
        public readonly Queue<Func<QuickActionRequest, ChatResponse>> ActionReplies = new();
        public HistoryResponse? History;
        public Func<ChatRequest, Exception>? ChatThrows;
        /// <summary>When set, ChatAsync parks until the test completes/faults this.</summary>
        public TaskCompletionSource<ChatResponse>? BlockChat;

        public Task<bool> ProbeHealthAsync(CancellationToken ct = default) => Task.FromResult(true);
        public Task<VerifyResponse> VerifyAsync(VerifyRequest r, CancellationToken ct = default) =>
            Task.FromResult(new VerifyResponse(true, "tk", 1, null));

        public Task<ChatResponse> ChatAsync(ChatRequest request, CancellationToken ct = default)
        {
            ChatRequests.Add(request);
            if (ChatThrows is not null) throw ChatThrows(request);
            if (BlockChat is not null) return BlockChat.Task;
            var next = ChatReplies.Count > 0 ? ChatReplies.Dequeue() : _ => Ok("chat", text: "پاسخ پیش‌فرض");
            return Task.FromResult(next(request));
        }

        public Task<ChatResponse> QuickActionAsync(QuickActionRequest request, CancellationToken ct = default)
        {
            ActionRequests.Add(request);
            var next = ActionReplies.Count > 0 ? ActionReplies.Dequeue() : _ => Ok("action_result", text: "نتیجه");

            return Task.FromResult(next(request));
        }

        public Task<HistoryResponse> HistoryAsync(string token, CancellationToken ct = default) =>
            Task.FromResult(History ?? new HistoryResponse(false, null));

        public static ChatResponse Ok(string kind, string? text = null, string[]? chunks = null,
            KeyboardDto[][]? keyboard = null, QuotaDto? quota = null, string? page = null,
            string format = "markdown", string[]? frames = null) =>
            new(true, kind, format, chunks, text, keyboard, quota, null, null, null, null, frames, page);
    }

    private sealed class FakeChatRepo : IChatRepository
    {
        public readonly List<ChatMessage> Saved = new();
        public Func<ChatMessage, ChatMessage> OnAdd = m => m;
        public bool InitCalled;
        public bool RejectsThreadZero;   // asserts the service never persists an unthreaded message

        public Task InitializeAsync() { InitCalled = true; return Task.CompletedTask; }
        public Task<ChatMessage> AddAsync(ChatMessage m, CancellationToken ct = default)
        {
            if (m.ThreadId <= 0) RejectsThreadZero = true;
            var saved = OnAdd(m);
            Saved.Add(saved);
            return Task.FromResult(saved);
        }
        public Task ReplaceAsync(ChatMessage m, CancellationToken ct = default) => Task.CompletedTask;
        public Task DeleteAsync(long id, CancellationToken ct = default) => Task.CompletedTask;
        public Task<IReadOnlyList<ChatMessage>> GetThreadMessagesAsync(long threadId, int take = 250, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<ChatMessage>>(Saved.Where(m => m.ThreadId == threadId).TakeLast(take).ToList());
        public Task DeleteThreadAsync(long threadId, CancellationToken ct = default)
        { Saved.RemoveAll(m => m.ThreadId == threadId); return Task.CompletedTask; }
        public Task ClearAllAsync(CancellationToken ct = default) { Saved.Clear(); return Task.CompletedTask; }
        public Task<ChatMessage?> GetByIdAsync(long id, CancellationToken ct = default) =>
            Task.FromResult<ChatMessage?>(Saved.FirstOrDefault(m => m.Id == id));
        public Task<int> CountAsync(CancellationToken ct = default) => Task.FromResult(Saved.Count);
    }

    private sealed class FakeConversationRepo : IConversationRepository
    {
        private long _nextId = 1;
        private readonly List<Conversation> _list = new();

        public FakeConversationRepo()
        {
            // Mirror the migration: the legacy bucket exists as id 1 so a
            // pre-seeded transcript's "newest conversation" is deterministic.
            _list.Add(new Conversation { Id = 1, Title = Conversation.LegacyTitle, CreatedAtMs = 0, UpdatedAtMs = 0 });
            _nextId = 2;
        }

        public Task InitializeAsync() => Task.CompletedTask;

        public Task<Conversation> CreateAsync(string title, CancellationToken ct = default)
        {
            var c = new Conversation { Id = _nextId++, Title = title, CreatedAtMs = Now(), UpdatedAtMs = Now() };
            _list.Add(c);
            return Task.FromResult(c);
        }

        public Task<IReadOnlyList<Conversation>> ListAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<Conversation>>(Ordered());

        public Task<Conversation?> GetAsync(long id, CancellationToken ct = default) =>
            Task.FromResult(_list.FirstOrDefault(c => c.Id == id));

        public Task RenameAsync(long id, string title, CancellationToken ct = default)
        {
            var i = _list.FindIndex(c => c.Id == id);
            if (i >= 0) _list[i] = _list[i] with { Title = title };
            return Task.CompletedTask;
        }

        public Task SetPinnedAsync(long id, bool pinned, CancellationToken ct = default)
        {
            var i = _list.FindIndex(c => c.Id == id);
            if (i >= 0) _list[i] = _list[i] with { Pinned = pinned };
            return Task.CompletedTask;
        }

        public Task TouchAsync(long id, CancellationToken ct = default)
        {
            var i = _list.FindIndex(c => c.Id == id);
            if (i >= 0) _list[i] = _list[i] with { UpdatedAtMs = Now() };
            return Task.CompletedTask;
        }

        public Task DeleteAsync(long id, CancellationToken ct = default)
        {
            _list.RemoveAll(c => c.Id == id);
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<Conversation>> SearchAsync(string query, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<Conversation>>(
                Ordered().Where(c => c.Title.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList());

        private IReadOnlyList<Conversation> Ordered() =>
            _list.OrderByDescending(c => c.Pinned).ThenByDescending(c => c.UpdatedAtMs).ToList();

        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private sealed class FakeDraftRepo : IDraftingRepository
    {
        public int Resets;
        public readonly List<(string User, string Ai)> Turns = new();
        public Task<string> GetTranscriptAsync(CancellationToken ct = default) => Task.FromResult("");
        public Task AppendAsync(string userText, string aiText, CancellationToken ct = default)
        { Turns.Add((userText, aiText)); return Task.CompletedTask; }
        public Task ResetAsync(CancellationToken ct = default) { Resets++; return Task.CompletedTask; }
    }

    private sealed class FakeTokenStore : ITokenStore
    {
        public string? Token = "session-token";
        public int ClearCount;
        public Task<string?> GetTokenAsync() => Task.FromResult(Token);
        public Task SaveTokenAsync(string token) { Token = token; return Task.CompletedTask; }
        public Task ClearAsync() { Token = null; ClearCount++; return Task.CompletedTask; }
    }

    private sealed class FakeConnectivity : IConnectivity
    {
        public bool IsOnline { get; private set; } = true;
        public event EventHandler<bool>? Changed;
        public void GoOffline() { IsOnline = false; Changed?.Invoke(this, false); }
    }

    private sealed class Harness
    {
        public readonly FakeApi Api = new();
        public readonly FakeChatRepo Repo = new();
        public readonly FakeConversationRepo Threads = new();
        public readonly FakeDraftRepo Drafts = new();
        public readonly FakeTokenStore Tokens = new();
        public readonly FakeConnectivity Net = new();
        public readonly ChatService Service;
        public readonly List<ChatStateChanged> States = new();

        public Harness(ChatMessage?[]? existingMessages = null)
        {
            if (existingMessages is not null)
                Repo.Saved.AddRange(existingMessages.OfType<ChatMessage>().Select(m => m with { ThreadId = 1 }));
            Service = new ChatService(Api, Repo, Threads, Drafts, Tokens, Net, NullLogger.Instance);
            Service.Changed += (_, s) => { lock (States) States.Add(s); };
        }

        public Task InitializeAsync() => Service.InitializeAsync(CancellationToken.None);

        /// <summary>Polls a condition with a 2s ceiling (belt-and-braces for fire-and-forget inserts).</summary>
        public static async Task WaitFor(Func<bool> condition)
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            while (!condition())
            {
                if (cts.IsCancellationRequested)
                    throw new TimeoutException("ChatService state did not reach the expected condition within 2s.");
                await Task.Yield();
            }
        }

        public ChatStateChanged LastState() { lock (States) return States[^1]; }
    }

    private static KeyboardDto[][] Row(params KeyboardDto[] buttons) => new[] { buttons };

    // ─────────────────────────────── Initialize ───────────────────────────────

    [Fact]
    public async Task Initialize_EmptyRepo_StartsOnEmptyConversation()
    {
        var h = new Harness();
        await h.InitializeAsync();

        Assert.True(h.Repo.InitCalled);
        // §10: the empty state is a VIEW — no seeded fake assistant message anymore.
        Assert.Empty(h.Service.Messages);
        Assert.True(h.Service.ActiveThreadId > 0);
        await Harness.WaitFor(() => h.States.Count > 0);
        var state = h.LastState();
        Assert.NotNull(state);
        Assert.Equal(6, state.MainMenu!.Count);     // default quick-action menu still offered
        Assert.Contains(state.MainMenu, b => b.Action == "cmd_drafting");
    }

    [Fact]
    public async Task Initialize_ExistingTranscript_LoadsOnlyItsConversation()
    {
        var existing = new ChatMessage { Id = 1, Role = MessageRole.User, Text = "قبلاً پرسیده بودم", CreatedAtMs = 5 };
        var h = new Harness(new ChatMessage?[] { existing });
        await h.InitializeAsync();

        var msg = Assert.Single(h.Service.Messages);
        Assert.Equal("قبلاً پرسیده بودم", msg.Text);
        Assert.Equal(1, h.Service.ActiveThreadId);   // newest-by-index = the legacy bucket
    }

    [Fact]
    public async Task Initialize_LastDraftingMessage_RestoresDraftingMode()
    {
        var draft = new ChatMessage { Id = 2, Role = MessageRole.Assistant, Kind = MessageKind.Drafting, Text = "پیش‌نویس", CreatedAtMs = 9 };
        var h = new Harness(new ChatMessage?[] { draft });
        await h.InitializeAsync();
        Assert.True(h.Service.DraftingMode);
    }

    [Fact]
    public async Task Initialize_RecentDraftButNewerChat_KeepsNormalMode()
    {
        var msgs = new ChatMessage?[]
        {
            new() { Id = 1, Role = MessageRole.Assistant, Kind = MessageKind.Drafting, Text = "d", CreatedAtMs = 5 },
            new() { Id = 2, Role = MessageRole.Assistant, Kind = MessageKind.Chat, Text = "c", CreatedAtMs = 10 },
        };
        var h = new Harness(msgs);
        await h.InitializeAsync();
        Assert.False(h.Service.DraftingMode);
    }

    [Fact]
    public async Task Initialize_DefaultMenuIsMainMenuButtons()
    {
        var h = new Harness(new ChatMessage?[] { new ChatMessage { Id = 1, Role = MessageRole.User, Text = "x" } });
        await h.InitializeAsync();
        Assert.Equal(6, h.Service.CurrentMenu.Count);
        Assert.Contains(h.Service.CurrentMenu, b => b.Action == "cmd_drafting");
    }

    // ─────────────────────────────── threads ───────────────────────────────

    [Fact]
    public async Task NewThread_SwitchesToFreshEmptyConversation_AndReusesWhenAlreadyEmpty()
    {
        var h = new Harness();
        await h.InitializeAsync();
        var first = h.Service.ActiveThreadId;

        await h.Service.NewThreadAsync();                 // current is still empty → reuse
        Assert.Equal(first, h.Service.ActiveThreadId);

        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پ"));
        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);

        await h.Service.NewThreadAsync();
        Assert.NotEqual(first, h.Service.ActiveThreadId);
        Assert.Empty(h.Service.Messages);
        var list = await h.Service.ListThreadsAsync();
        Assert.Contains(list, c => c.Id == first);
    }

    [Fact]
    public async Task OpenThread_SwapsMessageList()
    {
        var h = new Harness(new ChatMessage?[]
        {
            new() { Id = 1, Role = MessageRole.User, Text = "در گفتگوی قدیمی", CreatedAtMs = 5 },
        });
        await h.InitializeAsync();
        long legacy = h.Service.ActiveThreadId;

        await h.Service.NewThreadAsync();
        Assert.Empty(h.Service.Messages);

        await h.Service.OpenThreadAsync(legacy);
        Assert.Equal(legacy, h.Service.ActiveThreadId);
        var msg = Assert.Single(h.Service.Messages);
        Assert.Equal("در گفتگوی قدیمی", msg.Text);
    }

    [Fact]
    public async Task FirstUserMessage_AutoTitlesConversation()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پ"));
        await h.Service.SendTextAsync("اجرتالمه چک برگشتی چیست؟", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.ActiveThreadTitle == "اجرتالمه چک برگشتی چیست؟");
        Assert.Equal(h.Service.ActiveThreadTitle, (await h.Threads.GetAsync(h.Service.ActiveThreadId))!.Title);
    }

    [Fact]
    public async Task DeleteActiveThread_FallsBackToNewestRemaining()
    {
        var h = new Harness();
        await h.InitializeAsync();
        long a = h.Service.ActiveThreadId;
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پ"));
        await h.Service.SendTextAsync("اول", CancellationToken.None);   // a is non-empty now

        await h.Service.NewThreadAsync();
        long b = h.Service.ActiveThreadId;
        Assert.NotEqual(a, b);

        await h.Service.DeleteThreadAsync(b);
        var list = await h.Service.ListThreadsAsync();
        Assert.DoesNotContain(list, c => c.Id == b);
        Assert.Equal(a, h.Service.ActiveThreadId);                       // back to the remaining thread
        Assert.Equal(2, h.Service.Messages.Count);                       // its user + assistant messages
    }

    [Fact]
    public async Task RenameThread_PersistsTitle()
    {
        var h = new Harness();
        await h.InitializeAsync();
        await h.Service.RenameThreadAsync(h.Service.ActiveThreadId, "پرونده ملکی");
        Assert.Equal("پرونده ملکی", h.Service.ActiveThreadTitle);
        Assert.Equal("پرونده ملکی", (await h.Threads.GetAsync(h.Service.ActiveThreadId))!.Title);
    }

    [Fact]
    public async Task SearchThreads_FiltersByTitle()
    {
        var h = new Harness();
        await h.InitializeAsync();
        await h.Service.NewThreadAsync();
        await h.Service.RenameThreadAsync(h.Service.ActiveThreadId, "دفاعیه کیفری");
        var hits = await h.Service.SearchThreadsAsync("کیفری");
        Assert.Contains(hits, c => c.Title == "دفاعیه کیفری");
        Assert.DoesNotContain(hits, c => c.Title == Conversation.LegacyTitle);
    }

    [Fact]
    public async Task AllPersistedMessages_CarryARealThreadId()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پ", keyboard: Row(new KeyboardDto("ادامه", "cmd_x", "primary"))));
        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        Assert.False(h.Repo.RejectsThreadZero);
        Assert.All(h.Repo.Saved, m => Assert.True(m.ThreadId > 0));
    }

    // ─────────────────────────────── stop generation ───────────────────────────────

    [Fact]
    public async Task StopGeneration_CancelsInFlightRequest_WithoutErrorBubble()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.BlockChat = new TaskCompletionSource<ChatResponse>();

        var send = h.Service.SendTextAsync("سوال طولانی حقوقی", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.IsBusy);

        h.Service.StopGeneration();
        h.Api.BlockChat.SetException(new OperationCanceledException());
        await send;

        Assert.False(h.Service.IsBusy);
        // user message preserved, no failed/error bubble on a deliberate stop
        var last = h.Service.Messages[^1];
        Assert.Equal("سوال طولانی حقوقی", last.Text);
        Assert.DoesNotContain(h.Service.Messages, m => m.IsFailed);
    }

    [Fact]
    public async Task ServerTimeout_StampsRetryBubble_UnlikeManualStop()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatThrows = _ => new OperationCanceledException();   // timeout-shaped cancel (no user stop)

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages[^1].IsFailed);

        Assert.Contains("زمان محدود", h.Service.Messages[^1].Text);
        Assert.False(h.Service.IsBusy);
    }

    // ─────────────────────────────── SendText ───────────────────────────────

    [Fact]
    public async Task SendText_OkChunks_AddsUserThenAssistantBubblesInOrder()
    {
        var h = new Harness();
        await h.InitializeAsync(); // no welcome bubble — empty conversation
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", chunks: new[] { "بخش یک", "بخش دو" },
            quota: new QuotaDto(true, 7, 10, null)));

        await h.Service.SendTextAsync("  کلاهبرداری چیست؟  ", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 3);

        Assert.Equal("کلاهبرداری چیست؟", h.Service.Messages[0].Text); // trimmed, user role
        Assert.Equal(MessageRole.User, h.Service.Messages[0].Role);
        Assert.Equal(MessageKind.Chat, h.Service.Messages[0].Kind);
        Assert.Equal("بخش یک", h.Service.Messages[1].Text);
        Assert.Equal(MessageRole.Assistant, h.Service.Messages[1].Role);
        Assert.Equal("بخش دو", h.Service.Messages[2].Text);
        Assert.False(h.Service.IsBusy);

        // persisted through the repo fake (user msg + both chunks)
        await Harness.WaitFor(() => h.Repo.Saved.Count == 3);
        Assert.Equal(3, h.Repo.Saved.Count);

        // request carried token + trimmed text
        var req = Assert.Single(h.Api.ChatRequests);
        Assert.Equal("session-token", req.Token);
        Assert.Equal("کلاهبرداری چیست؟", req.Text);
    }

    [Fact]
    public async Task SendText_SingleTextField_StillBecomesOneAssistantBubble()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "تک‌پاسخ"));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        Assert.Equal("تک‌پاسخ", h.Service.Messages[^1].Text);
        Assert.Equal(MessageRole.Assistant, h.Service.Messages[^1].Role);
    }

    [Fact]
    public async Task SendText_KeyboardDtoMapsToChatButtonStyles()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پاسخ", keyboard: Row(
            new KeyboardDto("✅ تأیید", "cmd_ok", "success"),
            new KeyboardDto("❌ رد", "cmd_no", "DANGER"),
            new KeyboardDto("ادامه", "cmd_more", "weird-style"),
            new KeyboardDto("بی‌استایل", "cmd_plain", null!))));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        var buttons = h.Service.Messages[^1].Buttons;

        Assert.Equal(4, buttons.Count);
        Assert.Equal(ButtonStyle.Success, buttons[0].Style);
        Assert.Equal(ButtonStyle.Danger, buttons[1].Style);          // case-insensitive
        Assert.Equal(ButtonStyle.Primary, buttons[2].Style);         // unknown → primary
        Assert.Equal(ButtonStyle.Primary, buttons[3].Style);         // null style → primary
        Assert.Equal("✅ تأیید", buttons[0].Text);
        Assert.Equal("cmd_no", buttons[1].Action);
    }

    [Fact]
    public async Task SendText_KeyboardRows_IgnoreNullAndEmptyEntries()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پاسخ", keyboard: new[]
        {
            new[] { new KeyboardDto("", "act-ghost", "primary"), new KeyboardDto("متن", "", "primary"), null! },
            Array.Empty<KeyboardDto>(),
            new[] { new KeyboardDto("معتبر", "act-real", "success") },
        }));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        var btn = Assert.Single(h.Service.Messages[^1].Buttons);
        Assert.Equal("act-real", btn.Action);
    }

    [Fact]
    public async Task SendText_NoKeyboard_LeavesBubbleButtonless()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "بدون دکمه"));

        await h.Service.SendTextAsync("س", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        Assert.Empty(h.Service.Messages[^1].Buttons);
    }

    [Fact]
    public async Task SendText_HtmlFormatFlag_ProducesHtmlRenderFormat()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "<b>سند</b>", format: "HTML"));

        await h.Service.SendTextAsync("س", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);
        Assert.Equal(RenderFormat.Html, h.Service.Messages[^1].Format);
    }

    [Fact]
    public async Task SendText_ThinkingFrames_AttachToAssistantChunks()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", chunks: new[] { "الف", "ب" },
            frames: new[] { "بررسی", "تطبیق" }));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages.Count == 3);
        Assert.Equal(2, h.Service.Messages[1].ThinkingFrames.Count);
        Assert.Equal(2, h.Service.Messages[2].ThinkingFrames.Count);
    }

    // ─────────────────────────────── errors ───────────────────────────────

    [Fact]
    public async Task SendText_ValidationCostlessWarning_FailedBubbleAndQuotaUnchanged()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "اول", quota: new QuotaDto(true, 7, 10, null)));
        await h.Service.SendTextAsync("اولین", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Quota is not null);
        var before = h.Service.Quota!;

        h.Api.ChatReplies.Enqueue(_ => new ChatResponse(false, null, "markdown", null, null, null, null,
            "VALIDATION", "⚠️ سوال خیلی کوتاه است", Costless: true, null, null, null));

        await h.Service.SendTextAsync("ها", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages[^1].Kind == MessageKind.Warning);

        var warning = h.Service.Messages[^1];
        Assert.Equal(MessageKind.Warning, warning.Kind);
        Assert.True(warning.IsFailed);
        Assert.Equal("⚠️ سوال خیلی کوتاه است", warning.Text);
        Assert.Equal(before, h.Service.Quota);            // quota snapshot untouched on costless error
        Assert.Equal(7, h.Service.Quota!.Remaining);
        Assert.False(h.Service.IsBusy);
    }

    [Fact]
    public async Task SendText_LimitError_SetsErrorStateAndFailedBubble()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => new ChatResponse(false, null, null, null, null, null,
            new QuotaDto(false, 0, 10, null), "LIMIT", "⛔ سقف روزانه", Costless: false, null, null, null));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages[^1].Kind == MessageKind.Warning);

        Assert.True(h.Service.Messages[^1].IsFailed);
        Assert.Equal("LIMIT", h.LastState().Error);
        Assert.False(h.Service.IsBusy);
    }

    [Fact]
    public async Task SendText_Unauthorized_ClearsTokenDropsBusyShowsErrorBubble()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatThrows = _ => new AppApiException("UNAUTHORIZED", "unauthorized", 401);

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Tokens.ClearCount == 1);

        Assert.Null(h.Tokens.Token);                                  // store cleared
        Assert.False(h.Service.IsBusy);                               // busy cleared
        var bubble = h.Service.Messages[^1];
        Assert.Equal(MessageKind.Warning, bubble.Kind);
        Assert.True(bubble.IsFailed);
        Assert.Contains("نشست شما منقضی", bubble.Text);
        Assert.Equal("SESSION_EXPIRED", h.LastState().Error);
    }

    [Fact]
    public async Task SendText_TransportError_ShowsFailureBubbleAndKeepsToken()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatThrows = _ => new AppApiException("NETWORK", "down", 0);

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages[^1].IsFailed);

        Assert.Equal("session-token", h.Tokens.Token);
        Assert.False(h.Service.IsBusy);
        Assert.Contains("ارتباط با سرور", h.Service.Messages[^1].Text);
    }

    [Fact]
    public async Task SendText_Offline_ErrorsWithoutCallingApi()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Net.GoOffline();

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.States.Any(s => s.Error == ChatService.ErrorNoInternet));

        Assert.Empty(h.Api.ChatRequests);
        Assert.False(h.Service.IsBusy);
        Assert.Contains(h.States, s => s.Error == ChatService.ErrorNoInternet);
    }

    [Fact]
    public async Task SendText_MissingToken_TreatedAs401Path()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Tokens.Token = null;

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Messages[^1].IsFailed);

        Assert.Empty(h.Api.ChatRequests);       // RequireTokenAsync threw before any API call
        Assert.Equal("SESSION_EXPIRED", h.LastState().Error);
    }

    // ─────────────────────────────── pages & actions ───────────────────────────────

    private static ChatResponse Page(string pageId, string text, KeyboardDto[][]? kb = null) =>
        new(true, "page", "markdown", null, text, kb, null, null, null, null, null, null, pageId);

    [Fact]
    public async Task PageDraftIntro_TogglesDraftingModeOn()
    {
        var h = new Harness();
        await h.InitializeAsync();
        Assert.False(h.Service.DraftingMode);
        h.Api.ChatReplies.Enqueue(_ => Page("draft_intro", "✍️ حالت تنظیم متن فعال شد"));

        await h.Service.SendTextAsync("قانوند", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.DraftingMode);

        Assert.True(h.Service.DraftingMode);
        var bubble = h.Service.Messages[^1];
        Assert.Equal(MessageKind.Page, bubble.Kind);
        Assert.Equal("draft_intro", bubble.LinkedAction);
    }

    [Fact]
    public async Task PageExitDraft_TogglesDraftingModeOff()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => Page("draft_intro", "ورود"));
        await h.Service.SendTextAsync("قانوند", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.DraftingMode);

        h.Api.ChatReplies.Enqueue(_ => Page("exit_draft", "خروج"));
        await h.Service.SendTextAsync("خروج", CancellationToken.None);
        await Harness.WaitFor(() => !h.Service.DraftingMode);
        Assert.False(h.Service.DraftingMode);
    }

    [Fact]
    public async Task PageMainMenu_SetsMenuButtonsAndExitsDrafting()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => Page("draft_intro", "ورود به تنظیم"));
        await h.Service.SendTextAsync("ق", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.DraftingMode);

        h.Api.ActionReplies.Enqueue(_ => Page("main_menu", "منوی اصلی", Row(
            new KeyboardDto("شروع", "cmd_start", "primary"),
            new KeyboardDto("راهنما", "cmd_help", "success"))));

        await h.Service.InvokeActionAsync(new ChatButton("منو", "cmd_menu", ButtonStyle.Primary), null, CancellationToken.None);
        await Harness.WaitFor(() => !h.Service.DraftingMode && h.Service.CurrentMenu.Count == 2);

        Assert.Equal(new[] { "cmd_start", "cmd_help" }, h.Service.CurrentMenu.Select(b => b.Action).ToArray());
        Assert.False(h.Service.DraftingMode);
        Assert.Equal("cmd_menu", Assert.Single(h.Api.ActionRequests).Action);
    }

    [Fact]
    public async Task PageMainMenu_EmptyKeyboard_FallsBackToDefaultMenu()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ActionReplies.Enqueue(_ => Page("main_menu", "منو", Array.Empty<KeyboardDto[]>()));

        await h.Service.InvokeActionAsync(new ChatButton("منو", "cmd_menu", ButtonStyle.Primary));
        // §93: the menu page is consumed as the action strip — NO transcript bubble.
        await Harness.WaitFor(() => h.States.Any(s => !s.IsBusy && s.Error is null) && h.Service.CurrentMenu.Count == 6);

        Assert.Equal(ChatService.MainMenuButtons().Count, h.Service.CurrentMenu.Count);
        Assert.False(h.Service.IsBusy);
        Assert.Empty(h.Service.Messages);
    }

    [Fact]
    public async Task PageStartWelcome_InjectsNoBubble_KeepsKeyboard()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ActionReplies.Enqueue(_ => Page("start", "خوش آمدید", Row(
            new KeyboardDto("راهنما", "cmd_help", "primary"))));

        await h.Service.InvokeActionAsync(new ChatButton("شروع", "cmd_start", ButtonStyle.Primary));
        await Harness.WaitFor(() => !h.Service.IsBusy);

        Assert.Empty(h.Service.Messages);            // decorative welcome never pollutes history
        Assert.Contains(h.Service.CurrentMenu, b => b.Action == "cmd_help"); // keyboard survived
    }

    [Fact]
    public async Task ActionResult_ChunksBecomeActionBubbles()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ActionReplies.Enqueue(_ => FakeApi.Ok("action_result", chunks: new[] { "نتیجه ۱", "نتیجه ۲" }));

        await h.Service.InvokeActionAsync(new ChatButton("وضعیت", "cmd_limit", ButtonStyle.Primary));
        await Harness.WaitFor(() => h.Service.Messages.Count == 2);   // two action chunks, no welcome

        Assert.Equal(MessageKind.Action, h.Service.Messages[^2].Kind);
        Assert.Equal("نتیجه ۱", h.Service.Messages[^2].Text);
        Assert.Equal("نتیجه ۲", h.Service.Messages[^1].Text);
    }

    [Fact]
    public async Task DraftingKind_ResetsOnDraftCancelled()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => Page("draft_intro", "ورود"));
        await h.Service.SendTextAsync("ق", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.DraftingMode);

        h.Api.ChatReplies.Enqueue(_ => new ChatResponse(true, "draft_cancelled", "markdown", null,
            "✅ لغو شد", null, null, null, null, null, null, null, null));
        await h.Service.SendTextAsync("انصراف", CancellationToken.None);
        await Harness.WaitFor(() => !h.Service.DraftingMode);

        Assert.False(h.Service.DraftingMode);
        Assert.Equal(1, h.Drafts.Resets);
    }

    [Fact]
    public async Task QuotaFromChatResponse_PublishedInState()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پ", quota: new QuotaDto(true, 9, 10, "۱۴ ساعت")));

        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => h.Service.Quota is not null);

        Assert.Equal(9, h.Service.Quota!.Remaining);
        Assert.Equal(10, h.Service.Quota.DailyLimit);
    }

    // ─────────────────────────────── history mirror ───────────────────────────────

    [Fact]
    public async Task RestoreFromServer_ReturnsPersianCountOrNothing()
    {
        var h = new Harness();
        await h.InitializeAsync();
        Assert.Null(await h.Service.RestoreFromServerAsync()); // HistoryResponse.Ok=false

        h.Api.History = new HistoryResponse(true, new[]
        {
            new HistoryItem("user", "a", 1), new HistoryItem("assistant", "b", 2),
        });
        Assert.Equal("2 پیام", await h.Service.RestoreFromServerAsync());
    }

    [Fact]
    public async Task RestoreFromServer_NoToken_ReturnsNull()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Tokens.Token = null;
        Assert.Null(await h.Service.RestoreFromServerAsync());
    }

    // ─────────────────────────────── busy sequencing ───────────────────────────────

    [Fact]
    public async Task RunAsync_SerializesConcurrentSends()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "اولین"));
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "دومین"));

        await Task.WhenAll(h.Service.SendTextAsync("a"), h.Service.SendTextAsync("b"));
        await Harness.WaitFor(() => h.Service.Messages.Count == 4);

        // both user bubbles + both assistant bubbles, no lost updates
        Assert.Equal(2, h.Service.Messages.Count(m => m.Role == MessageRole.User));
        Assert.Contains(h.Service.Messages, m => m.Text == "اولین");
        Assert.Contains(h.Service.Messages, m => m.Text == "دومین");
        Assert.False(h.Service.IsBusy);
    }

    [Fact]
    public async Task ChangedEvents_NeverExceedOneBusyTransitionPerSend()
    {
        var h = new Harness();
        await h.InitializeAsync();
        h.Api.ChatReplies.Enqueue(_ => FakeApi.Ok("chat", text: "پاسخ"));

        int busySeen;
        await h.Service.SendTextAsync("سوال", CancellationToken.None);
        await Harness.WaitFor(() => !h.Service.IsBusy);
        lock (h.States) busySeen = h.States.Count(s => s.IsBusy);

        Assert.InRange(busySeen, 1, 3);
        Assert.False(h.Service.IsBusy);
    }
}
