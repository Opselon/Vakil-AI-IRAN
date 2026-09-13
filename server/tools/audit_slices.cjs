#!/usr/bin/env node
/* Audit every engine slice the builder extracts: report range + --check status. */
const path = require("path");
const { createLocator } = require("./slice_locator.cjs");
const { lines, findFn, findBlockLiteral } = createLocator(process.argv[2] || "C:/Users/Capsizer/Desktop/VAKILAI/worker.js");

const names = [
  "AppError", "GeminiEngineError", "ErrorClassGemini", "extractGeminiDebug", "toAppError", "normalizeError",
  "sleep", "clampInt", "validateInputContent", "normalizeUserStatus", "saveChatHistory", "getTehranTodayDate",
  "checkImageLimit", "incrementImageUsage", "checkUserLimit", "incrementUsage", "getGreeting",
  "clamp", "compute429CooldownMs", "resolveGeminiRuntimeBudget", "isGoogleOverloadResult",
  "isHardKeyExhaustionResult", "sanitizeGoogleRawResponse", "buildGeminiFailureReport", "throwGeminiEngineError",
  "processWithGemini", "filterAndRankCandidatesViaKV", "selectOptimalKeys", "selectOptimalBackupKeys",
  "selectFromD1", "selectRecoveryCandidates", "selectFromEnv", "executeWithLeastLoad", "acquireKeyLease",
  "releaseKeyLease", "getGatewayModels", "executeApiCall", "handleSuccess", "handleFailure",
  "readKeyMetricsFromKV", "updateKeyMetricsInKV", "calc429CooldownExponential", "calculateEWMA",
  "buildGeminiPayload", "generateSessionId", "maskKey", "shuffleArray", "addJitter",
  "logInfo", "logWarn", "logError", "processDraftingWithGemini", "splitByParagraphs", "fetchWithTimeoutTracer",
  "arrayBufferToBase64", "isolatedTelegramHtmlParser", "getActiveGeminiKey", "escapeHtml", "GEMINI_CONFIG"
];
let bad = 0;
for (const n of names) {
  const r = findFn(n);
  if (!r) { console.log("MISSING:", n); bad++; continue; }
  if (r[2] !== "ok") { console.log("NOT-OK:", n.padEnd(30), r.join("-"), r[2]); bad++; }
}
const sp = findBlockLiteral(6050, "const SYSTEM_PROMPT = `");
if (!sp || sp[1] - sp[0] < 10) { console.log("SYSTEM_PROMPT range suspicious:", sp); bad++; } else console.log("SYSTEM_PROMPT:", sp.join("-"), `(${sp[1] - sp[0] + 1} lines)`);
console.log(bad === 0 ? `ALL ${names.length} SLICES VERIFIED OK` : `${bad} problem slices`);
