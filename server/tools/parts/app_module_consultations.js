// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Consultation domain for the Vakil AI worker: the explicit
//             lifecycle (CREATED → PAYMENT_PENDING → PAID → ACTIVE → COMPLETED,
//             plus CANCELLED/EXPIRED/REFUNDED/FAILED as other-terminal states)
//             and the membership-enforced consultation chat that lives BESIDE
//             the AI chat, never inside it (spec §2.4, §2.6 — no WebSockets in
//             V1: the client polls POST /consultations/messages with afterId).
// OWNER     — Agent 7 — Consultation. These routes/domain helpers belong here;
//             the payment side (pay/ledger/splits) belongs to app_module_payments.js.
// CONSUMES  — appApiJson/appApiErr (app_module_head.js); marketplaceRegister,
//             marketplaceEnsureTables, marketplaceRequireToken/Role,
//             marketplaceNewId, marketplaceNow, marketplaceRateLimit
//             (app_module_common.js); env.DB (D1 ailawyer): consultations,
//             consultation_messages, app_accounts, lawyer_profiles.
//             Agent 8 (app_module_payments.js) supplies at build time:
//             paymentProviderName(env) [async]; paymentCreatePending(env,
//             {consultation, amountToman, idempotencyKey}) → paymentId — the only
//             one this file CALLS (create quotes the pending payment).
//             paymentCharge(env, {paymentId, idempotencyKey}) → {ok, status,
//             providerRef, error} is consumed by Agent 8's own /pay route; it is
//             named here only so the seam is documented, never called by me.
// PROVIDES  — Routes: POST /api/v1/consultations/create · /list · /get ·
//             /messages · /send · /complete.  (/consultations/pay is Agent 8's
//             and is deliberately NOT registered here.)
//             Seam functions for Agent 8/integrators — exact signatures:
//               async function consultationLoad(env, consultationId)
//                     → consultations row | null
//               function consultationMembership(row, userId)
//                     → 'client' | 'lawyer' | null
//               async function consultationTransition(env, consultationId,
//                     fromStatuses, toStatus, extraCols)
//                     → {ok: boolean, row: object|null}   (fromStatuses = string[])
//               async function consultationView(env, row, viewerUserId)
//                     → camelCase ConsultationDto | null
// INVARIANTS— 1) Membership is re-derived on EVERY read and write from the
//                verified token payload only (payload.uid vs the row's two user
//                ids). A client-supplied userId/role/scope is never consulted
//                for authorization.
//             2) Lifecycle is state, never a boolean: every transition goes
//                through consultationTransition, whose FROM guard lives in the
//                UPDATE's WHERE clause (atomic under D1 — two racing payers
//                cannot both flip PAID). extraCols keys are server-controlled
//                column names, NEVER built from request JSON.
//             3) price_toman/duration_minutes are SNAPSHOTS at creation and are
//                never retro-mutated. Writes are allowed only in PAID/ACTIVE;
//                history is readable in PAID/ACTIVE/COMPLETED (evidence!) and
//                never before payment (NOT_ACTIVE for PAYMENT_PENDING/CREATED).
//                A passed ends_at lazily closes the session (COMPLETED) and the
//                send is refused with CONSULTATION_EXPIRED.
//             4) NO Agent-8 symbol is referenced at top level.
//                paymentProviderName/paymentCreatePending are resolved via
//                `typeof x === "function"` INSIDE the create handler only, so
//                this part concatenates and boots even while
//                app_module_payments.js does not exist yet; then the response
//                says so honestly (code PAYMENT_UNAVAILABLE, paymentId null).
//             5) No import/export/top-level await; the only top-level side
//                effects are marketplaceRegister(...) calls. Nothing is seeded;
//                no lawyer row, consultation or timestamp is invented — `now`
//                is the only time this module creates.
//             6) Idempotency: a present idempotencyKey is pre-read, and the
//                UNIQUE (client_user_id, idempotency_key) index remains the
//                source of truth for concurrent retries: the constraint error is
//                caught, the existing row re-read, returned with duplicated:true.
// EXTEND    — V2 (cancellation/refund UX, reviews, expiry sweeper, push):
//             register the new route at the bottom of this file and reuse
//             consultationGuard()/consultationTransition() instead of
//             re-checking membership by hand; add consultations columns
//             additively (via app_module_schema.js, Agent 3) and mirror them in
//             consultationView + the .NET record in one coordinated commit.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── domain constants ───────────────────────────
// Mirrors the D1 CHECK constraint (spec §3) and MarketplaceContracts.ConsultationStatus.
const CONSULTATION_LIFECYCLE = ["CREATED", "PAYMENT_PENDING", "PAID", "ACTIVE",
  "COMPLETED", "CANCELLED", "EXPIRED", "REFUNDED", "FAILED"];

const CONSULTATION_LIST_LIMIT = 50;     // newest first
const CONSULTATION_PAGE_LIMIT = 200;    // messages per pull
const CONSULTATION_BODY_MAX = 4000;     // chars
const CONSULTATION_MIN_MINUTES = 15;
const CONSULTATION_MAX_MINUTES = 180;
// law_profiles.duration_minutes DEFAULT 45 (spec §3) — the honest fallback when
// a legacy row carries no duration, instead of silently granting the max window.
const CONSULTATION_DEFAULT_MINUTES = 45;
// Reading history is allowed once the session is paid, live, or finished
// (evidence); never while it still waits for payment.
const CONSULTATION_HISTORY_STATUSES = ["PAID", "ACTIVE", "COMPLETED"];
// Either participant may end a live/paid session (spec §2.4 + the fixed brief).
const CONSULTATION_CLOSE_FROM = ["PAID", "ACTIVE"];
const CONSULTATION_CLOSED_STATUSES = ["COMPLETED", "CANCELLED", "EXPIRED", "REFUNDED", "FAILED"];

let CONSULTATION_TABLES_READY = false;

// ─────────────────────────── tiny local helpers ───────────────────────────

/** D1 surfaces SQLite errors as plain Errors carrying the SQL text — UNIQUE probe. */
function consultationIsUniqueViolation(e) {
  return /UNIQUE constraint failed|constraint failed|ON CONFLICT/i.test(
    String((e && (e.message || e.error)) || e || ""));
}

function consultationInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function consultationClampMinutes(v, fallback) {
  const n = consultationInt(v, consultationInt(fallback, CONSULTATION_DEFAULT_MINUTES));
  return Math.min(CONSULTATION_MAX_MINUTES, Math.max(CONSULTATION_MIN_MINUTES, n));
}

/** SQLite hosts hand back INTEGER cells as bigint on some runtimes — DTOs need numbers. */
function consultationNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function consultationErr(code, message, status) {
  return appApiErr(code, message, status || 400);
}

/**
 * True when the consultation is over (audit M4/M5 semantics):
 *  • ACTIVE → ends_at passed (the live conversation window itself).
 *  • PAID but never started → paid_at + platform consultation_window_hours
 *    (the "redeem within N hours" deadline — default 24h if config is broken).
 * Evaluated lazily on every read/write, so no cron is required.
 */
async function consultationIsExpired(env, row, nowMs) {
  const status = String((row && row.status) || "");
  if (status === "ACTIVE") {
    const ends = consultationNum(row.ends_at);
    return ends !== null && ends > 0 && nowMs > ends;
  }
  if (status === "PAID") {
    const paid = consultationNum(row.paid_at);
    if (paid === null) return false;
    let hours = 24;
    try { hours = consultationInt(await marketplaceConfigGet(env, "consultation_window_hours", "24"), 24); } catch (_) {}
    hours = Math.min(720, Math.max(1, hours));
    return nowMs > paid + hours * 3600000;
  }
  return false;
}

// ─────────────────────────── table bootstrap (defensive, additive) ───────────────────────────

/**
 * Ensures the marketplace tables exist. The canonical DDL lives in
 * app_module_schema.js (Agent 3) via marketplaceEnsureTables; the CREATE TABLE
 * IF NOT EXISTS statements here are a no-op safety net so this module still
 * boots against a database where the schema part lagged behind, and never
 * touch any bot-owned table. Runs once per isolate.
 */
async function consultationEnsureTables(env) {
  if (CONSULTATION_TABLES_READY) return;
  let canonicalOk = true;
  try {
    // Canonical DDL is Agent 3's; a missing/late schema module must not make the
    // consultation domain unbootable, so the statements below run either way.
    await marketplaceEnsureTables(env);
  } catch (e) {
    canonicalOk = false;
    console.warn("consultationEnsureTables: marketplace schema gate unavailable:", e && e.message);
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY,
  client_user_id INTEGER NOT NULL,
  lawyer_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED'
      CHECK (status IN ('CREATED','PAYMENT_PENDING','PAID','ACTIVE','COMPLETED','CANCELLED','EXPIRED','REFUNDED','FAILED')),
  created_at INTEGER, updated_at INTEGER, paid_at INTEGER, started_at INTEGER, ends_at INTEGER,
  duration_minutes INTEGER, price_toman INTEGER,
  idempotency_key TEXT,
  UNIQUE (client_user_id, idempotency_key)
)`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cons_client ON consultations(client_user_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cons_lawyer ON consultations(lawyer_user_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cons_status ON consultations(status)").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS consultation_messages (
  id INTEGER PRIMARY KEY, consultation_id INTEGER NOT NULL, sender_user_id INTEGER NOT NULL,
  body TEXT, created_at INTEGER
)`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cm_cons ON consultation_messages(consultation_id, id)").run();
  // Audit (db): latch the full gate ONLY when the canonical bootstrap succeeded,
  // so the remaining 8 marketplace tables get retried on the next request.
  if (canonicalOk) CONSULTATION_TABLES_READY = true;
}

/** Handler-side wrapper: a schema failure must answer 500, never crash the route. */
async function consultationPrepare(env) {
  try {
    await consultationEnsureTables(env);
    return null;
  } catch (e) {
    console.error("consultationPrepare error:", e && e.message);
    return consultationErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }
}

// ─────────────────── lifecycle seam (shared with Agent 8 — §SEAM above) ───────────────────

/**
 * Load one consultation row.
 * @returns {Promise<object|null>} the raw D1 row, or null when absent/lookup failed.
 */
async function consultationLoad(env, consultationId) {
  const id = consultationNum(consultationId);
  if (id === null) return null;
  try {
    return await env.DB.prepare("SELECT * FROM consultations WHERE id = ?").bind(id).first();
  } catch (e) {
    console.error("consultationLoad error:", e && e.message);
    return null;
  }
}

/**
 * Derive the caller's membership from the ROW (server-side truth).
 * @returns {'client'|'lawyer'|null}
 */
function consultationMembership(row, userId) {
  if (!row) return null;
  const uid = consultationNum(userId);
  if (uid === null) return null;
  if (consultationNum(row.client_user_id) === uid) return "client";
  if (consultationNum(row.lawyer_user_id) === uid) return "lawyer";
  return null;
}

/**
 * The ONLY writer of consultation.status in this domain. The FROM guard lives in
 * the UPDATE's WHERE clause, so concurrent callers cannot both flip the state;
 * one wins, the other re-reads and sees the winner's result.
 * @param {string[]|string} fromStatuses allowed current statuses (empty = unconditional).
 * @param {object} [extraCols] server-controlled columns merged into SET (e.g. {paid_at: now}).
 * @returns {Promise<{ok:boolean, row:object|null}>} fresh row either way;
 *          ok=true also when the row ALREADY sits in toStatus (idempotent no-op).
 * Example for Agent 8's success path:
 *   const r = await consultationTransition(env, cid, ["PAYMENT_PENDING", "CREATED"],
 *                                          "PAID", { paid_at: marketplaceNow() });
 */
async function consultationTransition(env, consultationId, fromStatuses, toStatus, extraCols) {
  const id = consultationNum(consultationId);
  const to = String(toStatus || "").trim();
  const from = (Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses])
    .map(s => String(s || "").trim()).filter(Boolean);
  if (id === null || !CONSULTATION_LIFECYCLE.includes(to)) {
    return { ok: false, row: await consultationLoad(env, id) };
  }
  // extraCols keys are server-controlled TODAY; whitelist them so a future
  // caller that forwards request JSON can never rewrite identity columns
  // (audit L6). Anything outside this set is dropped, and only toStatus-legal
  // stamps pass (identity/ownership columns are structurally unreachable).
  const ALLOWED_EXTRA_COLS = ["paid_at", "started_at", "ends_at"];
  const cols = Object.assign({}, extraCols || {});
  delete cols.id; delete cols.status; delete cols.updated_at; // never clobbered by callers
  for (const k of Object.keys(cols)) if (!ALLOWED_EXTRA_COLS.includes(k)) delete cols[k];
  const setParts = ["status = ?"];
  const binds = [to];
  for (const key of Object.keys(cols)) {
    if (!/^[a-z_]+$/.test(key)) continue; // column names are code, not input
    setParts.push(key + " = ?");
    binds.push(cols[key] === undefined ? null : cols[key]);
  }
  setParts.push("updated_at = ?");
  binds.push(marketplaceNow());
  let sql = "UPDATE consultations SET " + setParts.join(", ") + " WHERE id = ?";
  if (from.length) sql += " AND status IN (" + from.map(() => "?").join(", ") + ")";
  binds.push(id);
  if (from.length) binds.push.apply(binds, from);
  let changed = 0;
  try {
    const stmt = env.DB.prepare(sql);
    const res = await stmt.bind.apply(stmt, binds).run();
    changed = consultationInt(res && res.meta && res.meta.changes, 0) || 0;
  } catch (e) {
    console.error("consultationTransition error:", e && e.message);
    return { ok: false, row: await consultationLoad(env, id) };
  }
  const row = await consultationLoad(env, id);
  if (!changed && row && String(row.status) === to) {
    return { ok: true, row }; // already in the target state — same result, no error
  }
  return { ok: Boolean(changed), row };
}

/**
 * Row → camelCase ConsultationDto (names fixed by MarketplaceContracts.cs).
 * clientName/lawyerName come from app_accounts; lastMessageAt + unreadForMe from
 * consultation_messages (unread = messages after the viewer's own last message —
 * a simple COUNT; 0 is a normal answer and any read failure reads as 0).
 */
async function consultationView(env, row, viewerUserId) {
  if (!row) return null;
  const viewer = consultationNum(viewerUserId);
  const cid = consultationNum(row.id);
  const clientId = consultationNum(row.client_user_id);
  const lawyerId = consultationNum(row.lawyer_user_id);

  const names = Object.create(null);
  try {
    const ids = [clientId, lawyerId].filter(v => v !== null);
    if (ids.length) {
      const stmt = env.DB.prepare(
        "SELECT user_id, display_name FROM app_accounts WHERE user_id IN (" +
        ids.map(() => "?").join(", ") + ")");
      const res = await stmt.bind.apply(stmt, ids).all();
      for (const r of (res.results || [])) {
        names[consultationNum(r.user_id)] = String(r.display_name || "");
      }
    }
  } catch (e) { /* display names are cosmetic — never fail the DTO for them */ }

  let lastMessageAt = null;
  let unreadForMe = 0;
  try {
    const last = await env.DB.prepare(
      "SELECT created_at FROM consultation_messages WHERE consultation_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(cid).first();
    if (last) lastMessageAt = consultationNum(last.created_at);
    if (viewer !== null) {
      const myLast = await env.DB.prepare(
        "SELECT id FROM consultation_messages WHERE consultation_id = ? AND sender_user_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(cid, viewer).first();
      const cnt = myLast
        ? await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM consultation_messages WHERE consultation_id = ? AND id > ?"
          ).bind(cid, consultationNum(myLast.id)).first()
        : await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM consultation_messages WHERE consultation_id = ?"
          ).bind(cid).first();
      unreadForMe = Math.max(0, consultationInt(cnt && cnt.n, 0));
    }
  } catch (e) {
    console.error("consultationView chat stats error:", e && e.message);
    unreadForMe = 0;
  }

  return {
    id: cid,
    clientUserId: clientId,
    clientName: names[clientId] || null,
    lawyerUserId: lawyerId,
    lawyerName: names[lawyerId] || null,
    status: String(row.status || "CREATED"),
    priceToman: consultationInt(row.price_toman, 0),
    durationMinutes: consultationClampMinutes(row.duration_minutes, CONSULTATION_DEFAULT_MINUTES),
    createdAt: consultationNum(row.created_at) || 0,
    paidAt: consultationNum(row.paid_at),
    startedAt: consultationNum(row.started_at),
    endsAt: consultationNum(row.ends_at),
    lastMessageAt: lastMessageAt,
    unreadForMe: unreadForMe
  };
}

// ─────────────────────────── shared gate for the chat routes ───────────────────────────

/**
 * Auth + load + membership for one consultation (used by get/messages/send/complete).
 * @returns {Promise<{row, viewer, membership, err}>} `err` is a Response when denied.
 * Codes: UNAUTHORIZED 401, NOT_FOUND 404, FORBIDDEN 403.
 */
async function consultationGuard(env, body) {
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return { err: auth.err };
  const row = await consultationLoad(env, body && body.consultationId);
  if (!row) {
    return { err: consultationErr("NOT_FOUND", "مشاوره‌ای با این شناسه یافت نشد.", 404) };
  }
  const membership = consultationMembership(row, auth.payload.uid);
  if (!membership) {
    // Same answer as "no such consultation" (audit L1): ids are time-ordered,
    // so a distinct 403 would let any token probe which consultations exist.
    return { err: consultationErr("NOT_FOUND", "مشاوره‌ای با این شناسه یافت نشد.", 404) };
  }
  return { row, viewer: consultationNum(auth.payload.uid), membership };
}

/**
 * Read one page of chat messages (membership already checked by the caller).
 * @returns {Promise<{messages: Array}>} id ASC, ≤200 rows after `afterId`.
 */
async function consultationMessagesPage(env, row, viewerId, afterId) {
  const after = consultationInt(afterId, 0) || 0;
  let res = { results: [] };
  try {
    res = await env.DB.prepare(
      "SELECT id, consultation_id, sender_user_id, body, created_at FROM consultation_messages " +
      "WHERE consultation_id = ? AND id > ? ORDER BY id ASC LIMIT " + CONSULTATION_PAGE_LIMIT
    ).bind(consultationNum(row.id), after).all();
  } catch (e) {
    console.error("consultationMessagesPage error:", e && e.message);
  }
  const lawyerId = consultationNum(row.lawyer_user_id);
  const names = Object.create(null);
  try {
    const ids = [consultationNum(row.client_user_id), lawyerId].filter(v => v !== null);
    if (ids.length) {
      const stmt = env.DB.prepare("SELECT user_id, display_name FROM app_accounts WHERE user_id IN (" +
        ids.map(() => "?").join(", ") + ")");
      const acc = await stmt.bind.apply(stmt, ids).all();
      for (const a of (acc.results || [])) names[consultationNum(a.user_id)] = String(a.display_name || "");
    }
  } catch (e) { /* cosmetic */ }
  const messages = (res.results || []).map(m => {
    const sender = consultationNum(m.sender_user_id);
    return {
      id: consultationNum(m.id),
      consultationId: consultationNum(m.consultation_id),
      senderUserId: sender,
      senderRole: sender === lawyerId ? "lawyer" : "client",
      senderName: names[sender] || null,
      body: String(m.body == null ? "" : m.body),
      createdAt: consultationNum(m.created_at) || 0,
      mine: sender === consultationNum(viewerId) // additive; the .NET record ignores it
    };
  });
  return { messages };
}

// ─────────────────────────── POST /api/v1/consultations/create ───────────────────────────

/**
 * Create a consultation (PAYMENT_PENDING) against a verified, available, priced
 * lawyer, then ask the payment module for a pending payment + quote.
 * Body: {token, lawyerUserId, durationMinutes?, idempotencyKey}
 * Roles: client; lawyer/admin may also book as the client against a DIFFERENT
 * lawyer (never themselves). durationMinutes clamps to the lawyer default and
 * the 15..180 band; price is a snapshot.
 * Codes: UNAUTHORIZED 401, FORBIDDEN 403, VALIDATION 400, LAWYER_NOT_FOUND 404,
 *        LAWYER_NOT_VERIFIED 403, LAWYER_UNAVAILABLE 403, PRICE_NOT_SET 400,
 *        RATE_LIMITED 429, INTERNAL 500.
 */
async function consultationHandleCreate(env, ctx, body) {
  const auth = await marketplaceRequireRole(env, body, "client", "lawyer", "admin");
  if (auth.err) return auth.err;
  const clientUserId = consultationNum(auth.payload.uid);
  const prep = await consultationPrepare(env);
  if (prep) return prep;

  const lawyerUserId = consultationNum(body && body.lawyerUserId);
  if (lawyerUserId === null) {
    return consultationErr("VALIDATION", "شناسه وکیل نامعتبر است.", 400);
  }
  if (lawyerUserId === clientUserId) {
    return consultationErr("VALIDATION", "نمی‌توانید برای خودتان مشاوره رزرو کنید.", 400);
  }
  if (!await marketplaceRateLimit(env, "cons-create:" + clientUserId, 20, 60000)) {
    return consultationErr("RATE_LIMITED", "تعداد درخواست‌های شما زیاد است؛ چند لحظه دیگر تلاش کنید.", 429);
  }

  const rawKey = body && body.idempotencyKey;
  const idempotencyKey = rawKey === null || rawKey === undefined || rawKey === ""
    ? null : String(rawKey).trim().slice(0, 120) || null;

  // ---- lawyer eligibility: honest, separate codes ----
  let lawyer = null;
  try {
    lawyer = await env.DB.prepare(
      "SELECT a.user_id, a.role, a.status AS account_status, " +
      "p.user_id AS profile_user_id, p.verification_status, p.is_available, " +
      "p.price_toman, p.duration_minutes " +
      "FROM app_accounts a LEFT JOIN lawyer_profiles p ON p.user_id = a.user_id " +
      "WHERE a.user_id = ?"
    ).bind(lawyerUserId).first();
  } catch (e) {
    console.error("consultationHandleCreate lawyer lookup error:", e && e.message);
    return consultationErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }
  if (!lawyer || String(lawyer.role || "") !== "lawyer" || consultationNum(lawyer.profile_user_id) === null) {
    return consultationErr("LAWYER_NOT_FOUND", "این وکیل در سامانه ثبت نشده است.", 404);
  }
  if (String(lawyer.account_status || "") !== "active") {
    return consultationErr("LAWYER_NOT_FOUND", "حساب این وکیل در سامانه فعال نیست.", 404);
  }
  if (String(lawyer.verification_status || "") !== "verified") {
    return consultationErr("LAWYER_NOT_VERIFIED", "این وکیل هنوز توسط سامانه تأیید نشده است.", 403);
  }
  if (consultationInt(lawyer.is_available, 1) !== 1) {
    return consultationErr("LAWYER_UNAVAILABLE", "این وکیل در حال حاضر پذیرای مشاوره نیست.", 403);
  }
  const priceToman = consultationInt(lawyer.price_toman, 0);
  if (priceToman <= 0) {
    return consultationErr("PRICE_NOT_SET", "این وکیل هنوز نرخ مشاوره تعیین نکرده است.", 400);
  }
  const durationMinutes = consultationClampMinutes(body && body.durationMinutes,
    consultationClampMinutes(lawyer.duration_minutes, CONSULTATION_DEFAULT_MINUTES));

  // ---- insert; the UNIQUE index is the source of truth for duplicate retries ----
  if (idempotencyKey) {
    const prior = await env.DB.prepare(
      "SELECT * FROM consultations WHERE client_user_id = ? AND idempotency_key = ?"
    ).bind(clientUserId, idempotencyKey).first();
    if (prior) return consultationCreateResponse(env, prior, clientUserId, true);
  }
  const now = marketplaceNow();
  const id = marketplaceNewId();
  try {
    await env.DB.prepare(
      "INSERT INTO consultations (id, client_user_id, lawyer_user_id, status, created_at, updated_at, " +
      "duration_minutes, price_toman, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, clientUserId, lawyerUserId, "PAYMENT_PENDING", now, now,
      durationMinutes, priceToman, idempotencyKey).run();
  } catch (e) {
    if (idempotencyKey && consultationIsUniqueViolation(e)) {
      const existing = await env.DB.prepare(
        "SELECT * FROM consultations WHERE client_user_id = ? AND idempotency_key = ?"
      ).bind(clientUserId, idempotencyKey).first();
      if (existing) return consultationCreateResponse(env, existing, clientUserId, true);
    }
    console.error("consultationHandleCreate insert error:", e && e.message);
    return consultationErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }

  return consultationCreateResponse(env, {
    id, client_user_id: clientUserId, lawyer_user_id: lawyerUserId,
    status: "PAYMENT_PENDING", created_at: now, updated_at: now,
    paid_at: null, started_at: null, ends_at: null,
    duration_minutes: durationMinutes, price_toman: priceToman,
    idempotency_key: idempotencyKey
  }, clientUserId, false);
}

/**
 * ConsultationCreateResponse envelope: {ok, consultation, paymentId, amountToman,
 * provider, devModeNotice, duplicated, message}. paymentId/provider come from
 * Agent 8's paymentCreatePending — resolved lazily (INVARIANT 4). The raw D1 row
 * is handed to them (they own the payments row; consultationView is available).
 */
async function consultationCreateResponse(env, row, viewerId, duplicated) {
  const dto = await consultationView(env, row, viewerId);
  const amountToman = consultationInt(row.price_toman, 0);
  const payload = {
    ok: true,
    consultation: dto,
    paymentId: null,
    amountToman: amountToman,
    provider: null,
    devModeNotice: null,
    duplicated: Boolean(duplicated),
    message: duplicated
      ? "این درخواست قبلاً ثبت شده بود؛ همان مشاورهٔ پیشین به شما نمایش داده می‌شود."
      : "درخواست مشاوره ثبت شد. برای آغاز گفتگو، هزینه مشاوره را پرداخت کنید."
  };
  try {
    if (typeof paymentProviderName === "function") {
      // Agent 8 implements this as async (it reads platform_config) — await the
      // promise whether the module returns a string or a Promise<string>.
      payload.provider = String(await paymentProviderName(env) || "devtest");
      // An unregistered configured id must not leak the internal sentinel, and
      // the quote must say honestly that payments cannot settle (audit M3/L3).
      if (payload.provider.indexOf("UNREGISTERED:") === 0) {
        payload.provider = payload.provider.slice(13);
        payload.code = "PAYMENT_PROVIDER_UNCONFIGURED";
      }
    }
    if (typeof paymentCreatePending !== "function") {
      payload.code = "PAYMENT_UNAVAILABLE";
      payload.devModeNotice = "سرویس پرداخت در این نسخه مستقر نشده است؛ هنوز امکان پرداخت وجود ندارد.";
      return appApiJson(payload);
    }
    const paymentId = await paymentCreatePending(env, {
      consultation: row,
      amountToman: amountToman,
      // payments.idempotency_key is GLOBALLY unique, while a consultation create
      // key is only unique per client — two different clients can coincidentally
      // pick the same string. Namespace it by consultation id so a collision can
      // never make the payment module adopt another consultation's row.
      idempotencyKey: "cons:" + consultationNum(row.id) + ":" + (row.idempotency_key || "no-key")
    });
    payload.paymentId = consultationNum(paymentId);
    payload.provider = payload.provider || "devtest";
    payload.devModeNotice = payload.provider === "devtest"
      ? "توجه: این پرداخت حالت توسعه/آزمون است و هیچ مبلغ واقعی از حساب شما کسر نمی‌شود."
      : (payload.code === "PAYMENT_PROVIDER_UNCONFIGURED"
        ? "هشدار: پرداخت‌کننده تنظیم‌شده در سامانه ثبت نشده است؛ تا اصلاح پیکربندی، پرداختی انجام نمی‌شود."
        : null);
    if (payload.paymentId === null) {
      payload.code = "PAYMENT_UNAVAILABLE";
      payload.devModeNotice = "سرویس پرداخت در حال حاضر فاکتوری صادر نکرد. لطفاً دوباره تلاش کنید.";
    }
  } catch (e) {
    console.error("consultationCreateResponse quote error:", e && e.message);
    payload.code = "PAYMENT_UNAVAILABLE";
    payload.devModeNotice = "اتصال به سرویس پرداخت ممکن نشد؛ مشاوره ثبت مانده و می‌توانید دوباره تلاش کنید.";
  }
  return appApiJson(payload);
}

// ─────────────────────────── POST /api/v1/consultations/list ───────────────────────────

/**
 * The caller's consultations in BOTH directions (client_user_id = me OR
 * lawyer_user_id = me), newest first, capped at 50, mapped through
 * consultationView (so unreadForMe/lastMessageAt ride along).
 * Body: {token, status?}   (an optional `scope:"mine"` from the spec route note is
 * accepted and ignored — mine is the only mode this route has.)
 * Codes: UNAUTHORIZED 401, VALIDATION 400 (bad status), INTERNAL 500.
 */
async function consultationHandleList(env, ctx, body) {
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const prep = await consultationPrepare(env);
  if (prep) return prep;
  const viewer = consultationNum(auth.payload.uid);
  // Audit M6: /list fans out up to 50 rows × ~4 reads each — cap the churn.
  if (!await marketplaceRateLimit(env, "cons-list:" + viewer, 30, 60000)) {
    return consultationErr("RATE_LIMITED", "دریافت فهرست بسیار سریع است؛ لحظی صبر کنید.", 429);
  }

  const status = String((body && body.status) || "").trim().toUpperCase();
  if (status && !CONSULTATION_LIFECYCLE.includes(status)) {
    return consultationErr("VALIDATION", "وضعیت درخواست‌شده معتبر نیست.", 400);
  }

  let rows = [];
  try {
    // NOTE the parentheses: without them `AND status = ?` would bind only to the
    // lawyer arm of the OR and silently leak unparded rows to the client arm.
    const sql = "SELECT * FROM consultations WHERE (client_user_id = ? OR lawyer_user_id = ?)" +
      (status ? " AND status = ?" : "") +
      " ORDER BY id DESC LIMIT " + CONSULTATION_LIST_LIMIT;
    const stmt = env.DB.prepare(sql);
    const binds = status ? [viewer, viewer, status] : [viewer, viewer];
    const res = await stmt.bind.apply(stmt, binds).all();
    rows = res.results || [];
  } catch (e) {
    console.error("consultationHandleList error:", e && e.message);
    return consultationErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }
  const consultations = [];
  for (const r of rows) consultations.push(await consultationView(env, r, viewer));
  return appApiJson({ ok: true, consultations });
}

// ─────────────────────────── POST /api/v1/consultations/get ───────────────────────────

/**
 * One consultation + membership. Non-participants cannot tell it exists.
 * Body: {token, consultationId}
 * Codes: UNAUTHORIZED 401, NOT_FOUND 404, FORBIDDEN 403.
 */
async function consultationHandleGet(env, ctx, body) {
  const prep = await consultationPrepare(env);
  if (prep) return prep;
  const gate = await consultationGuard(env, body);
  if (gate.err) return gate.err;
  const dto = await consultationView(env, gate.row, gate.viewer);
  return appApiJson({ ok: true, consultation: dto, membership: gate.membership });
}

// ─────────────────────────── POST /api/v1/consultations/messages ───────────────────────────

/**
 * Poll chat history: ≤200 messages after `afterId`, id ASC, plus the
 * consultation DTO the client uses to track lifecycle. Entitlement-gated:
 * readable in PAID/ACTIVE/COMPLETED; a not-yet-paid consultation answers
 * NOT_ACTIVE ("payment required") to its own client — history is never a
 * free preview of the lawyer.
 * Body: {token, consultationId, afterId?}
 * Codes: FORBIDDEN 403, NOT_FOUND 404, NOT_ACTIVE 409.
 */
async function consultationHandleMessages(env, ctx, body) {
  const prep = await consultationPrepare(env);
  if (prep) return prep;
  const gate = await consultationGuard(env, body);
  if (gate.err) return gate.err;
  // Audit M6: the V1 client polls this every few seconds — 120/min per viewer.
  if (!await marketplaceRateLimit(env, "cons-msg:" + gate.viewer, 120, 60000)) {
    return consultationErr("RATE_LIMITED", "دریافت پیام‌ها بسیار سریع است؛ لحظی صبر کنید.", 429);
  }

  let status = String(gate.row.status || "");
  // Lazy-close on READ too (audit M5b): an expired room must not stay "ACTIVE"
  // forever just because nobody tried to send in it.
  if (await consultationIsExpired(env, gate.row, marketplaceNow())) {
    await consultationTransition(env, gate.row.id, ["ACTIVE", "PAID"], "COMPLETED");
    const refreshed = await consultationLoad(env, gate.row.id) || gate.row;
    gate.row = refreshed;
    status = String(refreshed.status || status);
  }
  if (!CONSULTATION_HISTORY_STATUSES.includes(status)) {
    const waiting = status === "PAYMENT_PENDING" || status === "CREATED";
    return consultationErr("NOT_ACTIVE", waiting
      ? "برای گفتگو با وکیل، ابتدا هزینه مشاوره را پرداخت کنید."
      : "این مشاوره بسته شده و گفتگوی تازه‌ای در دسترس نیست.", 409);
  }
  const page = await consultationMessagesPage(env, gate.row, gate.viewer, body && body.afterId);
  const dto = await consultationView(env, gate.row, gate.viewer);
  return appApiJson({ ok: true, consultation: dto, messages: page.messages });
}

// ─────────────────────────── POST /api/v1/consultations/send ───────────────────────────

/**
 * Append a chat message. Participants only; writing allowed only while PAID or
 * ACTIVE. The first send after PAID starts the session (PAID→ACTIVE,
 * started_at=now, ends_at=now+duration). A session whose ends_at has passed is
 * lazily closed (COMPLETED) and the send is refused with CONSULTATION_EXPIRED.
 * Body: {token, consultationId, body}
 * Codes: VALIDATION 400, FORBIDDEN 403, NOT_FOUND 404, NOT_ACTIVE 409,
 *        CONSULTATION_EXPIRED/CLOSED 409, RATE_LIMITED 429, INTERNAL 500.
 */
async function consultationHandleSend(env, ctx, body) {
  const prep = await consultationPrepare(env);
  if (prep) return prep;
  const gate = await consultationGuard(env, body);
  if (gate.err) return gate.err;

  const text = String((body && body.body) == null ? "" : body.body).replace(/\r\n/g, "\n").trim();
  if (!text) return consultationErr("VALIDATION", "متن پیام نمی‌تواند خالی باشد.", 400);
  if (text.length > CONSULTATION_BODY_MAX) {
    return consultationErr("VALIDATION", "متن پیام بیش از حد بلند است (حداکثر " + CONSULTATION_BODY_MAX + " نویسه).", 400);
  }
  if (!await marketplaceRateLimit(env, "cons-send:" + gate.viewer, 60, 60000)) {
    return consultationErr("RATE_LIMITED", "پیام‌رسانی بسیار سریع است؛ لحظی صبر کنید.", 429);
  }

  let row = gate.row;
  let status = String(row.status || "");
  const now = marketplaceNow();

  // Expiry first: a stale ACTIVE session closes itself, then refuses the write.
  if (status === "ACTIVE" && await consultationIsExpired(env, row, now)) {
    await consultationTransition(env, row.id, ["ACTIVE"], "COMPLETED", {});
    return consultationErr("CONSULTATION_EXPIRED",
      "زمان این مشاوره به پایان رسیده است. برای ادامه، مشاورهٔ تازه‌ای رزرو کنید.", 409);
  }

  if (status === "PAYMENT_PENDING" || status === "CREATED") {
    return consultationErr("NOT_ACTIVE",
      "برای گفتگو با وکیل، ابتدا هزینه مشاوره را پرداخت کنید.", 409);
  }
  if (CONSULTATION_CLOSED_STATUSES.includes(status)) {
    return consultationErr("CONSULTATION_CLOSED",
      "این مشاوره بسته شده است و امکان ارسال پیام وجود ندارد.", 409);
  }

  // First write on a paid session starts it (guarded transition; races converge).
  if (status === "PAID") {
    // The payment module may already have fixed a paid window (ends_at at pay
    // time). If that window elapsed before anyone spoke, the session expired
    // unpaid-for — close it honestly instead of granting a fresh full duration.
    if (await consultationIsExpired(env, row, now)) {
      await consultationTransition(env, row.id, ["PAID"], "COMPLETED", {});
      return consultationErr("CONSULTATION_EXPIRED",
        "مهلت این مشاوره پیش از آغاز گفتگو به پایان رسید. لطفاً مشاورهٔ تازه‌ای رزرو کنید.", 409);
    }
    const duration = consultationClampMinutes(row.duration_minutes, CONSULTATION_DEFAULT_MINUTES);
    const started = await consultationTransition(env, row.id, ["PAID"], "ACTIVE",
      { started_at: now, ends_at: now + duration * 60000 });
    row = started.row || row;
    status = String(row.status || "");
    if (status !== "ACTIVE") {
      return consultationErr("NOT_ACTIVE",
        "این مشاوره آمادهٔ آغاز نیست. لطفاً صفحه را تازه‌سازی کنید.", 409);
    }
  }

  const msgId = marketplaceNewId();
  try {
    await env.DB.prepare(
      "INSERT INTO consultation_messages (id, consultation_id, sender_user_id, body, created_at) " +
      "VALUES (?, ?, ?, ?, ?)"
    ).bind(msgId, consultationNum(row.id), gate.viewer, text, marketplaceNow()).run();
  } catch (e) {
    console.error("consultationHandleSend insert error:", e && e.message);
    return consultationErr("INTERNAL", "پیام شما ثبت نشد. لطفاً مجدداً تلاش کنید.", 500);
  }

  // Refreshed page (the message just sent is the last row of it).
  const page = await consultationMessagesPage(env, row, gate.viewer, 0);
  const dto = await consultationView(env, row, gate.viewer);
  return appApiJson({ ok: true, consultation: dto, messages: page.messages });
}

// ─────────────────────────── POST /api/v1/consultations/complete ───────────────────────────

/**
 * Either participant ends the consultation → COMPLETED with ends_at=now (the
 * unused window is forfeited by choice). Non-participant = 403. Already
 * COMPLETED = idempotent success with the final state (ConsultationListResponse
 * shape, since that is what the .NET port returns here); a CANCELLED/EXPIRED/
 * REFUNDED/FAILED session answers CONSULTATION_CLOSED.
 * Body: {token, consultationId}
 * Codes: FORBIDDEN 403, NOT_FOUND 404, CONSULTATION_CLOSED 409, INTERNAL 500.
 */
async function consultationHandleComplete(env, ctx, body) {
  const prep = await consultationPrepare(env);
  if (prep) return prep;
  const gate = await consultationGuard(env, body);
  if (gate.err) return gate.err;

  let row = gate.row;
  const status = String(row.status || "");

  if (status === "COMPLETED") {
    const dto = await consultationView(env, row, gate.viewer);
    return appApiJson({
      ok: true, consultations: [dto], consultation: dto,
      alreadyClosed: true,
      message: "این مشاوره پیش‌تر به پایان رسیده بود؛ وضعیت نهایی نمایش داده می‌شود."
    });
  }
  if (CONSULTATION_CLOSED_STATUSES.includes(status)) {
    return consultationErr("CONSULTATION_CLOSED", "این مشاوره بسته شده است.", 409);
  }
  if (status === "PAYMENT_PENDING" || status === "CREATED") {
    // Nothing was paid and nothing ran — closing is not this route's job
    // (cancellation of an unpaid draft belongs to the payments/cancel flow).
    return consultationErr("NOT_ACTIVE",
      "این مشاوره هنوز پرداخت نشده و فعال نیست؛ نیازی به بستن آن نیست.", 409);
  }

  const res = await consultationTransition(env, row.id, CONSULTATION_CLOSE_FROM,
    "COMPLETED", { ends_at: marketplaceNow() });
  if (res.row) row = res.row;
  if (!res.ok && String(row.status || "") !== "COMPLETED") {
    return consultationErr("CONSULTATION_CLOSED",
      "این مشاوره در وضعیت جاری قابل بستن نیست. لطفاً صفحه را تازه‌سازی کنید.", 409);
  }
  const dto = await consultationView(env, row, gate.viewer);
  return appApiJson({
    ok: true, consultations: [dto], consultation: dto,
    message: "مشاوره با موفقیت به پایان رسید. متن گفتگو برای شما نگهداری می‌شود."
  });
}

// ─────────────────────────── route registration ───────────────────────────
// /consultations/pay is intentionally NOT registered here — Agent 8 owns it and
// drives the PAID transition through consultationTransition().
marketplaceRegister("POST /api/v1/consultations/create", consultationHandleCreate);
marketplaceRegister("POST /api/v1/consultations/list", consultationHandleList);
marketplaceRegister("POST /api/v1/consultations/get", consultationHandleGet);
marketplaceRegister("POST /api/v1/consultations/messages", consultationHandleMessages);
marketplaceRegister("POST /api/v1/consultations/send", consultationHandleSend);
marketplaceRegister("POST /api/v1/consultations/complete", consultationHandleComplete);
