# Tasks: Unified Onboarding State Machine and Signup-to-Ready Experience

**Input**: Design documents from `/specs/092-onboarding-unification/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/journey-api.md, quickstart.md

**Tests**: TDD is mandatory (constitution IX). In every phase, the test tasks come first and MUST be written and failing before the implementation tasks in that phase begin.

**Organization**: Tasks are grouped by the delivery phases A–F from plan.md. Each phase is an independently shippable Graphite stacked PR (see Stack Plan at the bottom); reliability (A) ships before everything else. Story labels map to spec.md user stories.

**Paths**: absolute repo-relative paths from the worktree root.

---

## Phase A: Provisioning & Billing Reliability (US2, US3 — backend) — PR 1

**Goal**: No user can get permanently stuck. Stuck `provisioning` rows fail automatically, `failed` rows stop blocking retries, machine replacement is atomic, and stale registrations are rejected.

> **Phasing refinement (decided during implementation)**: the `billing_checkout_attempts` record (T005, T014, T015) moves to **Phase B**, where the journey's `payment_settling` derivation consumes it — producer and consumer ship in one cohesive PR. PR 1 is provisioning-reliability-only. `recover()` was verified already atomic (single row mutated in place inside `runInPlatformTransaction`), so T013 reduces to a regression test (no two-row window) rather than a rewrite. `failure_code`/`failure_at` already exist on `user_machines`; only `attempt` is a new column.

**Independent test**: quickstart.md "Verify the reliability fixes" — force a stale provisioning row, watch the reconciler fail it within one interval; retry succeeds with exactly one live row; complete a Stripe test checkout with the webhook paused and confirm the attempt row records and later resolves.

### Tests first (write these, confirm they fail)

- [ ] T001 [P] [US2] Write failing tests for reconciler marking `provisioning`/`recovering` machines `failed` with `failure_code='registration_timeout'` once `registration_token_expires_at` has passed (server still exists in Hetzner mock) in `tests/platform/customer-vps-reconcile.test.ts`
- [ ] T002 [P] [US2] Write failing tests for provision/retry with a `failed` row present: row is retired (`deleted_at` set, status preserved) and a new attempt inserted in ONE transaction with `attempt` incremented; concurrent double-retry serializes via row lock and the loser observes the winner's attempt (FR-028/R12) in `tests/platform/customer-vps-retry.test.ts`
- [ ] T003 [P] [US2] Write failing tests for `/vps/register` returning 410 `attempt_retired` when the registration token belongs to a retired/replaced row, and for expired tokens not resurrecting failed rows (FR-010) in `tests/platform/customer-vps-register.test.ts`
- [ ] T004 [P] [US2] Write failing tests for `recover()` retiring the old machine row and activating the replacement in one transaction — assert no intermediate read can observe two non-deleted routable rows for the user (FR-009) in `tests/platform/customer-vps-recover.test.ts`
- [ ] T005 [P] [US3] Write failing tests for `billing_checkout_attempts`: `/billing/checkout` inserts an `open` row with the Stripe session id; `checkout.session.completed` webhook marks it `paid`; `checkout.session.expired` marks it `expired`; still-`open` rows >30 days are swept to `abandoned` by the reconciler pass in `tests/platform/billing-settling.test.ts`
- [ ] T006 [P] [US2] Write failing tests for bounded retries: `attempt` > cap (default 3, env `CUSTOMER_VPS_MAX_ATTEMPTS`) makes retry return 409 `retry_exhausted` in `tests/platform/customer-vps-retry.test.ts`

### Implementation

- [ ] T007 [US2] Add the one new column `attempt` (int NOT NULL DEFAULT 1) to `user_machines` as an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `migrate()` in `packages/platform/src/db.ts`. `failure_code`/`failure_at` already exist (Phase A reuses them); there is no `provisioning_stage` column (journey derives the stage from observable columns). `billing_checkout_attempts` is created in **Phase B**, not here (see the phasing-refinement note).
- [ ] T008 [US2] Add Kysely query helpers: `retireFailedMachineAndInsertAttempt` (single transaction, `SELECT ... FOR UPDATE` on the user's machine rows), `listRegistrationExpiredMachines`, checkout-attempt insert/resolve/sweep helpers in `packages/platform/src/db.ts`
- [ ] T009 [US2] Extend `reconcileProvisioning()` to fail machines whose registration token has expired (reason `registration_timeout`) in addition to existing no-server/server-gone cases; log every correction with machine id + reason (FR-030) in `packages/platform/src/customer-vps.ts`
- [ ] T010 [US2] Change provision blocking semantics: only `provisioning|recovering|running` block; a latest `failed` row routes through `retireFailedMachineAndInsertAttempt`; copy+increment `attempt`; enforce attempt cap; queue provider deletion for the retired row's `hetzner_server_id` (FR-007/008/011) in `packages/platform/src/customer-vps.ts`
- [ ] T011 [US2] (Superseded — no schema change.) The journey `progress.stage` is derived at read time from observable `user_machines` columns: `creating_server` (no `hetzner_server_id`), `booting` (server id, no `public_ipv4`), `registering` (has `public_ipv4`), `finalizing` (`recovering`). Implemented in `deriveJourneyPhase()` (Phase B), so no provisioning-stage column or lifecycle writes are needed in Phase A.
- [ ] T012 [US2] Reject stale registrations: `/vps/register` returns 410 `attempt_retired` for retired/replaced/expired attempts in `packages/platform/src/customer-vps-routes.ts` and the register flow in `packages/platform/src/customer-vps.ts`
- [ ] T013 [US2] Make `recover()` retire-old + activate-new atomic: move the old-row retirement into the same `runInPlatformTransaction` block that activates the replacement; provider deletion stays queued outside the transaction in `packages/platform/src/customer-vps.ts`
- [ ] T014 [US3] Record checkout attempts in `POST /billing/checkout` (status `open`, same request that creates the Stripe session) and resolve them in the Stripe webhook handler by subscribing to `checkout.session.completed` (→ `paid`) and `checkout.session.expired` (→ `expired`) in `packages/platform/src/billing-routes.ts`
- [ ] T015 [US3] Add checkout-attempt sweep (>30 days → `abandoned`) and journey-event sweep stub to the existing reconciler interval in `packages/platform/src/main.ts`
- [ ] T016 Run `bun run typecheck && bun run check:patterns && bun run test` and fix all findings for Phase A files

**Checkpoint A**: stuck users self-heal; retries work; checkout attempts are recorded. No UI change yet — shippable alone.

---

## Phase B: Journey Core (US1) — PR 2

**Goal**: `GET /api/journey` returns the correct phase for every user state; first-run completion becomes server-owned; phase transitions are recorded for telemetry. All surfaces CAN now render from one source (they switch over in later phases).

**Independent test**: spec.md US1 independent test — place a test user in each of the seven phases (quickstart.md table) and assert endpoint output matches; verify both Clerk-cookie and sync-JWT bearer auth paths.

### Tests first

- [ ] T017 [P] [US1] Write failing unit tests for `deriveJourneyPhase()` covering all derivation branches from research.md R1: plan_required (no attempt / expired / abandoned), payment_settling for an `open` attempt within window, payment_settling for a `paid` attempt with `settling.delayed=false` within window and `delayed=true` past window (a `paid` attempt NEVER becomes plan_required), an `open` attempt aged past the window falling back to plan_required (abandoned checkout — must NOT stay in settling), a lapsed entitlement (`canceled`) WITH a stale `paid` attempt still routing to plan_required (churned-subscriber must NOT be trapped in settling), provisioning (live machine + stage), provisioning_failed (retryable true/false by attempt cap), first_run (running + no record), ready (+readiness annotation passthrough), entitlement-loss regression to plan_required mid-journey in `tests/platform/journey.test.ts`
- [ ] T018 [P] [US1] Write failing route tests for `GET /api/journey`: 200 contract shape per contracts/journey-api.md for each phase; 401 unauthenticated; 503 `journey_unavailable` on DB failure (no phase guessing); `Cache-Control: no-store`; **explicit case: sync-JWT bearer auth (macOS native / CLI token) returns the identical contract as Clerk-cookie auth — this is the integration point the upcoming macOS PR consumes (observe-only here)** in `tests/platform/journey-routes.test.ts`
- [ ] T019 [P] [US1] Write failing tests for `POST /api/journey/retry-provision`: converges on in-flight attempt (`in_progress`), starts retry on failed (`started`), 402 without entitlement, 409 past cap, 429 rate limit, bodyLimit + Zod rejection in `tests/platform/journey-routes.test.ts`
- [ ] T020 [P] [US1] Write failing tests for `POST /internal/first-run`: UPGRADE_TOKEN constant-time auth (401 on bad token), Zod payload validation (422), idempotent upsert, handle/user mismatch → 422 generic in `tests/platform/journey-first-run.test.ts`
- [ ] T021 [P] [US1] Write failing tests for journey-event telemetry: event appended only when computed phase differs from latest event; write failure logs but never fails the read in `tests/platform/journey.test.ts`
- [ ] T022 [P] [US1] Write failing gateway tests: onboarding completion (WS `done` stage and `POST /api/settings/onboarding-complete`) posts to platform `/internal/first-run` with `AbortSignal.timeout(10_000)`, logs (not throws) on platform unavailability, still writes the local file in `tests/gateway/onboarding/ws-handler.test.ts` and `tests/gateway/settings-desktop.test.ts`

### Implementation

- [ ] T023 [US1] Create tables `onboarding_first_run` and `onboarding_journey_events` per data-model.md in `migrate()` in `packages/platform/src/db.ts`, plus query helpers (upsert first-run, latest-event read, append event, 180-day sweep)
- [ ] T024 [US1] Implement `deriveJourneyPhase()` + `recordJourneyTransition()` in new `packages/platform/src/journey.ts`, consuming `getRuntimeAccessDecision` (billing), checkout attempts, `user_machines`, `onboarding_first_run`; settling window env `BILLING_SETTLING_WINDOW_MS` default 600000. Gate `payment_settling` on a pre-activation entitlement (absent or `incomplete`); a lapsed entitlement (`canceled`/`ended`/`unpaid`/past grace) must route to `plan_required` even when a stale `paid` attempt exists (no churned-subscriber trap — R1/R3)
- [ ] T025 [US1] Implement `GET /api/journey` and `POST /api/journey/retry-provision` in new `packages/platform/src/journey-routes.ts` (dual auth resolution copied from the existing `/api/me` pattern in `packages/platform/src/auth-routes.ts`; per-user rate limit with capped LRU map; `bodyLimit`; generic errors only) and mount in `packages/platform/src/main.ts`
- [ ] T026 [US1] Implement `POST /internal/first-run` (UPGRADE_TOKEN + `x-matrix-handle`, `timingSafeEqual`, Zod schema, 16 KB bodyLimit, upsert) in `packages/platform/src/journey-routes.ts`
- [ ] T027 [US1] Implement legacy first-run backfill **off the hot read path** (R4): `deriveJourneyPhase()` does NO network call (running + no record ⇒ `first_run`, exited via the boot sequence "skip — already set up" affordance). Add a bounded backfill pass to the existing reconciler `setInterval` in `packages/platform/src/main.ts` that lists `running` machines lacking an `onboarding_first_run` record, probes each machine's gateway `onboarding-status` through the existing proxy with `AbortSignal.timeout`, and persists positives with `source='backfill'` using `ON CONFLICT (clerk_user_id) DO NOTHING` (never overwrite an authoritative gateway record — the write-behind path uses `DO UPDATE`); unreachable machines retry on a later pass. Keeps `GET /api/journey` within the p95 < 150 ms budget.
- [ ] T028 [US1] Gateway reports first-run: after writing `onboarding-complete.json`, POST to `${PLATFORM_INTERNAL_URL}/internal/first-run` (timeout, typed error logging, never blocks the user) from `packages/gateway/src/onboarding/ws-handler.ts` and `packages/gateway/src/routes/settings.ts`
- [ ] T029 [US1] Emit PostHog `journey_phase_entered` (phase, previous phase, ms-in-previous-phase) alongside event writes in `packages/platform/src/journey.ts`, reusing the platform's existing PostHog client
- [ ] T030 [US1] Wire `onboarding_journey_events` 180-day sweep into the reconciler interval in `packages/platform/src/main.ts` (replaces T015 stub)
- [ ] T031 Run `bun run typecheck && bun run check:patterns && bun run test` and fix all findings for Phase B files

**Checkpoint B**: `curl /api/journey` is correct for every user state via both auth schemes. The upcoming macOS PR can consume the endpoint as-is with its existing keychain sync JWT — no macOS code changes in this feature.

---

## Phase C: Shell Boot Sequence + Honest Readiness (US4, US7) — PR 3

**Goal**: One continuous boot-sequence flow in the shell driven by `/api/journey`; BillingGate retired; first-run gains the spec-082 goal step; launch-critical readiness checks become real.

**Independent test**: spec.md US4 independent test — new account walks sign-in → plan → pay → live build progress → first-run → desktop inside one flow; ready users bypass entirely; mid-flow tab close resumes at the same phase.

### Tests first

- [ ] T032 [P] [US4] Write failing tests for `useJourney` hook: polls 2–5 s only in `payment_settling`/`provisioning`, stops in terminal phases, no client-side max-poll death, surfaces 503 as `unreachable` state in `tests/shell/use-journey.test.tsx`
- [ ] T033 [P] [US4] Write failing tests for `BootSequence`: renders plan panel on `plan_required`, settling screen (never the paywall) on `payment_settling` incl. `delayed` escalation, stage progress on `provisioning`, retry CTA on `provisioning_failed` (support affordance when `retryable:false`), OnboardingScreen on `first_run`, children immediately on `ready` (FR-019) in `tests/shell/boot-sequence.test.tsx` (port surviving cases from `tests/shell/billing-gate.test.tsx`, then delete that file)
- [ ] T034 [P] [US7] Write failing tests for real readiness checks: each launch-critical gate (`workspace.provisioned`, `shell.routing`, `canvas.ready`, `terminal.ready`, `skills.ready`, `hermes.continuity`, `entitlement.ready`) passes on a healthy stack and fails with an actionable message when its subsystem is broken; `hermes.continuity` is no longer hardcoded; post-launch gates carry `scope: post-launch` in `tests/gateway/onboarding-activation.test.ts`
- [ ] T035 [P] [US4] Write failing gateway test for the new `goal` onboarding stage (greeting → goal → interview …), goal persisted into the first-run report payload, in `tests/gateway/onboarding/ws-handler.test.ts`

### Implementation

- [ ] T036 [US4] Implement `useJourney()` polling hook in new `shell/src/hooks/useJourney.ts` (fetch `/api/journey` through the shell proxy, `AbortSignal.timeout(10_000)`, capped error-string allowlist per CLAUDE.md client-store rule)
- [ ] T037 [US4] Implement `BootSequence` in new `shell/src/components/BootSequence.tsx`: phase-keyed renderer reusing `BillingPanel` content for plans, new settling and machine-build views (stage progress + spec-082 visual direction: stone/sage/forest palette, reduced-motion fallbacks), `OnboardingScreen` for first-run, fade-through to children on `ready`
- [ ] T038 [US4] Replace `BillingGate` with `BootSequence` at its mount point (shell layout / `shell/src/app/providers.tsx` or equivalent), delete `shell/src/components/BillingGate.tsx`, and remove the sessionStorage checkout-attempt logic (server-side settling supersedes it)
- [ ] T039 [US4] Update `shell/src/components/Desktop.tsx` to receive first-run state from the journey phase instead of fetching `/api/settings/onboarding-status` (keep the legacy fetch only as a transition fallback when journey is `unreachable`)
- [ ] T040 [US4] Add the goal-selection step (coding / company brain / assistant) to `shell/src/components/OnboardingScreen.tsx` ahead of voice/manual choice, including a "skip — already set up" affordance for backfill false-positives (R4), and add the `goal` stage to `packages/gateway/src/onboarding/ws-handler.ts` stage machine
- [ ] T041 [US7] Implement the live launch-critical readiness checks (HTTP/service probes with timeouts; hermes liveness ping; entitlement flag passthrough) replacing hardcoded values in `packages/gateway/src/onboarding/readiness-service.ts`; expose aggregate for the journey `readiness` annotation
- [ ] T042 [US4] Update `tests/e2e/onboarding-activation.spec.ts` (and visual spec) to walk the unified boot sequence end-to-end
- [ ] T043 Run `npx react-doctor@latest shell` and resolve findings, then `bun run typecheck && bun run check:patterns && bun run test` for Phase C files

**Checkpoint C**: the shell journey is one designed flow; readiness is honest.

---

## Phase D: Page Consolidation + Origin Integrity (US5, US6) — PR 4

**Goal**: One auth door; legacy pages redirect; all auth/billing/session flow code resolves origins through one authority; return paths are allowlisted.

**Independent test**: spec.md US5/US6 independent tests — crawl www CTAs and retired URLs (all land on the app auth door, zero 404s); run flows in a staging-config environment (no production-origin leaks); tampered returnPath falls back to `/`.

### Tests first

- [ ] T044 [P] [US6] Write failing tests for `origins.ts`: env-driven `appOrigin()/apiOrigin()/wwwOrigin()` with documented defaults; `resolveReturnPath()` allowlist (`/`, `/sign-in`, `/vm/`, `/runtime`) rejecting absolute URLs, `//host`, traversal, and off-list paths → `/` in `tests/platform/origins.test.ts`
- [ ] T045 [P] [US6] Write failing tests asserting checkout `returnPath` is validated before embedding in Stripe success/cancel URLs (tampered value → default) in `tests/platform/billing-settling.test.ts`
- [ ] T046 [P] [US5] Write failing tests for www redirects: `/signup`→`{app}/sign-up`, `/login`→`{app}/sign-in`, `/dashboard`→`{app}/`, `/early-access`→`/` (308s) in `tests/www/redirects.test.ts` (create the suite if www has none; otherwise verify via `next.config.ts` unit test of the `redirects()` export)

### Implementation

- [ ] T047 [US6] Implement `packages/platform/src/origins.ts` (`MATRIX_APP_ORIGIN`/`MATRIX_API_ORIGIN`/`MATRIX_WWW_ORIGIN` envs, production defaults, `resolveReturnPath`)
- [ ] T048 [US6] Replace hardcoded origin literals with `origins.ts` calls in `packages/platform/src/request-routing.ts`, `packages/platform/src/auth-routes.ts`, `packages/platform/src/ws-upgrade.ts`, `packages/platform/src/session-cookies.ts`, `packages/platform/src/billing-routes.ts` (the 5 flow files; verify none remain with `grep -rn "app\.matrix-os\.com\|api\.matrix-os\.com" packages/platform/src --include='*.ts'` modulo origins.ts defaults)
- [ ] T049 [US6] Apply `resolveReturnPath` to checkout returnPath in `packages/platform/src/billing-routes.ts` and to the device-approval redirect target in `packages/platform/src/auth-routes.ts`
- [ ] T050 [US5] Add the four permanent redirects to `redirects()` in `www/next.config.ts` using a www-side `www/src/lib/origins.ts` (reads `NEXT_PUBLIC_APP_ORIGIN`), then delete `www/src/app/signup/`, `www/src/app/login/`, `www/src/app/dashboard/`, `www/src/app/early-access/` and now-unused Clerk page imports
- [ ] T051 [US5] Sweep www CTAs to the single auth door via the origins helper: update `www/src/app/technical/page.tsx` `/signup` link, `www/src/components/landing/LandingBilling.tsx` hardcoded app links, `www/src/app/solutions/data.ts` flow links (marketing JSON-LD copy stays out of scope per R6)
- [ ] T052 [US6] Update shell billing fallback to read the same env name (`NEXT_PUBLIC_APP_ORIGIN`, fallback retained) in `shell/src/lib/billing.ts`
- [ ] T053 Run `bun run typecheck && bun run check:patterns && bun run test` (+ `npx react-doctor@latest www` if React files changed) and fix findings for Phase D files

**Checkpoint D**: one door, zero hardcoded flow origins, allowlisted returns.

---

## Phase E: CLI + Mobile Join the Journey (US8, US9) — PR 5

**Goal**: CLI login never dead-ends; `mos setup` provisions from the terminal; mobile renders every pre-ready phase.

**Independent test**: spec.md US8/US9 independent tests — CLI login as (no-plan / entitled-no-machine / ready) user produces correct guidance, with case (b) provisioning to completion in-terminal; mobile sign-in in each pre-ready phase shows a phase-appropriate screen, never a blank shell or generic connection error.

### Tests first

- [ ] T054 [P] [US8] Write failing CLI tests: on `/api/me` 404 the token is KEPT (not deleted) and `/api/journey` is consulted; `plan_required` prints the journey `nextAction.url`; `provisioning`/`provisioning_failed` offers `setup`; exit codes preserved for scripting in `tests/sync-client/login-journey.test.ts` (follow existing sync-client test layout)
- [ ] T055 [P] [US8] Write failing tests for the `setup` command: POSTs `retry-provision`, polls `/api/journey`, prints each stage transition once, exits 0 on `first_run`/`ready`, exits non-zero with support guidance on non-retryable failure in `tests/sync-client/setup-command.test.ts`
- [ ] T056 [P] [US9] Write failing tests for mobile `JourneyGate`: each pre-ready phase renders its screen (plan → browser handoff via `Linking.openURL`; settling/provisioning → progress; failed → retry; first_run → finish-on-web prompt); `ready` constructs `GatewayClient` exactly as today, in `apps/mobile/__tests__/journey-gate.test.tsx` (follow the mobile package's existing test setup)

### Implementation

- [ ] T057 [US8] Rework the 404 path in `packages/sync-client/src/cli/commands/login.ts`: keep auth.json, fetch `/api/journey` with the bearer token, render phase guidance (R9); remove the "Sign up at https://app.matrix-os.com first" dead-end copy
- [ ] T058 [US8] Implement the `setup` command in new `packages/sync-client/src/cli/commands/setup.ts` and register it in `packages/sync-client/src/cli/index.ts` (trigger + poll + stage streaming, `AbortSignal.timeout` on every request)
- [ ] T059 [US9] Implement `JourneyGate` in new `apps/mobile/app/journey.tsx` (or layout-level guard in `apps/mobile/app/_layout.tsx`): fetch `/api/journey` with the Clerk token before constructing `GatewayClient`; phase screens per R10 with polling and reduced-motion-safe progress UI
- [ ] T060 [US9] Route mobile post-sign-in flow through `JourneyGate` and keep the existing connection path untouched for `ready` users in `apps/mobile/app/_layout.tsx`
- [ ] T061 Run `bun run typecheck && bun run test` (+ `npx react-doctor@latest apps/mobile` for the RN changes) and fix findings for Phase E files

**Checkpoint E**: every surface renders the same journey.

---

## Phase F: Docs, Spec Annotations, Telemetry Polish — PR 6

**Goal**: Public docs match the new flow; superseded specs are annotated; funnel dashboards consume the new events (constitution docs-driven rule; FR-020, SC-009).

- [ ] T062 [P] Update `www/content/docs/guide/getting-started.mdx` for the unified boot sequence (plan → pay → watch build → first-run), including the settling and retry states users may see
- [ ] T063 [P] Update `www/content/docs/guide/cli.mdx` with journey-aware `mos login` output and the new `mos setup` command
- [ ] T064 [P] Update `www/content/docs/guide/mobile.mdx` with the pre-ready journey screens and browser checkout handoff
- [ ] T065 [P] Annotate `specs/053-onboarding/spec.md` (required-API-key stage superseded by 092/082; voice mode remains optional) and `specs/082-paid-beta-readiness/spec.md` (onboarding surface now rendered from the 092 journey; readiness gates feed the journey annotation) per FR-020
- [ ] T066 [P] Update `www/posthog-setup-report.md` (or successor doc) describing `journey_phase_entered` and the per-phase funnel (SC-001/SC-009/SC-010 measurement)
- [ ] T067 Final sweep: `bun run typecheck && bun run check:patterns && bun run test && bun run test:e2e`, confirm quickstart.md commands all work as written, and verify zero remaining references to `BillingGate` and the www auth pages

---

## Dependencies

```text
Phase A (US2, US3 backend)  ──►  Phase B (US1)  ──►  Phase C (US4, US7)
                                      │
                                      ├──────────►  Phase E (US8, US9)
                                      │
Phase D (US5, US6) ── independent of B/C/E (only T045 touches Phase A's billing test file)
Phase F ── after C, D, E (documents the final state)
```

- A → B: journey derivation reads `failure_code`/`attempt` (Phase A) and derives the provisioning stage from observable columns; `billing_checkout_attempts` is created in Phase B alongside its consumer.
- B → C and B → E: BootSequence, CLI, and mobile all consume `/api/journey`.
- D can be developed in parallel with B/C (different files); land it as a sibling branch in the stack to keep PRs small.
- Within each phase: test tasks [P] run in parallel first; implementation tasks follow their listed order (db.ts before services before routes).

## Parallel example (Phase A)

```text
# All five test files are independent — write simultaneously:
T001 tests/platform/customer-vps-reconcile.test.ts
T002+T006 tests/platform/customer-vps-retry.test.ts
T003 tests/platform/customer-vps-register.test.ts
T004 tests/platform/customer-vps-recover.test.ts
T005 tests/platform/billing-settling.test.ts
# Then T007 (schema) alone, then T008, then T009–T015 (T009/T012/T013/T014 touch
# distinct functions but share customer-vps.ts / billing-routes.ts — sequence them).
```

## Graphite Stack Plan (constitution X, PR size limits)

One stacked PR per phase, in order, each with the mandatory Invariants section (pre-written in `contracts/journey-api.md`):

1. `fix(platform): provisioning reliability and checkout attempt records` (Phase A)
2. `feat(platform): onboarding journey endpoint and first-run record` (Phase B)
3. `feat(shell): unified boot sequence and real readiness checks` (Phase C)
4. `feat(www,platform): single auth door and canonical origins` (Phase D)
5. `feat(cli,mobile): journey-aware login, setup, and pre-ready screens` (Phase E)
6. `docs: unified onboarding docs and spec annotations` (Phase F)

`gt create --all --message "..."` per layer; `gt restack`/`gt submit --stack` to publish; Greptile 5/5 per PR before merge.

## Implementation Strategy

- **MVP = Phase A + Phase B**: with just these, no user gets stuck, payments settle honestly, and `curl /api/journey` is the debugging tool for every support ticket — even before any UI changes. Existing BillingGate keeps working untouched through A and B.
- Ship and verify each checkpoint on a disposable feature VPS (CLAUDE.md feature-test-VM guidance) before promoting.
- **macOS native app (upcoming PR)**: nothing in this feature modifies `macos/`; Phase B's T018 pins the sync-JWT bearer contract the macOS app will consume (`DeviceAuthClient` keychain token → `Authorization: Bearer` → identical journey JSON). The macOS PR only adds rendering, exactly like CLI/mobile did in Phase E.
- Defer explicitly (recorded in contracts/journey-api.md): SSE push, in-terminal signup (spec 067), mobile IAP, post-launch readiness gates.
