// Replay the exact engine gateway body with a REAL cluster key; print status + raw answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const spy = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "spy_body.json"), "utf8"));
const realKey = fs.readFileSync(path.join(os.tmpdir(), "onekey.txt"), "utf8").trim();
const body = { ...spy.body, key: realKey, dedup_hash: "replay-" + Date.now() };
console.log("model:", body.model, "| payload keys:", Object.keys(body.payload).join(","));
console.log("contents roles:", (body.payload.contents || []).map(c => c.role).join(","));
const res = await fetch(spy.url + "/", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Session-Id": "replay-" + Date.now() },
  body: JSON.stringify(body),
});
const txt = await res.text();
console.log("HTTP", res.status);
console.log(txt.slice(0, 700));
