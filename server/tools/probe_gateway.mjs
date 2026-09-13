// Direct gateway probe: takes ONE real active key from D1 (via wrangler), calls
// the proxy root POST exactly like executeApiCall, prints the raw result.
// usage: node tools/probe_gateway.mjs   (reads key from %TEMP%/onekey.txt)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let key = "";
try { key = fs.readFileSync(path.join(os.tmpdir(), "onekey.txt"), "utf8").trim(); } catch { }
if (!key || !/^AI|AQ/.test(key)) {
  const out = execSync(`npx --yes wrangler d1 execute ailawyer --remote --json --command "SELECT key_value FROM gemini_api_keys WHERE status='active' ORDER BY last_used ASC LIMIT 1"`, { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", maxBuffer: 1 << 24 });
  const j = JSON.parse(out.slice(out.indexOf("{")));
  key = j[0].results[0].key_value;
}
console.log("using key", key.slice(0, 8) + "..." + key.slice(-4), "(len", key.length + ")");

async function probe(model) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: "فقط بگو OK" }] }],
    systemInstruction: { parts: [{ text: "تو یک دستیار کوتاه‌پاسخ هستی." }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 30 },
  };
  const res = await fetch("https://purple-bread-2b60.samerkhaldounmarefi.workers.dev/", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Session-Id": "probe-" + Date.now() },
    body: JSON.stringify({ key, model, payload, dedup_hash: "probe-" + Date.now() + "-" + model }),
  });
  const text = await res.text();
  console.log(`\n[${model}] HTTP ${res.status}`);
  console.log(text.slice(0, 500));
}

await probe("gemini-2.5-flash");
await probe("gemini-2.5-flash-lite");
