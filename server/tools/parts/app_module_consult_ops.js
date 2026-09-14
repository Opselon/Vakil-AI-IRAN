// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Consultation money-adjacent operations for the Vakil AI worker:
//             the CLIENT-side POST /consultations/cancel (unpaid drafts only)
//             and the dev/test-only POST /consultations/refund (paid-but-not-
//             started sessions). Both close the lifecycle through Agent 7's
//             consultationTransition seam; the refund additionally claims the
//             settled payment row out-of-band via a CAS UPDATE — nothing here
//             ever moves real money.
// OWNER     — Wave-2 lane B — consultation cancel/refund. Future edits to this
//             part belong to that lane (coordinator on merge).
// CONSUMES  — appApiJson/appApiErr (app_module_head.js); marketplaceRegister,
//             marketplaceEnsureTables, marketplaceRequireToken, marketplaceNow,
//             marketplaceRateLimit (app_module_common.js); the Agent 7 seam
//             (app_module_consultations.js) — consultationLoad,
//             consultationMembership, consultationTransition, consultationView
//             — resolved ONLY inside function bodies (order-independent, same
//             discipline as payments INVARIANT e); Agent 8's seam
//             paymentProviderName(env) for the provider gate; D1 tables
//             consultations, payments, payment_splits (read — never written).
// PROVIDES  — Routes: POST /api/v1/consultations/cancel · /refund.
//             Response shape (both, success): ConsultationOpResponse
//             {ok, consultation(dto), refundAmountToman, message} — camelCase,
//             mirroring the .NET record requested in
//             src/VakilAI.Application/Contracts/MarketplaceContracts.cs.
//             (The .NET record is coordinator-owned; appended as a
//             contract-request in MARKETPLACE_INTEGRATION_REQUESTS.md.)
// INVARIANTS— 1) NEVER marks a non-devtest settled payment refunded: BOTH the
//                configured provider (paymentProviderName) AND the payment row's
//                own provider column must be exactly 'devtest', else
//                PROVIDER_NOT_REFUNDABLE 502 — the worker refuses to pretend it
//                reversed money a real PSP holds.
//             2) payment_splits is an IMMUTABLE historical ledger: refund flips
//                ONLY payments.status ('succeeded'→'refunded', CAS with
//                refunded_at stamped in the same UPDATE) and the consultation
//                lifecycle; the split row REMAINS so earned/commission totals
//                stay auditable and refund visibility derives from
//                payments.status.
//             3) The CAS UPDATE ... WHERE id=? AND status='succeeded' is the
//                single-writer race guard: a concurrent double-refund loser
//                never re-stamps refunded_at and never re-drives money — it
//                re-reads and converges to the winner's honest state.
//             4) Membership is re-derived from the ROW (Agent 7
//                consultationMembership) for every call; a non-participant gets
//                the SAME 404 as a missing id (audit L1 rule — ids are
//                time-ordered, 403 would leak existence). Only the consultation
//                CLIENT may cancel/refund (lawyer = 403, they are a member).
//             5) Refund requires consultations.status === 'PAID' — never ACTIVE
//                (the conversation window was already consumed) and never
//                lazily-expired variants: one simple rule, no ends_at maths.
//                Cancel requires CREATED/PAYMENT_PENDING only; paid/live rows
//                answer CONSULTATION_CLOSED 409 pointing at the separate,
//                deliberate /refund action.
//             6) No import/export/top-level await; the only top-level side
//                effects are marketplaceRegister(...). Agent 7/8 symbols are
//                typeof-guarded inside handlers and fail CLOSED as JSON.
// EXTEND    — Reversal of a refund (refunded→succeeded) is an ADMIN-side action
//             for a later wave: register it in app_module_admin.js, re-CAS the
//             payments row (WHERE status='refunded' → 'succeeded', cleared
//             refunded_at) with an admin_audit_log entry, and drive the
//             consultation REFUNDED→PAID through consultationTransition. A real
//             PSP refund = a new provider capability (provider.refund(ctx))
//             consumed by the same CAS — this part must keep refusing until
//             such a provider exists.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── tiny local helpers ───────────────────────────
// Deliberately NOT reusing the sibling files' private helpers (consultationNum
// / paymentInt): the integrity gate requires every top-level name to be unique,
// and each module keeps its own defensive parsers.

function consultOpsInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Positive-integer parse for ids/amounts; anything else → null (never 0). */
function consultOpsNum(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  const f = Number(value);
  return Number.isSafeInteger(f) && f > 0 ? f : null;
}

/** Handler-side table gate: a schema failure must answer 500, never crash. */
async function consultOpsPrepare(env) {
  try {
    await marketplaceEnsureTables(env);
    return null;
  } catch (e) {
    console.error("consultOpsPrepare error:", e && e.message);
    return appApiErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }
}

/** Agent 7 seam callable? Fail closed (payments INVARIANT e discipline). */
function consultOpsSeamReady() {
  return typeof consultationLoad === "function"
    && typeof consultationMembership === "function"
    && typeof consultationTransition === "function"
    && typeof consultationView === "function";
}

function consultOpsSeamMissing() {
  return appApiErr("CONSULTATION_MODULE_MISSING",
    "ماژول مشاوره در دسترس نیست؛ عملیات انجام نشد.", 500);
}

/**
 * Auth + load + client-membership gate shared by cancel and refund.
 * @returns {Promise<{row, viewer, err}>} `err` is a Response when denied.
 * Codes: UNAUTHORIZED 401 (token), CONSULTATION_ID_INVALID 400, NOT_FOUND 404
 * (missing OR non-participant — uniform L1 answer), FORBIDDEN 403 (member but
 * not the client, e.g. the lawyer), RATE_LIMITED 429.
 */
async function consultOpsClientGate(env, body, bucket, limit) {
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return { err: auth.err };
  const uid = consultOpsInt(auth.payload.uid, 0);
  if (!await marketplaceRateLimit(env, bucket + ":" + uid, limit, 60000)) {
    return { err: appApiErr("RATE_LIMITED", "تعداد درخواست‌های شما زیاد است؛ چند لحظه دیگر تلاش کنید.", 429) };
  }
  const cid = consultOpsNum(body && body.consultationId);
  if (cid === null) {
    return { err: appApiErr("CONSULTATION_ID_INVALID", "شناسه مشاوره نامعتبر است.", 400) };
  }
  const row = await consultationLoad(env, cid);
  if (!row) {
    return { err: appApiErr("NOT_FOUND", "مشاوره‌ای با این شناسه یافت نشد.", 404) };
  }
  let membership = null;
  try { membership = consultationMembership(row, uid); }
  catch (e) {
    console.error("consultOpsClientGate membership error:", e && e.message);
    return { err: appApiErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500) };
  }
  if (!membership) {
    // Same answer as "no such consultation" (audit L1): existence is not leakable.
    return { err: appApiErr("NOT_FOUND", "مشاوره‌ای با این شناسه یافت نشد.", 404) };
  }
  if (membership !== "client") {
    return { err: appApiErr("FORBIDDEN", "فقط کارفرمای همین مشاوره می‌تواند این عملیات را انجام دهد.", 403) };
  }
  return { row, viewer: uid };
}

/** ConsultationOpResponse success envelope (shape fixed by the .NET record). */
async function consultOpsResponse(env, row, viewerId, refundAmountToman, message, code) {
  const payload = {
    ok: true,
    consultation: await consultationView(env, row, viewerId),
    refundAmountToman: consultOpsInt(refundAmountToman, 0),
    message: String(message || "")
  };
  if (code) payload.code = code; // additive; the .NET record ignores unknown fields
  return appApiJson(payload);
}

/**
 * The settled (or refunded) payment row for one consultation, newest first.
 * @param {string} status 'succeeded' | 'refunded'
 */
async function consultOpsPaymentByStatus(env, consultationId, status) {
  try {
    return await env.DB.prepare(
      "SELECT * FROM payments WHERE consultation_id = ? AND status = ? ORDER BY id DESC LIMIT 1"
    ).bind(consultationId, status).first();
  } catch (e) {
    console.error("consultOpsPaymentByStatus error:", e && e.message);
    return null;
  }
}

// ─────────────────────────── POST /api/v1/consultations/cancel ───────────────────────────

/**
 * Cancel an UNPAID consultation (the client's own). Only CREATED /
 * PAYMENT_PENDING can be cancelled; a paid or live session answers
 * CONSULTATION_CLOSED 409 and points at /refund as the separate, deliberate
 * money action — cancelling must never become a silent refund path.
 * Body: {token, consultationId}
 * Codes: UNAUTHORIZED 401 · RATE_LIMITED 429 (10/min) · CONSULTATION_ID_INVALID
 * 400 · NOT_FOUND 404 (missing or non-participant, uniform) · FORBIDDEN 403
 * (lawyer) · CONSULTATION_CLOSED 409 (paid/live/closed) · INTERNAL 500.
 */
async function consultOpsHandleCancel(env, ctx, body) {
  if (!consultOpsSeamReady()) return consultOpsSeamMissing();
  const prep = await consultOpsPrepare(env);
  if (prep) return prep;

  const gate = await consultOpsClientGate(env, body, "cons-cancel", 10);
  if (gate.err) return gate.err;
  const row = gate.row, viewer = gate.viewer;
  const cid = consultOpsNum(row.id);
  const status = String(row.status || "");

  const refundHint = "این مشاوره پرداخت شده است؛ لغو آن ممکن نیست و باید در صورت صلاحدید از «بازپرداخت» (اقدامی جداگانه) استفاده کنید.";

  if (status === "CANCELLED") {
    return consultOpsResponse(env, row, viewer, 0,
      "این مشاوره پیش‌تر لغو شده بود؛ وضعیت فعلی نمایش داده می‌شود.",
      "CONSULTATION_ALREADY_CANCELLED");
  }
  if (status === "PAID" || status === "ACTIVE") {
    return appApiErr("CONSULTATION_CLOSED", refundHint, 409);
  }
  if (status !== "CREATED" && status !== "PAYMENT_PENDING") {
    return appApiErr("CONSULTATION_CLOSED",
      "این مشاوره بسته شده است و امکان لغو وجود ندارد.", 409);
  }

  // Atomic FROM-guard inside the transition: a concurrent payer that flipped
  // the row to PAID wins, and this cancel re-reads and refuses honestly.
  const tr = await consultationTransition(env, cid, ["CREATED", "PAYMENT_PENDING"], "CANCELLED");
  const fresh = (tr && tr.row) || (await consultationLoad(env, cid)) || row;
  if ((!tr || tr.ok !== true) && String(fresh.status || "") !== "CANCELLED") {
    const nowStatus = String(fresh.status || "");
    if (nowStatus === "PAID" || nowStatus === "ACTIVE") {
      return appApiErr("CONSULTATION_CLOSED",
        "همزمان این مشاوره پرداخت شد و دیگر قابل لغو نیست. " + refundHint, 409);
    }
    return appApiErr("CONSULTATION_CLOSED",
      "این مشاوره در وضعیت جاری قابل لغو نیست. لطفاً صفحه را تازه‌سازی کنید.", 409);
  }
  return consultOpsResponse(env, fresh, viewer, 0,
    "مشاوره لغو شد. وجهی دریافت نشده بود، بنابراین بازپرداختی لازم نیست.",
    "CONSULTATION_CANCELLED");
}

// ─────────────────────────── POST /api/v1/consultations/refund ───────────────────────────

/**
 * Provider gate for the simulator-only refund (INVARIANT 1): the CONFIGURED
 * provider must be exactly 'devtest' — a real PSP (or a typo'd/unregistered
 * config, which paymentProviderName reports as 'UNREGISTERED:…') refuses with
 * PROVIDER_NOT_REFUNDABLE 502, because this endpoint reverses LEDGER state and
 * must never pretend it moved a real bank's money.
 * @returns {Promise<{err?:Response}>} err set ⇒ refund blocked.
 */
async function consultOpsProviderAllowsRefund(env) {
  if (typeof paymentProviderName !== "function") {
    return { err: appApiErr("PROVIDER_NOT_REFUNDABLE",
      "سرویس پرداخت برای بررسی بازپرداخت در دسترس نیست؛ با پشتیبانی تماس بگیرید.", 502) };
  }
  let configured = "";
  try { configured = String(await paymentProviderName(env) || ""); }
  catch (e) {
    console.error("consultOpsProviderAllowsRefund error:", e && e.message);
    return { err: appApiErr("PROVIDER_NOT_REFUNDABLE",
      "امکان بررسی پرداخت‌کننده وجود نداشت؛ بازپرداخت انجام نشد.", 502) };
  }
  if (configured !== "devtest") {
    return { err: appApiErr("PROVIDER_NOT_REFUNDABLE",
      "بازپرداخت خودکار فقط در حالت آزمایشی (devtest) امکان‌پذیر است؛ برای بازگشت وجه واقعی با پشتیبانی تماس بگیرید.", 502) };
  }
  return {};
}

/**
 * Dev/test-only refund of a PAID-but-not-started consultation (client only).
 * Order of operations is deliberate: membership → status → provider gate →
 * succeeded-payment guard → CAS on payments → consultation transition. The
 * payment_splits ledger row is left untouched (INVARIANT 2). A replayed or
 * concurrent-refunded row answers idempotently; exactly one call ever stamps
 * refunded_at (INVARIANT 3).
 * Body: {token, consultationId}
 * Codes: UNAUTHORIZED 401 · RATE_LIMITED 429 (5/min) · CONSULTATION_ID_INVALID
 * 400 · NOT_FOUND 404 (uniform L1) · FORBIDDEN 403 · CONSULTATION_STARTED 409
 * (ACTIVE) · CONSULTATION_NOT_PAID 409 (unpaid) · CONSULTATION_CLOSED 409
 * (COMPLETED/EXPIRED/CANCELLED/FAILED) · PROVIDER_NOT_REFUNDABLE 502 ·
 * PAYMENT_NOT_FOUND 409 · INTERNAL 500.
 */
async function consultOpsHandleRefund(env, ctx, body) {
  if (!consultOpsSeamReady()) return consultOpsSeamMissing();
  const prep = await consultOpsPrepare(env);
  if (prep) return prep;

  const gate = await consultOpsClientGate(env, body, "cons-refund", 5);
  if (gate.err) return gate.err;
  const row = gate.row, viewer = gate.viewer;
  const cid = consultOpsNum(row.id);
  const status = String(row.status || "");

  if (status === "ACTIVE") {
    return appApiErr("CONSULTATION_STARTED",
      "جلسه آغاز شده است؛ پس از شروع گفتگو، مبلغ مشاوره قابل بازپرداخت نیست.", 409);
  }
  if (status === "REFUNDED") {
    // Idempotent replay of a finished refund: no money action, no provider call.
    const done = await consultOpsPaymentByStatus(env, cid, "refunded");
    return consultOpsResponse(env, row, viewer, consultOpsInt(done && done.amount_toman, 0),
      "بازپرداخت این مشاوره پیش‌تر انجام شده بود؛ وضعیت فعلی نمایش داده می‌شود.",
      "CONSULTATION_ALREADY_REFUNDED");
  }
  if (status !== "PAID") {
    const unpaid = status === "CREATED" || status === "PAYMENT_PENDING";
    return appApiErr(unpaid ? "CONSULTATION_NOT_PAID" : "CONSULTATION_CLOSED",
      unpaid ? "این مشاوره پرداخت نشده است؛ چیزی برای بازپرداخت وجود ندارد."
        : "این مشاوره بسته شده است و امکان بازپرداخت وجود ندارد.", 409);
  }

  // ---- provider gate BEFORE touching any money row (INVARIANT 1) ----
  const prov = await consultOpsProviderAllowsRefund(env);
  if (prov.err) return prov.err;

  const payment = await consultOpsPaymentByStatus(env, cid, "succeeded");
  if (!payment) {
    // PAID with no settled payment row is a broken world — say so, touch nothing.
    return appApiErr("PAYMENT_NOT_FOUND",
      "رکورد پرداخت موفقِ این مشاوره یافت نشد؛ بازپرداخت انجام نشد. با پشتیبانی هماهنگ کنید.", 409);
  }
  if (String(payment.provider || "") !== "devtest") {
    // Row provenance guard: even with devtest configured, a payment that was
    // settled by another provider is not ours to reverse.
    return appApiErr("PROVIDER_NOT_REFUNDABLE",
      "این پرداخت توسط پرداخت‌کننده‌ای غیر از حالت آزمایشی انجام شده و در این نسخه قابل بازپرداخت خودکار نیست؛ با پشتیبانی تماس بگیرید.", 502);
  }

  const paymentId = consultOpsNum(payment.id) || 0;
  const refundAmount = consultOpsInt(payment.amount_toman, 0);

  // ---- CAS: the ONE write that marks money refunded (INVARIANT 3) ----
  let claim = null;
  try {
    claim = await env.DB.prepare(
      "UPDATE payments SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'succeeded'"
    ).bind(marketplaceNow(), paymentId).run();
  } catch (e) {
    console.error("consultOpsHandleRefund CAS error:", e && e.message);
    return appApiErr("INTERNAL", "بازپرداخت انجام نشد. لطفاً دوباره تلاش کنید.", 500);
  }
  const won = Boolean(claim && claim.meta && Number(claim.meta.changes) === 1);
  if (!won) {
    // Lost the race (or a replay): the row has moved under us. Re-read; only an
    // honest 'refunded' converges, anything else refuses. The winner — not us —
    // stamped refunded_at; we never touch it again.
    const again = await consultOpsPaymentByStatus(env, cid, "refunded");
    if (!again || consultOpsNum(again.id) !== paymentId || String(again.status || "") !== "refunded") {
      const other = await env.DB.prepare("SELECT status FROM payments WHERE id = ?").bind(paymentId).first();
      if (String((other && other.status) || "") !== "refunded") {
        return appApiErr("PAYMENT_NOT_REFUNDABLE",
          "وضعیت پرداخت این مشاوره تغییر کرده است؛ بازپرداخت انجام نشد. لطفاً صفحه را تازه‌سازی کنید.", 409);
      }
    }
  }

  // ---- lifecycle: PAID → REFUNDED (FROM-guard converges concurrent callers) --
  const tr = await consultationTransition(env, cid, ["PAID"], "REFUNDED");
  const fresh = (tr && tr.row) || (await consultationLoad(env, cid)) || row;
  if ((!tr || tr.ok !== true) && String(fresh.status || "") !== "REFUNDED") {
    // Money state already flipped; only the lifecycle row moved under us (e.g.
    // the live-session starter won). Report the refund honestly, flag the lag.
    return appApiJson({
      ok: true,
      consultation: await consultationView(env, fresh, viewer),
      refundAmountToman: refundAmount,
      code: "REFUND_APPLIED_STATE_PENDING",
      message: "بازپرداخت ثبت شد ولی وضعیت مشاوره به‌روزرسانی نشد. لطفاً وضعیت را از فهرست مشاوره‌ها ببینید."
    });
  }
  return consultOpsResponse(env, fresh, viewer, refundAmount,
    "بازپرداخت در حالت آزمایشی ثبت شد؛ هیچ وجه واقعی جابه‌جا نشده است.",
    won ? "CONSULTATION_REFUNDED" : "CONSULTATION_ALREADY_REFUNDED");
}

// ─────────────────────────── route registration (only top-level effects) ───────────────────────────
marketplaceRegister("POST /api/v1/consultations/cancel", async (env, ctx, body) => {
  try { return await consultOpsHandleCancel(env, ctx, body); }
  catch (e) { console.error("consultations/cancel failed:", e && e.message); return appApiErr("INTERNAL", "لغو مشاوره انجام نشد. لطفاً دوباره تلاش کنید.", 500); }
});
marketplaceRegister("POST /api/v1/consultations/refund", async (env, ctx, body) => {
  try { return await consultOpsHandleRefund(env, ctx, body); }
  catch (e) { console.error("consultations/refund failed:", e && e.message); return appApiErr("INTERNAL", "بازپرداخت انجام نشد. لطفاً دوباره تلاش کنید.", 500); }
});
