// ============================================================================
// VAKIL AI — Application API module (single-file, appended after the bot)
// ----------------------------------------------------------------------------
// This section implements /api/v1 for the cross-platform Vakil app. It REUSES
// the bot's own globals defined above in this same file (zero duplication of
// prompts/keys logic):
//   • SYSTEM_PROMPT, buildGeminiPayload, processWithGemini  — main legal engine
//   • gemini_api_keys (D1) via getActiveGeminiKey           — cluster API keys
//   • checkUserLimit / incrementUsage / chat_history        — quota + memory
//   • validateInputContent / checkImageLimit                — content gates
//   • splitByParagraphs / isolatedTelegramHtmlParser        — render helpers
//   • APP_* prompt/page functions (auto-extracted verbatim) — exact UX parity
// ============================================================================

/* eslint-disable no-undef */

const APP_API_PREFIX = "/api/v1";

function appApiJson(data, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vakil-Client, X-Vakil-Device",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  };
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers });
}

function appApiErr(code, message, status = 400) {
  return appApiJson({ ok: false, code, message }, status);
}

async function appApiSha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function appApiB64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function appApiB64UrlDecode(b64) {
  const bin = atob(String(b64).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function appApiDecodeToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return null;
    const payload = JSON.parse(appApiB64UrlDecode(parts[0]));
    return { payload, sig: parts[1] };
  } catch { return null; }
}

async function appApiVerifyToken(env, token) {
  const dec = appApiDecodeToken(token);
  if (!dec) return null;
  const secret = env.APP_TOKEN_SECRET;
  if (!secret) return null;
  const expected = (await appApiSha256Hex(JSON.stringify(dec.payload) + "|" + secret)).slice(0, 32);
  if (dec.sig !== expected) return null;
  if (!dec.payload.exp || Date.now() > dec.payload.exp) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT t.user_id, u.is_banned FROM app_tokens t JOIN users u ON u.user_id = t.user_id WHERE t.token_hash = ?"
    ).bind(await appApiSha256Hex(token)).first();
    if (!row || row.is_banned) return null;
    return dec.payload;
  } catch (e) {
    console.error("appApiVerifyToken DB error:", e);
    return null;
  }
}

async function appApiIssueToken(env, deviceId, userId, name) {
  const payload = {
    v: 1,
    did: String(deviceId).slice(0, 64),
    uid: userId,
    name: String(name || "").slice(0, 40),
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 60
  };
  const secret = env.APP_TOKEN_SECRET;
  const sig = (await appApiSha256Hex(JSON.stringify(payload) + "|" + secret)).slice(0, 32);
  const token = appApiB64UrlEncode(JSON.stringify(payload)) + "." + sig;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO app_tokens (token_hash, device_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(await appApiSha256Hex(token), payload.did, userId, payload.iat, payload.exp).run();
  return token;
}

function appApiUserFromPayload(payload) {
  return { id: payload.uid, username: "", first_name: payload.name || "App User" };
}

function appApiQuotaView(status, limit) {
  const l = Number(limit) || 3;
  return {
    allowed: Boolean(status.allowed),
    remaining: status.remaining ?? null,
    dailyLimit: l,
    resetHint: "اعتبار شما هر شب راس ساعت ۰۰:۰۰ به وقت ایران شارژ می‌شود."
  };
}

//__GENERATED_PROMPTS__

//__API_BODY__
