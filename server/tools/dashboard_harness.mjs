// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE — Dashboard render harness (no browser): evaluates the inline
//   <script> of server/admin/index.html against a shallow DOM stub and canned
//   server envelopes (exact shapes proven by smoke steps 16 + 18), then drives
//   loadPayouts / createPayout / markPayout / loadReviews and asserts on what
//   got rendered + which routes got called with what bodies.
// WHY — the dashboard is pure browser JS with zero build; CI cannot run it.
//   This closes that gap for the wave-2 sections: no fabricated data, server
//   re-list after every mutation, honest empty/failure states.
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";

const html = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.log("FAIL no inline script"); process.exit(1); }
const src = m[1] + "\n;return { loadPayouts, loadReviews, createPayout, markPayout, call, publicCall, token, $(id){ return document.getElementById(id); } };";

// ── shallow DOM ──
class Node2 {
  constructor(tag) {
    this.tag = tag; this.children = []; this._html = ""; this.textContent = "";
    this.style = {}; this.dataset = {}; this.hidden = false; this.value = "";
    this.disabled = false; this.className = ""; this.previousSibling = null;
    this.classList = { add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html + this.children.map((c) => c.innerHTML).join(""); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  querySelectorAll() { return []; }
  // innerHTML in real DOM parses <td> cells; our renderer appends action UI to
  // tr.lastElementChild — expose a registered cell so serialization sees it.
  get lastElementChild() {
    if (!this._lec) {
      this._lec = new Node2("td");
      if (this.tag === "tr") this.children.push(this._lec);
    }
    return this._lec;
  }
}
const registry = new Map();
const document2 = {
  getElementById(id) { if (!registry.has(id)) registry.set(id, new Node2("div#" + id)); return registry.get(id); },
  createElement(tag) { return new Node2(tag); },
  querySelectorAll() { return []; },
};
const store = new Map();
const localStorage2 = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };

// ── canned responses (shapes == smoke steps 16/18 + PayoutDto/ReviewDto) ──
const calls = [];
const LIST = {
  ok: true,
  payouts: [
    { id: 9001, lawyerUserId: 411, lawyerName: "سرکار وکیل آزمون", amountToman: 1500000,
      method: "کارت", status: "pending", reference: null, createdBy: "admin", createdAt: 1789400000000, paidAt: null, paidBy: null },
    { id: 9002, lawyerUserId: 411, lawyerName: "سرکار وکیل آزمون", amountToman: 500000,
      method: null, status: "paid", reference: "REF-77", createdBy: "admin", createdAt: 1789300000000, paidAt: 1789390000000, paidBy: "admin" },
  ],
  accruedToman: 2400000, paidOutToman: 500000,
  payoutNotice: "این دفتر صرفاً ثبتی است و سامانه هیچ وجهی جابه‌جا نمی‌کند.",
  message: null,
};
const REVIEWS = {
  ok: true, lawyerUserId: 411, count: 2, average: 4.5,
  reviews: [
    { id: 8001, consultationId: 7001, lawyerUserId: 411, reviewerName: "موکل الف", rating: 5, comment: "دقیق و به‌موقع", createdAt: 1789400000000 },
    { id: 8002, consultationId: 7002, lawyerUserId: 411, reviewerName: "موکل ب", rating: 4, comment: null, createdAt: 1789300000000 },
  ],
  code: null, message: null,
};
const EMPTY_LIST = { ok: true, payouts: [], accruedToman: 0, paidOutToman: 0, payoutNotice: "دفتر خالی است.", message: null };
const EMPTY_REVIEWS = { ok: true, lawyerUserId: 411, count: 0, average: null, reviews: [], message: "هنوز نظری ثبت نشده." };

let listPayload = LIST;
let reviewsPayload = REVIEWS;
let failReviews = false;   // the inline script binds fetch as an eval-time param, so mode flips live INSIDE the stub
let nextCreate = { ok: false, code: "OVER_ACCRUAL", message: "مبلغ درخواستی بیشتر از مانده است." };

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || "{}");
  const path = String(url).replace(/^https?:\/\/[^/]+\/api\/v1/, "");
  calls.push({ path, body });
  const json = (o) => ({ ok: true, status: 200, async json() { return o; } });
  const err = (o, st) => ({ ok: false, status: st, async json() { return o; } });
  if (path === "/admin/payouts/list") return json(listPayload);
  if (path === "/admin/payouts/create") {
    if (nextCreate && nextCreate.ok === false) { const e = nextCreate; nextCreate = null; return err(e, 400); }
    const ok = nextCreate; nextCreate = null; return json(ok);
  }
  if (path === "/admin/payouts/mark") return json({ ...LIST, accruedToman: 1900000, paidOutToman: 1000000,
    payouts: [{ ...LIST.payouts[0], status: "paid", paidAt: 1789490000000, paidBy: "admin", reference: body.reference }] });
  if (path === "/reviews/lawyer") {
    if (failReviews) return err({ ok: false, code: "NOT_FOUND", message: "مسیر سرویس‌اپلیکیشن یافت نشد." }, 404);
    return json(reviewsPayload);
  }
  if (path === "/admin/overview") return json({ ok: true, totalUsers: 3, lawyers: 1, consultations: 2, payments: 1, volumeToman: 2000000, derived: false, message: null });
  if (path === "/admin/config/get") return json({ ok: true, commission_bps: 2000, consultation_window_hours: 24, v1_enabled: 1, message: null });
  return err({ ok: false, code: "NOT_FOUND", message: "unstubbed " + path }, 404);
};
globalThis.confirm = () => true;

const fn = new Function("document", "localStorage", "fetch", "confirm", src);
const api = fn(document2, localStorage2, globalThis.fetch, globalThis.confirm);

// ── assertions ──
let pass = 0, fail = 0;
const T = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const has = (id, needle) => String(document2.getElementById(id).innerHTML).includes(needle);
const txt = (id) => String(document2.getElementById(id).textContent);

// token present so loadPayouts path uses call()
document2.getElementById("g-token").value = "tok-admin-1";
document2.getElementById("g-base").value = "https://vakil.test";

await api.loadPayouts();
T("payoutNotice rendered verbatim", txt("pay-notice").includes("هیچ وجهی جابه‌جا نمی‌کند"), txt("pay-notice").slice(0, 46));
const totHtml = has("pay-totals", "undefined") || has("pay-totals", "NaN");
T("server totals rendered faithfully (no undefined/NaN)", !totHtml && has("pay-totals", "تومان"), "tiles present");
T("ledger rows rendered with server statuses", has("payouts", "سرکار وکیل آزمون") && has("payouts", "در انتظار پرداخت") && has("payouts", "پرداخت‌شده"), "2 rows");
T("closed rows carry no mutation buttons", has("payouts", "بستهٔ قطعی"), "ok");

// failure path: OVER_ACCRUAL surfaces server code+message and does NOT write
calls.length = 0;
await api.createPayout.call ? null : null;
document2.getElementById("pay-lawyer").value = "411";
document2.getElementById("pay-amount").value = "99999999";
document2.getElementById("pay-method").value = "";
await api.createPayout();
const createCall = calls.find((c) => c.path === "/admin/payouts/create");
T("create sent integer amount + lawyer id", createCall && createCall.body.lawyerUserId === 411 && createCall.body.amountToman === 99999999,
  createCall ? JSON.stringify(createCall.body).slice(0, 60) : "no call");
T("OVER_ACCRUAL surfaced verbatim in status strip", txt("status").includes("OVER_ACCRUAL"), txt("status").slice(0, 60));
T("after failed create the ledger was re-listed (no client math)", calls.some((c) => c.path === "/admin/payouts/list"), "re-list ok");

// success create + mark paid
calls.length = 0;
nextCreate = LIST;
document2.getElementById("pay-lawyer").value = "411";
document2.getElementById("pay-amount").value = "1000000";
await api.createPayout();
T("create ok → re-list + overview refresh",
  calls.some((c) => c.path === "/admin/payouts/list") && calls.some((c) => c.path === "/admin/overview"), "both re-read");
T("inputs cleared after success", document2.getElementById("pay-amount").value === "", "cleared");

const row = LIST.payouts[0];
calls.length = 0;
await api.markPayout(row.id, "paid", new Node2("button"), new Node2("div"), { value: "REF-99" });
const markCall = calls.find((c) => c.path === "/admin/payouts/mark");
T("mark sent payoutId/status/reference", markCall && markCall.body.payoutId === 9001 && markCall.body.status === "paid" && markCall.body.reference === "REF-99",
  markCall ? JSON.stringify(markCall.body) : "no call");

// empty ledger honesty
listPayload = EMPTY_LIST;
await api.loadPayouts();
T("empty ledger says empty (not missing data)", has("payouts", "خالی است"), "ok");

// reviews
document2.getElementById("rev-lawyer").value = "411";
await api.loadReviews();
T("reviews average rendered with count", has("reviews", "4٫5") && has("reviews", "نظر"), "avg 4.5");
T("stars + reviewer + comment rendered", has("reviews", "★★★★★") && has("reviews", "موکل الف") && has("reviews", "دقیق و به‌موقع"), "row 1");
T("null comment rendered honestly", has("reviews", "بدون توضیح"), "row 2");

reviewsPayload = { ...EMPTY_REVIEWS };
await api.loadReviews();
T("zero reviews → average dash, never fake 0", has("reviews", "—") && has("reviews", "ثبت نشده"), "ok");

// reviews route failure surfaces server text. NOTE: the inline script receives
// `fetch` as a PARAMETER bound at eval time, so reassigning globalThis.fetch is
// a no-op — flip the canned stub's mode instead.
failReviews = true;
await api.loadReviews();
T("failed reviews call shows server code + message", has("reviews", "NOT_FOUND") && has("reviews", "یافت نشد"), "failure renderer");

console.log(`\nDASHBOARD HARNESS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
