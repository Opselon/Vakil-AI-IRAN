// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — End-to-end marketplace smoke: boots the BUILT app worker
//             (dist/vakil-app-worker.js) against a REAL in-process SQLite
//             database behind a thin D1-shaped stub (node:sqlite, shipped with
//             Node 24) and drives every V1 route through worker.fetch() — the
//             actual router + the actual handlers, no internal function calls.
//             Proves the signup→directory→admin-verify→consultation→payment→
//             ledger→chat lifecycle works across the 7 independently-written
//             marketplace modules, which is exactly the seam a per-agent
//             `node --check` cannot cover.
// OWNER     — Agent 9 (Build & QA). Agent 9 owns this file; other agents may
//             append a NEED to it only via MARKETPLACE_INTEGRATION_REQUESTS.md.
// CONSUMES  — dist/vakil-app-worker.js; the worker's OWN DDL paths
//             (appApiEnsureTables + marketplaceRegisterSchema/marketplaceEnsure
//             Tables from app_module_schema.js) to create every marketplace
//             table — the schema is never copied into this harness; env.DB,
//             env.KV, env.APP_TOKEN_SECRET, env.DAILY_LIMIT,
//             env.ADMIN_BOOTSTRAP_EMAILS.
// PROVIDES  — `npm run smoke:marketplace`: PASS/FAIL/SKIP lines +
//             "MARKETPLACE SMOKE: n passed, m failed, k skipped"; exit 1 only
//             on real failures (a not-yet-landed module SKIPs, never fails).
// INVARIANTS— 1) Never writes to dist/, never edits a part file: this is a
//                read-only consumer of the built artifact.
//             2) The only hand-written DDL is the two tables the Telegram bot
//                owns in the shared D1 (`users`, `chat_history`) — no worker
//                code creates them, so the stub must provision them or
//                checkUserLimit cannot run. Everything marketplace-related
//                comes from the worker itself.
//             3) Assertions are about RESPONSES (HTTP status + envelope code +
//                body shape). Direct SELECT COUNT(*) queries are used only to
//                prove "no second row" (idempotency / single ledger split).
//             4) Empty states must PASS: /lawyers/list with zero verified
//                lawyers is correct behaviour, not a failure.
//             5) No fabricated expectations about money: gross == commission +
//                earnings is checked against what the server itself reported.
// EXTEND    — Add one step at the bottom (step(name, needs, deps, fn)) and
//             register its route key in ROUTES so a missing module SKIPs
//             instead of failing the whole run. Keep it V1-tiny: this file and
//             smoke_app_worker.mjs are the entire server test budget.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

const ORIGIN = 'https://vakil-marketplace-smoke.test';
const ADMIN_EMAIL = 'admin@smoke.marketplace';

// ─────────────────────────────────────────────────────────────────────────────
// 1. REAL SQLite behind a D1-shaped surface
//    (prepare → bind → first/all/run, exactly what the parts use)
// ─────────────────────────────────────────────────────────────────────────────

const sqlite = new DatabaseSync(':memory:');

// Bot-owned shared tables (see INVARIANT 2). Column set mirrors server/DB.md +
// the INSERT the sliced engine code actually issues in checkUserLimit.
sqlite.exec(`CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, joined_at INTEGER,
  last_interaction_date TEXT, message_count INTEGER DEFAULT 0, is_banned INTEGER DEFAULT 0,
  image_count_today INTEGER DEFAULT 0, image_count_today_today INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'normal', draft_data TEXT DEFAULT '', phone_number TEXT DEFAULT ''
)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, role TEXT, content TEXT, created_at INTEGER
)`);

/**
 * D1 never hands back bigint/undefined; normalise so JSON + === stay sane.
 * Integral numbers are bound as BigInt on purpose: node:sqlite treats a JS
 * number as REAL, so storing 9200123456789 into a TEXT column would come back
 * as '9200123456789.0' — real D1 writes integer text. BigInt keeps both shapes
 * identical to production.
 */
function d1Value(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  return v;
}
function d1Row(row) {
  if (!row) return null;
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

/** Last D1 error seen — handy when a part ships SQL that SQLite rejects. */
const d1Errors = [];

class SmokeStatement {
  constructor(sql) {
    this._sql = String(sql);
    this._args = [];
  }
  bind(...args) { this._args = args.map(d1Value); return this; }
  _stmt() { return sqlite.prepare(this._sql); }
  async first() {
    try { return d1Row(this._stmt().get(...this._args)) ?? null; }
    catch (e) { d1Errors.push({ sql: this._sql.replace(/\s+/g, ' ').slice(0, 160), err: e.message }); throw e; }
  }
  async all() {
    try {
      const rows = this._stmt().all(...this._args).map(d1Row);
      return { results: rows, success: true, meta: { changes: rows.length } };
    }
    catch (e) { d1Errors.push({ sql: this._sql.replace(/\s+/g, ' ').slice(0, 160), err: e.message }); throw e; }
  }
  async run() {
    try {
      const meta = this._stmt().run(...this._args);
      return { results: [], success: true, meta: { changes: Number(meta.changes), lastRowId: Number(meta.lastInsertRowid) } };
    }
    catch (e) { d1Errors.push({ sql: this._sql.replace(/\s+/g, ' ').slice(0, 160), err: e.message }); throw e; }
  }
}

const DB = { prepare(sql) { return new SmokeStatement(sql); } };

// Minimal KV: get(key[, type]) / put(key, value, {expirationTtl}) / delete(key).
const kvStore = new Map();
const KV = {
  async get(key, type) {
    const hit = kvStore.get(String(key));
    if (!hit) return null;
    if (hit.exp && hit.exp < Date.now()) { kvStore.delete(String(key)); return null; }
    return type === 'json' ? JSON.parse(hit.value) : hit.value;
  },
  async put(key, value, opts) {
    const ttl = opts && Number.isFinite(Number(opts.expirationTtl)) ? Number(opts.expirationTtl) : 0;
    kvStore.set(String(key), {
      value: typeof value === 'string' ? value : JSON.stringify(value),
      exp: ttl > 0 ? Date.now() + ttl * 1000 : 0
    });
  },
  async delete(key) { kvStore.delete(String(key)); }
};

const env = {
  DB, KV,
  APP_TOKEN_SECRET: 'marketplace-smoke-secret',
  APP_CHANNEL_CODE: 'VAKIL-APP-1405',
  DAILY_LIMIT: '3',
  ADMIN_BOOTSTRAP_EMAILS: ADMIN_EMAIL,
  GEMINI_PROXY_URL: 'http://127.0.0.1:9/',
  PROXY_SECRET_TOKEN: 'smoke'
};
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };

// ─────────────────────────────────────────────────────────────────────────────
// 2. Boot the BUILT artifact through its real fetch handler
// ─────────────────────────────────────────────────────────────────────────────

const src = fs.readFileSync(new URL('../dist/vakil-app-worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

const post = (path, body) => worker.fetch(
  new Request(ORIGIN + path, { method: 'POST', body: JSON.stringify(body || {}) }), env, ctx);
const get = (path) => worker.fetch(new Request(ORIGIN + path), env, ctx);

/** POST + parse, never throws on a bad body. */
async function call(path, body) {
  let r, j = null, raw = '';
  try { r = await post(path, body); } catch (e) { return { status: 0, code: 'THREW:' + e.message, j: null }; }
  try { raw = await r.text(); j = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: r.status, j: j || {}, code: (j && j.code) || (raw ? 'HTTP' + r.status : 'NO_BODY'), raw };
}

function where(r) { return `http=${r.status} code=${r.code}${r.j && r.j.message ? ' msg=' + String(r.j.message).slice(0, 90) : ''}`; }
function ok(r) { return r.j && r.j.ok === true; }

// ─────────────────────────────────────────────────────────────────────────────
// 3. Step machinery with SKIP-on-missing-route (parts land independently)
// ─────────────────────────────────────────────────────────────────────────────

// Every route this smoke touches. A 404 NOT_FOUND here means the owning
// module has not landed in the build yet → SKIP, not FAIL.
const ROUTES = [
  '/api/v1/auth/signup', '/api/v1/auth/login', '/api/v1/auth/me', '/api/v1/auth/google',
  '/api/v1/lawyers/list', '/api/v1/lawyers/get', '/api/v1/lawyers/me', '/api/v1/lawyers/save',
  '/api/v1/lawyers/categories',
  '/api/v1/admin/lawyers/pending', '/api/v1/admin/lawyers/decide', '/api/v1/admin/overview',
  '/api/v1/consultations/create', '/api/v1/consultations/list', '/api/v1/consultations/messages',
  '/api/v1/consultations/send', '/api/v1/consultations/complete',
  '/api/v1/consultations/pay', '/api/v1/payments/history',
  '/api/v1/consultations/cancel', '/api/v1/consultations/refund',
  '/api/v1/reviews/submit', '/api/v1/reviews/lawyer', '/api/v1/reviews/mine',
  '/api/v1/admin/payouts/list', '/api/v1/admin/payouts/create', '/api/v1/admin/payouts/mark'
];

const registered = new Set();
for (const route of ROUTES) {
  const r = await call(route, { token: '' });
  if (r.status !== 404 || (r.j && r.j.code !== 'NOT_FOUND')) registered.add(route);
}

let pass = 0, fail = 0, skip = 0;
const status = Object.create(null);

async function step(name, needs, deps, fn) {
  const missing = needs.filter(r => !registered.has(r));
  if (missing.length) {
    skip++; status[name] = 'SKIP';
    console.log(`SKIP ${name} — not in build yet: ${missing.join(', ')}`);
    return;
  }
  const blocked = deps.filter(d => status[d] !== 'PASS');
  if (blocked.length) {
    skip++; status[name] = 'SKIP';
    console.log(`SKIP ${name} — depends on ${blocked.join(', ')} (${blocked.map(d => status[d]).join('/')})`);
    return;
  }
  try {
    const out = await fn();
    if (out && out.skip) {
      skip++; status[name] = 'SKIP';
      console.log(`SKIP ${name} — ${out.skip}`);
      return;
    }
    pass++; status[name] = 'PASS';
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++; status[name] = 'FAIL';
    console.log(`FAIL ${name} — ${e.message}`);
  }
}

function expect(cond, detail) { if (!cond) throw new Error(detail || 'expectation failed'); }
function expectOk(r, what) { expect(ok(r), `${what} not ok (${where(r)})`); return r.j; }

/** Shared state threaded between steps. */
const S = {};
const PW = 'Smoke-Pass-2026!';

// ─────────────────────────────────────────────────────────────────────────────
// 4. The journey
// ─────────────────────────────────────────────────────────────────────────────

// (1) health + the classic AI-chat route still reaches its auth gate
await step('01 health + legacy /api/v1/chat intact', [], [], async () => {
  const h = await get('/api/v1/health');
  const hj = await h.json();
  expect(h.status === 200 && hj.ok === true, `health broken (http=${h.status})`);
  const c = await call('/api/v1/chat', { token: 'not-a-real.token' });
  expect(c.j && c.j.ok === false && c.j.code === 'UNAUTHORIZED',
    `chat lost its auth gate (${where(c)})`);
});

// (2) signup (client) → token + role=client; duplicate email → EMAIL_TAKEN
await step('02 signup client + duplicate EMAIL_TAKEN', ['/api/v1/auth/signup'], ['01 health + legacy /api/v1/chat intact'], async () => {
  const r = await call('/api/v1/auth/signup', {
    email: 'client1@smoke.marketplace', password: PW, displayName: 'موکل آزمایش', role: 'client',
    deviceId: 'smoke-device-client-1'
  });
  const j = expectOk(r, 'signup(client)');
  expect(typeof j.token === 'string' && j.token.length > 40, `no token (${where(r)})`);
  expect(j.user && j.user.role === 'client', `role not client: ${JSON.stringify(j.user)} (${where(r)})`);
  expect(j.user && j.user.verificationStatus === undefined,
    `non-lawyer must not carry verificationStatus: ${JSON.stringify(j.user)}`);
  S.clientToken = j.token;
  S.clientId = j.user.userId;
  const dup = await call('/api/v1/auth/signup', {
    email: 'CLIENT1@smoke.marketplace', password: PW, displayName: 'تکراری', role: 'client'
  });
  expect(dup.j && dup.j.ok === false && dup.j.code === 'EMAIL_TAKEN',
    `duplicate email not rejected as EMAIL_TAKEN (${where(dup)})`);
});

// (3) login: wrong password → INVALID_CREDENTIALS; correct → token
await step('03 login wrong pw INVALID_CREDENTIALS, right pw ok', ['/api/v1/auth/login'],
  ['02 signup client + duplicate EMAIL_TAKEN'], async () => {
    const bad = await call('/api/v1/auth/login', { identifier: 'client1@smoke.marketplace', password: PW + 'x' });
    expect(bad.j && bad.j.ok === false && bad.j.code === 'INVALID_CREDENTIALS',
      `wrong password not INVALID_CREDENTIALS (${where(bad)})`);
    const good = await call('/api/v1/auth/login', { identifier: 'client1@smoke.marketplace', password: PW });
    const j = expectOk(good, 'login(client)');
    expect(typeof j.token === 'string', `login returned no token (${where(good)})`);
    expect(j.user && j.user.userId === S.clientId, `login changed user id: ${j.user && j.user.userId}`);
  });

// (4) signup role=lawyer → pending lawyer profile
await step('04 signup lawyer → pending profile', ['/api/v1/auth/signup', '/api/v1/lawyers/me'],
  ['01 health + legacy /api/v1/chat intact'], async () => {
    const r = await call('/api/v1/auth/signup', {
      email: 'lawyer1@smoke.marketplace', password: PW, displayName: 'وکیل آزمایش', role: 'lawyer',
      deviceId: 'smoke-device-lawyer-1'
    });
    const j = expectOk(r, 'signup(lawyer)');
    expect(j.user && j.user.role === 'lawyer', `role not lawyer: ${JSON.stringify(j.user)}`);
    expect(j.user && j.user.verificationStatus === 'pending',
      `new lawyer must be pending, got ${j.user && j.user.verificationStatus} (${where(r)})`);
    S.lawyerToken = j.token;
    S.lawyerId = j.user.userId;
    const me = await call('/api/v1/lawyers/me', { token: S.lawyerToken });
    const mj = expectOk(me, 'lawyers/me');
    expect(mj.verificationStatus === 'pending', `profile status ${mj.verificationStatus} (${where(me)})`);
    expect(mj.userId === S.lawyerId, `lawyers/me userId mismatch (${where(me)})`);
    expect(typeof mj.slug === 'string' && mj.slug.length > 0, `no slug on fresh profile (${where(me)})`);
    S.lawyerSlugPending = mj.slug;
  });

// (5) directory BEFORE verification: array present, pending lawyer absent
await step('05 lawyers/list hides the pending lawyer', ['/api/v1/lawyers/list'],
  ['04 signup lawyer → pending profile'], async () => {
    const r = await call('/api/v1/lawyers/list', {});
    const j = expectOk(r, 'lawyers/list');
    expect(Array.isArray(j.lawyers), `lawyers is not an array (${where(r)})`);
    expect(!j.lawyers.some(l => Number(l.userId) === Number(S.lawyerId)),
      'PENDING lawyer leaked into the public directory');
  });

// (6) lawyer edits own profile → stored, still not published
await step('06 lawyers/save stores fields, keeps pending', ['/api/v1/lawyers/save', '/api/v1/lawyers/list'],
  ['05 lawyers/list hides the pending lawyer'], async () => {
    const r = await call('/api/v1/lawyers/save', {
      token: S.lawyerToken, title: 'وکیل پایه یک دادگستری', bio: '۱۲ سال سابقه در دعاوی خانواده',
      city: 'تهران', jurisdiction: 'Tehran', experienceYears: 12, priceToman: 500000,
      durationMinutes: 60, specialties: ['khanevadeh'], languages: ['fa'],
      availabilityNote: 'شنبه تا چهارشنبه', isAvailable: true,
      verificationStatus: 'verified'          // must be IGNORED (spec §2.2)
    });
    const j = expectOk(r, 'lawyers/save');
    expect(j.verificationStatus === 'pending',
      `client-supplied verificationStatus was honoured: ${j.verificationStatus}`);
    expect(j.title === 'وکیل پایه یک دادگستری' && j.city === 'تهران',
      `fields not echoed back: ${JSON.stringify({ title: j.title, city: j.city })} (${where(r)})`);
    expect(Number(j.priceToman) === 500000 && Number(j.experienceYears) === 12,
      `numbers not stored: price=${j.priceToman} exp=${j.experienceYears} (${where(r)})`);
    expect(Array.isArray(j.specialties) && j.specialties[0] === 'khanevadeh',
      `specialties not round-tripped: ${JSON.stringify(j.specialties)}`);
    const list = await call('/api/v1/lawyers/list', {});
    const lj = expectOk(list, 'lawyers/list(after save)');
    expect(!lj.lawyers.some(l => Number(l.userId) === Number(S.lawyerId)),
      'lawyer visible in directory before admin verification');
  });

// (7) admin bootstrap → queue → verify → the lawyer is now public
await step('07 admin bootstrap → pending queue → verify → listed',
  ['/api/v1/auth/signup', '/api/v1/admin/lawyers/pending', '/api/v1/admin/lawyers/decide', '/api/v1/lawyers/list'],
  ['06 lawyers/save stores fields, keeps pending'], async () => {
    const r = await call('/api/v1/auth/signup', {
      email: ADMIN_EMAIL, password: PW, displayName: 'ادمین آزمایش', role: 'admin',
      deviceId: 'smoke-device-admin-1'
    });
    const j = expectOk(r, 'signup(admin bootstrap)');
    expect(j.user && j.user.role === 'admin',
      `bootstrap admin email did not get role admin: ${JSON.stringify(j.user)}`);
    S.adminToken = j.token;

    const sneaky = await call('/api/v1/auth/signup', {
      email: 'sneaky@smoke.marketplace', password: PW, displayName: 'مدعی', role: 'admin'
    });
    const sj = expectOk(sneaky, 'signup(role=admin, unlisted)');
    expect(sj.user && sj.user.role === 'client',
      `role=admin honoured for a NON-bootstrap email: ${JSON.stringify(sj.user)}`);

    const q = await call('/api/v1/admin/lawyers/pending', { token: S.adminToken });
    const qj = expectOk(q, 'admin/lawyers/pending');
    const rows = qj.lawyers || qj.users || [];
    expect(Array.isArray(rows) && rows.some(x => Number(x.userId ?? x.user_id) === Number(S.lawyerId)),
      `pending queue does not contain the new lawyer (${where(q)})`);

    const d = await call('/api/v1/admin/lawyers/decide', {
      token: S.adminToken, userId: S.lawyerId, decision: 'verify', note: 'اسناد بررسی شد'
    });
    const dj = expectOk(d, 'admin/lawyers/decide verify');
    expect(dj.verificationStatus === 'verified',
      `decide(verify) returned ${dj.verificationStatus} (${where(d)})`);

    const list = await call('/api/v1/lawyers/list', {});
    const lj = expectOk(list, 'lawyers/list(after verify)');
    const card = (lj.lawyers || []).find(l => Number(l.userId) === Number(S.lawyerId));
    expect(card, `VERIFIED lawyer still missing from /lawyers/list (${where(list)})`);
    expect(card.verificationStatus === 'verified', `list card status ${card.verificationStatus}`);
    expect(Number(lj.total) >= 1, `total not raised: ${JSON.stringify(lj.total)} body=${list.raw.slice(0, 300)}`);
    S.lawyerSlug = card.slug || S.lawyerSlugPending;
  });

// (8) non-admin cannot reach the admin surface
await step('08 client hitting /admin/overview → FORBIDDEN', ['/api/v1/admin/overview'],
  ['02 signup client + duplicate EMAIL_TAKEN', '07 admin bootstrap → pending queue → verify → listed'], async () => {
    const r = await call('/api/v1/admin/overview', { token: S.clientToken });
    expect(r.j && r.j.ok === false && r.j.code === 'FORBIDDEN' && r.status === 403,
      `expected 403 FORBIDDEN (${where(r)})`);
    const noAuth = await call('/api/v1/admin/overview', { token: '' });
    expect(noAuth.j && noAuth.j.ok === false && noAuth.j.code === 'UNAUTHORIZED',
      `admin route accepted a missing token (${where(noAuth)})`);
  });

// (9) consultation create (+idempotency) → PAYMENT_PENDING with a devtest quote
await step('09 consultations/create PAYMENT_PENDING + idempotent replay',
  ['/api/v1/consultations/create', '/api/v1/consultations/list'],
  ['07 admin bootstrap → pending queue → verify → listed', '03 login wrong pw INVALID_CREDENTIALS, right pw ok'], async () => {
    S.idem = 'cons-create-smoke-1';
    const r = await call('/api/v1/consultations/create', {
      token: S.clientToken, lawyerUserId: S.lawyerId, idempotencyKey: S.idem
    });
    const j = expectOk(r, 'consultations/create');
    const c = j.consultation || {};
    expect(c.status === 'PAYMENT_PENDING', `status ${c.status} (${where(r)})`);
    expect(Number(c.priceToman) === 500000, `price snapshot ${c.priceToman} (${where(r)})`);
    expect(Number(j.paymentId) > 0, `no paymentId on the quote (${where(r)})`);
    expect(j.provider === 'devtest', `provider ${JSON.stringify(j.provider)} (${where(r)})`);
    expect(typeof j.devModeNotice === 'string' && j.devModeNotice.length > 5,
      `dev/test label missing (${where(r)})`);
    S.consultationId = Number(c.id);
    S.amount = Number(c.priceToman);

    const again = await call('/api/v1/consultations/create', {
      token: S.clientToken, lawyerUserId: S.lawyerId, idempotencyKey: S.idem
    });
    const aj = expectOk(again, 'consultations/create(replay)');
    expect(Number(aj.consultation && aj.consultation.id) === S.consultationId,
      `same idempotencyKey created a NEW consultation (${aj.consultation && aj.consultation.id} vs ${S.consultationId})`);
    const rows = sqlite.prepare('SELECT id FROM consultations WHERE client_user_id = ?')
      .all(S.clientId);
    expect(rows.length === 1, `expected 1 consultation row, found ${rows.length}`);
    const mine = await call('/api/v1/consultations/list', { token: S.clientToken, scope: 'mine' });
    expectOk(mine, 'consultations/list(client)');
  });

// (10) pay → PAID + single ledger split; re-pay → CONSULTATION_ALREADY_PAID
await step('10 consultations/pay split + no double ledger',
  ['/api/v1/consultations/pay'], ['09 consultations/create PAYMENT_PENDING + idempotent replay'], async () => {
    const r = await call('/api/v1/consultations/pay', {
      token: S.clientToken, consultationId: S.consultationId, idempotencyKey: 'pay-smoke-1'
    });
    const j = expectOk(r, 'consultations/pay');
    expect(j.paymentStatus === 'succeeded', `paymentStatus ${j.paymentStatus} (${where(r)})`);
    const com = j.commissionToman, earn = j.lawyerEarningsToman;
    expect(Number.isInteger(com) && Number.isInteger(earn),
      `split not integer toman: commission=${JSON.stringify(com)} earnings=${JSON.stringify(earn)}`);
    expect(com + earn === S.amount, `gross ${S.amount} != commission ${com} + earnings ${earn}`);
    expect(j.consultation && j.consultation.status === 'PAID',
      `consultation status after pay: ${j.consultation && j.consultation.status}`);
    expect(typeof j.devModeNotice === 'string' && j.devModeNotice.length > 5,
      `settled devtest payment lost its honest label (${where(r)})`);
    S.commission = com; S.earnings = earn;

    const again = await call('/api/v1/consultations/pay', {
      token: S.clientToken, consultationId: S.consultationId, idempotencyKey: 'pay-smoke-1'
    });
    expect(again.j && again.j.ok === true && again.j.code === 'CONSULTATION_ALREADY_PAID',
      `re-pay not CONSULTATION_ALREADY_PAID (${where(again)})`);
    const splits = sqlite.prepare('SELECT COUNT(*) AS n FROM payment_splits').get().n;
    expect(Number(splits) === 1, `payment_splits rows = ${splits} (must stay 1)`);
    const pays = sqlite.prepare('SELECT COUNT(*) AS n FROM payments WHERE consultation_id = ?')
      .get(S.consultationId).n;
    expect(Number(pays) === 1, `payments rows = ${pays} (must stay 1)`);
  });

// (11) consultation chat + server-side membership enforcement
await step('11 send/messages work for members, FORBIDDEN for outsider',
  ['/api/v1/consultations/send', '/api/v1/consultations/messages'],
  ['10 consultations/pay split + no double ledger'], async () => {
    const s = await call('/api/v1/consultations/send', {
      token: S.clientToken, consultationId: S.consultationId,
      body: 'سلام، دربارهٔ یک دعوای خانوادگی می‌خواستم مشورت کنم.'
    });
    const sj = expectOk(s, 'consultations/send');
    expect(sj.consultation && sj.consultation.status === 'ACTIVE',
      `first send should start the session, got ${sj.consultation && sj.consultation.status} (${where(s)})`);
    const last = (sj.messages || [])[ (sj.messages || []).length - 1 ] || {};
    expect(last.body && String(last.body).includes('مشورت'),
      `sent message not in the returned page (${where(s)})`);
    S.clientName = sj.consultation && sj.consultation.clientName;

    const pull = await call('/api/v1/consultations/messages', {
      token: S.clientToken, consultationId: S.consultationId, afterId: 0
    });
    const pj = expectOk(pull, 'consultations/messages(member)');
    expect(Array.isArray(pj.messages) && pj.messages.length >= 1,
      `member could not read the thread (${where(pull)})`);

    const other = await call('/api/v1/auth/signup', {
      email: 'client2@smoke.marketplace', password: PW, displayName: 'غریبه', role: 'client'
    });
    const oj = expectOk(other, 'signup(client2)');
    const stranger = await call('/api/v1/consultations/messages', {
      token: oj.token, consultationId: S.consultationId, afterId: 0
    });
    // L1 hardening: non-members get the SAME answer as a missing id (404) so
    // time-ordered ids cannot enumerate which consultations exist.
    expect(stranger.j && stranger.j.ok === false && stranger.j.code === 'NOT_FOUND' && stranger.status === 404 &&
      !(stranger.j.messages && stranger.j.messages.length),
      `non-participant could read the consultation (${where(stranger)})`);
    const strangerSend = await call('/api/v1/consultations/send', {
      token: oj.token, consultationId: S.consultationId, body: 'مزاحم می‌شوم'
    });
    expect(strangerSend.j && strangerSend.j.ok === false && strangerSend.j.code === 'NOT_FOUND',
      `non-participant WROTE to the consultation (${where(strangerSend)})`);
  });

// (12) complete → COMPLETED, further writes rejected
await step('12 consultations/complete then send rejected',
  ['/api/v1/consultations/complete', '/api/v1/consultations/send'],
  ['11 send/messages work for members, FORBIDDEN for outsider'], async () => {
    const c = await call('/api/v1/consultations/complete', { token: S.clientToken, consultationId: S.consultationId });
    const cj = expectOk(c, 'consultations/complete');
    const st = (cj.consultation && cj.consultation.status) ||
      (cj.consultations && cj.consultations[0] && cj.consultations[0].status);
    expect(st === 'COMPLETED', `status after complete = ${st} (${where(c)})`);
    const late = await call('/api/v1/consultations/send', {
      token: S.clientToken, consultationId: S.consultationId, body: 'بعد از پایان'
    });
    expect(late.j && late.j.ok === false &&
      ['CONSULTATION_CLOSED', 'CONSULTATION_EXPIRED', 'NOT_ACTIVE'].includes(late.j.code),
      `send on a COMPLETED consultation was accepted (${where(late)})`);
    const hist = await call('/api/v1/consultations/messages', {
      token: S.clientToken, consultationId: S.consultationId, afterId: 0
    });
    expectOk(hist, 'consultations/messages after COMPLETED (evidence stays readable)');
    expect((hist.j.messages || []).length >= 1, 'completed thread lost its messages');
  });

// (13) role-aware payment history for all three parties
await step('13 payments/history client/lawyer/admin', ['/api/v1/payments/history'],
  ['12 consultations/complete then send rejected'], async () => {
    const cl = await call('/api/v1/payments/history', { token: S.clientToken });
    const clj = expectOk(cl, 'payments/history(client)');
    expect(Array.isArray(clj.transactions) && clj.transactions.length === 1,
      `client transaction list wrong (${JSON.stringify(clj.transactions)})`);
    expect(Number(clj.grossToman) === S.amount, `client gross ${clj.grossToman} != ${S.amount} (${where(cl)})`);
    expect(Number(clj.earningsToman) === 0, `client must see no earnings (${clj.earningsToman})`);

    const lw = await call('/api/v1/payments/history', { token: S.lawyerToken });
    const lwj = expectOk(lw, 'payments/history(lawyer)');
    expect(Number(lwj.earningsToman) === S.earnings,
      `lawyer earnings ${lwj.earningsToman} != reported split ${S.earnings} (${where(lw)})`);

    const ad = await call('/api/v1/payments/history', { token: S.adminToken });
    const adj = expectOk(ad, 'payments/history(admin)');
    expect(Number(adj.commissionToman) === S.commission,
      `platform commission ${adj.commissionToman} != reported split ${S.commission} (${where(ad)})`);
    expect(Number(adj.grossToman) === S.amount, `admin gross ${adj.grossToman}`);
  });

// (14) /lawyers/get by slug: a PENDING profile is invisible to a stranger
await step('14 lawyers/get pending slug → NOT_FOUND for stranger',
  ['/api/v1/auth/signup', '/api/v1/lawyers/me', '/api/v1/lawyers/get'],
  ['02 signup client + duplicate EMAIL_TAKEN', '04 signup lawyer → pending profile'], async () => {
    const fresh = await call('/api/v1/auth/signup', {
      email: 'lawyer2@smoke.marketplace', password: PW, displayName: 'وکیل دوم', role: 'lawyer'
    });
    const fj = expectOk(fresh, 'signup(lawyer2)');
    const me = await call('/api/v1/lawyers/me', { token: fj.token });
    const mj = expectOk(me, 'lawyers/me(lawyer2)');
    expect(mj.verificationStatus === 'pending', `lawyer2 status ${mj.verificationStatus}`);
    const stranger = await call('/api/v1/lawyers/get', { slug: mj.slug });
    expect(stranger.j && stranger.j.ok === false && stranger.j.code === 'NOT_FOUND' && stranger.status === 404,
      `pending profile readable by slug for a stranger (${where(stranger)})`);
    const strangerByUser = await call('/api/v1/lawyers/get', { userId: fj.user.userId });
    expect(strangerByUser.j && strangerByUser.j.ok === false && strangerByUser.j.code === 'NOT_FOUND',
      `pending profile readable by userId for a stranger (${where(strangerByUser)})`);
    const self = await call('/api/v1/lawyers/get', { slug: mj.slug, token: fj.token });
    expectOk(self, 'lawyers/get by owner (self must stay readable)');
  });

// (15) extra: Google login must answer honestly, never crash / never fake a session
await step('15 auth/google honest CONFIG_PENDING (no crash)', ['/api/v1/auth/google'], [], async () => {
  const r = await call('/api/v1/auth/google', { credential: 'not-a-google-token', deviceId: 'smoke-dev-google' });
  expect(r.status !== 500 && r.code !== 'THREW:not-a-google-token', `google route crashed (${where(r)})`);
  if (env.GOOGLE_CLIENT_ID) return;
  expect(r.j && r.j.ok === false && r.j.code === 'CONFIG_PENDING',
    `GOOGLE_CLIENT_ID unset but answer was ${r.code} (spec §2.3 wants CONFIG_PENDING)`);
});

await step('16 wave-2 reviews: happy, self/stranger refusals, replay, public aggregate',
  ['/api/v1/reviews/submit', '/api/v1/reviews/lawyer', '/api/v1/reviews/mine'],
  ['12 consultations/complete then send rejected'], async () => {
  const submit = await call('/api/v1/reviews/submit',
    { token: S.clientToken, consultationId: S.consultationId, rating: 5, comment: '  عالی و دقیق  ' });
  expect(submit.j && submit.j.ok === true, `client submit failed (${where(submit)})`);
  expect(submit.j.count === 1 && submit.j.average === 5, `aggregate wrong: count=${submit.j.count} avg=${submit.j.average}`);

  const replay = await call('/api/v1/reviews/submit', { token: S.clientToken, consultationId: S.consultationId, rating: 1 });
  expect(replay.status === 409 && replay.code === 'ALREADY_REVIEWED', `replay: ${where(replay)}`);

  const self = await call('/api/v1/reviews/submit', { token: S.lawyerToken, consultationId: S.consultationId, rating: 1 });
  expect(self.status === 403 && self.code === 'FORBIDDEN', `lawyer self-review: ${where(self)}`);

  const stranger = await call('/api/v1/reviews/submit', { token: S.adminToken, consultationId: S.consultationId, rating: 1 });
  expect(stranger.status === 404 && stranger.code === 'NOT_FOUND', `stranger submit: ${where(stranger)}`);

  const pub = await call('/api/v1/reviews/lawyer', { lawyerUserId: S.lawyerId });
  expect(pub.j && pub.j.ok === true && pub.j.count === 1, `public list: ${where(pub)}`);
  expect(pub.j.reviews[0].comment === 'عالی و دقیق', 'comment not trimmed on write');
  expect(pub.j.reviews[0].rating === 5 && typeof pub.j.reviews[0].id === 'number', 'review DTO shape drift');

  const mine = await call('/api/v1/reviews/mine', { token: S.clientToken, consultationId: S.consultationId });
  expect(mine.j && mine.j.ok === true && mine.j.count === 1, `mine: ${where(mine)}`);
  const mineStranger = await call('/api/v1/reviews/mine', { token: S.adminToken, consultationId: S.consultationId });
  expect(mineStranger.status === 404, `stranger mine: ${where(mineStranger)}`);
});

await step('17 wave-2 cancel/refund: unpaid cancel, paid refund + provider guard, split ledger intact',
  ['/api/v1/consultations/cancel', '/api/v1/consultations/refund'],
  ['07 admin bootstrap → pending queue → verify → listed', '10 consultations/pay split + no double ledger'], async () => {
  // cancel before payment is free and final
  const c3 = await call('/api/v1/consultations/create', { token: S.clientToken, lawyerUserId: S.lawyerId, topic: 'لغو' });
  const id3 = c3.j && c3.j.consultation && c3.j.consultation.id;
  expect(id3, `create for cancel failed (${where(c3)})`);
  const cancel = await call('/api/v1/consultations/cancel', { token: S.clientToken, consultationId: id3 });
  expect(cancel.j && cancel.j.ok === true && cancel.j.consultation.status === 'CANCELLED', `cancel: ${where(cancel)}`);
  const replay = await call('/api/v1/consultations/cancel', { token: S.clientToken, consultationId: id3 });
  // lane-B design: replay is IDEMPOTENT-OK (200 + code marker + current row), not 409
  expect(replay.status === 200 && replay.code === 'CONSULTATION_ALREADY_CANCELLED'
         && replay.j.consultation.status === 'CANCELLED', `cancel replay: ${where(replay)}`);

  // pay a fresh room, then refund it (devtest provider is the smoke default)
  const c4 = await call('/api/v1/consultations/create', { token: S.clientToken, lawyerUserId: S.lawyerId, topic: 'استرداد' });
  const id4 = c4.j && c4.j.consultation && c4.j.consultation.id;
  expect(id4, `create for refund failed (${where(c4)})`);
  const pay = await call('/api/v1/consultations/pay', { token: S.clientToken, consultationId: id4, provider: 'devtest' });
  expect(pay.j && pay.j.ok === true, `pay before refund failed (${where(pay)})`);

  // provider guard (row provenance): a payment whose own row says a real PSP is
  // never refundable through devtest — proven by rewriting the row, not config
  // (config path rejects unregistered providers with BAD_CONFIG_VALUE by design).
  sqlite.prepare("UPDATE payments SET provider = 'zarinpal' WHERE consultation_id = ?").run(BigInt(id4));
  const guarded = await call('/api/v1/consultations/refund', { token: S.clientToken, consultationId: id4 });
  expect(guarded.status === 502 && guarded.code === 'PROVIDER_NOT_REFUNDABLE', `provider guard: ${where(guarded)}`);
  const stamped = sqlite.prepare("SELECT status, refunded_at FROM payments WHERE consultation_id = ?").get(BigInt(id4));
  expect(stamped.status === 'succeeded' && !stamped.refunded_at, 'guarded refund still touched the payment row');
  sqlite.prepare("UPDATE payments SET provider = 'devtest' WHERE consultation_id = ?").run(BigInt(id4));

  const refund = await call('/api/v1/consultations/refund', { token: S.clientToken, consultationId: id4 });
  expect(refund.j && refund.j.ok === true && refund.j.consultation.status === 'REFUNDED', `refund: ${where(refund)}`);
  expect(Number(refund.j.refundAmountToman) > 0, 'refund amount not reported');
  const refundAgain = await call('/api/v1/consultations/refund', { token: S.clientToken, consultationId: id4 });
  expect(refundAgain.j && refundAgain.j.ok === true, `refund replay should be idempotent: ${where(refundAgain)}`);

  // ledger honesty: refunded payment keeps its split row (immutable history)
  const rows = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM payment_splits ps JOIN payments p ON p.id = ps.payment_id WHERE p.consultation_id = ?"
  ).get(BigInt(id4));
  expect(Number(rows.n) === 1, `split ledger row deleted on refund (n=${rows.n})`);
  const paid = sqlite.prepare("SELECT status, refunded_at FROM payments WHERE consultation_id = ?").get(BigInt(id4));
  expect(paid.status === 'refunded' && Number(paid.refunded_at) > 0, 'payments row not stamped refunded');
});

await step('18 wave-2 payouts: over-accrual guard, one-way mark, paid-only totals',
  ['/api/v1/admin/payouts/list', '/api/v1/admin/payouts/create', '/api/v1/admin/payouts/mark'],
  ['10 consultations/pay split + no double ledger', '07 admin bootstrap → pending queue → verify → listed'], async () => {
  const list0 = await call('/api/v1/admin/payouts/list', { token: S.adminToken });
  expect(list0.j && list0.j.ok === true, `list: ${where(list0)}`);
  const earn = Number(list0.j.accruedToman);
  expect(earn > 0, 'a succeeded split must accrue before any payout');

  const over = await call('/api/v1/admin/payouts/create',
    { token: S.adminToken, lawyerUserId: S.lawyerId, amountToman: earn + 1 });
  expect(over.status === 400 && over.code === 'OVER_ACCRUAL', `over-accrual: ${where(over)}`);

  const half = Math.max(1, Math.floor(earn / 2));
  const made = await call('/api/v1/admin/payouts/create',
    { token: S.adminToken, lawyerUserId: S.lawyerId, amountToman: half, method: 'manual-smoke' });
  expect(made.j && made.j.ok === true, `create: ${where(made)}`);
  const row = (made.j.payouts || []).find((x) => x.status === 'pending' && x.amountToman === half);
  expect(row, 'created pending row missing from response');
  const midList = await call('/api/v1/admin/payouts/list', { token: S.adminToken });
  expect(Number(midList.j.paidOutToman) === 0, 'pending row must not move paidOut totals');

  const paid = await call('/api/v1/admin/payouts/mark',
    { token: S.adminToken, payoutId: row.id, status: 'paid', reference: 'SMOKE-REF-1' });
  expect(paid.j && paid.j.ok === true, `mark paid: ${where(paid)}`);
  const after = await call('/api/v1/admin/payouts/list', { token: S.adminToken });
  expect(Number(after.j.paidOutToman) === half, `paidOut ${after.j.paidOutToman} != ${half}`);

  const again = await call('/api/v1/admin/payouts/mark',
    { token: S.adminToken, payoutId: row.id, status: 'cancelled' });
  expect(again.status === 409 && again.code === 'PAYOUT_STATE_CONFLICT', `one-way mark: ${where(again)}`);

  const clientTry = await call('/api/v1/admin/payouts/list', { token: S.clientToken });
  expect(clientTry.status === 403, `client reached payouts: ${where(clientTry)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Verdict
// ─────────────────────────────────────────────────────────────────────────────

const skippedRoutes = ROUTES.filter(r => !registered.has(r));
if (skippedRoutes.length) console.log(`NOTE unregistered routes: ${skippedRoutes.join(', ')}`);
if (d1Errors.length) {
  console.log(`NOTE D1 errors observed: ${d1Errors.length}`);
  for (const e of d1Errors.slice(0, 5)) console.log(`  · ${e.err} :: ${e.sql}`);
}
console.log(`\nMARKETPLACE SMOKE: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
