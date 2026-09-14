# Vakil AI — V1 Marketplace Infrastructure Spec (SSOT)

Owner: lead implementation coordinator. All 10 V1 agents read this file FIRST and follow it exactly.
Anything not specified here is your call, but must stay minimal, additive and reversible.

**V1 posture:** clean, working, extensible foundation. NOT over-engineered security, NOT exhaustive tests,
NOT production payment hardening. Do not create hundreds of tests. Do not redesign working architecture.
Never fabricate lawyers, ratings, reviews, credentials, verification, earnings or consultation stats —
empty states beat fake data.

---

## 1. Existing system (verified — do not re-derive, do not duplicate)

### Backend — Cloudflare Worker + D1

* Live worker: `vakil-app` → `https://vakil-app.samerkhaldounmarefi.workers.dev` (routes `/api/v1/*`, `/health`).
* Shipped artifact: `server/dist/vakil-app-worker.js` — **AUTO-GENERATED, never hand-edit.**
  Rebuild: `cd server && npm run build` (= `node tools/build_app_worker.cjs "C:/Users/Capsizer/Desktop/VAKILAI/worker.js" dist/vakil-app-worker.js`).
  That pristine bot worker source (`Desktop/VAKILAI/worker.js`) is **read-only** — never modify it.
* Sources you edit: `server/tools/parts/app_module_head.js`, `app_module_engine.js`, `app_module_body.js`,
  plus the NEW V1 modules (see §5). `tools/extract_prompts.cjs` regenerates `server/src/app_api.prompts.js`.
* Integrity gate: `npm run check` (every required symbol defined exactly once, no undefined calls).
* Offline integration tests: `npm run smoke` (14 tests, stubbed D1/gateway). Live: `npm run test:live`.
* D1 `ailawyer` = `env.DB` (id `d2d3f21d-67c4-41f5-b21c-430102a913ae`), **SHARED with the Telegram bot**.
  KV `GeminiKV` = `env.KV`. AI gateway = service binding `env.GEMINI_PROXY`. Details: `server/DB.md`.
* Existing tables: `users` (bot-owned: user_id, username, first_name, joined_at, last_interaction_date,
  message_count, is_banned, image_count_today, image_count_today_today, mode, draft_data, phone_number),
  `chat_history`, `gemini_api_keys` (key cluster), `app_devices(device_id,user_id,name,platform,created_at)`,
  `app_tokens(token_hash,device_id,user_id,created_at,expires_at)`.
* Existing auth: `POST /api/v1/auth/verify` compares one shared `APP_CHANNEL_CODE` (constant-time), provisions a
  synthetic `9xxxxxxxxxxx` user id into `users`, then `appApiIssueToken()` → token =
  `base64url(JSON payload) + "." + sig` where `sig = sha256(JSON(payload) + "|" + APP_TOKEN_SECRET).slice(0,32)`
  and payload = `{v,did,uid,name,iat,exp}`. `appApiVerifyToken()` re-checks sig + `exp` + a DB row in `app_tokens`
  joined to `users.is_banned`. Table creation is idempotent at first use (`appApiEnsureTables`).
* Existing endpoints that MUST keep working unchanged: `/api/v1/chat`, `/api/v1/quick-action`,
  `/api/v1/history`, `/api/v1/health`, and legacy `/api/v1/auth/verify`.

### Client — .NET MAUI (`Vakil-AI-IRAN`, net10.0-android/ios/maccatalyst/windows)

* Clean Architecture: `src/VakilAI.Domain` (entities, value objects, repo interfaces),
  `src/VakilAI.Application` (`Contracts/Ports.cs` = wire DTOs + `IAppApi`/`ITokenStore`/… ports,
  `Services/ChatService.cs` = the engine orchestrator, publishes `ChatStateChanged` snapshots),
  `src/VakilAI.Infrastructure` (`Api/AppApiClient.cs` = the only HTTP surface; `Storage/Delegate*Store`;
  `SqliteChatRepository`). The MAUI app project references all three.
* DI: `MauiProgram.Services` (static `IServiceProvider`); pages resolve from it. **No Shell, no x:Arguments DI**
  (deliberate — XAML reliability). `App.CreateWindow` shows a `BootPage` then swaps `window.Page`.
* Pages: `Pages/ActivationPage`, `Pages/ChatPage` (+ `Controls/BootPage.cs`, `Controls/UiMotion.cs`,
  `Rendering/RichBlockRenderer.cs`).
* Design system: `AppTheme.xaml` (merged into `App.xaml`) — "Aurora/Glass": colors `Accent #6366F1`,
  `AccentSoft #818CF8`, `AccentDeep #4338CA`, `Gold #D4AF37`, `Violet #8B5CF6`, `Cyan #22D3EE`,
  `SurfaceDark #0B1220`, `InkDark #E6EDF7`, `InkMuted #94A3B8`, `GlassDark #1A2438`, `GlassLight #F7F9FE`,
  `Danger/Success/Caution`. Styles to reuse: `PageStyle`, `GlassCard`, `IconPlate`, `EntryCard`, `CtaCard`,
  `Caption`, `MenuChip`, `IconCircle`, `ChatBubble`, `UserBubble`, `ComposerEditor`, brushes
  `AuroraIndigoBrush/Violet/Gold/Cyan`, `GoldBrush`, `HeaderGradientBrush`, `CtaBrush`, `ShimmerBrush`.
  Full light/dark via `{AppThemeBinding Light=…, Dark=…}`. RTL: every page sets
  `FlowDirection=RightToLeft` (via `PageStyle`), font `VazirmatnRegular/Medium/Bold`. Persian UI copy.
* Animation: only the **Async** extension methods (`FadeToAsync`, `ScaleToAsync`, `TranslateToAsync`) and
  `DisplayAlertAsync`. The non-Async ones are obsolete in .NET 10 MAUI → they produce CS0618. Use `UiMotion`.
* Zero-warning policy: the Windows build must stay at **0 warnings, 0 errors**.

---

## 2. V1 product decisions (fixed)

1. **No activation code in the normal signup path.** New: email or username + password. Legacy
   `/auth/verify` (channel code) stays deployed for compatibility and is removed from the primary UX.
2. **Roles** live server-side, never trusted from the client: `client`, `lawyer`, `admin`.
   `role` is identity-authorization; `verification_status` is a separate professional-verification concept.
   **A lawyer is NOT verified.** New lawyers start `pending`; only an admin action can move them to `verified`.
3. **Google login**: verify an ID token (`credential` from the MAUI `Authenticator`/WebView) against
   Google's `tokeninfo` endpoint. Credentials come from env/secret (`GOOGLE_CLIENT_ID`) — never hardcoded.
   If unconfigured, the endpoint returns a clear `CONFIG_PENDING` code and the rest of V1 keeps working.
   GitHub = extension point only (`/auth/oauth/exchange` shape + provider registry), not required for V1.
4. **Consultation lifecycle** is explicit domain state, never a boolean:
   `CREATED → PAYMENT_PENDING → PAID → ACTIVE → COMPLETED`, plus `CANCELLED`, `EXPIRED`, `REFUNDED`, `FAILED`.
5. **Payments**: provider abstraction + one **dev/test** provider, explicitly labelled. No fake production
   success. Commission rate is data (`platform_config.commission_bps`), never a hardcoded literal in handlers.
6. **Chat**: AI chat (`/api/v1/chat`) and lawyer consultation chat are SEPARATE surfaces that coexist.
   Consultation messages persist server-side; membership is enforced server-side on every read/write.
   Do NOT build WebSockets/real-time in V1 — poll/pull on an open session, like the existing history mirror.
7. **Admin**: API/domain foundation + a minimal static dashboard (single HTML file) is enough for V1.
8. Idempotency: consultation create + payment accept an `Idempotency-Key`-style client key column.

---

## 3. Target D1 schema (ADDITIVE ONLY — new tables, no destructive change to `users`)

All tables created idempotently by `marketplaceEnsureTables(env)` (same pattern as `appApiEnsureTables`), and mirrored
in `server/schema.marketplace.sql` for `wrangler d1 execute … --file`. `user_id`/`id` are INTEGER, ms epochs are INTEGER.

```sql
-- credential + profile record for app accounts (Telegram users keep using `users` only)
app_accounts (
  user_id        INTEGER PRIMARY KEY,      -- shares the id space with `users`
  email          TEXT,                     -- nullable, unique when set
  email_norm     TEXT UNIQUE,              -- lower-cased lookup key (NULL allowed, SQLite unique ignores NULLs)
  username       TEXT UNIQUE,
  password_hash  TEXT,                     -- "pbkdf2$<iter>$<saltB64>$<hashB64>"; NULL for oauth-only accounts
  google_sub     TEXT UNIQUE,              -- stable Google subject id
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'client'   CHECK (role IN ('client','lawyer','admin')),
  status         TEXT NOT NULL DEFAULT 'active'   CHECK (status IN ('active','suspended','deleted')),
  created_at     INTEGER, last_login_at INTEGER
)

-- one row per lawyer; existence of a row = "applied as lawyer"
lawyer_profiles (
  user_id             INTEGER PRIMARY KEY,      -- -> app_accounts.user_id
  slug                TEXT UNIQUE,              -- /lawyer/<slug>
  title               TEXT,                     -- professional title, self-declared
  bio                 TEXT,                     -- short biography, self-declared
  specialties         TEXT,                     -- JSON array of category slugs
  languages           TEXT,                     -- JSON array
  city                TEXT, jurisdiction        -- TEXT (location/where they practise)
  experience_years    INTEGER,
  price_toman         INTEGER,                  -- consultation price, Tomans (integer minor-free unit)
  duration_minutes    INTEGER DEFAULT 45,
  availability_note   TEXT,                      -- free-text V1 availability
  is_available        INTEGER DEFAULT 1,
  verification_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (verification_status IN ('pending','verified','rejected','suspended')),
  verification_note   TEXT, verified_at INTEGER, verified_by INTEGER,
  photo_url           TEXT,
  created_at INTEGER, updated_at INTEGER
)
-- index: idx_lp_status ON lawyer_profiles(verification_status)

lawyer_categories (slug TEXT PRIMARY KEY, name_fa TEXT, name_en TEXT, sort INTEGER)

consultations (
  id             INTEGER PRIMARY KEY,        -- Date.now()*1000 + counter
  client_user_id INTEGER NOT NULL,
  lawyer_user_id INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'CREATED'
      CHECK (status IN ('CREATED','PAYMENT_PENDING','PAID','ACTIVE','COMPLETED','CANCELLED','EXPIRED','REFUNDED','FAILED')),
  created_at INTEGER, updated_at INTEGER, paid_at INTEGER, started_at INTEGER, ends_at INTEGER,
  duration_minutes INTEGER, price_toman INTEGER,     -- snapshot at creation (price never mutated retroactively)
  idempotency_key TEXT,
  UNIQUE (client_user_id, idempotency_key)
)
-- index: idx_cons_client, idx_cons_lawyer, idx_cons_status

consultation_messages (
  id INTEGER PRIMARY KEY, consultation_id INTEGER NOT NULL, sender_user_id INTEGER NOT NULL,
  body TEXT, created_at INTEGER
)
-- index: idx_cm_cons ON consultation_messages(consultation_id, id)

payments (
  id INTEGER PRIMARY KEY, consultation_id INTEGER NOT NULL, user_id INTEGER NOT NULL,   -- payer (client)
  amount_toman INTEGER NOT NULL, currency TEXT DEFAULT 'IRT', provider TEXT NOT NULL,   -- 'devtest' | future
  status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','succeeded','failed','refunded')),
  provider_ref TEXT, idempotency_key TEXT UNIQUE, created_at INTEGER, settled_at INTEGER
)
-- ledger: platform commission + lawyer earnings are DERIVED, single row per succeeded payment
payment_splits (
  payment_id INTEGER PRIMARY KEY, consultation_id INTEGER, lawyer_user_id INTEGER,
  gross_toman INTEGER, commission_toman INTEGER, lawyer_earnings_toman INTEGER,
  commission_bps INTEGER                       -- the rate that actually applied
)

platform_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER, updated_by INTEGER)
-- seeded: commission_bps=2000 (20.00%), v1_enabled=1

reviews (id INTEGER PRIMARY KEY, consultation_id INTEGER UNIQUE, client_user_id INTEGER,
         lawyer_user_id INTEGER, rating INTEGER CHECK (rating BETWEEN 1 AND 5),
         comment TEXT, created_at INTEGER)     -- table exists as the extension point; NO seeded rows

admin_audit_log (id INTEGER PRIMARY KEY, actor_user_id INTEGER, action TEXT,
                 target_type TEXT, target_id TEXT, note TEXT, created_at INTEGER)
```

`app_tokens.device_id` and the token payload stay as-is; V1 adds `role` **server-side lookup only**
(a helper `marketplaceAccount(env, userId)`), not new required token fields — old tokens keep working.

---

## 4. HTTP surface (all under `/api/v1`, JSON, `appApiJson`/`appApiErr` envelope)

Every response uses the existing envelope: success `{ok:true, …}`, failure `{ok:false, code, message}`.
`message` is always user-presentable Persian. Authenticated endpoints take `token` in the body (existing style).

### Auth (Agent 1/2)
| Route | Purpose |
|---|---|
| `POST /auth/signup` | `{email?, username?, password, displayName, role:'client'|'lawyer'}` → `{ok, token, user, quota}`; role=lawyer also creates a `pending` profile row. `role:'admin'` is accepted ONLY when the normalized email appears in env `ADMIN_BOOTSTRAP_EMAILS` (comma list; unset = nobody).
| `POST /auth/login` | `{identifier, password}` → `{ok, token, user, quota}` |
| `POST /auth/google` | `{credential}` → verifies → `{ok, token, user, quota}` (or `CONFIG_PENDING`) |
| `POST /auth/oauth/exchange` | `{provider, code, redirectUri}` → extension point, returns `NOT_CONFIGURED` in V1 |
| `POST /auth/me` | `{token}` → `{ok, user, quota, capabilities}` |
| `POST /auth/password/set` | `{token, newPassword}` (recovery foundation; email reset is a documented stub) |

`user` = `{userId, displayName, email?, username?, role, verificationStatus?}`.
Passwords: PBKDF2-SHA256 via `crypto.subtle` (100k iters, 16-byte random salt), optional `AUTH_PEPPER` env.
Signup/login rate limiting: KV counters, cheap and visible, not elaborate.

### Lawyer marketplace (Agent 4)
`POST /lawyers/list` `{query?, category?, city?, maxPrice?, sort?, token?}` → `{ok, lawyers[], total}` —
**only `verification_status='verified'` by default** plus `?includePending` NOT exposed to clients; the
directory shows verified lawyers, and the empty state is a feature. Sorting: `rating` is NOT implemented in V1
(no fake data) → default `experience`, `price_asc`, `price_desc`, `recent`.
`POST /lawyers/get` `{userId | slug}` → public profile (verified lawyers only, + self for its owner).
`POST /lawyers/apply` `{token}` → a client upgrades to lawyer: sets `app_accounts.role='lawyer'` (refuses for
admin accounts; idempotent if already lawyer) and inserts a `pending` `lawyer_profiles` row with a fresh slug.
Returns the same payload as `/lawyers/me`. This is the path the account page's "accept as lawyer" button uses.
`POST /lawyers/me` `{token}` → the caller's own profile incl. `verificationStatus` and admin note.
`POST /lawyers/save` `{token, …fields}` → lawyer edits own profile; any edit by a verified lawyer resets it to
`pending` UNLESS `KEEP_VERIFIED_ON_EDIT=1` (code polarity is authoritative); NEVER accepts `verificationStatus` from the client.
`POST /lawyers/categories` `{}` → `{ok, categories[]}`.

### Consultation (Agent 7) + payments (Agent 8)
`POST /consultations/create` `{token, lawyerUserId, durationMinutes?, idempotencyKey}` →
status `PAYMENT_PENDING` + price + a `payment` quote. Server validates: lawyer exists & verified &
available, not self, price snapshot. `POST /consultations/pay` `{token, consultationId, idempotencyKey}` →
provider charge → on success `PAID` + `payment_splits` row. `POST /consultations/list` `{token, scope:mine}` →
both directions for client/lawyer. `POST /consultations/get` + `/messages` (append) + `/send` +
`/complete` — **membership enforced every call**; non-participant = `FORBIDDEN`, closed/expired = `NOT_ACTIVE`.
`POST /payments/history` `{token}` → transactions + earnings (lawyer) + platform commission totals (admin).

### Admin (Agent 6) — every route re-checks `role==='admin'` server-side
`POST /admin/overview` · `/admin/users/list` · `/admin/lawyers/pending` · `/admin/lawyers/decide`
`{token, userId, decision:'verify'|'reject'|'suspend'|'restore', note?}` · `/admin/config/get|set`
(commission_bps) · `/admin/consultations/list` · `/admin/audit/list`.
Static foundation: `server/admin/index.html` (token-paste login, calls the same API).

---

## 5. File ownership (hard boundaries — never edit a file another agent owns)

Naming convention (user directive): every generated file gets a descriptive solid name (no `v1_*`/`_tmp` style)
and MUST open with a full header comment block:

```
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — what this module does, 2–4 lines
// OWNER     — agent number + role that owns future edits
// CONSUMES  — which existing functions/tables/env it relies on
// PROVIDES  — the routes/functions it registers (the public surface)
// INVARIANTS— rules later agents must not break (e.g. "verification is never
//             writable from client input")
// EXTEND    — how to add to this module later (for the next engineer)
// ═══════════════════════════════════════════════════════════════════════════
```
Every public handler function gets a short doc comment (purpose, params, error codes).

| File | Owner |
|---|---|
| `server/tools/parts/app_module_common.js` (router dispatcher + shared helpers — WRITTEN, read-only for agents) | coordinator |
| `server/tools/parts/app_module_schema.js` (marketplaceEnsureTables + seeds), `server/schema.marketplace.sql`, `server/DB.md` (V1 section) | Agent 3 |
| `server/tools/parts/app_module_auth.js` | Agent 1 |
| `server/tools/parts/app_module_google.js` | Agent 2 |
| `server/tools/parts/app_module_lawyers.js` | Agent 4 |
| `Pages/LawyersPage.xaml(.cs)`, `Pages/LawyerProfilePage.xaml(.cs)` | Agent 5 |
| `server/tools/parts/app_module_admin.js`, `server/admin/**` | Agent 6 |
| `server/tools/parts/app_module_consultations.js` | Agent 7 |
| `server/tools/parts/app_module_payments.js` | Agent 8 |
| builds/smoke/integration fixes: `server/tools/**` (except parts above), `.github/workflows/**`, any file when FIXING a build break | Agent 9 |
| `Pages/AuthPage.xaml(.cs)`, `Pages/ConsultChatPage.xaml(.cs)` (client shell), `Pages/HostPage.xaml(.cs)`, `App.xaml.cs`, `MauiProgram.cs`, `ActivationGate.cs`, `AppTheme.xaml` ADDITIVE styles (coordinate via requests file) | Agent 10 |
| `src/VakilAI.Application/Contracts/MarketplaceContracts.cs`, `src/VakilAI.Domain/Entities/MarketplaceModels.cs`, `src/VakilAI.Infrastructure/Api/MarketplaceApiClient.cs` | **coordinator only** |
| `server/tools/build_app_worker.cjs`, router hook in `app_module_body.js` | **coordinator only** |
| `MARKETPLACE_INTEGRATION_REQUESTS.md` (append-only cross-agent asks; each agent one clearly-marked section) | shared-append |

Rules:
* Client agents (5, 10) may **only** call the typed port `IMarketplaceApi` implemented by
  `MarketplaceApiClient.cs` — no raw `HttpClient` in pages. The coordinator writes this layer at dispatch
  time; read it before coding UI. Need a DTO/field change? Append to `MARKETPLACE_INTEGRATION_REQUESTS.md`
  and code against the requested shape; the coordinator applies it.
* Route registration: your module registers its own routes via `marketplaceRegister("POST /api/v1/…", handler)`
  at top level (see `app_module_common.js` header — do not touch the router in `app_module_body.js`).
* New server modules: no `import`/`export`, no top-level `await`, no top-level side effects other than
  `marketplaceRegister`. Do NOT duplicate helper names — the following already exist (reuse them):
  `appApiJson`, `appApiErr`, `appApiSha256Hex`, `appApiIssueToken`, `appApiVerifyToken`, `appApiAuthed`,
  `appApiUserFromPayload`, `checkUserLimit`, `getTehranTodayDate` — plus the shared helpers in
  `app_module_common.js` (`marketplaceEnsureTables`, `marketplaceAccount`, `marketplaceRateLimit`,
  `marketplaceNewId`, `marketplaceJsonNow`, guards for lawyer/admin).
* **Build collision:** only Agent 9 may write `dist/` or run `npm run build|check|smoke`. To validate
  yourself, run `node --check server/tools/parts/<yourfile>.js` and, if needed, build to a THROWAWAY path:
  `node server/tools/build_app_worker.cjs "C:/Users/Capsizer/Desktop/VAKILAI/worker.js" "$TEMP/<agent>-test.js"`
  (never to `dist/`).
* `Pages/ChatPage.xaml(.cs)` and the XAML design tokens in `AppTheme.xaml` are owned by **Agent 10 only**
  (it wires the marketplace entry points into the existing chat screen). Agent 5 builds its pages from
  the patterns already present in `ActivationPage.xaml` / `ChatPage.xaml` — do not edit those files.
* **Testing posture (V1):** no xUnit suites, no test projects, no CI edits unless a build breaks. Server
  verification = `node --check` + the existing `smoke_app_worker.mjs` chain (must stay 14/14 PASS) +
  `tools/smoke_marketplace.mjs` (Agent 9's one smoke file). Note: Node 24 here has a real embedded SQL
  engine — `require('node:sqlite').DatabaseSync` — so Agent 9 may drive handlers against a genuine SQLite
  D1 stub instead of pattern-matched SQL fakes. That is the V1 test budget; do not expand it.
* Git: read-only commands only (`git status`, `git diff`, `git log`). **NEVER** `reset --hard`, `clean`,
  `stash`, `checkout --`, `restore`, commit or push. Other agents' WIP must survive you.

## 5b. Handoff report format (every agent, final message)

1. FILES: absolute paths created/edited, one per line, marked NEW/EDITED.
2. GATES: exact command + verbatim result line (`node --check`, `dotnet build`, smoke output).
3. SURFACE: routes/records you added (so integrators can cite them, not guess).
4. CONTRACT-REQUESTS: items appended to MARKETPLACE_INTEGRATION_REQUESTS.md, or `none`.
5. ASSUMPTIONS / NOT-VERIFIED: honest list — including anything you could not run and why.
6. FOLLOW-UPS: what V1 deferred (max 5 bullets).
Never report a route as working if you never executed it. Never report a UI page as compiling if you
never compiled it — say "not compiled, coordinator to verify".

## 6. Definition of done (per agent, self-reported honestly; coordinator verifies)

* Server agents: `node --check` passes on your file; your routes are registered through
  `marketplaceRegister`; if you can, verify with a throwaway build (§5 rule) that your module
  concatenates cleanly.
* Client agents: `dotnet build src/VakilAI.Application -v q` and `src/VakilAI.Infrastructure` (plain net10.0,
  fast, no workloads) pass. MAUI app-project builds are authoritative at Agent 9 / the coordinator (Windows
  workload builds are slow and clash when concurrent). A UI agent MAY attempt one isolated build with
  `-p:BaseIntermediateOutputPath=obj_agentN\ -p:BaseOutputPath=bin_agentN\`; if it fails for infrastructure
  reasons, STOP and report it — do not fight the build system or "fix" shared files to make it pass.
* Never claim something works that you did not run. Report blockers with the exact error text.
