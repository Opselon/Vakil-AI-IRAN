// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — "Continue with Google" for the Vakil AI app: verifies the ID
//             token (credential) the MAUI Authenticator/WebView produced, then
//             provisions or links the marketplace account and issues the same
//             session token as the password endpoints. Also hosts the generic
//             OAuth extension point (/auth/oauth/exchange), which is a clean
//             NOT_CONFIGURED refusal in V1 — the architecture is here, no fake
//             provider success.
// OWNER     — Agent 2 — Google Authentication.
// CONSUMES  — marketplaceRegister/marketplaceEnsureTables/marketplaceNewUserId/
//             marketplaceUserView/marketplaceRateLimit/marketplaceNow
//             (app_module_common.js); appApiJson/appApiErr/
//             appApiIssueToken/appApiQuotaView (app_module_head.js);
//             appApiEnsureTables (app_module_body.js — app_tokens/app_devices);
//             the bot's checkUserLimit (provisions the shared `users` row,
//             reads is_banned); D1 tables app_accounts + users (DDL owned by
//             Agent 3 / app_module_schema.js — this file never DDLs);
//             env.GOOGLE_CLIENT_ID (see GOOGLE CONFIG below); global fetch +
//             AbortController for https://oauth2.googleapis.com/tokeninfo.
// PROVIDES  — POST /api/v1/auth/google          {credential, deviceId?}
//                 → {ok:true, token, user, quota}
//                 → {ok:false, code, message} for CONFIG_PENDING(400) — the exact
//                   code VAKIL_V1_SPEC §2.3 and Pages/AuthPage.xaml.cs key off,
//                   INVALID_CREDENTIAL(401), GOOGLE_UNAVAILABLE(503),
//                   ACCOUNT_BANNED(403), ACCOUNT_SUSPENDED(403),
//                   ACCOUNT_DELETED(403), RATE_LIMITED(429),
//                   DB_UNAVAILABLE(503)
//             POST /api/v1/auth/oauth/exchange  {provider, code, redirectUri}
//                 → {ok:false, code:'NOT_CONFIGURED'} (400) for every provider
//                   in V1; PROVIDER_REQUIRED (400) when provider is blank;
//                   RATE_LIMITED (429) past 20 tries/hour per device+ip.
//             Functions: googleVerifyIdToken (the single swap-in point for
//             JWKS verification), googleEnsureAccount, googleBuildUser,
//             googleIssueSession. `user` is the SAME DTO as Agent 1's
//             endpoints (marketplaceUserView) so one client model covers all.
// INVARIANTS— 1) GOOGLE_CLIENT_ID comes from env ONLY — never hardcoded, never
//                logged, never echoed in a response. Unconfigured Google must
//                answer CONFIG_PENDING and must never throw.
//             2) A token is accepted ONLY when aud === clientId AND iss is
//                https://accounts.google.com | accounts.google.com AND exp is
//                in the future AND sub is present AND email_verified is true
//                (absent email_verified is tolerated when sub exists — see
//                googleClaimsAcceptable). Anything else is INVALID_CREDENTIAL.
//             3) The credential is a bearer token: it is never logged, never
//                stored, never put in any response or error message.
//             4) A brand-new Google-only account is ALWAYS role='client'.
//                This module can never produce a lawyer or admin, and it never
//                touches verification_status (only Agent 4/6 may).
//             5) The UNIQUE lookup key email_norm is occupied ONLY when Google
//                explicitly reported email_verified=true — both when linking
//                onto an existing account and when creating one. An unverified
//                address can therefore never squat a real address and lock its
//                owner out of /auth/signup.
//             6) Every appApiIssueToken call is preceded by checkUserLimit,
//                which guarantees the shared `users` row exists —
//                appApiVerifyToken JOINs app_tokens to users and would reject
//                a token minted for an id that row does not have.
//             7) No import/export, no top-level await, no top-level side
//                effects other than the two marketplaceRegister calls below.
// EXTEND    — Hardening: replace the tokeninfo body of googleVerifyIdToken with
//             JWKS (fetch https://www.googleapis.com/oauth2/v3/certs, cache the
//             keys, verify the RS256 signature + aud/iss/exp/email exactly as
//             googleClaimsAcceptable already does). Keep the {claims}|{err}
//             contract so googleHandleLogin does not change.
//             Real OAuth code exchange (GitHub etc.): add the provider's token
//             endpoint + profile mapping to GOOGLE_OAUTH_PROVIDERS, implement
//             the exchange in googleRunOauthExchange where the NOT_CONFIGURED
//             refusal sits today, and reuse googleEnsureAccount/
//             googleIssueSession for provisioning — add one `*_sub` column via
//             Agent 3's schema part first, never overload google_sub.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ GOOGLE CONFIG ═══ (operator setup — nothing else enables this feature)
//
// 1. Create an OAuth 2.0 *Web* client in Google Cloud Console
//    (APIs & Services → Credentials). Authorised redirect / JS origin per
//    Google's own sign-in docs. For Android also register the APK's package
//    name + SHA-1 of the signing key; the ID token the MAUI Authenticator
//    receives must carry THIS web client id as `aud`, otherwise the worker
//    rejects it with INVALID_CREDENTIAL by design (invariant 2).
// 2. Give the worker that client id — pick ONE:
//       cd server
//       npx wrangler secret put GOOGLE_CLIENT_ID -c wrangler.app.toml
//    or, since a client id is public-by-protocol (not a secret), add it to
//    wrangler.app.toml under [vars]:
//       GOOGLE_CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com"
//    (server/wrangler.app.toml is NOT edited by this module — Agent 9 / the
//    coordinator deploys it.)
// 3. The MAUI side needs the SAME value: Agent 10 feeds it to the
//    WebAuthenticator from Pages/AuthPage.xaml(.cs) and already reads the
//    local override key `vakil.google.client.id` (Preferences) there, with the
//    callback https://vakil.app/.auth/google/callback — next to the API base
//    address in src/VakilAI.Infrastructure/Api/HttpClientFactory.cs. One
//    client id, two consumers: the app asks Google for a token for it, the
//    worker checks the token was issued for it.
// 4. Unconfigured = inert: with no GOOGLE_CLIENT_ID the route answers
//    CONFIG_PENDING (400) and the rest of V1 is unaffected. The client
//    can read that code and hide the Google button.
//
// 5. There is intentionally no Google *client secret* anywhere: this is ID-token
//    verification, not the code-exchange flow. GOOGLE_CLIENT_ID is therefore not
//    a credential and is safe as a plain var; the worker holds no Google secret.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── constants ───────────────────────────

// V1 verification endpoint. tokeninfo is the simplest thing that is REAL: one
// HTTPS GET, Google has already checked its own signature, we check aud/iss/exp
// /email_verified. It costs a round trip and trusts Google's edge, which is
// acceptable for V1; JWKS (verify the RS256 sig locally) is the hardening-phase
// swap-in and lives entirely inside googleVerifyIdToken (see EXTEND above).
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_TOKENINFO_TIMEOUT_MS = 10000;

// Google issues ID tokens with either form; both are ours, nothing else is.
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Upper bound on an ID token we are willing to forward into a GET query string
// (real Google JWTs are ~1–2 KB). Longer ⇒ not a credential, reject locally.
const GOOGLE_CREDENTIAL_MAX = 4096;

// googleHandleLogin / googleRunOauthExchange rate budget (spec §4: cheap and
// visible, not a WAF).
const GOOGLE_LOGIN_LIMIT = 10;          // per hour, per verified Google subject
const GOOGLE_LOGIN_WINDOW_MS = 3600000;
// Pre-verification brake: 10/h on a raw IP would lock a shared Iranian NAT out
// of sign-in at launch, so the *unauthenticated* gate is deliberately looser —
// its only job is to stop one machine grinding Google's endpoint + our D1.
// The per-subject budget above is what actually bounds a single account.
const GOOGLE_IP_LIMIT = 60;
const GOOGLE_EXCHANGE_LIMIT = 20;       // per hour, per device/ip — free work
const GOOGLE_EXCHANGE_WINDOW_MS = 3600000;

// Persian copy. Kept as constants so the strings the client can key off are
// visible in one place.
const GOOGLE_MSG_CONFIG_PENDING =
  "ورود با گوگل هنوز روی سرور پیکربندی نشده است. لطفاً بعداً دوباره تلاش کنید.";
const GOOGLE_MSG_INVALID_CREDENTIAL =
  "توکن گوگل معتبر نیست یا مدت آن به پایان رسیده است. لطفاً دوباره با گوگل وارد شوید.";
const GOOGLE_MSG_UNAVAILABLE =
  "بررسی توکن گوگل فعلاً ممکن نیست. لطفاً چند لحظه دیگر تلاش کنید.";
const GOOGLE_MSG_RATE_LIMITED =
  "تعداد تلاش‌های ورود با گوگل بیش از حد مجاز است. لطفاً یک ساعت دیگر تلاش کنید.";
const GOOGLE_MSG_ACCOUNT_BANNED =
  "🚫 حساب کاربری شما مسدود شده است.";
const GOOGLE_MSG_ACCOUNT_SUSPENDED =
  "حساب کاربری شما موقتاً غیرفعال شده است.";
const GOOGLE_MSG_ACCOUNT_DELETED =
  "حساب کاربری مرتبط با این ایمیل حذف شده است. برای بازگرداندن با پشتیبانی تماس بگیرید.";
const GOOGLE_MSG_DB_UNAVAILABLE =
  "سامانه فعلاً در دسترس نیست. لطفاً چند لحظه دیگر تلاش کنید.";
const GOOGLE_MSG_EXCHANGE_PENDING =
  "ورود با این سرویس در نسخه فعلی برنامه فعال نشده است. فعلاً فقط ورود با گوگل یا ایمیل کار می‌کند.";
const GOOGLE_MSG_PROVIDER_REQUIRED =
  "نام سرویس ورود (provider) مشخص نشده است.";
const GOOGLE_MSG_EXCHANGE_RATE =
  "تعداد درخواست‌های این مسیر بیش از حد مجاز است. لطفاً یک ساعت دیگر تلاش کنید.";

// Provider registry for the OAuth *code exchange* flow (the extension point).
// V1 ships the shape only: every entry stays `enabled:false` and the handler
// refuses before touching the network, so no provider can silently half-work.
// A future entry must also declare the env bindings it reads (`clientIdVar`,
// `clientSecretVar`) and its own `<provider>_sub` column (`subColumn`) — those
// are deliberately NOT read in V1, because there is nothing to misconfigure yet.
// `emailIsVerified` records whether that provider vouches for the address:
// false means the account it provisions must keep email_norm NULL (same rule
// as an unverified Google e-mail — see invariant 5).
const GOOGLE_OAUTH_PROVIDERS = Object.freeze({
  github: Object.freeze({
    slug: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    subColumn: null,                 // needs its own column (Agent 3) first
    emailIsVerified: false,          // GitHub primary email is NOT verified
    enabled: false
  })
  // google stays out of this map on purpose: it uses the ID-token route above.
});

// ─────────────────────────── small private helpers ───────────────────────────

/**
 * Client IP for a rate-limit bucket (never logged, never returned). Cloudflare
 * sets cf-connecting-ip; fall back to the left-most x-forwarded-for hop, then
 * a stable anonymous bucket.
 */
function googleClientIp(request) {
  try {
    const h = request && request.headers;
    if (h && typeof h.get === "function") {
      const direct = h.get("cf-connecting-ip");
      if (direct) return String(direct).slice(0, 64);
      const chain = h.get("x-forwarded-for");
      if (chain) return String(chain).split(",")[0].trim().slice(0, 64);
    }
  } catch (_) { /* header access must never break an auth path */ }
  return "unknown";
}

/**
 * Device id for the issued token. Same header the app already sends
 * (X-Vakil-Device) as a fallback, then a fixed synthetic bucket — appApiIssueToken
 * only stores/slices it, and app_tokens.device_id is not a security property.
 */
function googleDeviceId(body, request) {
  const raw = String((body && body.deviceId) || "").trim();
  if (raw.length >= 6) return raw.slice(0, 64);
  try {
    const hdr = request && request.headers && typeof request.headers.get === "function"
      ? String(request.headers.get("x-vakil-device") || "").trim() : "";
    if (hdr.length >= 6) return hdr.slice(0, 64);
  } catch (_) {}
  return "google-signin";
}

/** Lower-cased, trimmed lookup key for an email ("" when unusable). */
function googleNormEmail(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return v.length > 0 && v.length <= 254 && v.includes("@") ? v : "";
}

/** Display name from Google claims: name → given_name → email prefix. */
function googleDisplayName(claims) {
  const name = String(claims.name || "").trim();
  if (name) return name.slice(0, 40);
  const given = String(claims.given_name || "").trim();
  if (given) return given.slice(0, 40);
  const email = String(claims.email || "").trim();
  if (email && email.includes("@")) return email.split("@")[0].slice(0, 40);
  return "کاربر گوگل";
}

/**
 * True when a Google e-mail may be treated as owned by the caller. Google
 * returns email_verified as a JSON bool OR as the string "true" depending on
 * the endpoint flavour, so accept both explicitly; "absent" is NOT verified
 * here (invariant 5) even though it is enough to *log in* by sub.
 */
function googleEmailVerified(claims) {
  const v = claims.email_verified;
  return v === true || v === "true";
}

/**
 * Decides whether the claims prove a valid Google identity for THIS client.
 * Params: claims (parsed tokeninfo object), clientId (env value).
 * Returns null when acceptable, else a short reason token for the log
 * ('aud'|'iss'|'exp'|'sub'|'email') — never the credential, never the ids.
 */
function googleClaimsAcceptable(claims, clientId) {
  if (!claims || typeof claims !== "object") return "aud";

  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.some(a => String(a) === clientId) : String(aud || "") === clientId;
  if (!audOk) return "aud";

  if (!GOOGLE_ISSUERS.includes(String(claims.iss || ""))) return "iss";

  const exp = parseInt(claims.exp, 10);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return "exp";

  if (!String(claims.sub || "").trim()) return "sub";

  // email_verified true ⇒ fine. ABSENT is tolerated when a subject id exists
  // (some workspace/legacy payloads omit it) — but that path is login-only:
  // googleEnsureAccount never lets it occupy email_norm. An explicit FALSE (or
  // any other value) is a hard reject: the address is not ours to trust.
  const v = claims.email_verified;
  if (v === undefined || v === null) return String(claims.sub).trim() ? null : "email";
  if (v === true || v === "true") return null;
  return "email";
}

// ─────────────────────────── ID-token verification ───────────────────────────

/**
 * Verifies a Google ID token against Google's tokeninfo endpoint.
 * Params: env, credential (the raw ID token from the app).
 * Returns { clientId, claims } on success, or { err: Response } already built
 * with the right code/status — the caller only ever returns the err.
 *
 * Codes: CONFIG_PENDING (400, no clientId configured: the feature is
 * inert, nothing throws), INVALID_CREDENTIAL (401, Google said no / the
 * payload fails our aud/iss/exp/sub checks), GOOGLE_UNAVAILABLE (503, the
 * network call to Google failed or timed out).
 *
 * ⚠ SWAP-IN POINT: replacing tokeninfo with local JWKS + RS256 verification
 * touches this function ONLY — keep the {clientId, claims}|{err} contract.
 */
async function googleVerifyIdToken(env, credential) {
  const clientId = String((env && env.GOOGLE_CLIENT_ID) || "").trim();

  // 1. Configuration gate — first, cheap, and it must not throw (spec §2.3).
  if (!clientId) {
    return { err: appApiErr("CONFIG_PENDING", GOOGLE_MSG_CONFIG_PENDING, 400) };
  }

  const token = String(credential || "").trim();
  if (!token || token.length > GOOGLE_CREDENTIAL_MAX) {
    return { err: appApiErr("INVALID_CREDENTIAL", GOOGLE_MSG_INVALID_CREDENTIAL, 401) };
  }

  // 2. Ask Google. GET + query param is the documented tokeninfo shape; the
  // credential stays out of every log line (invariant 3).
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TOKENINFO_TIMEOUT_MS);
  try {
    response = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    console.error("googleVerifyIdToken network failure:", (e && e.name) || "error");
    return { err: appApiErr("GOOGLE_UNAVAILABLE", GOOGLE_MSG_UNAVAILABLE, 503) };
  }
  clearTimeout(timer);

  // 3. Google answers 400 with {error, error_description} for a bad/expired/
  // wrong-audience token. Either way: the credential is not accepted.
  if (!response || response.status !== 200) {
    return { err: appApiErr("INVALID_CREDENTIAL", GOOGLE_MSG_INVALID_CREDENTIAL, 401) };
  }

  let claims;
  try { claims = await response.json(); }
  catch (e) { return { err: appApiErr("GOOGLE_UNAVAILABLE", GOOGLE_MSG_UNAVAILABLE, 503) }; }

  const reason = googleClaimsAcceptable(claims, clientId);
  if (reason) {
    console.warn("googleVerifyIdToken rejected claims:", reason); // reason token only
    return { err: appApiErr("INVALID_CREDENTIAL", GOOGLE_MSG_INVALID_CREDENTIAL, 401) };
  }

  return { clientId, claims };
}

// ─────────────────────────── account provisioning ───────────────────────────

/**
 * Finds, links or creates the app_accounts row that owns a Google identity.
 * Order (spec §5b of the task): google_sub → email_norm (link) → new account.
 * Params: env, claims (verified Google claims).
 * Returns { account } (fresh row, re-read from DB) or { err: Response }.
 *
 * New accounts are ALWAYS role='client' with password_hash NULL; existing
 * accounts keep their role/status/username (this function never promotes,
 * never demotes, never verifies). Banned (shared `users`.is_banned) and
 * suspended (app_accounts.status) answers are 403.
 *
 * NOTE (honest duplication, flagged to the coordinator): Agent 1 owns the
 * equivalent signup-side provisioning in app_module_auth.js. This helper is
 * deliberately `google`-prefixed and self-contained instead of sharing it, so
 * neither agent has to edit the other's file. The clean-up is one shared
 * `marketplaceCreateAccount(env, fields)` in app_module_common.js.
 */
async function googleEnsureAccount(env, claims) {
  const sub = String(claims.sub).trim();
  const emailRaw = String(claims.email || "").trim();
  const emailNorm = googleNormEmail(emailRaw);
  const emailIsVerified = googleEmailVerified(claims);

  // (a) already linked — the steady state for every return visit.
  const bySub = await env.DB.prepare(
    "SELECT * FROM app_accounts WHERE google_sub = ?"
  ).bind(sub).first();
  if (bySub) return googleAccountGuard(bySub, env);

  // (b) a password account with the same VERIFIED address ⇒ link the Google
  // identity onto it. Unverified addresses are never linked (invariant 5).
  if (emailIsVerified && emailNorm) {
    const byEmail = await env.DB.prepare(
      "SELECT * FROM app_accounts WHERE email_norm = ?"
    ).bind(emailNorm).first();
    if (byEmail) {
      if (byEmail.google_sub && byEmail.google_sub !== sub) {
        // One address already bound to a different Google subject — refuse
        // rather than steal an identity. This is a real conflict, not a race.
        console.warn("googleEnsureAccount: email_norm already bound to another sub");
        return { err: appApiErr("INVALID_CREDENTIAL", GOOGLE_MSG_INVALID_CREDENTIAL, 401) };
      }
      // Ownership resolution (audit HIGH fix — email-squat defence): a signup
      // proves NOTHING about address ownership (no email verification in V1),
      // while Google just vouched for this address. On merge the VERIFIED owner
      // wins the row: the pre-claiming squatter's password_hash is CLEARED (they
      // keep no login path into a mailbox they do not own) and every existing
      // session on the row is REVOKED. Role and lawyer data survive — the row
      // identity stays stable for consultations/payments.
      const update = await env.DB.prepare(
        "UPDATE app_accounts SET google_sub = ?, email = COALESCE(email, ?), display_name = ?, password_hash = NULL WHERE user_id = ? AND google_sub IS NULL"
      ).bind(sub, emailRaw || null, googleDisplayName(claims), byEmail.user_id).run();
      // meta.changes is the honest "did the row actually change" signal in D1.
      const changed = update && update.meta ? Number(update.meta.changes) : 1;
      if (changed === 0) {
        // Lost a race with a concurrent request for the same sub.
        const racer = await env.DB.prepare("SELECT * FROM app_accounts WHERE google_sub = ?").bind(sub).first();
        if (racer) return googleAccountGuard(racer, env);
      }
      try {
        await env.DB.prepare("DELETE FROM app_tokens WHERE user_id = ?").bind(byEmail.user_id).run();
      } catch (e) { console.warn("google merge token revoke failed:", e && e.message); }
      const linked = await env.DB.prepare("SELECT * FROM app_accounts WHERE user_id = ?").bind(byEmail.user_id).first();
      return googleAccountGuard(linked || byEmail, env);
    }
  }

  // (c) brand-new Google-only account.
  const userId = await marketplaceNewUserId(env);
  const now = marketplaceNow();
  try {
    await env.DB.prepare(
      "INSERT INTO app_accounts (user_id, email, email_norm, username, password_hash, google_sub, display_name, role, status, created_at, last_login_at) " +
      "VALUES (?, ?, ?, NULL, NULL, ?, ?, 'client', 'active', ?, NULL)"
    ).bind(
      userId,
      emailRaw || null,                               // shown to the owner
      emailIsVerified ? (emailNorm || null) : null,   // the UNIQUE lookup key is
                                                      // occupied ONLY when Google
                                                      // vouched for the address
                                                      // (invariant 5) — otherwise
                                                      // an unverified Google email
                                                      // could squat a real
                                                      // address and lock its owner
                                                      // out of /auth/signup
      sub,
      googleDisplayName(claims),
      now
    ).run();
  } catch (e) {
    // UNIQUE collision on google_sub/email_norm: someone won the race a moment
    // ago. Re-read their row instead of failing the sign-in.
    if (googleIsUniqueViolation(e)) {
      const winner = await env.DB.prepare("SELECT * FROM app_accounts WHERE google_sub = ?").bind(sub).first();
      if (winner) return googleAccountGuard(winner, env);
    }
    console.error("googleEnsureAccount insert failed:", (e && e.message) || e);
    return { err: appApiErr("DB_UNAVAILABLE", GOOGLE_MSG_DB_UNAVAILABLE, 503) };
  }

  const created = await env.DB.prepare("SELECT * FROM app_accounts WHERE user_id = ?").bind(userId).first();
  if (!created) return { err: appApiErr("DB_UNAVAILABLE", GOOGLE_MSG_DB_UNAVAILABLE, 503) };
  return googleAccountGuard(created, env);
}

/** D1/SQLite unique-constraint errors surface as text — match them loosely. */
function googleIsUniqueViolation(e) {
  const m = String((e && (e.message || e)) || "");
  return /UNIQUE constraint failed|already exists|\bSQLITE_CONSTRAINT\b/i.test(m);
}

/**
 * Status gates for a provisioned account (spec §5 task item 5): suspended or
 * deleted marketplace accounts, and banned shared `users` rows, get a 403 with
 * the same Persian copy the common.js guards use. Returns {account}|{err}.
 */
async function googleAccountGuard(account, env) {
  if (!account || !account.user_id) {
    return { err: appApiErr("DB_UNAVAILABLE", GOOGLE_MSG_DB_UNAVAILABLE, 503) };
  }
  if (account.status === "suspended") {
    return { err: appApiErr("ACCOUNT_SUSPENDED", GOOGLE_MSG_ACCOUNT_SUSPENDED, 403) };
  }
  if (account.status === "deleted") {
    return { err: appApiErr("ACCOUNT_DELETED", GOOGLE_MSG_ACCOUNT_DELETED, 403) };
  }
  try {
    const shared = await env.DB.prepare("SELECT is_banned FROM users WHERE user_id = ?").bind(account.user_id).first();
    if (shared && shared.is_banned) {
      return { err: appApiErr("ACCOUNT_BANNED", GOOGLE_MSG_ACCOUNT_BANNED, 403) };
    }
  } catch (e) {
    // The users row may legitimately not exist yet (checkUserLimit creates it);
    // a failed read must not lock a verified Google identity out of the app.
    console.warn("googleAccountGuard ban lookup skipped:", (e && e.message) || e);
  }
  return { account };
}

// ─────────────────────────── session (same shape as Agent 1) ───────────────────────────

/**
 * Wire `user` DTO for an account row (MarketplaceUser). verificationStatus is
 * lawyer-only and read server-side, exactly like Agent 1's builder; a Google
 * account that was linked onto a lawyer keeps its real status.
 */
async function googleBuildUser(env, account) {
  const extra = {};
  if (account.role === "lawyer") {
    let vs = "pending";
    try {
      const row = await env.DB.prepare(
        "SELECT verification_status FROM lawyer_profiles WHERE user_id = ?"
      ).bind(account.user_id).first();
      if (row && row.verification_status) vs = row.verification_status;
    } catch (e) {
      console.error("googleBuildUser lawyer_profiles read failed:", e && e.message);
    }
    extra.verificationStatus = vs;
  }
  return marketplaceUserView(account, extra);
}

/**
 * Shared success builder: quota (which ALSO provisions the shared `users` row
 * via checkUserLimit) → token (unchanged appApiIssueToken format) → user.
 * Order is load-bearing — see invariant 6.
 */
async function googleIssueSession(env, account, deviceId) {
  const quotaStatus = await checkUserLimit(env, {
    id: account.user_id,
    username: account.username || "",
    first_name: account.display_name
  });
  const quota = appApiQuotaView(quotaStatus, env.DAILY_LIMIT);

  const token = await appApiIssueToken(env, deviceId, account.user_id, account.display_name);
  const user = await googleBuildUser(env, account);

  await env.DB.prepare("UPDATE app_accounts SET last_login_at = ? WHERE user_id = ?")
    .bind(marketplaceNow(), account.user_id).run()
    .catch(e => console.warn("google last_login_at update failed:", e && e.message));

  return appApiJson({ ok: true, token, user, quota });
}

// ─────────────────────────── POST /api/v1/auth/google ───────────────────────────

/**
 * POST /api/v1/auth/google — "Continue with Google".
 * Params (body): credential (Google ID token, required), deviceId? (the app's
 * stable device id; falls back to the X-Vakil-Device header).
 * Flow: rate-limit (ip) → googleVerifyIdToken → rate-limit (sub) →
 *       googleEnsureAccount → googleIssueSession.
 * Success: {ok:true, token, user, quota} — identical shape to /auth/login, so
 * the client's MarketplaceAuthResponse covers every auth path.
 * Errors: CONFIG_PENDING(400) when env.GOOGLE_CLIENT_ID is unset,
 * INVALID_CREDENTIAL(401), GOOGLE_UNAVAILABLE(503), ACCOUNT_SUSPENDED(403),
 * ACCOUNT_BANNED(403), RATE_LIMITED(429), DB_UNAVAILABLE(503).
 * A 4xx/400 status is used for the config/credential cases on purpose: the
 * typed MAUI client throws on >=500 (ENGINE_UNAVAILABLE) and would otherwise
 * never see the code it needs to hide the Google button.
 */
async function googleHandleLogin(env, ctx, body, url, request) {
  try {
    await marketplaceEnsureTables(env);
    await appApiEnsureTables(env); // app_tokens — the session store itself

    // Flood brake BEFORE the paid/external work: a per-ip budget so nobody
    // grinds Google's endpoint (and our D1) for free. Looser than the subject
    // bucket on purpose — see GOOGLE_IP_LIMIT.
    const ip = googleClientIp(request);
    if (!(await marketplaceRateLimit(env, "google:ip:" + ip, GOOGLE_IP_LIMIT, GOOGLE_LOGIN_WINDOW_MS))) {
      return appApiErr("RATE_LIMITED", GOOGLE_MSG_RATE_LIMITED, 429);
    }

    const verified = await googleVerifyIdToken(env, body && body.credential);
    if (verified.err) return verified.err;
    const claims = verified.claims;

    // 10/h per verified subject (the task's stated budget) — applied after
    // verification so the key is a Google-issued id, not attacker-chosen text.
    if (!(await marketplaceRateLimit(env, "google:" + String(claims.sub).trim(), GOOGLE_LOGIN_LIMIT, GOOGLE_LOGIN_WINDOW_MS))) {
      return appApiErr("RATE_LIMITED", GOOGLE_MSG_RATE_LIMITED, 429);
    }

    const ensured = await googleEnsureAccount(env, claims);
    if (ensured.err) return ensured.err;

    return await googleIssueSession(env, ensured.account, googleDeviceId(body, request));
  } catch (e) {
    // Nothing here may leak: the credential, the client id and Google's raw
    // bodies are all deliberately absent from this log line.
    console.error("googleHandleLogin error:", (e && e.message) || e);
    return appApiErr("DB_UNAVAILABLE", GOOGLE_MSG_DB_UNAVAILABLE, 503);
  }
}

// ─────────────────────────── POST /api/v1/auth/oauth/exchange ───────────────────────────

/**
 * POST /api/v1/auth/oauth/exchange — generic OAuth code-exchange entry point
 * (GitHub etc.), V1 = architecture only.
 * Params (body): provider, code, redirectUri. Accepted and validated so the
 * client can already build against the final contract.
 * Error codes: RATE_LIMITED(429), PROVIDER_REQUIRED(400), NOT_CONFIGURED(400),
 * DB_UNAVAILABLE(503 — only if the KV/D1 guard itself explodes).
 * V1 behaviour: PROVIDER_REQUIRED(400) when provider is blank, otherwise
 * NOT_CONFIGURED(400) for EVERY provider — including one a future engineer adds
 * to GOOGLE_OAUTH_PROVIDERS without flipping `enabled` (and, per spec, `code`
 * and `redirectUri` are never logged or forwarded anywhere on this path).
 * Extension: implement the exchange where the refusal sits — read the
 * provider's env bindings, POST the code to its token endpoint, map the
 * profile into {sub, email, emailVerified, name}, then hand off to
 * googleEnsureAccount + googleIssueSession so roles, the users row and the
 * token stay in ONE place.
 */
async function googleRunOauthExchange(env, ctx, body, url, request) {
  try {
    // Cheap flood brake: this route does no paid work today, but it is
    // unauthenticated and will do network work once a provider is enabled.
    const deviceId = googleDeviceId(body, request);
    if (!(await marketplaceRateLimit(env, "oauth:" + deviceId + ":" + googleClientIp(request), GOOGLE_EXCHANGE_LIMIT, GOOGLE_EXCHANGE_WINDOW_MS))) {
      return appApiErr("RATE_LIMITED", GOOGLE_MSG_EXCHANGE_RATE, 429);
    }

    const provider = String((body && body.provider) || "").trim().toLowerCase();
    if (!provider) return appApiErr("PROVIDER_REQUIRED", GOOGLE_MSG_PROVIDER_REQUIRED, 400);

    // Shape validation only — the code is never used, logged or sent out.
    const code = String((body && body.code) || "").trim();
    const redirectUri = String((body && body.redirectUri) || "").trim();
    if (!code || !redirectUri) {
      return appApiErr("NOT_CONFIGURED", GOOGLE_MSG_EXCHANGE_PENDING, 400);
    }

    // Unknown providers get the same answer as unconfigured ones: no oracle for
    // which slugs exist, and one honest code for the client to key off.
    const known = Object.prototype.hasOwnProperty.call(GOOGLE_OAUTH_PROVIDERS, provider);
    if (known && GOOGLE_OAUTH_PROVIDERS[provider].enabled) {
      // V1: unreachable by design. Real provider implementations land here.
      return appApiErr("NOT_CONFIGURED", GOOGLE_MSG_EXCHANGE_PENDING, 400);
    }
    if (!known) console.warn("oauth/exchange: unknown provider requested"); // name not logged
    return appApiErr("NOT_CONFIGURED", GOOGLE_MSG_EXCHANGE_PENDING, 400);
  } catch (e) {
    console.error("googleRunOauthExchange error:", (e && e.message) || e);
    return appApiErr("DB_UNAVAILABLE", GOOGLE_MSG_DB_UNAVAILABLE, 503);
  }
}

// ─────────────────────────── route registration ───────────────────────────
// The only top-level side effects in this file (spec §5). Handler signature is
// (env, ctx, body, url, request) as called by appApiExtensions in common.js.
marketplaceRegister("POST /api/v1/auth/google", googleHandleLogin);
marketplaceRegister("POST /api/v1/auth/oauth/exchange", googleRunOauthExchange);
