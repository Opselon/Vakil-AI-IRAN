#!/usr/bin/env node
/* Build vakil-app-worker.js — the STANDALONE serverless worker that serves ONLY
   the app API (/api/v1). The Telegram bot worker stays 100% untouched.

   Strategy: slice the proven engine functions VERBATIM from the pristine bot
   worker (D1 gemini_api_keys failover cluster + KV sticky/cooldown/lease +
   EWMA health + turbo downgrade), append the auto-extracted prompts/pages +
   app module, and wrap with an app-only fetch handler. The bot's admin log
   sink is replaced by a console sink (no Telegram sends in this worker). */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { createLocator } = require("./slice_locator.cjs");

const [, , WORKER_IN, OUT] = process.argv;
if (!WORKER_IN || !OUT) { console.error("usage: node build_app_worker.js <orig-bot-worker.js> <out.js>"); process.exit(2); }

const HERE = __dirname;
const must = (c, m) => { if (!c) { console.error("BUILD FAILED: " + m); process.exit(4); } };
const { lines, findFn, findBlockLiteral } = createLocator(path.resolve(WORKER_IN));

const names = [
  // error model
  "AppError", "GeminiEngineError", "ErrorClassGemini", "extractGeminiDebug", "toAppError", "normalizeError",
  "sleep", "clampInt",
  // quota / memory / validation
  "validateInputContent", "normalizeUserStatus", "saveChatHistory", "getTehranTodayDate",
  "checkImageLimit", "incrementImageUsage", "checkUserLimit", "incrementUsage", "getGreeting",
  // cluster engine
  "clamp", "compute429CooldownMs", "resolveGeminiRuntimeBudget", "isGoogleOverloadResult",
  "isHardKeyExhaustionResult", "sanitizeGoogleRawResponse", "buildGeminiFailureReport", "throwGeminiEngineError",
  "processWithGemini", "filterAndRankCandidatesViaKV", "selectOptimalKeys", "selectOptimalBackupKeys",
  "selectFromD1", "selectRecoveryCandidates", "selectFromEnv", "executeWithLeastLoad", "acquireKeyLease",
  "releaseKeyLease", "getGatewayModels", "executeApiCall", "handleSuccess", "handleFailure",
  "readKeyMetricsFromKV", "updateKeyMetricsInKV", "calc429CooldownExponential", "calculateEWMA",
  "buildGeminiPayload", "generateSessionId", "maskKey", "shuffleArray", "addJitter",
  // logging + drafting + render helpers
  "logInfo", "logWarn", "logError", "processDraftingWithGemini",
  "splitByParagraphs", "fetchWithTimeoutTracer", "arrayBufferToBase64",
  "isolatedTelegramHtmlParser", "getActiveGeminiKey", "escapeHtml",
  "GEMINI_CONFIG"
];

const ranges = [];
for (const n of names) {
  const r = findFn(n);
  must(r, `top-level declaration '${n}' not found in bot source`);
  ranges.push(r);
}
ranges.push(findBlockLiteral(6050, "const SYSTEM_PROMPT = `"));

ranges.sort((a, b) => a[0] - b[0]);
const merged = [];
for (const r of ranges) {
  if (merged.length && r[0] <= merged[merged.length - 1][1]) { merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]); continue; }
  merged.push([...r]);
}

let slices = merged.map(([s, e]) => lines.slice(s - 1, e).join("\n")).join("\n\n");
slices = slices.split("\n").filter(l => !/^import\s.*from\s/.test(l)).join("\n"); // no imports may survive

// ---- app module parts (shared sources with the dual worker) ----
execSync(`node "${path.join(HERE, "extract_prompts.cjs")}" "${path.resolve(WORKER_IN)}" "${path.join(HERE, "..", "src", "app_api.prompts.js")}"`, { stdio: "inherit" });
const genPrompts = fs.readFileSync(path.join(HERE, "..", "src", "app_api.prompts.js"), "utf8");
const engine = fs.readFileSync(path.join(HERE, "parts", "app_module_engine.js"), "utf8");
const body = fs.readFileSync(path.join(HERE, "parts", "app_module_body.js"), "utf8");
const tracer = fs.readFileSync(path.join(HERE, "parts", "tracer_class.js"), "utf8");
let head = fs.readFileSync(path.join(HERE, "parts", "app_module_head.js"), "utf8");
head = head.replace("//__GENERATED_PROMPTS__", genPrompts).replace("//__API_BODY__", engine + "\n" + body);

const adminStub = `
// ── app-worker console sink (no Telegram admin channel in this deployment) ──
async function logToAdmin(env, entry) {
  try {
    const e = typeof entry === "string" ? { message: entry } : (entry || {});
    console.log("[ADMIN-SINK]", e.level || "info", e.fn || "", e.event || "", String(e.message || "").slice(0, 300));
  } catch (_) {}
}
`;

// URL-normalization patch (root cause of live 404s): Cloudflare Workers routes
// "" and "/" differently; the bot calls fetch(proxyUrl) with a TRAILING slash
// (its env value has one) while the app module concatenated without it. The
// app's appApiGatewayFetch always prefixes "/", so strip the host's slashes.
slices = slices.split('env.GEMINI_PROXY_URL || "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev"')
  .join('((env.GEMINI_PROXY_URL || "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev").replace(/\\/+$/, "") + "/")');
must(!/[^\s]/.test(""), ""); // noop

const appFetch = `
// ────────────────────────────────────────────────────────────────────────────
// APP-ONLY WORKER FETCH HANDLER — serves /api/v1 only. Telegram webhooks are
// intentionally NOT handled here (they live in the untouched bot worker).
// ────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      return await handleAppApi(request, env, ctx);
    }
    if (url.pathname === "/") {
      return new Response("\\u2696\\uFE0F Vakil AI App API: ONLINE (serverless, D1 key cluster)", { status: 200 });
    }
    if (url.pathname === "/health") {
      return appApiJson({ ok: true, service: "vakil-ai-app", ts: Date.now() });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Maintenance sweep: drop expired app tokens (keeps table lean at 500-key scale).
    try {
      await env.DB.prepare("DELETE FROM app_tokens WHERE expires_at < ?").bind(Date.now() - 7 * 86400000).run();
    } catch (e) { console.error("scheduled token sweep failed:", e && e.message); }
  }
};
`;

const banner = `// ==========================================================================
// VAKIL AI — APP SERVERLESS WORKER (single file, deploy target for the app)
// AUTO-GENERATED by server/tools/build_app_worker.js from:
//   • pristine bot worker engine slices (failover cluster — verbatim)
//   • tools/parts/app_module_* + src/app_api.prompts.js (verbatim pages)
// Bindings: DB (D1 ailawyer), KV (GeminiKV). Secrets: APP_TOKEN_SECRET,
// APP_CHANNEL_CODE. Optional: GEMINI_PROXY_URL, PROXY_SECRET_TOKEN,
// GEMINI_API_KEY (D1-lookup fallback only), DAILY_LIMIT.
// DO NOT EDIT BY HAND — edit the parts/tools and rebuild.
// ==========================================================================
/* eslint-disable */

`;

// ── Marketplace modules (optional, concatenated in fixed dependency order;
//    each part is node --check'd on its own and included only when present).
//    Order matters: schema before auth before the feature modules. ──
const V1_ORDER = ["app_module_common.js", "app_module_schema.js", "app_module_auth.js", "app_module_google.js", "app_module_lawyers.js", "app_module_consultations.js", "app_module_payments.js", "app_module_consult_ops.js", "app_module_payouts.js", "app_module_reviews.js", "app_module_admin.js"];
const marketplaceParts = [];
for (const n of V1_ORDER) {
  const p = path.join(HERE, "parts", n);
  if (!fs.existsSync(p)) continue;
  const code = fs.readFileSync(p, "utf8");
  const tmp = path.join(require("os").tmpdir(), `marketplace_check_${n}.js`);
  fs.writeFileSync(tmp, code, "utf8");
  try { execSync(`node --check "${tmp}"`, { stdio: "pipe" }); }
  catch (e) { must(false, `marketplace part ${n} failed node --check:\n${e.stderr ? e.stderr.toString().slice(0, 500) : e.message}`); }
  try { fs.unlinkSync(tmp); } catch (_) {}
  marketplaceParts.push(`\n// ══ marketplace part: ${n} ══\n` + code);
}

const out = banner + tracer + "\n\n" + slices + "\n\n" + adminStub + "\n\n" + head + "\n" + marketplaceParts.join("\n") + "\n\n" + appFetch;
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, out, "utf8");
console.log(`built app worker -> ${OUT} (${(out.length / 1024).toFixed(0)} KB, ${merged.length} engine regions)`);
