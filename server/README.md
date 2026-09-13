# Vakil AI — Server API (serverless Cloudflare Worker)

This folder builds the **one file you deploy**: `dist/worker.js`.

The deployed **Telegram bot worker is NOT modified**. This produces a *second*
worker for the mobile/desktop app that shares the **same D1 database**, so the
API-key cluster (`gemini_api_keys`), user quota (`users`), and chat memory
(`chat_history`) are exactly the records the bot already uses — keys never
leave Cloudflare and are never duplicated.

## Build pipeline

```
Desktop/VAKILAI/worker.js   (pristine bot source, read-only)
        │
        ├─ tools/extract_prompts.js   → src/app_api.prompts.js
        │     (auto-verbatim extraction of every AI prompt + every UI page text
        │      from the bot source; line anchors are verified — a bot edit that
        │      moves a prompt fails the build loudly instead of drifting)
        │
        └─ tools/build_worker.js      → dist/worker.js  (single file)
              • replaces `import { ErrorTraceLog } …` with an inlined
                API-compatible tracer (class implements every member the bot uses)
              • inserts the /api/v1 route BEFORE the bot's env check
              • appends the app module (auth, chat, quick-action, history)
```

Regenerate + verify (24 integration tests against the real handler chain —
token signing, D1 quota, cluster-key routing through `processWithGemini`,
JSON-capsule post-processing, drafting mode, dynamic [ACTION:] buttons,
CORS, tamper rejection):

```
node tools/build_worker.js "C:/Users/Capsizer/Desktop/VAKILAI/worker.js" dist/worker.js
node tools/smoke_worker.mjs          # must print: 24 passed, 0 failed
```

## Endpoints (used by the .NET MAUI client)

| Method | Path                     | Body / Query                                   | Purpose |
|--------|--------------------------|------------------------------------------------|---------|
| GET    | `/api/v1/health`         | –                                              | probe   |
| POST   | `/api/v1/auth/verify`    | `{deviceId, code, name?, platform?}`           | activation → bearer token (APP_CHANNEL_CODE) |
| POST   | `/api/v1/chat`           | `{token, text, imageBase64?, imageMime?, audioBase64?, audioMime?}` | full legal analysis with the bot's own engine; returns `chunks[]`, keyboard (8 action buttons), quota |
| POST   | `/api/v1/quick-action`   | `{token, action, contextText?}`                | deep_analysis / dos_and_donts / court_simulator / interrogation_sim / financial_risk / opponent_claims / legal_opportunities / ai_act\|… / cmd_limit / cmd_contact / cmd_drafting / cmd_help / cmd_terms / cmd_about / main_menu … |
| POST   | `/api/v1/history`        | `{token}`                                      | server-side mirror of chat_history (recovery) |

Quota model is the bot's: `DAILY_LIMIT` requests/day reset at Tehran midnight,
admin bypass unchanged, BAN propagation via `users.is_banned`.
Validation warnings (too-short text, image without caption, image limit) return
the exact same Persian texts the bot sends, flagged `costless: true` so the app
doesn't count them against quota.

## Deploy (one-time)

1. `cd server`
2. `npx wrangler login`
3. Edit `wrangler.toml`: set your `database_name`/`database_id` (same D1 as the bot) and KV id.
4. `npx wrangler d1 execute <DB_NAME> --remote --file=./schema.sql` (adds `app_devices`, `app_tokens`).
5. `npx wrangler secret put APP_TOKEN_SECRET` — long random string (token signing).
6. `npx wrangler secret put APP_CHANNEL_CODE`  — the code you give users in-app.
7. `npx wrangler secret put GEMINI_API_KEY`    — at least one cluster key (fallback; runtime prefers D1 cluster).
8. Optional `PROXY_SECRET_TOKEN` for the gateway worker.
9. `npx wrangler deploy` → you get `https://vakil-ai-app.<account>.workers.dev`.
10. Put that URL in the app (Settings screen or build-time `VAKIL_API_BASE_URL`).

Security notes: path-prefix only answers `/api/v1/*`; everything else keeps the
existing webhook rules. Tokens are HMAC-signed, stored hashed in D1 (revocable
per device), 60-day expiry. Activation code comparison is constant-time.
The API never exposes key values — `getActiveGeminiKey` results stay server-side.
