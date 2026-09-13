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

/// <summary>On-device conversation store. WAL mode, single-writer queue, FIFO cap 1000 rows.</summary>
public sealed class SqliteChatRepository : IChatRepository
{
    private readonly SQLiteAsyncConnection _db;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private bool _initialized;

    public SqliteChatRepository(string dbPath, ILogger? log = null)
    {
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
            await _db.CreateTableAsync<ChatRow>();
            await _db.CreateTableAsync<SettingRow>();
            await _db.CreateTableAsync<DraftRow>();
            await _db.ExecuteAsync("PRAGMA journal_mode=WAL;").ContinueWith(_ => { });
            _initialized = true;
        }
        finally { _initLock.Release(); }
    }

    private static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web);

    public async Task<ChatMessage> AddAsync(ChatMessage message, CancellationToken ct = default)
    {
        await InitializeAsync();
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
            IsFailed = message.IsFailed
        };
        await _db.InsertAsync(row);
        await TrimAsync();
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

    public async Task<IReadOnlyList<ChatMessage>> GetRecentAsync(int take = 100, CancellationToken ct = default)
    {
        await InitializeAsync();
        var rows = await _db.Table<ChatRow>().OrderByDescending(r => r.Id).Take(Math.Clamp(take, 1, 500)).ToListAsync();
        rows.Reverse();
        return rows.Select(Map).ToList();
    }

    public async Task ClearAllAsync(CancellationToken ct = default)
    {
        await InitializeAsync();
        await _db.DeleteAllAsync<ChatRow>();
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

    private async Task TrimAsync()
    {
        const int cap = 1000;
        var count = await _db.Table<ChatRow>().CountAsync();
        if (count <= cap) return;
        await _db.ExecuteAsync(
            "DELETE FROM ChatRow WHERE Id NOT IN (SELECT Id FROM ChatRow ORDER BY Id DESC LIMIT ?)", cap);
    }

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
            IsFailed = r.IsFailed
        };
    }
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
