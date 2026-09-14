// ────────────────────────────────────────────────────────────────────────────
// VAKIL AI — Application API (handlers + router)
// Appended into the worker's own file scope: it calls the bot's engine
// functions directly (no HTTP hop, no key duplication).
// ────────────────────────────────────────────────────────────────────────────

const APP_SALES = Object.freeze({
  CARD_OWNER: "رضا جسارتی",
  CARD_NUMBER: "6219861837282945",
  SUPPORT_ID: "@Capxi",
  DIRECT_PHONE: "09016807808"
});

// Exact content-gate warnings from the bot pipeline
const APP_WARNING_SHORT_INPUT =
  `💡 **تحلیل دقیق حقوقی مستلزم جزئیات است**\n\n` +
  `کاربر گرامی، پیام‌های بسیار کوتاه یا مبهم در نظام حقوقی قابل بررسی نیستند. برای اینکه بتوانم راهکار قانونیِ **قابل استناد** به شما ارائه دهم، باید «نقشه ماجرا» را بدانم.\n\n` +
  `🏗 **ستون‌های اصلی یک سوال خوب:**\n` +
  `۱. **طرفین ماجرا:** (مثلاً: مستاجر هستید یا موجر؟ خریدار یا فروشنده؟)\n` +
  `۲. **زمان و مکان:** (تاریخ قرارداد یا اتفاق، بسیار در مرور زمانِ دعاوی مهم است.)\n` +
  `۳. **مبلغ یا اسناد:** (مبالغ درگیر و اینکه چه سندی -چک، سفته، دست‌نوشته- دارید.)\n` +
  `۴. **هدف نهایی:** (دقیقاً می‌خواهید چه اتفاقی بیفتد؟ فسخ قرارداد؟ جلب طرف مقابل؟ استرداد پول؟)\n\n` +
  `📝 **مقایسه برای درک بهتر:**\n` +
  `❌ *اشتباه:* «پولم رو خوردن، چیکار کنم؟»\n` +
  `✅ *درست:* «اینجانب ۶ ماه پیش مبلغ ۵۰ میلیون تومان بابت خرید کالا به حساب شخصی واریز کردم. رسید بانکی دارم اما طرف مقابل گوشی را جواب نمی‌دهد و کالا را نفرستاده. آیا می‌توانم تحت عنوان **کلاهبرداری** شکایت کنم؟»\n\n` +
  `👇 **لطفاً اکنون ماجرای خود را با رعایت این موارد بنویسید یا ویس بفرستید:**`;

const APP_WARNING_IMAGE_NO_CAPTION =
  `⛔️ *تصویر بدون توضیحات پذیرفته نمی‌شود.*\n\n` +
  `لطفاً عکس را **مجدد** ارسال کنید و در کپشن دقیقاً بنویسید:\n` +
  `• این سند چیست؟\n` +
  `• سوال شما در مورد کجای این سند است؟`;

const APP_WARNING_IMAGE_CAPTION_WEAK =
  `⚠️ *توضیحات عکس کافی نیست.*\n\n` +
  `نوشتن کلماتی مثل «این رو بخون» یا «سند» کافی نیست. لطفاً در کپشن توضیح دهید که چه اتفاقی افتاده و خواسته شما چیست.`;

const APP_WARNING_IMAGE_LIMIT =
  `🚫 *سقف ارسال تصویر تکمیل شده است.*\n\n` +
  `هر کاربر مجاز است **در هر ۲۴ ساعت فقط ۱ تصویر** برای تحلیل ارسال کند.\n\n` +
  `⏳ *شما می‌توانید فردا مجدداً تصویر ارسال کنید.*`;

const APP_THINKING_FRAMES = Object.freeze([
  "⏳ در حال تحقیق و بررسی پرونده شما، لطفاً شکیبا باشید...",
  "🔎 در حال جستجو در رویه‌های قضایی و پرونده‌های مشابه...",
  "⚖️ در حال تطبیق قوانین با شرایط شما و انجام تحلیل نهایی...",
  "✍️ در حال تنظیم و نگارش پاسخ حقوقی مستند..."
]);

const APP_DRAFT_CANCEL_KEYWORDS = ["لغو", "کنسل", "خروج", "بازگشت", "بیخیال", "انصراف", "/cancel", "/start", "/menu"];

// Keyboards — identical labels/semantics to the bot inline keyboards,
// addressed by app action names instead of callback_data.
function appApiKeyboardFor(kind) {
  switch (kind) {
    case "chat_response":
      return [
        [{ text: "🔎 تحلیل عمیق و تخصصی پرونده", action: "deep_analysis", style: "success" }],
        [{ text: "🚨 بایدها و نبایدهای حیاتی پرونده", action: "dos_and_donts", style: "success" }],
        [{ text: "⚖️ شبیه‌ساز دادگاه (سوالات احتمالی قاضی)", action: "court_simulator", style: "success" }],
        [{ text: "🕵️ بازجویی استراتژیک (شبیه‌ساز کلانتری/دادسرا)", action: "interrogation_sim", style: "success" }],
        [{ text: "📊 محاسبه شانس برد و ریسک مالی", action: "financial_risk", style: "primary" }],
        [{ text: "🔮 پیش‌بینی ادعاهای حریف و پاتک حقوقی", action: "opponent_claims", style: "primary" }],
        [{ text: "⚖️ فرصت‌ها و تهدیدهای قانونی پرونده", action: "legal_opportunities", style: "primary" }],
        [{ text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }]
      ];
    case "drafting":
      return [[{ text: "❌ انصراف و خروج", action: "cancel_drafting", style: "danger" }]];
    case "main_menu":
      return [
        [
          { text: "👤 وضعیت حساب من", action: "cmd_limit", style: "primary" },
          { text: "📞 تماس فوری با وکیل", action: "cmd_contact", style: "success" }
        ],
        [
          { text: "✍️ تنظیم قرارداد و لایحه", action: "cmd_drafting", style: "primary" },
          { text: "📚 راهنمای کامل", action: "cmd_help", style: "success" }
        ],
        [
          { text: "⚖️ قوانین و مقررات", action: "cmd_terms", style: "danger" },
          { text: "ℹ️ درباره تکنولوژی ما", action: "cmd_about", style: "primary" }
        ]
      ];
    case "offers":
      return [
        [
          { text: "⚡ رزرو مشاوره فوری (۲۵۰)", action: "buy_consult_250", style: "success" },
          { text: "📎 تحلیل مدارک (۵۰۰)", action: "buy_docs_500", style: "success" }
        ],
        [{ text: "📝 تنظیم اوراق/قرارداد (از ۷۰۰)", action: "buy_draft_700", style: "primary" }],
        [
          { text: "📌 اشتراک پشتیبانی پرونده", action: "buy_subscription", style: "primary" },
          { text: "🧑‍💻 گفت‌وگو با پشتیبانی", action: "support_chat", style: "success" }
        ],
        [
          { text: "❓ سوالات متداول", action: "faq", style: "primary" },
          { text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }
        ]
      ];
    case "back_to_offers":
      return [[
        { text: "🔙 بازگشت به پکیج‌ها", action: "cmd_contact", style: "primary" },
        { text: "🔙 منوی اصلی", action: "main_menu", style: "danger" }
      ]];
    default: // quick_page / action_result
      return [[{ text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }]];
  }
}

// ─────────────────────────── tables (idempotent, first use) ───────────────────────────

async function appApiEnsureTables(env) {
  if (globalThis.__appApiTablesOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_devices (
    device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, platform TEXT, created_at INTEGER
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_tokens (
    token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_app_tokens_user ON app_tokens(user_id);").run();
  // Audit (db): DB.md documents these two as existing; the runtime gate now
  // creates them too, so the 6h token sweep + device→user lookups never full-scan.
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_app_tokens_exp ON app_tokens(expires_at);").run().catch(() => {});
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_app_devices_user ON app_devices(user_id);").run().catch(() => {});
  globalThis.__appApiTablesOk = true;
}

// ─────────────────────────── auth ───────────────────────────

async function appApiHandleVerify(env, body, request) {
  const deviceId = String(body.deviceId || "").trim().slice(0, 64);
  const code = String(body.code || "").trim();
  const platform = String(body.platform || "unknown").slice(0, 32);
  const name = String(body.name || "").trim().slice(0, 40);
  if (!deviceId || deviceId.length < 6) return appApiErr("BAD_DEVICE", "شناسه دستگاه نامعتبر است.");
  if (!env.APP_CHANNEL_CODE) return appApiErr("SERVER_NOT_CONFIGURED", "سرور هنوز برای ورود برنامه پیکربندی نشده است.", 500);
  if (!code || code.length < 4) return appApiErr("CODE_REQUIRED", "کد فعال‌سازی را وارد کنید.");

  // Audit (V1 hardening wave): this endpoint had NO limiter, so the constant-
  // time compare was moot against unlimited guesses, and rotating deviceId minted
  // fresh synthetic users + daily quota. 6 tries / 15 min per device(+IP when
  // the edge exposes it) throttles both. marketplaceRateLimit lives in
  // app_module_common.js — same concatenated scope, hoisted, safe to call here.
  const ipKey = (request && request.cf && request.cf.clientIp) || deviceId;
  if (!(await marketplaceRateLimit(env, "verify:" + deviceId, 6, 900000)) ||
      !(await marketplaceRateLimit(env, "verify-ip:" + ipKey, 20, 900000))) {
    return appApiErr("RATE_LIMITED", "تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر تلاش کنید.", 429);
  }

  const expected = String(env.APP_CHANNEL_CODE).trim();
  if (code.length !== expected.length) return appApiErr("INVALID_CODE", "🔒 کد فعال‌سازی اشتباه است.", 403);
  let diff = 0;
  for (let i = 0; i < code.length; i++) diff |= code.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return appApiErr("INVALID_CODE", "🔒 کد فعال‌سازی اشتباه است.", 403);

  try {
    await appApiEnsureTables(env);
    const existing = await env.DB.prepare("SELECT user_id FROM app_devices WHERE device_id = ?").bind(deviceId).first();
    let appUserId = existing?.user_id;

    if (!appUserId) {
      // synthetic id namespaced away from real Telegram ids
      let candidate = 9000000000000 + Math.floor(Math.random() * 999999999);
      for (let g = 0; g < 6; g++) {
        const clash = await env.DB.prepare("SELECT user_id FROM users WHERE user_id = ?").bind(candidate).first();
        if (!clash) break;
        candidate += 17;
      }
      appUserId = candidate;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO app_devices (device_id, user_id, name, platform, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(deviceId, appUserId, name || "App", platform, Date.now()).run();
    }

    const user = { id: appUserId, username: "", first_name: name || "App User" };
    const status = await checkUserLimit(env, user); // bot's own registration + quota logic
    const token = await appApiIssueToken(env, deviceId, appUserId, name);
    return appApiJson({ ok: true, token, userId: appUserId, quota: appApiQuotaView(status, env.DAILY_LIMIT) });
  } catch (e) {
    console.error("appApiHandleVerify error:", e);
    return appApiErr("VERIFY_FAILED", "خطای سامانه در ثبت‌نام دستگاه. لطفاً دوباره تلاش کنید.", 500);
  }
}

async function appApiAuthed(env, body) {
  const payload = await appApiVerifyToken(env, body.token);
  if (!payload) return { err: appApiErr("UNAUTHORIZED", "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.", 401) };
  return { payload, user: appApiUserFromPayload(payload) };
}

// ─────────────────────────── engine text pipeline ───────────────────────────

function appApiPostProcessEngineText(raw) {
  let safeResponseText = typeof raw === "string" ? raw : String(raw ?? "");
  safeResponseText = safeResponseText.replace(/\n\s*[-\_*]{3,}\s*(?=\n|$)/g, "\n");

  let isHtmlFormat = false;
  const formatStructuredJson = (obj) => {
    const resObj = obj.response || obj;
    if (resObj && (resObj.topic || resObj.legal_analysis || resObj.conclusion_and_solution)) {
      return (
        `<b>⚖️ موضوع</b>\n${resObj.topic || ""}\n\n` +
        `<b>📚 تحلیل حقوقی</b>\n${resObj.legal_analysis || ""}\n\n` +
        `<b>✅ نتیجه‌گیری و راهکار</b>\n${resObj.conclusion_and_solution || ""}\n\n` +
        `⚠️ <b>هشدار جدی و سلب مسئولیت</b>\n<i>${resObj.disclaimer || resObj.disclaimer_text || ""}</i>`
      ).trim();
    }
    return null;
  };

  let jsonParseText = safeResponseText.trim();
  if (jsonParseText.startsWith("```")) {
    jsonParseText = jsonParseText.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(jsonParseText);
    const googlePayload = (parsed && parsed.success && parsed.data) ? parsed.data : parsed;
    const textFromCandidates = googlePayload?.candidates?.[0]?.content?.parts?.[0]?.text;
    let candidateText = textFromCandidates || (typeof googlePayload === "string" ? googlePayload : null);
    if (candidateText) {
      let inner = candidateText.trim();
      if (inner.startsWith("```")) inner = inner.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
      try {
        const formatted = formatStructuredJson(JSON.parse(inner));
        if (formatted) { candidateText = formatted; isHtmlFormat = true; }
      } catch (_) {}
      safeResponseText = candidateText;
    } else if (googlePayload && typeof googlePayload === "object") {
      const formatted = formatStructuredJson(googlePayload);
      if (formatted) { safeResponseText = formatted; isHtmlFormat = true; }
    }
  } catch (_) {}

  return { text: safeResponseText, isHtmlFormat };
}

function appApiExtractDynamicActions(aiText) {
  const encoder = new TextEncoder();
  const dynamicActions = [];
  const cleanAiText = String(aiText).replace(/\[ACTION:(.+?)\]/g, (_m, title) => {
    const cleanTitle = title.trim();
    if (cleanTitle) {
      let safeData = "";
      let bytesCount = 0;
      for (const char of cleanTitle) {
        const charLen = encoder.encode(char).length;
        if (bytesCount + charLen > 55) break;
        safeData += char;
        bytesCount += charLen;
      }
      const displayText = cleanTitle.length > 45 ? cleanTitle.slice(0, 42) + "..." : cleanTitle;
      dynamicActions.push({ text: `📝 ${displayText}`, action: `ai_act|${safeData}`, style: "primary" });
    }
    return "";
  });
  return { cleanAiText, dynamicActions };
}

// App-side audio arrives as m4a/ogg/mp3 — the bot engine hardcodes audio/ogg
// (Telegram voice format), so app audio runs through the same gateway with the
// correct mime, using the SAME D1 key cluster. Text/image use the cluster engine.
async function appApiEngineWithAudio(env, text, audioBase64, audioMime) {
  const key = await getActiveGeminiKey(env);
  const cleanSystemPrompt = typeof SYSTEM_PROMPT === "string" ? SYSTEM_PROMPT.trim() : SYSTEM_PROMPT;
  const audioPrompt = (typeof text === "string" && text.trim()) ? text.trim() : "تحلیل و آنالیز حقوقی محتوای صوتی ارسالی";
  const res = await appApiGatewayFetch(env, "/v1/gemini/generate", {
    key,
    model: env.GEMINI_MODEL || "gemini-flash-latest",
    payload: {
      system_instruction: { parts: [{ text: cleanSystemPrompt }] },
      contents: [{ role: "user", parts: [
        { text: audioPrompt },
        { inline_data: { mime_type: audioMime, data: audioBase64 } }
      ]}],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
    }
  }, 26000);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    try { await res.body?.cancel(); } catch {}
    throw new Error(`AUDIO_ENGINE_HTTP_${res.status}: ${t.slice(0, 150)}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "AUDIO_ENGINE_FAILED");
  const out = data.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out || !out.trim()) throw new Error("EMPTY_AUDIO_RESPONSE");
  return out;
}

// ─────────────────────────── /api/v1/chat ───────────────────────────

async function appApiHandleChat(env, ctx, body) {
  const auth = await appApiAuthed(env, body);
  if (auth.err) return auth.err;
  const { user } = auth;

  try {
    const text = String(body.text || "").trim();
    const hasImage = Boolean(body.imageBase64);
    const hasAudio = Boolean(body.audioBase64);

    // -------- Eligibility gate FIRST (exact bot order: checkUserLimit before drafting) --------
    const rawStatus = await checkUserLimit(env, user);
    const userStatus = normalizeUserStatus(rawStatus);
    if (!userStatus.allowed) {
      return appApiJson({ ok: false, code: "LIMIT", message: userStatus.reason, quota: appApiQuotaView(userStatus, env.DAILY_LIMIT) });
    }

    // -------- DRAFTING MODE (not charged — mirrors bot: gate only, no incrementUsage) --------
    let userState = null;
    try {
      userState = await env.DB.prepare("SELECT mode, draft_data FROM users WHERE user_id = ?").bind(user.id).first();
    } catch (e) { console.error("appApi userState error:", e); }

    if (userState && userState.mode === "drafting") {
      const low = text.toLowerCase();
      if (!text || APP_DRAFT_CANCEL_KEYWORDS.some(kw => low.includes(kw))) {
        await env.DB.prepare("UPDATE users SET mode = 'normal', draft_data = '' WHERE user_id = ?").bind(user.id).run();
        return appApiJson({
          ok: true, kind: "draft_cancelled",
          text: text ? "✅ از حالت تنظیم متن حقوقی خارج شدید." : "✅ از حالت تنظیم متن حقوقی خارج شدید.",
          keyboard: [[{ text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }]]
        });
      }
      try {
        const aiResponse = await processDraftingWithGemini(env, text, userState.draft_data || "");
        const newEntry = `User: ${text}\nAI: ${aiResponse}\n---\n`;
        const truncatedHistory = ((userState.draft_data || "") + newEntry).slice(-4000);
        await env.DB.prepare("UPDATE users SET draft_data = ? WHERE user_id = ?").bind(truncatedHistory, user.id).run();
        return appApiJson({ ok: true, kind: "drafting", format: "markdown", text: aiResponse, keyboard: appApiKeyboardFor("drafting") });
      } catch (e) {
        console.error("appApi drafting crash:", e);
        return appApiJson({ ok: false, code: "DRAFTING_ENGINE", message: "⚠️ متاسفانه ارتباط با سرور تنظیم متن برقرار نشد. لطفاً چند لحظه دیگر تلاش کنید." });
      }
    }

    // -------- Content validation (exact bot messages, no quota charged) --------
    if (hasImage) {
      if (!text) return appApiJson({ ok: false, code: "VALIDATION", format: "markdown", message: APP_WARNING_IMAGE_NO_CAPTION, costless: true });
      const captionCheck = validateInputContent(text);
      if (!captionCheck || captionCheck.valid === false)
        return appApiJson({ ok: false, code: "VALIDATION", format: "markdown", message: APP_WARNING_IMAGE_CAPTION_WEAK, costless: true });
      try {
        const canSendImage = await checkImageLimit(env, user.id);
        if (!canSendImage) return appApiJson({ ok: false, code: "IMAGE_LIMIT", format: "markdown", message: APP_WARNING_IMAGE_LIMIT, costless: true });
      } catch (_) {}
    }

    if (!hasImage && !hasAudio) {
      if (!text) return appApiJson({ ok: false, code: "EMPTY", message: "متن درخواست خالی است." });
      const qc = validateInputContent(text);
      if (!qc || qc.valid === false)
        return appApiJson({ ok: false, code: "VALIDATION", format: "markdown", message: APP_WARNING_SHORT_INPUT, costless: true });
    }

    await incrementUsage(env, user.id);

    // -------- THE ENGINE --------
    let responseText = "";
    let usedFallback = false;
    try {
      if (hasAudio) {
        const mime = String(body.audioMime || "audio/mp4").slice(0, 32);
        responseText = await appApiEngineWithAudio(env, text, String(body.audioBase64), mime);
        usedFallback = true;
      } else {
        let imageBuffer = null;
        if (hasImage) {
          imageBuffer = Uint8Array.from(atob(String(body.imageBase64)), c => c.charCodeAt(0)).buffer;
          try { await incrementImageUsage(env, user.id); } catch (_) {}
        }
        const geminiBudget = 25000;
        const geminiEnv = Object.assign({}, env, {
          GEMINI_LAYER_BUDGET_MS: geminiBudget,
          GEMINI_OVERALL_BUDGET_MS: geminiBudget,
          GEMINI_TIMEOUT_MS: clampInt(env.GEMINI_TIMEOUT_MS, 1500, 12000, 9000),
          GEMINI_TIMEOUT_PER_KEY_MS: clampInt(env.GEMINI_TIMEOUT_MS, 1500, 12000, 9000)
        });
        responseText = await processWithGemini(geminiEnv, text, null, imageBuffer, "", ctx);
      }
    } catch (engineErr) {
      console.error("appApi engine error:", engineErr);
      try {
        const key = await getActiveGeminiKey(env);
        const parts = [];
        if (hasImage) parts.push({ inline_data: { mime_type: "image/jpeg", data: String(body.imageBase64) } });
        parts.push({ text: text || "درخواست بررسی حقوقی عمومی" });
        const res = await appApiGatewayFetch(env, "/v1/gemini/generate", {
          key,
          model: env.GEMINI_MODEL || "gemini-flash-latest",
          payload: {
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
          }
        }, 26000);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "GATEWAY_FAIL");
        responseText = data.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) throw new Error("EMPTY_GATEWAY_RESPONSE");
        usedFallback = true;
      } catch (e2) {
        console.error("appApi gateway error:", e2);
        return appApiJson({ ok: false, code: "ENGINE_UNAVAILABLE",
          message: "❌ متاسفانه به دلیل ترافیک بالای سرورهای جهانی، ارتباط با هسته تحلیلی برقرار نشد. لطفاً چند لحظه دیگر تلاش کنید." });
      }
    }

    const processed = appApiPostProcessEngineText(responseText);
    const chunks = splitByParagraphs(processed.text, 4000);

    try {
      const userContentToSave = text || (hasAudio ? "[Audio Message]" : "[Image Message]");
      await saveChatHistory(env, user.id, "user", userContentToSave);
      await saveChatHistory(env, user.id, "model", processed.text);
    } catch (e) { console.error("appApi saveChatHistory error:", e); }

    const afterStatus = normalizeUserStatus(await checkUserLimit(env, user).catch(() => userStatus));
    return appApiJson({
      ok: true,
      kind: "chat",
      format: processed.isHtmlFormat ? "html" : "markdown",
      chunks,
      thinkingFrames: APP_THINKING_FRAMES,
      keyboard: appApiKeyboardFor("chat_response"),
      quota: appApiQuotaView(afterStatus, env.DAILY_LIMIT),
      fallback: usedFallback
    });
  } catch (e) {
    console.error("appApiHandleChat crash:", e);
    return appApiErr("INTERNAL", "خطای داخلی سامانه. لطفاً مجدداً تلاش کنید.", 500);
  }
}

// ─────────────────────────── /api/v1/history (server mirror) ───────────────────────────

async function appApiHandleHistory(env, body, url) {
  const auth = await appApiAuthed(env, body.token ? body : { token: url?.searchParams?.get("token") });
  if (auth.err) return auth.err;
  try {
    const rows = await env.DB.prepare(
      "SELECT role, content, created_at FROM chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 40"
    ).bind(auth.user.id).all();
    return appApiJson({ ok: true, items: (rows.results || []).reverse() });
  } catch (e) {
    console.error("appApiHandleHistory error:", e);
    return appApiJson({ ok: true, items: [] });
  }
}

async function appApiLastModelText(env, userId) {
  try {
    const row = await env.DB.prepare(
      "SELECT content FROM chat_history WHERE user_id = ? AND role = 'model' ORDER BY created_at DESC LIMIT 1"
    ).bind(userId).first();
    return row?.content || "";
  } catch (_) { return ""; }
}

// ─────────────────────────── /api/v1/quick-action ───────────────────────────

async function appApiHandleQuickAction(env, ctx, body) {
  const auth = await appApiAuthed(env, body);
  if (auth.err) return auth.err;
  const { user } = auth;
  const action = String(body.action || "").slice(0, 80);
  const S = APP_SALES;

  // ---------- static pages (zero quota — identical texts to the bot) ----------
  switch (action) {
    case "main_menu":
      return appApiJson({ ok: true, kind: "page", page: "main_menu", format: "markdown", text: APP_PAGE_MAIN_MENU(), keyboard: appApiKeyboardFor("main_menu") });
    case "cmd_help":
      return appApiJson({ ok: true, kind: "page", page: "help", format: "markdown", text: APP_PAGE_HELP(), keyboard: appApiKeyboardFor("quick_page") });
    case "cmd_terms":
      return appApiJson({ ok: true, kind: "page", page: "terms", format: "markdown", text: APP_PAGE_TERMS(), keyboard: [
        [{ text: "✅ شرایط فوق را می‌پذیرم و متعهد می‌شوم", action: "main_menu", style: "success" }],
        [{ text: "🔙 بازگشت", action: "main_menu", style: "danger" }]
      ] });
    case "cmd_about":
      return appApiJson({ ok: true, kind: "page", page: "about", format: "markdown", text: APP_PAGE_ABOUT(), keyboard: appApiKeyboardFor("quick_page") });
    case "cmd_start":
      return appApiJson({ ok: true, kind: "page", page: "start", format: "markdown", text: APP_PAGE_START(getGreeting()), keyboard: appApiKeyboardFor("main_menu") });
    case "welcome":
      return appApiJson({ ok: true, kind: "page", page: "welcome", format: "markdown", text: APP_PAGE_WELCOME(), keyboard: appApiKeyboardFor("main_menu") });
    case "cmd_drafting": {
      await env.DB.prepare("UPDATE users SET mode = ?, draft_data = ? WHERE user_id = ?").bind("drafting", "", user.id).run();
      return appApiJson({ ok: true, kind: "page", page: "draft_intro", format: "markdown", text: APP_PAGE_DRAFT_INTRO(), keyboard: appApiKeyboardFor("drafting") });
    }
    case "cancel_drafting": {
      await env.DB.prepare("UPDATE users SET mode = 'normal', draft_data = '' WHERE user_id = ?").bind(user.id).run();
      return appApiJson({ ok: true, kind: "page", page: "exit_draft", format: "markdown", text: APP_PAGE_EXIT_DRAFT(), keyboard: appApiKeyboardFor("main_menu") });
    }
    case "cmd_limit":
    case "refresh_limit": {
      const status = normalizeUserStatus(await checkUserLimit(env, user));
      const limit = parseInt(env.DAILY_LIMIT) || 3;
      const used = limit - (status.remaining ?? 0);
      const percent = Math.min(100, Math.max(0, (used / limit) * 100));
      const filled = Math.round(percent / 10);
      const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
      let statusIcon = "🟢";
      if (percent > 50) statusIcon = "🟡";
      if (percent > 90) statusIcon = "🔴";
      return appApiJson({ ok: true, kind: "page", page: "limit", format: "markdown",
        text: APP_PAGE_LIMIT(bar, percent, used, status, limit, statusIcon),
        quota: appApiQuotaView(status, limit),
        keyboard: [
          [{ text: "🔄 بروزرسانی وضعیت", action: "refresh_limit", style: "primary" }],
          [{ text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }]
        ] });
    }
    case "cmd_contact":
      return appApiJson({ ok: true, kind: "page", page: "contact", format: "markdown",
        text: APP_PAGE_CONTACT(APP_PAYMENT_BLOCK(S.CARD_OWNER, S.CARD_NUMBER, S.SUPPORT_ID), S.DIRECT_PHONE, S.SUPPORT_ID),
        keyboard: appApiKeyboardFor("offers") });
    case "buy_consult_250":
    case "buy_docs_500":
    case "buy_draft_700":
    case "buy_subscription":
    case "support_chat":
    case "faq": {
      const pb = APP_PAYMENT_BLOCK(S.CARD_OWNER, S.CARD_NUMBER, S.SUPPORT_ID);
      const pages = {
        buy_consult_250: () => APP_PAGE_BUY_CONSULT(pb, S.DIRECT_PHONE, S.SUPPORT_ID),
        buy_docs_500: () => APP_PAGE_BUY_DOCS(pb, S.SUPPORT_ID),
        buy_draft_700: () => APP_PAGE_BUY_DRAFT(pb),
        buy_subscription: () => APP_PAGE_BUY_SUB(S.DIRECT_PHONE, S.SUPPORT_ID),
        support_chat: () => APP_PAGE_SUPPORT(S.DIRECT_PHONE, S.SUPPORT_ID),
        faq: () => APP_PAGE_FAQ(S.SUPPORT_ID, S.DIRECT_PHONE)
      };
      return appApiJson({ ok: true, kind: "page", page: action, format: "markdown", text: pages[action](), keyboard: appApiKeyboardFor("back_to_offers") });
    }
  }

  // ---------- AI actions (quota + engines) ----------
  const isAiAction = ["deep_analysis","dos_and_donts","court_simulator","interrogation_sim","financial_risk","opponent_claims","legal_opportunities"].includes(action)
    || action.startsWith("ai_act|");
  if (!isAiAction) return appApiErr("UNKNOWN_ACTION", "اقدام نامشخص است.", 400);

  const status = normalizeUserStatus(await checkUserLimit(env, user));
  if (!status.allowed)
    return appApiJson({ ok: false, code: "LIMIT", message: "🚫 اعتبار روزانه شما برای این اقدام به پایان رسیده است.", quota: appApiQuotaView(status, env.DAILY_LIMIT) });

  const originalText = String(body.contextText || "").trim() || await appApiLastModelText(env, user.id);
  if (!originalText)
    return appApiJson({ ok: false, code: "NO_CONTEXT", message: "⚠️ ابتدا یک سوال حقوقی بپرسید تا سپس تحلیل تکمیلی روی پرونده شما انجام شود." });

  await incrementUsage(env, user.id);
  const cleanOriginal = originalText.replace(/⚙️ Model[\s\S]*$/, "").trim();

  try {
    let aiText = "";
    let providerUsed = "";
    let headerTitle = "";
    let hasDynamicActions = false;

    if (action === "deep_analysis") {
      ({ text: aiText, providerUsed } = await appApiDualEngine(env, APP_PROMPT_DEEP(cleanOriginal),
        "شما کارشناس ارشد حقوقی هستید. کوتاه، صریح و مستند پاسخ دهید.", 0.10, 2000));
      headerTitle = "🔮 <b>کالبدشکافی عمیق و استراتژی دفاعی</b>";
      providerUsed = "هسته هوشمند وکیل‌جی‌پی (DeepSeek)";
      hasDynamicActions = true;
    } else if (action === "dos_and_donts") {
      aiText = await appApiGemini(env, "شما کارشناس ارشد و استراتژیست پرونده‌های حقوقی ایران هستید. بسیار صریح و کاربردی بنویسید.", APP_PROMPT_DOS_DONTS(cleanOriginal), 0.15, 1900);
      headerTitle = "🚨 <b>دستورالعمل‌های حیاتی: بایدها و نبایدهای پرونده</b>";
      providerUsed = "هسته پشتیبان وکیل‌جی‌پی";
    } else if (action === "court_simulator") {
      aiText = await appApiGemini(env, "شما کارشناس ارشد و استراتژیست پرونده‌های حقوقی ایران هستید. بسیار صریح و کاربردی بنویسید.", APP_PROMPT_COURT(cleanOriginal), 0.15, 1900);
      headerTitle = "⚖️ <b>شبیه‌ساز جلسه دادگاه و سوالات احتمالی قاضی</b>";
      providerUsed = "هسته پشتیبان وکیل‌جی‌پی";
    } else if (action === "financial_risk") {
      aiText = await appApiGemini(env, "شما کارشناس ارشد برآورد خسارت و هزینه محاکم ایران هستید. بسیار صریح و کاربردی بنویسید.", APP_PROMPT_FINANCIAL(cleanOriginal), 0.10, 2200);
      headerTitle = "📊 <b>برآورد شانس موفقیت و ریسک مالی پرونده</b>";
      providerUsed = "هسته هوشمند وکیل‌جی‌پی";
    } else if (action === "legal_opportunities") {
      aiText = await appApiGemini(env, "شما استراتژیست ارشد دادرسی و مسلط به بندهای پنهان قوانین ایران هستید. بسیار کاربردی و صریح بنویسید.", APP_PROMPT_LEGAL_OPP(cleanOriginal), 0.35, 2000);
      headerTitle = "⚖️ <b>تحلیل فرصت‌ها و تهدیدهای قانونی پرونده</b>";
      providerUsed = "هسته هوشمند وکیل‌جی‌پی";
    } else if (action === "opponent_claims" || action === "interrogation_sim") {
      const sys = action === "opponent_claims"
        ? "شما استراتژیست ارشد دادرسی محاکم ایران هستید. بسیار تهاجمی، صریح و با استناد به قانون بنویسید."
        : "شما وکیل ارشد دادرسی ایران هستید. بسیار محافظه‌کار، صریح و هوشمندانه پاسخ دهید.";
      const prompt = action === "opponent_claims" ? APP_PROMPT_OPPONENT(cleanOriginal) : APP_PROMPT_INTERROGATION(cleanOriginal);
      aiText = await appApiDeepSeek(env, sys, prompt, 0.15, 2500, 24000);
      headerTitle = action === "opponent_claims"
        ? "🔮 <b>پیش‌بینی ادعاهای حریف و پاتک حقوقی</b>"
        : "🕵️ <b>بازجویی استراتژیک (شبیه‌ساز کلانتری/دادسرا)</b>";
      providerUsed = "DeepSeek V4 Pro (Live Stream)";
      hasDynamicActions = true;
    } else if (action.startsWith("ai_act|")) {
      const actionTitle = action.split("|").slice(1).join("|").slice(0, 60);
      ({ text: aiText, providerUsed } = await appApiDualEngine(env, APP_PROMPT_DYNAMIC_ACTION(actionTitle, cleanOriginal),
        "شما کارشناس ارشد و نگارنده اوراق قضایی ایران هستید.", 0.10, 3200));
      headerTitle = `📝 <b>تنظیم پیش‌نویس: ${escapeHtml(actionTitle)}</b>`;
      providerUsed = "DeepSeek";
    }

    const { cleanAiText, dynamicActions } = hasDynamicActions
      ? appApiExtractDynamicActions(aiText)
      : { cleanAiText: aiText, dynamicActions: [] };

    const parsedSafeText = isolatedTelegramHtmlParser(cleanAiText);
    const suffix = action === "deep_analysis"
      ? `⚙️ <b>موتور پردازش:</b> <code>${providerUsed}</code>`
      : `⚙️ <i>Powered by: ${providerUsed}</i>`;
    const finalOutput = `${headerTitle}\n━━━━━━━━━━━━━━━━━━\n\n${parsedSafeText}\n\n${suffix}`;

    const rows = dynamicActions.map(b => [b]);
    rows.push([{ text: "🔙 بازگشت به منوی اصلی", action: "main_menu", style: "danger" }]);

    try {
      await saveChatHistory(env, user.id, "user", `[ACTION] ${action}`);
      await saveChatHistory(env, user.id, "model", finalOutput);
    } catch (_) {}

    const afterStatus = normalizeUserStatus(await checkUserLimit(env, user).catch(() => status));
    return appApiJson({
      ok: true, kind: "action_result", action, format: "html",
      chunks: splitByParagraphs(finalOutput, 4000),
      keyboard: rows,
      quota: appApiQuotaView(afterStatus, env.DAILY_LIMIT)
    });
  } catch (err) {
    console.error(`appApi quick-action ${action} crash:`, err);
    return appApiJson({ ok: false, code: "ENGINE_UNAVAILABLE",
      message: "❌ متاسفانه به دلیل ترافیک بالای سرورهای جهانی، ارتباط با هسته تحلیلی برقرار نشد. لطفاً چند لحظه دیگر تلاش کنید." });
  }
}

// ─────────────────────────── router ───────────────────────────

async function handleAppApi(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return appApiJson({}, 204);

  if (!env || !env.DB) return appApiErr("DB_MISSING", "پایگاه داده در دسترس نیست.", 500);

  if (url.pathname === `${APP_API_PREFIX}/health`) {
    return appApiJson({ ok: true, service: "vakil-app-api", ts: Date.now() });
  }

  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { return appApiErr("BAD_JSON", "بدنه درخواست نامعتبر است."); }
  }

  try {
    switch (`${request.method} ${url.pathname}`) {
      case "POST /api/v1/auth/verify":  return await appApiHandleVerify(env, body, request);
      case "POST /api/v1/chat":         return await appApiHandleChat(env, ctx, body);
      case "POST /api/v1/quick-action": return await appApiHandleQuickAction(env, ctx, body);
      case "POST /api/v1/history":      return await appApiHandleHistory(env, body, url);
      default: {
        // Marketplace modules (auth/lawyers/consultations/payments/admin).
        // appApiExtensions lives in app_module_common.js and returns null when no
        // module owns the path, so a build without any V1 part behaves exactly as before.
        if (typeof appApiExtensions === "function") {
          const ext = await appApiExtensions(request, env, ctx, body, url);
          if (ext) return ext;
        }
        return appApiErr("NOT_FOUND", "مسیر سرویس‌اپلیکیشن یافت نشد.", 404);
      }
    }
  } catch (fatal) {
    console.error("handleAppApi fatal:", fatal);
    return appApiErr("INTERNAL", "خطای بحرانی سرویس‌اپلیکیشن.", 500);
  }
}
