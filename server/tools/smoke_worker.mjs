// INTEGRATION smoke test — exercises the BUILT SINGLE-FILE worker (real bot code
// + app module). Only external services are faked (Google gateway fetch, KV,
// Telegram admin logs). Everything else runs verbatim: token auth, D1 quota,
// registration, cluster key selection, engine pipeline, JSON capsule parsing,
// history persistence, drafting mode, quick-action engines + dynamic buttons.
import fs from 'fs';

const src = fs.readFileSync(new URL('../dist/worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// ───────────────────────────── D1 stub ─────────────────────────────
const tehranToday = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const m = {}; p.forEach(x => m[x.type] = x.value);
  return `${m.year}-${m.month}-${m.day}`;
};
const db = { users: {}, tokens: {}, history: {}, devices: {}, keys: [] };
const d1 = {
  prepare(sql) { return { _sql: sql.replace(/\s+/g, ' ').trim(), bind(...a) { this._a = a; return this; },
    async first() { return firstResult(this); }, async all() { return allResult(this); }, async run() { return runResult(this); } }; }
};

function firstResult(q) {
  const s = q._sql, a = q._a || [];
  if (s.startsWith('SELECT * FROM users WHERE user_id')) return db.users[a[0]] || null;
  if (s.startsWith('SELECT mode, draft_data FROM users WHERE user_id')) return db.users[a[0]] || null;
  if (s.includes('FROM app_devices WHERE device_id')) return db.devices[a[0]] || null;
  if (s.includes('SELECT user_id FROM app_devices')) return db.devices[a[0]] || null;
  if (s.includes('SELECT user_id FROM users WHERE user_id')) return db.users[a[0]] ? { user_id: a[0] } : null;
  if (s.includes('FROM gemini_api_keys') && s.includes("status = 'active'")) {
    const k = db.keys.find(x => x.status === 'active');
    return k ? { id: 1, key_value: k.key_value, health_score: 95, last_used: 0, total_requests: 0, total_failures: 0 } : null;
  }
  if (s.includes('SELECT key_value FROM gemini_api_keys')) {
    const k = db.keys.find(x => x.status === 'active');
    return k ? { key_value: k.key_value } : null;
  }
  if (s.includes('FROM chat_history') && s.includes("role = 'model'")) {
    const list = (db.history[a[0]] || []).filter(x => x.role === 'model');
    return list.length ? list[list.length - 1] : null;
  }
  if (s.includes('FROM app_tokens t JOIN users u')) {
    const t = db.tokens[a[0]];
    if (!t) return null;
    return { user_id: t.user_id, is_banned: db.users[t.user_id]?.is_banned ? 1 : 0 };
  }
  return null;
}

function allResult(q) {
  const s = q._sql, a = q._a || [];
  if (s.includes('FROM chat_history WHERE user_id')) return { results: (db.history[a[0]] || []).slice(-40).reverse ? [...(db.history[a[0]] || [])].slice(-40).reverse() : [] };
  if (s.includes('FROM gemini_api_keys')) return { results: db.keys.filter(k => k.status === 'active').map((k, i) => ({ id: i + 1, key_value: k.key_value, health_score: 90, last_used: 0, total_requests: 0, total_failures: 0, cooldown_until: null })) };
  return { results: [] };
}

function runResult(q) {
  const s = q._sql, a = q._a || [];
  if (s.startsWith('INSERT INTO users') || s.startsWith('INSERT OR IGNORE INTO users')) {
    const id = String(a[0]);
    if (!db.users[id]) db.users[id] = { user_id: id, message_count: 0, last_interaction_date: tehranToday(), is_banned: 0, mode: 'normal', draft_data: '', first_name: a[2] ?? 'App', username: a[1] ?? '', image_count_today: 0, image_count_today_today: 0 };
  }
  if (s.includes('UPDATE users SET message_count = message_count + 1')) { const u = db.users[String(a[0])]; if (u) u.message_count++; }
  if (s.includes('UPDATE users SET mode')) {
    if (s.includes("mode = 'normal'")) { const u = db.users[String(a[0])]; if (u) { u.mode = 'normal'; u.draft_data = ''; } }
    else { const [mode, dd, uid] = a; const u = db.users[String(uid)]; if (u) { u.mode = mode; u.draft_data = dd; } }
  }
  if (s.includes('SET draft_data = ?')) { const [dd, uid] = a; const u = db.users[String(uid)]; if (u) u.draft_data = dd; }
  if (s.includes('UPDATE users SET message_count = 0')) { const u = db.users[String(a[a.length-1])]; if (u) { u.message_count = 0; u.last_interaction_date = a[0]; } }
  if (s.includes('INSERT OR REPLACE INTO app_tokens')) { const [h, did, uid, iat, exp] = a; db.tokens[h] = { token_hash: h, device_id: did, user_id: uid, created_at: iat, expires_at: exp }; }
  if (s.includes('INSERT INTO app_devices') || s.includes('INSERT OR IGNORE INTO app_devices')) { const [did, uid] = a; db.devices[did] = { device_id: did, user_id: uid }; }
  if (s.startsWith('INSERT INTO chat_history')) { const [uid, role, content, ts] = a; (db.history[String(uid)] = db.history[String(uid)] || []).push({ role, content, created_at: ts }); }
  if (s.startsWith('DELETE FROM chat_history')) { /* keep all in test */ }
  if (s.includes('UPDATE gemini_api_keys')) { /* health bookkeeping no-op */ }
  return { meta: { changes: 1 }, success: true };
}

// ───────────────────────────── KV stub ─────────────────────────────
const kvStore = new Map();
const KV = {
  async get(k, type) { const v = kvStore.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { kvStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { kvStore.delete(k); }
};

// ───────────────────────────── fetch intercept ─────────────────────────────
const originalFetch = globalThis.fetch;
const gatewayCalls = [];
let engineReplyText = JSON.stringify({ response: { topic: 'موضوع تست', legal_analysis: 'تحلیل تست', conclusion_and_solution: 'راهکار تست', disclaimer: 'هشدار تست' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  if (u.includes('/v1/openrouter/')) {
    return new Response(JSON.stringify({ success: true, data: { choices: [{ message: { content: 'DEEPSEEK: تحلیل عمیق <b>پاسخ</b> [ACTION:تنظیم لایحه دفاعیه پرونده تستی]' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('generativelanguage')) {
    // raw Google API shape (used by processDraftingWithGemini's direct fetch)
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '📄 سند آزمایشی: بسمه تعالی — پیش‌نویس لایحه تست' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('purple-bread')) {
    const body = JSON.parse(opts.body || '{}');
    gatewayCalls.push({ url: u.slice(0, 60), key: body.key });
    return new Response(JSON.stringify({ success: true, data: { candidates: [{ content: { parts: [{ text: engineReplyText }] } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(url, opts);
};

const worker = mod.default;
const env = {
  GEMINI_API_KEY: 'AIzaTESTFALLBACKKEY12345',
  DB: d1, KV, AI: { run: async () => ({}) },
  TELEGRAM_BOT_TOKEN: '123:test-token',
  WEBHOOK_SECRET_PATH: 'secret-path',
  APP_TOKEN_SECRET: 'integration-test-secret-0123456789',
  APP_CHANNEL_CODE: 'VAKIL-2026',
  DAILY_LIMIT: '3',
  GEMINI_PROXY_URL: 'https://purple-bread-2b60.samerkhaldounmarefi.workers.dev',
  PROXY_SECRET_TOKEN: 'proxy-test-token'
};
// active key cluster row in D1 (what the bot uses)
db.keys.push({ key_value: 'AIzaD1CLUSTERKEY0001', status: 'active' });

const ctx = { waitUntil: (p) => { p.catch(() => {}); } };

const post = (path, body) => worker.fetch(new Request('https://vakil-app.test' + path, { method: 'POST', body: JSON.stringify(body) }), env, ctx);
const get = (path) => worker.fetch(new Request('https://vakil-app.test' + path), env, ctx);

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => { cond ? (pass++, console.log('PASS', name)) : (fail++, console.log('FAIL', name, extra)); };

// 1. health via the REAL fetch handler (route hook works, webhook check bypassed)
let r = await get('/api/v1/health'); let j = await r.json();
T('health through worker.fetch', j.ok === true && j.service === 'vakil-app-api');

// 2. bot GET / still works (bot untouched)
r = await get('/');
T('bot health root intact', r.status === 200 && (await r.text()).includes('Lawyer System'));

// 3. unauthorized webhook POST still 403 (security intact)
r = await worker.fetch(new Request('https://vakil-app.test/webhook/wrong-path', { method: 'POST', body: '{}' }), env, ctx);
T('webhook guard intact', r.status === 403);

// 4. verify
r = await post('/api/v1/auth/verify', { deviceId: 'integration-device-01', code: 'VAKIL-2026', name: 'مریم', platform: 'android' });
j = await r.json();
T('verify ok + user registered', j.ok === true && typeof j.token === 'string' && db.users[String(j.userId)] !== undefined, JSON.stringify(j).slice(0, 140));
const token = j.token;

// 5. chat through the REAL cluster engine (processWithGemini → executeApiCall → D1 key)
r = await post('/api/v1/chat', { token, text: 'اینجانب چکی به مبلغ ۱۰۰ میلیون تومان دارم که در تاریخ ۱۴۰۳/۰۳/۲۰ به دلیل کسری موجودی برگشت خورده است. دارنده چک تهدید به شکایت کیفری کرده؛ آیا امکان جلب وجود دارد؟' });
j = await r.json();
T('chat 200', j.ok === true, JSON.stringify(j).slice(0, 200));
T('chat structured capsule parsed (html)', j.format === 'html' && j.chunks[0].includes('⚖️ موضوع'));
T('engine used D1 cluster key', gatewayCalls.length > 0 && gatewayCalls.some(c => c.key === 'AIzaD1CLUSTERKEY0001'), JSON.stringify(gatewayCalls.slice(-2)));
T('chat keyboard exact 8 rows', j.keyboard.length === 8 && j.keyboard[7][0].text.includes('بازگشت به منوی اصلی'));
T('quota used 1', j.quota.remaining === 2, JSON.stringify(j.quota));
const uid = String(j.userId ?? Object.keys(db.history)[0]);
T('chat_history persisted user+model', (db.history[Object.keys(db.history)[0]] || []).length === 2);

// 6. plain-text answer path (not JSON)
engineReplyText = '<b>⚖️ موضوع</b>\nپاسخ متنی ساده\n\n<b>📚 تحلیل حقوقی</b>\nتحلیل\n\n<b>✅ نتیجه‌گیری و راهکار</b>\nنتیجه\n\n⚠️ <i>هشدار تست</i>';
r = await post('/api/v1/chat', { token, text: 'یک قرارداد اجاره آپارتمان یک ساله دارم که مستاجر اجاره را پرداخت نمی‌کند و به ملک هم آسیب زده، چگونه می‌توانم تخلیه بگیرم و خسارت را مطالبه کنم؟' });
j = await r.json();
T('plain answer format markdown', j.ok === true && j.format === 'markdown' && j.chunks[0].includes('موضوع'), JSON.stringify(j).slice(0, 160));

// 7. quick action deep_analysis (dual engine: OpenRouter stub returns [ACTION:])
r = await post('/api/v1/quick-action', { token, action: 'deep_analysis' });
j = await r.json();
T('deep_analysis ok', j.ok === true && j.chunks[0].includes('کالبدشکافی عمیق'), JSON.stringify(j).slice(0, 160));
const dyn = j.keyboard.find(row => row[0].action?.startsWith('ai_act|'));
T('dynamic AI button extracted', !!dyn, JSON.stringify(j.keyboard));

// 8. quota exhausted after 3 charges (chat, chat, deep) — 4th AI action blocked
r = await post('/api/v1/quick-action', { token, action: dyn[0].action });
j = await r.json();
T('limit enforced on ai_act (4th)', j.ok === false && j.code === 'LIMIT', JSON.stringify(j).slice(0, 120));
r = await post('/api/v1/quick-action', { token, action: 'financial_risk' });
j = await r.json();
T('limit enforced on quick-action', j.ok === false && j.code === 'LIMIT');

// 10. static pages don't need quota and don't charge
r = await post('/api/v1/quick-action', { token, action: 'cmd_help' }); j = await r.json();
T('help page while limited', j.ok === true && j.text.includes('راهنمای جامع'));

// 11. drafting on a FRESH device (drafting not charged; quota only gates entry)
r = await post('/api/v1/auth/verify', { deviceId: 'integration-device-02', code: 'VAKIL-2026' });
j = await r.json();
const token2 = j.token;
T('second device verify', j.ok === true && typeof token2 === 'string');
r = await post('/api/v1/quick-action', { token: token2, action: 'cmd_drafting' }); j = await r.json();
T('draft enter', j.ok === true && j.text.includes('بسمه تعالی'));
r = await post('/api/v1/chat', { token: token2, text: 'شکواییه — خیانت در امانت ماشین‌آلات کارگاهی' });
j = await r.json();
T('drafting answer', j.ok === true && j.kind === 'drafting' && j.keyboard[0][0].action === 'cancel_drafting', JSON.stringify(j).slice(0, 120));
r = await post('/api/v1/chat', { token: token2, text: 'لغو' });
j = await r.json();
T('draft cancel', j.ok === true && j.kind === 'draft_cancelled');
// ai_act works on fresh quota (explicit context since new device has no history)
r = await post('/api/v1/quick-action', { token: token2, action: 'deep_analysis', contextText: 'متن پرونده آزمایشی دستگاه دوم برای تحلیل عمیق' }); j = await r.json();
const dyn2 = j.keyboard.find(row => row[0].action?.startsWith('ai_act|'));
r = await post('/api/v1/quick-action', { token: token2, action: dyn2[0].action }); j = await r.json();
T('ai_act draft doc ok (fresh quota)', j.ok === true && j.chunks[0].includes('تنظیم پیش‌نویس'), JSON.stringify(j).slice(0, 120));

// 12. history mirror
r = await post('/api/v1/history', { token }); j = await r.json();
T('history mirror', j.ok === true && Array.isArray(j.items) && j.items.length >= 2);

// 13. tampered token + foreign token rejected
r = await post('/api/v1/chat', { token: token.slice(0, -1) + 'x', text: 'تست اعتبارسنجی امنیتی برای رد شدن توکن دستکاری‌شده' });
T('tampered token 401', r.status === 401);

// 14. CORS preflight
r = await worker.fetch(new Request('https://vakil-app.test/api/v1/chat', { method: 'OPTIONS' }), env, ctx);
T('CORS preflight', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*');

console.log(`\nINTEGRATION RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
