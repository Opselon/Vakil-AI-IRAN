-- Vakil AI — cross-platform app schema (D1 / SQLite)
-- Run:  npx wrangler d1 execute <DB_NAME> --remote --file=./schema.sql
-- Idempotent: safe to re-run. The bot tables (users, chat_history) must already
-- exist from the Telegram worker; this adds device/token management only.

CREATE TABLE IF NOT EXISTS app_devices (
  device_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT,
  platform   TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_app_tokens_user   ON app_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_app_tokens_exp    ON app_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_app_devices_user  ON app_devices(user_id);
