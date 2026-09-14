// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Shared foundation for the Vakil AI marketplace modules (auth,
//             lawyer directory, consultations, payments, admin). Provides the
//             route registry the modules register into, the dispatcher the main
//             /api/v1 router delegates to, id helpers, account lookup, guards,
//             rate limiting and platform-config access. Everything feature-
//             specific lives in the sibling app_module_*.js parts.
// OWNER     — COORDINATOR ONLY (marketplace agents must not edit this file).
// CONSUMES  — appApiJson/appApiErr (app_module_head.js), appApiVerifyToken +
//             appApiIssueToken + appApiUserFromPayload (same), env.DB (D1
//             ailawyer), env.KV (GeminiKV, optional — falls back to in-memory),
//             env.APP_TOKEN_SECRET, the `users` table (quota/ban state owned by
//             the Telegram bot — this module NEVER redefines it), app_accounts
//             + platform_config (created by app_module_schema.js).
// PROVIDES  — appApiExtensions(request, env, ctx, body, url)  [dispatcher]
//             marketplaceRegister(routeKey, handler)          [route hook]
//             marketplaceRegisterSchema(fn)                   [schema hook]
//             marketplaceEnsureTables(env)                    [idempotent DDL gate]
//             marketplaceNewId(), marketplaceNewUserId(env), marketplaceNow()
//             marketplaceAccount(env, userId)                 [app_accounts row]
//             marketplaceUserView(row, extra)                 [wire `user` DTO]
//             marketplaceRequireToken(env, body)              [{payload,err}]
//             marketplaceRequireRole(env, body, ...roles)     [{payload,account,err}]
//             marketplaceRequireAdmin(env, body)              alias of the above
//             marketplaceRateLimit(env, bucket, limit, windowMs) → boolean
//             marketplaceConfigGet(env, key, fallback), marketplaceConfigSet
//             marketplaceCommissionBps(env)                   [int basis points]
//             marketplaceJsonArray(text)                      [JSON col → []]
//             marketplaceSlugify(name)                        [ascii slug]
// INVARIANTS— 1) A handler returns an appApiJson Response or null (unknown
//                route). 2) role/verification_status are NEVER writable from
//                client input — only the admin decision endpoint changes them.
//             3) Tokens keep the existing app_tokens/HMAC format: issuing one
//                ALWAYS follows checkUserLimit (which guarantees the shared
//                `users` row exists — the token→users JOIN would otherwise
//                invalidate it). 4) No top-level await/import/export anywhere.
// EXTEND    — New marketplace part: create
//             server/tools/parts/app_module_<domain>.js, add its filename to
//             MARKETPLACE_PARTS in build_app_worker.cjs (dependency order!),
//             register routes at the bottom via marketplaceRegister, and reuse
//             the guards here instead of re-checking auth by hand.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── route registry ───────────────────────────
// Keys are "METHOD /api/v1/path". Handlers are async (env, ctx, body, url, request) → Response.
const MARKETPLACE_ROUTES = Object.create(null);

/** Registers one route key. Safe to call at top level; later registration wins. */
function marketplaceRegister(routeKey, handler) {
  MARKETPLACE_ROUTES[routeKey] = handler;
}

/**
 * Dispatcher invoked from the main app-module router (app_module_body.js) for
 * every POST under /api/v1 that the classic router did not match. Returns the
 * handler's Response, or null when nothing owns the path (→ router 404s).
 *
 * Honours platform_config v1_enabled as the documented MARKETPLACE kill-switch
 * (audit DB: the config key used to be decorative). Legacy chat routes are NOT
 * affected — this gate wraps only marketplace handlers. Cached per isolate for
 * 60s so turning it off is fast without a config read per request.
 */
// globalThis (not module scope) so white-box harnesses can bust the cache the
// same way they reset __appApiTablesOk — the flag itself is operator-owned data.
globalThis.__marketplaceKillCached = null; // { off: boolean, at: number }
async function appApiExtensions(request, env, ctx, body, url) {
  const handler = MARKETPLACE_ROUTES[`${request.method} ${url.pathname}`];
  if (!handler) return null;
  try {
    const kc = globalThis.__marketplaceKillCached;
    if (!kc || Date.now() - kc.at > 60000) {
      const v = String(await marketplaceConfigGet(env, "v1_enabled", "1")).trim().toLowerCase();
      globalThis.__marketplaceKillCached = { off: !(v === "1" || v === "true" || v === "on" || v === "yes"), at: Date.now() };
    }
    if (globalThis.__marketplaceKillCached.off) {
      return appApiErr("SERVICE_DISABLED", "بخش بازار وکلا موقتاً غیرفعال است. گفتگوی هوشمند همچنان کار می‌کند.", 503);
    }
  } catch (e) { /* config read failure must not block handlers */ }
  return await handler(env, ctx, body, url, request);
}

// ─────────────────────────── schema hook ───────────────────────────
// The DDL itself lives in app_module_schema.js (Agent 3); this gate makes it
// idempotent-per-isolate and a clear error when the module is absent.
let MARKETPLACE_SCHEMA_IMPL = null;
let MARKETPLACE_SCHEMA_READY = false;

/** Called once per isolate by app_module_schema.js with its create-tables fn. */
function marketplaceRegisterSchema(fn) { MARKETPLACE_SCHEMA_IMPL = fn; MARKETPLACE_SCHEMA_READY = false; }

/** Ensures marketplace tables exist before any handler touches them. */
async function marketplaceEnsureTables(env) {
  if (MARKETPLACE_SCHEMA_READY) return;
  if (typeof MARKETPLACE_SCHEMA_IMPL !== "function") {
    throw new Error("MARKETPLACE_SCHEMA_MISSING: app_module_schema.js not deployed");
  }
  await MARKETPLACE_SCHEMA_IMPL(env);
  MARKETPLACE_SCHEMA_READY = true;
}

// ─────────────────────────── identity helpers ───────────────────────────
const MARKETPLACE_USER_ID_BASE = 9200000000000; // app-email accounts; distinct
// from the legacy synthetic activation range (9.000e12–9.001e12) and from real
// Telegram ids (< ~9e9). Collision-checked against `users` before use.
let __marketplaceIdCounter = 0;

/**
 * Row id: ms epoch * 1000 + (per-isolate random base + rolling counter) % 1000.
 *
 * Audit fix (M1): the previous counter restarted at 0 in EVERY isolate, so two
 * Workers minting an id in the same millisecond collided (PK failures → lost
 * messages/rows). A random per-isolate start makes that need a same-ms request
 * pair AND the same 1-in-1000 base, while within an isolate the counter still
 * advances so id ordering (afterId cursors) stays monotonic. The *1000 space is
 * DELIBERATE: Date.now()*1000000 would exceed 2^53 and lose integer precision
 * in JS number binds — never widen this multiplier.
 */
let __marketplaceIdBase = 0;
function marketplaceIdBase() {
  if (!__marketplaceIdBase) {
    const a = new Uint8Array(2);
    crypto.getRandomValues(a);
    __marketplaceIdBase = ((a[0] << 8) | a[1]) % 1000;
  }
  return __marketplaceIdBase;
}
function marketplaceNewId() {
  return Date.now() * 1000 + ((marketplaceIdBase() + __marketplaceIdCounter++) % 1000);
}

function marketplaceNow() { return Date.now(); }

/** Fresh app-account user id, probed against the shared users + app_accounts tables. */
async function marketplaceNewUserId(env) {
  for (let g = 0; g < 8; g++) {
    const candidate = MARKETPLACE_USER_ID_BASE + Math.floor(Math.random() * 999999999);
    const clash = await env.DB.prepare(
      "SELECT user_id FROM users WHERE user_id = ? OR user_id IN (SELECT user_id FROM app_accounts WHERE user_id = ?) LIMIT 1"
    ).bind(candidate, candidate).first();
    if (!clash) return candidate;
  }
  throw new Error("USER_ID_EXHAUSTED");
}

/** Reads the marketplace account row for a token user id (null for bot-only users). */
async function marketplaceAccount(env, userId) {
  try {
    return await env.DB.prepare("SELECT * FROM app_accounts WHERE user_id = ?").bind(userId).first();
  } catch (e) {
    console.error("marketplaceAccount error:", e);
    return null;
  }
}

/** Canonical wire `user` object (camelCase) shared by all auth endpoints. */
function marketplaceUserView(account, extra) {
  const base = {
    userId: account.user_id,
    displayName: account.display_name || "",
    role: account.role || "client",
    email: account.email || null,
    username: account.username || null,
    authMethods: marketplaceAuthMethodsOf(account)
  };
  return Object.assign(base, extra || {});
}

function marketplaceAuthMethodsOf(account) {
  const list = [];
  if (account.password_hash) list.push("password");
  if (account.google_sub) list.push("google");
  if (Number(account.user_id) < MARKETPLACE_USER_ID_BASE) list.push("activation");
  return list;
}

// ─────────────────────────── auth guards ───────────────────────────
/**
 * Verifies the bearer token (existing HMAC + app_tokens + ban check) and loads
 * the marketplace account. Returns {payload, account} or {err: Response(401)}.
 * Legacy activation-only users (no app_accounts row) pass through with
 * account=null so the AI chat keeps working for them.
 */
async function marketplaceRequireToken(env, body) {
  const payload = await appApiVerifyToken(env, body && body.token);
  if (!payload) return { err: appApiErr("UNAUTHORIZED", "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.", 401) };
  const account = await marketplaceAccount(env, payload.uid);
  if (account && account.status === "suspended")
    return { err: appApiErr("ACCOUNT_SUSPENDED", "حساب کاربری شما موقتاً غیرفعال شده است.", 403) };
  if (account && account.status === "deleted")
    return { err: appApiErr("ACCOUNT_DELETED", "این حساب حذف شده است.", 403) };
  return { payload, account };
}

/** As marketplaceRequireToken, but the account must exist AND carry one of `roles`. */
async function marketplaceRequireRole(env, body) {
  const roles = Array.prototype.slice.call(arguments, 2);
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth;
  if (!auth.account || !roles.includes(auth.account.role))
    return { err: appApiErr("FORBIDDEN", "دسترسی به این بخش مجاز نیست.", 403) };
  return auth;
}

function marketplaceRequireAdmin(env, body) { return marketplaceRequireRole(env, body, "admin"); }

// ─────────────────────────── rate limiting ───────────────────────────
// Best-effort fixed-window counters in KV (per isolate memory when KV is down).
// Good enough for V1 signup/login flooding; not a WAF.
const __marketplaceLocalBuckets = Object.create(null);

/**
 * Increments bucket and reports whether the action is allowed.
 * @returns {Promise<boolean>} true = under limit.
 */
async function marketplaceRateLimit(env, bucket, limit, windowMs) {
  const window = Math.max(1, Math.floor(windowMs / 1000));
  const key = "rl:" + bucket + ":" + Math.floor(Date.now() / (window * 1000));
  try {
    if (env.KV) {
      const prev = parseInt(await env.KV.get(key), 10) || 0;
      if (prev >= limit) return false;
      await env.KV.put(key, String(prev + 1), { expirationTtl: window + 5 });
      return true;
    }
  } catch (e) { console.warn("rate limit KV error, falling back:", e && e.message); }
  const prev = __marketplaceLocalBuckets[key] || 0;
  if (prev >= limit) return false;
  __marketplaceLocalBuckets[key] = prev + 1;
  return true;
}

// ─────────────────────────── platform config ───────────────────────────
async function marketplaceConfigGet(env, key, fallback) {
  try {
    const row = await env.DB.prepare("SELECT value FROM platform_config WHERE key = ?").bind(key).first();
    return row && row.value != null ? row.value : fallback;
  } catch (e) { return fallback; }
}

async function marketplaceConfigSet(env, key, value, actorUserId) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO platform_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)"
  ).bind(key, String(value), marketplaceNow(), actorUserId || null).run();
}

/** Commission rate actually applied to payments, in basis points (e.g. 2000 = 20%). */
async function marketplaceCommissionBps(env) {
  const raw = parseInt(await marketplaceConfigGet(env, "commission_bps", "2000"), 10);
  if (!Number.isFinite(raw) || raw < 0) return 2000;
  return Math.min(raw, 10000);
}

// ─────────────────────────── small utilities ───────────────────────────
/** Parses a JSON-array column value defensively (null/garbage → []). */
function marketplaceJsonArray(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** URL-safe ascii slug with a Persian→latin fallback and numeric tail. */
function marketplaceSlugify(name) {
  const faMap = { "آ": "a", "ا": "e", "ب": "b", "پ": "p", "ت": "t", "ث": "s", "ج": "j", "چ": "ch", "ح": "h", "خ": "kh", "د": "d", "ذ": "z", "ر": "r", "ز": "z", "ژ": "zh", "س": "s", "ش": "sh", "ص": "sa", "ض": "za", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "ghh", "ک": "k", "گ": "g", "ل": "l", "م": "m", "ن": "n", "و": "v", "ه": "h", "ی": "y" };
  let out = String(name || "").toLowerCase();
  out = out.split("").map(c => (/[a-z0-9]/.test(c) ? c : (faMap[c] || (/[؀-ۿ]/.test(c) ? "" : "-")))).join("");
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!out) out = "vakil";
  return out + "-" + Math.floor(Math.random() * 46656).toString(36); // yyyyz6 tail
}

/** Splits "first last" defensively (both may be empty; never throws). */
function marketplaceSplitName(displayName) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "کاربر", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
