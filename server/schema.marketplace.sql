-- ═══════════════════════════════════════════════════════════════════════════
-- Vakil AI — marketplace (V1) schema  ·  D1 / SQLite  ·  Agent 3
-- Run:  npx wrangler d1 execute ailawyer --remote --file=./schema.marketplace.sql
--
-- WHEN THIS IS NEEDED: the app worker self-creates every table below at first
-- use (app_module_schema.js → marketplaceEnsureTables), so this file is
-- OPTIONAL at runtime. Run it once BEFORE the first V1 deploy so the tables
-- exist ahead of traffic (cleaner cold start, and DB/console/ wrangler queries
-- work before any handler has run). Safe to re-run any time.
--
-- SAFETY: the `ailawyer` D1 database is SHARED with the live Telegram bot
-- (users, chat_history, gemini_api_keys). This file is ADDITIVE ONLY — every
-- statement is CREATE ... IF NOT EXISTS; no ALTER, no DROP, no DELETE, no
-- INSERT of marketplace content. Reference seeds are INSERT OR IGNORE and are
-- configuration (categories + platform_config), never lawyers/reviews.
-- Mirror of the worker DDL: change one side, change the other.
-- ═══════════════════════════════════════════════════════════════════════════

-- Credential + profile record for app accounts (auth routes, marketplaceAccount).
CREATE TABLE IF NOT EXISTS app_accounts (
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
);

-- One row per lawyer; verification_status is admin-writable only.
CREATE TABLE IF NOT EXISTS lawyer_profiles (
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
);

-- Practice-area vocabulary (seeded below).
CREATE TABLE IF NOT EXISTS lawyer_categories (
  slug    TEXT PRIMARY KEY,
  name_fa TEXT,
  name_en TEXT,
  sort    INTEGER
);

-- Consultation state machine; price/duration are creation-time snapshots.
CREATE TABLE IF NOT EXISTS consultations (
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
);

-- Consultation chat (separate from the AI-chat chat_history mirror).
CREATE TABLE IF NOT EXISTS consultation_messages (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER NOT NULL,
  sender_user_id  INTEGER NOT NULL,
  body            TEXT,
  created_at      INTEGER
);

-- Payment attempts; UNIQUE idempotency_key prevents double-charge on retry.
CREATE TABLE IF NOT EXISTS payments (
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
);

-- Derived ledger: exactly one row per SUCCEEDED payment (PK = idempotency).
CREATE TABLE IF NOT EXISTS payment_splits (
  payment_id            INTEGER PRIMARY KEY,
  consultation_id       INTEGER,
  lawyer_user_id        INTEGER,
  gross_toman           INTEGER,
  commission_toman      INTEGER,
  lawyer_earnings_toman INTEGER,
  commission_bps        INTEGER
);

-- Runtime configuration (commission rate, V1 kill-switch) as data.
CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER,
  updated_by INTEGER
);

-- Review extension point; one review per consultation. NO seeded rows.
CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER UNIQUE,
  client_user_id  INTEGER,
  lawyer_user_id  INTEGER,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      INTEGER
);

-- Append-only trail of admin mutations.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER,
  action        TEXT,
  target_type   TEXT,
  target_id     TEXT,
  note          TEXT,
  created_at    INTEGER
);

-- ─────────────────────────── indexes ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_lp_status     ON lawyer_profiles(verification_status);
CREATE INDEX IF NOT EXISTS idx_lp_price      ON lawyer_profiles(price_toman);
CREATE INDEX IF NOT EXISTS idx_cons_client   ON consultations(client_user_id);
CREATE INDEX IF NOT EXISTS idx_cons_lawyer   ON consultations(lawyer_user_id);
CREATE INDEX IF NOT EXISTS idx_cons_status   ON consultations(status);
CREATE INDEX IF NOT EXISTS idx_cm_cons       ON consultation_messages(consultation_id, id);
-- Audit H1: exactly one live (pending|succeeded) payment per consultation —
-- concurrent create attempts collide here and the handler adopts the winner.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_live ON payments(consultation_id) WHERE status IN ('pending','succeeded');
CREATE INDEX IF NOT EXISTS idx_pay_cons      ON payments(consultation_id);
CREATE INDEX IF NOT EXISTS idx_pay_user      ON payments(user_id);

-- ─────────────────────────── reference seeds ───────────────────────────
-- Configuration ONLY (mirrors marketplaceSeedDefaults in app_module_schema.js):
-- practice areas + platform_config defaults. INSERT OR IGNORE keeps this
-- re-runnable and never overwrites an admin's edited value.
INSERT OR IGNORE INTO lawyer_categories (slug, name_fa, name_en, sort) VALUES
  ('khanevadeh',             'خانواده',                'Family',                           10),
  ('keyfari',                'کیفری',                  'Criminal',                         20),
  ('sabti-melki',            'ثبتی و ملکی',            'Registration & Property',          30),
  ('qardadha',               'قراردادها',              'Contracts',                        40),
  ('amoor-shekha-ha',        'امور شرکت‌ها',              'Corporate',                        50),
  ('kar-tamin-ejtemaei',     'کار و تامین اجتماعی',    'Labor & Social Security',          60),
  ('maliyati',               'مالیاتی',                'Tax',                              70),
  ('takhlie-mojer-mostajir', 'تخلیه و موجر و مستاجر',  'Eviction & Landlord/Tenant',       80),
  ('davari-hal-etelaf',      'داوری و حل اختلاف',      'Arbitration & Dispute Resolution', 90),
  ('vekalat-dadgostari',     'وکالت دادگستری',          'Court Advocacy',                  100);

INSERT OR IGNORE INTO platform_config (key, value, updated_at) VALUES
  ('commission_bps',            '2000', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('v1_enabled',                '1',    CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('consultation_window_hours', '24',   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('payment_provider',          'devtest', CAST(strftime('%s','now') AS INTEGER) * 1000),
  -- DDL revision stamp (the worker re-stamps this on cold start; see MP_SCHEMA_VERSION
  -- in app_module_schema.js — bump BOTH when the schema changes):
  ('schema_version',            '1',       CAST(strftime('%s','now') AS INTEGER) * 1000);
