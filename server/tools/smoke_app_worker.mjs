// Smoke test for the STANDALONE APP WORKER (dist/vakil-app-worker.js).
// Real engine path: D1 gemini_api_keys cluster selection, KV sticky/lease/
// cooldown, executeApiCall via gateway root POST, turbo failover — with the
// gateway + Telegram-admin faked only.
import fs from 'fs';

const src = fs.readFileSync(new URL('../dist/vakil-app-worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

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
  if (s.startsWith('SELECT * FROM users WHERE user_id')) return db.users[String(a[0])] || null;
  if (s.startsWith('SELECT mode, draft_data FROM users')) return db.users[String(a[0])] || null;
  if (s.includes('FROM app_devices WHERE device_id')) return db.devices[a[0]] || null;
  if (s.includes('SELECT user_id FROM users WHERE user_id')) return db.users[String(a[0])] ? { user_id: a[0] } : null;
  if (s.includes('FROM gemini_api_keys') && s.includes("LIMIT 1")) {
    const k = db.keys.find(x => x.status === 'active');
    return k ? { key_value: k.key_value } : null;
  }
  if (s.includes('FROM chat_history') && s.includes("role = 'model'")) {
    const list = (db.history[String(a[0])] || []).filter(x => x.role === 'model');
    return list.length ? list[list.length - 1] : null;
  }
  if (s.includes('FROM app_tokens t JOIN users u')) {
    const t = db.tokens[a[0]];
    return t ? { user_id: t.user_id, is_banned: db.users[String(t.user_id)]?.is_banned ? 1 : 0 } : null;
  }
  return null;
}

function allResult(q) {
  const s = q._sql, a = q._a || [];
  if (s.includes('FROM chat_history WHERE user_id')) return { results: [...(db.history[String(a[0])] || [])].reverse().slice(0, 40).reverse() };
  if (s.includes('FROM gemini_api_keys')) {
    const now = Date.now();
    return { results: db.keys.filter(k => k.status === 'active' || (k.cooldown_until && k.cooldown_until < now)).slice(0, 12).map((k, i) => ({
      key_value: k.key_value, status: 'active', usage_count: k.usage_count || 0, error_count: 0, last_used: k.last_used || 0,
      cooldown_until: 0, health_score: 80 - i, consecutive_429: 0, consecutive_failures: 0, last_429_at: 0, last_error_at: 0,
      ewma_latency_ms: 900 + i * 100, lease_until: 0, lease_id: ''
    })) };
  }
  return { results: [] };
}

function runResult(q) {
  const s = q._sql, a = q._a || [];
  if (s.startsWith('INSERT INTO users') || s.startsWith('INSERT OR IGNORE INTO users')) {
    const id = String(a[0]);
    if (!db.users[id]) db.users[id] = { user_id: id, message_count: 0, last_interaction_date: tehranToday(), is_banned: 0, mode: 'normal', draft_data: '', first_name: 'App', username: '' };
  }
  if (s.includes('UPDATE users SET message_count = message_count + 1')) { const u = db.users[String(a[0])]; if (u) u.message_count++; }
  if (s.includes("SET mode = 'normal', draft_data = ''")) { const u = db.users[String(a[0])]; if (u) { u.mode = 'normal'; u.draft_data = ''; } }
  if (s.includes('SET draft_data = ?')) { const [dd, uid] = a; const u = db.users[String(uid)]; if (u) u.draft_data = dd; }
  if (s.includes('SET mode = ?, draft_data = ?')) { const [mode, dd, uid] = a; const u = db.users[String(uid)]; if (u) { u.mode = mode; u.draft_data = dd; } }
  if (s.includes('INSERT OR REPLACE INTO app_tokens')) { const [h, did, uid, iat, exp] = a; db.tokens[h] = { device_id: did, user_id: uid, expires_at: exp }; if (!db.users[String(uid)]) db.users[String(uid)] = { user_id: uid, message_count: 0, last_interaction_date: tehranToday(), is_banned: 0, mode: 'normal', draft_data: '' }; }
  if (s.includes('INTO app_devices')) { const [did, uid] = a; db.devices[did] = { device_id: did, user_id: uid }; }
  if (s.startsWith('INSERT INTO chat_history')) { const [uid, role, content, ts] = a; (db.history[String(uid)] = db.history[String(uid)] || []).push({ role, content, created_at: ts }); }
  if (s.startsWith('UPDATE gemini_api_keys')) {
    const key = a[a.length - 1];
    const k = db.keys.find(x => x.key_value === key);
    if (k) {
      if (s.includes("status = 'active'")) { k.usage_count = (k.usage_count || 0) + 1; k.last_used = Date.now(); }
    }
  }
  if (s.includes('DELETE FROM app_tokens')) {}
  return { meta: { changes: 1 }, success: true };
}

const kvStore = new Map();
const KV = {
  async get(k, type) { const v = kvStore.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { kvStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { kvStore.delete(k); }
};

const originalFetch = globalThis.fetch;
const gatewayHits = [];
let engineMode = 'structured';

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (u.includes('openrouter')) {
    return new Response(JSON.stringify({ success: true, data: { choices: [{ message: { content: 'DEEPSEEK <b>تحلیل</b> [ACTION:تنظیم لایحه دفاعیه پرونده تست]' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('generativelanguage')) {
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '📄 بسمه تعالی — سند تست' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('purple-bread')) {
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    gatewayHits.push(body.key);
    const text = engineMode === 'structured'
      ? JSON.stringify({ response: { topic: 'تست', legal_analysis: 'تحلیل', conclusion_and_solution: 'راهکار', disclaimer: 'هشدار' } })
      : '<b>⚖️ موضوع</b>\nمتن ساده';
    return new Response(JSON.stringify({ success: true, data: { candidates: [{ content: { parts: [{ text }] } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(url, opts);
};

// seed 5 active keys in D1 cluster (scale: 500 in production)
for (let i = 0; i < 5; i++) db.keys.push({ key_value: `AIzaCLUSTERKEY000${i}`, status: 'active', usage_count: 0, last_used: 0 });

const env = {
  DB: d1, KV,
  APP_TOKEN_SECRET: 'app-worker-test-secret',
  APP_CHANNEL_CODE: 'VAKIL-APP-1405',
  DAILY_LIMIT: '3',
  GEMINI_PROXY_URL: 'https://purple-bread-2b60.samerkhaldounmarefi.workers.dev',
  PROXY_SECRET_TOKEN: 'x'
};
const ctx = { waitUntil: (p) => p.catch(() => {}) };

const post = (path, body) => worker.fetch(new Request('https://vakil-app.test' + path, { method: 'POST', body: JSON.stringify(body) }), env, ctx);
const get = (path) => worker.fetch(new Request('https://vakil-app.test' + path), env, ctx);

let pass = 0, fail = 0;
const T = (n, c, e = '') => { c ? (pass++, console.log('PASS', n)) : (fail++, console.log('FAIL', n, e)); };

let r = await get('/api/v1/health'); let j = await r.json();
T('health', j.ok === true);
r = await get('/');
T('root banner', r.status === 200 && (await r.text()).includes('App API'));
r = await worker.fetch(new Request('https://vakil-app.test/webhook/anything', { method: 'POST', body: '{}' }), env, ctx);
T('no telegram surface (404)', r.status === 404);

r = await post('/api/v1/auth/verify', { deviceId: 'appdev-0001', code: 'WRONG', name: 'test' });
T('bad code 403', r.status === 403);
r = await post('/api/v1/auth/verify', { deviceId: 'appdev-0001', code: 'VAKIL-APP-1405', name: 'مریم', platform: 'android' });
j = await r.json();
T('verify ok', j.ok === true && typeof j.token === 'string');
const token = j.token;

r = await post('/api/v1/chat', { token, text: 'اینجانب چکی به مبلغ ۱۰۰ میلیون تومان دارم که در تاریخ ۱۴۰۳/۰۳/۲۰ به دلیل کسری موجودی برگشت خورده است؛ آیا امکان شکایت کیفری و جلب وجود دارد؟' });
j = await r.json();
T('chat ok via REAL cluster engine', j.ok === true && j.format === 'html', JSON.stringify(j).slice(0, 180));
T('used a D1 cluster key', gatewayHits.some(k => String(k).startsWith('AIzaCLUSTER')), JSON.stringify(gatewayHits.slice(0, 3)));
T('8 exact action buttons', j.keyboard?.length === 8);
T('quota decremented', j.quota.remaining === 2);
T('KV sticky key set', kvStore.has('active_gemini_key'));

r = await post('/api/v1/quick-action', { token, action: 'deep_analysis' });
j = await r.json();
T('deep_analysis via dual engine', j.ok === true && j.chunks[0].includes('کالبدشکافی عمیق'), JSON.stringify(j).slice(0, 140));
const dyn = j.keyboard.find(row => row[0].action?.startsWith('ai_act|'));
T('dynamic action button', !!dyn);

r = await post('/api/v1/quick-action', { token, action: 'cmd_limit' }); j = await r.json();
T('limit page renders', j.ok === true && j.text.includes('پروفایل و اعتبار کاربری'));

r = await post('/api/v1/history', { token }); j = await r.json();
T('history mirror', j.ok === true && j.items.length >= 2);

console.log(`\nAPP-WORKER RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
