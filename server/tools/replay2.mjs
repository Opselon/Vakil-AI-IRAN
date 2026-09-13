// Replay the EXACT spy-captured body with a real key against both URL shapes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const spy = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "spy_body.json"), "utf8"));
const realKey = fs.readFileSync(path.join(os.tmpdir(), "onekey.txt"), "utf8").trim();

for (const variant of ["engine-url-+-", "engine-url-+/"]) {
  const body = { ...spy.body, key: realKey, dedup_hash: "replay2-" + Date.now() + "-" + variant };
  const url = variant.endsWith("-")
    ? "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev"
    : "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev/";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Session-Id": "replay2-" + Date.now() },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let summary;
  try { const j = JSON.parse(txt); summary = j.success ? "SUCCESS text=" + (j.data?.candidates?.[0]?.content?.parts?.[0]?.text || "").slice(0, 40) : "FAIL " + JSON.stringify(j).slice(0, 160); }
  catch { summary = "RAW " + txt.slice(0, 160); }
  console.log(variant, "→ HTTP", res.status, "→", summary);
}
