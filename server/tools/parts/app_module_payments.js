// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Payment provider abstraction + the ONE honest dev/test provider
//             (`devtest`) for V1, the idempotent `/consultations/pay` flow
//             (pending row → charge → settlement → PAID transition) and the
//             commission split ledger (`payment_splits`), plus the role-aware
//             `/payments/history` surface. Real money movement NEVER happens
//             here: a production PSP plugs in by registering a second provider.
// OWNER     — Agent 8 — Payment & Commission (owns future edits to this part).
// CONSUMES  — app_module_common.js: marketplaceRegister, marketplaceEnsureTables,
//             marketplaceRequireToken, marketplaceNewId,
//             marketplaceNow, marketplaceCommissionBps, marketplaceConfigGet,
//             marketplaceRateLimit; appApiJson/appApiErr (app_module_head.js);
//             D1 tables payments, payment_splits, consultations, platform_config
//             (DDL owned by Agent 3 / app_module_schema.js).
//             Agent 7 seam (app_module_consultations.js), called ONLY inside
//             function bodies: consultationLoad(env,id),
//             consultationMembership(row,userId),
//             consultationTransition(env,id,fromStatuses[],toStatus,extraCols),
//             consultationView(env,row,viewerUserId).
// PROVIDES  — routes: POST /api/v1/consultations/pay,
//             POST /api/v1/payments/history, POST /api/v1/payments/providers.
//             seam for Agent 7: paymentProviderName(env),
//             paymentCreatePending(env,{consultation,amountToman,idempotencyKey})
//             → payment row id, paymentCharge(env,{paymentId,idempotencyKey})
//             → {ok,status,providerRef,error}. Registry: paymentRegisterProvider.
// INVARIANTS— (a) CLIENT INPUT CAN NEVER SET A PAYMENT STATUS: amount comes from
//                consultations.price_toman (server snapshot), payer from the
//                consultation row's client_user_id, status only from the
//                provider's charge() result as persisted by paymentCharge.
//             (b) ONE PAYMENT = AT MOST ONE payment_splits ROW (payment_id is the
//                PK; INSERT OR REPLACE + the already-succeeded short-circuit in
//                paymentCharge means a replay NEVER re-charges or re-writes the
//                ledger, and the applied commission_bps is STORED, never
//                re-derived from today's platform_config).
//             (c) `devtest` IS A TEST MODE, NEVER PRODUCTION: it moves no money,
//                every settled payment carries provider='devtest' + a
//                'devtest-sim-' ref + an honest Persian test label in the
//                message, and paymentCharge refuses to let the simulator settle
//                once the operator disables test mode (env
//                PAYMENT_ALLOW_TEST_MODE='0', set when a real PSP goes live).
//                No client field can hide or influence any of this.
//             (d) ALL MONEY IS INTEGER TOMAN — integer arithmetic + Math.round
//                only, never floating-point accumulation, never SUM in JS.
//             (e) ORDER-INDEPENDENT PAIRING: this file and
//                app_module_consultations.js may be concatenated in either
//                order. The consultation* seam is referenced only inside
//                function bodies (resolved at call time) and every use is
//                preceded by paymentSeamReady(), so a missing/badly-named seam
//                fails CLOSED as JSON — never a half-charged consultation.
//             (f) NO import/export/top-level await; the only top-level side
//                effects are marketplaceRegister(...) + paymentRegisterProvider(...).
// EXTEND    — add a PSP: paymentRegisterProvider('zarinpal', { name, isTestMode:
//             false, async charge(ctx){…} }) in its own part file, then set
//             platform_config.payment_provider='zarinpal' via /admin/config/set.
//             No handler change is required — paymentProviderName() resolves the
//             registered id and paymentCharge() drives it. Add payout tracking as
//             a NEW table (payment_payouts) referenced by payment_splits
//             .payment_id; do NOT overload payout_status onto payments in V1.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── provider registry ───────────────────────────
// A PSP is `{ name, isTestMode, charge(ctx) }`. charge() is the ONLY place a
// payment status originates, and it receives server-loaded rows — never the
// request body. Keep this map tiny: it is the extension point, not a fortress.
const PAYMENT_PROVIDERS = Object.create(null);

/**
 * Registers one payment provider (idempotent — later registration wins).
 * @param {string} id            stored in payments.provider, settable in platform_config.payment_provider
 * @param {{name:string, isTestMode?:boolean, charge:function}} def
 */
function paymentRegisterProvider(id, def) {
  const key = String(id || "").trim().toLowerCase();
  if (!key || !def || typeof def.charge !== "function") {
    throw new Error("PAYMENT_PROVIDER_INVALID: " + id);
  }
  PAYMENT_PROVIDERS[key] = {
    id: key,
    name: String(def.name || key),
    isTestMode: def.isTestMode === true,
    charge: def.charge
  };
}

/** The registered provider object for an id, or null. */
function paymentProvider(id) {
  return PAYMENT_PROVIDERS[String(id || "").trim().toLowerCase()] || null;
}

// ─────────────────────────── the dev/test provider ───────────────────────────
// DEVTEST SIMULATES A PSP — IT MOVES NO REAL MONEY AND NEVER REPORTS A
// PRODUCTION PAYMENT. Deterministic so failures are testable WITHOUT randomness:
//   • amount <= 0 (or non-integer)      → failed   (invalid amount)
//   • amount whose last digit is 9       → failed   ("declined card" switch)
//   • anything else                      → succeeded with providerRef 'devtest-sim-<paymentId>'
// A production PSP (ZarinPal / IDPay / …) plugs in by registering a SECOND
// provider with isTestMode:false — no other change in this module is needed.
paymentRegisterProvider("devtest", {
  name: "حالت آزمایشی (شبیه‌ساز پرداخت)",
  isTestMode: true,
  charge: async function devtestCharge(ctx) {
    const amount = Number(ctx && ctx.amountToman);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return { ok: false, status: "failed", error: "مبلغ پرداخت نامعتبر است؛ مبلغ باید عدد صحیح و بزرگ‌تر از صفر باشد." };
    }
    if (Math.floor(amount) % 10 === 9) {
      return { ok: false, status: "failed", error: "کارت بانکی در حالت آزمایشی رد شد (مبلغ‌هایی که به رقم ۹ ختم می‌شوند شبیه‌سازی «پرداخت ناموفق» هستند)." };
    }
    const pid = ctx && ctx.payment && ctx.payment.id != null ? ctx.payment.id : "unknown";
    return { ok: true, status: "succeeded", providerRef: "devtest-sim-" + pid };
  }
});

// ─────────────────────────── small internal helpers ───────────────────────────
/** Integer Tomans only: safe int of a value, else `fallback` (never NaN/null). */
function paymentInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * STRICT integer-Toman parse: a JS integer, or an exact integer-formatted
 * string (some D1 drivers hand back TEXT for INTEGER columns). Anything
 * fractional, boolean, exponent-notation or garbage → null, so a payment amount
 * is NEVER silently re-rounded into a different amount.
 */
function paymentExactInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Integer Tomans for wire DTOs where "unknown/absent" must stay null, NEVER 0
 * (0 would claim a settled split that does not exist). Note Number(null)===0 —
 * hence the explicit emptiness check.
 */
function paymentIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Commission split, INTEGER math only. This is the exact formula used
 * everywhere in this module:
 *   commissionToman   = Math.round(grossToman * commissionBps / 10000)
 *   lawyerEarningsToman = grossToman - commissionToman      (sum is exact by construction)
 */
function paymentSplitAmounts(grossToman, commissionBps) {
  const gross = Math.max(0, paymentInt(grossToman, 0));
  const bps = Math.min(10000, Math.max(0, paymentInt(commissionBps, 0)));
  const commission = Math.round(gross * bps / 10000);
  return { gross, commissionBps: bps, commissionToman: commission, lawyerEarningsToman: gross - commission };
}

/** True when the Agent 7 consultation seam is callable. Fail-closed guard (INVARIANT e). */
function paymentSeamReady() {
  return typeof consultationLoad === "function"
    && typeof consultationMembership === "function"
    && typeof consultationTransition === "function"
    && typeof consultationView === "function";
}

function paymentSeamMissing() {
  return appApiErr("CONSULTATION_MODULE_MISSING",
    "ماژول مشاوره در دسترس نیست؛ پرداخت انجام نشد.", 500);
}

const PAYMENT_CLOSED_STATUSES = ["CANCELLED", "EXPIRED", "REFUNDED", "FAILED"];
const PAYMENT_PAID_STATUSES = ["PAID", "ACTIVE", "COMPLETED"];

/** payments row → PaymentTransactionDto (camelCase); split fields nullable. */
function paymentTransactionView(row) {
  return {
    id: paymentInt(row.id, 0),
    consultationId: paymentInt(row.consultation_id, 0),
    amountToman: paymentInt(row.amount_toman, 0),
    status: String(row.status || "pending"),
    provider: String(row.provider || "devtest"),
    commissionToman: paymentIntOrNull(row.commission_toman),
    lawyerEarningsToman: paymentIntOrNull(row.lawyer_earnings_toman),
    createdAt: paymentInt(row.created_at, 0),
    settledAt: row.settled_at == null ? null : paymentInt(row.settled_at, 0)
  };
}

// ─────────────────────────── exported seam (used by Agent 7) ───────────────────────────
/**
 * Which provider settles payments right now. Data-driven, fail-safe: an
 * unregistered / empty / bad value in platform_config.payment_provider falls
 * back to 'devtest' so a typo can never silently disable charging.
 * @returns {Promise<string>} a registered provider id ('devtest' in V1)
 */
async function paymentProviderName(env) {
  const raw = await marketplaceConfigGet(env, "payment_provider", "devtest");
  const id = String(raw || "").trim().toLowerCase();
  // Fail CLOSED on an unknown non-empty provider (audit M3): a typo'd switch to
  // a production PSP must NOT silently settle with the simulator. Empty/unset
  // stays devtest (fresh deploy), which /payments/providers reports honestly.
  if (id && id !== "devtest" && !paymentProvider(id)) return "UNREGISTERED:" + id;
  return paymentProvider(id) ? id : "devtest";
}

/**
 * Finds or creates the pending payments row for a consultation (never inserts
 * twice). Amount/payer come from the SERVER consultation row — a client-supplied
 * amount is not read anywhere in this module.
 * @param {{consultation:object, amountToman:number, idempotencyKey?:string|null}} opts
 * @returns {Promise<number>} payments.id
 * @throws Error('PAYMENT_AMOUNT_INVALID') when the amount is not positive integer Toman
 */
async function paymentCreatePending(env, opts) {
  const consultation = (opts && opts.consultation) || {};
  const amountToman = paymentExactInt(opts && opts.amountToman);
  if (amountToman === null || amountToman <= 0) throw new Error("PAYMENT_AMOUNT_INVALID: " + String(opts && opts.amountToman));
  const key = String((opts && opts.idempotencyKey) || "").trim().slice(0, 120) || null;
  const consultationId = paymentInt(consultation.id, 0);
  if (!consultationId) throw new Error("PAYMENT_AMOUNT_INVALID: consultation id missing");

  // 1) same idempotency key already seen FOR THIS CONSULTATION → that row. A key
  //    already stamped on another consultation's payment (payments.idempotency_key
  //    is globally UNIQUE, two clients can repeat a key) is NEVER adopted and never
  //    re-stamped: the new row just goes out without a key. Dedupe for this
  //    consultation is still guaranteed by step 2 + the status guard in /pay.
  const byKey = key
    ? await env.DB.prepare("SELECT * FROM payments WHERE idempotency_key = ?").bind(key).first()
    : null;
  if (byKey && paymentInt(byKey.consultation_id, -1) === consultationId) return paymentInt(byKey.id, 0);
  const rowKey = byKey ? null : key;
  // 2) a live row for this consultation (pending = retry, succeeded = replay) → reuse.
  const existing = await env.DB.prepare(
    "SELECT * FROM payments WHERE consultation_id = ? AND status IN ('pending','succeeded') ORDER BY id DESC LIMIT 1"
  ).bind(consultationId).first();
  if (existing) return paymentInt(existing.id, 0);

  // 3) fresh pending row.
  let provider = await paymentProviderName(env);
  // An unregistered configured id is STAMPED as-is (honest row provenance);
  // paymentCharge then refuses to settle it (PROVIDER_NOT_CONFIGURED, M3).
  if (provider.indexOf("UNREGISTERED:") === 0) provider = provider.slice(13);
  const id = marketplaceNewId();
  const insert = (stampKey) => env.DB.prepare(
    "INSERT INTO payments (id, consultation_id, user_id, amount_toman, currency, provider, status, provider_ref, idempotency_key, created_at, settled_at) " +
    "VALUES (?, ?, ?, ?, 'IRT', ?, 'pending', NULL, ?, ?, NULL)"
  ).bind(id, consultationId, paymentInt(consultation.client_user_id, 0), amountToman,
    provider, stampKey, marketplaceNow()).run();
  try {
    await insert(rowKey);
  } catch (e) {
    // UNIQUE(idempotency_key) lost the race — or an UNRELATED consultation already
    // carries this key string (keys are unique table-wide). Either way: adopt a
    // live row for THIS consultation if one exists, else retry un-keyed so a
    // colliding string from another client can never block an honest invoice.
    const same = await env.DB.prepare(
      "SELECT id FROM payments WHERE consultation_id = ? AND status IN ('pending','succeeded') ORDER BY id DESC LIMIT 1"
    ).bind(consultationId).first();
    if (same && same.id != null) return paymentInt(same.id, 0);
    if (!rowKey) { console.error("paymentCreatePending insert failed:", e && e.message); throw e; }
    try {
      await insert(null);
    } catch (e2) {
      const again = await env.DB.prepare(
        "SELECT id FROM payments WHERE consultation_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(consultationId).first();
      if (again && again.id != null) return paymentInt(again.id, 0);
      console.error("paymentCreatePending insert failed:", e2 && e2.message);
      throw e2;
    }
  }
  return id;
}

/**
 * Drives the registered provider for one payment and persists the outcome.
 * THE ONLY WRITER OF payments.status / payment_splits. Guarantees:
 *   • already-'succeeded' → no provider call, no ledger rewrite (replay-safe)
 *   • 'refunded'          → refused
 *   • provider status outside {succeeded,failed,pending} → treated as 'pending'
 *   • devtest may never settle in a production runtime (INVARIANT c)
 * @param {{paymentId?:number|string, idempotencyKey?:string}} opts
 * @returns {Promise<{ok:boolean,status:string,providerRef:string|null,paymentId:number|null,
 *                    provider:string,commissionToman:number|null,lawyerEarningsToman:number|null,
 *                    commissionBps:number|null,settled:boolean,error:string|null}>}
 */
async function paymentCharge(env, opts) {
  const paymentId = paymentInt(opts && opts.paymentId, 0);
  const key = String((opts && opts.idempotencyKey) || "").trim().slice(0, 120) || null;
  const load = paymentId
    ? await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first()
    : (key ? await env.DB.prepare("SELECT * FROM payments WHERE idempotency_key = ?").bind(key).first() : null);

  if (!load) {
    return { ok: false, status: "failed", providerRef: null, paymentId: null, provider: "", commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: "رکورد پرداخت یافت نشد." };
  }
  if (load.status === "refunded") {
    return { ok: false, status: "failed", providerRef: load.provider_ref || null, paymentId: paymentInt(load.id, 0), provider: String(load.provider || ""), commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: "این پرداخت بازپرداخت شده است و دوباره قابل پرداخت نیست." };
  }
  if (load.status === "succeeded") {
    // Replay: report the STORED ledger (never re-derive the rate from today's
    // config). HEAL path (audit H2): if a crash landed between the settlement
    // CAS and the split INSERT, the ledger row is missing — rebuild it exactly
    // once here (payment_id is the PK, so re-inserting is idempotent). The rate
    // used is today's config — an accepted V1 compromise for a repair of a row
    // that has NO recorded rate at all; loudly logged so ops can review it.
    const split = await env.DB.prepare("SELECT * FROM payment_splits WHERE payment_id = ?").bind(paymentInt(load.id, 0)).first();
    if (split) {
      return { ok: true, status: "succeeded", providerRef: load.provider_ref || null, paymentId: paymentInt(load.id, 0), provider: String(load.provider || "devtest"),
        commissionToman: paymentInt(split.commission_toman, 0),
        lawyerEarningsToman: paymentInt(split.lawyer_earnings_toman, 0),
        commissionBps: paymentInt(split.commission_bps, 0), settled: true, error: null };
    }
    const healAmount = paymentExactInt(load.amount_toman);
    if (healAmount !== null && healAmount > 0) {
      console.warn("paymentCharge replay HEALING missing split for payment", paymentInt(load.id, 0));
      const amounts = paymentSplitAmounts(healAmount, await marketplaceCommissionBps(env));
      const healConsult = typeof consultationLoad === "function" ? await consultationLoad(env, paymentInt(load.consultation_id, 0)) : null;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO payment_splits (payment_id, consultation_id, lawyer_user_id, gross_toman, commission_toman, lawyer_earnings_toman, commission_bps) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(paymentInt(load.id, 0), paymentInt(load.consultation_id, 0),
        healConsult ? paymentInt(healConsult.lawyer_user_id, 0) : null, amounts.gross, amounts.commissionToman, amounts.lawyerEarningsToman, amounts.commissionBps).run();
      return { ok: true, status: "succeeded", providerRef: load.provider_ref || null, paymentId: paymentInt(load.id, 0), provider: String(load.provider || "devtest"),
        commissionToman: amounts.commissionToman, lawyerEarningsToman: amounts.lawyerEarningsToman,
        commissionBps: amounts.commissionBps, settled: true, healed: true, error: null };
    }
    return { ok: true, status: "succeeded", providerRef: load.provider_ref || null, paymentId: paymentInt(load.id, 0), provider: String(load.provider || "devtest"),
      commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: true, error: null };
  }

  const configured = await paymentProviderName(env);
  if (configured.indexOf("UNREGISTERED:") === 0) {
    // M3: money must never settle through a silently-swapped provider.
    return { ok: false, status: "failed", providerRef: null, paymentId: paymentInt(load.id, 0), provider: configured.slice(13),
      commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false,
      error: "PROVIDER_NOT_CONFIGURED: پرداخت‌کننده تنظیم‌شده («" + configured.slice(13) + "») ثبت نشده است — با پشتیبانی هماهنگ کنید." };
  }
  const provider = paymentProvider(load.provider) || paymentProvider(configured) || paymentProvider("devtest");
  const consult = typeof consultationLoad === "function" ? await consultationLoad(env, paymentInt(load.consultation_id, 0)) : null;
  // SQLite's INTEGER column can physically hold a REAL, so the STORED amount is
  // re-validated here: a corrupt/non-integer amount is never silently rounded
  // into a different charge — it fails closed and no provider is called.
  const amountToman = paymentExactInt(load.amount_toman);
  if (amountToman === null) {
    await env.DB.prepare("UPDATE payments SET status = 'failed', provider_ref = NULL, settled_at = NULL WHERE id = ?").bind(paymentInt(load.id, 0)).run();
    return { ok: false, status: "failed", providerRef: null, paymentId: paymentInt(load.id, 0), provider: provider.id, commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: "مبلغ ثبت‌شده این پرداخت نامعتبر است (عدد صحیح تومان نیست)؛ پرداخت انجام نشد." };
  }

  // Fail closed: an operator who has switched the runtime OFF from test mode
  // (env PAYMENT_ALLOW_TEST_MODE='0', set when a real PSP goes live) must never
  // get a settlement minted by the simulator. The var is operator config —
  // no client field can influence it (default = test mode allowed, which is
  // what V1 is).
  // Strict parse (audit M2): ONLY unset or an explicit positive allows test mode.
  // "", "0", "false", "off", "no" and any typo all FAIL CLOSED — the kill switch
  // can no longer be defeated by writing the wrong kind of "off".
  const tmRawRaw = env.PAYMENT_ALLOW_TEST_MODE;
  const tmRaw = tmRawRaw == null ? null : String(tmRawRaw).trim().toLowerCase();
  const testModeAllowed = tmRaw === null || tmRaw === "" || tmRaw === "1" || tmRaw === "true" || tmRaw === "on" || tmRaw === "yes";
  if (provider.isTestMode && !testModeAllowed) {
    await env.DB.prepare("UPDATE payments SET status = 'failed', provider_ref = NULL, settled_at = NULL WHERE id = ?").bind(paymentInt(load.id, 0)).run();
    return { ok: false, status: "failed", providerRef: null, paymentId: paymentInt(load.id, 0), provider: provider.id, commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: "DEVTEST_BLOCKED_IN_PRODUCTION: پرداخت‌کننده آزمایشی در محیط تولید غیرفعال است." };
  }

  let res = null;
  try {
    res = await provider.charge({ env, payment: load, consultation: consult || null, amountToman, idempotencyKey: load.idempotency_key || null, isTestMode: provider.isTestMode });
  } catch (e) {
    console.error("paymentCharge provider crash:", provider.id, e && e.message);
    res = { ok: false, status: "pending", error: "خطای داخلی پرداخت‌کننده؛ پرداخت در حالت «در انتظار» ماند." };
  }
  res = res || {};
  const status = ["succeeded", "failed", "pending"].includes(String(res.status)) ? String(res.status) : "pending";
  const now = marketplaceNow();

  if (status === "succeeded") {
    // Race-safe settlement: compare-and-set the row out of 'pending'. Two pay
    // calls that both loaded 'pending' (double-tap, retry, or parallel tabs)
    // would otherwise BOTH write — the ledger stays correct (payment_id is the
    // split PK) but only the CAS winner records the amounts and derives the
    // split from the rate at settlement time. The loser re-reads the winner's
    // stored split and answers as an idempotent replay — never a second
    // settlement view, never a rewritten rate.
    const ref = String(res.providerRef || provider.id + "-ref-" + paymentInt(load.id, 0)).slice(0, 120);
    const claim = await env.DB.prepare(
      "UPDATE payments SET status = 'succeeded', provider_ref = ?, settled_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(ref, now, paymentInt(load.id, 0)).run();
    const won = claim && claim.meta && Number(claim.meta.changes) === 1;
    if (!won) {
      const settled = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentInt(load.id, 0)).first();
      const split = await env.DB.prepare("SELECT * FROM payment_splits WHERE payment_id = ?").bind(paymentInt(load.id, 0)).first();
      return { ok: true, status: "succeeded", providerRef: (settled && settled.provider_ref) || ref, paymentId: paymentInt(load.id, 0),
        provider: String((settled && settled.provider) || provider.id),
        commissionToman: split ? paymentInt(split.commission_toman, 0) : null,
        lawyerEarningsToman: split ? paymentInt(split.lawyer_earnings_toman, 0) : null,
        commissionBps: split ? paymentInt(split.commission_bps, 0) : null, settled: true, replayed: true, error: null };
    }
    // Ledger: exactly one row per payment (payment_id is the PK → INSERT cannot
    // duplicate) using the rate that ACTUALLY applies at settlement.
    const amounts = paymentSplitAmounts(amountToman, await marketplaceCommissionBps(env));
    await env.DB.prepare(
      "INSERT OR REPLACE INTO payment_splits (payment_id, consultation_id, lawyer_user_id, gross_toman, commission_toman, lawyer_earnings_toman, commission_bps) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(paymentInt(load.id, 0), paymentInt(load.consultation_id, 0),
      consult ? paymentInt(consult.lawyer_user_id, 0) : null,
      amounts.gross, amounts.commissionToman, amounts.lawyerEarningsToman, amounts.commissionBps).run();
    return { ok: true, status: "succeeded", providerRef: ref || null, paymentId: paymentInt(load.id, 0), provider: provider.id,
      commissionToman: amounts.commissionToman, lawyerEarningsToman: amounts.lawyerEarningsToman, commissionBps: amounts.commissionBps, settled: true, error: null };
  }

  if (status === "failed") {
    await env.DB.prepare("UPDATE payments SET status = 'failed', provider_ref = NULL, settled_at = NULL WHERE id = ?").bind(paymentInt(load.id, 0)).run();
    return { ok: false, status: "failed", providerRef: null, paymentId: paymentInt(load.id, 0), provider: provider.id, commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: String(res.error || "پرداخت ناموفق بود.") };
  }

  // pending: nothing is settled, nothing is marked paid — the client may retry.
  await env.DB.prepare("UPDATE payments SET status = 'pending' WHERE id = ?").bind(paymentInt(load.id, 0)).run();
  return { ok: true, status: "pending", providerRef: res.providerRef ? String(res.providerRef) : null, paymentId: paymentInt(load.id, 0), provider: provider.id, commissionToman: null, lawyerEarningsToman: null, commissionBps: null, settled: false, error: res.error ? String(res.error) : null };
}

// ─────────────────────────── POST /api/v1/consultations/pay ───────────────────────────
/**
 * Idempotent consultation payment. Body {token, consultationId, idempotencyKey?}.
 * Only the consultation's CLIENT may call; only CREATED/PAYMENT_PENDING is payable.
 * Codes: FORBIDDEN(403) · CONSULTATION_NOT_FOUND(404) · CONSULTATION_CLOSED(409) ·
 * CONSULTATION_ALREADY_PAID(200, ok:true, no second charge) · CONSULTATION_ID_INVALID ·
 * CONSULTATION_PRICE_MISSING(409) · PAYMENT_FAILED(200, ok:false) ·
 * CONSULTATION_MODULE_MISSING(500) · PAYMENT_RATE_LIMITED(429)
 */
async function paymentHandlePay(env, ctx, body) {
  if (!paymentSeamReady()) return paymentSeamMissing();
  await marketplaceEnsureTables(env);

  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const uid = paymentInt(auth.payload.uid, 0);

  if (!(await marketplaceRateLimit(env, "pay:" + uid, 20, 60000))) {
    return appApiErr("PAYMENT_RATE_LIMITED", "تعداد تلاش برای پرداخت بیش از حد مجاز است؛ لطفاً یک دقیقه صبر کنید.", 429);
  }

  const consultationId = paymentExactInt(body && body.consultationId);
  if (consultationId === null || consultationId <= 0) return appApiErr("CONSULTATION_ID_INVALID", "شناسه مشاوره نامعتبر است.");
  const row = await consultationLoad(env, consultationId);
  if (!row) return appApiErr("CONSULTATION_NOT_FOUND", "مشاوره مورد نظر یافت نشد.", 404);

  // Membership: the server row is authoritative for money (INVARIANT a); the
  // Agent 7 helper is consulted as a SECOND, contradiction-checking signal — a
  // concrete non-client answer blocks even if ids match, an unknown shape does
  // not (the id equality above is what actually gates the payer).
  const isClientPayer = paymentInt(row.client_user_id, -1) === uid;
  let memb = null;
  try { memb = await consultationMembership(row, uid); } catch (e) { console.error("consultationMembership error:", e && e.message); }
  const membNorm = typeof memb === "string" ? memb.toLowerCase()
    : (memb === true ? "client" : (memb && memb.role ? String(memb.role).toLowerCase() : null));
  const membSaysClient = !membNorm || membNorm === "client" || membNorm === "payer";
  if (!isClientPayer || !membSaysClient) {
    return appApiErr("FORBIDDEN", "فقط کارفرمای همین مشاوره می‌تواند آن را پرداخت کند.", 403);
  }

  const status = String(row.status || "");
  const key = String((body && body.idempotencyKey) || "").trim().slice(0, 120) || null;
  const view = async (r) => await consultationView(env, r, uid);

  // Already paid / running / finished with money in → idempotent replay, no charge.
  if (PAYMENT_PAID_STATUSES.includes(status)) {
    const paid = await env.DB.prepare(
      "SELECT p.*, s.commission_toman, s.lawyer_earnings_toman, s.commission_bps FROM payments p " +
      "LEFT JOIN payment_splits s ON s.payment_id = p.id WHERE p.consultation_id = ? AND p.status = 'succeeded' ORDER BY p.id DESC LIMIT 1"
    ).bind(consultationId).first();
    return appApiJson({
      ok: true,
      code: "CONSULTATION_ALREADY_PAID",
      consultation: await view(row),
      paymentStatus: "succeeded",
      commissionToman: paid ? paymentInt(paid.commission_toman, 0) : null,
      lawyerEarningsToman: paid ? paymentInt(paid.lawyer_earnings_toman, 0) : null,
      paymentId: paid ? paymentInt(paid.id, 0) : null,
      provider: paid ? String(paid.provider || "devtest") : null,
      devModeNotice: paid && paid.provider === "devtest" ? paymentDevNotice() : null,
      message: "این مشاوره قبلاً پرداخت شده است."
    });
  }
  if (PAYMENT_CLOSED_STATUSES.includes(status)) {
    return appApiErr("CONSULTATION_CLOSED", "این مشاوره بسته شده است و قابل پرداخت نیست.", 409);
  }
  if (status !== "PAYMENT_PENDING" && status !== "CREATED") {
    return appApiErr("CONSULTATION_CLOSED", "وضعیت این مشاوره امکان پرداخت نمی‌دهد.", 409);
  }

  const price = paymentExactInt(row.price_toman);
  if (price === null || price <= 0) {
    return appApiErr("CONSULTATION_PRICE_MISSING", "قیمت این مشاوره ثبت نشده است؛ با وکیل هماهنگ کنید.", 409);
  }

  // A key that already stamps ANOTHER consultation's payment is simply not
  // reusable (payments.idempotency_key is globally unique across users, and two
  // clients can coincidentally send the same string). It must never block or
  // move money: paymentCreatePending then creates/adopts THIS consultation's row
  // without re-stamping the key, and dedupe for this consultation is still
  // guaranteed by the consultation-scoped reuse + the status guard above.
  const paymentId = await paymentCreatePending(env, { consultation: row, amountToman: price, idempotencyKey: key });

  const charge = await paymentCharge(env, { paymentId, idempotencyKey: null });

  if (charge.status === "failed") {
    // Retriable: the consultation stays PAYMENT_PENDING on purpose.
    return appApiJson({
      ok: false, code: "PAYMENT_FAILED",
      consultation: await view(await consultationLoad(env, consultationId) || row),
      paymentStatus: "failed", commissionToman: null, lawyerEarningsToman: null,
      paymentId, provider: charge.provider,
      message: charge.error || "پرداخت ناموفق بود. می‌توانید دوباره تلاش کنید."
    }, 200);
  }
  if (charge.status === "pending") {
    return appApiJson({
      ok: true, code: "PAYMENT_PENDING",
      consultation: await view(row),
      paymentStatus: "pending", commissionToman: null, lawyerEarningsToman: null,
      paymentId, provider: charge.provider,
      devModeNotice: charge.provider === "devtest" ? paymentDevNotice() : null,
      message: "در حال تأیید پرداخت — اگر چند لحظه طول کشید، همین درخواست را با همان کلید تکرار دوباره بفرستید."
    });
  }

  // Succeeded → PAID + the consultation window, so Agent 7's expiry rule works
  // (the FROM-guard inside consultationTransition means a concurrent payer/expiry
  // can never be overwritten by this write — whoever loses re-reads the truth).
  // Audit M4: ends_at is deliberately NOT stamped here. The conversation window
  // starts at the FIRST message (consultationHandleSend re-anchors it); paying
  // only opens the redemption deadline handled by consultationIsExpired via
  // platform consultation_window_hours. Stamping it here granted up to 2× the
  // paid duration (pay + full window elapsing, then first message + window).
  const now = marketplaceNow();
  const transitioned = await consultationTransition(env, consultationId,
    ["PAYMENT_PENDING", "CREATED"], "PAID",
    { paid_at: now });
  const fresh = (transitioned && transitioned.row) || (await consultationLoad(env, consultationId)) || row;
  if (transitioned && transitioned.ok === false && String(fresh.status || "") !== "PAID") {
    // Money settled but the lifecycle write lost a race / the seam refused it.
    // Say so honestly instead of claiming a paid-and-open consultation.
    return appApiJson({
      ok: true, code: "PAYMENT_SETTLED_STATE_PENDING",
      consultation: await view(fresh),
      paymentStatus: "succeeded",
      commissionToman: charge.commissionToman, lawyerEarningsToman: charge.lawyerEarningsToman,
      paymentId, provider: charge.provider, commissionBps: charge.commissionBps,
      devModeNotice: charge.provider === "devtest" ? paymentDevNotice() : null,
      message: "پرداخت ثبت شد ولی وضعیت مشاوره به‌روزرسانی نشد. لطفاً وضعیت را از فهرست مشاوره‌ها ببینید."
    });
  }

  return appApiJson({
    ok: true,
    consultation: await view(fresh),
    paymentStatus: "succeeded",
    commissionToman: charge.commissionToman,
    lawyerEarningsToman: charge.lawyerEarningsToman,
    paymentId, provider: charge.provider, commissionBps: charge.commissionBps,
    devModeNotice: charge.provider === "devtest" ? paymentDevNotice() : null,
    message: charge.provider === "devtest"
      ? "پرداخت آزمایشی با موفقیت شبیه‌سازی شد (وجه واقعی جابه‌جا نشده است)."
      : "پرداخت با موفقیت انجام شد."
  });
}

/** The honest test-mode label every devtest settlement carries. Never suppressed. */
function paymentDevNotice() {
  return "این سرویس در حالت آزمایشی است: پرداخت‌ها شبیه‌سازی‌اند و پول واقعی دریافت یا واریز نشده است.";
}

// ─────────────────────────── POST /api/v1/payments/history ───────────────────────────
/**
 * Role-aware payment history. Body {token}. Rows capped at 60; TOTALS are
 * separate SQL aggregates over ALL rows (never JS sums, never limited by the cap).
 * client → own payments (payer), gross paid. lawyer → payments of consultations
 * they served + their earnings. admin → everything + platform commission totals.
 * Zero rows ⇒ empty list + zero totals; missing ledger rows stay null, not 0.
 * A legacy bot-only token (no app_accounts row) is treated as 'client' and sees
 * its own payments only — marketplace money it did not pay never appears.
 * Codes: UNAUTHORIZED(401) only (from marketplaceRequireToken).
 */
async function paymentHandleHistory(env, ctx, body) {
  await marketplaceEnsureTables(env);
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const uid = paymentInt(auth.payload.uid, 0);
  const role = auth.account && auth.account.role ? String(auth.account.role) : "client";
  const LIMIT = 60;

  // (list, totals) per role — parameterised, one shape of DTO out.
  let listSql, listArgs, sumSql, sumArgs;
  if (role === "admin") {
    listSql = "SELECT p.id, p.consultation_id, p.amount_toman, p.status, p.provider, p.created_at, p.settled_at, " +
      "s.commission_toman, s.lawyer_earnings_toman, s.commission_bps FROM payments p " +
      "LEFT JOIN payment_splits s ON s.payment_id = p.id ORDER BY p.id DESC LIMIT ?";
    listArgs = [LIMIT];
    sumSql = "SELECT COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN p.amount_toman END), 0) AS gross, " +
      "COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN s.commission_toman END), 0) AS commission, " +
      "COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN s.lawyer_earnings_toman END), 0) AS earnings " +
      "FROM payments p LEFT JOIN payment_splits s ON s.payment_id = p.id";
    sumArgs = [];
  } else if (role === "lawyer") {
    listSql = "SELECT p.id, p.consultation_id, p.amount_toman, p.status, p.provider, p.created_at, p.settled_at, " +
      "s.commission_toman, s.lawyer_earnings_toman, s.commission_bps FROM payments p " +
      "JOIN consultations c ON c.id = p.consultation_id " +
      "LEFT JOIN payment_splits s ON s.payment_id = p.id " +
      "WHERE c.lawyer_user_id = ? ORDER BY p.id DESC LIMIT ?";
    listArgs = [uid, LIMIT];
    sumSql = "SELECT COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN p.amount_toman END), 0) AS gross, " +
      "COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN s.commission_toman END), 0) AS commission, " +
      "COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN s.lawyer_earnings_toman END), 0) AS earnings " +
      "FROM payments p JOIN consultations c ON c.id = p.consultation_id LEFT JOIN payment_splits s ON s.payment_id = p.id " +
      "WHERE c.lawyer_user_id = ?";
    sumArgs = [uid];
  } else {
    listSql = "SELECT p.id, p.consultation_id, p.amount_toman, p.status, p.provider, p.created_at, p.settled_at, " +
      "s.commission_toman, s.lawyer_earnings_toman, s.commission_bps FROM payments p " +
      "LEFT JOIN payment_splits s ON s.payment_id = p.id " +
      "WHERE p.user_id = ? ORDER BY p.id DESC LIMIT ?";
    listArgs = [uid, LIMIT];
    sumSql = "SELECT COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN p.amount_toman END), 0) AS gross, 0 AS commission, 0 AS earnings " +
      "FROM payments p WHERE p.user_id = ?";
    sumArgs = [uid];
  }

  const listed = await env.DB.prepare(listSql).bind(...listArgs).all();
  const totals = await env.DB.prepare(sumSql).bind(...sumArgs).first();
  const gross = paymentInt(totals && totals.gross, 0);
  const commission = paymentInt(totals && totals.commission, 0);
  const earnings = paymentInt(totals && totals.earnings, 0);

  const payload = {
    ok: true,
    transactions: ((listed && listed.results) || []).map(paymentTransactionView),
    grossToman: gross,
    commissionToman: role === "client" ? 0 : commission,   // client: their own spend only
    earningsToman: role === "lawyer" ? earnings : (role === "admin" ? earnings : 0),
    role,
    limit: LIMIT
  };
  if (role === "lawyer") {
    // HONEST V1 GAP: payout_status is not modelled yet (§3 has no payouts table),
    // so every succeeded earning is still awaiting payout. We report the real
    // accrued total instead of inventing a payout ledger.
    payload.pendingPayoutToman = earnings;
    payload.payoutNotice = "واحد پرداخت به وکیل در نسخه فعلی مدل‌سازی نشده است؛ این مبلغ، کل درآمد قطعی‌شده شماست.";
  }
  if (role === "admin") {
    payload.commissionBps = await marketplaceCommissionBps(env);
    payload.devModeNotice = await paymentProviderName(env) === "devtest" ? paymentDevNotice() : null;
  }
  return appApiJson(payload);
}

// ─────────────────────────── POST /api/v1/payments/providers ───────────────────────────
/**
 * Public registry metadata for the admin dashboard: which PSP ids exist and which
 * are test mode. No secrets, no rows — and it can never change a payment.
 */
async function paymentHandleProviders(env) {
  const current = await paymentProviderName(env);
  const providers = Object.keys(PAYMENT_PROVIDERS).sort().map(id => ({
    id, name: PAYMENT_PROVIDERS[id].name, isTestMode: PAYMENT_PROVIDERS[id].isTestMode === true,
    active: id === current
  }));
  return appApiJson({ ok: true, providers, current, devModeNotice: current === "devtest" ? paymentDevNotice() : null });
}

// ─────────────────────────── routes (only top-level side effects) ───────────────────────────
marketplaceRegister("POST /api/v1/consultations/pay", async (env, ctx, body) => {
  try { return await paymentHandlePay(env, ctx, body); }
  catch (e) { console.error("consultations/pay failed:", e && e.message); return appApiErr("INTERNAL", "پرداخت انجام نشد. لطفاً دوباره تلاش کنید.", 500); }
});
marketplaceRegister("POST /api/v1/payments/history", async (env, ctx, body) => {
  try { return await paymentHandleHistory(env, ctx, body); }
  catch (e) { console.error("payments/history failed:", e && e.message); return appApiErr("INTERNAL", "تاریخچه پرداخت در دسترس نیست.", 500); }
});
marketplaceRegister("POST /api/v1/payments/providers", async (env) => {
  try { return await paymentHandleProviders(env); }
  catch (e) { console.error("payments/providers failed:", e && e.message); return appApiErr("INTERNAL", "لیست پرداخت‌کننده‌ها در دسترس نیست.", 500); }
});
