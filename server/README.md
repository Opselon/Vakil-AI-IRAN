# Vakil AI — Server API (serverless Cloudflare Worker)

Two deployables live here — **both built from the pristine bot worker
(`Desktop/VAKILAI/worker.js`), which is never modified**:

| File | What | Deploy |
|---|---|---|
| `dist/vakil-app-worker.js` | **App serverless API only** — worker `vakil-app`, serves `/api/v1/*` + `/health`; Telegram webhooks are NOT handled here. Committed + deployed | `npm run deploy` |
| `dist/worker.js` | Dual worker (bot + app API in one file — optional future consolidation). **Local-only**: it embeds the private bot source's operator fallback key, so it is gitignored and never pushed | `npm run build:dual`, manual deploy |

## Production config checklist (one-time, in this order)

Each value is documented per-row in `DB.md` (config table, ~lines 254-258); this is
only the sequence. The names are identical across code, `wrangler.app.toml`, CI and DB.md.

```bash
cd server
npx wrangler secret put AUTH_PEPPER              # random 32+ chars — BEFORE the first signup
npx wrangler secret put ADMIN_BOOTSTRAP_SECRET   # second factor for role=admin signup
npx wrangler secret put ADMIN_BOOTSTRAP_EMAILS   # comma list; UN-guessable mailbox (see DB.md note)
npx wrangler secret put GOOGLE_CLIENT_ID         # optional; unset => /auth/google answers CONFIG_PENDING
npx wrangler deployments status -c wrangler.app.toml
```

Then:
1. Create your admin: `POST /auth/signup` with `role:"admin"`, an address inside
   `ADMIN_BOOTSTRAP_EMAILS` **and** `bootstrapSecret`. Email-only bootstrap is refused
   once the secret is set — that refusal is the Wave-1 blocker fix.
2. Provision a DEDICATED CI smoke admin the same way, add its address to
   `ADMIN_BOOTSTRAP_EMAILS`, then `gh secret set SMOKE_ADMIN_EMAIL` /
   `gh secret set SMOKE_ADMIN_PW`. CI's marketplace live smoke runs its admin steps for
   real with them; without them it SKIPs them honestly (never fakes admin power).
3. `PAYMENT_ALLOW_TEST_MODE` stays `1` until a real PSP is registered: with it on,
   `/consultations/pay` SIMULATES settlement and every response says so. Set it to `0`
   before telling anyone the app takes money.

Verify against production: `npm run test:live` (legacy chat rails) and
`npm run test:live:app` (marketplace rails on real D1 — SKIP lines are information).

## npm scripts (run inside `server/`)

```
build            # rebuild dist/vakil-app-worker.js from the pristine bot worker
build:dual       # rebuild dist/worker.js (dual variant)
check            # integrity audit: 139 required symbols, each defined exactly once
check:drift      # marketplace parts vs shipped artifact (byte-identical)
smoke            # 14 offline integration tests (real handler chain; stubbed D1/KV/gateway)
smoke:marketplace # marketplace lifecycle smoke over real SQLite (Node 24; 18 steps incl. wave-2 reviews/cancel/refund/payouts)
audit:slices     # per-slice parse verification of every engine region extracted
probe:gateway    # audit all cluster keys vs the gateway (model support matrix)
deploy           # wrangler deploy -c wrangler.app.toml
tail             # wrangler tail vakil-app
test:live        # 11 live end-to-end tests against the deployed worker
secret:pepper  # AUTH_PEPPER — set BEFORE the first signup (see DB.md)
secret:token     # set APP_TOKEN_SECRET
secret:code      # set APP_CHANNEL_CODE (app activation code)
```

## Bindings (wrangler.app.toml)

* D1 `ailawyer` → `env.DB` (shared with the bot: `gemini_api_keys` cluster, quota,
  chat mirror, app devices/tokens)
* KV `GeminiKV` → `env.KV` (sticky sessions, leases, cooldowns, EWMA metrics)
* Service `purple-bread-2b60` → `env.GEMINI_PROXY` (AI gateway over worker-to-worker
  calls — public *.workers.dev HTTP from a Worker is refused with error 1042)

## Docs

* **DB.md** — schema, indexes, the 500-key failover algorithm, operator commands
* **.github/workflows/ci.yml** — syntax + integrity + smoke on every push/PR
* **.github/workflows/deploy-worker.yml** — manual wrangler deploy with health probe

The app worker shares the same records the bot already uses — API keys never
leave D1, prompts/buttons/pages are extracted verbatim at build time
(`tools/extract_prompts.cjs`), so bot and app can never drift apart.
