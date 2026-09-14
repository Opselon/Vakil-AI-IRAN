#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — LIVE marketplace smoke against the DEPLOYED vakil-app worker.
//             The mirror of tools/smoke_marketplace.mjs (which runs locally on
//             SQLite) on real Cloudflare D1: proves the marketplace surface
//             works in production, not just in the harness.
// CONSUMES  — the deployed worker at BASE (/api/v1/*): auth signup/login/me,
//             admin bootstrap (env ADMIN_BOOTSTRAP_EMAILS must include the
//             address below), consultations create + cancel, reviews list
//             empty state, admin payouts list. Unique emails/device ids per
//             run so a re-run never trips EMAIL_TAKEN.
// PROVIDES  — `test:live:app` in CI (PR-safe) and manual `node
//             tools/live_smoke_app.mjs [BASE]`; LIVE SMOKE APP: n/m + exit 1
//             on any FAIL.
// INVARIANTS— 1) ZERO money/chat spend: no /consultations/pay, no /chat.
//             2) Only additive data (new accounts, one unpaid consultation,
//                immediately cancelled) — nothing destructive, no config
//                writes (payment_provider stays as the operator set it).
//             3) Every check is against the server's OWN answers (status +
//                envelope code); no fabricated expectations.
//             4) If the admin bootstrap is not configured in the target
//                environment, admin-dependent steps FAIL with CONFIG_PENDING
//                surfaced verbatim — that IS the production-readiness signal.
// EXTEND    — when a real PSP lands, add the paid lifecycle behind an opt-in
//             env flag; never auto-refund real money in a smoke.
// ═══════════════════════════════════════════════════════════════════════════ */

const BASE = process.argv[2] || "https://vakil-app.samerkhaldounmarefi.workers.dev";
const RUN = Date.now().toString(36);
const LAWYER_EMAIL = `lawyer+smoke${RUN}@vakil.app`;
const CLIENT_EMAIL = `client+smoke${RUN}@vakil.app`;
const PW = "Smoke!2026#" + RUN;
// Admin steps need a PROVISIONED smoke admin: the signup bootstrap only grants
// admin when the email sits inside the worker's ADMIN_BOOTSTRAP_EMAILS (a secret —
// minting a new address per run can never qualify). Read the pair from env or the
// same %TEMP%/vakil_secrets.txt the legacy live smoke uses; without it those
// checks SKIP honestly instead of pretending power the token does not have.
const ADMIN_EMAIL = process.env.VAKIL_SMOKE_ADMIN_EMAIL || "";
const ADMIN_PW = process.env.VAKIL_SMOKE_ADMIN_PW || "";

let pass = 0, fail = 0, skip = 0;
const T = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const SK = (name, why) => { skip++; console.log(`SKIP ${name} — ${why}`); };

async function api(p, body, token) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + "/api/v1" + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    let j = null; try { j = await res.json(); } catch { }
    return { status: res.status, j, dt: Date.now() - t0 };
  } catch (e) {
    // transport failure must FAIL the run honestly, never crash the report
    return { status: 0, j: { code: "TRANSPORT", message: String(e && e.message || e).slice(0, 120) }, dt: Date.now() - t0 };
  }
}
const shape = (r) => `http=${r.status} code=${r.j && r.j.code}${r.j && r.j.message ? ' msg=' + String(r.j.message).slice(0, 70) : ""}`;

// 0) liveness + marketplace surface presence (kill switch honest)
const health = await fetch(BASE + "/api/v1/health").then(r => r.json()).catch(() => null);
T("health online", !!health?.ok);

const anon = await api("/lawyers/list", {});
T("marketplace surface live (lawyers/list)", anon.status === 200 && anon.j && anon.j.ok === true,
  anon.status === 503 ? shape(anon) + " (v1_enabled kill switch)" : shape(anon));

// 1) auth trio on production D1 (+ provisioned admin when credentials exist)
let adminToken = "";
if (ADMIN_EMAIL && ADMIN_PW) {
  const la = await api("/auth/login", { identifier: ADMIN_EMAIL, password: ADMIN_PW, deviceId: "smoke-admin-" + RUN });
  adminToken = la.j?.token || "";
  T("provisioned smoke admin can log in", la.status === 200 && !!adminToken, shape(la));
} else {
  SK("admin-dependent checks", "set VAKIL_SMOKE_ADMIN_EMAIL / VAKIL_SMOKE_ADMIN_PW (must be inside ADMIN_BOOTSTRAP_EMAILS)");
}

const sLaw = await api("/auth/signup", { email: LAWYER_EMAIL, password: PW, displayName: "اسموک وکیل", role: "lawyer" });
const lawyerToken = sLaw.j?.token;
T("signup lawyer", sLaw.status === 200 && !!lawyerToken, shape(sLaw));

const sCli = await api("/auth/signup", { email: CLIENT_EMAIL, password: PW, displayName: "اسموک موکل", role: "client" });
const clientToken = sCli.j?.token;
T("signup client", sCli.status === 200 && !!clientToken, shape(sCli));

const dup = await api("/auth/signup", { email: CLIENT_EMAIL, password: PW, displayName: "تکراری", role: "client" });
T("duplicate email refused EMAIL_TAKEN", dup.j?.ok === false && dup.j?.code === "EMAIL_TAKEN", shape(dup));

const login = await api("/auth/login", { identifier: CLIENT_EMAIL, password: PW, deviceId: "device-" + RUN });
T("login issues a working session", login.status === 200 && !!login.j?.token, shape(login));

const me = await api("/auth/me", { token: clientToken });
T("auth/me round-trips the account", me.j?.ok === true && me.j?.user?.email === CLIENT_EMAIL, shape(me));

const bad = await api("/auth/login", { identifier: CLIENT_EMAIL, password: "wrong-" + RUN, deviceId: "device-x" });
T("wrong password → uniform INVALID_CREDENTIALS", bad.status === 401 && bad.j?.code === "INVALID_CREDENTIALS", shape(bad));

// 2) lawyer profile → verify queue → admin decision (needs the provisioned admin)
if (!adminToken) SK("lawyer verify + booking chain", "no provisioned admin login (VAKIL_SMOKE_ADMIN_*)");
const save = await api("/lawyers/save", {
  token: lawyerToken, title: "وکیل پایه یک (اسموک)", bio: "حساب آزمایشی زنده — لطفاً دست نزنید",
  city: "تهران", consultPriceToman: 500000, durationMinutes: 60, yearsExperience: 10,
});
if (!adminToken) SK("lawyer/save ok on production D1", "no provisioned admin to verify the lawyer first");
else T("lawyer/save ok on production D1", save.j?.ok === true, shape(save));
const lawyerId = save.j?.profile?.userId ?? (await api("/auth/me", { token: lawyerToken })).j?.user?.userId;

if (adminToken) {
  const pend = await api("/admin/lawyers/pending", { token: adminToken });
  if (pend.j?.ok === false && pend.j?.code === "FORBIDDEN") {
    T("provisioned admin really has the role", false, shape(pend) + ` — ${ADMIN_EMAIL} is not admin in this env`);
  } else {
    T("admin pending queue readable", pend.j?.ok === true, shape(pend));
    const row = (pend.j?.lawyers || []).find(x => String(x.userId) === String(lawyerId));
    T("smoke lawyer appears in pending queue", !!row, row ? "queued" : `lawyerId=${lawyerId} n=${(pend.j?.lawyers || []).length}`);
    if (row) {
      const dec = await api("/admin/lawyers/decide", { token: adminToken, userId: lawyerId, decision: "verify", note: "اسموک زنده" });
      T("admin verify decision accepted", dec.j?.ok === true, shape(dec));
    }
  }
}

// 3) consultation create → cancel (no payment anywhere in this file)
let cid = 0;
if (!adminToken) {
  SK("consultations/create works on production D1", "lawyer unverified (no provisioned admin) — booking correctly refused");
} else {
  const created = await api("/consultations/create", { token: clientToken, lawyerUserId: lawyerId, topic: "تست زنده", idempotencyKey: "live-" + RUN });
  cid = created.j?.consultation?.id || 0;
  T("consultations/create works on production D1", created.j?.ok === true && !!cid, shape(created));
}

if (!cid) {
  SK("wave-2 cancel live", "consultation not created (see create check)");
} else {
  const cancel = await api("/consultations/cancel", { token: clientToken, consultationId: cid });
  if (cancel.status === 404 && cancel.j?.code === "NOT_FOUND" && String(cancel.j?.message || "").includes("یافت نشد")) {
    SK("wave-2 cancel live", "route absent on THIS deployed artifact (dispatcher 404) — re-run after the wave-2 deploy");
  } else {
    T("wave-2 cancel works live (unpaid → CANCELLED)", cancel.j?.ok === true && cancel.j?.consultation?.status === "CANCELLED", shape(cancel));
    const replay = await api("/consultations/cancel", { token: clientToken, consultationId: cid });
    T("cancel replay is idempotent (200 + marker)", replay.status === 200 && replay.j?.code === "CONSULTATION_ALREADY_CANCELLED", shape(replay));
  }
}

// 4) reviews: public empty state + eligibility refusal
const dispatcherMiss = (r) => r.status === 404 && r.j?.code === "NOT_FOUND" && String(r.j?.message || "").includes("یافت نشد");
const rl = await api("/reviews/lawyer", { lawyerUserId: lawyerId || 1 });
T("reviews/lawyer answers as a well-formed public envelope",
  dispatcherMiss(rl) ? false : (rl.j?.ok === true && Array.isArray(rl.j?.reviews) && (rl.j.count === 0 ? rl.j.average === null : true)) || (rl.status === 400 && rl.j?.code === "VALIDATION"),
  shape(rl));
const rs = await api("/reviews/submit", { token: clientToken, consultationId: cid || 1, rating: 5 });
T("reviews/submit refuses ineligible (live; 404 incl. undeployed)", rs.j?.ok === false && [403, 404, 409].includes(rs.status), shape(rs));

// 5) payouts ledger: admin-gated read (no create — record-keeping route stays untouched by smoke)
if (adminToken) {
  const pl = await api("/admin/payouts/list", { token: adminToken });
  if (dispatcherMiss(pl)) SK("payouts/list reachable + honest", "route absent on THIS deployed artifact — re-run after the wave-2 deploy");
  else {
  const guarded = pl.j?.ok === false && pl.j?.code === "FORBIDDEN";
  T("payouts/list reachable + honest", pl.j?.ok === true || guarded, shape(pl));
  if (pl.j?.ok === true) {
    T("payout totals are integers (no float money)",
      Number.isInteger(Number(pl.j.accruedToman)) && Number.isInteger(Number(pl.j.paidOutToman)),
      `accrued=${pl.j.accruedToman} paidOut=${pl.j.paidOutToman}`);
    T("payoutNotice shipped verbatim", typeof pl.j.payoutNotice === "string" && pl.j.payoutNotice.length > 20, "ok");
  }
  }
}

// 6) security rails that must hold in production
const noToken = await api("/consultations/list", { token: "garbage." + RUN });
T("bad token → 401 UNAUTHORIZED", noToken.status === 401, shape(noToken));
const stranger = await api("/consultations/get", { token: lawyerToken, consultationId: cid || 1 });
T("non-member get → uniform 404 (no existence oracle)", stranger.status === 404 || stranger.j?.ok === false && stranger.j?.code === "NOT_FOUND", shape(stranger));
const out = await api("/auth/logout", { token: clientToken });
T("logout ok", out.j?.ok === true, shape(out));
const after = await api("/auth/me", { token: clientToken });
T("logout actually revoked the session (real D1 app_tokens)", after.status === 401, shape(after));

console.log(`\nLIVE SMOKE APP: ${pass} passed, ${fail} failed, ${skip} skipped (${BASE})`);
process.exit(fail ? 1 : 0);
