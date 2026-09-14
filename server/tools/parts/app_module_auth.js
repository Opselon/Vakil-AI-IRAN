// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Marketplace account authentication: email/username + password
//             signup, login, session introspection (/auth/me) and password
//             set (recovery foundation). Owns the PBKDF2 password store and the
//             client-side validation rules; issues tokens through the EXISTING
//             app_tokens/HMAC path so legacy activation keeps working.
// OWNER     — Agent 1 — Authentication.
// CONSUMES  — marketplaceRegister/marketplaceEnsureTables/marketplaceNewUserId/
//             marketplaceAccount/marketplaceUserView/marketplaceRequireToken/
//             marketplaceRateLimit/marketplaceSlugify/marketplaceNow (common.js),
//             appApiJson/appApiErr/appApiIssueToken/appApiVerifyToken/
//             appApiQuotaView/appApiEnsureTables (head.js + body.js), the bot's
//             checkUserLimit (shared `users` row + quota), env.DB tables
//             app_accounts + lawyer_profiles (DDL: app_module_schema.js),
//             env.APP_TOKEN_SECRET, optional env.AUTH_PEPPER,
//             env.ADMIN_BOOTSTRAP_EMAILS, env.DAILY_LIMIT, crypto.subtle.
// PROVIDES  — POST /api/v1/auth/signup    → {ok, token, user, quota}
//             POST /api/v1/auth/login     → {ok, token, user, quota}
//             POST /api/v1/auth/me        → {ok, user, quota, capabilities}
//             POST /api/v1/auth/password/set → {ok}
//             Functions: authHashPassword, authVerifyPassword (shared with the
//             google/oauth module — same stored format).
//             Codes: EMAIL_INVALID, EMAIL_TAKEN, USERNAME_INVALID,
//             USERNAME_TAKEN, IDENTIFIERS_REQUIRED, PASSWORD_REQUIRED,
//             PASSWORD_WEAK, DISPLAY_NAME_INVALID, INVALID_CREDENTIALS,
//             ACCOUNT_SUSPENDED, RATE_LIMITED, UNAUTHORIZED, ME_FAILED,
//             SERVER_NOT_CONFIGURED, SIGNUP_FAILED, LOGIN_FAILED, DB_UNAVAILABLE.
// INVARIANTS— 1) verification_status is NEVER writable from client input — a
//                lawyer signup only ever creates a 'pending' profile row.
//             2) role is decided server-side: 'lawyer' allowed, 'admin' allowed
//                ONLY for a normalized email listed in ADMIN_BOOTSTRAP_EMAILS
//                (unset = nobody); everything else is forced to 'client'.
//             3) Every issued token is preceded by checkUserLimit() so the
//                shared `users` row exists — appApiVerifyToken JOINs app_tokens
//                to users and would otherwise reject the fresh token.
//             4) Password hashes (pbkdf2$<iter>$<saltB64>$<hashB64>) are never
//                logged, returned or put in any response body.
//             5) Failed login always answers INVALID_CREDENTIALS — the response
//                never reveals whether the identifier or the password was wrong.
//             6) Legacy activation tokens (uid with no app_accounts row) still
//                pass /auth/me as role 'client' + authMethods ['activation'].
// EXTEND    — Register more auth routes with marketplaceRegister("POST
//             /api/v1/auth/<path>", handler) at the bottom of this file and
//             reuse authBuildUser()/authIssueSession() instead of re-implementing
//             the response shape. New validation rule = one function returning
//             `null | {code, message}` so codes stay stable for the MAUI client.
//             Email reset stays a documented stub until a mail provider lands.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── password hashing ───────────────────────────
// PBKDF2-SHA256, 100k iterations, 16-byte random salt, 32-byte key — stored as
// "pbkdf2$<iter>$<saltB64>$<hashB64>" so a future upgrade can re-derive the
// parameters from the string itself instead of a schema migration. AUTH_PEPPER
// (when configured) is concatenated into the PRF input, so a leaked D1 dump is
// still not a crackable credential list.
const AUTH_HASH_SCHEME = "pbkdf2";
const AUTH_PBKDF2_ITERATIONS = 100000;
const AUTH_PBKDF2_SALT_BYTES = 16;
const AUTH_PBKDF2_KEY_BITS = 256;
const AUTH_HASH_SEP = "$";

function authB64FromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function authBytesFromB64(text) {
  const bin = atob(String(text).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** URL-safe random hex (no imports — Workers/Web crypto only). */
function authRandomHex(byteLength) {
  const bytes = new Uint8Array(Math.max(1, byteLength | 0));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derives the stored credential string for a plaintext password.
 * Params: password (string), env (reads optional AUTH_PEPPER).
 * Error codes: throws PASSWORD_HASH_UNAVAILABLE if crypto.subtle is missing.
 */
async function authHashPassword(password, env) {
  const secret = (env && env.AUTH_PEPPER ? String(env.AUTH_PEPPER) : "") + String(password || "");
  if (!globalThis.crypto || !crypto.subtle) throw new Error("PASSWORD_HASH_UNAVAILABLE");
  const salt = new Uint8Array(AUTH_PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: AUTH_PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    AUTH_PBKDF2_KEY_BITS
  );
  const hash = new Uint8Array(bits);
  return [AUTH_HASH_SCHEME, String(AUTH_PBKDF2_ITERATIONS), authB64FromBytes(salt), authB64FromBytes(hash)].join(AUTH_HASH_SEP);
}

/**
 * Constant-time verification of a password against a stored credential string.
 * Params: password, stored ("pbkdf2$<iter>$<saltB64>$<hashB64>" | null).
 * @returns {Promise<boolean>} false for null/malformed/foreign schemes (an
 *          oauth-only row must never be "logged in" with a password).
 */
async function authVerifyPassword(password, stored, env) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split(AUTH_HASH_SEP);
  if (parts.length !== 4 || parts[0] !== AUTH_HASH_SCHEME) return false;
  const iterations = parseInt(parts[1], 10);
  // Bounds on the STORED parameters: this string is server-written, but a
  // partially-imported or hand-edited row must never become a master key.
  // Empty expected-hash segment would make the compare vacuously true — refuse.
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;
  let salt, expected;
  try {
    salt = authBytesFromB64(parts[2]);
    expected = authBytesFromB64(parts[3]);
  } catch { return false; }
  if (!salt || salt.length < 8 || !expected || expected.length < 16) return false;
  const secret = (env && env.AUTH_PEPPER ? String(env.AUTH_PEPPER) : "") + String(password || "");
  let derived;
  try {
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
    derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      baseKey,
      expected.length * 8
    ));
  } catch (e) {
    console.error("authVerifyPassword derive error:", e && e.message);
    return false;
  }
  // Constant-time over the max length so neither value nor length leaks by timing.
  let diff = derived.length ^ expected.length;
  const n = Math.max(derived.length, expected.length);
  for (let i = 0; i < n; i++) diff |= (derived[i] || 0) ^ (expected[i] || 0);
  return diff === 0;
}

// ─────────────────────────── field validation ───────────────────────────
// Each validator returns `null` when the value is acceptable, otherwise
// {code, message} with a Persian, presentable message (spec §4 envelope).
// Code names are part of the client contract — keep them stable.
const AUTH_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const AUTH_USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const AUTH_DEVICE_ID_MIN = 6;   // mirrors DeviceId.MinLength on the client
const AUTH_DEVICE_ID_MAX = 64;  // appApiIssueToken slices to 64 anyway
const AUTH_PASSWORD_MIN = 8;

function authTrim(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max || 200);
}

/** Lowercased e-mail, or "" when absent. Lookup key = stored value (lowercase). */
function authNormalizeEmail(raw) {
  const v = authTrim(raw, 500).toLowerCase();
  return v;
}

/** Lowercased username (the accepted charset is lowercase-only). */
function authNormalizeUsername(raw) {
  return authTrim(raw, 64).toLowerCase();
}

function authErr(code, message) { return { code, message }; }

/** email: optional, but must be well-formed when present. */
function authValidateEmail(email) {
  if (!email) return null;
  if (!AUTH_EMAIL_RE.test(email)) {
    return authErr("EMAIL_INVALID", "قالب ایمیل معتبر نیست. لطفاً نشانی کامل ایمیل را وارد کنید.");
  }
  return null;
}

/** username: optional, [a-z0-9_.] 3-20 when present. */
function authValidateUsername(username) {
  if (!username) return null;
  if (!AUTH_USERNAME_RE.test(username)) {
    return authErr("USERNAME_INVALID", "نام کاربری باید ۳ تا ۲۰ نویسه باشد و فقط شامل حروف کوچک انگلیسی، رقم، نقطه یا زیرخط باشد.");
  }
  return null;
}

/** password: >= 8 chars, at least one letter and one digit (any script letter). */
function authValidatePassword(password) {
  if (!password) return authErr("PASSWORD_REQUIRED", "رمز عبور را وارد کنید.");
  if (password.length < AUTH_PASSWORD_MIN) {
    return authErr("PASSWORD_WEAK", "رمز عبور باید حداقل ۸ نویسه باشد و شامل حداقل یک حرف و یک رقم باشد.");
  }
  if (!/[\p{L}]/u.test(password) || !/[0-9]/.test(password)) {
    return authErr("PASSWORD_WEAK", "رمز عبور باید حداقل ۸ نویسه باشد و شامل حداقل یک حرف و یک رقم باشد.");
  }
  return null;
}

/** displayName: 2-40 visible characters. */
function authValidateDisplayName(displayName) {
  if (displayName.length < 2 || displayName.length > 40) {
    return authErr("DISPLAY_NAME_INVALID", "نام نمایشی باید بین ۲ تا ۴۰ نویسه باشد.");
  }
  return null;
}

/**
 * Device id for the token payload: the client's own id when it is DeviceId-
 * shaped (6–64 chars, per src/VakilAI.Domain/ValueObjects/Identity.cs), else a
 * server-generated fallback so /auth/* never fails just because the caller
 * omitted the field.
 */
function authDeviceId(rawDeviceId) {
  const did = authTrim(rawDeviceId, AUTH_DEVICE_ID_MAX);
  if (did.length >= AUTH_DEVICE_ID_MIN) return did;
  return "acct-" + authRandomHex(16);
}

/** Raw (non-minting) device id for rate buckets — never invents a new bucket. */
function authDeviceIdOf(body) {
  return authTrim(body && body.deviceId, AUTH_DEVICE_ID_MAX) || null;
}

/**
 * Well-formed PBKDF2 string the login path derives against when the identifier
 * matches no account — equal CPU cost, so response time cannot enumerate users.
 * Salt/hash are a real one-off derivation of the literal string
 * "vakil-timing-dummy" (regenerable; its password is public, the row is not).
 */
const AUTH_TIMING_DUMMY_HASH = "pbkdf2$100000$vcbQbe60Je2OcrYQ0h49Tg==$v4tA01Y5FZS1o97W1EmQEIpEGezV/WdhwIg6umhUugE=";

/**
 * Admin bootstrap gate. role='admin' is only honoured for a normalized email
 * listed in env.ADMIN_BOOTSTRAP_EMAILS (comma separated). Unset/empty = nobody,
 * so a fresh deployment can never self-mint an admin.
 */
function authIsBootstrapAdmin(env, emailNorm) {
  const list = authTrim(env && env.ADMIN_BOOTSTRAP_EMAILS, 8000);
  if (!list || !emailNorm) return false;
  return list.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).includes(emailNorm);
}

/**
 * Second-factor gate for admin bootstrap (audit BLOCKER fix): knowing the
 * bootstrap email is not proof of ownership in V1 (no email verification), so
 * when ADMIN_BOOTSTRAP_SECRET is configured, admin signup must ALSO present it
 * (constant-time compare). Unset = legacy email-only mode with a loud warn —
 * operators are told in wrangler.app.toml/DB.md to set the secret before
 * exposing signup publicly.
 */
function authAdminSecretOk(env, body) {
  const secret = env && env.ADMIN_BOOTSTRAP_SECRET ? String(env.ADMIN_BOOTSTRAP_SECRET) : "";
  if (!secret) return true; // email-only mode; caller logs the warning
  const given = String((body && body.bootstrapSecret) || "");
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

function authAdminSecretConfigured(env) {
  return Boolean(env && env.ADMIN_BOOTSTRAP_SECRET);
}

/**
 * Server-side role decision (client input is NEVER trusted, spec §2.2):
 * lawyer → lawyer, admin → admin only when bootstrapped, everything else →
 * client. Client input can never set verification_status.
 */
function authResolveRole(env, requestedRole, emailNorm) {
  const want = authTrim(requestedRole, 16).toLowerCase();
  if (want === "lawyer") return "lawyer";
  if (want === "admin" && authIsBootstrapAdmin(env, emailNorm)) return "admin";
  return "client";
}

// ─────────────────────────── session + response builders ───────────────────────────

/**
 * Guarantees the shared `users` row exists and returns the quota view.
 * checkUserLimit auto-registers unknown ids (the bot's own path) — calling it
 * before appApiIssueToken is what keeps appApiVerifyToken's JOIN to `users`
 * valid for a brand-new marketplace account.
 * Params: env, account row. Returns the appApiQuotaView object.
 */
async function authQuotaForAccount(env, account) {
  const status = await checkUserLimit(env, {
    id: account.user_id,
    username: account.username || "",
    first_name: account.display_name
  });
  return appApiQuotaView(status, env.DAILY_LIMIT);
}

/**
 * Wire `user` DTO (MarketplaceUser) for any account row, adding the lawyer-only
 * verificationStatus read from lawyer_profiles. verificationStatus stays absent
 * (undefined → omitted from JSON) for non-lawyers: the client treats null as
 * "not a lawyer", never as "verified".
 */
async function authBuildUser(env, account) {
  const extra = {};
  if (account.role === "lawyer") {
    let vs = "pending";
    try {
      const row = await env.DB.prepare(
        "SELECT verification_status FROM lawyer_profiles WHERE user_id = ?"
      ).bind(account.user_id).first();
      if (row && row.verification_status) vs = row.verification_status;
    } catch (e) {
      console.error("authBuildUser lawyer_profiles read failed:", e && e.message);
    }
    extra.verificationStatus = vs;
  }
  return marketplaceUserView(account, extra);
}

/**
 * Shared success builder for signup/login: quota (which also provisions the
 * `users` row) → token (existing appApiIssueToken format, unchanged) → user.
 * Order matters: never issue a token before the users row exists.
 */
async function authIssueSession(env, account, deviceId) {
  const quota = await authQuotaForAccount(env, account);
  const token = await appApiIssueToken(env, deviceId, account.user_id, account.display_name);
  const user = await authBuildUser(env, account);
  await env.DB.prepare("UPDATE app_accounts SET last_login_at = ? WHERE user_id = ?")
    .bind(marketplaceNow(), account.user_id).run().catch(e => console.warn("last_login_at update failed:", e && e.message));
  return appApiJson({ ok: true, token, user, quota });
}

// ─────────────────────────── POST /api/v1/auth/signup ───────────────────────────

/**
 * POST /api/v1/auth/signup
 * Params (body): email?, username?, password, displayName, role:'client'|'lawyer',
 *                deviceId?. role='admin' is honoured only via ADMIN_BOOTSTRAP_EMAILS.
 * Success: {ok:true, token, user, quota}. A 'lawyer' signup also creates a
 *          lawyer_profiles row with verification_status='pending' + a slug.
 * Error codes: RATE_LIMITED(429), IDENTIFIERS_REQUIRED, EMAIL_INVALID,
 *              USERNAME_INVALID, PASSWORD_REQUIRED, PASSWORD_WEAK,
 *              DISPLAY_NAME_INVALID, EMAIL_TAKEN, USERNAME_TAKEN,
 *              SERVER_NOT_CONFIGURED(500), DB_UNAVAILABLE(503), SIGNUP_FAILED(500).
 */
async function authRunSignup(env, ctx, body) {
  await marketplaceEnsureTables(env);
  await appApiEnsureTables(env); // app_tokens/app_devices for the legacy verifier

  const email = authNormalizeEmail(body && body.email);
  const username = authNormalizeUsername(body && body.username);
  const deviceId = authDeviceId(body && body.deviceId);

  // 6/hour per TARGET identifier (email/username) — a client-supplied deviceId
  // must not be able to mint a fresh bucket by omission (audit MEDIUM), so the
  // identifier leads the key; device is only a fallback when neither given.
  if (!(await marketplaceRateLimit(env, "auth:signup:" + (email || username || deviceId), 6, 3600000))) {
    return appApiErr("RATE_LIMITED", "تعداد درخواست‌های ثبت‌نام از این دستگاه بیش از حد مجاز است. لطفاً یک ساعت دیگر تلاش کنید.", 429);
  }

  if (!email && !username) {
    return appApiErr("IDENTIFIERS_REQUIRED", "برای ثبت‌نام وارد کردن ایمیل یا نام کاربری الزامی است.");
  }
  const password = String((body && body.password) || "");
  // Deliberately NOT pre-sliced to 40: validation must see the real length so a
  // 60-char name is rejected (DISPLAY_NAME_INVALID) instead of silently clipped.
  const displayName = authTrim(body && body.displayName, 120);

  const problems = [authValidateEmail(email), authValidateUsername(username),
    authValidatePassword(password), authValidateDisplayName(displayName)];
  for (const p of problems) if (p) return appApiErr(p.code, p.message);

  if (!env.APP_TOKEN_SECRET) {
    return appApiErr("SERVER_NOT_CONFIGURED", "سرور هنوز برای صدور نشست پیکربندی نشده است.", 500);
  }

  // Admin bootstrap (audit BLOCKER): email-list match is necessary but NOT
  // sufficient once ADMIN_BOOTSTRAP_SECRET is set — knowing a published admin
  // address must not mint an admin.
  const wantAdmin = authTrim(body && body.role, 16).toLowerCase() === "admin" && !!email && authIsBootstrapAdmin(env, email);
  if (wantAdmin && !authAdminSecretOk(env, body)) {
    return appApiErr("ADMIN_BOOTSTRAP_REQUIRED", "این نشانی برای مدیر سامانه ثبت شده است؛ کلید راه‌اندازی (bootstrap secret) لازم است.", 403);
  }
  if (wantAdmin && !authAdminSecretConfigured(env)) {
    console.warn("ADMIN_BOOTSTRAP: granting admin via email-only mode — set ADMIN_BOOTSTRAP_SECRET for production.");
  }
  const role = wantAdmin ? "admin" : authResolveRole(env, body && body.role, email);

  try {
    // Pre-check the unique keys so the response is a stable code instead of a
    // raw constraint crash; the INSERT below still guards the race.
    if (email) {
      const clash = await env.DB.prepare("SELECT user_id FROM app_accounts WHERE email_norm = ?").bind(email).first();
      if (clash) return appApiErr("EMAIL_TAKEN", "این ایمیل قبلاً ثبت شده است. برای ورود از «ورود» استفاده کنید.");
    }
    if (username) {
      const clash = await env.DB.prepare("SELECT user_id FROM app_accounts WHERE username = ?").bind(username).first();
      if (clash) return appApiErr("USERNAME_TAKEN", "این نام کاربری قبلاً گرفته شده است. یک نام دیگر انتخاب کنید.");
    }

    const userId = await marketplaceNewUserId(env);
    const now = marketplaceNow();
    const passwordHash = await authHashPassword(password, env);

    try {
      await env.DB.prepare(`INSERT INTO app_accounts
        (user_id, email, email_norm, username, password_hash, google_sub, display_name, role, status, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?)`)
        .bind(userId, email || null, email || null, username || null, passwordHash, displayName, role, now, now).run();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/app_accounts\.email_norm/i.test(msg)) return appApiErr("EMAIL_TAKEN", "این ایمیل قبلاً ثبت شده است. برای ورود از «ورود» استفاده کنید.");
      if (/app_accounts\.username/i.test(msg)) return appApiErr("USERNAME_TAKEN", "این نام کاربری قبلاً گرفته شده است. یک نام دیگر انتخاب کنید.");
      throw e;
    }

    // Lawyer application: pending profile ONLY. No verification, no fabricated
    // title/bio/price — the lawyer fills those in /lawyers/save (Agent 4).
    if (role === "lawyer") {
      try {
        // Audit (db): INSERT OR IGNORE + a random slug could be swallowed by a
        // slug collision → a lawyer account with NO profile row (silent strand,
        // /lawyers/me 404s forever). Check meta.changes and retry a fresh slug.
        let profiled = false;
        for (let attempt = 0; attempt < 4 && !profiled; attempt++) {
          const res = await env.DB.prepare(`INSERT OR IGNORE INTO lawyer_profiles
            (user_id, slug, verification_status, created_at, updated_at)
            VALUES (?, ?, 'pending', ?, ?)`)
            .bind(userId, marketplaceSlugify(displayName), now, now).run();
          profiled = !(res && res.meta && Number(res.meta.changes) === 0);
        }
        if (!profiled) {
          console.error("signup lawyer_profiles: slug collision persisted across 4 attempts");
          return appApiErr("SIGNUP_FAILED", "حساب ساخته شد اما پرونده وکیل ثبت نشد. لطفاً دوباره تلاش کنید.", 500);
        }
      } catch (e) {
        // The account exists; a missing profile row would strand the lawyer flow,
        // so roll forward loudly rather than pretending success.
        console.error("signup lawyer_profiles insert failed:", e && (e.message || e));
        return appApiErr("SIGNUP_FAILED", "حساب ساخته شد اما پرونده وکیل ثبت نشد. لطفاً دوباره تلاش کنید.", 500);
      }
    }

    const account = await marketplaceAccount(env, userId) || {
      user_id: userId, email: email || null, username: username || null,
      password_hash: passwordHash, google_sub: null, display_name: displayName,
      role, status: "active", created_at: now, last_login_at: now
    };
    return await authIssueSession(env, account, deviceId);
  } catch (e) {
    console.error("authRunSignup error:", e);
    return appApiErr("DB_UNAVAILABLE", "سامانه فعلاً در دسترس نیست. لطفاً چند لحظه دیگر تلاش کنید.", 503);
  }
}

// ─────────────────────────── POST /api/v1/auth/login ───────────────────────────

/** Finds an account by e-mail (normalized) or username; null when unknown. */
async function authFindAccountByIdentifier(env, identifier) {
  const ident = authTrim(identifier, 254).toLowerCase();
  if (!ident) return null;
  const byEmail = () => env.DB.prepare("SELECT * FROM app_accounts WHERE email_norm = ?").bind(ident).first();
  const byUsername = () => env.DB.prepare("SELECT * FROM app_accounts WHERE username = ?").bind(ident).first();
  try {
    let row = null;
    if (ident.indexOf("@") >= 0) { row = await byEmail(); if (!row) row = await byUsername(); }
    else { row = await byUsername(); if (!row) row = await byEmail(); }
    return row || null;
  } catch (e) {
    console.error("authFindAccountByIdentifier error:", e && e.message);
    return null;
  }
}

/**
 * POST /api/v1/auth/login  {identifier, password, deviceId?}
 * identifier = e-mail OR username. Success: {ok:true, token, user, quota}.
 * Error codes: RATE_LIMITED(429, 8/15min per identifier), PASSWORD_REQUIRED,
 *              INVALID_CREDENTIALS(401 — single generic answer, unknown user and
 *              bad password are indistinguishable), ACCOUNT_SUSPENDED(403),
 *              SERVER_NOT_CONFIGURED(500), LOGIN_FAILED(500).
 */
async function authRunLogin(env, ctx, body, url, request) {
  await marketplaceEnsureTables(env);
  await appApiEnsureTables(env);

  const identifier = authTrim(body && body.identifier, 254).toLowerCase();
  // Dual bucket (audit MEDIUM fix): identifier-only keys let an attacker lock a
  // victim out. The same limit now ALSO applies per client IP, so one device/IP
  // cannot burn everyone's identifier budgets, and hammering one identifier from
  // many IPs stays limited by the identifier bucket itself.
  const ip = (request && request.cf && request.cf.clientIp) || authDeviceIdOf(body);
  if (!(await marketplaceRateLimit(env, "auth:login:" + (identifier || "-"), 8, 900000)) ||
      !(await marketplaceRateLimit(env, "auth:login-ip:" + (ip || "-"), 40, 900000))) {
    return appApiErr("RATE_LIMITED", "تعداد تلاش‌های ورود با این نشانی/نام کاربری بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر دوباره امتحان کنید.", 429);
  }

  const password = String((body && body.password) || "");
  if (!identifier) return appApiErr("INVALID_CREDENTIALS", "ایمیل یا نام کاربری و رمز عبور را وارد کنید.", 401);
  if (!password) return appApiErr("PASSWORD_REQUIRED", "رمز عبور را وارد کنید.");
  if (!env.APP_TOKEN_SECRET) {
    return appApiErr("SERVER_NOT_CONFIGURED", "سرور هنوز برای صدور نشست پیکربندی نشده است.", 500);
  }

  try {
    const account = await authFindAccountByIdentifier(env, identifier);
    // Same answer + same status for "no such user" and "wrong password" (INV-5),
    // AND the same cost: the PBKDF2 derive also runs for unknown users (dummy
    // well-formed hash) so response time does not enumerate accounts.
    const okCred = await authVerifyPassword(password,
      account ? account.password_hash : AUTH_TIMING_DUMMY_HASH, env);
    if (!account || !okCred) {
      return appApiErr("INVALID_CREDENTIALS", "ایمیل/نام کاربری یا رمز عبور اشتباه است.", 401);
    }
    if (account.status === "suspended") {
      return appApiErr("ACCOUNT_SUSPENDED", "حساب کاربری شما موقتاً غیرفعال شده است.", 403);
    }
    if (account.status === "deleted") {
      return appApiErr("INVALID_CREDENTIALS", "ایمیل/نام کاربری یا رمز عبور اشتباه است.", 401);
    }
    return await authIssueSession(env, account, authDeviceId(body && body.deviceId));
  } catch (e) {
    console.error("authRunLogin error:", e);
    return appApiErr("LOGIN_FAILED", "خطای سامانه در ورود. لطفاً دوباره تلاش کنید.", 500);
  }
}

// ─────────────────────────── POST /api/v1/auth/me ───────────────────────────

/**
 * POST /api/v1/auth/me  {token} → {ok, user, quota, capabilities}
 * Also the legacy-activation compatibility seam: a valid token whose uid has no
 * app_accounts row answers ok with role 'client' + authMethods ['activation']
 * (never 404), so /auth/verify sessions keep working in the new app shell.
 * Error codes: RATE_LIMITED(429), UNAUTHORIZED(401), ME_FAILED(500).
 */
async function authRunMe(env, ctx, body) {
  await marketplaceEnsureTables(env);
  await appApiEnsureTables(env); // app_tokens must exist before the verifier reads it
  // Guard first (token HMAC + app_tokens JOIN users + ban/suspend), then a
  // generous per-session brake: /auth/me is a read the app shell calls on boot.
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const payload = auth.payload;
  if (!(await marketplaceRateLimit(env, "auth:me:" + payload.uid, 120, 60000))) {
    return appApiErr("RATE_LIMITED", "درخواست‌های وضعیت حساب بیش از حد مجاز است. کمی دیگر تلاش کنید.", 429);
  }

  try {
    const account = auth.account;

    if (!account) {
      // Legacy activation-only session: synthesize the minimal account shape so
      // marketplaceUserView reports authMethods ['activation'] (spec §1 existing auth).
      const legacy = {
        user_id: payload.uid,
        display_name: payload.name || "App User",
        role: "client",
        email: null,
        username: null,
        password_hash: null,
        google_sub: null
      };
      const quota = appApiQuotaView(await checkUserLimit(env, {
        id: legacy.user_id, username: "", first_name: legacy.display_name
      }), env.DAILY_LIMIT);
      return appApiJson({
        ok: true,
        user: marketplaceUserView(legacy),
        quota,
        capabilities: { marketplace: true, lawyerOffice: false, admin: false }
      });
    }

    if (account.status === "suspended") {
      return appApiErr("ACCOUNT_SUSPENDED", "حساب کاربری شما موقتاً غیرفعال شده است.", 403);
    }

    const quota = await authQuotaForAccount(env, account);
    const user = await authBuildUser(env, account);
    return appApiJson({
      ok: true,
      user,
      quota,
      capabilities: {
        marketplace: true,
        lawyerOffice: user.role === "lawyer",
        admin: user.role === "admin"
      }
    });
  } catch (e) {
    console.error("authRunMe error:", e);
    return appApiErr("ME_FAILED", "خطای سامانه در خواندن وضعیت حساب. لطفاً چند لحظه دیگر تلاش کنید.", 500);
  }
}

// ─────────────────────────── POST /api/v1/auth/password/set ───────────────────────────

/**
 * POST /api/v1/auth/password/set  {token, newPassword} → {ok:true}
 * Recovery foundation: an authenticated account (or a legacy activation session,
 * which gains its first app_accounts row here) re-sets its own password.
 * E-mail reset is NOT implemented — see MARKETPLACE_INTEGRATION_REQUESTS.md.
 * Error codes: RATE_LIMITED(429, 5/hour per user), UNAUTHORIZED(401),
 *              PASSWORD_REQUIRED, PASSWORD_WEAK, DB_UNAVAILABLE(503).
 */
async function authRunPasswordSet(env, ctx, body) {
  await marketplaceEnsureTables(env);
  await appApiEnsureTables(env); // the guard reads app_tokens

  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const userId = auth.payload.uid;

  if (!(await marketplaceRateLimit(env, "auth:pwset:" + userId, 5, 3600000))) {
    return appApiErr("RATE_LIMITED", "تعداد تلاش برای تغییر رمز بیش از حد مجاز است. لطفاً یک ساعت دیگر تلاش کنید.", 429);
  }

  const password = String((body && body.newPassword) || "");
  const bad = authValidatePassword(password);
  if (bad) return appApiErr(bad.code, bad.message);

  try {
    const passwordHash = await authHashPassword(password, env);
    if (auth.account) {
      await env.DB.prepare("UPDATE app_accounts SET password_hash = ? WHERE user_id = ?")
        .bind(passwordHash, userId).run();
    } else {
      // Legacy activation user opting into a password: adopt the id they already
      // hold (it is already a `users` row) and give them a client account. Never
      // touches verification_status; the row is created 'pending'-free (client).
      const adopt = await env.DB.prepare(`INSERT OR IGNORE INTO app_accounts
        (user_id, email, email_norm, username, password_hash, google_sub, display_name, role, status, created_at, last_login_at)
        VALUES (?, NULL, NULL, NULL, ?, NULL, ?, 'client', 'active', ?, ?)`)
        .bind(userId, passwordHash, (auth.payload && auth.payload.name) || "App User", marketplaceNow(), marketplaceNow()).run();
      // Audit (db): if INSERT was ignored (a row appeared between the guard read
      // and now — transient marketplaceAccount failure masking), set the hash on
      // the EXISTING row instead of answering ok with nothing written.
      if (adopt && adopt.meta && Number(adopt.meta.changes) === 0) {
        await env.DB.prepare("UPDATE app_accounts SET password_hash = ? WHERE user_id = ? AND password_hash IS NULL")
          .bind(passwordHash, userId).run();
      }
    }
    // Rotation hygiene (audit HIGH — no revocation existed anywhere): every
    // OTHER session on this account is invalidated; the caller's own token
    // survives so they are not kicked out by their own password change.
    try {
      const me = await appApiSha256Hex(String((body && body.token) || ""));
      await env.DB.prepare("DELETE FROM app_tokens WHERE user_id = ? AND token_hash <> ?")
        .bind(userId, me).run();
    } catch (e) { console.warn("password/set revocation failed:", e && e.message); }
    return appApiJson({ ok: true, message: "رمز عبور تازه ثبت شد و نشست‌های دیگر این حساب باطل شدند." });
  } catch (e) {
    console.error("authRunPasswordSet error:", e);
    return appApiErr("DB_UNAVAILABLE", "سامانه فعلاً در دسترس نیست. لطفاً چند لحظه دیگر تلاش کنید.", 503);
  }
}

/**
 * POST /api/v1/auth/logout  {token} → {ok:true}
 * Server-side session invalidation (audit: sign-out was client-only; the 60-day
 * bearer stayed spendable). Deletes ONLY the caller's token row — other devices
 * keep their sessions until they expire or are revoked by password rotation.
 * Idempotent: an already-dead token still answers ok (client clears locally).
 */
async function authRunLogout(env, ctx, body) {
  await marketplaceEnsureTables(env);
  await appApiEnsureTables(env);
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err && auth.err.status !== 401) return auth.err; // 401 → still answer ok below
  try {
    if (!auth.err) {
      const hash = await appApiSha256Hex(String((body && body.token) || ""));
      await env.DB.prepare("DELETE FROM app_tokens WHERE token_hash = ?").bind(hash).run();
    }
    return appApiJson({ ok: true, message: "جلسه شما باطل شد." });
  } catch (e) {
    console.error("authRunLogout error:", e && e.message);
    return appApiErr("DB_UNAVAILABLE", "خروج کامل انجام نشد؛ حساب محلی پاک شد.", 503);
  }
}

// ─────────────────────────── route registration ───────────────────────────
// The only top-level side effects in this file (spec §5). Handler signature is
// (env, ctx, body, url, request) as called by appApiExtensions in common.js.
marketplaceRegister("POST /api/v1/auth/signup", authRunSignup);
marketplaceRegister("POST /api/v1/auth/login", authRunLogin);
marketplaceRegister("POST /api/v1/auth/me", authRunMe);
marketplaceRegister("POST /api/v1/auth/password/set", authRunPasswordSet);
marketplaceRegister("POST /api/v1/auth/logout", authRunLogout);

