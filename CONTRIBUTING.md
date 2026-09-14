# Contributing — وکیل هوشمند ایران / Vakil AI

Persian legal-assistant app: .NET MAUI client (net10.0, four heads) + a
Cloudflare Worker API in `server/`. One ground rule above all rules:
**ship only what you have actually run.** No mocks or fabricated data ever
reach a production path — stubs live only inside offline tests.

## Development loop

### Client (.NET MAUI)

Prerequisites: the pinned SDK from `global.json` (net10.0 toolchain) and the
MAUI workloads (`dotnet workload restore Vakil-AI-IRAN.csproj`).

```bash
dotnet restore

# fast inner loop — Windows head
dotnet build Vakil-AI-IRAN.csproj -f net10.0-windows10.0.19041.0 -c Debug
dotnet run    -f net10.0-windows10.0.19041.0            # F5 in VS works too

# Android head (device or emulator)
dotnet build Vakil-AI-IRAN.csproj -f net10.0-android -c Debug
dotnet build Vakil-AI-IRAN.csproj -f net10.0-android -c Release   # pre-push parity with CI

# iOS / MacCatalyst compile-check (macOS only)
dotnet build Vakil-AI-IRAN.csproj -f net10.0-ios -c Release
dotnet build Vakil-AI-IRAN.csproj -f net10.0-maccatalyst -c Release

dotnet test tests/VakilAI.Core.Tests -c Release --nologo   # 237 tests
```

Layout: `src/VakilAI.Domain` (entities/contracts — no deps),
`src/VakilAI.Application` (use-cases, ports, rich-text parser — no platform
deps), `src/VakilAI.Infrastructure` (HTTP/SQLite/crypto), root `Pages/`,
`Controls/`, `Rendering/`, `Services/` (MAUI presentation). Keep the dependency
arrow pointing inward: Domain knows nothing about the others; only
Infrastructure may touch platform APIs. UI is RTL-first, Vazirmatn, dark-first.

### Server (Cloudflare Worker, `server/`)

Run inside `server/` (Node 22):

```bash
npm run build            # rebuild dist/vakil-app-worker.js from the pristine bot worker
npm run check            # integrity: every required symbol defined exactly once
npm run smoke            # 14 offline integration tests (real handler chain, stubbed D1/KV/gateway)
npm run audit:slices     # per-slice parse verification of extracted engine regions
npm run test:live        # 11 live E2E tests against the deployed worker (operator credentials)
npm run deploy           # wrangler deploy -c wrangler.app.toml (operator only)
npm run tail             # logs of the live worker
```

The bot worker (`Desktop/VAKILAI/worker.js` on the operator machine) is
**pristine and never edited** — app behaviour is assembled from
`server/tools/parts/*` + verbatim slices, and prompts/buttons/pages are
extracted at build time (`tools/extract_prompts.cjs`) so bot and app can never
drift. If you change a slice: `npm run build && npm run check && npm run smoke`
and commit the regenerated `server/dist/vakil-app-worker.js` in the same PR.

## Verify before push (hard rule)

A push/PR is ready only when **all three** pass locally, in this order:

1. `dotnet test tests/VakilAI.Core.Tests -c Release` — all 237 green
2. Offline smokes — `npm run check` + `npm run smoke` in `server/` (14/14),
   plus a `dotnet build -c Release` of every head you touched
3. Live smoke — `npm run test:live` against the deployed worker (11/11) whenever
   your change can affect the server path (parts/, tools/, dist/, auth, quota).
   Client-only changes still need the live worker to be green, since the app
   has no offline AI fallback by design.

CI re-runs 1 and 2 on every push/PR; never push on the expectation that CI will
catch it for you. Do not weaken, skip, or `[Fact(Skip)]` an assertion to get
green — fix the cause or raise it in the PR.

## Branches & pull requests

- `master` is the trunk — always branch off it, keep it releasable.
- Name branches `type/short-topic` (`feat/marketplace-ui`, `fix/token-expiry`,
  `docs/landing-page`, `ci/android-workload`).
- One logical change per PR; rebase (not merge) onto fresh `master` before
  requesting review.
- PR title: conventional commit style (`feat: …`, `fix: …`, `docs: …`, `ci: …`).
  Body must state: what changes, how it was verified (paste the three green
  results above), and which surfaces are affected (client head / worker / both).
- UI copy changes must keep bot-parity — if the wording comes from the server,
  change it in the bot slice, not in a client string.
- Never commit real secrets: no `APP_CHANNEL_CODE` value, no `APP_TOKEN_SECRET`,
  no API keys, nothing from a keystore. Docs and screenshots must not leak them.
- Releases are cut by the maintainer via the `release.yml` workflow_dispatch;
  contributors do not tag versions.

## Code style (short version)

- C#: nullable enabled, file-scoped namespaces, expression members where they
  read better; match the surrounding file.
- The big comment banners in service files (PURPOSE / OWNER / PROVIDES /
  CONSUMES) are the repo's module contract idiom — keep them updated when you
  touch the file.
- Persian user-facing strings use proper Persian punctuation and ZWNJ
  (نیم‌فاصله); numerals in UI text are Persian (۱۲۳) except user-entered data.

## Getting help

Start with `README.md`, `server/README.md` and `server/DB.md` (failover and
schema truth). Spec: `VAKIL_V1_SPEC.md`. If a smoke fails in a way the docs
don't explain, open an issue with the failing output.
