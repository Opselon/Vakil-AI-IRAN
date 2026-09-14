# Vakil AI — Server Database (D1) & Failover Design

_Last verified: 2026-09-14 against the live deployment. The "Marketplace (V1)
tables" section was added the same day and is verified against the embedded
SQLite engine (offline: `server/schema.marketplace.sql` + the worker's runtime
DDL), **not** yet applied to the live D1 database._

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

Marketplace surface (V1 — registered via `app_module_common.js`, gated by `platform_config.v1_enabled`):

| Route group | Auth | Notes |
|---|---|---|
| `POST /auth/signup · /auth/login · /auth/me · /auth/logout · /auth/password/set` | token (except signup/login) | PBKDF2-SHA256/100k + optional `AUTH_PEPPER`; login answers identical 401 for unknown-id/wrong-password at identical cost (dummy derive); `/auth/logout` deletes the CALLER's `app_tokens` row only; password rotation revokes every OTHER session of the account |
| `POST /auth/google · /auth/oauth/exchange` | — | ID-token verify via tokeninfo (JWKS = V2 swap point); unset `GOOGLE_CLIENT_ID` → `CONFIG_PENDING`; merge onto an existing email account CLEARS that row's password + revokes its sessions (verified owner wins); oauth/exchange = shaped `NOT_CONFIGURED` (GitHub extension point) |
| `POST /lawyers/list · /get · /categories` | optional token | verified+active lawyers ONLY, honest empty states, `limit≤40`+`hasMore` |
| `POST /lawyers/me · /apply · /save` | token | apply = self role-upgrade (pending, idempotent); save = field-whitelist; any edit resets verified→pending unless server `KEEP_VERIFIED_ON_EDIT=1` |
| `POST /consultations/create · /list · /get · /messages · /send · /complete` | token | lifecycle CAS in `consultationTransition`; membership from token row only; NON-MEMBERS GET 404 (not 403 — ids are time-ordered; existence oracle closed); messages readable PAID/ACTIVE/COMPLETED, writable PAID/ACTIVE; first send anchors `ends_at = first_message + duration`; PAID-unstarted redeems within `consultation_window_hours` then lazily COMPLETED; per-user rate limits on list(30/min)/messages(120/min)/send(60/min)/create(20/min) |
| `POST /consultations/pay` | token (client of the row) | idempotent; settlement CAS (`WHERE status='pending'`), one live payment per consultation ENFORCED by `uq_pay_live`; ledger heal on replay (missing split re-derived once, logged); commission rate stored per payment |
| `POST /payments/history · /payments/providers` | token / public read | role-scoped totals; providers flags `isTestMode` honestly |
| `POST /consultations/cancel` | token (client of the row) | CREATED/PAYMENT_PENDING → CANCELLED via the same lifecycle CAS; replay is idempotent-OK (200 + `CONSULTATION_ALREADY_CANCELLED` + current row); paid rows answer 409 pointing at `/refund`; non-member 404; 10/min |
| `POST /consultations/refund` | token (client of the row) | **devtest-only**: BOTH the configured provider and the payment ROW's provider must be `devtest`, else 502 `PROVIDER_NOT_REFUNDABLE`. PAID-only (ACTIVE → 409 «جلسه آغاز شده»). CAS `UPDATE payments SET status='refunded', refunded_at=? WHERE status='succeeded'` — concurrent loser converges idempotently; `payment_splits` rows are PRESERVED (immutable ledger); consultation → REFUNDED; 5/min |
| `POST /reviews/submit` | token (booking client) | COMPLETED-only (409 `CONSULTATION_NOT_COMPLETED`), integer rating 1..5, comment trimmed ≤1000, one per consultation (pre-check + UNIQUE catch → 409 `ALREADY_REVIEWED`); non-participant 404, lawyer self 403; 10/min; returns fresh count+average |
| `POST /reviews/lawyer` | public | newest-first ≤50 + `count`/`average` over the lawyer's COMPLETED book only; `average=null` at zero reviews (never a fake 0); reviewer name resolved from `app_accounts` |
| `POST /reviews/mine` | token (booking client) | `{ok,reviews,count}` for one or all of the caller's consultations; non-participant 404 |
| `POST /admin/payouts/list · /create · /mark` | admin token | V1 ledger = **record-keeping, not money movement** (`payoutNotice` says so). Outstanding = per-lawyer `MAX(0, Σsucceeded-splits − Σpaid-payouts)` clamped lawyer-wise; create refuses `OVER_ACCRUAL` (400, both figures in the message); mark is one-way CAS `pending→paid|cancelled` (loser 409 `PAYOUT_STATE_CONFLICT`); paid rows move totals, pending rows never do; both mutations audited (`payout_create`/`payout_paid`/`payout_cancelled`); 20/min |
| `POST /admin/overview · /users/list · /lawyers/pending · /lawyers/decide · /config/get · /config/set · /consultations/list · /audit/list` | admin token | decide = the ONLY `verified` writer (self-decision refused; suspend/reject ALSO revoke the target's sessions); config whitelist incl. `payment_provider` (registered ids only); every mutation audited |

`platform_config` seeds: `commission_bps='2000'` (20%), `v1_enabled='1'`,
`consultation_window_hours='24'`, `payment_provider='devtest'`, `schema_version='2'`
(the last is the DDL revision stamp; bump `MP_SCHEMA_VERSION` with schema changes —
the seed throttle keys off it).

Session/token facts (audit-corrected): tokens are **60-day** (was mis-documented as
30). Revocation paths: per-token `/auth/logout`, account-wide on password rotation,
target-wide on lawyer reject/suspend. Legacy chat endpoints keep enforcing
`users.is_banned`; marketplace additionally enforces `app_accounts.status`
(suspended/deleted → 403).

Cron (`17 */6 * * *`): purges expired `app_tokens` rows only.

## Deploy & test (wrangler automation)

```bash
cd server
npm run build          # rebuild dist/vakil-app-worker.js from the pristine bot worker
npm run check          # integrity: every required symbol defined exactly once (128)
npm run check:drift    # marketplace parts embedded in dist are byte-identical to tools/parts/
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


## Marketplace (V1) tables

Ten additive tables back the lawyer marketplace (spec `VAKIL_V1_SPEC.md` §3). All of
them are created **idempotently at first use** by the app worker
(`tools/parts/app_module_schema.js` → `marketplaceEnsureTablesImpl`, registered into the
per-isolate gate `marketplaceEnsureTables` in `app_module_common.js`), and mirrored
statement-for-statement in `server/schema.marketplace.sql` for the operator:

```bash
cd server
npx wrangler d1 execute ailawyer --remote --file=./schema.marketplace.sql
```

The operator run is **optional at runtime** (the worker self-creates), but recommended
**before the first V1 deploy** so tables exist ahead of traffic and ad-hoc
`wrangler d1 execute … --command` queries work immediately. Everything in the file is
`CREATE … IF NOT EXISTS` / `INSERT OR IGNORE` — safe to re-run, and provably harmless to
the bot-owned tables it shares `ailawyer` with (`users`, `chat_history`,
`gemini_api_keys`) plus the earlier `app_devices` / `app_tokens`. No ALTER, no DROP,
no DELETE anywhere.

```sql
app_accounts (user_id INTEGER PK, email, email_norm UNIQUE, username UNIQUE,
  password_hash, google_sub UNIQUE, display_name NOT NULL,
  role CHECK client|lawyer|admin DEFAULT 'client',
  status CHECK active|suspended|deleted DEFAULT 'active', created_at, last_login_at)
lawyer_profiles (user_id INTEGER PK → app_accounts, slug UNIQUE, title, bio,
  specialties TEXT (JSON array of lawyer_categories.slug), languages TEXT (JSON array),
  city, jurisdiction, experience_years, price_toman, duration_minutes DEFAULT 45,
  availability_note, is_available DEFAULT 1,
  verification_status CHECK pending|verified|rejected|suspended DEFAULT 'pending',
  verification_note, verified_at, verified_by, photo_url, created_at, updated_at)
lawyer_categories (slug TEXT PK, name_fa, name_en, sort)          -- 10 seeded rows
consultations (id INTEGER PK, client_user_id, lawyer_user_id,
  status CHECK CREATED|PAYMENT_PENDING|PAID|ACTIVE|COMPLETED|CANCELLED|EXPIRED|REFUNDED|FAILED,
  created_at, updated_at, paid_at, started_at, ends_at,
  duration_minutes, price_toman,           -- snapshot at creation, never mutated
  idempotency_key, UNIQUE (client_user_id, idempotency_key))
consultation_messages (id INTEGER PK, consultation_id, sender_user_id, body, created_at)
payments (id INTEGER PK, consultation_id, user_id /* payer */, amount_toman,
  currency DEFAULT 'IRT', provider /* 'devtest' in V1 */,
  status CHECK pending|succeeded|failed|refunded, provider_ref,
  idempotency_key UNIQUE, created_at, settled_at)
payment_splits (payment_id INTEGER PK, consultation_id, lawyer_user_id, gross_toman,
  commission_toman, lawyer_earnings_toman, commission_bps)  -- derived ledger, 1 row/succeeded payment
platform_config (key TEXT PK, value, updated_at, updated_by)
payout_ledger (id INTEGER PK, lawyer_user_id, amount_toman, method, status
  pending|paid|cancelled, reference, created_by, created_at, paid_at, paid_by)
  — V1 RECORD-KEEPING ONLY: no money moves; `status='paid'` rows are the only
  totals-affecting state; `pending` rows exist to make open commitments visible.
payments gains `refunded_at` (v2) — stamped by the CAS refund writer only.
reviews (id INTEGER PK, consultation_id UNIQUE, client_user_id, lawyer_user_id,
  rating CHECK 1..5, comment, created_at)                    -- extension point, NO rows seeded
admin_audit_log (id INTEGER PK, actor_user_id, action, target_type, target_id,
  note, created_at)                                          -- append-only
```

**Indexes** (also `IF NOT EXISTS`; a failed index is logged and skipped, never fatal):
`idx_ac_email_norm`, `idx_ac_google_sub` (login/Google lookups), `idx_lp_status`,
`idx_lp_price` (verified-only directory + price sorts), `idx_cons_client`,
`idx_cons_lawyer`, `idx_cons_status` (both-sides listing + expiry sweep),
`idx_cm_cons(consultation_id, id)` (pull-since cursor), `idx_pay_cons`, `idx_pay_user`
(payment quote join + history). The UNIQUE column constraints
(`email_norm`, `username`, `google_sub`, `slug`, `payments.idempotency_key`,
`reviews.consultation_id`) get SQLite auto-indexes on top of the named ones.

### Marketplace environment configuration (V1)

| Knob | Kind | Effect when unset | Set how |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | var (public OAuth **Web** client id) | `/auth/google` answers `CONFIG_PENDING` 400; rest of V1 unaffected | `[vars]` in `wrangler.app.toml` or `wrangler secret put` — must equal the MAUI-side id (token `aud` is checked against it) |
| `ADMIN_BOOTSTRAP_EMAILS` | var (comma list, lowercase) | nobody can sign up as admin | `[vars]` — ⚠ use an UN-guessable private mailbox: bootstrap matching happens on the signup-supplied email BEFORE verification (V1); a published guess = squatting risk; V2 email-verification closes it |
| `ADMIN_BOOTSTRAP_SECRET` | **secret** | admin signup falls back to email-only mode (loud warn) | `wrangler secret put ADMIN_BOOTSTRAP_SECRET` — when set, role=admin signup ALSO needs body.bootstrapSecret (constant-time); set before opening public signup |
| `AUTH_PEPPER` | **secret** (mixed into PBKDF2) | password hashes pepperless — set it BEFORE the first signup; rotating it invalidates every password | `cd server && npm run secret:pepper` |
| `PAYMENT_ALLOW_TEST_MODE` | var | test provider `devtest` may settle (V1 default) | set `"0"` the day a real PSP is registered — test providers then fail closed |
| `APP_CHANNEL_CODE` | secret (legacy) | activation-code login stays broken for old users | `npm run secret:code` (unchanged) |



**Idempotency guards** — retried client writes reuse, never duplicate:
`consultations UNIQUE(client_user_id, idempotency_key)` (NULL keys stay
non-colliding, so keyless creates are unaffected), `payments.idempotency_key UNIQUE`
(one charge per key), `payment_splits.payment_id` as PK (one ledger row per
succeeded payment), `reviews.consultation_id UNIQUE` (one review per consultation).

**role vs verification_status** — two orthogonal columns, deliberately:
`app_accounts.role` is *identity-authorization* (`client`/`lawyer`/`admin`) — what the
account may call (`/lawyers/me` vs `/admin/*`); a lawyer sets it once via
`/lawyers/apply`. `lawyer_profiles.verification_status` is *professional vetting* —
every new profile starts `pending` and **only an admin action** (`/admin/lawyers/decide`,
audited in `admin_audit_log`) moves it to `verified`; the public directory serves
verified lawyers only. A lawyer is NOT verified by existing. Neither column is ever
writable from ordinary client input.

**`platform_config` keys** (seeded with `INSERT OR IGNORE` — an admin edit survives a
re-deploy; whitelisted + range-checked in `app_module_admin.js`):

| Key | Seed | Meaning |
|---|---|---|
| `commission_bps` | `2000` | Platform commission in basis points (20.00%) — data, never a hardcoded handler literal |
| `v1_enabled` | `1` | Marketplace kill-switch |
| `consultation_window_hours` | `24` | How long a `PAYMENT_PENDING` consultation stays quotable before expiry |

Seed policy: reference data **only** (categories + config). `lawyer_profiles`,
`reviews`, `consultations` and `payments` are never seeded — fabricated marketplace
content is forbidden (spec header); empty states beat fake data.

`user_id` in `app_accounts` shares the id space with the bot's `users` table; new app
accounts draw from `MARKETPLACE_USER_ID_BASE = 9200000000000` (`app_module_common.js`)
after a collision probe against both tables. Legacy Telegram/activation users keep
using `users` only and simply have no `app_accounts` row (`marketplaceAccount` → null).
