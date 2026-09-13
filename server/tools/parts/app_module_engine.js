// ───────────────────────── gateway engines (same proxy the bot uses) ─────────────────────────

function appApiGateway(env) {
  return {
    service: env.PROXY || env.Gateway || env.GEMINI_PROXY,
    host: env.GEMINI_PROXY_URL || "https://purple-bread-2b60.samerkhaldounmarefi.workers.dev",
    headers: {
      "Content-Type": "application/json",
      "Authorization": env.PROXY_SECRET_TOKEN ? `Bearer ${env.PROXY_SECRET_TOKEN}` : ""
    }
  };
}

async function appApiGatewayFetch(env, localPath, body, timeoutMs) {
  const g = appApiGateway(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (g.service && typeof g.service.fetch === "function") {
      return await g.service.fetch(`http://localhost${localPath}`, { method: "POST", headers: g.headers, body: JSON.stringify(body), signal: controller.signal });
    }
    return await fetch(`${g.host}${localPath}`, { method: "POST", headers: g.headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function appApiGemini(env, systemText, userText, temperature = 0.3, maxOutputTokens = 2000, timeoutMs = 22000) {
  const key = await getActiveGeminiKey(env); // D1 gemini_api_keys cluster — same source as bot
  const res = await appApiGatewayFetch(env, "/v1/gemini/generate", {
    key,
    model: "gemini-2.5-flash-lite",
    payload: {
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature, maxOutputTokens }
    }
  }, timeoutMs);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    try { await res.body?.cancel(); } catch {}
    throw new Error(`GEMINI_GATEWAY_HTTP_${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "GEMINI_GATEWAY_FAILED");
  const text = data.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) throw new Error("EMPTY_GEMINI_RESPONSE");
  return text;
}

async function appApiDeepSeek(env, systemText, userText, temperature = 0.15, maxTokens = 2200, timeoutMs = 14000) {
  const res = await appApiGatewayFetch(env, "/v1/openrouter/generate", {
    model: "deepseek/deepseek-v4-flash",
    payload: {
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: userText }
      ],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    }
  }, timeoutMs);
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`OPENROUTER_GATEWAY_HTTP_${res.status}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "OPENROUTER_GATEWAY_FAILED");
  const text = data.data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error("EMPTY_OPENROUTER_RESPONSE");
  return text;
}

// Dual engine exactly like executeDeepAnalysis (DeepSeek first, Gemini fallback)
async function appApiDualEngine(env, userPrompt, sys, temperature, maxTokens) {
  const provider = "هسته هوشمند وکیل‌جی‌پی (DeepSeek)";
  try {
    const text = await appApiDeepSeek(env, sys, userPrompt, temperature, maxTokens, 14000);
    return { text, providerUsed: provider };
  } catch (e) {
    console.warn("appApi DeepSeek failed, falling back to Gemini:", e.message);
    const text = await appApiGemini(env, sys, userPrompt, temperature, maxTokens, 22000);
    return { text, providerUsed: provider };
  }
}
