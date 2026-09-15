using SQLite;
using VakilAI.Domain.Entities;
using VakilAI.Domain.Repositories;
using VakilAI.Infrastructure.Storage;
using Xunit;

namespace VakilAI.Core.Tests;

/// <summary>
/// Guards the one-time SQLite upgrade that adds conversation threads to installs
/// that predate them. Runs against real file DBs (sqlite-net-pcl + the bundled
/// e_sqlite3 work on the desktop test host), because the migration is raw DDL
/// that the ChatService fakes never exercise. This is the safety net for real
/// users' on-device history.
/// </summary>
public sealed class SqliteMigrationTests : IDisposable
{
    private readonly List<string> _files = new();

    private string NewDbPath()
    {
        var path = Path.Combine(Path.GetTempPath(), "vakil-mig-" + Guid.NewGuid().ToString("N") + ".db3");
        _files.Add(path);
        return path;
    }

    /// <summary>Create a DB with the OLD (pre-threads) ChatRow schema + seeded rows, as shipped.</summary>
    private static async Task SeedLegacyDbAsync(string path, params string[] texts)
    {
        var db = new SQLiteAsyncConnection(path,
            SQLiteOpenFlags.ReadWrite | SQLiteOpenFlags.Create | SQLiteOpenFlags.SharedCache | SQLiteOpenFlags.FullMutex);
        await db.ExecuteAsync("""
            CREATE TABLE ChatRow (
                Id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                ClientId INTEGER NOT NULL,
                Role INTEGER NOT NULL,
                Kind INTEGER NOT NULL,
                Text TEXT NOT NULL,
                Format INTEGER NOT NULL,
                CreatedAtMs INTEGER NOT NULL,
                LinkedAction TEXT,
                ButtonsJson TEXT NOT NULL,
                FramesJson TEXT NOT NULL,
                IsFailed INTEGER NOT NULL
            );
            """);
        int t = 1;
        foreach (var text in texts)
        {
            await db.ExecuteAsync(
                "INSERT INTO ChatRow(ClientId,Role,Kind,Text,Format,CreatedAtMs,LinkedAction,ButtonsJson,FramesJson,IsFailed) VALUES(?,?,2,?,?,?,'','[]','[]',0)",
                1000 + t, 1 /*Assistant*/, text, 0, t);
            t++;
        }
        // one persisted decorative welcome bubble (Role=Assistant, Kind=Page, 🏛 prefix)
        await db.ExecuteAsync(
            "INSERT INTO ChatRow(ClientId,Role,Kind,Text,Format,CreatedAtMs,LinkedAction,ButtonsJson,FramesJson,IsFailed) VALUES(9999,1,2,'🏛 دستیار هوشمند',0,9999,NULL,'[]','[]',0)");
        await db.CloseAsync();
    }

    private static async Task<int> ScalarAsync(string path, string sql)
    {
        var db = new SQLiteAsyncConnection(path, SQLiteOpenFlags.ReadOnly | SQLiteOpenFlags.SharedCache);
        try { return await db.ExecuteScalarAsync<int>(sql); }
        finally { await db.CloseAsync(); }
    }

    [Fact]
    public async Task Migration_AddsThreadId_BacksfillsLegacyConversation_DropsWelcome_AndStampsVersion()
    {
        var path = NewDbPath();
        await SeedLegacyDbAsync(path, "سوال قدیمی یک", "سوال قدیمی دو");

        var repo = new SqliteChatRepository(path);
        await repo.InitializeAsync();   // runs the migration

        // ThreadId column exists (via the guarded ALTER).
        Assert.Equal(1, await ScalarAsync(path,
            "SELECT COUNT(*) FROM pragma_table_info('ChatRow') WHERE name='ThreadId'"));

        // Legacy rows moved into conversation 1, welcome bubble purged (2 survive).
        Assert.Equal(2, await ScalarAsync(path, "SELECT COUNT(*) FROM ChatRow"));
        Assert.Equal(2, await ScalarAsync(path, "SELECT COUNT(*) FROM ChatRow WHERE ThreadId=1"));
        Assert.Equal(0, await ScalarAsync(path, "SELECT COUNT(*) FROM ChatRow WHERE ThreadId=0 OR ThreadId IS NULL"));

        // Legacy conversation row exists with the Persian bucket title.
        Assert.Equal(1, await ScalarAsync(path,
            $"SELECT COUNT(*) FROM ConversationRow WHERE Id={SqliteChatRepository.LegacyConversationId}"));

        // version stamped → idempotent second init is a no-op
        Assert.Equal(1, await ScalarAsync(path, "PRAGMA user_version"));
        await repo.InitializeAsync();
        Assert.Equal(2, await ScalarAsync(path, "SELECT COUNT(*) FROM ChatRow"));
    }

    [Fact]
    public async Task Migration_LegacyHistoryIsReadableThroughTheRepository()
    {
        var path = NewDbPath();
        await SeedLegacyDbAsync(path, "تاریخچه‌ی قبلی");

        var repo = new SqliteChatRepository(path);
        IConversationRepository convos = repo;   // same instance owns both ports
        await repo.InitializeAsync();

        var list = await convos.ListAsync();
        Assert.Contains(list, c => c.Id == SqliteChatRepository.LegacyConversationId);

        var msgs = await repo.GetThreadMessagesAsync(SqliteChatRepository.LegacyConversationId);
        Assert.Contains(msgs, m => m.Text == "تاریخچه‌ی قبلی");
    }

    [Fact]
    public async Task PerThreadTrim_KeepsOtherConversationsIntact()
    {
        var path = NewDbPath();
        var repo = new SqliteChatRepository(path);
        IConversationRepository convos = repo;
        await repo.InitializeAsync();

        var a = await convos.CreateAsync("گفتگوی الف");
        var b = await convos.CreateAsync("گفتگوی ب");

        // fill A past the per-thread cap
        for (int i = 0; i < SqliteChatRepository.PerThreadCap + 5; i++)
            await repo.AddAsync(New(a.Id, "الف-" + i));
        // a handful in B
        for (int i = 0; i < 3; i++)
            await repo.AddAsync(New(b.Id, "ب-" + i));

        var aMsgs = await repo.GetThreadMessagesAsync(a.Id);
        var bMsgs = await repo.GetThreadMessagesAsync(b.Id);

        Assert.Equal(SqliteChatRepository.PerThreadCap, aMsgs.Count);  // A trimmed to cap
        Assert.Equal(3, bMsgs.Count);                                  // B untouched by A's trim
        Assert.Equal("ب-0", bMsgs[0].Text);
    }

    [Fact]
    public async Task GlobalCeiling_EvictsOldestUnpinnedConversationWhole()
    {
        var path = NewDbPath();
        var repo = new SqliteChatRepository(path, globalCeiling: 20);   // cheap to cross
        IConversationRepository convos = repo;
        await repo.InitializeAsync();

        var pinned = await convos.CreateAsync("قدیمی پین‌شده");
        await convos.SetPinnedAsync(pinned.Id, true);
        for (int i = 0; i < 5; i++) await repo.AddAsync(New(pinned.Id, "p" + i));

        var mid = await convos.CreateAsync("قدیمی");
        for (int i = 0; i < 5; i++) await repo.AddAsync(New(mid.Id, "m" + i));

        var fresh = await convos.CreateAsync("تازه");
        for (int i = 0; i < 12; i++) await repo.AddAsync(New(fresh.Id, "f" + i));   // crosses the ceiling

        var remaining = await convos.ListAsync();
        Assert.Contains(remaining, c => c.Id == pinned.Id);        // pinned survives
        Assert.DoesNotContain(remaining, c => c.Id == mid.Id);     // oldest unpinned evicted whole
        Assert.Contains(remaining, c => c.Id == fresh.Id);         // the writing thread is never the victim
    }

    private static long _seq = 1;
    private static ChatMessage New(long thread, string text) => new()
    {
        Id = Interlocked.Increment(ref _seq),
        ThreadId = thread,
        Role = MessageRole.User,
        Text = text,
        CreatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
    };

    public void Dispose()
    {
        foreach (var f in _files)
        {
            try { File.Delete(f); File.Delete(f + "-wal"); File.Delete(f + "-shm"); } catch { }
        }
    }
}
