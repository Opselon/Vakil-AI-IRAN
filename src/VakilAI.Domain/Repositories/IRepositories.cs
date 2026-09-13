using VakilAI.Domain.Entities;
using VakilAI.Domain.ValueObjects;

namespace VakilAI.Domain.Repositories;

/// <summary>Local, device-owned chat persistence (SQLite). The app never relies
/// on server-side history to render — every conversation is stored on-device.</summary>
public interface IChatRepository
{
    Task InitializeAsync();
    Task<ChatMessage> AddAsync(ChatMessage message, CancellationToken ct = default);
    Task ReplaceAsync(ChatMessage message, CancellationToken ct = default);
    Task DeleteAsync(long id, CancellationToken ct = default);
    Task<IReadOnlyList<ChatMessage>> GetRecentAsync(int take = 100, CancellationToken ct = default);
    Task ClearAllAsync(CancellationToken ct = default);
    Task<ChatMessage?> GetByIdAsync(long id, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
}

/// <summary>Drafting-mode transcript buffer (mirrors users.draft_data server-side).</summary>
public interface IDraftingRepository
{
    Task<string> GetTranscriptAsync(CancellationToken ct = default);
    Task AppendAsync(string userText, string aiText, CancellationToken ct = default);
    Task ResetAsync(CancellationToken ct = default);
}

/// <summary>Persisted device identity (survives app updates).</summary>
public interface IDeviceStore
{
    Task<DeviceId?> GetDeviceIdAsync();
    Task SaveDeviceIdAsync(DeviceId id);
    Task<string?> GetUserNameAsync();
    Task SaveUserNameAsync(string name);
}
