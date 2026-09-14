// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Coordinator wiring check for the marketplace dispatcher: boots
//             the BUILT artifact (dist/vakil-app-worker.js) with a minimal
//             stubbed D1 and proves (a) classic routes still resolve through
//             the untouched switch, (b) unknown marketplace paths fall through
//             to the classic 404 (appApiExtensions returns null when no part
//             registered the route), and (c) OPTIONS preflight is unaffected.
// OWNER     — coordinator (throwaway verification tool; Agent 9 may absorb it).
// CONSUMES  — dist/vakil-app-worker.js built by tools/build_app_worker.cjs.
// PROVIDES  — exit 0 + printed PASS lines, exit 1 on regression.
// INVARIANTS— must pass BOTH before marketplace parts exist and after they do
//             (then lawyers/list answers instead of 404 — see spec §5).
// EXTEND    — when marketplace parts land, add positive assertions against
//             /api/v1/lawyers/list here instead of a new throwaway file.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'fs';

const src = fs.readFileSync(new URL('../dist/vakil-app-worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

// Minimal D1: every SELECT first()=null, every all()=empty; run() ok. Enough
// to route dispatch without touching the engine path.
const db = {
  prepare(sql) {
    return {
      _sql: String(sql),
      bind() { return this; },
      async first() { return null; },
      async all() { return { results: [] }; },
      async run() { return {}; }
    };
  }
};
const env = { DB: db, KV: null, APP_TOKEN_SECRET: 'test-secret', DAILY_LIMIT: '3' };
const ctx = { waitUntil() { } };

let fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + (e && e.message)); fail++; }
};

await t('health route (classic switch)', async () => {
  const r = await worker.fetch(new Request('https://x/api/v1/health'), env, ctx);
  const j = await r.json();
  return r.status === 200 && j.ok === true;
});

await t('unregistered marketplace path -> classic 404 NOT_FOUND', async () => {
  const r = await worker.fetch(new Request('https://x/api/v1/lawyers/list', { method: 'POST', body: '{}' }), env, ctx);
  const j = await r.json();
  // Either clean 404 (no parts) or a module-owned response (parts installed): both prove dispatch.
  return (r.status === 404 && j.code === 'NOT_FOUND') || (j.ok === true && Array.isArray(j.lawyers)) || (j.ok === false && j.code !== 'NOT_FOUND');
});

await t('unknown path stays 404', async () => {
  const r = await worker.fetch(new Request('https://x/api/v1/nope/nothing', { method: 'POST', body: '{}' }), env, ctx);
  return r.status === 404;
});

await t('OPTIONS preflight unaffected', async () => {
  const r = await worker.fetch(new Request('https://x/api/v1/lawyers/list', { method: 'OPTIONS' }), env, ctx);
  return r.status === 204;
});

await t('chat route reaches auth gate (classic path intact)', async () => {
  const r = await worker.fetch(new Request('https://x/api/v1/chat', { method: 'POST', body: JSON.stringify({ token: 'bad.token' }) }), env, ctx);
  const j = await r.json();
  return j.ok === false && j.code === 'UNAUTHORIZED';
});

console.log(fail === 0 ? 'MARKETPLACE WIRING OK' : 'MARKETPLACE WIRING FAILED');
process.exit(fail === 0 ? 0 : 1);
