using VakilAI.Domain.Entities;
using VakilAI.Domain.ValueObjects;

namespace VakilAI.Domain.Repositories;

/// <summary>Local, device-owned chat persistence (SQLite). The app never relies
/// on server-side history to render — every conversation is stored on-device.
/// Messages are grouped into threads (conversations); the server stays
/// stateless and never learns thread ids.</summary>
public interface IChatRepository
{
    Task InitializeAsync();
    Task<ChatMessage> AddAsync(ChatMessage message, CancellationToken ct = default);
    Task ReplaceAsync(ChatMessage message, CancellationToken ct = default);
    Task DeleteAsync(long id, CancellationToken ct = default);
    Task<IReadOnlyList<ChatMessage>> GetThreadMessagesAsync(long threadId, int take = 250, CancellationToken ct = default);
    Task DeleteThreadAsync(long threadId, CancellationToken ct = default);
    Task ClearAllAsync(CancellationToken ct = default);
    Task<ChatMessage?> GetByIdAsync(long id, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
}

/// <summary>Conversation (thread) index living in the same device DB.</summary>
public interface IConversationRepository
{
    Task InitializeAsync();
    Task<Conversation> CreateAsync(string title, CancellationToken ct = default);
    Task<IReadOnlyList<Conversation>> ListAsync(CancellationToken ct = default);
    Task<Conversation?> GetAsync(long id, CancellationToken ct = default);
    Task RenameAsync(long id, string title, CancellationToken ct = default);
    Task SetPinnedAsync(long id, bool pinned, CancellationToken ct = default);
    Task TouchAsync(long id, CancellationToken ct = default);
    Task DeleteAsync(long id, CancellationToken ct = default);
    Task<IReadOnlyList<Conversation>> SearchAsync(string query, CancellationToken ct = default);
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
