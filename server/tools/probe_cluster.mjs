// Probe EVERY cluster key in gemini_api_keys against the gateway with two
// candidate models and report which model/key combos actually succeed.
// Keys are never printed in full (tail-4 only).
import { execSync } from "node:child_process";
import path from "node:path";

const CWD = path.join(import.meta.dirname, "..");
const GW = "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev";

const raw = execSync(`npx --yes wrangler d1 execute ailawyer --remote --json --command "SELECT key_value, health_score, status FROM gemini_api_keys ORDER BY rowid"`, { cwd: CWD, encoding: "utf8", maxBuffer: 1 << 26 });
const s = raw.slice(raw.indexOf("["));
const rows = JSON.parse(s.slice(0, s.lastIndexOf("]") + 1))[0].results;
console.log("cluster keys:", rows.length);

async function probe(key, model) {
  const body = {
    key, model,
    payload: {
      contents: [{ role: "user", parts: [{ text: "say OK" }] }],
      system_instruction: { parts: [{ text: "Answer with one word." }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 8 },
    },
    dedup_hash: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(GW + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const txt = await res.text();
    let tag = res.status;
    try { const j = JSON.parse(txt); if (j.success) tag = "OK:" + (j.data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim().slice(0, 10); else tag = res.status + ":" + (j.googleStatus || j.error || "").slice(0, 24); } catch { tag = res.status + ":raw"; }
    return tag;
  } catch (e) { return "EXC:" + (e.name || e.message).slice(0, 20); }
  finally { clearTimeout(t); }
}

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const tally = {};
for (const r of rows) {
  const tail = r.key_value.slice(-4);
  const results = [];
  for (const m of MODELS) {
    const t = await probe(r.key_value, m);
    results.push(`${m.replace("gemini-2.5-", "")}=${t}`);
    tally[m] = tally[m] || {};
    tally[m][t.split(":")[0]] = (tally[m][t.split(":")[0]] || 0) + 1;
  }
  console.log(tail, "health", String(r.health_score).padStart(3), r.status.padEnd(8), results.join("  "));
}
console.log("\nTALLY:", JSON.stringify(tally, null, 1));
