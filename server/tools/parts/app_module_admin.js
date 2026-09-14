// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Admin foundation for the Vakil AI marketplace (V1): overview
//             metrics, user search, the lawyer review queue, the ONLY route that
//             can set lawyer_profiles.verification_status (verify/reject/
//             suspend/restore), a whitelisted platform_config editor (commission
//             bps) and the append-only audit trail.
// OWNER     — Agent 6 (Web Admin Dashboard). Server routes: ask the coordinator
//             for contract changes via MARKETPLACE_INTEGRATION_REQUESTS.md.
// CONSUMES  — appApiJson/appApiErr (app_module_head.js); marketplaceRegister +
//             dispatcher (app_module_common.js); marketplaceRequireAdmin (a
//             SERVER-SIDE role==='admin' check on every single call — there is
//             no shared-secret and no back door), marketplaceEnsureTables (the
//             DDL lives in app_module_schema.js — this module never creates a
//             table), marketplaceAccount/ConfigGet/ConfigSet/CommissionBps/Now,
//             the `users` table (read-only: bot display name fallback, ban
//             state), and the V1 tables app_accounts, lawyer_profiles,
//             consultations, payments, payment_splits, platform_config,
//             admin_audit_log (schema per VAKIL_V1_SPEC.md §3).
// PROVIDES  — POST /api/v1/admin/overview
//             POST /api/v1/admin/users/list      {filter?, limit?}
//             POST /api/v1/admin/lawyers/pending {status?='pending'|verified|
//                     rejected|suspended|all, limit?}
//             POST /api/v1/admin/lawyers/decide  {userId,
//                     decision:'verify'|'reject'|'suspend'|'restore', note?}
//             POST /api/v1/admin/config/get      {}
//             POST /api/v1/admin/config/set      {key,value}
//             POST /api/v1/admin/consultations/list {status?}
//             POST /api/v1/admin/audit/list      {limit?}
//             + functions adminHandleOverview, adminHandleUsersList,
//               adminHandlePendingLawyers, adminHandleDecide,
//               adminHandleConfigGet, adminHandleConfigSet,
//               adminHandleConsultations, adminHandleAuditList,
//               adminWriteAudit, adminLawyerRowView (all admin* prefixed).
// INVARIANTS— 1) verification_status is NEVER writable from client input and
//                NEVER writable by a lawyer: /lawyers/decide here is the only
//                path that can REACH 'verified'/'rejected'/'suspended' (the one
//                other writer in the system, app_module_lawyers.js, only
//                downgrades verified→pending on a self-edit and can never
//                verify). Every route here re-checks role==='admin' server-side.
//                No lawyer can self-verify (self-decision: CANNOT_SELF_DECIDE).
//             2) `restore` lands on 'pending', never on 'verified' — a
//                re-review is deliberately required after suspension.
//             3) admin_audit_log is append-only: nothing in V1 updates or
//                deletes an audit row.
//             4) commission rate is data (platform_config.commission_bps),
//                never a literal; only /admin/config/set writes it, inside the
//                0..4000 bps (0..40%) whitelist.
//             5) Money counts are DERIVED from payment_splits rows written by
//                Agent 8; if that ledger is still empty the overview falls back
//                to the current rate and says so (`derived:true`) — it never
//                invents historical numbers.
//             6) No import/export, no top-level await, no top-level side
//                effects other than marketplaceRegister.
// EXTEND    — Add a handler below, guard it with adminGuarded(env, body) (which
//             does ensure-tables + requireAdmin in one step), register the key
//             at the bottom, and append an audit row via adminWriteAudit. New
//             config keys must be added to ADMIN_CONFIG_KEYS with an explicit
//             validator — unknown keys stay BAD_CONFIG_KEY on purpose.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── constants ───────────────────────────
// The complete set of legal states (mirrors the lawyer_profiles CHECK
// constraint in app_module_schema.js / VAKIL_V1_SPEC.md §3).
const ADMIN_VERIFICATION_STATES = ["pending", "verified", "rejected", "suspended"];

// Statuses the review-queue route accepts as a filter: the four states plus
// "all" (an admin view across decided profiles). Never client-raw-SQL — the
// value is checked against this list and then bound as a parameter.
const ADMIN_QUEUE_STATUSES = ADMIN_VERIFICATION_STATES.concat(["all"]);

// Which decisions are allowed FROM each state. Kept as data so the state
// machine is reviewable in one place. `restore` only goes back to 'pending'
// (documented decision: a suspended lawyer must be reviewed again).
const ADMIN_DECISION_RULES = {
  verify: { from: ["pending", "rejected", "suspended"], to: "verified" },
  reject: { from: ["pending", "verified"], to: "rejected" },
  suspend: { from: ["pending", "verified", "rejected"], to: "suspended" },
  restore: { from: ["suspended"], to: "pending" }
};

// Whitelisted platform_config keys: value range + integer coercion. Anything
// else is refused with BAD_CONFIG_KEY — this endpoint cannot write arbitrary
// rows into platform_config.
const ADMIN_CONFIG_KEYS = {
  commission_bps: { min: 0, max: 4000 },
  consultation_window_hours: { min: 1, max: 720 },
  v1_enabled: { min: 0, max: 1 },
  // Audit parity: DB.md said the PSP is admin-switchable; the whitelist said no.
  // It is now — but ONLY to a REGISTERED provider (validated in configSet), and
  // switching to a non-test provider while PAYMENT_ALLOW_TEST_MODE stays unset
  // is exactly the go-live lever payments.js fail-closes around.
  payment_provider: { enum: true }
};

// consultations.status CHECK list (VAKIL_V1_SPEC.md §3) — used to validate the
// optional ?status filter instead of interpolating client text into SQL.
const ADMIN_CONSULTATION_STATUSES = ["CREATED", "PAYMENT_PENDING", "PAID", "ACTIVE",
  "COMPLETED", "CANCELLED", "EXPIRED", "REFUNDED", "FAILED"];

const ADMIN_AUDIT_ACTIONS = ["lawyer_verify", "lawyer_reject", "lawyer_suspend",
  "lawyer_restore", "config_set"];

// ─────────────────────────── small helpers ───────────────────────────
/**
 * Parse a base-10 integer with a hard clamp; garbage/null → fallback.
 * Never lets a client push a number outside the SQL/queue-safe range.
 */
function adminInt(value, fallback, min, max) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === "number" && n < min) n = min;
  if (typeof max === "number" && n > max) n = max;
  return n;
}

/**
 * Shared entry guard for every admin route: ensures the marketplace tables
 * exist, THEN requires role==='admin' on the server. Returns
 * {err} (a Response) or {auth} with {payload, account} for the caller.
 * @returns {Promise<{err?: Response, auth?: {payload: object, account: object}}>}
 */
async function adminGuarded(env, body) {
  try {
    await marketplaceEnsureTables(env);
  } catch (e) {
    console.error("admin ensure tables failed:", e && e.message);
    return { err: appApiErr("SCHEMA_PENDING", "زیرساخت دیتابیس بازار هنوز آماده نشده است. لطفاً بعداً تلاش کنید.", 503) };
  }
  const auth = await marketplaceRequireAdmin(env, body);
  if (auth.err) return { err: auth.err };
  return { auth };
}

/** Run a SELECT and return its rows, or {err: message} — never throws. */
async function adminQueryAll(env, sql, binds) {
  try {
    let stmt = env.DB.prepare(sql);
    if (binds && binds.length) stmt = stmt.bind.apply(stmt, binds);
    const res = await stmt.all();
    return { rows: (res && res.results) || [] };
  } catch (e) {
    console.error("admin query failed:", String(sql).slice(0, 80), e && e.message);
    return { err: (e && e.message) || "query failed" };
  }
}

/** Run an INSERT/UPDATE, or {err: message} — never throws. */
async function adminQueryRun(env, sql, binds) {
  try {
    let stmt = env.DB.prepare(sql);
    if (binds && binds.length) stmt = stmt.bind.apply(stmt, binds);
    await stmt.run();
    return { ok: true };
  } catch (e) {
    console.error("admin write failed:", String(sql).slice(0, 80), e && e.message);
    return { err: (e && e.message) || "write failed" };
  }
}

/**
 * Append one row to admin_audit_log (append-only; there is deliberately no
 * update/delete helper anywhere in this module).
 * @param {number|string|null} targetId stored as TEXT (max 64 chars) alongside
 *   target_type, so a lawyer target reads target_type='lawyer' + target_id='<uid>'.
 * Errors are returned, and callers log them loudly — an admin mutation must
 * never look successful while silently losing its audit row.
 */
async function adminWriteAudit(env, actorUserId, action, targetType, targetId, note) {
  if (!ADMIN_AUDIT_ACTIONS.includes(action)) {
    console.error("adminWriteAudit: refusing unknown action", action);
    return { err: "BAD_AUDIT_ACTION" };
  }
  return await adminQueryRun(env,
    "INSERT INTO admin_audit_log (id, actor_user_id, action, target_type, target_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [marketplaceNewId(), actorUserId == null ? null : actorUserId, action,
      String(targetType || "").slice(0, 32) || null,
      targetId == null ? null : String(targetId).slice(0, 64),
      note == null ? null : String(note).slice(0, 500), marketplaceNow()]);
}

/** Number → finite non-negative number for the wire (D1 may hand back strings). */
function adminMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : (Number.isFinite(n) ? 0 : 0);
}

/**
 * lawyer_profiles row (+ app_accounts display name) → camelCase review view.
 * Field names mirror LawyerProfileResponse in MarketplaceContracts.cs so the
 * dashboard AND the typed client can consume the same rows.
 * verificationStatus/verificationNote/verifiedAt/verifiedBy are admin-visible
 * only: this function is reached exclusively behind marketplaceRequireAdmin.
 */
function adminLawyerRowView(row) {
  return {
    userId: row.user_id,
    slug: row.slug || null,
    displayName: row.display_name || "",
    title: row.title || null,
    bio: row.bio || null,
    specialties: marketplaceJsonArray(row.specialties),
    languages: marketplaceJsonArray(row.languages),
    city: row.city || null,
    jurisdiction: row.jurisdiction || null,
    experienceYears: row.experience_years == null ? null : Number(row.experience_years),
    priceToman: row.price_toman == null ? null : Number(row.price_toman),
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    availabilityNote: row.availability_note || null,
    isAvailable: Number(row.is_available) === 1,
    verificationStatus: row.verification_status || "pending",
    verificationNote: row.verification_note || null,
    verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
    verifiedBy: row.verified_by == null ? null : Number(row.verified_by),
    photoUrl: row.photo_url || null,
    createdAt: row.created_at == null ? null : Number(row.created_at),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at)
  };
}

// ─────────────────────────── handlers ───────────────────────────
/**
 * POST /admin/overview — headline counts for the dashboard cards.
 * counts: users = app_accounts rows; lawyersTotal/Pending/Verified from
 * lawyer_profiles; consultationsOpen = CREATED/PAYMENT_PENDING/PAID/ACTIVE;
 * grossToman/commissionToman = SUM over payments.status='succeeded' JOIN
 * payment_splits; commissionBps = the rate currently configured.
 * Codes: FORBIDDEN, UNAUTHORIZED, SCHEMA_PENDING, INTERNAL.
 */
async function adminHandleOverview(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const counts = await adminQueryAll(env, `
    SELECT
      (SELECT COUNT(*) FROM app_accounts) AS users,
      (SELECT COUNT(*) FROM lawyer_profiles) AS lawyers_total,
      (SELECT COUNT(*) FROM lawyer_profiles WHERE verification_status = 'pending') AS lawyers_pending,
      (SELECT COUNT(*) FROM lawyer_profiles WHERE verification_status = 'verified') AS lawyers_verified,
      (SELECT COUNT(*) FROM lawyer_profiles WHERE verification_status = 'rejected') AS lawyers_rejected,
      (SELECT COUNT(*) FROM lawyer_profiles WHERE verification_status = 'suspended') AS lawyers_suspended,
      (SELECT COUNT(*) FROM consultations WHERE status IN ('CREATED','PAYMENT_PENDING','PAID','ACTIVE')) AS consultations_open,
      (SELECT COUNT(*) FROM consultations) AS consultations_total,
      (SELECT COUNT(*) FROM payments WHERE status = 'succeeded') AS payments_succeeded`);
  if (counts.err) return appApiErr("INTERNAL", "خطا در محاسبه آمار.", 500);

  // reviews is the last extension table in §3; if the deployed schema has not
  // caught up yet, the overview must still work — count it defensively.
  const reviewCount = await adminQueryAll(env, "SELECT COUNT(*) AS reviews_total FROM reviews");

  const ledger = await adminQueryAll(env, `
    SELECT COALESCE(SUM(ps.gross_toman), 0) AS gross_toman,
           COALESCE(SUM(ps.commission_toman), 0) AS commission_toman
    FROM payment_splits ps JOIN payments p ON p.id = ps.payment_id
    WHERE p.status = 'succeeded'`);
  let gross = ledger.err ? 0 : adminMoney(ledger.rows[0] && ledger.rows[0].gross_toman);
  let commission = ledger.err ? 0 : adminMoney(ledger.rows[0] && ledger.rows[0].commission_toman);

  // Honest fallback: until Agent 8's ledger has rows, the totals are DERIVED
  // from the current rate and flagged, so the UI can label them as estimates.
  let derived = false;
  if (!ledger.err && gross === 0 && commission === 0) {
    const sum = await adminQueryAll(env,
      "SELECT COALESCE(SUM(amount_toman), 0) AS gross_toman FROM payments WHERE status = 'succeeded'");
    if (!sum.err) {
      const raw = adminMoney(sum.rows[0] && sum.rows[0].gross_toman);
      if (raw > 0) {
        const bps = await marketplaceCommissionBps(env);
        gross = raw;
        commission = Math.round(raw * bps / 10000);
        derived = true;
      }
    }
  }

  return appApiJson({
    ok: true,
    users: adminMoney(counts.rows[0] && counts.rows[0].users),
    lawyersTotal: adminMoney(counts.rows[0] && counts.rows[0].lawyers_total),
    lawyersPending: adminMoney(counts.rows[0] && counts.rows[0].lawyers_pending),
    lawyersVerified: adminMoney(counts.rows[0] && counts.rows[0].lawyers_verified),
    lawyersRejected: adminMoney(counts.rows[0] && counts.rows[0].lawyers_rejected),
    lawyersSuspended: adminMoney(counts.rows[0] && counts.rows[0].lawyers_suspended),
    consultationsOpen: adminMoney(counts.rows[0] && counts.rows[0].consultations_open),
    consultationsTotal: adminMoney(counts.rows[0] && counts.rows[0].consultations_total),
    paymentsSucceeded: adminMoney(counts.rows[0] && counts.rows[0].payments_succeeded),
    reviewsTotal: reviewCount.err ? 0 : adminMoney(reviewCount.rows[0] && reviewCount.rows[0].reviews_total),
    grossToman: gross,
    commissionToman: commission,
    derived,
    commissionBps: await marketplaceCommissionBps(env),
    message: "آمار نمای کلی آماده است."
  });
}

/**
 * POST /admin/users/list {filter?} — up to 100 AdminUserRow.
 * filter matches display_name / email / username (case-insensitive LIKE).
 * verificationStatus comes from a LEFT JOIN lawyer_profiles (null for
 * non-lawyers). Codes: FORBIDDEN, UNAUTHORIZED, SCHEMA_PENDING, INTERNAL.
 */
async function adminHandleUsersList(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const limit = adminInt(body && body.limit, 100, 1, 100);
  const filter = String((body && body.filter) || "").trim().slice(0, 64);
  const like = "%" + filter.replace(/[%_]/g, "") + "%";

  const where = filter
    ? `WHERE (LOWER(a.display_name) LIKE ? OR LOWER(COALESCE(a.email, '')) LIKE ? OR LOWER(COALESCE(a.username, '')) LIKE ?)`
    : "";
  const binds = filter ? [like, like, like] : [];
  binds.push(limit);

  const rows = await adminQueryAll(env, `
    SELECT a.user_id, a.display_name, a.email, a.username, a.role, a.status,
           a.created_at, a.last_login_at, lp.verification_status, lp.slug
    FROM app_accounts a
    LEFT JOIN lawyer_profiles lp ON lp.user_id = a.user_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ?`, binds);
  if (rows.err) return appApiErr("INTERNAL", "خطا در خواندن فهرست کاربران.", 500);

  const users = rows.rows.map(r => ({
    userId: r.user_id,
    displayName: r.display_name || "",
    email: r.email || null,
    username: r.username || null,
    role: r.role || "client",
    status: r.status || "active",
    verificationStatus: r.verification_status || null,
    slug: r.slug || null,
    createdAt: r.created_at == null ? null : Number(r.created_at),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at)
  }));
  return appApiJson({ ok: true, users, returned: users.length, filter: filter || null });
}

/**
 * POST /admin/lawyers/pending {status?} — the review queue: every field a
 * reviewer needs (bio, specialties, city, experience, price, identity) ordered
 * oldest-first so nobody queue-jumps. Default status='pending'; admins may also
 * ask for 'verified' | 'rejected' | 'suspended' | 'all' to reopen a decided
 * profile (the decision buttons stay useful — restore/re-verify — and the
 * state machine on /admin/lawyers/decide still refuses illegal transitions).
 * Codes: BAD_STATUS, FORBIDDEN, UNAUTHORIZED, SCHEMA_PENDING, INTERNAL.
 */
async function adminHandlePendingLawyers(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const wanted = String((body && body.status) || "pending").trim().toLowerCase();
  if (!ADMIN_QUEUE_STATUSES.includes(wanted))
    return appApiErr("BAD_STATUS", "وضعیت پروفایل برای این فهرست معتبر نیست.");

  const limit = adminInt(body && body.limit, 50, 1, 100);
  const binds = [];
  let where = "";
  if (wanted !== "all") { where = "WHERE lp.verification_status = ?"; binds.push(wanted); }
  binds.push(limit);
  const rows = await adminQueryAll(env, `
    SELECT lp.*, a.display_name
    FROM lawyer_profiles lp
    LEFT JOIN app_accounts a ON a.user_id = lp.user_id
    ${where}
    ORDER BY lp.created_at ASC
    LIMIT ?`, binds);
  if (rows.err) return appApiErr("INTERNAL", "خطا در خواندن صف بررسی وکلا.", 500);

  const lawyers = rows.rows.map(adminLawyerRowView);
  return appApiJson({
    ok: true,
    lawyers,
    total: lawyers.length,
    status: wanted,
    message: lawyers.length ? "صف بررسی وکلا بارگذاری شد." : "هیچ پروفایلی با این وضعیت وجود ندارد."
  });
}

/**
 * POST /admin/lawyers/decide {userId, decision, note?} — the ONLY route in the
 * system that can move verification_status to verified/rejected/suspended (the
 * only other writer, /lawyers/save, downgrades verified→pending). Admin-only,
 * never self.
 * State machine (ADMIN_DECISION_RULES): verify→'verified' from
 * pending|rejected|suspended (+verified_at/verified_by); reject→'rejected' from
 * pending|verified; suspend→'suspended' from pending|verified|rejected;
 * restore→'pending' (NOT straight to 'verified': re-review is required — the
 * documented V1 decision). Writes verification_note + a fresh updated_at, then
 * appends admin_audit_log (actor_user_id, action='lawyer_<decision>',
 * target_type='lawyer', target_id=<user id as text>, note carrying
 * "lawyer:<id> :: <from> -> <to> :: <note>" — i.e. the human target string).
 * Codes: NOT_LAWYER, CANNOT_SELF_DECIDE, USER_NOT_FOUND, BAD_DECISION,
 *        BAD_TRANSITION, DB_WRITE_FAILED, FORBIDDEN, UNAUTHORIZED, SCHEMA_PENDING.
 */
async function adminHandleDecide(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;
  const actorId = g.auth.payload.uid;

  const targetUserId = Number(body && body.userId);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0)
    return appApiErr("BAD_DECISION", "شناسه کاربر نامعتبر است.");

  const decision = String((body && body.decision) || "").trim().toLowerCase();
  const rule = ADMIN_DECISION_RULES[decision];
  if (!rule) return appApiErr("BAD_DECISION", "نوع تصمیم معتبر نیست.");

  const note = String((body && body.note) || "").trim().slice(0, 500);

  // An admin must never sit in their own review queue, and nobody can approve
  // themselves: this is the anti-self-verification invariant.
  if (Number(actorId) === targetUserId)
    return appApiErr("CANNOT_SELF_DECIDE", "مدیر نمی‌تواند درباره وضعیت احراز هویت حساب خودش تصمیم بگیرد.", 403);

  const targetAccount = await marketplaceAccount(env, targetUserId);
  if (!targetAccount)
    return appApiErr("USER_NOT_FOUND", "حساب کاربری مورد نظر یافت نشد.", 404);

  const profRes = await adminQueryAll(env, "SELECT * FROM lawyer_profiles WHERE user_id = ?", [targetUserId]);
  if (profRes.err) return appApiErr("INTERNAL", "خطا در خواندن پروفایل وکیل.", 500);
  const profile = profRes.rows[0];
  // Only an applied lawyer (a lawyer_profiles row exists) can be decided on.
  if (!profile) return appApiErr("NOT_LAWYER", "این کاربر پروفایل وکیل ندارد و در صف احراز هویت نیست.", 404);
  if (!ADMIN_VERIFICATION_STATES.includes(profile.verification_status)) {
    return appApiErr("INTERNAL", "وضعیت احراز هویت نامشخص است؛ لطفاً بررسی شود.", 500);
  }

  const from = profile.verification_status;
  if (!rule.from.includes(from))
    return appApiErr("BAD_TRANSITION",
      `گذار وضعیت «${from}» به «${rule.to}» برای تصمیم «${decision}» مجاز نیست.`);

  const now = marketplaceNow();
  const nextStatus = rule.to;
  const nextNote = note || null;
  // verified_at is stamped when a profile BECOMES verified (also when an
  // already-verified profile is re-verified); verified_by records the admin
  // (actor) id, which is the compliance trail alongside the audit row.
  const nextVerifiedAt = nextStatus === "verified" ? now : profile.verified_at;
  const nextVerifiedBy = nextStatus === "verified" ? actorId : profile.verified_by;

  const upd = await adminQueryRun(env, `
    UPDATE lawyer_profiles
    SET verification_status = ?, verification_note = ?, verified_at = ?, verified_by = ?, updated_at = ?
    WHERE user_id = ?`,
    [nextStatus, nextNote, nextVerifiedAt, nextVerifiedBy, now, targetUserId]);
  if (upd.err) return appApiErr("DB_WRITE_FAILED", "تغییر وضعیت ذخیره نشد. لطفاً دوباره تلاش کنید.", 500);

  // Session freeze on loss of standing (audit: suspending a lawyer previously
  // changed only the badge while their 60-day token kept working). reject and
  // suspend revoke every app_tokens row for the target; verify/restore do not.
  if (decision === "suspend" || decision === "reject") {
    try {
      const rev = await env.DB.prepare("DELETE FROM app_tokens WHERE user_id = ?").bind(targetUserId).run();
      const n = rev && rev.meta ? Number(rev.meta.changes) : 0;
      logInfo("ADMIN_REV", `revoked ${n} session token(s) for lawyer:${targetUserId} (${decision})`);
    } catch (e) { console.error("admin session revoke failed:", e && e.message); }
  }

  const audit = await adminWriteAudit(env, actorId, "lawyer_" + decision, "lawyer",
    targetUserId, `lawyer:${targetUserId} :: ${from} -> ${nextStatus}${note ? " :: " + note : ""}`);
  if (audit.err) {
    // The decision is already committed; a missing audit row must be loud.
    console.error("ADMIN DECISION APPLIED WITHOUT AUDIT ROW — repair needed:",
      "lawyer_" + decision, targetUserId, audit.err);
  }

  const messages = {
    verify: "حساب وکیل تایید شد و در فهرست عمومی نمایش داده می‌شود.",
    reject: "پروفایل وکیل رد شد. کاربر می‌تواند پس از اصلاح، دوباره بررسی شود.",
    suspend: "احراز هویت وکیل معلق شد تا زمانی که مجدداً بررسی شود.",
    restore: "پروفایل به صف «در انتظار بررسی» بازگشت؛ احراز مجدد لازم است."
  };
  return appApiJson({
    ok: true,
    userId: targetUserId,
    verificationStatus: nextStatus,
    previousStatus: from,
    decision,
    auditLogged: !audit.err,
    message: messages[decision]
  });
}

/**
 * POST /admin/config/get {} — the V1 platform knobs as typed values.
 * {ok, config:{commission_bps, v1_enabled, consultation_window_hours}}
 * Codes: FORBIDDEN, UNAUTHORIZED, SCHEMA_PENDING.
 */
async function adminHandleConfigGet(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const v1 = adminInt(await marketplaceConfigGet(env, "v1_enabled", "1"), 1, 0, 1);
  const window = adminInt(await marketplaceConfigGet(env, "consultation_window_hours", "24"), 24, 1, 720);
  return appApiJson({
    ok: true,
    config: {
      commission_bps: await marketplaceCommissionBps(env),
      v1_enabled: v1,
      consultation_window_hours: window
    },
    keys: Object.keys(ADMIN_CONFIG_KEYS)
  });
}

/**
 * POST /admin/config/set {key, value} — whitelisted keys only, integer values
 * inside the declared range; commission changes are audited like decisions.
 * Codes: BAD_CONFIG_KEY (unknown key — deliberate: no arbitrary config rows),
 *        BAD_CONFIG_VALUE (out of range / not an integer), FORBIDDEN.
 */
async function adminHandleConfigSet(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;
  const actorId = g.auth.payload.uid;

  const key = String((body && body.key) || "").trim().toLowerCase();
  const spec = ADMIN_CONFIG_KEYS[key];
  if (!spec) return appApiErr("BAD_CONFIG_KEY", "این کلید پیکربندی مجاز نیست (کلیدهای مجاز: commission_bps، v1_enabled، consultation_window_hours، payment_provider).");

  const raw = body && body.value;

  // Enum-valued key (payment_provider, audit parity): only REGISTERED provider
  // ids may be set; the value is stored as text and audited like the numeric
  // keys. Switching to a non-test provider is accepted only when such a
  // provider is actually registered (payments registry is the source of truth).
  if (spec.enum) {
    const pid = String(raw || "").trim().toLowerCase();
    const known = typeof paymentProvider === "function" ? paymentProvider(pid) : null;
    if (!known) return appApiErr("BAD_CONFIG_VALUE", "پرداخت‌کننده‌ای با این شناسه ثبت نشده است.");
    const previousP = await marketplaceConfigGet(env, key, null);
    await marketplaceConfigSet(env, key, pid, actorId);
    const auditP = await adminWriteAudit(env, actorId, "config_set", "config", key,
      key + ": " + (previousP == null ? "(unset)" : previousP) + " -> " + pid + (pid !== "devtest" ? " :: GO-LIVE LEVER (operator must also set PAYMENT_ALLOW_TEST_MODE deliberately)" : ""));
    if (auditP.err) console.error("ADMIN CONFIG APPLIED WITHOUT AUDIT ROW:", key, auditP.err);
    return appApiJson({
      ok: true, key, value: pid, previous: previousP == null ? null : previousP,
      auditLogged: !auditP.err,
      message: pid === "devtest"
        ? "پرداخت‌کننده روی حالت آزمایشی (devtest) تنظیم شد — هیچ مبلغ واقعی جابه‌جا نمی‌شود."
        : "پرداخت‌کننده واقعی انتخاب شد. مطمئن شوید PAYMENT_ALLOW_TEST_MODE درست تنظیم شده است."
    });
  }

  const parsed = parseInt(raw, 10);
  const num = Number.isFinite(parsed) ? parsed : NaN;
  // No silent clamping: an out-of-range value is a client/admin mistake and is
  // refused, so nobody types 40000 intending 400 and quietly sets 40%.
  if (!Number.isFinite(num) || num < spec.min || num > spec.max) {
    return appApiErr("BAD_CONFIG_VALUE",
      `مقدار «${key}» باید عدد صحیح بین ${spec.min} و ${spec.max} باشد.`);
  }

  const previous = await marketplaceConfigGet(env, key, null);
  await marketplaceConfigSet(env, key, num, actorId);
  const audit = await adminWriteAudit(env, actorId, "config_set", "config", key,
    `${key}: ${previous == null ? "(unset)" : previous} -> ${num}`);
  if (audit.err) console.error("ADMIN CONFIG APPLIED WITHOUT AUDIT ROW:", key, audit.err);

  return appApiJson({
    ok: true,
    key,
    value: num,
    previous: previous == null ? null : previous,
    auditLogged: !audit.err,
    message: key === "commission_bps"
      ? `نرخ کمیسیون پلتفرم به ${num} واحد پایه (بسیس‌پوینت) تغییر کرد؛ بر پرداخت‌های جدید اعمال می‌شود.`
      : "پیکربندی به‌روزرسانی شد."
  });
}

/**
 * POST /admin/consultations/list {status?} — up to 60 consultations joined to
 * client/lawyer names, newest first. `status` must be one of the lifecycle
 * states (validated against a constant list, never interpolated raw).
 * Codes: BAD_STATUS, FORBIDDEN, UNAUTHORIZED, INTERNAL.
 */
async function adminHandleConsultations(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const limit = adminInt(body && body.limit, 30, 1, 60);
  const statusRaw = String((body && body.status) || "").trim().toUpperCase();
  let where = "";
  const binds = [];
  if (statusRaw && statusRaw !== "ALL") {
    if (!ADMIN_CONSULTATION_STATUSES.includes(statusRaw))
      return appApiErr("BAD_STATUS", "وضعیت مشاوره معتبر نیست.");
    where = "WHERE c.status = ?";
    binds.push(statusRaw);
  }
  binds.push(limit);

  const rows = await adminQueryAll(env, `
    SELECT c.id, c.status, c.price_toman, c.duration_minutes,
           c.created_at, c.updated_at, c.paid_at, c.started_at, c.ends_at,
           c.client_user_id, c.lawyer_user_id,
           COALESCE(ca.display_name, cu.first_name, '') AS client_name,
           COALESCE(la.display_name, lu.first_name, '') AS lawyer_name
    FROM consultations c
    LEFT JOIN app_accounts ca ON ca.user_id = c.client_user_id
    LEFT JOIN app_accounts la ON la.user_id = c.lawyer_user_id
    LEFT JOIN users cu ON cu.user_id = c.client_user_id
    LEFT JOIN users lu ON lu.user_id = c.lawyer_user_id
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ?`, binds);
  if (rows.err) return appApiErr("INTERNAL", "خطا در خواندن فهرست مشاوره‌ها.", 500);

  const consultations = rows.rows.map(r => ({
    id: Number(r.id),
    clientUserId: r.client_user_id,
    clientName: r.client_name || null,
    lawyerUserId: r.lawyer_user_id,
    lawyerName: r.lawyer_name || null,
    status: r.status,
    priceToman: r.price_toman == null ? null : Number(r.price_toman),
    durationMinutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
    createdAt: r.created_at == null ? null : Number(r.created_at),
    updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    paidAt: r.paid_at == null ? null : Number(r.paid_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    endsAt: r.ends_at == null ? null : Number(r.ends_at)
  }));
  return appApiJson({ ok: true, consultations, returned: consultations.length, status: statusRaw || null });
}

/**
 * POST /admin/audit/list {limit?} — newest first, hard cap 100 rows.
 * target is rendered as the stored 'lawyer:<id>' / config key text.
 * Codes: FORBIDDEN, UNAUTHORIZED, INTERNAL.
 */
async function adminHandleAuditList(env, ctx, body) {
  const g = await adminGuarded(env, body);
  if (g.err) return g.err;

  const limit = adminInt(body && body.limit, 30, 1, 100);
  const rows = await adminQueryAll(env, `
    SELECT l.id, l.actor_user_id, l.action, l.target_type, l.target_id, l.note,
           l.created_at, COALESCE(a.display_name, u.first_name, '') AS actor_name
    FROM admin_audit_log l
    LEFT JOIN app_accounts a ON a.user_id = l.actor_user_id
    LEFT JOIN users u ON u.user_id = l.actor_user_id
    ORDER BY l.id DESC
    LIMIT ?`, [limit]);
  if (rows.err) return appApiErr("INTERNAL", "خطا در خواندن گزارش مدیران.", 500);

  const entries = rows.rows.map(r => ({
    id: Number(r.id),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: r.actor_name || null,
    action: r.action,
    targetType: r.target_type || null,
    targetId: r.target_id || null,
    target: `${r.target_type || "target"}:${r.target_id == null ? "-" : r.target_id}`,
    note: r.note || null,
    createdAt: r.created_at == null ? null : Number(r.created_at)
  }));
  return appApiJson({ ok: true, entries, returned: entries.length });
}

// ─────────────────────────── route registration ───────────────────────────
marketplaceRegister("POST /api/v1/admin/overview", async (env, ctx, body) => await adminHandleOverview(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/users/list", async (env, ctx, body) => await adminHandleUsersList(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/lawyers/pending", async (env, ctx, body) => await adminHandlePendingLawyers(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/lawyers/decide", async (env, ctx, body) => await adminHandleDecide(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/config/get", async (env, ctx, body) => await adminHandleConfigGet(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/config/set", async (env, ctx, body) => await adminHandleConfigSet(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/consultations/list", async (env, ctx, body) => await adminHandleConsultations(env, ctx, body));
marketplaceRegister("POST /api/v1/admin/audit/list", async (env, ctx, body) => await adminHandleAuditList(env, ctx, body));
