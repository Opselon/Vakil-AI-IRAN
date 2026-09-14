# Marketplace Integration Requests (append-only)

Cross-agent change requests. UI/feature agents MUST NOT edit `VAKIL_V1_SPEC.md`,
`MarketplaceContracts.cs`, `MarketplaceApiClient.cs`, `app_module_common.js` or the
router in `app_module_body.js` — those are coordinator-owned. Need a change there?
Append ONE numbered item inside your own section below and code against the shape
you asked for. The coordinator applies approved items and marks them `APPLIED:`.

Rules: append only, never rewrite someone else's section, one section per agent,
keep each item to 1–3 lines with the exact member name and type you need.

---

## Agent 1 — Authentication
(none yet)

## Agent 2 — Google Login
Server part `server/tools/parts/app_module_google.js` is DONE and executed against a real SQLite
D1 stub + a throwaway build of the full worker (43 local checks + 7 dispatcher checks, all pass).
No `MarketplaceContracts.cs` change needed: `/auth/google` answers the existing
`MarketplaceAuthResponse` shape byte-compatible with `/auth/login`. Asks below.

1. TO coordinator — CLEAN-UP (honest duplication): this file defines private
   `googleEnsureAccount` / `googleBuildUser` / `googleIssueSession` that overlap
   `authFindAccountByIdentifier`/`authBuildUser`/`authIssueSession` in Agent 1's file. Intentional:
   agents may not edit each other's parts. The clean consolidation is ONE shared helper in
   `app_module_common.js`, e.g. `marketplaceCreateAccount(env, {email,emailNorm,username,
   passwordHash,googleSub,displayName,role}) -> row` + `marketplaceIssueSession(env, account,
   deviceId) -> Response`; then both parts call it and the duplicates die. Nothing breaks until then.
2. TO Agent 9 / coordinator — DEPLOYMENT VAR (required before the Google button does anything):
   `GOOGLE_CLIENT_ID` (OAuth **Web** client id, public-by-protocol — `[vars]` in
   `server/wrangler.app.toml` or `wrangler secret put GOOGLE_CLIENT_ID`). Unset = `/auth/google`
   answers `CONFIG_PENDING` 400 and the rest of V1 is untouched. No client secret exists for
   this flow. Steps are written in the `═══ GOOGLE CONFIG ═══` block of my part file.
   CODE NAME NOTE: my task brief said `GOOGLE_CONFIG_PENDING`; spec §2.3/§4 and
   `Pages/AuthPage.xaml.cs:443` (`res.Code == "CONFIG_PENDING"`) say `CONFIG_PENDING`, so the worker
   answers `CONFIG_PENDING` — SSOT + the real consumer win over the brief. Nothing else renamed.
3. TO Agent 10 — client contract, already coded against: request
   `GoogleLoginRequest{credential, deviceId?}` (credential = raw ID token, untouched) →
   `MarketplaceAuthResponse`. Treat `CONFIG_PENDING` and `INVALID_CREDENTIAL` as
   "hide/disable the Google button, tell the user to sign in with email" — both are 400/401, so
   `MarketplaceApiClient` (retry:false on this verb) surfaces them as `Ok=false`+`Code`, not as a
   thrown `ENGINE_UNAVAILABLE`. `GOOGLE_UNAVAILABLE` (503, Google/tokeninfo unreachable) DOES throw
   `AppApiException("ENGINE_UNAVAILABLE")` client-side — catch it for a retry affordance.
   Your `vakil.google.client.id` Preferences override (your §3) is the right seam; the id must match
   the worker's `GOOGLE_CLIENT_ID` exactly, and the ID token's `aud` must be that same id.
4. TO Agent 1 — behaviour note, no action: a Google sign-in whose verified email equals an existing
   password account LINKS (writes `google_sub`) instead of creating a duplicate, and keeps role and
   `password_hash`, so `/auth/login` keeps working for that user; `authMethods` becomes
   `["password","google"]` automatically via `marketplaceAuthMethodsOf`. Conflict (same
   `email_norm` already bound to a DIFFERENT `google_sub`) is answered `INVALID_CREDENTIAL` — an
   admin-unlink tool is a follow-up, not V1.
5. NOTE (all consumers) — deliberately strict e-mail rule: `email_norm` (UNIQUE) is occupied ONLY
   for addresses Google vouched for (`email_verified=true`). `email_verified` absent still logs in
   (sub present) but creates a login-only account with `email_norm NULL`; `email_verified=false` is
   rejected outright. This prevents a self-claimed address from locking a real owner out of signup.
6. OPTIONAL LATER (not V1): `LawyerListResponse`-style pagination is not relevant here; the item I
   actually expect to be requested later is a `provider` field on the `user` DTO once a second
   OAuth provider is real — do NOT add it now, `authMethods` already covers google vs password.

Deferred in V1 (documented, not silent): JWKS signature verification (tokeninfo only today, swap-in
point is `googleVerifyIdToken`), email-based account recovery for google-only users, an
admin unlink/rebind tool, account deletion cascade for `google_sub`, and any real GitHub code
exchange (`/auth/oauth/exchange` is a shaped refusal: `NOT_CONFIGURED` for every provider).

## Agent 3 — Database / Schema
(none yet)

## Agent 4 — Lawyer Backend
(none yet)

## Agent 5 — Lawyer Marketplace UI
Code against these shapes now; the coordinator applies what is approved. My pages
(`Pages/LawyersPage.xaml(.cs)`, `Pages/LawyerProfilePage.xaml(.cs)`) compile against them.

1. `LawyerListItem.SpecialtyLabels` + `LawyerProfileResponse.SpecialtyLabels` (`string[]?`,
   camelCase, Persian display names parallel to `specialties` slugs; same for `LanguageLabels`).
   Today chips render raw slugs because the client has no slug→name map. Fallback accepted:
   expose `/lawyers/categories` nameFa+slug pairs as a cacheable lookup the pages can localize with.
2. `LawyerListResponse.HasMore` (`bool`) and/or `Offset`/`Limit` echo — the directory renders
   every row the server returns and shows the server `total`; paging needs one signal to say so.
3. `AppTheme.xaml` ADDITIVE styles `ChipSelected` / `ChipUnselected` (TargetType=Border,
   light/dark correct) so the selected-filter look is not hand-painted in two code-behinds.
   (I inline the resting/selected colors for now — no assumption made.)
4. Registration already done by Agent 10 (`MauiProgram.cs` lines 128–129 addTransient for both
   pages) — keep it, and keep `Navigate(MarketplaceRoute.LawyerProfile, long userId)` as the
   hand-off (both my pages implement `IMarketplaceRouteArgument`; the profile also accepts a
   slug string for future `/lawyer/<slug>` deep links, and the directory accepts an optional
   category-slug string argument). No contract change needed — just don't rename them.
5. `IMarketplaceCoordinator.StartConsultationAsync(long lawyerUserId, CancellationToken)` shape
   is relied on verbatim by the profile CTA: `null` = success (coordinator navigates away),
   non-null = Persian text shown as-is. Please keep that null-or-message contract.

## Agent 6 — Web Admin Dashboard
(none yet)

## Agent 7 — Consultation
Server part `server/tools/parts/app_module_consultations.js` is DONE and executed against a real
SQLite engine (78 assertions in a throwaway harness, incl. a run against Agent 8's CURRENT
`app_module_payments.js` end-to-end: create→pay→first-send→chat→complete, 15/15). Routes:
`/consultations/create|list|get|messages|send|complete`. `/pay` untouched (Agent 8). No contract
change needed — every response matches `MarketplaceContracts.cs` 1:1.

1. TO Agent 8 — the seam you can rely on (defined exactly once, here):
   `async consultationLoad(env, consultationId)` → row|null ·
   `consultationMembership(row, userId)` → `'client'|'lawyer'|null` (sync — safe to await) ·
   `async consultationTransition(env, consultationId, fromStatuses[], toStatus, extraCols)` →
   `{ok, row}` · `async consultationView(env, row, viewerUserId)` → DTO. Your current file already
   matches; I verified your `pay` path through it.
2. TO Agent 8 — `paymentCreatePending` is called by ME from `/create` with a NAMESPACED key
   (`"cons:<consultationId>:<clientKey>"`) because `payments.idempotency_key` is globally UNIQUE
   while a consultation create key is only unique per client; two clients can pick the same string
   and must never adopt each other's payment row. Keep treating the value as opaque. Also:
   `paymentProviderName` is awaited — an async implementation is expected and honoured.
3. TO coordinator — window semantics as implemented: Agent 8's pay sets `ends_at = pay_time +
   duration`; my first send transitions PAID→ACTIVE and re-anchors `ends_at = first_message +
   duration` (the clock starts when the conversation starts, and a paid window that elapsed before
   anyone spoke closes COMPLETED + `CONSULTATION_EXPIRED`, it is never silently extended). If the
   product wants "24h from payment regardless of use", that is a one-line change in
   `consultationHandleSend` — say the word.
4. TO Agent 9 — for `check_app_worker.cjs` REQUIRED (same pattern as Agent 6's item 1):
   `consultationHandleCreate`, `consultationHandleList`, `consultationHandleGet`,
   `consultationHandleMessages`, `consultationHandleSend`, `consultationHandleComplete` + the four
   seam names in item 1. My part self-bootstraps `consultations`/`consultation_messages` DDL
   identical to Agent 3's (no-op `CREATE TABLE IF NOT EXISTS`) — it must NOT be treated as schema
   drift; `server/schema.marketplace.sql` stays canonical.
5. TO Agent 10 — additive fields beyond the C# records (ignored by System.Text.Json, usable when
   the DTOs grow): create → `duplicated:bool`; get → `membership:'client'|'lawyer'`; complete →
   `alreadyClosed:bool` and both `consultation` + `consultations:[dto]` (your typed
   `ConsultationListResponse` reads the latter); messages → each row carries `mine:bool`.
   `unreadForMe` = messages after MY OWN last message (no read receipts in V1), so the list badge
   clears as soon as I reply.
6. NOTE — `idempotencyKey` omitted on create = every call creates a new consultation (NULL is
   unique-tolerant in SQLite). The MAUI port already always sends one; do not build a UI retry path
   that omits it.

## Agent 8 — Payment & Commission

1. TO COORDINATOR (`MarketplaceContracts.cs`): add to `ConsultationPayResponse` —
   `[JsonPropertyName("paymentId")] long? PaymentId`, `[JsonPropertyName("provider")] string? Provider`,
   `[JsonPropertyName("devModeNotice")] string? DevModeNotice`. The server already sends all three
   (devtest settlements ALWAYS carry devModeNotice); UI needs them to show the honest test label.
2. TO COORDINATOR (`MarketplaceContracts.cs`): add to `PaymentHistoryResponse` —
   `[JsonPropertyName("pendingPayoutToman")] long PendingPayoutToman` (lawyer only; V1 = accrued
   succeeded earnings, payout not modelled — server sends `payoutNotice` string too, add if wanted).
3. TO COORDINATOR (`app_module_schema.js` seed / admin config): payments resolves its PSP from
   `platform_config.payment_provider` (values = registered ids; V1 only `devtest`; unset/bogus →
   devtest). Please add `payment_provider` = `devtest` to the platform_config seed so admin's
   `/admin/config/set` has a visible row to edit, and mention it in DB.md.
4. TO COORDINATOR (deployment): operator-only env var `PAYMENT_ALLOW_TEST_MODE` — when set to
   `0`, `paymentCharge` refuses to let any `isTestMode` provider settle (fail-closed for the day a
   real PSP goes live). Nothing to code; needs a wrangler secret line in DB.md only.
5. TO AGENT 6 (admin): `POST /api/v1/payments/providers` → `{ok, providers:[{id,name,isTestMode,active}],
   current, devModeNotice}` — harmless registry listing, use it for the dashboard's PSP badge; and
   `/payments/history` with an admin token returns platform-wide `grossToman`/`commissionToman` totals.
6. TO AGENT 7: `consultationTransition` returning `{ok,row}` (not the bare row) is what
   `paymentHandlePay` consumes for the PAID write — if your final shape differs, keep `.row` present;
   a missing `.ok` is treated as success, a `ok:false` with status ≠ PAID returns honest
   code `PAYMENT_SETTLED_STATE_PENDING` (money settled, state write refused) instead of a fake PAID.
7. TO AGENT 10 (UI): `POST /api/v1/consultations/pay` can return `ok:true` with
   `paymentStatus:"pending"` ("در حال تأیید پرداخت") — poll `/consultations/get` or retry pay with
   the SAME idempotencyKey; never render that as PAID. `PAYMENT_FAILED` (`ok:false`) is retriable.

## Agent 9 — Build & QA
1. BUILD BREAK (Pages/LawyersPage.xaml.cs, Agent 5) — 3 mechanical compile errors, blocking the
   whole MAUI gate: `new LawyerListRequest(token: token, ...)` → parameter is `Token` (CS1739);
   `FadeToAsync(0.35, 720 + index * 140, ...)` int→uint (CS1503, x2 — use `(uint)(720 + index * 140)`);
   `tap.Tapped += async (sender, _) => { ... _ = UiMotion.PressPopAsync(v); }` assigns a Task to the
   lambda's `_` parameter (CS0029) — rename the param (e.g. `args`) so `_` is a real discard again.
2. APPLIED BY AGENT 9: /auth/google unconfigured code was `GOOGLE_CONFIG_PENDING`; spec §2.3 and
   Pages/AuthPage.xaml.cs:443 key off `CONFIG_PENDING` → app_module_google.js now emits
   `CONFIG_PENDING` (one-line code-string change only, no design change).

## Agent 10 — UX Integration
1. `Pages/ConsultationsPage` ('مشاوره‌های من' list) is NOT in my file set — Agent 5/coordinator owns it.
   `MarketplaceRoute.Consultations` is wired through the coordinator's soft-resolver and expects a
   paramless DI page named `Vakil_AI_IRAN.Pages.ConsultationsPage`; until then it shows "به‌زودی".
2. Consumed as spec'd, no contract change: `ConsultationMessagesAsync(token, id, afterId)` (id-ASC page +
   `consultation` DTO), `ConsultationCreateResponse.DevModeNotice` (shown verbatim on the pay card),
   `ConsultationPayResponse`. Client relies on them now — integrators can cite, not guess.
3. Google: `WebAuthenticator` + Preferences key `vakil.google.client.id`, callback const
   `AuthPage.GoogleCallback`. When Agent 2 fixes the redirect/decoder contract, that one const changes only.
4. Agent 5's pages DID exist at my edit time → `MauiProgram` registers `Pages.LawyersPage` +
   `Pages.LawyerProfilePage`. Keep those type names (a rename breaks the app build), and keep the root-
   namespace `Vakil_AI_IRAN.IMarketplaceRouteArgument` contract LawyerProfilePage already implements.
5. TO coordinator — optional follow-up registrations when those pages land: `MarketplaceRoute.Payments`
   resolves `Pages.PaymentsPage`, `Account` → `Pages.AccountPage`, `LawyerOffice` → `Pages.HostPage`
   (all by type name at runtime; a missing type degrades to the honest notice, no crash).

---

# Coordinator integration pass (03:15, after all 10 lanes)

APPLIED items:
- A1#1/#2 → `MarketplaceCapabilities` added to `MarketplaceAuthResponse` + `IMarketplaceApi.SetPasswordAsync`
  implemented (client); server already answered both shapes. A1#3 → documented in wrangler.app.toml + DB.md,
  `npm run secret:pepper` added.
- A2#1 → NOT applied as a refactor: consolidating google/auth duplicate helpers into common.js is a
  post-V1 cleanup (nothing breaks; both parts self-contained). Tracked under hardening phase.
- A4/A5#2 → `hasMore` computed server-side in lawyers/list + added to `LawyerListResponse`.
  A5#1 (SpecialtyLabels) deferred — chips show slugs; slug→name map ships with the categories cache in
  the polish phase. A5#3 (ChipSelected styles) skipped — pages inline colors, works everywhere.
- A6 (Agent 6 #6) → `AdminPendingLawyersAsync` retyped to `AdminLawyersResponse` (`lawyers[]`) — the
  previous `AdminUsersResponse` silently deserialized the queue to null. Fixed both sides.
- A7#4 → `check_app_worker.cjs` REQUIRED now pins all 53 marketplace entry points (128 symbols unique) —
  a dropped or duplicated part fails the build gate. A7#3 window semantics left as implemented
  (chat-start re-anchors `ends_at`; product can flip one line later).
- A8#1/#2 → paymentId/provider/devModeNotice + pendingPayoutToman/payoutNotice added to the C# records.
  A8#3 → `payment_provider='devtest'` seeded in BOTH DDL copies (schema part + schema.marketplace.sql).
  A8#4 → PAYMENT_ALLOW_TEST_MODE documented in wrangler.app.toml + DB.md config table.
- Gap filled by coordinator: `Pages/ConsultationsPage` (the route Agent 10 pre-wired but no lane owned) —
  both-directions hub, lifecycle chips, unread badges, apply-as-lawyer + sign-out, DI registered.

Final gate evidence (coordinator-run, post-integration): worker rebuild + `APP-WORKER INTEGRITY OK
(128 required symbols unique)` · `APP-WORKER RESULT: 14 passed, 0 failed` (legacy chain) ·
`MARKETPLACE WIRING OK` (5/5) · `MARKETPLACE SMOKE: 15 passed, 0 failed, 0 skipped` ·
Domain/Application/Infrastructure `0W/0E` · MAUI Windows app build `0 Warning(s) 0 Error(s)`.

## COORDINATOR — integration pass (post-audit wave, 07:0x)
Applied from lanes (items now LIVE in contracts/server): A1#1 capabilities (server returns, record has, client reads on switch) · A1#2 SetPasswordAsync (+AuthPage UI) · A2#2 CONFIG_PENDING (+docs) · A4 category-slug contract honored · A5#2 hasMore (+server emit, client LoadMore button; A5#1 solved client-side via SpecialtyNames cache — no new fields) · A6#6 AdminPendingLawyersAsync retyped to AdminLawyersResponse(lawyers[]) + dead Admin* client methods deleted (honest) · A7 seams unchanged, L1 made guard FORBIDDEN→404 uniform · A8#1–#4 all applied (paymentId/provider/devModeNotice/pendingPayoutToman/payoutNotice + payment_provider seed + PAYMENT_ALLOW_TEST_MODE docs).
Declined w/ reason: A2#1 google/auth helper consolidation (post-V1 refactor, no defect) · A8#5 admin-facing providers list auth-gate (content non-secret, L7 recorded) · full user-scoped ChatRow migration (identity-change reset closes the leak for V1; column migration is V2).
New in this pass beyond requests: /auth/logout (server revocation) · uq_pay_live unique index + heal-on-replay · v1_enabled kill-switch enforced · CAS settlement · marketplace rate-limit completion · seed throttle + schema_version stamp · CI drift check + node:sqlite gates (15/15 + redteam green on Linux runners) · 5 journey fixes (kick-loop, subscription leak, self-profile/verificationNote reachability, complete button, poll economy).

## Wave2-B — consultation cancel/refund (lane B)
1. BUILDER WIRING — DONE by lane B per lifted ownership grant: `app_module_consult_ops.js` appended to
   V1_ORDER in `server/tools/build_app_worker.cjs` after `app_module_payments.js` (the one line this lane
   was authorized to touch). Verified: build embeds the part, `npm run check` = INTEGRITY OK,
   `check:drift` = IN SYNC, `smoke:marketplace` 15/15, legacy `smoke` 14/14.
2. COORDINATOR — `server/tools/check_marketplace_drift.mjs` `MARKETPLACE_PARTS` must join
   `app_module_consult_ops.js` after `app_module_payments.js` (its list is currently missing it, so my
   part is NOT drift-checked; same for `app_module_payouts.js` in build order vs my insertion point —
   keep consult_ops BEFORE payouts as wired).
3. COORDINATOR — `server/tools/check_app_worker.cjs` REQUIRED: add
   `consultOpsHandleCancel`, `consultOpsHandleRefund`, `consultOpsClientGate`, `consultOpsProviderAllowsRefund`
   so a dropped part fails the integrity gate like the other lanes.
4. CONTRACT (.NET) — server now answers both routes as `ConsultationOpResponse`
   `{ok, consultation(dto), refundAmountToman, message}` (+ additive `code`):
   `CONSULTATION_CANCELLED` / `CONSULTATION_ALREADY_CANCELLED` / `CONSULTATION_REFUNDED` /
   `CONSULTATION_ALREADY_REFUNDED` / `REFUND_APPLIED_STATE_PENDING`; error codes
   `NOT_FOUND` 404 (uniform, non-participant too) · `FORBIDDEN` 403 · `CONSULTATION_CLOSED` 409 ·
   `CONSULTATION_STARTED` 409 (ACTIVE, «جلسه آغاز شده») · `CONSULTATION_NOT_PAID` 409 ·
   `PAYMENT_NOT_FOUND` 409 · `PROVIDER_NOT_REFUNDABLE` 502 · `RATE_LIMITED` 429 (10/min cancel, 5/min refund).
   Please add the record + `IMarketplaceApi.ConsultationCancelAsync/ConsultationRefundAsync` +
   `MarketplaceApiClient` methods (coordinator-owned files, spec §5).
5. NOTE — refund is deliberately devtest-only (both the configured provider AND the payments-row
   provenance must be 'devtest'); real-PSP reversal is a provider-capability extension point (this
   part's EXTEND header) and must keep refusing until such a provider registers.

## COORDINATOR — wave-2 integration pass 2
Lane outputs staged (sources): consult_ops + payouts parts; V1_ORDER now 11 entries; drift 11 slots;
integrity 139; smoke 18/18 (new steps 16 reviews / 17 cancel-refund / 18 payouts); redteam 84/0.
Coordinator fixes applied during integration:
- smoke step 17 originally asserted cancel-replay=409; lane-B shipped idempotent-OK (200 + code
  marker). Assert aligned to the SHIPPED contract — replay must stay 2xx for at-most-once on
  flaky networks.
- provider-guard arm rewritten to payments-row provenance (UPDATE provider='zarinpal'):
  admin config/set rejects unregistered provider ids with BAD_CONFIG_VALUE BY DESIGN (P28), so a
  config-flip arm contradicted the red-team proof. Row arm mirrors harness P09.
- contracts: ConsultationOpResponse/review records missing from 4fc7832 (it landed payouts only)
  -> added with the lanes' pinned key sets + 5 port methods + MarketplaceApiClient lines.
- gates: consultOps REQUIRED names corrected to the handlers lane B actually exports;
  drift checker + integrity already extended by lanes, verified not re-written.
- UI: cancel chip (unpaid client rows), refund chip (PAID client rows, chat header), one-shot
  review offer on COMPLETED (client), reviews section on lawyer profile. Win+Android 0W/0E.
- Dashboard payouts/reviews sections delegated (lane D) — lands as a follow-up commit.
