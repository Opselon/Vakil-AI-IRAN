#!/usr/bin/env node
/* Local reproduction harness: runs the DEPLOYED app worker file in-process with
   in-memory D1/KV mocks but the REAL gateway (Google egress), so engine logs
   (NODE_ENV=development) are visible. Usage:
     node tools/repro_engine.mjs "متن سوال"            */
process.env.NODE_ENV = "development";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, "..", "dist", "vakil-app-worker.js")).href);
const worker = mod.default;

// ── in-memory D1 (users + gemini_api_keys seeded like production) ──
const now = Date.now();
const KEYS = [];
for (let i = 0; i < 4; i++) KEYS.push({ key_value: `AIzaREPL${i}${"x".repeat(30)}`, status: "active", usage_count: 0, error_count: 0, last_used: 0, cooldown_until: 0, health_score: 80, consecutive_429: 0, consecutive_failures: 0, last_429_at: 0, last_error_at: 0, ewma_latency_ms: 0, lease_until: 0, lease_id: "" });
const USERS = new Map();
const TOKENS = new Map(); // token_hash -> {user_id, device_id}
const DEVICES = new Map();
const d1rows = (sql) => {
  if (/FROM gemini_api_keys/.test(sql)) {
    if (/COUNT\(\*\)/.test(sql)) return [{ total: KEYS.length }];
    return KEYS.map((k, i) => ({ id: i + 1, ...k }));
  }
  return [];
};
const env = {
  DB: {
    prepare(sql) {
      const stmt = {
        sql,
        bind(...v) { stmt._vals = v; return stmt; },
        first: async () => {
          if (/FROM app_tokens t JOIN users/.test(sql)) {
            const t = TOKENS.get(stmt._vals[0]);
            return t ? { user_id: String(t.user_id), is_banned: 0 } : null;
          }
          if (/FROM users WHERE user_id/.test(sql)) { const u = USERS.get(String(stmt._vals[0])); return u ? { user_id: String(stmt._vals[0]), message_count: u.message_count, last_interaction_date: u.last_interaction_date, is_banned: 0, mode: u.mode, draft_data: u.draft_data } : null; }
          if (/SELECT user_id FROM app_devices/.test(sql)) { const d = DEVICES.get(stmt._vals[0]); return d ? { user_id: d } : null; }
          if (/FROM gemini_api_keys/.test(sql)) return (d1rows(sql) || [])[0] || null;
          return null;
        },
        all: async () => ({ results: d1rows(sql) }),
        run: async () => {
          if (/INSERT OR REPLACE INTO app_tokens/.test(sql)) TOKENS.set(stmt._vals[0], { user_id: stmt._vals[2], device_id: stmt._vals[1] });
          if (/INSERT OR IGNORE INTO app_devices/.test(sql)) DEVICES.set(stmt._vals[0], stmt._vals[1]);
          if (/INSERT INTO users/.test(sql)) { const id = String(stmt._vals[0]); if (!USERS.has(id)) USERS.set(id, { message_count: 0, last_interaction_date: "", mode: "normal", draft_data: "" }); }
          if (/UPDATE users SET mode/.test(sql)) { const id = String(stmt._vals.at(-1)); const u = USERS.get(id) || { message_count: 0, last_interaction_date: "", mode: "normal", draft_data: "" }; if (/mode = 'normal', draft_data = ''/.test(sql)) { u.mode = "normal"; u.draft_data = ""; } else { u.mode = stmt._vals[0]; u.draft_data = stmt._vals[1] || ""; } USERS.set(id, u); }
          if (/UPDATE users SET mode = \?, draft_data/.test(sql)) { const id = String(stmt._vals.at(-1)); const u = USERS.get(id) || {}; u.mode = stmt._vals[0]; u.draft_data = stmt._vals[1]; USERS.set(id, u); }
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
    batch: async (qs) => qs.map(() => ({ success: true, meta: {} })),
  },
  KV: {
    _m: new Map(),
    async get(k, o) { const v = this._m.get(k); if (v === undefined) return null; return o === "json" ? JSON.parse(v) : v; },
    async put(k, v) { this._m.set(k, String(v)); },
    async delete(k) { this._m.delete(k); },
  },
  APP_TOKEN_SECRET: "repro-secret",
  APP_CHANNEL_CODE: "REPROCODE",
  DAILY_LIMIT: "30",
  GEMINI_PROXY_URL: "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev",
  GEMINI_MODEL: "gemini-2.5-flash",
  async scheduled() {},
};

const jf = async (p, b, t) => {
  const r = await worker.fetch(new Request("https://vakil-app.local" + p, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: JSON.stringify(b) }), env, { waitUntil() {} });
  return await r.json();
};
const v = await jf("/api/v1/auth/verify", { deviceId: "repro-device-1", code: "REPROCODE", platform: "repro" });
console.log("verify:", v.ok ? "ok" : JSON.stringify(v).slice(0, 200));
const question = process.argv[2] || "توهین ساده طبق قانون مجازات اسلامی چه مجازاتی دارد؟";
const c = await jf("/api/v1/chat", { token: v.token, text: question });
console.log("\n== RESULT ==", JSON.stringify({ ok: c.ok, kind: c.kind, code: c.code, message: c.message, chunks: (c.chunks || []).map(s => String(s).slice(0, 60)) }, null, 1));
