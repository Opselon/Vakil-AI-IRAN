# Vakil AI — Server API (serverless Cloudflare Worker)

Two deployables live here — **both built from the pristine bot worker
(`Desktop/VAKILAI/worker.js`), which is never modified**:

| File | What | Deploy |
|---|---|---|
| `dist/vakil-app-worker.js` | **App serverless API only** — worker `vakil-app`, serves `/api/v1/*` + `/health`; Telegram webhooks are NOT handled here. Committed + deployed | `npm run deploy` |
| `dist/worker.js` | Dual worker (bot + app API in one file — optional future consolidation). **Local-only**: it embeds the private bot source's operator fallback key, so it is gitignored and never pushed | `npm run build:dual`, manual deploy |

## npm scripts (run inside `server/`)

```
build            # rebuild dist/vakil-app-worker.js from the pristine bot worker
build:dual       # rebuild dist/worker.js (dual variant)
check            # integrity audit: 75 required symbols, each defined exactly once
smoke            # 14 offline integration tests (real handler chain; stubbed D1/KV/gateway)
audit:slices     # per-slice parse verification of every engine region extracted
probe:gateway    # audit all cluster keys vs the gateway (model support matrix)
deploy           # wrangler deploy -c wrangler.app.toml
tail             # wrangler tail vakil-app
test:live        # 11 live end-to-end tests against the deployed worker
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
