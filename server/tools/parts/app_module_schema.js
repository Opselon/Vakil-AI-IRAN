// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Marketplace DDL layer: creates every V1 table idempotently at
//             first use inside the app worker (same pattern as
//             appApiEnsureTables), then seeds reference data (lawyer
//             categories + platform_config). No business logic lives here.
// OWNER     — Agent 3 (Database / Schema).
// CONSUMES  — env.DB (D1 `ailawyer`, SHARED with the live Telegram bot —
//             therefore this file is ADDITIVE ONLY: CREATE ... IF NOT EXISTS
//             everywhere, never ALTER/DROP/DELETE on bot-owned tables),
//             marketplaceRegisterSchema (app_module_common.js).
// PROVIDES  — marketplaceEnsureTablesImpl(env) [registered as the schema
//             impl; gate: marketplaceEnsureTables], marketplaceSeedDefaults(env).
//             Tables: app_accounts, lawyer_profiles, lawyer_categories,
//             consultations, consultation_messages, payments, payment_splits,
//             platform_config, reviews, admin_audit_log.
// INVARIANTS— 1) Every statement is CREATE TABLE/INDEX IF NOT EXISTS — a
//                re-run is a no-op; this file can NEVER damage bot tables.
//             2) Table-creation errors propagate (fail fast); ONLY index
//                creation errors are tolerated (log + continue) because an
//                index is a performance detail, not a correctness one.
//             3) Seeds are CONFIGURATION only (categories, platform_config).
//                No lawyer_profiles, reviews, consultations or payments rows
//                are ever invented — empty states beat fake data (spec §0).
//             4) Mirror of server/schema.marketplace.sql: change one, change
//                both. The SQL file is the operator fallback; the worker
//                self-creates, so the file is optional at runtime.
// EXTEND    — Add a const holding the new CREATE statement (with its WHY
//             comment), push it onto MP_TABLES (or MP_INDEXES), and append the
//             same statement to schema.marketplace.sql. Never mutate an
//             existing table in place — add a new table or a tolerated index.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── tables (spec §3, verbatim column sets) ───────────────────────────

// Credential + profile record for app accounts — every /auth/* route
// (signup/login/google/me) and marketplaceAccount() reads it. Telegram users
// keep living in the bot's `users` table only; user_id shares that id space.
const MP_DDL_APP_ACCOUNTS = `CREATE TABLE IF NOT EXISTS app_accounts (
  user_id        INTEGER PRIMARY KEY,
  email          TEXT,
  email_norm     TEXT UNIQUE,
  username       TEXT UNIQUE,
  password_hash  TEXT,
  google_sub     TEXT UNIQUE,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','lawyer','admin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at     INTEGER,
  last_login_at  INTEGER
)`;

// One row per lawyer; existence = "applied as lawyer" (/lawyers/apply).
// /lawyers/list + /lawyers/get + /admin/lawyers/pending|decide read it, and
// consultation creation snapshots price/duration from it. verification_status
// is admin-writable ONLY — distinct from role (identity vs professional vetting).
const MP_DDL_LAWYER_PROFILES = `CREATE TABLE IF NOT EXISTS lawyer_profiles (
  user_id             INTEGER PRIMARY KEY,
  slug                TEXT UNIQUE,
  title               TEXT,
  bio                 TEXT,
  specialties         TEXT,
  languages           TEXT,
  city                TEXT,
  jurisdiction        TEXT,
  experience_years    INTEGER,
  price_toman         INTEGER,
  duration_minutes    INTEGER DEFAULT 45,
  availability_note   TEXT,
  is_available        INTEGER DEFAULT 1,
  verification_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (verification_status IN ('pending','verified','rejected','suspended')),
  verification_note   TEXT,
  verified_at         INTEGER,
  verified_by         INTEGER,
  photo_url           TEXT,
  created_at          INTEGER,
  updated_at          INTEGER
)`;

// Practice-area vocabulary for /lawyers/categories + the apply/edit form.
// Seeded below (reference data only).
const MP_DDL_LAWYER_CATEGORIES = `CREATE TABLE IF NOT EXISTS lawyer_categories (
  slug    TEXT PRIMARY KEY,
  name_fa TEXT,
  name_en TEXT,
  sort    INTEGER
)`;

// The consultation state machine (Agent 7): CREATED → PAYMENT_PENDING → PAID →
// ACTIVE → COMPLETED (+ CANCELLED/EXPIRED/REFUNDED/FAILED). price_toman and
// duration_minutes are snapshots taken at creation — never mutated retroactively.
// UNIQUE(client_user_id, idempotency_key) de-dupes retried /consultations/create
// calls (NULL keys stay unique-agnostic in SQLite, so ad-hoc creates never clash).
const MP_DDL_CONSULTATIONS = `CREATE TABLE IF NOT EXISTS consultations (
  id                INTEGER PRIMARY KEY,
  client_user_id    INTEGER NOT NULL,
  lawyer_user_id    INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'CREATED'
      CHECK (status IN ('CREATED','PAYMENT_PENDING','PAID','ACTIVE','COMPLETED','CANCELLED','EXPIRED','REFUNDED','FAILED')),
  created_at        INTEGER,
  updated_at        INTEGER,
  paid_at           INTEGER,
  started_at        INTEGER,
  ends_at           INTEGER,
  duration_minutes  INTEGER,
  price_toman       INTEGER,
  idempotency_key   TEXT,
  UNIQUE (client_user_id, idempotency_key)
)`;

// Consultation chat messages (separate from the AI-chat `chat_history` mirror);
// /consultations/send appends, /consultations/messages pulls after a
// server-side membership check.
const MP_DDL_CONSULTATION_MESSAGES = `CREATE TABLE IF NOT EXISTS consultation_messages (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER NOT NULL,
  sender_user_id  INTEGER NOT NULL,
  body            TEXT,
  created_at      INTEGER
)`;

// Payment attempts per consultation (Agent 8): one provider row per accept of
// /consultations/pay or /payments/create; idempotency_key UNIQUE blocks a
// double charge on a retried request. provider='devtest' is the V1 dev/test
// provider — explicitly labelled, never a fake production success.
const MP_DDL_PAYMENTS = `CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  amount_toman    INTEGER NOT NULL,
  currency        TEXT DEFAULT 'IRT',
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','succeeded','failed','refunded')),
  provider_ref    TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      INTEGER,
  settled_at      INTEGER
)`;

// Derived ledger: exactly one row per SUCCEEDED payment (payment_id is the PK,
// so it doubles as the idempotency guard for split bookkeeping) —
// /payments/history and /admin/overview sum commission + lawyer earnings from it.
const MP_DDL_PAYMENT_SPLITS = `CREATE TABLE IF NOT EXISTS payment_splits (
  payment_id            INTEGER PRIMARY KEY,
  consultation_id       INTEGER,
  lawyer_user_id        INTEGER,
  gross_toman           INTEGER,
  commission_toman      INTEGER,
  lawyer_earnings_toman INTEGER,
  commission_bps        INTEGER
)`;

// Runtime configuration read via marketplaceConfigGet/Set — commission_bps and
// the v1 kill-switch live here as DATA, never as hardcoded handler literals.
const MP_DDL_PLATFORM_CONFIG = `CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER,
  updated_by INTEGER
)`;

// Post-consultation review slot (extension point for V1: table exists, routes
// may return empty states). consultation_id UNIQUE = one review per
// consultation; rating 1..5 is the only CHECKed numeric range. NO seeded rows.
const MP_DDL_REVIEWS = `CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER UNIQUE,
  client_user_id  INTEGER,
  lawyer_user_id  INTEGER,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      INTEGER
)`;

// Append-only trail of every admin mutation (verify/reject/suspend/config set)
// — /admin/audit/list reads it; nothing updates or deletes it.
const MP_DDL_ADMIN_AUDIT_LOG = `CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER,
  action        TEXT,
  target_type   TEXT,
  target_id     TEXT,
  note          TEXT,
  created_at    INTEGER
)`;

// ─────────────────────────── indexes ( tolerated failures ) ───────────────────────────
// Lookup shapes the routes actually run; the UNIQUE column constraints above
// already give SQLite auto-indexes for email/username/google_sub/slug — the
// named idx_ac_* ones keep query plans stable/explicit for D1.

const MP_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_ac_email_norm ON app_accounts(email_norm)",     // /auth/login by email
  "CREATE INDEX IF NOT EXISTS idx_ac_google_sub ON app_accounts(google_sub)",     // /auth/google subject lookup
  "CREATE INDEX IF NOT EXISTS idx_lp_status     ON lawyer_profiles(verification_status)", // /lawyers/list verified-only filter
  "CREATE INDEX IF NOT EXISTS idx_lp_price      ON lawyer_profiles(price_toman)", // /lawyers/list price_asc/desc + maxPrice
  "CREATE INDEX IF NOT EXISTS idx_cons_client   ON consultations(client_user_id)",   // /consultations/list scope=client
  "CREATE INDEX IF NOT EXISTS idx_cons_lawyer   ON consultations(lawyer_user_id)",   // /consultations/list scope=lawyer
  "CREATE INDEX IF NOT EXISTS idx_cons_status   ON consultations(status)",           // expiry sweep + admin filtering
  "CREATE INDEX IF NOT EXISTS idx_cm_cons       ON consultation_messages(consultation_id, id)", // pull-since cursor
  // One LIVE (pending|succeeded) payment per consultation, enforced by the DB
  // itself (audit H1): concurrent creates adopt the winner's row via the
  // UNIQUE-violation path in paymentCreatePending instead of double-inserting.
  // 'failed' rows are excluded on purpose so a retried payment is possible.
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_live ON payments(consultation_id) WHERE status IN ('pending','succeeded')",
  "CREATE INDEX IF NOT EXISTS idx_pay_cons      ON payments(consultation_id)",       // /consultations/get payment quote join
  "CREATE INDEX IF NOT EXISTS idx_pay_user      ON payments(user_id)"                // /payments/history per payer
];

// ─────────────────────────── reference seed data ───────────────────────────
// Configuration ONLY (spec §3): practice areas + platform config defaults.
// NEVER seed lawyer_profiles, reviews, consultations or payments — that would
// be fabricated marketplace content.

// slug / name_fa / name_en / sort — Persian legal practice areas.
const MP_SEED_CATEGORIES = [
  ["khanevadeh",            "خانواده",                       "Family",                          10],
  ["keyfari",              "کیفری",                          "Criminal",                        20],
  ["sabti-melki",          "ثبتی و ملکی",                   "Registration & Property",         30],
  ["qardadha",             "قراردادها",                      "Contracts",                       40],
  ["amoor-shekha-ha",      "امور شرکت‌ها",                   "Corporate",                       50],
  ["kar-tamin-ejtemaei",   "کار و تامین اجتماعی",           "Labor & Social Security",         60],
  ["maliyati",             "مالیاتی",                        "Tax",                             70],
  ["takhlie-mojer-mostajir","تخلیه و موجر و مستاجر",        "Eviction & Landlord/Tenant",      80],
  ["davari-hal-etelaf",    "داوری و حل اختلاف",             "Arbitration & Dispute Resolution", 90],
  ["vekalat-dadgostari",   "وکالت دادگستری",                "Court Advocacy",                 100]
];

// Commission 20.00% (2000 bps) + V1 kill-switch + the consultation window
// the payment quote expires after (hours). INSERT OR IGNORE: an admin edit of
// any of these values is never overwritten by a redeploy.
const MP_SEED_CONFIG = [
  ["commission_bps",            "2000"],
  ["v1_enabled",                "1"],
  ["consultation_window_hours", "24"],
  ["payment_provider",          "devtest"]
];

// DDL revision stamp — bump on every marketplace schema change; the seed
// throttle above compares against it, operators can SELECT it directly.
const MP_SCHEMA_VERSION = "1";

/**
 * Seeds reference rows with INSERT OR IGNORE so the function is re-runnable and
 * admin edits of config values survive a restart. Called once per isolate by
 * marketplaceEnsureTablesImpl AFTER the tables exist.
 */
/**
 * Seeds run ONLY when missing (audit db: previously every isolate re-issued all
 * config/category INSERT OR IGNOREs on cold start). Single probe first; the
 * schema_version stamp lets operators read the DDL revision it was seeded by.
 */
async function marketplaceSeedDefaults(env) {
  try {
    const stamped = await env.DB.prepare("SELECT value FROM platform_config WHERE key = 'schema_version'").first();
    if (stamped && String(stamped.value) === MP_SCHEMA_VERSION) {
      const catCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM lawyer_categories").first();
      if (catCount && Number(catCount.n) >= MP_SEED_CATEGORIES.length) return; // fully seeded
    }
  } catch (_) { /* probe failed — fall through and (re)seed idempotently */ }
  for (const [slug, nameFa, nameEn, sort] of MP_SEED_CATEGORIES) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO lawyer_categories (slug, name_fa, name_en, sort) VALUES (?, ?, ?, ?)"
    ).bind(slug, nameFa, nameEn, sort).run();
  }
  for (const [key, value] of MP_SEED_CONFIG) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO platform_config (key, value, updated_at) VALUES (?, ?, ?)"
    ).bind(key, value, Date.now()).run();
  }
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO platform_config (key, value, updated_at) VALUES ('schema_version', ?, ?)").bind(MP_SCHEMA_VERSION, marketplaceNow()).run();
    } catch (e) { console.warn("schema_version stamp failed:", e && e.message); }
}

/**
 * The schema impl registered with common.js: runs every CREATE TABLE in order
 * (errors propagate — a missing table is a hard failure), then the CREATE
 * INDEXes individually inside try/catch (a failed index only costs query
 * speed), then seeds reference data once.
 * Params: env (needs env.DB). Error codes: propagates D1 errors as thrown.
 */
async function marketplaceEnsureTablesImpl(env) {
  const tables = [
    MP_DDL_APP_ACCOUNTS,
    MP_DDL_LAWYER_PROFILES,
    MP_DDL_LAWYER_CATEGORIES,
    MP_DDL_CONSULTATIONS,
    MP_DDL_CONSULTATION_MESSAGES,
    MP_DDL_PAYMENTS,
    MP_DDL_PAYMENT_SPLITS,
    MP_DDL_PLATFORM_CONFIG,
    MP_DDL_REVIEWS,
    MP_DDL_ADMIN_AUDIT_LOG
  ];
  for (const sql of tables) {
    await env.DB.prepare(sql).run();
  }
  for (const sql of MP_INDEXES) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      console.warn("marketplace index skipped:", sql, e && e.message);
    }
  }
  await marketplaceSeedDefaults(env);
}

// The ONLY top-level side effect in this file (spec §5): hand the impl to the
// per-isolate gate in app_module_common.js.
marketplaceRegisterSchema(marketplaceEnsureTablesImpl);
