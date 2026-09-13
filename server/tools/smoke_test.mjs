// Smoke test: run app_api.js router with stubbed bot globals (Node >=20)
import fs from 'fs';

const src = fs.readFileSync(new URL('./app_api.js', import.meta.url), 'utf8');

// ---- DB stub (D1-like) ----
const db = { users: {}, tokens: {}, history: {}, devices: {} };
const dbStub = {
  prepare(sql) {
    this._sql = sql;
    return this;
  },
  bind(...args) { this._args = args; return this; },
  async first() {
    const s = this._sql.replace(/\s+/g, ' ');
    if (s.includes('FROM users WHERE user_id')) return db.users[this._args[0]] || null;
    if (s.includes('FROM app_devices')) return db.devices[this._args[0]] || null;
    if (s.includes('FROM chat_history')) {
      const uid = this._args[0];
      const list = (db.history[uid] || []).filter(x => x.role === 'model');
      return list.length ? list[list.length - 1] : null;
    }
    if (s.includes('FROM app_tokens')) {
      const t = db.tokens[this._args[0]];
      return t ? { ...t, is_banned: 0 } : null;
    }
    return null;
  },
  async all() {
    const s = this._sql.replace(/\s+/g, ' ');
    if (s.includes('FROM chat_history')) {
      const uid = this._args[0];
      return { results: (db.history[uid] || []).slice(-40) };
    }
    return { results: [] };
  },
  async run() {
    const s = this._sql.replace(/\s+/g, ' ');
    if (s.startsWith('INSERT INTO users') || s.startsWith('INSERT OR IGNORE INTO users')) {
      const [id] = this._args;
      if (!db.users[id]) db.users[id] = { user_id: id, message_count: 0, last_interaction_date: '2020', is_banned: 0, mode: 'normal', draft_data: '', first_name: 'App', username: '' };
    }
    if (s.includes('UPDATE users SET message_count = message_count + 1')) {
      const u = db.users[this._args[0]]; if (u) u.message_count++;
    }
    if (s.includes("SET mode = 'normal', draft_data = ''")) {
      const u = db.users[this._args[0]];
      if (u) { u.mode = 'normal'; u.draft_data = ''; }
    }
    if (s.includes('SET draft_data = ?')) {
      const [draft, uid] = this._args;
      const u = db.users[uid];
      if (u) u.draft_data = draft;
    }
    if (s.includes('SET mode = ?, draft_data = ?')) {
      const [mode, draft, uid] = this._args;
      const u = db.users[uid];
      if (u) { u.mode = mode; u.draft_data = draft; }
    }
    if (s.includes('INSERT OR REPLACE INTO app_tokens')) {
      const [h, did, uid, iat, exp] = this._args;
      db.tokens[h] = { token_hash: h, device_id: did, user_id: uid, created_at: iat, expires_at: exp };
      if (!db.users[uid]) db.users[uid] = { user_id: uid, message_count: 0, last_interaction_date: '2020', is_banned: 0, mode: 'normal', draft_data: '', first_name: 'App', username: '' };
    }
    if (s.includes('INSERT OR IGNORE INTO app_devices')) {
      const [did, uid] = this._args;
      db.devices[did] = { device_id: did, user_id: uid };
    }
    if (s.includes('INSERT INTO chat_history')) {
      const [uid, role, content] = this._args;
      (db.history[uid] = db.history[uid] || []).push({ role, content, created_at: Date.now() });
    }
    if (s.includes('UPDATE users SET username') || s.includes('UPDATE users SET phone')) {}
    return { meta: { changes: 1 } };
  }
};

// ---- bot globals stubs (same signatures as worker.js) ----
globalThis.SYSTEM_PROMPT = 'SYS';
globalThis.getActiveGeminiKey = async () => 'AIzaTEST';
globalThis.checkUserLimit = async (env, user) => {
  const u = db.users[user.id] || (db.users[user.id] = { user_id: user.id, message_count: 0, is_banned: 0, mode: 'normal', draft_data: '' });
  if (u.is_banned) return { allowed: false, reason: '🚫 حساب کاربری شما مسدود شده است.' };
  const limit = 3;
  const remaining = Math.max(0, limit - (u.message_count || 0));
  if (remaining <= 0) return { allowed: false, reason: '⚠️ سهمیه روزانه شما تمام شده است.' };
  return { allowed: true, remaining };
};
globalThis.normalizeUserStatus = (v) => ({ allowed: v.allowed !== false, remaining: v.remaining ?? null, reason: v.reason || null });
globalThis.incrementUsage = async (env, id) => { const u = db.users[id]; if (u) u.message_count = (u.message_count || 0) + 1; };
globalThis.incrementImageUsage = async () => {};
globalThis.checkImageLimit = async () => true;
globalThis.validateInputContent = (t) => ({ valid: String(t || '').trim().length >= 10 });
globalThis.saveChatHistory = async (env, uid, role, content) => {
  (db.history[uid] = db.history[uid] || []).push({ role, content, created_at: Date.now() });
};
globalThis.getTehranTodayDate = () => '2026-09-13';
globalThis.isolatedTelegramHtmlParser = (t) => String(t);
globalThis.splitByParagraphs = (t) => [t];
globalThis.escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
globalThis.clampInt = (v, a, b, f) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(b, Number(v))) : f);
globalThis.getGreeting = () => 'صبح بخیر ☀️';
globalThis.processDraftingWithGemini = async (env, text) => '📄 سند: ' + text;
globalThis.processWithGemini = async (env, text) =>
  JSON.stringify({ response: { topic: 'موضوع تست', legal_analysis: 'تحلیل تست', conclusion_and_solution: 'نتیجه تست', disclaimer: 'هشدار تست' } });
globalThis.buildGeminiPayload = (t) => ({ contents: [{ role: 'user', parts: [{ text: t }] }] });

// gateway stub: env.PROXY service binding with fetch
function makeGateway(handlers) {
  return {
    fetch: async (url, opts) => {
      const path = new URL(url).pathname;
      const h = handlers[path];
      if (!h) return new Response('no route', { status: 404 });
      return h(JSON.parse(opts.body));
    }
  };
}

const env = {
  DB: dbStub,
  APP_TOKEN_SECRET: 'test-secret',
  APP_CHANNEL_CODE: 'VAKIL-2026',
  DAILY_LIMIT: '3',
  PROXY: makeGateway({
    '/v1/openrouter/generate': () => new Response(JSON.stringify({ success: true, data: { choices: [{ message: { content: 'DEEPSEEK_ANALYSIS [ACTION:تنظیم لایحه دفاعیه تست]' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/v1/gemini/generate': () => new Response(JSON.stringify({ success: true, data: { candidates: [{ content: { parts: [{ text: '<b>GEMINI_ANALYSIS</b>' }] } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
};

// import app_api via dynamic data-URL module so stubs above are visible
const modSrc = src.replace('/* eslint-disable no-undef */', '/* eslint-disable no-undef */\n' +
  'const g = globalThis;\n' +
  'const SYSTEM_PROMPT=g.SYSTEM_PROMPT, getActiveGeminiKey=g.getActiveGeminiKey, checkUserLimit=g.checkUserLimit, normalizeUserStatus=g.normalizeUserStatus, incrementUsage=g.incrementUsage, incrementImageUsage=g.incrementImageUsage, checkImageLimit=g.checkImageLimit, validateInputContent=g.validateInputContent, saveChatHistory=g.saveChatHistory, isolatedTelegramHtmlParser=g.isolatedTelegramHtmlParser, splitByParagraphs=g.splitByParagraphs, escapeHtml=g.escapeHtml, clampInt=g.clampInt, getGreeting=g.getGreeting, processDraftingWithGemini=g.processDraftingWithGemini, processWithGemini=g.processWithGemini, buildGeminiPayload=g.buildGeminiPayload;\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(modSrc).toString('base64'));
const { handleAppApi } = mod;

const post = (path, body) => handleAppApi(new Request('https://vakil.test' + path, { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil: () => {} });
const get = (path) => handleAppApi(new Request('https://vakil.test' + path), env, { waitUntil: () => {} });

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

// health
let r = await get('/api/v1/health'); let j = await r.json();
T('health', j.ok === true);

// verify: bad code rejected
r = await post('/api/v1/auth/verify', { deviceId: 'device-123456', code: 'WRONG-CODE' }); j = await r.json();
T('verify bad code 403', r.status === 403 && j.ok === false);

// verify: ok
r = await post('/api/v1/auth/verify', { deviceId: 'device-123456', code: 'VAKIL-2026', name: 'سارا', platform: 'android' });
j = await r.json();
T('verify ok', j.ok === true && typeof j.token === 'string' && j.quota.remaining === 3, JSON.stringify(j).slice(0, 120));
const token = j.token;

// tampered token rejected
r = await post('/api/v1/chat', { token: token.slice(0, -2) + 'zz', text: 'سلام من چکی拿به مبلغ ۱۰۰ میلیون برگ زده شده است لطفا راهنمایی کنید' });
j = await r.json();
T('tampered token 401', r.status === 401);

// chat: too short
r = await post('/api/v1/chat', { token, text: 'кوتاه' });
j = await r.json();
T('chat validation short', j.ok === false && j.code === 'VALIDATION' && j.message.includes('تحلیل دقیق حقوقی'));

// chat: normal → structured JSON capsule path
r = await post('/api/v1/chat', { token, text: 'اینجانب چکی به مبلغ ۱۰۰ میلیون تومان دارم که در تاریخ ۱۴۰۳/۰۳/۲۰ برگ خورده است، آیا امکان شکایت کیفری هست؟' });
j = await r.json();
T('chat ok', j.ok === true && j.format === 'html' && j.chunks[0].includes('⚖️ موضوع'), JSON.stringify(j).slice(0, 150));
T('chat keyboard exact', j.keyboard.length === 8 && j.keyboard[0][0].text.includes('تحلیل عمیق'));
T('chat quota decremented', j.quota.remaining === 2, JSON.stringify(j.quota));

// history mirror
r = await post('/api/v1/history', { token }); j = await r.json();
T('history', j.ok === true && j.items.length === 2 && j.items.some(x => x.role === 'user') && j.items.some(x => x.role === 'model'));

// quick action: main_menu page
r = await post('/api/v1/quick-action', { token, action: 'main_menu' }); j = await r.json();
T('action main_menu', j.ok === true && j.text.includes('پیشخوان جامع خدمات حقوقی') && j.keyboard.length === 3);

// quick action: help/terms static
r = await post('/api/v1/quick-action', { token, action: 'cmd_help' }); j = await r.json();
T('action help', j.ok === true && j.text.includes('راهنمای جامع استفاده'));
r = await post('/api/v1/quick-action', { token, action: 'cmd_terms' }); j = await r.json();
T('action terms accept btn', j.ok === true && j.keyboard[0][0].text.includes('می‌پذیرم'));

// contact pages (exact worker behavior: contact page lists packages + direct phone; card number is on the buy_* subpages)
r = await post('/api/v1/quick-action', { token, action: 'cmd_contact' }); j = await r.json();
T('action contact', j.ok === true && j.text.includes('250,000') && j.text.includes('09016807808'));
r = await post('/api/v1/quick-action', { token, action: 'buy_consult_250' }); j = await r.json();
T('action buy_consult card block', j.ok === true && j.text.includes('6219861837282945') && j.text.includes('رضا جسارتی'));

// drafting flow
r = await post('/api/v1/quick-action', { token, action: 'cmd_drafting' }); j = await r.json();
T('drafting enter', j.ok === true && j.text.includes('بسمه تعالی') && j.keyboard[0][0].action === 'cancel_drafting');
r = await post('/api/v1/chat', { token, text: 'قرارداد — اجاره آپارتمان یک‌ساله با مبلغ رهن' });
j = await r.json();
T('drafting message', j.ok === true && j.kind === 'drafting' && j.text.includes('📄 سند'));
r = await post('/api/v1/chat', { token, text: 'لغو' });
j = await r.json();
T('drafting cancel', j.ok === true && j.kind === 'draft_cancelled');

// AI quick action with dynamic buttons (deep_analysis → stub DeepSeek returns [ACTION])
r = await post('/api/v1/quick-action', { token, action: 'deep_analysis' }); j = await r.json();
T('deep_analysis', j.ok === true && j.chunks[0].includes('کالبدشکافی عمیق'), JSON.stringify(j).slice(0, 160));
T('dynamic action button', j.keyboard.some(row => row[0].action && row[0].action.startsWith('ai_act|')));
const dynBtn = j.keyboard.find(row => row[0].action && row[0].action.startsWith('ai_act|'))[0];

// ai_act follow-up
r = await post('/api/v1/quick-action', { token, action: dynBtn.action }); j = await r.json();
T('ai_act runs', j.ok === true && j.chunks[0].includes('تنظیم پیش‌نویس'));

// limit exhaustion: 2 used so far (chat + deep_analysis) + ai_act = 3 → next blocked
r = await post('/api/v1/chat', { token, text: 'آیا در مورد فسخ قرارداد اجاره نیاز به توضیح بیشتری هست برای تحلیل حقوقی دقیق؟' });
j = await r.json();
T('limit reached on 4th', j.ok === false && j.code === 'LIMIT', JSON.stringify(j).slice(0, 120));

// unknown action
r = await post('/api/v1/quick-action', { token, action: 'hack_attempt' }); j = await r.json();
T('unknown action 400', r.status === 400);

// 2nd device same code
r = await post('/api/v1/auth/verify', { deviceId: 'device-999999', code: 'VAKIL-2026' }); j = await r.json();
T('second device distinct user', j.ok === true && j.userId !== undefined && j.userId !== null);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
