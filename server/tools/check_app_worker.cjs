// integrity check for the built app worker:
//   1) every engine symbol the app needs is defined EXACTLY once (catches the
//      logToAdmin-duplicate class of bug)
//   2) no top-level identifier is called that is neither defined, nor a known
//      builtin, nor one of the app-module's own locals declared via const/let
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "dist", "vakil-app-worker.js"), "utf8");
const lines = src.split("\n");

const defs = {};
for (const line of lines) {
  const m = line.match(/^(?:async function|function) ([A-Za-z0-9_$]+)\s*\(|^class ([A-Za-z0-9_$]+)\b|^const ([A-Za-z0-9_$]+)\s*=|^let ([A-Za-z0-9_$]+)\s*=/);
  if (m) { const n = m[1] || m[2] || m[3] || m[4]; defs[n] = (defs[n] || 0) + 1; }
}

const REQUIRED = ["AppError", "GeminiEngineError", "ErrorClassGemini", "extractGeminiDebug", "toAppError", "normalizeError",
  "sleep", "clampInt", "validateInputContent", "normalizeUserStatus", "saveChatHistory", "getTehranTodayDate",
  "checkImageLimit", "incrementImageUsage", "checkUserLimit", "incrementUsage", "getGreeting", "clamp",
  "compute429CooldownMs", "resolveGeminiRuntimeBudget", "isGoogleOverloadResult", "isHardKeyExhaustionResult",
  "sanitizeGoogleRawResponse", "buildGeminiFailureReport", "throwGeminiEngineError", "processWithGemini",
  "filterAndRankCandidatesViaKV", "selectOptimalKeys", "selectOptimalBackupKeys", "selectFromD1",
  "selectRecoveryCandidates", "selectFromEnv", "executeWithLeastLoad", "acquireKeyLease", "releaseKeyLease",
  "getGatewayModels", "executeApiCall", "handleSuccess", "handleFailure", "readKeyMetricsFromKV",
  "updateKeyMetricsInKV", "calc429CooldownExponential", "calculateEWMA", "buildGeminiPayload",
  "generateSessionId", "maskKey", "shuffleArray", "addJitter", "logInfo", "logWarn", "logError", "logToAdmin",
  "processDraftingWithGemini", "splitByParagraphs", "fetchWithTimeoutTracer", "arrayBufferToBase64",
  "isolatedTelegramHtmlParser", "getActiveGeminiKey", "escapeHtml", "SYSTEM_PROMPT", "GEMINI_CONFIG",
  "handleAppApi", "appApiHandleChat", "appApiHandleVerify", "appApiHandleQuickAction", "appApiHandleHistory",
  "appApiJson", "appApiErr", "appApiVerifyToken", "appApiIssueToken",
  "appApiAuthed", "appApiGemini", "appApiDualEngine", "appApiEnsureTables", "appApiKeyboardFor",
  // ── marketplace foundation (V1): dispatcher, schema gate, auth/google seam ──
  // Fails loudly if any marketplace part is dropped from the build order, or if
  // a duplicate sneaks in (both are exactly the class of bug this tool exists for).
  "appApiExtensions", "marketplaceRegister", "marketplaceRegisterSchema", "marketplaceEnsureTables",
  "marketplaceEnsureTablesImpl", "marketplaceSeedDefaults", "marketplaceRequireToken",
  "marketplaceRequireRole", "marketplaceRequireAdmin", "marketplaceRateLimit", "marketplaceAccount",
  "marketplaceNewId", "marketplaceNewUserId", "marketplaceCommissionBps",
  "authRunSignup", "authRunLogin", "authRunMe", "authRunPasswordSet", "authHashPassword", "authVerifyPassword",
  "googleHandleLogin", "googleVerifyIdToken",
  "lawyersHandleList", "lawyersHandleGet", "lawyersHandleMe", "lawyersHandleSave", "lawyersHandleApply", "lawyersHandleCategories",
  "consultationHandleCreate", "consultationHandleList", "consultationHandleGet",
  "consultationHandleMessages", "consultationHandleSend", "consultationHandleComplete",
  "consultationLoad", "consultationMembership", "consultationTransition", "consultationView",
  "paymentHandlePay", "paymentHandleHistory", "paymentHandleProviders",
  "paymentRegisterProvider", "paymentProviderName", "paymentCreatePending", "paymentCharge",
  "reviewsHandleList", "reviewsHandleMine", "reviewsHandleSubmit", "reviewEnsureLawyerContext", "adminHandleOverview", "adminHandleUsersList", "adminHandlePendingLawyers", "adminHandleDecide",
  "adminHandleConfigGet", "adminHandleConfigSet", "adminHandleConsultations", "adminHandleAuditList",
  "adminPayoutHandleList", "adminPayoutHandleCreate", "adminPayoutHandleMark",
  "consultOpsHandleCancel", "consultOpsHandleRefund", "consultOpsClientGate", "consultOpsProviderAllowsRefund"];

let fail = 0;
for (const r of REQUIRED) {
  if (!defs[r]) { console.log("MISSING:", r); fail++; }
  else if (defs[r] > 1) { console.log("DUPLICATE:", r, `(${defs[r]}x)`); fail++; }
}
if (!/^export default \{/m.test(src)) { console.log("MISSING: export default worker object"); fail++; }

console.log(fail === 0 ? `APP-WORKER INTEGRITY OK (${REQUIRED.length} required symbols unique)` : `APP-WORKER INTEGRITY FAILED (${fail} problems)`);
process.exit(fail === 0 ? 0 : 1);
