// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Admin payout ledger for the Vakil AI marketplace (wave-2):
//             lawyer earnings ACCRUE from payment_splits (succeeded payments
//             only); MOVING money is an operator action (manual card/SHABA
//             transfer, outside this system) that this module RECORDS. The
//             over-accrual guard makes it impossible to book a payout larger
//             than a lawyer's current unpaid balance, and the pending→final
//             transition is a compare-and-set so two admins can never settle
//             the same row twice.
//             HONEST MONEY MODEL (defines every figure in the responses):
//               per-lawyer accrued     = SUM(payment_splits.lawyer_earnings_toman
//                                        over payments.status='succeeded')
//               per-lawyer paidOut     = SUM(payout_ledger.amount_toman WHERE
//                                        status='paid')
//               per-lawyer outstanding = max(0, accrued − paidOut)
//               response accruedToman  = SUM over ALL lawyers of
//                                        max(0, accrued − paidOut)  (i.e. the
//                                        platform-wide UNPAID accrual)
//               response paidOutToman  = SUM(payout_ledger.amount_toman WHERE
//                                        status='paid') platform-wide
//             Payouts are per-lawyer aggregates: a payout row can NOT be
//             attributed to specific payments, so per-payment attribution is
//             deliberately NOT modelled (payments stay immutable evidence).
//             KNOWN V1 LIMITATION, stated plainly: outstanding deducts PAID
//             payouts only, so several PENDING rows for one lawyer may
//             individually pass the guard yet sum above the accrual — the
//             ledger lists every pending row newest-first so the admin sees
//             the open commitments before booking the next one.
// OWNER     — Wave-2 lane C — payouts.
// CONSUMES  — appApiJson/appApiErr (app_module_head.js); marketplaceRegister +
//             dispatcher, marketplaceRequireAdmin (SERVER-SIDE role==='admin'
//             on every call — the frontend is never trusted),
//             marketplaceEnsureTables (DDL lives in app_module_schema.js:
//             payout_ledger / payment_splits / payments / app_accounts /
//             lawyer_profiles / admin_audit_log — this file creates nothing),
//             marketplaceNewId/marketplaceNow/marketplaceRateLimit
//             (app_module_common.js). The admin.js helpers (adminGuarded,
//             adminWriteAudit, adminQueryAll/Run) are PRIVATE to that file —
//             this module owns adminPayout*-prefixed equivalents and does NOT
//             edit app_module_admin.js.
// PROVIDES  — POST /api/v1/admin/payouts/list  {} → PayoutsResponse
//             POST /api/v1/admin/payouts/create {lawyerUserId, amountToman,
//                     method?} → PayoutsResponse (fresh payload after the
//                     INSERT) — OVER_ACCRUAL refuses amount > outstanding.
//             POST /api/v1/admin/payouts/mark   {payoutId,
//                     status:'paid'|'cancelled', reference?} → PayoutsResponse
//                     (fresh, recomputed totals) — CAS on status='pending',
//                     lost race → PAYOUT_STATE_CONFLICT.
//             + functions adminPayoutHandleList, adminPayoutHandleCreate,
//               adminPayoutHandleMark (names pinned in the integrity check).
//             Response shape mirrors PayoutsResponse / PayoutDto in
//             src/VakilAI.Application/Contracts/MarketplaceContracts.cs.
// INVARIANTS— payouts RECORD manual transfers, nothing ever moves money
//             automatically (no PSP call exists anywhere in this file); a
//             payout can never exceed current accrued (OVER_ACCRUAL guard);
//             only admin; pending→paid|cancelled is a one-way CAS (a row that
//             is no longer 'pending' can never be re-marked —
//             PAYOUT_STATE_CONFLICT); every payout_create/payout_paid/
//             payout_cancelled appends admin_audit_log (append-only; an audit
//             write failure is console.error'd loudly but never reverts the
//             ledger row — admin.js precedent); ALL MONEY IS INTEGER TOMAN
//             (strict integer parse in, SQL SUM out, Math.trunc on read —
//             never float accumulation); create/mark are rate-limited to
//             20/min per admin; no import/export/top-level await — the only
//             top-level side effects are the three marketplaceRegister calls.
// EXTEND    — refund-aware accrual: subtract splits of refunded payments from
//             the accrued CTE (payments.refunded_at exists in schema v2).
//             Per-lawyer payout detail endpoint: reuse adminPayoutLawyerBalance.
//             NEVER auto-execute a transfer from this ledger; new money rails
//             arrive as a payment provider (payments.js registry), and only
//             THEN may a payout row gain an outbound provider_ref.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── constants ───────────────────────────
const ADMIN_PAYOUT_LIST_CAP = 60;           // newest-first page cap
const ADMIN_PAYOUT_METHOD_MAX = 40;         // payout_ledger.method free text
const ADMIN_PAYOUT_REFERENCE_MAX = 120;     // payout_ledger.reference (receipt id)
const ADMIN_PAYOUT_NOTE_MAX = 500;          // admin_audit_log.note
// The only final states a pending payout row may take (mirrors the CHECK
// constraint on payout_ledger.status in app_module_schema.js).
const ADMIN_PAYOUT_MARK_STATUSES = ["paid", "cancelled"];
// The only audit actions this module may write — a typo'd action is refused
// locally instead of polluting the append-only trail.
const ADMIN_PAYOUT_AUDIT_ACTIONS = ["payout_create", "payout_paid", "payout_cancelled"];
// create/mark are capped per admin per minute (list is a cheap read).
const ADMIN_PAYOUT_RATE_LIMIT = 20;

// ─────────────────────────── small helpers ───────────────────────────
/** Integer read of a numeric column (D1 may hand back strings); never NaN. */
function adminPayoutInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * STRICT integer parse: a JS integer, or an exact integer-formatted string.
 * Anything fractional or garbage → null, so a payout amount is NEVER silently
 * rounded into a different amount of money (payments.paymentExactInt precedent).
 */
function adminPayoutExactInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Shared entry guard (admin.js adminGuarded equivalent): ensure the
 * marketplace tables exist, THEN require role==='admin' server-side.
 * @returns {Promise<{err?: Response, auth?: {payload: object, account: object}}>}
 */
async function adminPayoutGuarded(env, body) {
  try {
    await marketplaceEnsureTables(env);
  } catch (e) {
    console.error("payouts ensure tables failed:", e && e.message);
    return { err: appApiErr("SCHEMA_PENDING", "زیرساخت دیتابیس بازار هنوز آماده نشده است. لطفاً بعداً تلاش کنید.", 503) };
  }
  const auth = await marketplaceRequireAdmin(env, body);
  if (auth.err) return { err: auth.err };
  return { auth };
}

/** Run a SELECT and return its rows, or {err: message} — never throws. */
async function adminPayoutQueryAll(env, sql, binds) {
  try {
    let stmt = env.DB.prepare(sql);
    if (binds && binds.length) stmt = stmt.bind.apply(stmt, binds);
    const res = await stmt.all();
    return { rows: (res && res.results) || [] };
  } catch (e) {
    console.error("payouts query failed:", String(sql).slice(0, 80), e && e.message);
    return { err: (e && e.message) || "query failed" };
  }
}

/** Run an INSERT/UPDATE; reports rows actually changed — never throws. */
async function adminPayoutQueryRun(env, sql, binds) {
  try {
    let stmt = env.DB.prepare(sql);
    if (binds && binds.length) stmt = stmt.bind.apply(stmt, binds);
    const res = await stmt.run();
    const changes = res && res.meta ? Number(res.meta.changes) : 0;
    return { ok: true, changes: Number.isFinite(changes) ? changes : 0 };
  } catch (e) {
    console.error("payouts write failed:", String(sql).slice(0, 80), e && e.message);
    return { err: (e && e.message) || "write failed" };
  }
}

/**
 * Append one payout action to admin_audit_log (target renders as
 * 'payout:<id>' in /admin/audit/list, same target_type/target_id shape
 * admin.js uses). Append-only: there is no update/delete helper here.
 * Errors are returned to the caller, which logs them loudly — a mutation
 * must never look successful while silently losing its audit row.
 */
async function adminPayoutAudit(env, actorUserId, action, payoutId, note) {
  if (!ADMIN_PAYOUT_AUDIT_ACTIONS.includes(action)) {
    console.error("adminPayoutAudit: refusing unknown action", action);
    return { err: "BAD_AUDIT_ACTION" };
  }
  return await adminPayoutQueryRun(env,
    "INSERT INTO admin_audit_log (id, actor_user_id, action, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [marketplaceNewId(), actorUserId == null ? null : actorUserId, action,
      "payout",
      payoutId == null ? null : String(payoutId).slice(0, 64),
      note == null ? null : String(note).slice(0, ADMIN_PAYOUT_NOTE_MAX), marketplaceNow()]);
}

/** The honest manual-payout disclaimer every response carries. */
function adminPayoutNotice() {
  return "درآمد وکلا از پرداخت‌های موفق (پس از کسر کمیسیون) انباشته می‌شود؛ واریز به حساب وکیل دستی است و هیچ انتقال خودکاری انجام نمی‌شود. هر واریز یا انصراف باید در همین دفتر ثبت شود.";
}

// ─────────────────────────── money queries ───────────────────────────
/**
 * Platform-wide (accruedToman, paidOutToman) in ONE SQL pass. accruedToman is
 * the SUM over all lawyers of max(0, accrued − paidOut) — clamped PER LAWYER,
 * so one over-paid lawyer can never mask another one's unpaid balance (the
 * definition is part of the money model; do not "simplify" it to a global
 * SUM(accrued) − SUM(paid)). Sums happen in SQL, never in JS.
 */
async function adminPayoutTotals(env) {
  const res = await adminPayoutQueryAll(env, `
    WITH accrued AS (
      SELECT ps.lawyer_user_id AS uid,
             COALESCE(SUM(ps.lawyer_earnings_toman), 0) AS earned
      FROM payment_splits ps
      JOIN payments p ON p.id = ps.payment_id
      WHERE p.status = 'succeeded' AND ps.lawyer_user_id IS NOT NULL
      GROUP BY ps.lawyer_user_id
    ),
    paid AS (
      SELECT pl.lawyer_user_id AS uid,
             COALESCE(SUM(pl.amount_toman), 0) AS sent
      FROM payout_ledger pl
      WHERE pl.status = 'paid'
      GROUP BY pl.lawyer_user_id
    ),
    per_lawyer AS (
      SELECT uid FROM accrued UNION SELECT uid FROM paid
    )
    SELECT COALESCE(SUM(CASE WHEN COALESCE(a.earned, 0) - COALESCE(pd.sent, 0) > 0
                             THEN COALESCE(a.earned, 0) - COALESCE(pd.sent, 0)
                             ELSE 0 END), 0) AS accrued_toman,
           COALESCE(SUM(COALESCE(pd.sent, 0)), 0) AS paid_out_toman
    FROM per_lawyer l
    LEFT JOIN accrued a ON a.uid = l.uid
    LEFT JOIN paid pd ON pd.uid = l.uid`);
  if (res.err) return { err: res.err };
  const row = res.rows[0] || {};
  return {
    accruedToman: adminPayoutInt(row.accrued_toman, 0),
    paidOutToman: adminPayoutInt(row.paid_out_toman, 0)
  };
}

/**
 * One lawyer's money state: {accrued, paidOut, outstanding} in integer toman.
 * outstanding is clamped at 0 (see the per-lawyer note in adminPayoutTotals).
 * @returns {Promise<{accrued:number,paidOut:number,outstanding:number}|null>}
 *          null on a query failure — callers must fail closed.
 */
async function adminPayoutLawyerBalance(env, lawyerUserId) {
  const acc = await adminPayoutQueryAll(env,
    "SELECT COALESCE(SUM(ps.lawyer_earnings_toman), 0) AS earned " +
    "FROM payment_splits ps JOIN payments p ON p.id = ps.payment_id " +
    "WHERE p.status = 'succeeded' AND ps.lawyer_user_id = ?", [lawyerUserId]);
  if (acc.err) return null;
  const paid = await adminPayoutQueryAll(env,
    "SELECT COALESCE(SUM(amount_toman), 0) AS sent FROM payout_ledger " +
    "WHERE status = 'paid' AND lawyer_user_id = ?", [lawyerUserId]);
  if (paid.err) return null;
  const accrued = adminPayoutInt(acc.rows[0] && acc.rows[0].earned, 0);
  const paidOut = adminPayoutInt(paid.rows[0] && paid.rows[0].sent, 0);
  return { accrued, paidOut, outstanding: Math.max(0, accrued - paidOut) };
}

// ─────────────────────────── DTO + payload ───────────────────────────
/** payout_ledger (+ lawyer name) row → PayoutDto (camelCase, contract-named). */
function adminPayoutRowView(row) {
  return {
    id: adminPayoutInt(row.id, 0),
    lawyerUserId: adminPayoutInt(row.lawyer_user_id, 0),
    lawyerName: row.lawyer_name || null,
    amountToman: adminPayoutInt(row.amount_toman, 0),
    status: String(row.status || "pending"),
    method: row.method || null,
    reference: row.reference || null,
    createdAt: adminPayoutInt(row.created_at, 0),
    paidAt: row.paid_at == null ? null : adminPayoutInt(row.paid_at, 0)
  };
}

/**
 * The FULL PayoutsResponse: newest-first ledger page (cap 60, ids are
 * time-derived so id DESC == created DESC) + freshly recomputed totals.
 * Every successful mutation answers with this, so the admin UI can update
 * ledger AND balances from one response without a second round-trip.
 */
async function adminPayoutPayload(env, message) {
  const rows = await adminPayoutQueryAll(env, `
    SELECT pl.id, pl.lawyer_user_id, pl.amount_toman, pl.status, pl.method,
           pl.reference, pl.created_at, pl.paid_at,
           COALESCE(a.display_name, u.first_name, '') AS lawyer_name
    FROM payout_ledger pl
    LEFT JOIN app_accounts a ON a.user_id = pl.lawyer_user_id
    LEFT JOIN users u ON u.user_id = pl.lawyer_user_id
    ORDER BY pl.id DESC
    LIMIT ?`, [ADMIN_PAYOUT_LIST_CAP]);
  if (rows.err) return appApiErr("INTERNAL", "خطا در خواندن دفتر پرداخت‌ها.", 500);

  const totals = await adminPayoutTotals(env);
  if (totals.err) return appApiErr("INTERNAL", "خطا در محاسبه مانده حساب وکلا.", 500);

  const payouts = rows.rows.map(adminPayoutRowView);
  return appApiJson({
    ok: true,
    payouts,
    accruedToman: totals.accruedToman,
    paidOutToman: totals.paidOutToman,
    payoutNotice: adminPayoutNotice(),
    message
  });
}

// ─────────────────────────── POST /api/v1/admin/payouts/list ───────────────────────────
/**
 * The payout ledger page + platform balances. Body {token} (admin).
 * Codes: FORBIDDEN(403), UNAUTHORIZED(401), SCHEMA_PENDING(503), INTERNAL(500).
 */
async function adminPayoutHandleList(env, ctx, body) {
  const g = await adminPayoutGuarded(env, body);
  if (g.err) return g.err;
  return await adminPayoutPayload(env, "دفتر پرداخت‌ها آماده است.");
}

// ─────────────────────────── POST /api/v1/admin/payouts/create ───────────────────────────
/**
 * Book a PENDING payout for one lawyer. The over-accrual guard compares the
 * requested amount against the lawyer's CURRENT outstanding and refuses with
 * OVER_ACCRUAL naming both figures — that is the fraud guard of this module.
 * Codes: PAYOUT_RATE_LIMITED(429), BAD_LAWYER_ID, BAD_AMOUNT,
 *        USER_NOT_FOUND(404), NOT_LAWYER(404), OVER_ACCRUAL,
 *        DB_WRITE_FAILED(500), + the guarded() set.
 */
async function adminPayoutHandleCreate(env, ctx, body) {
  const g = await adminPayoutGuarded(env, body);
  if (g.err) return g.err;
  const actorId = adminPayoutInt(g.auth.payload.uid, 0);

  if (!(await marketplaceRateLimit(env, "payout_create:" + actorId, ADMIN_PAYOUT_RATE_LIMIT, 60000))) {
    return appApiErr("PAYOUT_RATE_LIMITED", "تعداد ثبت پرداخت در دقیقه بیش از حد مجاز است؛ لطفاً یک دقیقه صبر کنید.", 429);
  }

  const lawyerUserId = adminPayoutExactInt(body && body.lawyerUserId);
  if (lawyerUserId === null || lawyerUserId <= 0)
    return appApiErr("BAD_LAWYER_ID", "شناسه کاربر وکیل نامعتبر است.");
  const amountToman = adminPayoutExactInt(body && body.amountToman);
  if (amountToman === null || amountToman <= 0)
    return appApiErr("BAD_AMOUNT", "مبلغ پرداخت باید عدد صحیح و بزرگ‌تر از صفر (تومان) باشد.");
  const method = String((body && body.method) || "").trim().slice(0, ADMIN_PAYOUT_METHOD_MAX) || null;

  // The target must be a real lawyer: role='lawyer' AND a lawyer_profiles row
  // (existence of the profile = "applied as lawyer"). Client text never chooses
  // who gets paid out of the platform's pocket without this check.
  const lawyer = await adminPayoutQueryAll(env,
    "SELECT a.role AS role, lp.user_id AS profile_uid FROM app_accounts a " +
    "LEFT JOIN lawyer_profiles lp ON lp.user_id = a.user_id WHERE a.user_id = ?",
    [lawyerUserId]);
  if (lawyer.err) return appApiErr("INTERNAL", "خطا در بررسی حساب وکیل.", 500);
  const lrow = lawyer.rows[0];
  if (!lrow) return appApiErr("USER_NOT_FOUND", "حساب کاربری این وکیل یافت نشد.", 404);
  if (String(lrow.role) !== "lawyer" || lrow.profile_uid == null)
    return appApiErr("NOT_LAWYER", "این کاربر پروفایل وکیل ندارد؛ پرداختی برای او ثبت نمی‌شود.", 404);

  const bal = await adminPayoutLawyerBalance(env, lawyerUserId);
  if (!bal) return appApiErr("INTERNAL", "خطا در محاسبه مانده حساب وکیل.", 500);
  if (amountToman > bal.outstanding) {
    // The guard: refuse OVER-ACCRUAL, showing both figures so the admin can
    // see exactly what the ledger proves. Nothing is written on this path.
    return appApiErr("OVER_ACCRUAL",
      `مبلغ درخواستی (${amountToman} تومان) از مانده قابل پرداخت این وکیل (${bal.outstanding} تومان — درآمد قطعی ${bal.accrued}، پرداخت‌شده ${bal.paidOut}) بیشتر است؛ پرداختی ثبت نشد.`);
  }

  const payoutId = marketplaceNewId();
  const now = marketplaceNow();
  const ins = await adminPayoutQueryRun(env,
    "INSERT INTO payout_ledger (id, lawyer_user_id, amount_toman, status, method, reference, created_at, paid_at, created_by, paid_by) " +
    "VALUES (?, ?, ?, 'pending', ?, NULL, ?, NULL, ?, NULL)",
    [payoutId, lawyerUserId, amountToman, method, now, actorId]);
  if (ins.err) return appApiErr("DB_WRITE_FAILED", "ثبت پرداخت انجام نشد؛ لطفاً دوباره تلاش کنید.", 500);

  const audit = await adminPayoutAudit(env, actorId, "payout_create", payoutId,
    `payout:${payoutId} :: lawyer:${lawyerUserId} :: ${amountToman} IRT pending :: accrued:${bal.accrued} paidOut:${bal.paidOut} outstanding:${bal.outstanding}${method ? " :: method:" + method : ""}`);
  if (audit.err) {
    // The ledger row is already committed; a missing audit row must be loud
    // (mirrors the ADMIN DECISION APPLIED WITHOUT AUDIT ROW precedent).
    console.error("PAYOUT CREATED WITHOUT AUDIT ROW — repair needed:", payoutId,
      "lawyer:" + lawyerUserId, amountToman, audit.err);
  }

  return await adminPayoutPayload(env,
    "پرداخت در انتظار ثبت شد؛ پس از واریز دستی، همین رکورد را «پرداخت شد» علامت بزنید.");
}

// ─────────────────────────── POST /api/v1/admin/payouts/mark ───────────────────────────
/**
 * One-way finalisation of a pending payout: 'paid' stamps paid_at/paid_by and
 * stores the transfer reference; 'cancelled' voids the booking. The UPDATE is
 * a compare-and-set on status='pending' — a row another admin already
 * finalised loses the race and answers PAYOUT_STATE_CONFLICT; nothing ever
 * moves a paid/cancelled row back. Codes: PAYOUT_RATE_LIMITED(429),
 * BAD_PAYOUT_ID, BAD_MARK_STATUS, PAYOUT_NOT_FOUND(404),
 * PAYOUT_STATE_CONFLICT(409), DB_WRITE_FAILED(500), + the guarded() set.
 */
async function adminPayoutHandleMark(env, ctx, body) {
  const g = await adminPayoutGuarded(env, body);
  if (g.err) return g.err;
  const actorId = adminPayoutInt(g.auth.payload.uid, 0);

  if (!(await marketplaceRateLimit(env, "payout_mark:" + actorId, ADMIN_PAYOUT_RATE_LIMIT, 60000))) {
    return appApiErr("PAYOUT_RATE_LIMITED", "تعداد تغییر وضعیت پرداخت در دقیقه بیش از حد مجاز است؛ لطفاً یک دقیقه صبر کنید.", 429);
  }

  const payoutId = adminPayoutExactInt(body && body.payoutId);
  if (payoutId === null || payoutId <= 0)
    return appApiErr("BAD_PAYOUT_ID", "شناسه پرداخت نامعتبر است.");
  const status = String((body && body.status) || "").trim().toLowerCase();
  if (!ADMIN_PAYOUT_MARK_STATUSES.includes(status))
    return appApiErr("BAD_MARK_STATUS", "وضعیت نهایی باید «paid» یا «cancelled» باشد.");
  const reference = String((body && body.reference) || "").trim().slice(0, ADMIN_PAYOUT_REFERENCE_MAX) || null;

  const cur = await adminPayoutQueryAll(env,
    "SELECT id, lawyer_user_id, amount_toman, status FROM payout_ledger WHERE id = ?", [payoutId]);
  if (cur.err) return appApiErr("INTERNAL", "خطا در خواندن رکورد پرداخت.", 500);
  const row = cur.rows[0];
  if (!row) return appApiErr("PAYOUT_NOT_FOUND", "رکورد پرداخت مورد نظر یافت نشد.", 404);

  const now = marketplaceNow();
  const cas = status === "paid"
    ? await adminPayoutQueryRun(env,
        "UPDATE payout_ledger SET status = 'paid', reference = ?, paid_at = ?, paid_by = ? WHERE id = ? AND status = 'pending'",
        [reference, now, actorId, payoutId])
    : await adminPayoutQueryRun(env,
        "UPDATE payout_ledger SET status = 'cancelled', reference = ? WHERE id = ? AND status = 'pending'",
        [reference, payoutId]);
  if (cas.err) return appApiErr("DB_WRITE_FAILED", "تغییر وضعیت پرداخت انجام نشد؛ لطفاً دوباره تلاش کنید.", 500);
  if (cas.changes !== 1) {
    // Someone (or some earlier click of this admin) already finalised the row.
    // The ledger is append-only truth: re-read it for the message and refuse.
    const after = await adminPayoutQueryAll(env,
      "SELECT status FROM payout_ledger WHERE id = ?", [payoutId]);
    const nowStatus = (after.rows && after.rows[0] && after.rows[0].status) || "unknown";
    return appApiErr("PAYOUT_STATE_CONFLICT",
      `این پرداخت دیگر «در انتظار» نیست (وضعیت فعلی: ${nowStatus}) — قابل تغییر مجدد نیست.`, 409);
  }

  const audit = await adminPayoutAudit(env, actorId, "payout_" + status, payoutId,
    `payout:${payoutId} :: lawyer:${adminPayoutInt(row.lawyer_user_id, 0)} :: ${adminPayoutInt(row.amount_toman, 0)} IRT pending -> ${status}${reference ? " :: ref:" + reference : ""}`);
  if (audit.err) {
    console.error("PAYOUT MARKED WITHOUT AUDIT ROW — repair needed:", payoutId,
      "lawyer:" + row.lawyer_user_id, status, audit.err);
  }

  return await adminPayoutPayload(env, status === "paid"
    ? "پرداخت به‌عنوان واریز‌شده ثبت شد و از مانده بدهکاری این وکیل کسر گردید."
    : "ثبت پرداخت لغو شد؛ مبلغ به مانده قابل پرداخت وکیل بازمی‌گردد.");
}

// ─────────────────────────── routes (only top-level side effects) ───────────────────────────
marketplaceRegister("POST /api/v1/admin/payouts/list", async (env, ctx, body) => {
  try { return await adminPayoutHandleList(env, ctx, body); }
  catch (e) { console.error("admin/payouts/list failed:", e && e.message); return appApiErr("INTERNAL", "دفتر پرداخت‌ها در دسترس نیست.", 500); }
});
marketplaceRegister("POST /api/v1/admin/payouts/create", async (env, ctx, body) => {
  try { return await adminPayoutHandleCreate(env, ctx, body); }
  catch (e) { console.error("admin/payouts/create failed:", e && e.message); return appApiErr("INTERNAL", "ثبت پرداخت انجام نشد.", 500); }
});
marketplaceRegister("POST /api/v1/admin/payouts/mark", async (env, ctx, body) => {
  try { return await adminPayoutHandleMark(env, ctx, body); }
  catch (e) { console.error("admin/payouts/mark failed:", e && e.message); return appApiErr("INTERNAL", "تغییر وضعیت پرداخت انجام نشد.", 500); }
});
