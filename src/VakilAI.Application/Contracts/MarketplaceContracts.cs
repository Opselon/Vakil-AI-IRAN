using System.Text.Json.Serialization;

namespace VakilAI.Application.Contracts;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Wire DTOs + typed port (IMarketplaceApi) for the Vakil
//             marketplace backend: email/username auth, Google login, lawyer
//             directory, consultations, payments, admin foundation.
// OWNER     — COORDINATOR ONLY. UI agents consume IMarketplaceApi; contract
//             changes go through MARKETPLACE_INTEGRATION_REQUESTS.md.
// CONSUMES  — QuotaDto (Ports.cs); same /api/v1 envelope conventions; the
//             session/navigation seam in MarketplaceSession.cs.
// PROVIDES  — auth / lawyer / consultation / payment / admin records and the
//             IMarketplaceApi port implemented by MarketplaceApiClient.cs.
// INVARIANTS— 1) Field names map 1:1 to the worker JSON (camelCase); a change
//                here needs the matching server part change. 2) role and
//                verification_status are server-owned — clients only read them.
//             3) Nullable means 'unknown/not provided', never coerced to 0.
// EXTEND    — new endpoint = one record + one IMarketplaceApi method + one
//             implementation line in MarketplaceApiClient.cs.
// ═══════════════════════════════════════════════════════════════════════════
// ────────────────────────── account / auth ──────────────────────────

/// <summary>Public account view returned by every auth endpoint.</summary>
public sealed record MarketplaceUser(
    [property: JsonPropertyName("userId")] long UserId,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("role")] string Role,                       // client | lawyer | admin
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("username")] string? Username,
    [property: JsonPropertyName("verificationStatus")] string? VerificationStatus, // pending|verified|rejected|suspended (lawyer only)
    [property: JsonPropertyName("authMethods")] string[]? AuthMethods);      // password|google|activation

/// <summary>Shared success shape for signup / login / google / auth-me.</summary>
public sealed record MarketplaceAuthResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("user")] MarketplaceUser? User,
    [property: JsonPropertyName("quota")] QuotaDto? Quota,
    [property: JsonPropertyName("capabilities")] MarketplaceCapabilities? Capabilities,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>Server-declared feature flags — sent by /auth/me (sign-in responses omit them until a route opts in).</summary>
public sealed record MarketplaceCapabilities(
    [property: JsonPropertyName("marketplace")] bool Marketplace,
    [property: JsonPropertyName("lawyerOffice")] bool LawyerOffice,
    [property: JsonPropertyName("admin")] bool Admin);

public sealed record SignupRequest(
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("username")] string? Username,
    [property: JsonPropertyName("password")] string Password,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("role")] string Role,                        // "client" | "lawyer"
    [property: JsonPropertyName("deviceId")] string? DeviceId = null);

public sealed record LoginRequest(
    [property: JsonPropertyName("identifier")] string Identifier,            // email or username
    [property: JsonPropertyName("password")] string Password,
    [property: JsonPropertyName("deviceId")] string? DeviceId = null);

/// <summary>credential = the Google ID token (sign-in button payload), untouched.</summary>
public sealed record GoogleLoginRequest(
    [property: JsonPropertyName("credential")] string Credential,
    [property: JsonPropertyName("deviceId")] string? DeviceId = null);

// ────────────────────────── lawyers ──────────────────────────

/// <summary>Directory card data (public fields only — never private contact info).</summary>
public sealed record LawyerListItem(
    [property: JsonPropertyName("userId")] long UserId,
    [property: JsonPropertyName("slug")] string? Slug,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("city")] string? City,
    [property: JsonPropertyName("experienceYears")] int? ExperienceYears,
    [property: JsonPropertyName("specialties")] string[] Specialties,
    [property: JsonPropertyName("priceToman")] int? PriceToman,
    [property: JsonPropertyName("durationMinutes")] int DurationMinutes,
    [property: JsonPropertyName("isAvailable")] bool IsAvailable,
    [property: JsonPropertyName("verificationStatus")] string VerificationStatus,
    [property: JsonPropertyName("photoUrl")] string? PhotoUrl);

public sealed record LawyerProfile(LawyerListItem Profile);

public sealed record LawyerListResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("lawyers")] LawyerListItem[]? Lawyers,
    [property: JsonPropertyName("total")] int Total,
    [property: JsonPropertyName("hasMore")] bool HasMore,                   // more rows exist beyond this page
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record LawyerProfileResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("userId")] long? UserId,
    [property: JsonPropertyName("slug")] string? Slug,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("bio")] string? Bio,
    [property: JsonPropertyName("specialties")] string[]? Specialties,
    [property: JsonPropertyName("languages")] string[]? Languages,
    [property: JsonPropertyName("city")] string? City,
    [property: JsonPropertyName("jurisdiction")] string? Jurisdiction,
    [property: JsonPropertyName("experienceYears")] int? ExperienceYears,
    [property: JsonPropertyName("priceToman")] int? PriceToman,
    [property: JsonPropertyName("durationMinutes")] int? DurationMinutes,
    [property: JsonPropertyName("availabilityNote")] string? AvailabilityNote,
    [property: JsonPropertyName("isAvailable")] bool IsAvailable,
    [property: JsonPropertyName("verificationStatus")] string? VerificationStatus,
    [property: JsonPropertyName("verificationNote")] string? VerificationNote, // owner/admin view only
    [property: JsonPropertyName("photoUrl")] string? PhotoUrl,
    [property: JsonPropertyName("isSelf")] bool IsSelf,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>Profile edit payload — verificationStatus is deliberately absent (§INVARIANTS).</summary>
public sealed record LawyerSaveRequest(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("title")] string? Title = null,
    [property: JsonPropertyName("bio")] string? Bio = null,
    [property: JsonPropertyName("specialties")] string[]? Specialties = null,
    [property: JsonPropertyName("languages")] string[]? Languages = null,
    [property: JsonPropertyName("city")] string? City = null,
    [property: JsonPropertyName("jurisdiction")] string? Jurisdiction = null,
    [property: JsonPropertyName("experienceYears")] int? ExperienceYears = null,
    [property: JsonPropertyName("priceToman")] int? PriceToman = null,
    [property: JsonPropertyName("durationMinutes")] int? DurationMinutes = null,
    [property: JsonPropertyName("availabilityNote")] string? AvailabilityNote = null,
    [property: JsonPropertyName("isAvailable")] bool? IsAvailable = null,
    [property: JsonPropertyName("photoUrl")] string? PhotoUrl = null);

public sealed record LawyerCategoriesResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("categories")] LawyerCategory[]? Categories);

public sealed record LawyerCategory(
    [property: JsonPropertyName("slug")] string Slug,
    [property: JsonPropertyName("nameFa")] string NameFa,
    [property: JsonPropertyName("nameEn")] string? NameEn);

public sealed record LawyerListRequest(
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("query")] string? Query = null,
    [property: JsonPropertyName("category")] string? Category = null,
    [property: JsonPropertyName("city")] string? City = null,
    [property: JsonPropertyName("maxPrice")] int? MaxPrice = null,
    [property: JsonPropertyName("sort")] string? Sort = null);             // experience|price_asc|price_desc|recent

// ────────────────────────── consultations ──────────────────────────

/// <summary>Explicit lifecycle states (server CHECK-constrained; never a boolean).</summary>
public static class ConsultationStatus
{
    public const string Created = "CREATED";
    public const string PaymentPending = "PAYMENT_PENDING";
    public const string Paid = "PAID";
    public const string Active = "ACTIVE";
    public const string Completed = "COMPLETED";
    public const string Cancelled = "CANCELLED";
    public const string Expired = "EXPIRED";
    public const string Refunded = "REFUNDED";
    public const string Failed = "FAILED";

    public static bool IsWritable(string? s) => s is Active or Paid; // client may send while ACTIVE
    public static bool IsFinished(string? s) => s is Completed or Cancelled or Expired or Refunded or Failed;
}

public sealed record ConsultationDto(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("clientUserId")] long ClientUserId,
    [property: JsonPropertyName("clientName")] string? ClientName,
    [property: JsonPropertyName("lawyerUserId")] long LawyerUserId,
    [property: JsonPropertyName("lawyerName")] string? LawyerName,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("priceToman")] int PriceToman,
    [property: JsonPropertyName("durationMinutes")] int DurationMinutes,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("paidAt")] long? PaidAt,
    [property: JsonPropertyName("startedAt")] long? StartedAt,
    [property: JsonPropertyName("endsAt")] long? EndsAt,
    [property: JsonPropertyName("lastMessageAt")] long? LastMessageAt,
    [property: JsonPropertyName("unreadForMe")] int UnreadForMe);

public sealed record ConsultationListResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("consultations")] ConsultationDto[]? Consultations,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record ConsultationCreateRequest(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("lawyerUserId")] long LawyerUserId,
    [property: JsonPropertyName("durationMinutes")] int? DurationMinutes = null,
    [property: JsonPropertyName("idempotencyKey")] string? IdempotencyKey = null);

public sealed record ConsultationCreateResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("consultation")] ConsultationDto? Consultation,
    [property: JsonPropertyName("paymentId")] long? PaymentId,
    [property: JsonPropertyName("amountToman")] int? AmountToman,
    [property: JsonPropertyName("provider")] string? Provider,             // "devtest" in V1
    [property: JsonPropertyName("devModeNotice")] string? DevModeNotice,   // honest label, never hidden
    [property: JsonPropertyName("duplicated")] bool Duplicated,            // idempotent replay: the SAME consultation
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record ConsultationPayRequest(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("consultationId")] long ConsultationId,
    [property: JsonPropertyName("idempotencyKey")] string? IdempotencyKey = null);

public sealed record ConsultationPayResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("consultation")] ConsultationDto? Consultation,
    [property: JsonPropertyName("paymentStatus")] string? PaymentStatus,
    [property: JsonPropertyName("commissionToman")] int? CommissionToman,
    [property: JsonPropertyName("lawyerEarningsToman")] int? LawyerEarningsToman,
    [property: JsonPropertyName("paymentId")] long? PaymentId,
    [property: JsonPropertyName("provider")] string? Provider,
    [property: JsonPropertyName("devModeNotice")] string? DevModeNotice,    // honest test-payment label
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record ConsultationMessageDto(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("consultationId")] long ConsultationId,
    [property: JsonPropertyName("senderUserId")] long SenderUserId,
    [property: JsonPropertyName("senderRole")] string SenderRole,           // client|lawyer
    [property: JsonPropertyName("senderName")] string? SenderName,
    [property: JsonPropertyName("body")] string Body,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("mine")] bool Mine);                        // server-authoritative (fixes dual-role bubble fallback)

public sealed record ConsultationMessagesResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("consultation")] ConsultationDto? Consultation,
    [property: JsonPropertyName("messages")] ConsultationMessageDto[]? Messages,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record ConsultationSendRequest(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("consultationId")] long ConsultationId,
    [property: JsonPropertyName("body")] string Body);

// ────────────────────────── payments ──────────────────────────

public sealed record PaymentHistoryResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("transactions")] PaymentTransactionDto[]? Transactions,
    [property: JsonPropertyName("grossToman")] long GrossToman,
    [property: JsonPropertyName("commissionToman")] long CommissionToman,
    [property: JsonPropertyName("earningsToman")] long EarningsToman,       // lawyer: their share; client: 0
    [property: JsonPropertyName("pendingPayoutToman")] long PendingPayoutToman, // V1: accrued earnings, payout not modelled
    [property: JsonPropertyName("payoutNotice")] string? PayoutNotice,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record PaymentTransactionDto(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("consultationId")] long ConsultationId,
    [property: JsonPropertyName("amountToman")] int AmountToman,
    [property: JsonPropertyName("status")] string Status,                   // pending|succeeded|failed|refunded
    [property: JsonPropertyName("provider")] string Provider,
    [property: JsonPropertyName("commissionToman")] int? CommissionToman,
    [property: JsonPropertyName("lawyerEarningsToman")] int? LawyerEarningsToman,
    [property: JsonPropertyName("createdAt")] long CreatedAt,
    [property: JsonPropertyName("settledAt")] long? SettledAt);

// ────────────────────────── admin foundation ──────────────────────────

public sealed record AdminOverviewResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("users")] long Users,
    [property: JsonPropertyName("lawyersTotal")] long LawyersTotal,
    [property: JsonPropertyName("lawyersPending")] long LawyersPending,
    [property: JsonPropertyName("lawyersVerified")] long LawyersVerified,
    [property: JsonPropertyName("consultationsOpen")] long ConsultationsOpen,
    [property: JsonPropertyName("grossToman")] long GrossToman,
    [property: JsonPropertyName("commissionToman")] long CommissionToman,
    [property: JsonPropertyName("commissionBps")] int CommissionBps,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record AdminUserRow(
    [property: JsonPropertyName("userId")] long UserId,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("username")] string? Username,
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("verificationStatus")] string? VerificationStatus,
    [property: JsonPropertyName("createdAt")] long? CreatedAt,
    [property: JsonPropertyName("lastLoginAt")] long? LastLoginAt);

public sealed record AdminUsersResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("users")] AdminUserRow[]? Users,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>Review-queue rows: the lawyer-side mirror of AdminUserRow (server /admin/lawyers/pending answers lawyers[]).</summary>
public sealed record AdminLawyerRow(
    [property: JsonPropertyName("userId")] long UserId,
    [property: JsonPropertyName("slug")] string? Slug,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("bio")] string? Bio,
    [property: JsonPropertyName("specialties")] string[]? Specialties,
    [property: JsonPropertyName("languages")] string[]? Languages,
    [property: JsonPropertyName("city")] string? City,
    [property: JsonPropertyName("jurisdiction")] string? Jurisdiction,
    [property: JsonPropertyName("experienceYears")] int? ExperienceYears,
    [property: JsonPropertyName("priceToman")] int? PriceToman,
    [property: JsonPropertyName("durationMinutes")] int? DurationMinutes,
    [property: JsonPropertyName("isAvailable")] bool IsAvailable,
    [property: JsonPropertyName("verificationStatus")] string? VerificationStatus,
    [property: JsonPropertyName("verificationNote")] string? VerificationNote,
    [property: JsonPropertyName("createdAt")] long? CreatedAt);

public sealed record AdminLawyersResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("lawyers")] AdminLawyerRow[]? Lawyers,
    [property: JsonPropertyName("total")] int Total,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

public sealed record AdminDecisionRequest(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("userId")] long UserId,
    [property: JsonPropertyName("decision")] string Decision,               // verify|reject|suspend|restore
    [property: JsonPropertyName("note")] string? Note = null);

public sealed record AdminDecisionResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("userId")] long? UserId,
    [property: JsonPropertyName("verificationStatus")] string? VerificationStatus,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

// ────────────────────────── typed port ──────────────────────────

/// <summary>
/// Single external surface of the marketplace features (implemented by
/// MarketplaceApiClient in Infrastructure). UI agents: never touch HttpClient
/// directly — resolve this from MauiProgram.Services.
/// Every method may throw AppApiException (Codes: NETWORK/TIMEOUT/RATE_LIMITED/
/// BAD_RESPONSE/UNAUTHORIZED) — callers already handle that in the chat engine;
/// business rejections come back as Ok=false + Code/Message (presentable Persian).
/// </summary>
public interface IMarketplaceApi
{
    // auth
    Task<MarketplaceAuthResponse> SignupAsync(SignupRequest request, CancellationToken ct = default);
    Task<MarketplaceAuthResponse> LoginAsync(LoginRequest request, CancellationToken ct = default);
    Task<MarketplaceAuthResponse> GoogleLoginAsync(GoogleLoginRequest request, CancellationToken ct = default);
    Task<MarketplaceAuthResponse> MeAsync(string token, CancellationToken ct = default);

    /// <summary>Sets/changes the account password (recovery foundation; also adopts legacy sessions).</summary>
    Task<MarketplaceAuthResponse> SetPasswordAsync(string token, string newPassword, CancellationToken ct = default);

    // lawyers
    Task<LawyerCategoriesResponse> CategoriesAsync(string? token, CancellationToken ct = default);
    Task<LawyerListResponse> LawyersAsync(LawyerListRequest request, CancellationToken ct = default);
    Task<LawyerProfileResponse> LawyerProfileAsync(long userId, string token, CancellationToken ct = default);
    Task<LawyerProfileResponse> LawyerProfileBySlugAsync(string slug, string token, CancellationToken ct = default);
    Task<LawyerProfileResponse> MyLawyerProfileAsync(string token, CancellationToken ct = default);

    /// <summary>Client upgrades own account to role=lawyer; server creates a PENDING profile (never auto-verified).</summary>
    Task<LawyerProfileResponse> ApplyAsLawyerAsync(string token, CancellationToken ct = default);
    Task<LawyerProfileResponse> SaveLawyerProfileAsync(LawyerSaveRequest request, CancellationToken ct = default);

    // consultations
    Task<ConsultationCreateResponse> ConsultationCreateAsync(ConsultationCreateRequest request, CancellationToken ct = default);
    Task<ConsultationPayResponse> ConsultationPayAsync(ConsultationPayRequest request, CancellationToken ct = default);
    Task<ConsultationListResponse> ConsultationsAsync(string token, CancellationToken ct = default);
    Task<ConsultationMessagesResponse> ConsultationMessagesAsync(string token, long consultationId, long afterId, CancellationToken ct = default);
    Task<ConsultationMessagesResponse> ConsultationSendAsync(ConsultationSendRequest request, CancellationToken ct = default);
    Task<ConsultationListResponse> ConsultationCompleteAsync(string token, long consultationId, CancellationToken ct = default);

    // payments
    Task<PaymentHistoryResponse> PaymentHistoryAsync(string token, CancellationToken ct = default);

    // admin foundation
    Task<AdminOverviewResponse> AdminOverviewAsync(string token, CancellationToken ct = default);
    Task<AdminUsersResponse> AdminUsersAsync(string token, string? filter, CancellationToken ct = default);
    Task<AdminLawyersResponse> AdminPendingLawyersAsync(string token, CancellationToken ct = default);
    Task<AdminDecisionResponse> AdminDecideAsync(AdminDecisionRequest request, CancellationToken ct = default);
}
