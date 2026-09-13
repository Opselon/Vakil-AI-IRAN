#!/usr/bin/env node
/* Build the single deployable worker.js for the Vakil AI cross-platform app.

   Input : original bot worker (read-only, never modified) + app API parts
   Output: ONE self-contained worker.js file — bot code unchanged + appended
           /api/v1 module + minimal route hook in fetch().

   The deployed Telegram worker is NOT touched: this file is intended for a
   SECOND Cloudflare Worker deployment that shares the same D1 (users,
   chat_history, gemini_api_keys), KV and Gemini gateway.

   Usage: node build_worker.js <orig_worker.js> <out_worker.js> */
const fs = require("fs");
const path = require("path");

const [, , WORKER_IN, OUT] = process.argv;
if (!WORKER_IN || !OUT) { console.error("usage: node build_worker.js <orig> <out>"); process.exit(2); }

const HERE = __dirname;
const must = (cond, msg) => { if (!cond) { console.error("BUILD FAILED: " + msg); process.exit(4); } };

const raw = fs.readFileSync(WORKER_IN, "utf8");
const hadCRLF = raw.includes("\r\n");
const src = hadCRLF ? raw.replace(/\r\n/g, "\n") : raw;
must(!src.includes("APP_API_PREFIX"), "input worker already contains app module — use the pristine copy");

// 1) regenerate prompts verbatim (line anchors verified inside)
require("child_process").execSync(
  `node "${path.join(HERE, "extract_prompts.cjs")}" "${path.resolve(WORKER_IN)}" "${path.join(HERE, "..", "src", "app_api.prompts.js")}"`,
  { stdio: "inherit" }
);

const genPrompts = fs.readFileSync(path.join(HERE, "..", "src", "app_api.prompts.js"), "utf8");
const engine = fs.readFileSync(path.join(HERE, "parts", "app_module_engine.js"), "utf8");
const body = fs.readFileSync(path.join(HERE, "parts", "app_module_body.js"), "utf8");
const tracer = fs.readFileSync(path.join(HERE, "parts", "tracer_class.js"), "utf8");
let head = fs.readFileSync(path.join(HERE, "parts", "app_module_head.js"), "utf8");
head = head.replace("//__GENERATED_PROMPTS__", genPrompts).replace("//__API_BODY__", engine + "\n" + body);

// 2) single-file: drop the ErrorTraceLog relative import, inline our compatible class
const importLine = `import { ErrorTraceLog } from "./ErrorTraceLog.js";`;
must(src.includes(importLine), "ErrorTraceLog import line not found");
let patched = src.replace(importLine, "// ErrorTraceLog inlined below (single-file deploy)");

// 3) route hook in fetch() — BEFORE the bot's critical env check so the app
//    worker needs only D1 (+optional KV/gateway) bindings; OPTIONS always works.
const routeAnchor = "      // 1. Critical Environment Check";
must(patched.includes(routeAnchor), "critical env check anchor not found (bot file changed?)");
const route = `      // ── 📱 Vakil App API — cross-platform client (same D1 key cluster) ──
      if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
        return await handleAppApi(request, env, ctx);
      }

`;
patched = patched.replace(routeAnchor, route + routeAnchor);

// 4) append module + tracer class (function/class refs resolve at request time)
patched = patched + "\n\n" + tracer + "\n\n" + head;

if (hadCRLF) patched = patched.replace(/\n/g, "\r\n");
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, patched, "utf8");
console.log("built single-file worker ->", OUT, `(${(patched.length / 1024).toFixed(0)} KB)`);
