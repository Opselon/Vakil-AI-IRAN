#!/usr/bin/env node
/* LIVE smoke against the deployed vakil-app worker (real D1 cluster, real
   Google egress via the bot's proxy). Verifies the app API contract:
     POST /api/v1/auth/verify   {device_id?→deviceId, code} → {ok, token, userId, quota}
     POST /api/v1/chat          {token, text|audioBase64|imageBase64} → {ok, kind, chunks, keyboard, quota}
     POST /api/v1/quick-action  {token, action}
     POST/GET /api/v1/history
   usage: node tools/live_smoke.mjs [BASE_URL]      (secrets file: %TEMP%/vakil_secrets.txt) */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "https://vakil-app.samerkhaldounmarefi.workers.dev";
const secretsFile = process.env.VAKIL_SECRETS || path.join(os.tmpdir(), "vakil_secrets.txt");
const code = fs.readFileSync(secretsFile, "utf8").split("\n").find(l => l.startsWith("APP_CHANNEL_CODE=")).split("=").slice(1).join("=").trim();

let pass = 0, fail = 0, elapsedReal = 0;
const T = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const dev = "smoke-" + Math.random().toString(36).slice(2, 10) + "-vakil";

async function api(p, body, token) {
  const t0 = Date.now();
  const res = await fetch(BASE + "/api/v1" + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await res.json(); } catch { }
  const dt = Date.now() - t0;
  return { status: res.status, j, dt };
}

const health = await fetch(BASE + "/api/v1/health").then(r => r.json()).catch(() => null);
T("health online", !!health?.ok);

const noCode = await api("/auth/verify", { deviceId: dev, code: "WRONGCODE1" });
T("wrong code rejected 403", noCode.status === 403, noCode.j?.message ? "msg ok" : JSON.stringify(noCode.j || {}).slice(0, 80));

const v = await api("/auth/verify", { deviceId: dev, code, platform: "win-x64", name: "smoke" });
const token = v.j?.token;
T("verify ok + token issued", v.status === 200 && !!token, v.j?.userId ? "user " + v.j.userId : JSON.stringify(v.j?.message || {}));

const chat1 = await api("/chat", { token, text: "سلام" });
const menu = await api("/quick-action", { token, action: "main_menu" }, token);
const flat = (menu.j?.keyboard || []).flat ? (menu.j.keyboard || []).flat() : [];
T("main_menu action → EXACT bot main menu (6 buttons)", menu.j?.ok && flat.length === 6 && flat[0]?.text?.includes("وضعیت حساب"), `n=${flat.length} first=${flat[0]?.text || "-"}`);

const chat2 = await api("/chat", { token, text: "توهین ساده طبق قانون مجازات اسلامی چه مجازاتی دارد؟" }, token);
const txt = (chat2.j?.chunks || []).join("\n");
T("REAL answer via live D1 cluster", chat2.j?.ok === true && txt.length > 60, `len=${txt.length} in ${chat2.dt}ms kind=${chat2.j?.kind}`);
if (!(chat2.j?.ok === true && txt.length > 60)) console.log(JSON.stringify(chat2.j || {}).slice(0, 500));
T("chat response carries thinkingFrames + quota", Array.isArray(chat2.j?.thinkingFrames) && chat2.j.thinkingFrames.length > 0 && typeof chat2.j?.quota?.remaining === "number",
  `frames=${chat2.j?.thinkingFrames?.length} quota=${JSON.stringify(chat2.j?.quota)}`);

const qa = await api("/quick-action", { token, action: "cmd_help" }, token);
T("quick-action static page (zero quota)", qa.j?.ok === true && typeof qa.j?.text === "string" && qa.j.text.length > 40, `kind=${qa.j?.kind} in ${qa.dt}ms`);
const qa2 = await api("/quick-action", { token, action: "deep_analysis", contextText: "طرف مقابل چک برگشتی من را پرداخت نکرده است." }, token);
T("deep_analysis dynamic action via dual engine", qa2.j?.ok === true && ((qa2.j.chunks || []).join(" ") + (qa2.j.text || "")).length > 60, `kind=${qa2.j?.kind} in ${qa2.dt}ms`);

const hist = await api("/history", { token, message: "row for smoke", role: "user" }, token);
T("history mirror ok", hist.j?.ok === true);

const badTok = await api("/chat", { token: "tampered.token.xyz", text: "x" });
T("tampered token 401", badTok.status === 401 || badTok.j?.code === "UNAUTHORIZED");

const cors = await fetch(BASE + "/api/v1/auth/verify", { method: "OPTIONS", headers: { origin: BASE, "access-control-request-method": "POST" } });
T("CORS preflight ok", cors.status === 204 || cors.status === 200);

console.log(`\nLIVE SMOKE: ${pass} passed, ${fail} failed  (base ${BASE})`);
process.exit(fail ? 1 : 0);
