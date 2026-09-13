// Capture the EXACT gateway request the engine sends (fetch spy), and replay it.
process.env.NODE_ENV = "development";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("workers.dev")) {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), dedup_hash: "spy-" + Date.now() + captured.length }) };
  }
  const res = await realFetch(url, init);
  return res;
};

const mod = await import(pathToFileURL(path.join(HERE, "..", "dist", "vakil-app-worker.js")).href);
const worker = mod.default;

const now = Date.now();
const KEYS = [];
for (let i = 0; i < 6; i++) KEYS.push({ key_value: `AIzaSPY${i}${"k".repeat(34)}`, status: "active", usage_count: 0, error_count: 0, last_used: 0, cooldown_until: 0, health_score: 80, consecutive_429: 0, consecutive_failures: 0, last_429_at: 0, last_error_at: 0, ewma_latency_ms: 0, lease_until: 0, lease_id: "" });
const USERS = new Map(); const TOKENS = new Map(); const DEVICES = new Map();
const d1rows = (sql) => {
  if (/FROM gemini_api_keys/.test(sql)) {
    if (/COUNT\(\*\)/.test(sql)) return [{ total: KEYS.length }];
    return KEYS.map((k, i) => ({ id: i + 1, ...k }));
  }
  return [];
};
const env = {
  DB: { prepare(sql) { const stmt = { bind(...v) { stmt._vals = v; return stmt; },
    first: async () => {
      if (/FROM app_tokens t JOIN users/.test(sql)) { const t = TOKENS.get(stmt._vals[0]); return t ? { user_id: String(t.user_id), is_banned: 0 } : null; }
      if (/FROM users WHERE user_id/.test(sql)) { const u = USERS.get(String(stmt._vals[0])); return u ? { user_id: Number(stmt._vals[0]), message_count: u.message_count || 0, last_interaction_date: u.last_interaction_date || "", is_banned: 0, mode: u.mode || "normal", draft_data: u.draft_data || "" } : null; }
      if (/SELECT user_id FROM app_devices/.test(sql)) { const d = DEVICES.get(stmt._vals[0]); return d ? { user_id: d } : null; }
      if (/FROM gemini_api_keys/.test(sql)) return (d1rows(sql) || [])[0] || null;
      return null;
    },
    all: async () => ({ results: d1rows(sql) }),
    run: async () => {
      if (/INSERT OR REPLACE INTO app_tokens/.test(sql)) TOKENS.set(stmt._vals[0], { user_id: stmt._vals[2], device_id: stmt._vals[1] });
      if (/INSERT OR IGNORE INTO app_devices/.test(sql)) DEVICES.set(stmt._vals[0], stmt._vals[1]);
      if (/INSERT INTO users/.test(sql)) { const id = String(stmt._vals[0]); if (!USERS.has(id)) USERS.set(id, { message_count: 0, last_interaction_date: "", mode: "normal", draft_data: "" }); }
      return { success: true, meta: {} };
    } }; return stmt; },
    batch: async (qs) => qs.map(() => ({ success: true, meta: {} })) },
  KV: { _m: new Map(), async get(k, o) { const v = this._m.get(k); if (v === undefined) return null; return o === "json" ? JSON.parse(v) : v; }, async put(k, v) { this._m.set(k, String(v)); }, async delete(k) { this._m.delete(k); } },
  APP_TOKEN_SECRET: "spy-secret", APP_CHANNEL_CODE: "SPYCODE", DAILY_LIMIT: "30",
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_PROXY_URL: "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev",
};
const jf = async (p, b) => { const r = await worker.fetch(new Request("https://vakil-app.local" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), env, { waitUntil() {} }); return await r.json(); };
const v = await jf("/api/v1/auth/verify", { deviceId: "spy-device-1", code: "SPYCODE", platform: "spy" });
console.log("verify:", v.ok ? "ok" : JSON.stringify(v).slice(0, 160));
const c = await jf("/api/v1/chat", { token: v.token, text: "توهین ساده طبق قانون مجازات اسلامی چه مجازاتی دارد؟" });
console.log("chat:", JSON.stringify({ ok: c.ok, code: c.code, chunks: (c.chunks || []).length }).slice(0, 160));

console.log("\n=== CAPTURED", captured.length, "gateway request(s) ===");
const first = captured[0];
if (first) {
  const { key, ...rest } = first.body;
  console.log("URL:", first.url);
  console.log("key tail:", key?.slice(-4), "len", key?.length);
  fs.writeFileSync("C:/Users/Capsizer/AppData/Local/Temp/spy_body.json", JSON.stringify({url:first.url, headers:first.headers, body:first.body},null,1));console.log("body saved, len", JSON.stringify(first.body).length);
}
