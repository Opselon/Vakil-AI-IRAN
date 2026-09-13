# ⚖️ وکیل هوشمند ایران — Vakil AI (cross-platform app)

Modern Persian legal-assistant client for iOS, Android, macOS and Windows
(.NET MAUI / net10.0), powered by the **Vakil AI serverless API** on
Cloudflare Workers — the exact same legal engine, prompts and actions that
power the Telegram bot, with **zero** dependency on any chat platform.

> The app talks to **one** surface: `POST /api/v1/*` on your own Cloudflare
> Worker (built from `server/`). API keys never touch the client; quota,
> history and the key cluster live in your D1 database.

## What it does

- 💬 Full legal consultation chat with the bot’s exact 3-part analysis
  (⚖️ موضوع / 📚 تحلیل حقوقی / ✅ نتیجه‌گیری و راهکار + risk-based disclaimer)
- 🧠 8 pro action buttons after every answer: deep case analysis, dos &
  don’ts, courtroom simulator, interrogation simulator, win-rate & financial
  risk, opponent red-teaming, opportunities & threats — and **AI-generated
  dynamic action buttons** (e.g. “📝 تنظیم لایحه …”) that draft real documents
- ✍️ Dedicated document-drafting mode (contracts, petitions, complaints,
  defense bills, legal notices) with the bot’s exact drafting engine
- 🎙 Voice notes and 📸 document photos analyzed with multimodal Gemini
- 🧾 Persian rich-text rendering (bold/italic/quote/code/lists), RTL-first,
  Vazirmatn typography, dark/light themes, animated typing indicator with the
  bot’s exact “thinking frames”
- 👤 Daily-quota UX identical to the bot (Tehran-midnight reset), profile,
  packages/pricing, help, terms, about — all server-delivered
- 💾 **Chat history is stored on-device** (SQLite) — offline browsing,
  survives restarts; server mirror available via `/api/v1/history`
- 🔐 Activation-code auth, HMAC-signed device tokens (60-day expiry),
  certificate-less: no key material on clients at all

## Architecture (Clean / DDD / SOLID)

```
Vakil-AI-IRAN (MAUI app, Presentation)
 ├─ src/VakilAI.Domain          entities, value objects, repository contracts
 ├─ src/VakilAI.Application      use-cases (ChatService), ports (IAppApi…),
 │                               rich-text parser — no platform deps
 ├─ src/VakilAI.Infrastructure   AppApiClient (HTTP/2, retries, typed errors),
 │                               SQLite stores, crypto RNG, delegates
 └─ server/                      single-file Cloudflare Worker: bot code +
                                 /api/v1 app API (same D1 key cluster)
tests/VakilAI.Core.Tests          60+ xUnit tests (parser, service, contracts)
```

- The engine lives **server-side only** (`server/dist/worker.js`); every AI
  capability is an API call. No prompts, keys, or fallback text in the client.
- `IChatService` orchestrates the full conversation state machine
  (idle → thinking-frames → response/pages/quota), platform-free & unit-tested.

## Build & run

```
dotnet restore                # pinned SDK: global.json (net10.0 toolchain)
dotnet build -f net10.0-android -c Release
dotnet build -f net10.0-windows10.0.19041.0 -c Release   # Windows
dotnet test tests/VakilAI.Core.Tests -c Release
```

Server worker (regenerate after editing `server/tools/parts/*`):
```
node server/tools/build_worker.js <pristine-bot-worker.js> server/dist/worker.js
node server/tools/smoke_worker.mjs     # 24 integration assertions
```
Then deploy `server/dist/worker.js` as a **second** Cloudflare Worker sharing
the bot’s D1 — see `server/README.md` for the 10-step guide.

Activation: users enter the code you publish (`APP_CHANNEL_CODE` secret) on
first launch; the app provisions a stable device identity automatically.

## CI/CD

- `.github/workflows/ci.yml` — core tests, server smoke, Android + Windows
  build gates on every push/PR
- `.github/workflows/release.yml` — GitHub Release with **per-CPU APKs**
  (arm64-v8a / armeabi-v7a / x64, optional keystore signing) and **self-contained
  Win-x64 & Win-arm64 EXE zips**, plus SHA256SUMS for verification

## Status

- Serverless API: built + 24/24 integration tests (against real handler chain
  with stubbed D1/gateway) ✅ — deploy your worker to go live
- Android & Windows heads: compile-verified locally; iOS/MacCatalyst buildable
  from macOS with the same codebase
- Chat-history sync from server (multi-device restore): API ready
  (`/api/v1/history`), UI merge planned next

© Vakil AI — قانون جمهوری اسلامی ایران.
