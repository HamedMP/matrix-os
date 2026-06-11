# Research: Unified Onboarding State Machine (092)

All decisions below are grounded in code verified on 2026-06-11 at `origin/main` (e337a1d30). File:line citations reference that revision.

## R1. Journey state: derived projection, not a stored state column

**Decision**: The journey phase is computed on read from existing sources of truth — Clerk identity, `billing_entitlements` (+ override/grace logic in `billing.ts`), `user_machines` status, plus two new records (`billing_checkout_attempts`, `onboarding_first_run`). No mutable `current_phase` column exists anywhere. A separate append-only `onboarding_journey_events` table records transitions for telemetry only (written when the computed phase differs from the last recorded event for that user).

**Rationale**: A stored phase column would be a second source of truth that can diverge from the tables that actually gate behavior (the exact bug class this feature kills). Derivation makes the journey endpoint a pure projection; the telemetry log is write-behind and non-authoritative, so divergence there is harmless. This matches the existing pattern: `getRuntimeAccessDecision()` already derives billing access on read (`packages/platform/src/main.ts:2547`).

**Alternatives considered**: (a) Stored state machine table with explicit transitions — rejected: dual-write divergence risk, needs backfill and repair tooling forever. (b) Computing in each client — rejected: that is the status quo causing the bugs.

**Phase derivation order** (first match wins):
1. No platform user row → `account_required` (only reachable pre-sync; surfaces normally never see it)
2. Entitlement not active/trialing/grace AND no recent open checkout attempt → `plan_required`
3. Entitlement not yet active AND open checkout attempt younger than settling window → `payment_settling`
4. Entitled, no live machine (or only retired/failed-retired rows) → `provisioning` is *not* auto-entered; phase is `provisioning_required` internally but the journey response collapses it into `provisioning` with `nextAction: start` — the shell/CLI triggers `retry-provision`/`provision-runtime`. (Matches current eager-after-entitlement behavior where BillingGate calls `POST /api/auth/provision-runtime`, `shell/src/components/BillingGate.tsx:353`.)
5. Live machine in `provisioning`/`recovering` → `provisioning` with stage detail
6. Live machine in `failed` → `provisioning_failed` with attempt count + retryable flag
7. Machine `running`, no first-run completion record → `first_run`
8. Otherwise → `ready`, with `readiness` annotation (R8)

## R2. Stuck provisioning: close the two reconciliation gaps, stop failed rows from blocking

**Verified current behavior**:
- A reconciler exists: `reconcileProvisioning()` (`packages/platform/src/customer-vps.ts:858-902`), interval-driven from `main.ts:4145-4173` (60 s default), stale-after 10 min (`customer-vps-config.ts:69`).
- **Gap 1**: for a stale machine whose Hetzner server *exists but never registered* (cloud-init failure, registration token expired after 15 min — `customer-vps-config.ts:67`), the reconciler only refreshes IP metadata; the row stays `provisioning` forever.
- **Gap 2**: the provision path returns early if *any* non-deleted machine exists (`getActiveUserMachineByClerkId`, early-return at `customer-vps.ts:494-496`), and the unique indexes are `WHERE deleted_at IS NULL` (`db.ts:593-605`) — so a `failed` machine **permanently blocks** a new attempt. There is no self-service retry.

**Decision**:
1. Reconciler marks a machine `failed` when it is in `provisioning`/`recovering` and its `registration_token_expires_at` has passed (covers booted-but-never-registered), in addition to the existing no-server/server-gone cases. Failure reason codes distinguish `registration_timeout`, `provider_unavailable`, `not_found`.
2. Provision/retry treats only `provisioning|recovering|running` as blocking. A `failed` row is retired (soft-deleted with `deleted_at`, status preserved) **inside the same transaction** that inserts the new attempt, keeping the partial unique index satisfied at every instant.
3. `user_machines` gains `attempt` (int, per user counter) and `failure_code`; auto-retry is bounded (default 3) — beyond that, journey reports `provisioning_failed` with `retryable: false` and a support action (FR-008).
4. Failed/retired machines with a `hetzner_server_id` are reaped via the existing `queueProviderDeletion()` path (`customer-vps.ts:751-764`) — FR-011 reuses it, no new mechanism.

**Alternatives considered**: client-side timeout + manual support deletion (status quo) — rejected, loses paying users; hard-deleting failed rows — rejected, destroys audit/telemetry trail.

## R3. Payment settling: server-side checkout-attempt record

**Verified current behavior**: The shell handles `?checkout=success` with a sessionStorage "recent attempt" marker (30 min, `BillingGate.tsx:45-58`) and shows `SubscriptionConfirmationPending` while polling `app-session` 60× at 8 s (8 min hard stop → "failed", `BillingGate.tsx:18-19,308`). The webhook itself is idempotent (`INSERT ... ON CONFLICT DO NOTHING`, `db.ts:1632`) and grace periods exist (`billing.ts:1`). The race is real but the mitigation is client-local: a second device, a cleared session, or the 8-minute stop re-shows the paywall.

**Decision**: Record a `billing_checkout_attempts` row when `/billing/checkout` creates a Stripe session (`billing-routes.ts:102-141`): `clerk_user_id`, `stripe_session_id`, `created_at`, `status (open|completed|expired|abandoned)`. The webhook marks it `completed`; `checkout.session.expired` (already received via the same webhook endpoint) marks it `expired`. Journey derivation reports `payment_settling` while an `open` attempt is younger than the settling window (default 10 min, env-tunable) and entitlement is not yet active; past the window it becomes `plan_required` with `detail: confirmation_delayed` and a support action (FR-014). Settling is therefore device-independent and survives reloads; sessionStorage logic is deleted.

**Alternatives considered**: synchronous Stripe API poll from the journey endpoint — rejected (external call on hot path, violates the p95 target and adds a provider dependency to every shell load); trusting `?checkout=success` query param — rejected (client-forgeable, already half-broken).

## R4. First-run completion: server-owned record fed by the gateway

**Verified current behavior**: completion is only `~/system/onboarding-complete.json` on the user's VPS, written by gateway `ws-handler.ts:73-81` or `routes/settings.ts:344-361`; shell checks it via `/api/settings/onboarding-status` (`Desktop.tsx:625`). It does not survive machine replacement and is invisible to platform, CLI, and mobile. **No Postgres mirror exists.**

**Decision**: New platform table `onboarding_first_run` (`clerk_user_id` PK, `completed_at`, `goal`, `steps` JSONB, `source`). The gateway posts to `POST /internal/first-run` (authenticated with the existing `UPGRADE_TOKEN` + `MATRIX_HANDLE` internal scheme, constant-time compare) whenever it writes the completion file. The local file keeps being written (owner-inspectable artifact, constitution I) but becomes derived. **Lazy backfill** for existing users: when journey derivation finds a `running` machine and no record, it queries the user's gateway `onboarding-status` once through the existing proxy path with a short timeout; a positive answer is persisted, a timeout/negative leaves phase `first_run` (safe: the boot sequence's first-run step shows a "skip — already set up" affordance so a false `first_run` is a one-click exit, never a trap).

**Alternatives considered**: platform reads the VPS file on demand every time — rejected (per-request cross-VPS call, fails when machine is down, no cross-device consistency before machine exists); migrating completion entirely off the VPS — rejected (violates owner-inspectable identity-as-files).

## R5. Transport for near-real-time phase updates: polling now, SSE later

**Decision**: Surfaces poll `GET /api/journey` at 2–5 s during active phases (settling, provisioning) and stop polling at `ready`/`plan_required`. No client-side maximum-poll death: polling continues while the tab is open because the server now owns timeouts (settling window, provisioning stale-after) and will move the phase itself.

**Rationale**: The platform already serves polled session/billing checks at this cadence; provisioning lasts minutes, so push saves nothing material. SSE/WebSocket adds an auth + proxy + reconnect surface for marginal gain — explicitly deferred, the response shape (`phase`, `detail`, `nextAction`, `progress`) is transport-agnostic so SSE can be added without breaking clients.

## R6. Canonical origin authority and returnPath allowlist

**Verified current behavior**: ~26 hardcoded origin literals in platform flow files (worst: `request-routing.ts` ×8, `auth-routes.ts` ×5, `ws-upgrade.ts` ×4, `session-cookies.ts`, `billing-routes.ts`), ~71 in www, 0 in shell (env fallback constant `MATRIX_BILLING_DEFAULT_APP_URL`, `shell/src/lib/billing.ts:10`). Checkout `returnPath` flows into the Stripe success URL without allowlist validation.

**Decision**: One platform module `origins.ts` exposing `appOrigin()`, `apiOrigin()`, `wwwOrigin()` (env-driven: `MATRIX_APP_ORIGIN` etc., with current production values as documented defaults) and `resolveReturnPath(path)` (allowlist of path prefixes: `/`, `/sign-in`, `/vm/`, `/runtime`; everything else → `/`). All platform flow-code literals route through it. www gets a single `lib/origins.ts` reading `NEXT_PUBLIC_APP_ORIGIN`; marketing copy/JSON-LD literals (solutions data etc.) are out of scope — only auth/billing/session *flow* code counts (that's where the bugs are; the spec's FR-022 says "flow code").

**Alternatives considered**: shared workspace package — rejected (one function, two runtimes; package overhead unjustified); request-header derivation (`x-forwarded-host`) — rejected by constitution VIII (never trust user-controlled headers for security decisions).

## R7. www auth pages become redirects; Clerk sign-in stays in shell

**Verified current behavior**: www hosts Clerk `SignUp` at `/signup` and `SignIn` at `/login` (fallback → `/dashboard`, which is itself a hardcoded redirect to app); shell hosts its own Clerk pages at `/sign-in` and `/sign-up`; `/early-access` is a Tally form with no CTA into the product. Clerk session cookie spans `.matrix-os.com`, so either host's sign-in works for the other.

**Decision**: `/signup` → 308 to `{app}/sign-up`, `/login` → 308 to `{app}/sign-in`, `/dashboard` → 308 to `{app}/`, `/early-access` → 308 to `/` (waitlist era is over; paid beta self-serves). Implemented as Next.js `redirects()` in `www/next.config.ts` using the origins module — pages and their Clerk dependencies are deleted from www. The Inngest `clerk/user.created` sync (`www/src/inngest/provision-user.ts`) is unaffected (server-side, not page-coupled).

**Alternatives considered**: keeping www auth pages as thin Clerk wrappers — rejected: two Clerk appearance configs and two post-auth redirect behaviors are exactly the duplicated-surface bug source; moving sign-in to www instead — rejected: the app is where session → journey → boot sequence continues; an extra cross-origin hop adds failure modes.

## R8. Readiness: real checks for launch-critical gates only

**Verified current behavior**: `readiness-service.ts` defines 16 gates (`BASE_GATES`, lines 84-101); `hermes.continuity` is hardcoded `pass`; coding-setup gates derive from real `CodingSetupStatus`; the rest stay `unknown` (TODO at line 297).

**Decision**: Implement live verification for the launch-critical set: `workspace.provisioned` (machine running + gateway health), `shell.routing` (shell HTTP probe), `canvas.ready` + `terminal.ready` (existing service probes), `skills.ready` (skills dir load), `hermes.continuity` (actual kernel liveness ping replacing the hardcoded pass), `entitlement.ready` (platform journey/billing flag passed down). Non-launch-critical gates (`visual.qa`, `company_brain.ready`, `support_growth.ready`, `admin_control.ready`) remain `unknown` but are labeled `scope: post-launch` in the response so the UI can segregate them honestly (FR-024's "no perpetual unknown for implemented subsystems" — these subsystems are explicitly not implemented). Readiness aggregates into the journey `ready` phase as `readiness: ok | degraded` (FR-025); it never regresses the phase.

## R9. CLI: journey-aware login + `matrix setup`

**Verified current behavior**: device flow (RFC 8628) works end-to-end (`packages/sync-client/src/cli/oauth.ts`); after login, `GET /api/me` 404 → CLI deletes the just-stored token, prints "Sign up at https://app.matrix-os.com first", exits 1 (`commands/login.ts:170-202`). PostHog already emits `cli_runtime_lookup_missing`.

**Decision**: On 404, the CLI calls `GET /api/journey` with the still-valid token (token is **kept**, not deleted — deleting it is what makes the dead-end dead). Rendering: `plan_required` → print the exact checkout continuation URL (from journey `nextAction`); `provisioning`/`provisioning_failed` → offer `matrix setup` which POSTs `retry-provision` and polls journey, streaming stage transitions to the terminal; `first_run` → print the shell URL; `ready` → proceed as today. New `setup` subcommand registered in `cli/index.ts`. Spec 067's full in-terminal signup (email verification, Turnstile) stays out of scope — journey-aware handoff covers FR-026 without rebuilding signup in the terminal.

## R10. Mobile: journey gate before gateway connection

**Verified current behavior**: `apps/mobile` connects Clerk-authenticated users straight to the hardcoded hosted gateway (`lib/storage.ts:4`); a user without a running machine gets a generic `ConnectionBanner` error. No billing/provisioning UI exists.

**Decision**: A `JourneyGate` (expo-router screen/layout guard) fetches `/api/journey` with the Clerk token after sign-in and before constructing `GatewayClient`. `plan_required` → screen with "Continue in browser" (`Linking.openURL` to the checkout/plan page; in-app purchase is explicitly out of scope — Stripe web checkout via browser, consistent with App Store external-purchase rules for this category); `payment_settling`/`provisioning` → progress screen polling journey; `provisioning_failed` → retry button hitting `retry-provision`; `first_run` → prompt to finish setup on web or proceed with degraded note; `ready` → existing flow unchanged.

## R11. Boot sequence: one shell flow, OnboardingScreen absorbed

**Decision**: `BootSequence.tsx` replaces `BillingGate` as the top-level gate in the shell layout. It renders per journey phase: plan selection (existing `BillingPanel` content) → settling → machine build (stage progress from journey `progress`) → first-run (existing `OnboardingScreen`, gaining a goal-selection step per spec 082; voice mode and manual mode both preserved; `api_key` stage already skippable per `ws-handler.ts` stages, so FR-020 is a UX ordering change plus spec annotations, not a protocol rewrite) → fade into Desktop/Canvas. `ready` users render children immediately (FR-019). Resumability is free: phase comes from the server on every load (FR-018, US4 scenario 5). `Desktop.tsx` drops its independent `/api/settings/onboarding-status` check in favor of the journey phase passed down — one fewer parallel gate.

## R12. Concurrency: converging simultaneous setup attempts

**Decision**: `retry-provision`/`provision-runtime` keep the existing early-return-on-existing-machine behavior (`customer-vps.ts:494-496`) — with R2's fix it returns the *in-flight* attempt rather than a zombie, which is exactly FR-028's "second surface observes". The retire-and-insert transaction takes `SELECT ... FOR UPDATE` on the user's machine rows so two concurrent retries serialize and the loser sees the winner's row (mandatory-pattern: optimistic concurrency enforced in the write statement).

## R13. Telemetry

**Decision**: `onboarding_journey_events` (user, from_phase, to_phase, at, detail) written by the journey module on observed transitions; platform emits PostHog events `journey_phase_entered` with phase + elapsed-in-previous-phase, joining the existing funnel events (`provision_requested/completed/failed`, `cli_*` family). SC-001/SC-009/SC-010 are measured from this table + PostHog.
