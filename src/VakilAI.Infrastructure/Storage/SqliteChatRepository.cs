using SQLite;
using VakilAI.Application;
using VakilAI.Domain.Entities;
using VakilAI.Domain.Repositories;

namespace VakilAI.Infrastructure.Storage;

internal sealed class ChatRow
{
    [PrimaryKey, AutoIncrement] public int Id { get; set; }
    public long ClientId { get; set; }
    public int Role { get; set; }
    public int Kind { get; set; }
    public string Text { get; set; } = "";
    public int Format { get; set; }
    public long CreatedAtMs { get; set; }
    public string? LinkedAction { get; set; }
    public string ButtonsJson { get; set; } = "[]";
    public string FramesJson { get; set; } = "[]";
    public bool IsFailed { get; set; }
    // Owned by the raw migration below (sqlite-net 1.9.172 would add it NULLable
    // without a default — see EnsureThreadsMigrationAsync). Never 0 on a live row.
    public long ThreadId { get; set; }
}

internal sealed class ConversationRow
{
    [PrimaryKey, AutoIncrement] public long Id { get; set; }
    public string Title { get; set; } = "";
    public long CreatedAtMs { get; set; }
    public long UpdatedAtMs { get; set; }
    public bool Pinned { get; set; }
}

internal sealed class SettingRow
{
    [PrimaryKey] public string Key { get; set; } = "";
    public string Value { get; set; } = "";
}

internal sealed class DraftRow
{
    [PrimaryKey] public string Id { get; set; } = "draft";
    public string Transcript { get; set; } = "";
    public long UpdatedAtMs { get; set; }
}

/// <summary>
/// On-device conversation store (WAL, single-writer queue). Messages are grouped
/// into conversations (threads); trimming is PER-THREAD so one chatty new thread
/// never eats another's history, with a global ceiling that evicts whole oldest
/// non-pinned conversations (never half-deletes a thread). One-time migration
/// (PRAGMA user_version) backfills pre-thread installs into conversation 1.
/// Also implements <see cref="IConversationRepository"/> — it owns the single
/// connection, so deleting a conversation and its rows stays in one place.
/// </summary>
public sealed class SqliteChatRepository : IChatRepository, IConversationRepository
{
    /// <summary>Newest rows kept per conversation.</summary>
    public const int PerThreadCap = 250;
    /// <summary>Hard storage ceiling; exceeding it evicts the oldest unpinned conversation whole.</summary>
    public const int GlobalCeiling = 4000;
    /// <summary>The backfilled bucket that owns every pre-threads message.</summary>
    public const long LegacyConversationId = 1;

    private readonly SQLiteAsyncConnection _db;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private readonly int _globalCeiling;
    private bool _initialized;

    /// <param name="globalCeiling">Storage guard; tests may lower it to exercise eviction cheaply.</param>
    public SqliteChatRepository(string dbPath, ILogger? log = null, int globalCeiling = GlobalCeiling)
    {
        _globalCeiling = globalCeiling;
        var dir = Path.GetDirectoryName(dbPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _db = new SQLiteAsyncConnection(dbPath,
            SQLiteOpenFlags.ReadWrite | SQLiteOpenFlags.Create | SQLiteOpenFlags.SharedCache | SQLiteOpenFlags.FullMutex)
        { Trace = false };
    }

    public async Task InitializeAsync()
    {
        if (_initialized) return;
        await _initLock.WaitAsync();
        try
        {
            if (_initialized) return;
            await _db.ExecuteAsync("PRAGMA journal_mode=WAL;").ContinueWith(_ => { });
            await _db.CreateTableAsync<ConversationRow>();   // must exist before the backfill INSERT
            await _db.CreateTableAsync<ChatRow>();
            await _db.CreateTableAsync<SettingRow>();
            await _db.CreateTableAsync<DraftRow>();
            await EnsureThreadsMigrationAsync();
            _initialized = true;
        }
        finally { _initLock.Release(); }
    }

    /// <summary>
    /// Idempotent one-time upgrade for installs that predate conversations:
    /// adds ChatRow.ThreadId (NOT NULL DEFAULT 0 — sqlite-net's auto-add would
    /// leave old rows NULL and NULL never matches `ThreadId = 0` in SQL),
    /// creates + backfills the legacy conversation, drops the obsolete persisted
    /// welcome bubble, indexes (ThreadId, Id), and stamps PRAGMA user_version.
    /// </summary>
    private async Task EnsureThreadsMigrationAsync()
    {
        var version = await _db.ExecuteScalarAsync<int>("PRAGMA user_version;");
        if (version >= 1) return;

        var cols = await _db.QueryAsync<TableInfoRow>("SELECT name FROM pragma_table_info('ChatRow');");
        if (cols.All(c => c.name != "ThreadId"))
            await _db.ExecuteAsync("ALTER TABLE ChatRow ADD COLUMN ThreadId INTEGER NOT NULL DEFAULT 0");

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await _db.ExecuteAsync(
            "INSERT OR IGNORE INTO ConversationRow(Id, Title, CreatedAtMs, UpdatedAtMs, Pinned) VALUES(?, ?, ?, ?, 0)",
            LegacyConversationId, Conversation.LegacyTitle, now, now);
        await _db.ExecuteAsync("UPDATE ChatRow SET ThreadId = ? WHERE ThreadId IS NULL OR ThreadId = 0", LegacyConversationId);
        await _db.ExecuteAsync(
            "DELETE FROM ChatRow WHERE Role = 1 AND Kind = 2 AND (LinkedAction IS NULL OR LinkedAction = '') AND Text LIKE '🏛%'");
        await _db.ExecuteAsync("CREATE INDEX IF NOT EXISTS IX_ChatRow_Thread ON ChatRow(ThreadId, Id);");
        await _db.ExecuteAsync("PRAGMA user_version = 1;");
    }

    private sealed class TableInfoRow { public string name { get; set; } = ""; }

    private static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web);

    // ────────────────────────── messages ──────────────────────────

    public async Task<ChatMessage> AddAsync(ChatMessage message, CancellationToken ct = default)
    {
        await InitializeAsync();
        if (message.ThreadId <= 0)
            throw new InvalidOperationException("ChatMessage.ThreadId must be a real conversation id (never the 0 sentinel).");
        var row = new ChatRow
        {
            ClientId = message.Id,
            Role = (int)message.Role,
            Kind = (int)message.Kind,
            Text = message.Text,
            Format = (int)message.Format,
            CreatedAtMs = message.CreatedAtMs,
            LinkedAction = message.LinkedAction,
            ButtonsJson = System.Text.Json.JsonSerializer.Serialize(message.Buttons.Select(b => new { b.Text, b.Action, Style = (int)b.Style }), Json),
            FramesJson = System.Text.Json.JsonSerializer.Serialize(message.ThinkingFrames, Json),
            IsFailed = message.IsFailed,
            ThreadId = message.ThreadId
        };
        await _db.InsertAsync(row);
        await TrimThreadAsync(message.ThreadId);
        await EvictOldestConversationsIfNeededAsync(message.ThreadId);
        await _db.ExecuteAsync(
            "UPDATE ConversationRow SET UpdatedAtMs = MAX(UpdatedAtMs, ?) WHERE Id = ?", message.CreatedAtMs, message.ThreadId);
        return message with { Id = row.Id };
    }

    public async Task ReplaceAsync(ChatMessage message, CancellationToken ct = default)
    {
        await InitializeAsync();
        var existing = await _db.Table<ChatRow>().Where(r => r.Id == message.Id).FirstOrDefaultAsync();
        if (existing is null) { await AddAsync(message, ct); return; }
        existing.Text = message.Text;
        existing.Kind = (int)message.Kind;
        existing.Format = (int)message.Format;
        existing.ButtonsJson = System.Text.Json.JsonSerializer.Serialize(message.Buttons.Select(b => new { b.Text, b.Action, Style = (int)b.Style }), Json);
        await _db.UpdateAsync(existing);
    }

    public Task DeleteAsync(long id, CancellationToken ct = default) =>
        InitializeAsync().ContinueWith(_ => _db.DeleteAsync<ChatRow>((int)id));

    public async Task<IReadOnlyList<ChatMessage>> GetThreadMessagesAsync(long threadId, int take = 250, CancellationToken ct = default)
    {
        await InitializeAsync();
        var rows = await _db.Table<ChatRow>()
            .Where(r => r.ThreadId == threadId)
            .OrderByDescending(r => r.Id)
            .Take(Math.Clamp(take, 1, 500))
            .ToListAsync();
        rows.Reverse();
        return rows.Select(Map).ToList();
    }

    public async Task DeleteThreadAsync(long threadId, CancellationToken ct = default)
    {
        await InitializeAsync();
        await _db.ExecuteAsync("DELETE FROM ChatRow WHERE ThreadId = ?", threadId);
        await _db.DeleteAsync<ConversationRow>(threadId);
    }

    public async Task ClearAllAsync(CancellationToken ct = default)
    {
        await InitializeAsync();
        await _db.DeleteAllAsync<ChatRow>();
        await _db.DeleteAllAsync<ConversationRow>();
    }

    public async Task<ChatMessage?> GetByIdAsync(long id, CancellationToken ct = default)
    {
        await InitializeAsync();
        var row = await _db.FindAsync<ChatRow>((int)id);
        return row is null ? null : Map(row);
    }

    public async Task<int> CountAsync(CancellationToken ct = default)
    {
        await InitializeAsync();
        return await _db.Table<ChatRow>().CountAsync();
    }

    private async Task TrimThreadAsync(long threadId)
    {
        await _db.ExecuteAsync(
            "DELETE FROM ChatRow WHERE ThreadId = ? AND Id NOT IN (SELECT Id FROM ChatRow WHERE ThreadId = ? ORDER BY Id DESC LIMIT ?)",
            threadId, threadId, PerThreadCap);
    }

    /// <summary>Storage guard only: past the ceiling, the oldest non-pinned
    /// conversation (never the legacy bucket, never the one being written to)
    /// is dropped whole.</summary>
    private async Task EvictOldestConversationsIfNeededAsync(long activeThreadId)
    {
        var total = await _db.Table<ChatRow>().CountAsync();
        if (total <= _globalCeiling) return;
        var victims = await _db.QueryAsync<IdRow>(
            @"SELECT c.Id AS Id FROM ConversationRow c
              WHERE c.Pinned = 0 AND c.Id <> ? AND c.Id <> ?
                AND (SELECT COUNT(*) FROM ChatRow m WHERE m.ThreadId = c.Id) > 0
              ORDER BY c.UpdatedAtMs ASC LIMIT 3", LegacyConversationId, activeThreadId);
        foreach (var v in victims)
        {
            await _db.ExecuteAsync("DELETE FROM ChatRow WHERE ThreadId = ?", v.Id);
            await _db.DeleteAsync<ConversationRow>(v.Id);
            total -= PerThreadCap; // rough; the next insert re-checks cheaply
            if (total <= _globalCeiling) break;
        }
    }

    private sealed class IdRow { public long Id { get; set; } }

    private static ChatMessage Map(ChatRow r)
    {
        List<ChatButton> buttons = new();
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(r.ButtonsJson);
            foreach (var el in doc.RootElement.EnumerateArray())
                buttons.Add(new ChatButton(
                    el.GetProperty("text").GetString() ?? "",
                    el.GetProperty("action").GetString() ?? "",
                    (ButtonStyle)el.GetProperty("style").GetInt32()));
        }
        catch { /* tolerate corrupt rows */ }

        List<string> frames = new();
        try { frames = System.Text.Json.JsonSerializer.Deserialize<List<string>>(r.FramesJson) ?? new(); }
        catch { }

        return new ChatMessage
        {
            Id = r.Id,
            Role = (MessageRole)r.Role,
            Kind = (MessageKind)r.Kind,
            Text = r.Text,
            Format = (RenderFormat)r.Format,
            CreatedAtMs = r.CreatedAtMs,
            LinkedAction = r.LinkedAction,
            Buttons = buttons,
            ThinkingFrames = frames,
            IsFailed = r.IsFailed,
            ThreadId = r.ThreadId
        };
    }

    // ────────────────────────── conversations ──────────────────────────

    async Task<Conversation> IConversationRepository.CreateAsync(string title, CancellationToken ct)
    {
        await InitializeAsync();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var row = new ConversationRow { Title = title, CreatedAtMs = now, UpdatedAtMs = now };
        await _db.InsertAsync(row);
        return new Conversation { Id = row.Id, Title = title, CreatedAtMs = now, UpdatedAtMs = now, MessageCount = 0 };
    }

    async Task<IReadOnlyList<Conversation>> IConversationRepository.ListAsync(CancellationToken ct)
    {
        await InitializeAsync();
        var rows = await _db.QueryAsync<ConversationListRow>(
            @"SELECT c.Id, c.Title, c.CreatedAtMs, c.UpdatedAtMs, c.Pinned,
                     (SELECT COUNT(*) FROM ChatRow m WHERE m.ThreadId = c.Id) AS Cnt,
                     (SELECT COALESCE(m.Text,'') FROM ChatRow m WHERE m.ThreadId = c.Id ORDER BY m.Id DESC LIMIT 1) AS Snip
              FROM ConversationRow c ORDER BY c.Pinned DESC, c.UpdatedAtMs DESC;");
        return rows.Select(MapConversation).ToList();
    }

    async Task<Conversation?> IConversationRepository.GetAsync(long id, CancellationToken ct)
    {
        await InitializeAsync();
        var rows = await _db.QueryAsync<ConversationListRow>(
            @"SELECT c.Id, c.Title, c.CreatedAtMs, c.UpdatedAtMs, c.Pinned,
                     (SELECT COUNT(*) FROM ChatRow m WHERE m.ThreadId = c.Id) AS Cnt,
                     (SELECT COALESCE(m.Text,'') FROM ChatRow m WHERE m.ThreadId = c.Id ORDER BY m.Id DESC LIMIT 1) AS Snip
              FROM ConversationRow c WHERE c.Id = ?;", id);
        var row = rows.FirstOrDefault();
        return row is null ? null : MapConversation(row);
    }

    async Task IConversationRepository.RenameAsync(long id, string title, CancellationToken ct)
    {
        await InitializeAsync();
        await _db.ExecuteAsync("UPDATE ConversationRow SET Title = ? WHERE Id = ?", title.Trim(), id);
    }

    async Task IConversationRepository.SetPinnedAsync(long id, bool pinned, CancellationToken ct)
    {
        await InitializeAsync();
        await _db.ExecuteAsync("UPDATE ConversationRow SET Pinned = ? WHERE Id = ?", pinned ? 1 : 0, id);
    }

    async Task IConversationRepository.TouchAsync(long id, CancellationToken ct)
    {
        await InitializeAsync();
        await _db.ExecuteAsync("UPDATE ConversationRow SET UpdatedAtMs = ? WHERE Id = ?",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), id);
    }

    async Task IConversationRepository.DeleteAsync(long id, CancellationToken ct) =>
        await DeleteThreadAsync(id, ct);   // rows + index entry together (single owner of the connection)

    async Task<IReadOnlyList<Conversation>> IConversationRepository.SearchAsync(string query, CancellationToken ct)
    {
        await InitializeAsync();
        var like = "%" + query.Trim().Replace("%", "").Replace("_", "") + "%";   // LIKE wildcards neutralized
        var rows = await _db.QueryAsync<ConversationListRow>(
            @"SELECT c.Id, c.Title, c.CreatedAtMs, c.UpdatedAtMs, c.Pinned,
                     (SELECT COUNT(*) FROM ChatRow m WHERE m.ThreadId = c.Id) AS Cnt,
                     (SELECT COALESCE(m.Text,'') FROM ChatRow m WHERE m.ThreadId = c.Id ORDER BY m.Id DESC LIMIT 1) AS Snip
              FROM ConversationRow c
              WHERE c.Title LIKE ?
                 OR EXISTS (SELECT 1 FROM ChatRow m WHERE m.ThreadId = c.Id AND m.Text LIKE ?)
              ORDER BY c.Pinned DESC, c.UpdatedAtMs DESC LIMIT 50;", like, like);
        return rows.Select(MapConversation).ToList();
    }

    private sealed class ConversationListRow
    {
        public long Id { get; set; }
        public string Title { get; set; } = "";
        public long CreatedAtMs { get; set; }
        public long UpdatedAtMs { get; set; }
        public int Pinned { get; set; }
        public int Cnt { get; set; }
        public string Snip { get; set; } = "";
    }

    private static Conversation MapConversation(ConversationListRow r) => new()
    {
        Id = r.Id,
        Title = string.IsNullOrWhiteSpace(r.Title) ? Conversation.Untitled : r.Title,
        CreatedAtMs = r.CreatedAtMs,
        UpdatedAtMs = r.UpdatedAtMs,
        Pinned = r.Pinned != 0,
        MessageCount = r.Cnt,
        LastSnippet = r.Snip.Length > 80 ? r.Snip[..80] : r.Snip
    };
}

/// <summary>Key/value settings (drafting transcript, user name, activation meta).</summary>
public sealed class SqliteSettingsStore : IDraftingRepository
{
    private readonly SQLiteAsyncConnection _db;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private bool _initialized;

    public SqliteSettingsStore(string dbPath, ILogger? log = null)
    {
        _db = new SQLiteAsyncConnection(dbPath,
            SQLiteOpenFlags.ReadWrite | SQLiteOpenFlags.Create | SQLiteOpenFlags.SharedCache | SQLiteOpenFlags.FullMutex)
        { Trace = false };
    }

    private async Task InitializeAsync()
    {
        if (_initialized) return;
        await _initLock.WaitAsync();
        try
        {
            if (_initialized) return;
            await _db.CreateTableAsync<DraftRow>();
            _initialized = true;
        }
        finally { _initLock.Release(); }
    }

    public async Task<string> GetTranscriptAsync(CancellationToken ct = default)
    {
        await InitializeAsync();
        var row = await _db.FindAsync<DraftRow>("draft");
        return row?.Transcript ?? "";
    }

    public async Task AppendAsync(string userText, string aiText, CancellationToken ct = default)
    {
        await InitializeAsync();
        var current = await GetTranscriptAsync(ct);
        var entry = $"User: {userText}\nAI: {aiText}\n---\n";
        var merged = current + entry;
        if (merged.Length > 4000) merged = merged[^4000..];
        await _db.InsertOrReplaceAsync(new DraftRow { Id = "draft", Transcript = merged, UpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
    }

    public async Task ResetAsync(CancellationToken ct = default)
    {
        await InitializeAsync();
        await _db.DeleteAsync<DraftRow>("draft");
    }
}
