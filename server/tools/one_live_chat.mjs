// One live chat round-trip against the DEPLOYED worker (for use with wrangler tail).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const code = fs.readFileSync(path.join(os.tmpdir(), "vakil_secrets.txt"), "utf8")
  .split("\n").find(l => l.startsWith("APP_CHANNEL_CODE=")).split("=").slice(1).join("=").trim();
const dev = "livedbg-" + Date.now();
const B = "https://vakil-app.samerkhaldounmarefi.workers.dev";
let r = await fetch(B + "/api/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: dev, code }) });
const v = await r.json();
console.log("verify ok:", v.ok);
const t0 = Date.now();
r = await fetch(B + "/api/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: v.token, text: "توهین ساده طبق قانون مجازات اسلامی چه مجازاتی دارد؟" }) });
const j = await r.json();
console.log("chat HTTP", r.status, "in", Date.now() - t0, "ms ->", JSON.stringify({ ok: j.ok, code: j.code, kind: j.kind, chunks: (j.chunks || []).length, msg: (j.message || "").slice(0, 60) }));
