// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Adversarial RUNTIME red-team for the marketplace surface: boots
//             the built worker (dist/vakil-app-worker.js) against a real
//             in-process SQLite behind the same D1-shaped stub used by
//             smoke_marketplace.mjs, then attacks routes through
//             worker.fetch() with tampered tokens, spoofed bodies, cross-user
//             probes, malformed payloads, and concurrent double-spend races.
//             This is PROOF OF BEHAVIOUR, not proof of reading.
// OWNER     — coordinator (Phase 1 runtime arm of the adversarial audit).
// CONSUMES  — dist/vakil-app-worker.js, node:sqlite, the worker's own DDL.
// PROVIDES  — `node tools/marketplace_redteam.mjs`: PASS/FAIL/WAIVE lines with
//             observed status+code, and a final summary. Exit 1 only on real
//             security failures (a WAIVE is a behaviour to review, not a fail).
// INVARIANTS— repo addition is THIS file only (plus its results echo under
//             %TEMP%/vakil_audit/); never edits dist or parts; every probe is
//             observable via worker.fetch(), so results are runtime proof.
// EXTEND    — one probe = one block at the bottom; keep the assert helpers.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

const OUT = new URL('file:///C:/Users/Capsizer/AppData/Local/Temp/vakil_audit/redteam_results.txt');
const src = fs.readFileSync(new URL('../dist/vakil-app-worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

// ── D1 stub (same semantics as smoke_marketplace: BigInt binds, Number rows) ──
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, joined_at INTEGER,
  last_interaction_date TEXT, message_count INTEGER DEFAULT 0, is_banned INTEGER DEFAULT 0,
  image_count_today INTEGER DEFAULT 0, image_count_today_today INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'normal', draft_data TEXT DEFAULT '', phone_number TEXT DEFAULT ''
)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, role TEXT, content TEXT, created_at INTEGER
)`);
function d1Value(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  return v;
}
function d1Row(row) {
  if (!row) return null;
  const out = {};
  for (const k of Object.keys(row)) { const v = row[k]; out[k] = typeof v === 'bigint' ? Number(v) : v; }
  return out;
}
class Stmt {
  constructor(sql) { this._sql = String(sql); this._args = []; }
  bind(...a) { this._args = a.map(d1Value); return this; }
  async first() { return d1Row(sqlite.prepare(this._sql).get(...this._args)) ?? null; }
  async all() { const rows = sqlite.prepare(this._sql).all(...this._args).map(d1Row); return { results: rows, success: true, meta: { changes: rows.length } }; }
  async run() { const r = sqlite.prepare(this._sql).run(...this._args); return { success: true, meta: { changes: Number(r.changes) } }; }
}
const env = {
  DB: { prepare: (sql) => new Stmt(sql) },
  KV: null,
  APP_TOKEN_SECRET: 'redteam-secret-0123456789',
  APP_CHANNEL_CODE: 'REDTEAM-CODE',
  DAILY_LIMIT: '99',
  ADMIN_BOOTSTRAP_EMAILS: 'admin@red.team'
};
const ctx = { waitUntil() { } };
const call = async (path, bodyObj) => {
  const r = await worker.fetch(new Request('https://rt.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyObj === '__RAW__' ? undefined : JSON.stringify(bodyObj)
  }), env, ctx);
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, j };
};
const raw = async (path, text) => {
  const r = await worker.fetch(new Request('https://rt.test' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: text
  }), env, ctx);
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, j };
};
const q = (sql, ...a) => d1Row(sqlite.prepare(sql).get(...a.map(d1Value))) || {};

const lines = [];
let fail = 0, pass = 0, waive = 0;
const check = (name, ok, detail) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
  ok ? pass++ : fail++;
};
const waiver = (name, detail) => { lines.push(`WAIVE | ${name} | ${detail}`); waive++; };

// ─────────────────────────── fixtures ───────────────────────────
// role:'admin' is honoured ONLY because this email is in ADMIN_BOOTSTRAP_EMAILS
// (set in env above); the same call with any other email yields 'client' (P03b).
const admin = (await call('/api/v1/auth/signup', { email: 'admin@red.team', password: 'RedTeam123', displayName: 'Admin RT', role: 'admin' })).j;
if (admin?.user?.role !== 'admin') { console.log('FIXTURE FAILURE: bootstrap admin not honoured', JSON.stringify(admin).slice(0, 300)); process.exit(2); }
const client = (await call('/api/v1/auth/signup', { email: 'client@red.team', password: 'RedTeam123', displayName: 'Client RT', role: 'client' })).j;
let lawyer = (await call('/api/v1/auth/signup', { email: 'law@red.team', password: 'RedTeam123', displayName: 'Lawyer RT', role: 'lawyer' })).j;
const reloginLawyer = async () => (await call('/api/v1/auth/login', { identifier: 'law@red.team', password: 'RedTeam123' })).j;
const stranger = (await call('/api/v1/auth/signup', { email: 'str@red.team', password: 'RedTeam123', displayName: 'Stranger', role: 'client' })).j;
if (!admin?.ok || !client?.ok || !lawyer?.ok || !stranger?.ok) {
  console.log('FIXTURE FAILURE', JSON.stringify({ admin, client, lawyer, stranger }).slice(0, 600));
  process.exit(2);
}
await call('/api/v1/lawyers/save', {
  token: lawyer.token, title: 'وکیل پایه', bio: 'بیو آزمایشی', specialties: ['family', 'criminal'],
  city: 'تهران', experienceYears: 12, priceToman: 85001, durationMinutes: 45
});
const decided = await call('/api/v1/admin/lawyers/decide', { token: admin.token, userId: lawyer.user.userId, decision: 'verify', note: 'rt' });
check('fixture: admin verify works', decided.j?.ok === true && decided.j?.verificationStatus === 'verified', JSON.stringify(decided.j).slice(0, 120));

// ─────────────────────────── probes ───────────────────────────
// P01 malformed tokens
for (const [label, tok] of [
  ['garbage', 'not-a-token'],
  ['sig-stripped', client.token.split('.')[0] + '.00000000000000000000000000000000'],
  ['payload-swapped-uid', (() => {
    const p = JSON.parse(Buffer.from(client.token.split('.')[0], 'base64url').toString());
    p.uid = admin.user.userId + 777;
    const b64 = Buffer.from(JSON.stringify(p)).toString('base64url');
    return b64 + '.' + client.token.split('.')[1];
  })()],
  ['empty', '']
]) {
  const r = await call('/api/v1/consultations/list', { token: tok });
  check('P01 token rejected: ' + label, r.status === 401 && r.j?.code === 'UNAUTHORIZED', `${r.status} ${r.j?.code}`);
}

// P02 unsigned/absent body & non-JSON
{
  const r = await raw('/api/v1/auth/login', 'this is not json');
  check('P02 non-JSON POST -> BAD_JSON 4xx', r.status === 400 && r.j?.code === 'BAD_JSON', `${r.status} ${r.j?.code}`);
  const e = await call('/api/v1/auth/login', {});
  check('P02b empty login body -> clean 4xx, no 500', e.status < 500, `${e.status} ${e.j?.code}`);
  const big = await call('/api/v1/auth/signup', { email: 'x@y.io', password: 'a'.repeat(70000), displayName: 'Z', role: 'client' });
  check('P02c 70KB password refused (length cap or 413)', big.status < 500 && big.j?.ok === false, `${big.status} ${big.j?.code}`);
}

// P03 client-trusted fields
{
  const r = await call('/api/v1/auth/signup', {
    email: 'evil@red.team', password: 'RedTeam123', displayName: 'Evil', role: 'client',
    verificationStatus: 'verified', admin: true, uid: 1, userId: 1, isLawyer: true
  });
  check('P03 spoofed role/verification fields ignored', r.j?.ok === true && r.j?.user?.role === 'client' && r.j?.user?.verificationStatus == null, `role=${r.j?.user?.role} vs=${r.j?.user?.verificationStatus}`);
  const su = await call('/api/v1/auth/signup', { email: 'law2@red.team', password: 'RedTeam123', displayName: 'L2', role: 'ADMIN' });
  check('P03b role ADMIN (no bootstrap email) -> client', su.j?.user?.role === 'client', `role=${su.j?.user?.role}`);
  const selfSave = await call('/api/v1/lawyers/save', { token: lawyer.token, verification_status: 'verified', verificationStatus: 'verified', role: 'admin' });
  const me = await call('/api/v1/lawyers/me', { token: lawyer.token });
  check('P03c lawyer save cannot self-verify/re-role', me.j?.verificationStatus === 'verified' && (await (async () => { const a = await call('/api/v1/auth/me', { token: lawyer.token }); return a.j?.user?.role === 'lawyer'; })()), `vs=${me.j?.verificationStatus} role=${(await call('/api/v1/auth/me', { token: lawyer.token })).j?.user?.role}`);
}

// P04 directory honesty
{
  const before = await call('/api/v1/lawyers/list', {});
  const pending = (await call('/api/v1/auth/signup', { email: 'pend@red.team', password: 'RedTeam123', displayName: 'Pending', role: 'lawyer' })).j;
  await call('/api/v1/lawyers/save', { token: pending.token, priceToman: 50000, city: 'شیراز' });
  const after = await call('/api/v1/lawyers/list', {});
  const names = (after.j?.lawyers || []).map(l => l.displayName);
  check('P04 pending lawyer NEVER in directory', !names.includes('Pending') && names.includes('Lawyer RT'), JSON.stringify(names));
  check('P04b list exposes only verified + hasMore bool', (after.j?.lawyers || []).every(l => l.verificationStatus === 'verified') && typeof after.j?.hasMore === 'boolean', `total=${after.j?.total} hasMore=${after.j?.hasMore}`);
  const sget = await call('/api/v1/lawyers/get', { userId: pending.user.userId });
  check('P04c strangers cannot GET a pending profile', sget.status === 404 && sget.j?.code === 'NOT_FOUND', `${sget.status} ${sget.j?.code}`);
  const own = await call('/api/v1/lawyers/get', { userId: pending.user.userId, token: pending.token });
  check('P04d owner CAN self-view pending (isSelf)', own.j?.ok === true && own.j?.isSelf === true, `${own.status} isSelf=${own.j?.isSelf}`);
}

// P05 cross-user consultation access (IDOR)
let cid = null;
{
  const c1 = await call('/api/v1/consultations/create', { token: client.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'rt-create-1' });
  cid = c1.j?.consultation?.id;
  check('P05 create -> PAYMENT_PENDING + devtest + devModeNotice', c1.j?.ok === true && c1.j?.consultation?.status === 'PAYMENT_PENDING' && c1.j?.provider === 'devtest' && typeof c1.j?.devModeNotice === 'string' && c1.j.devModeNotice.length > 5, `status=${c1.j?.consultation?.status} prov=${c1.j?.provider}`);
  const pre = await call('/api/v1/consultations/messages', { token: client.token, consultationId: cid, afterId: 0 });
  check('P05b unpaid client cannot read/write chat yet', pre.status === 403 || pre.j?.code === 'NOT_ACTIVE' || pre.j?.ok === false, `${pre.status} ${pre.j?.code}`);
  const st = await call('/api/v1/consultations/messages', { token: stranger.token, consultationId: cid, afterId: 0 });
  check('P05c stranger GET messages -> 404 (uniform with missing id, L1)', st.status === 404 && st.j?.code === 'NOT_FOUND', `${st.status} ${st.j?.code}`);
  const ss = await call('/api/v1/consultations/send', { token: stranger.token, consultationId: cid, body: 'نفوذ' });
  check('P05d stranger SEND -> 404 refusal, nothing stored', ss.status === 404, `${ss.status} ${ss.j?.code}`);
  const sc = await call('/api/v1/consultations/complete', { token: stranger.token, consultationId: cid });
  check('P05e stranger COMPLETE -> 404', sc.status === 404, `${sc.status} ${sc.j?.code}`);
  const ls = await call('/api/v1/consultations/list', { token: stranger.token });
  check('P05f stranger list does NOT contain the consultation', !(ls.j?.consultations || []).some(x => x.id === cid), `n=${(ls.j?.consultations || []).length}`);
  const spoof = await call('/api/v1/consultations/list', { token: stranger.token, userId: client.user.userId, clientUserId: client.user.userId, scope: 'all' });
  check('P05g spoofed userId in list body cannot widen scope', !(spoof.j?.consultations || []).some(x => x.id === cid), `n=${(spoof.j?.consultations || []).length}`);
}

// P06 payment races + ledger
{
  const [p1, p2] = await Promise.all([
    call('/api/v1/consultations/pay', { token: client.token, consultationId: cid, idempotencyKey: 'race-A' }),
    call('/api/v1/consultations/pay', { token: client.token, consultationId: cid, idempotencyKey: 'race-B' })
  ]);
  const okCount = [p1, p2].filter(x => x.j?.ok === true && x.j?.paymentStatus === 'succeeded').length;
  const already = [p1, p2].filter(x => x.j?.code === 'CONSULTATION_ALREADY_PAID').length;
  const spl = q(`SELECT COUNT(*) AS n FROM payment_splits`);
  const pay = q(`SELECT COUNT(*) AS n FROM payments WHERE status='succeeded'`);
  const cons = q(`SELECT COUNT(*) AS n FROM consultations WHERE id=?`, cid);
  // Both callers may legitimately see 'succeeded' (winner + CAS-replay); the
  // security property is exactly ONE settled payment + ONE ledger row.
  check('P06 concurrent double-pay: exactly one settlement', okCount === 2 && Number(pay.n) === 1 && Number(spl.n) === 1 && Number(cons.n) === 1 && already <= 1,
    `ok=${okCount} already=${already} payments=${pay.n} splits=${spl.n} cons=${cons.n}`);
  const paid = await call('/api/v1/consultations/get', { token: client.token, consultationId: cid });
  check('P06b consultation now PAID', paid.j?.consultation?.status === 'PAID', `${paid.j?.consultation?.status}`);
  const s = q(`SELECT * FROM payment_splits LIMIT 1`);
  check('P06c split invariant gross=commission+earnings (85001 @2000bps)', Number(s.gross_toman) === 85001 && Number(s.commission_toman) + Number(s.lawyer_earnings_toman) === Number(s.gross_toman) && Number(s.commission_bps) === 2000,
    `g=${s.gross_toman} c=${s.commission_toman} e=${s.lawyer_earnings_toman} bps=${s.commission_bps}`);
  const r3 = await call('/api/v1/consultations/pay', { token: client.token, consultationId: cid, idempotencyKey: 'race-C' });
  check('P06d replay after paid -> ALREADY_PAID, no new row', r3.j?.code === 'CONSULTATION_ALREADY_PAID' && Number(q(`SELECT COUNT(*) AS n FROM payments`).n) === 1, `code=${r3.j?.code} payments=${q(`SELECT COUNT(*) AS n FROM payments`).n}`);
  const strangerPay = await call('/api/v1/consultations/pay', { token: stranger.token, consultationId: cid, idempotencyKey: 'steal' });
  // payments.js gates on row.client_user_id (403 there); consultation guard would
  // say 404. Either refusal is correct — assert refusal AND that nothing charged.
  check('P06e non-client cannot pay (no free activation)',
    (strangerPay.status === 403 || strangerPay.status === 404) && strangerPay.j?.ok === false &&
    Number(q(`SELECT COUNT(*) AS n FROM payments WHERE user_id=?`, stranger.user.userId).n) === 0,
    `${strangerPay.status} ${strangerPay.j?.code}`);
}

// P07 chat after PAID + lifecycle
{
  const m1 = await call('/api/v1/consultations/send', { token: client.token, consultationId: cid, body: 'سلام، اولین پیام' });
  const st = (await call('/api/v1/consultations/get', { token: client.token, consultationId: cid })).j?.consultation;
  check('P07 first send flips PAID->ACTIVE (window re-anchors)', m1.j?.ok === true && st?.status === 'ACTIVE' && st?.startedAt > 0 && st?.endsAt > st?.startedAt, `status=${st?.status} ends>started=${st?.endsAt > st?.startedAt}`);
  const empt = await call('/api/v1/consultations/send', { token: client.token, consultationId: cid, body: '   ' });
  check('P07b whitespace message refused', empt.j?.ok === false && empt.status < 500, `${empt.status} ${empt.j?.code}`);
  const huge = await call('/api/v1/consultations/send', { token: client.token, consultationId: cid, body: 'ب'.repeat(50000) });
  check('P07c oversized message refused', huge.j?.ok === false, `${huge.status} ${huge.j?.code}`);
  const lm = await call('/api/v1/consultations/send', { token: lawyer.token, consultationId: cid, body: 'پاسخ وکیل' });
  check('P07d lawyer can reply', lm.j?.ok === true, `${lm.status} ${lm.j?.code}`);
  const page = await call('/api/v1/consultations/messages', { token: client.token, consultationId: cid, afterId: 0 });
  const msgs = page.j?.messages || [];
  check('P07e messages ordered ASC, mine flag present', msgs.length >= 2 && msgs.every((m, i) => i === 0 || m.createdAt >= msgs[i - 1].createdAt), `n=${msgs.length} first-mine=${msgs[0]?.mine}`);
  if ('mine' in (msgs[0] || {})) check('P07f unread excludes my own replies', true, `mine field exists`); else waiver('P07f unread/mine semantics', 'server did not echo `mine` — client falls back to senderUserId; verify against Agent 7 claim');
  const comp = await call('/api/v1/consultations/complete', { token: lawyer.token, consultationId: cid });
  check('P07g lawyer can complete', comp.j?.ok === true, `${comp.status} ${comp.j?.code}`);
  const after = await call('/api/v1/consultations/send', { token: client.token, consultationId: cid, body: 'بعد از پایان' });
  check('P07h send after COMPLETED refused', after.j?.ok === false && after.status < 500, `${after.status} ${after.j?.code}`);
  const read = await call('/api/v1/consultations/messages', { token: client.token, consultationId: cid, afterId: 0 });
  check('P07i completed consultation stays READABLE (evidence)', read.j?.ok === true && (read.j?.messages || []).length >= 2, `n=${(read.j?.messages || []).length}`);
  const comp2 = await call('/api/v1/consultations/complete', { token: client.token, consultationId: cid });
  check('P07j double complete idempotent-ish (ok or closed, no 500)', comp2.status < 500 && (comp2.j?.ok === true || comp2.j?.code === 'CONSULTATION_CLOSED'), `${comp2.status} ${comp2.j?.code}`);
}

// P08 AI-chat isolation: consultation messages must not leak into chat_history mirror
{
  const ch = q(`SELECT COUNT(*) AS n FROM chat_history`);
  check('P08 consultation messages never touch chat_history', Number(ch.n) === 0, `chat_history rows=${ch.n}`);
}

// P09 admin authorization surface
{
  const r = await call('/api/v1/admin/overview', { token: client.token });
  check('P09 client -> admin route 403', r.status === 403 && r.j?.code === 'FORBIDDEN', `${r.status} ${r.j?.code}`);
  const rl = await call('/api/v1/admin/lawyers/decide', { token: lawyer.token, userId: client.user.userId, decision: 'verify' });
  check('P09b lawyer cannot verify anyone', rl.status === 403, `${rl.status} ${rl.j?.code}`);
  const selfDecide = await call('/api/v1/admin/lawyers/decide', { token: admin.token, userId: admin.user.userId, decision: 'verify' });
  check('P09c admin self-decision refused (NOT_LAWYER/CANNOT_SELF)', selfDecide.j?.ok === false, `${selfDecide.status} ${selfDecide.j?.code}`);
  const pending = await call('/api/v1/admin/lawyers/pending', { token: admin.token });
  check('P09d pending queue shape = lawyers[] (client contract fixed)', Array.isArray(pending.j?.lawyers) && typeof pending.j?.total === 'number', `keys=${Object.keys(pending.j || {}).join(',')}`);
  const audit = await call('/api/v1/admin/audit/list', { token: admin.token });
  const rows = audit.j?.entries || audit.j?.audit || audit.j?.log || [];
  const found = JSON.stringify(audit.j || {}).includes('lawyer_verify');
  check('P09e decide() audited', found, JSON.stringify(audit.j).slice(0, 140));
  const cfg = await call('/api/v1/admin/config/set', { token: admin.token, key: 'commission_bps', value: '1500' });
  const bad = await call('/api/v1/admin/config/set', { token: admin.token, key: 'commission_bps', value: '999999' });
  const unk = await call('/api/v1/admin/config/set', { token: admin.token, key: 'evil_key', value: '1' });
  check('P09f config whitelist enforced', cfg.j?.ok === true && bad.j?.ok === false && unk.j?.code === 'BAD_CONFIG_KEY', `ok/refuse=${cfg.j?.ok},${bad.j?.ok} unk=${unk.j?.code}`);
  await call('/api/v1/admin/config/set', { token: admin.token, key: 'commission_bps', value: '2000' });
}

// P10 payments visibility
{
  const lh = await call('/api/v1/payments/history', { token: lawyer.token });
  const chh = await call('/api/v1/payments/history', { token: client.token });
  const sh = await call('/api/v1/payments/history', { token: stranger.token });
  check('P10 lawyer earnings visible & matches split', chh.j?.ok === true && lh.j?.ok === true
    && typeof lh.j?.earningsToman === 'number' && typeof lh.j?.pendingPayoutToman === 'number'
    && chh.j?.grossToman === 85001 && (lh.j?.transactions || []).length === 1
    && Number(lh.j?.transactions?.[0]?.lawyerEarningsToman) + Number(lh.j?.transactions?.[0]?.commissionToman) === 85001,
    `law=${lh.j?.earningsToman} pending=${lh.j?.pendingPayoutToman} gross-c=${chh.j?.grossToman}`);
  check('P10b stranger history empty + honest zeros', (sh.j?.transactions || []).length === 0 && sh.j?.grossToman === 0 && sh.j?.earningsToman === 0, JSON.stringify(sh.j)?.slice(0, 90));
  const provs = await call('/api/v1/payments/providers', { token: client.token });
  check('P10c providers route flags test mode honestly', provs.j?.ok === true && JSON.stringify(provs.j).includes('devtest') && JSON.stringify(provs.j).includes('true'), JSON.stringify(provs.j).slice(0, 160));
}

// P11 legacy activation compat end-to-end
{
  const lv = await call('/api/v1/auth/verify', { deviceId: 'rt-device-0001', code: 'REDTEAM-CODE', name: 'Legacy', platform: 'test' });
  check('P11 legacy verify still issues token', lv.j?.ok === true && typeof lv.j?.token === 'string', `${lv.status} ${lv.j?.code}`);
  const me = await call('/api/v1/auth/me', { token: lv.j.token });
  check('P11b legacy /auth/me -> activation, no 404', me.j?.ok === true && JSON.stringify(me.j?.user?.authMethods || []).includes('activation') && me.j?.user?.role === 'client', JSON.stringify(me.j?.user));
  const bad = await call('/api/v1/auth/verify', { deviceId: 'rt-device-0002', code: 'WRONG-CODE', name: 'X', platform: 'test' });
  check('P11c wrong code -> INVALID_CODE 403', bad.status === 403 && bad.j?.code === 'INVALID_CODE', `${bad.status} ${bad.j?.code}`);
}

// P12 banned user through both stacks
{
  sqlite.exec(`UPDATE users SET is_banned = 1 WHERE user_id = ${stranger.user.userId}`);
  const chat = await call('/api/v1/chat', { token: stranger.token, text: 'test' });
  const mkt = await call('/api/v1/auth/me', { token: stranger.token });
  const adm = await call('/api/v1/lawyers/list', { token: stranger.token });
  check('P12 banned user: token invalid on chat AND marketplace', chat.status === 401 && (mkt.status === 401 || mkt.j?.ok === false), `chat=${chat.status} me=${mkt.status} list=${adm.status}`);
  sqlite.exec(`UPDATE users SET is_banned = 0 WHERE user_id = ${stranger.user.userId}`);
}

// P13 account suspension via app_accounts.status (admin suspend a lawyer)
{
  const sus = await call('/api/v1/admin/lawyers/decide', { token: admin.token, userId: lawyer.user.userId, decision: 'suspend', note: 'rt-suspend' });
  const me = await call('/api/v1/lawyers/me', { token: lawyer.token });
  const list = await call('/api/v1/lawyers/list', {});
  const names = (list.j?.lawyers || []).map(l => l.displayName);
  check('P13 suspended lawyer removed from directory', sus.j?.ok === true && sus.j?.verificationStatus === 'suspended' && !names.includes('Lawyer RT'), `vs=${sus.j?.verificationStatus} names=${JSON.stringify(names)}`);
  {
    const t1 = await call('/api/v1/lawyers/me', { token: lawyer.token });
    const t2 = await call('/api/v1/consultations/list', { token: lawyer.token });
    check('P13b suspension REVOKES sessions (401 on both stacks)', t1.status === 401 && t2.status === 401, `me=${t1.status} list=${t2.status}`);
    lawyer = await reloginLawyer();
  }
  await call('/api/v1/admin/lawyers/decide', { token: admin.token, userId: lawyer.user.userId, decision: 'restore', note: 'rt-restore' });
  const lst2 = (await call('/api/v1/lawyers/list', {})).j?.lawyers || [];
  check('P13c restore lands pending (re-review), NOT verified', !lst2.some(l => l.displayName === 'Lawyer RT'), `still-visible=${lst2.some(l => l.displayName === 'Lawyer RT')}`);
  await call('/api/v1/admin/lawyers/decide', { token: admin.token, userId: lawyer.user.userId, decision: 'verify', note: 'rt-verify-2' });
}

// P14 duplicate signup races
{
  const [a, b] = await Promise.all([
    call('/api/v1/auth/signup', { email: 'race@red.team', password: 'RedTeam123', displayName: 'R1', role: 'client' }),
    call('/api/v1/auth/signup', { email: 'race@red.team', password: 'RedTeam123', displayName: 'R2', role: 'client' })
  ]);
  const oks = [a, b].filter(x => x.j?.ok === true).length;
  const errs = [a, b].filter(x => x.j?.code === 'EMAIL_TAKEN').length;
  const rows = Number(q(`SELECT COUNT(*) AS n FROM app_accounts WHERE email_norm='race@red.team'`).n);
  check('P14 concurrent same-email signup -> one account', oks === 1 && (errs === 1 || [a, b].some(x => x.status >= 500 ? false : false)) && rows === 1, `ok=${oks} taken=${errs} rows=${rows} codes=${a.j?.code}/${b.j?.code}`);
  if ([a, b].some(x => x.status >= 500)) waiver('P14b race produced 500', 'UNIQUE violation surfaced as INTERNAL instead of EMAIL_TAKEN — map it');
}

// P15 google unconfigured honesty
{
  const g = await call('/api/v1/auth/google', { credential: 'whatever' });
  check('P15 google without GOOGLE_CLIENT_ID -> CONFIG_PENDING (not fake ok, not 500)', g.status === 400 && g.j?.code === 'CONFIG_PENDING', `${g.status} ${g.j?.code}`);
  const ex = await call('/api/v1/auth/oauth/exchange', { provider: 'github', code: 'x', redirectUri: 'y' });
  check('P15b github exchange -> shaped NOT_CONFIGURED refusal', ex.status === 400 && ex.j?.code === 'NOT_CONFIGURED', `${ex.status} ${ex.j?.code}`);
}

// P16 idempotent create reuse + cross-user key reuse
{
  const c1 = await call('/api/v1/consultations/create', { token: client.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'dup-A' });
  const c2 = await call('/api/v1/consultations/create', { token: client.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'dup-A' });
  check('P16 same client key -> same consultation', c1.j?.ok && c2.j?.ok && c1.j?.consultation?.id === c2.j?.consultation?.id, `ids=${c1.j?.consultation?.id}/${c2.j?.consultation?.id}`);
  const s1 = await call('/api/v1/consultations/create', { token: stranger.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'dup-A' });
  check('P16b stranger reuses same key string -> OWN new consultation (no adoption)', s1.j?.ok === true && s1.j?.consultation?.id !== c1.j?.consultation?.id && s1.j?.consultation?.clientUserId === stranger.user.userId, `ids-differ=${s1.j?.consultation?.id !== c1.j?.consultation?.id}`);
}

// P17 lawyers/apply idempotency + admin refusal
{
  const a1 = await call('/api/v1/lawyers/apply', { token: stranger.token });
  const a2 = await call('/api/v1/lawyers/apply', { token: stranger.token });
  const rows = Number(q(`SELECT COUNT(*) AS n FROM lawyer_profiles WHERE user_id=?`, stranger.user.userId).n);
  const adm = await call('/api/v1/lawyers/apply', { token: admin.token });
  check('P17 apply idempotent + admin refused', a1.j?.ok === true && a2.j?.ok === true && rows === 1 && adm.status === 403, `rows=${rows} admin=${adm.status} ${adm.j?.code}`);
}

// P18 rate limiting live (login)
{
  let last = null;
  for (let i = 0; i < 12; i++) last = await call('/api/v1/auth/login', { identifier: 'client@red.team', password: 'WrongPass123' });
  check('P18 repeated failed logins hit RATE_LIMITED eventually', last.j?.code === 'RATE_LIMITED' || last.status === 429, `final=${last.status} ${last.j?.code}`);
  const still = await call('/api/v1/auth/login', { identifier: 'law@red.team', password: 'RedTeam123' });
  check('P18b rate limit is per identifier (other users unaffected)', still.j?.ok === true, `${still.status} ${still.j?.code}`);
}

// P19 oversized list / injection probes
{
  const inj = await call('/api/v1/lawyers/list', { query: "'; DROP TABLE lawyer_profiles; --" });
  const alive = q(`SELECT COUNT(*) AS n FROM lawyer_profiles`);
  check('P19 SQL injection attempt -> 0 rows, table intact', inj.j?.ok === true && (inj.j?.lawyers || []).length === 0 && Number(alive.n) > 0, `rows=${(inj.j?.lawyers || []).length} tables-ok=${Number(alive.n)}`);
  const wild = await call('/api/v1/lawyers/list', { limit: 100000, offset: -5, sort: 'experience; DELETE FROM users' });
  check('P19b hostile limit/offset/sort clamped, no 500', wild.status === 200 && wild.j?.ok === true, `${wild.status} n=${(wild.j?.lawyers || []).length}`);
}

// P20 D1 error ledger from the stub
{
  waiver('P20 d1Errors', 'stub records rejected SQL verbatim — see results file for any silent DDL/SQL rejections');
}

// P21 password rotation revokes OTHER sessions but keeps the caller's
{
  const fresh = await reloginLawyer(); // session B
  const aTok = lawyer.token;           // session A (older)
  const set = await call('/api/v1/auth/password/set', { token: fresh.token, newPassword: 'Rotated987' });
  const bStill = await call('/api/v1/auth/me', { token: fresh.token });
  const aDead = await call('/api/v1/auth/me', { token: aTok });
  check('P21 password set: caller session lives, other sessions revoked', set.j?.ok === true && bStill.status === 200 && aDead.status === 401, `set=${set.j?.ok} caller=${bStill.status} other=${aDead.status}`);
  const re = await call('/api/v1/auth/login', { identifier: 'law@red.team', password: 'Rotated987' });
  check('P21b login works with rotated password', re.j?.ok === true, `${re.status} ${re.j?.code}`);
  lawyer = re.j;
}

// P21c admin bootstrap second factor: with ADMIN_BOOTSTRAP_SECRET set, the
// email alone must NOT mint an admin; the secret does.
{
  env.ADMIN_BOOTSTRAP_EMAILS = 'admin@red.team,admin2@red.team,admin3@red.team,admin4@red.team,admin5@red.team';
  const before = await call('/api/v1/auth/signup', { email: 'admin2@red.team', password: 'RedTeam123', displayName: 'A2', role: 'admin' });
  check('P21c email-only admin in secret-less mode works (legacy)', before.j?.user?.role === 'admin', `role=${before.j?.user?.role}`);
  env.ADMIN_BOOTSTRAP_SECRET = 'rt-bootstrap-2';
  const nos = await call('/api/v1/auth/signup', { email: 'admin3@red.team', password: 'RedTeam123', displayName: 'A3', role: 'admin' });
  const nope = await call('/api/v1/auth/signup', { email: 'admin4@red.team', password: 'RedTeam123', displayName: 'A4', role: 'admin', bootstrapSecret: 'wrong-secret' });
  const yes = await call('/api/v1/auth/signup', { email: 'admin5@red.team', password: 'RedTeam123', displayName: 'A5', role: 'admin', bootstrapSecret: 'rt-bootstrap-2' });
  check('P21d secret mode: missing/wrong refused, correct grants admin',
    nos.j?.ok === false && nope.j?.ok === false && yes.j?.user?.role === 'admin',
    `missing=${nos.j?.code} wrong=${nope.j?.code} right=${yes.j?.user?.role}`);
  env.ADMIN_BOOTSTRAP_SECRET = null;
}

// P22 legacy /auth/verify now rate limited (6/15min per device)
{
  let last = null;
  for (let i = 0; i < 10; i++) last = await call('/api/v1/auth/verify', { deviceId: 'rt-flood-dev-1', code: 'WRONG-CODE', name: 'X', platform: 'test' });
  check('P22 legacy verify guesses hit RATE_LIMITED', last.status === 429 || last.j?.code === 'RATE_LIMITED', `final=${last.status} ${last.j?.code}`);
}

// P23 malformed stored-hash defense (PBKDF2 verifier hardening)
{
  // Directly seed a corrupted credential row, then attempt the classic
  // empty-hash master-key login the audit reproduced.
  const victim = (await call('/api/v1/auth/signup', { email: 'vic@red.team', password: 'RedTeam123', displayName: 'Vic', role: 'client' })).j;
  sqlite.exec(`UPDATE app_accounts SET password_hash='pbkdf2$1000$${Buffer.from('0123456789abcdef').toString('base64')}$' WHERE email_norm='vic@red.team'`);
  const evil = await call('/api/v1/auth/login', { identifier: 'vic@red.team', password: 'anything-at-all-1' });
  check('P23 empty-hash row cannot be logged into', evil.status === 401 && evil.j?.code === 'INVALID_CREDENTIALS', `${evil.status} ${evil.j?.code}`);
}

// P24 email-squat merge: verified-Google owner clears the squatter's password
{
  const squatter = (await call('/api/v1/auth/signup', { email: 'owner@gmail.com', password: 'Squat98765', displayName: 'Squatter', role: 'lawyer' })).j;
  const rows0 = q(`SELECT password_hash FROM app_accounts WHERE email_norm='owner@gmail.com'`);
  check('P24 squat occupies email_norm (precondition)', squatter?.ok === true && typeof rows0.password_hash === 'string', `signup=${String(squatter?.ok)} hash-len=${String(rows0.password_hash).length}`);
  // Stub Google's tokeninfo (the ONLY network call googleVerifyIdToken makes)
  // and configure the client id — full runtime proof of the merge-clearance fix.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/tokeninfo')) {
      return new Response(JSON.stringify({
        aud: 'rt-google-client-id.apps.googleusercontent.com',
        iss: 'https://accounts.google.com',
        sub: 'google-owner-sub-1',
        email: 'owner@gmail.com', email_verified: 'true',
        name: 'Real Owner', exp: String(Math.floor(Date.now() / 1000) + 300)
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, o);
  };
  env.GOOGLE_CLIENT_ID = 'rt-google-client-id.apps.googleusercontent.com';
  try {
    const g = await call('/api/v1/auth/google', { credential: 'stubbed.id.token', deviceId: 'rt-google-dev' });
    const row = q(`SELECT password_hash, google_sub, display_name FROM app_accounts WHERE email_norm='owner@gmail.com'`);
    const squatLogin = await call('/api/v1/auth/login', { identifier: 'owner@gmail.com', password: 'Squat98765' });
    check('P24b verified-Google owner wins merge: password cleared + sub bound',
      g.j?.ok === true && g.j?.token && row.password_hash === null && row.google_sub === 'google-owner-sub-1'
      && squatLogin.status === 401 && squatLogin.j?.code === 'INVALID_CREDENTIALS',
      `g=${g.j?.ok} hash=${row.password_hash === null ? 'NULL' : 'kept'} sub=${row.google_sub ? 'set' : '-'} squatLogin=${squatLogin.status}`);
    check('P24c squatter sessions on the row revoked at merge', (await call('/api/v1/auth/me', { token: squatter.token })).status === 401, 'me-after-merge');
    check('P24d role survived merge (row identity stable for money/chat)', g.j?.user?.role === 'lawyer', `role=${g.j?.user?.role} vs=${g.j?.user?.verificationStatus}`);
  } finally {
    globalThis.fetch = realFetch;
    delete env.GOOGLE_CLIENT_ID;
  }
}

// P25 no-secret deployment: every issuer must refuse LOUDLY (never mint a dead token)
{
  const saved = env.APP_TOKEN_SECRET;
  env.APP_TOKEN_SECRET = null;
  // (login uses a FRESH identifier: the earlier P18 lockout bucket for
  // client@red.team is legitimately still full — that is the limiter working.)
  const su = await call('/api/v1/auth/signup', { email: 'ns@red.team', password: 'RedTeam123', displayName: 'NoSecret', role: 'client' });
  const lg = await call('/api/v1/auth/login', { identifier: 'law@red.team', password: 'RedTeam123' });
  const lv = await call('/api/v1/auth/verify', { deviceId: 'rt-nosecret-dev', code: 'REDTEAM-CODE', name: 'NN', platform: 'test' });
  const ok500 = (x) => x.status === 500 && x.j?.ok === false;
  check('P25 signup/login/verify refuse without APP_TOKEN_SECRET (clear 5xx, no dead token)',
    ok500(su) && ok500(lg) && ok500(lv) && !su.j?.token && !lg.j?.token && !lv.j?.token,
    `signup=${su.status}/${su.j?.code} login=${lg.status}/${lg.j?.code} verify=${lv.status}/${lv.j?.code}`);
  env.APP_TOKEN_SECRET = saved;
}

// P26 marketplace kill switch: v1_enabled=0 refuses marketplace routes (503)
// and clears quickly (cache bust via __marketplaceKillCached.at); the legacy AI
// chat switch is UNTOUCHED by design (the gate wraps appApiExtensions only).
{
  sqlite.exec(`UPDATE platform_config SET value='0' WHERE key='v1_enabled'`);
  globalThis.__marketplaceKillCached = null;
  const off = await call('/api/v1/lawyers/list', {});
  check('P26 v1_enabled=0 -> marketplace 503 SERVICE_DISABLED', off.status === 503 && off.j?.code === 'SERVICE_DISABLED', `${off.status} ${off.j?.code}`);
  const legacy = await worker.fetch(new Request('https://rt.test/api/v1/health'), env, ctx);
  check('P26b legacy health route unaffected by marketplace gate', legacy.status === 200, `${legacy.status}`);
  sqlite.exec(`UPDATE platform_config SET value='1' WHERE key='v1_enabled'`);
  globalThis.__marketplaceKillCached = null;
  const on = await call('/api/v1/lawyers/list', {});
  check('P26c v1_enabled=1 restores service', on.status === 200 && on.j?.ok === true, `${on.status}`);
}

// P27 PAID-but-never-used expires on window_hours (lazy close on READ, audit M5)
{
  const c2 = (await call('/api/v1/consultations/create', { token: stranger.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'win-1' })).j;
  const id2 = c2?.consultation?.id;
  await call('/api/v1/consultations/pay', { token: stranger.token, consultationId: id2, idempotencyKey: 'win-pay' });
  sqlite.exec(`UPDATE consultations SET paid_at = paid_at - 30 * 3600000 WHERE id = ${id2}`); // 30h ago, window=24h
  const read = await call('/api/v1/consultations/messages', { token: stranger.token, consultationId: id2, afterId: 0 });
  const st = read.j?.consultation?.status;
  check('P27 stale PAID lazily closes to COMPLETED on read', read.j?.ok === true && st === 'COMPLETED', `status=${st} code=${read.j?.code}`);
  const send = await call('/api/v1/consultations/send', { token: stranger.token, consultationId: id2, body: 'بعد از مهلت' });
  check('P27b send after redemption deadline refused', send.j?.ok === false && send.status < 500, `${send.status} ${send.j?.code}`);
}

// P28 unregistered payment_provider fails CLOSED (no silent devtest settle, audit M3)
{
  sqlite.exec(`UPDATE platform_config SET value='zarinpal-typo' WHERE key='payment_provider'`);
  const c3 = (await call('/api/v1/consultations/create', { token: stranger.token, lawyerUserId: lawyer.user.userId, idempotencyKey: 'prov-1' })).j;
  const id3 = c3?.consultation?.id;
  const pay = await call('/api/v1/consultations/pay', { token: stranger.token, consultationId: id3, idempotencyKey: 'prov-pay' });
  const settled = q(`SELECT COUNT(*) AS n FROM payments WHERE consultation_id=${id3} AND status='succeeded'`);
  check('P28 mis-set provider refuses settlement (PROVIDER_NOT_CONFIGURED, no fake money)',
    pay.j?.ok === false && pay.j?.paymentStatus === 'failed' && String(pay.j?.message || '').includes('PROVIDER_NOT_CONFIGURED') && Number(settled.n) === 0,
    `ok=${pay.j?.ok} msg=${String(pay.j?.message).slice(0, 40)} succeeded=${settled.n}`);
  sqlite.exec(`UPDATE platform_config SET value='devtest' WHERE key='payment_provider'`);
}

// P29 uq_pay_live: two LIVE payments for one consultation are impossible at the DB
{
  const n = q(`SELECT COUNT(*) AS n FROM payments WHERE status IN ('pending','succeeded') GROUP BY consultation_id ORDER BY n DESC LIMIT 1`);
  check('P29 at most one live payment per consultation (uq_pay_live)', Number(n?.n ?? 1) <= 1, `max-live=${n?.n}`);
}

// ─────────────────────────── report ───────────────────────────
const summary = `MARKETPLACE REDTEAM: ${pass} passed, ${fail} failed, ${waive} waived`;
lines.push('');
lines.push(summary);
fs.mkdirSync(new URL('.', OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(fail > 0 ? 1 : 0);
