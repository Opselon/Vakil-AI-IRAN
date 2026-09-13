# Vakil AI — Server Database (D1) & Failover Design

_Last verified: 2026-09-14 against the live deployment._

Two Cloudflare resources back this app:

| Resource | Binding | Id | Role |
|---|---|---|---|
| D1 **`ailawyer`** | `env.DB` | `d2d3f21d-67c4-41f5-b21c-430102a913ae` | Users, quota, chat mirror, **AI key cluster**, app devices/tokens |
| KV **`GeminiKV`** | `env.KV` | `9ddff85e3d8b4d4ea3e320c786baab0c` | Sticky sessions, key leases, cooldowns, EWMA health metrics |
| Worker **`purple-bread-2b60`** | `env.GEMINI_PROXY` (service binding) | — | AI gateway (Google/OpenRouter egress). Never called over public *.workers.dev from a Worker — Cloudflare refuses intra-Edge HTTP to workers.dev (error **1042**); the service binding is the correct path. |

Workers:

| Worker | URL | Purpose |
|---|---|---|
| `vakil-app` | `https://vakil-app.samerkhaldounmarefi.workers.dev` | **App serverless API only** (`/api/v1/*`). Built by `tools/build_app_worker.cjs`. |
| `ailawyer-bot` (Telegram) | unchanged | The original bot — untouched by this repo, shares D1+KV. |

## Key principles

* **Keys are never logged.** No log, history row or API response ever contains a
  key value. Only masked tails (`...mMBQ`) appear in diagnostics — identical to the
  bot's `maskKey`/`logInfo` behavior, and the app worker has no admin-log surface at
  all (`logToAdmin` is a console sink).
* **No chat content is logged.** `chat_history` stores message content in D1
  (encrypted at rest by Cloudflare) for the cross-device mirror only.
* **Single source of truth for prompts/buttons/pages:** extracted verbatim from the
  production bot worker by `tools/extract_prompts.cjs` at build time — the app can
  never drift from the bot's wording.

## Tables (gemini_api_keys cluster — shared with the bot)

```sql
gemini_api_keys (          -- the 500-key-ready failover cluster
  key_value        TEXT PRIMARY KEY,   -- actual key (never returned by any API)
  status           TEXT CHECK IN ('active','cooldown','disabled'),
  usage_count, error_count, last_used, cooldown_until,
  created_at, updated_at,
  health_score     INTEGER DEFAULT 80,   -- 0..100 EWMA blend
  consecutive_429, consecutive_failures,  -- trip counters
  last_429_at, last_error_at,
  ewma_latency_ms,                        -- routing cost signal
  lease_until,     lease_id               -- concurrency lock per session
)
-- indexes (already applied):
--   idx_keys_status_health  ON gemini_api_keys(status, health_score DESC, last_used ASC)
--   idx_keys_cooldown       ON gemini_api_keys(cooldown_until)
```

App tables (created idempotently by `appApiEnsureTables`, also in `schema.sql`):

```sql
app_devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, platform TEXT, created_at INTEGER)
app_tokens  (token_hash TEXT PRIMARY KEY, device_id TEXT, user_id TEXT, created_at INTEGER, expires_at INTEGER)
-- indexes: idx_app_tokens_user, idx_app_tokens_exp, idx_app_devices_user
```

Shared with the bot: `users` (quota counters, `mode`, `draft_data`), `chat_history`
(the mirror the app pulls on new devices).

## Failover algorithm (proven engine, sliced verbatim from the bot)

Order of operations on every AI call (`executeWithLeastLoad`):

1. **Sticky session** — `KV: sticky:<user>` pins a user to the key that served them
   last (context affinity + cache warmth). Ignored when that key is cooling down.
2. **Candidate pool (D1)** — `selectFromD1`: up to `KEY_POOL_SIZE=12` keys ordered by
   `health_score DESC, last_used ASC` → least-recently-used among the healthiest,
   so 500 keys spread evenly and hot keys recover.
3. **KV ranking pass** — `filterAndRankCandidatesViaKV` drops keys that are
   *leased* (`lease_until > now`), *cooling* (`cooldown_until > now`) or *disabled*,
   then sorts by EWMA latency. Only `EXECUTION_CANDIDATE_LIMIT=3` ready keys proceed.
4. **Lease** — `acquireKeyLease` stamps `lease_until/lease_id` (D1 compare-and-set +
   KV guard) so two concurrent requests never burn the same key (`MIN_KEY_ATTEMPT_MS=2500`
   floor per attempt).
5. **Execution** — `executeApiCall` → gateway (`/v1beta` root POST `{key,model,payload,dedup_hash}`,
   anti-replay lock via `dedup_hash`; `REQUEST_ALREADY_PROCESSING` = silent drop, no
   double count). Local retry rotates models (`getGatewayModels`: primary →
   `gemini-flash-latest` → `gemini-3.5-flash` → `gemini-pro-latest`); 503 rotates to
   a stable alias on the same key.
6. **Health feedback** — `handleSuccess`/`handleFailure` (KV, 60s buckets + D1 rows):
   * `+HEALTH_RECOVERY(5)` on success (cap 100), `-15` error, `-10` timeout, `-30` per 429, `-50` per 403.
   * `calc429CooldownExponential`: cooldown = `compute429CooldownMs` doubling per
     consecutive 429, bounded by `QUARANTINE_429` (24h); 403 → `QUARANTINE_403` (48h);
     400 → `KV_400_COOLDOWN_SEC` (5 min); hard-exhaustion markers → full cooldown.
   * `consecutive_failures > CONSECUTIVE_FAILURE_LIMIT(5)` ⇒ key disabled from
     rotation until an operator re-enables it.
   * EWMA latency `α=0.3` feeds step 3's ranking.
7. **Global overload patient mode** — ≥`GLOBAL_OVERLOAD_THRESHOLD(3)` 503/timeouts
   in-pool ⇒ jittered patient retries inside the 25s budget
   (`resolveGeminiRuntimeBudget`, first key gets 68% of it), then **turbo downgrade**
   to the small legal prompt on the last key.
8. **Fallback env key** — `selectFromEnv` only when D1/KV are down entirely.

Budgets: `TOTAL_TIMEOUT 25s`, `PER_KEY_TIMEOUT 10s`, `LEASE_DURATION 15s`,
`MAX_FAILOVER_KEYS 2`.

### Operator commands

```bash
# cluster health
npx wrangler d1 execute ailawyer --remote --command \
  "SELECT status, COUNT(*) FROM gemini_api_keys GROUP BY status"
# un-ban a key
npx wrangler d1 execute ailawyer --remote --command \
  "UPDATE gemini_api_keys SET status='active', consecutive_failures=0, cooldown_until=0 WHERE key_value LIKE '...XXXX'"
# add keys (bulk): INSERT OR IGNORE INTO gemini_api_keys (key_value) VALUES ('AIza…'), ...
```

## App API surface (single worker, serverless)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/auth/verify` | channel code | constant-time compare; provisions synthetic `9xxxxxxxxx` user ids in shared `users` row; returns bearer token (HMAC, `APP_TOKEN_SECRET`, 30-day) |
| `POST /api/v1/chat` | token | text/audio/image → exact bot validation & limit pages; drafting state machine (`users.mode/draft_data`); quota via `checkUserLimit` (Iran-midnight reset) |
| `POST /api/v1/quick-action` | token | static pages zero-cost; `deep_analysis` & dynamic buttons via DeepSeek-first dual engine (Gemini fallback) |
| `POST /api/v1/history` | token | server mirror rows (`chat_history`) — local SQLite stays the client source of truth |
| `GET /api/v1/health` | — | liveness |

Cron (`17 */6 * * *`): purges expired `app_tokens` rows only.

## Deploy & test (wrangler automation)

```bash
cd server
npm run build          # rebuild dist/vakil-app-worker.js from the pristine bot worker
npm run check          # integrity: every required symbol defined exactly once
npm run smoke          # 14 offline integration tests (real handler chain, stubbed D1/gateway)
npm run deploy         # wrangler deploy -c wrangler.app.toml
npm run test:live      # 11 live tests against the deployed worker (real keys, real answers)
npm run probe:gateway  # audit all cluster keys vs the gateway (model matrix)
```

Secrets (one-time, per environment):

```bash
npm run secret:token   # APP_TOKEN_SECRET  (random 64+ chars, base64url)
npm run secret:code    # APP_CHANNEL_CODE  (activation code shown in the app login)
```

CI/CD: `.github/workflows/ci.yml` checks the committed artifact (syntax + integrity +
offline smoke, drift-checked rebuild); `.github/workflows/deploy-worker.yml` is a
manual `workflow_dispatch` gate that publishes **only the exact artifact CI
validated** via `wrangler deploy` (repo secrets `CLOUDFLARE_API_TOKEN` — Workers
Edit+KV+D1 scopes — and `CLOUDFLARE_ACCOUNT_ID`). Release artifacts (APK/EXE per
CPU) come from `.github/workflows/release.yml`.
