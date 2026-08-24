# Tasks: Prebilling Provisioning

**Input**: Design documents from `/specs/116-prebilling-provisioning/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Mandatory. Execute each behavior as a vertical red → green → refactor slice.

**Delivery override**: The requester explicitly asked for one monitored PR. Preserve the three architecture layers as Nima-Naderi-authored phase commits and stop before publication if the diff exceeds 3,000 additions or 50 files.

## Phase 1: Setup and Baseline

**Purpose**: Confirm the existing project and feature artifacts are safe to implement.

- [x] T001 Verify Node/TypeScript ignore and pattern-scan coverage without modifying unrelated files in `.gitignore`, `eslint.config.mjs`, and `scripts/review/check-patterns.sh`
- [x] T002 Record the focused billing/provisioning baseline with `tests/platform/billing-routes.test.ts`, `tests/platform/customer-vps-provisioning-durability.test.ts`, and `tests/platform/journey.test.ts`
- [x] T003 Confirm the single-PR delivery override and Nima-Naderi authorship requirements in `specs/116-prebilling-provisioning/plan.md` and `specs/116-prebilling-provisioning/research.md`

---

## Phase 2: Foundational State and Admission

**Purpose**: Add rollback-safe persistence, configuration, and transaction helpers while admission remains disabled.

**Critical**: This phase blocks all user stories.

- [x] T004 Write failing public-store tests for intent uniqueness, canonical selections, activation defaults, capacity reservation, and release-once semantics in `tests/platform/prebilling-provisioning.test.ts`
- [x] T005 Implement strict off-by-default rollout, lease, count, and cost configuration in `packages/platform/src/prebilling-provisioning-config.ts`
- [x] T006 Add additive Kysely schema/types for preparation intents, machine activation, provisioning authorization basis, cleanup state, and durable capacity accounting in `packages/platform/src/db.ts`
- [x] T007 Implement revision-checked, transaction-aware intent/admission/promotion operations in `packages/platform/src/prebilling-provisioning-store.ts`
- [x] T008 Refactor the shared machine/job creation seam to accept only the discriminated billing-entitlement or validated-prebilling authorization basis in `packages/platform/src/customer-vps.ts` and `packages/platform/src/customer-vps-provisioning-jobs.ts`
- [x] T009 Run `tests/platform/prebilling-provisioning.test.ts` and `tests/platform/customer-vps-provisioning-durability.test.ts`, then refactor while green

**Checkpoint**: Commit the flag-off foundation as Nima-Naderi.

---

## Phase 3: User Story 1 — Prepare While the User Checks Out (Priority: P1)

**Goal**: One authenticated checkout mutation starts one owner-bound inaccessible machine and signed subscription projection activates that exact machine or guarantees one fallback job.

**Independent Test**: Delay a fake subscription event after Checkout creation; prove provider work overlaps Checkout, preauthorization access is denied, and the signed event activates the same machine.

- [x] T010 [US1] Write the failing checkout-to-preparation and signed-authorization tracer test in `tests/platform/prebilling-provisioning.test.ts`
- [x] T011 [US1] Add exact intent metadata, explicit 30-minute `expires_at`, bounded Stripe operations, and subscription metadata propagation in `packages/platform/src/stripe-billing.ts`
- [x] T012 [US1] Extend strict checkout input/equality for server type and canonical developer tools, then finalize intent/machine/job atomically after an open session in `packages/platform/src/billing-routes.ts` and `packages/platform/src/db.ts`
- [x] T013 [US1] Implement the registration-time prebilling orchestration interface and provider-job admission in `packages/platform/src/prebilling-provisioning.ts` and `packages/platform/src/customer-vps.ts`
- [x] T014 [US1] Promote the exact prepared machine from verified subscription projection and preserve the existing entitled journey fallback when preparation is absent/failed in `packages/platform/src/billing-routes.ts` and `packages/platform/src/prebilling-provisioning.ts`
- [x] T015 [US1] Run the tracer plus billing settling, Stripe billing, and provisioning durability tests, then refactor while green in `tests/platform/prebilling-provisioning.test.ts`

**Checkpoint**: Commit checkout/authorization behavior as Nima-Naderi.

---

## Phase 4: User Story 2 — Recover Safely From Abandonment and Failure (Priority: P1)

**Goal**: Reclaim only authoritatively expired unauthorized machines and make signed authorization win every cleanup race.

**Independent Test**: Race authorization against each cleanup phase; an authorized machine always survives, while an expired unpaid machine is reconciled absent and releases its cost once.

- [x] T016 [US2] Write failing authoritative-expiry and authorization-fence tests in `tests/platform/prebilling-provisioning.test.ts`
- [x] T017 [US2] Implement signed-expiry cleanup under the intent row lock and hand provider absence to the existing durable deletion queue in `packages/platform/src/prebilling-provisioning-store.ts`
- [x] T018 [US2] Add exact signed Stripe expiry and provider deletion reconciliation boundaries in `packages/platform/src/billing-routes.ts` and `packages/platform/src/prebilling-provisioning-store.ts`
- [x] T019 [US2] Keep cleanup and authorization callable independently of new-admission state and reuse bounded platform billing/provider logs
- [x] T020 [US2] Run expiry cleanup, customer VPS reliability, and billing settling tests, then refactor while green

---

## Phase 5: User Story 3 — Resume Without Duplicates (Priority: P2)

**Goal**: Identical retries and browser refreshes resume one payable checkout/preparation; conflicting selections are rejected safely.

**Independent Test**: Concurrent identical and conflicting fake checkout requests leave one session, intent, machine, and job, while journey returns a safe resume action.

- [x] T021 [US3] Run concurrent retry, selection-conflict, and journey-resume coverage in `tests/platform/billing-routes.test.ts` and `tests/platform/journey.test.ts`
- [x] T022 [US3] Complete `ON CONFLICT`/revision-fenced checkout-intent reuse and ambiguous Stripe reconciliation in `packages/platform/src/db.ts` and `packages/platform/src/billing-routes.ts`
- [x] T023 [US3] Preserve coarse payment-settling/resume journey states without exposing internal identifiers in `packages/platform/src/journey.ts`
- [x] T024 [US3] Run concurrent checkout and journey contract tests, then refactor while green in `tests/platform/billing-routes.test.ts` and `tests/platform/journey-routes.test.ts`

---

## Phase 6: User Story 4 — Preserve Lifecycle and Present the New Flow (Priority: P3)

**Goal**: Only new-primary onboarding changes; every customer access path requires entitlement plus machine activation, and Canvas/Desktop show compute → agents → checkout/preparation.

**Independent Test**: An unauthorized physically running prepared machine is denied across HTTP/WebSocket/terminal/recovery/resize/resume paths while existing paid/additional/preview behavior remains unchanged.

- [x] T025 [US4] Write failing shared active/running-machine activation-gate tests in `tests/platform/prebilling-provisioning.test.ts`
- [x] T026 [US4] Enforce machine activation in the shared accessible/running machine selectors consumed by HTTP, WebSocket, and app-session routing in `packages/platform/src/db.ts`
- [x] T027 [US4] Write the failing pre-checkout compute/agent selection test in `tests/shell/billing-section.test.tsx`
- [x] T028 [US4] Move developer-tool selection before checkout by reusing the branded onboarding selector in `shell/src/components/settings/sections/BillingPanel.tsx`
- [x] T029 [US4] Run paid/additional/preview, journey, billing shell, and boot-sequence regression checks in `tests/platform/` and `tests/shell/`

**Checkpoint**: Commit journey/shell/observability and lifecycle regression coverage as Nima-Naderi.

---

## Phase 7: Polish, Validation, and Monitored PR

**Purpose**: Freeze the exact review head, validate all gates, and deliver the requested PR without deploying or provisioning live resources.

- [x] T030 Verify public-safe documentation requirements and operator boundaries in `specs/116-prebilling-provisioning/quickstart.md`; keep the separate `FinnaAI/matrix-os-site` PR deferred until implementation wording is stable
- [ ] T031 Run `bun run typecheck`, `bun run check:patterns:diff`, focused platform/shell tests, `bun run test`, `bun run test:coverage`, `bun run build:shell:production`, and `pnpm dlx react-doctor@latest .`
- [ ] T032 Perform the structured mechanical, trust-boundary, atomicity/failure-mode, runtime-contract, and paid-beta launch-readiness review against all changed files documented in `docs/dev/review-pipeline.md`
- [ ] T033 Confirm every checklist/task is complete and the aggregate diff stays below 3,000 additions/50 files in `specs/116-prebilling-provisioning/tasks.md`
- [ ] T034 Push the Nima-Naderi-authored branch, open one Conventional Commit PR with required invariants, monitor current-head feedback to trusted Greptile 5/5, add `ready-for-ci`, and wait for label-triggered CI

---

## Dependencies and Execution Order

- Phase 1 establishes a clean baseline.
- Phase 2 is blocking and must complete before any user story.
- US1 establishes preparation and authorization; US2 and US3 depend on its intent lifecycle.
- US4 depends on activation state and journey annotations from US1/US3.
- Phase 7 begins only after all selected user stories are green.
- Within every phase, write one failing behavior test, implement only enough to pass it, then refactor before the next behavior.

## Parallel Opportunities

The monitor skill explicitly forbids Swarm coordination for this workflow. Conceptually independent test files may be run concurrently, but edits touching `db.ts`, billing routes, or shared VPS lifecycle code remain sequential.

## Graphite / PR Plan

The original design proposed a three-PR stack. The requester later explicitly asked for one PR, so this execution preserves the same boundaries as three phase commits on `116-prebilling-provisioning`. Use Graphite to track and submit the single branch. Do not merge. If review size exceeds 3,000 additions or 50 files, stop and request permission to split rather than publishing an oversized PR.

## Completion Criteria

- All 34 tasks are checked.
- The feature remains off by default and can stop new admission without stopping authorization or cleanup.
- Preauthorization routing is denied in every contract test.
- Checkout retries create no duplicate session, intent, job, or machine.
- Signed subscription projection activates the exact prepared machine or creates exactly one normal fallback job.
- Authoritatively expired unpaid machines reconcile absent; completed/payment-settling sessions are never auto-deleted.
- Nima-Naderi is the author of every commit and the authenticated opener of the PR.
- Latest trusted Greptile is 5/5 and label-triggered CI is green before handoff for human review.
