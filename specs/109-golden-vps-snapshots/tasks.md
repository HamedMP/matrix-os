# Tasks: Golden VPS Snapshots

**Input**: Design documents from `specs/109-golden-vps-snapshots/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: TDD is mandatory. Every test task below must be committed in a failing state before its paired implementation task makes it green.

**Organization**: Tasks are grouped by independently testable user story. Equal-priority stories are ordered to match the requested Graphite dependency stack: persistence, build/validation, provisioning/fallback/recovery, release automation, and operations/docs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it changes different files and has no incomplete dependency
- **[Story]**: Maps to the approved user story in `spec.md`
- Every task names the concrete target path

## Phase 1: Planning and Spike Gates

**Purpose**: Preserve the approved spec and create the reviewable design layer.

- [ ] T001 Record official Hetzner snapshot/action/architecture/location/quota/delete findings and unresolved disposable-spike gates in `specs/109-golden-vps-snapshots/research.md`
- [ ] T002 Define architecture, lifecycle, sanitation, fallback, rollout, transaction scope, and Graphite layers in `specs/109-golden-vps-snapshots/plan.md`
- [ ] T003 [P] Define authoritative entities and atomic state-transition invariants in `specs/109-golden-vps-snapshots/data-model.md`
- [ ] T004 [P] Define bounded authenticated control-plane and provider contracts in `specs/109-golden-vps-snapshots/contracts/control-plane.md` and `specs/109-golden-vps-snapshots/contracts/provider.md`
- [ ] T005 [P] Define local/fake-provider and separately authorized live validation in `specs/109-golden-vps-snapshots/quickstart.md`
- [ ] T006 Update the Spec Kit context marker and generated technology context in `AGENTS.md`
- [ ] T007 Validate planning artifacts with `git diff --check`, unresolved-placeholder search, and Spec Kit prerequisite scripts from `.specify/scripts/bash/`

**Checkpoint**: `docs(plan): plan golden VPS snapshot implementation` is independently reviewable and changes no runtime behavior.

---

## Phase 2: Foundational Lifecycle Persistence

**Purpose**: Add the canonical Postgres state, transactional repository, bounded config, and pure domain contracts that every runtime story consumes.

**CRITICAL**: No provider or provisioning integration starts until this phase is green.

- [ ] T008 Write failing schema/migration tests for snapshot, build, durable revoked-base-generation markers, bounded immutable audit events, test-mode isolation/TTL, stable pre-adoption recovery lease identity, snapshot-domain cleanup, existing `provider_deletion_queue` customer-clone cleanup integration, and provisioning-step tables/columns in `tests/platform/golden-snapshot-repository.test.ts`
- [ ] T009 [P] Write failing bounded Zod/state-transition tests in `tests/platform/golden-snapshot-schema.test.ts`
- [ ] T010 [P] Write failing exact/older/newer compatibility and deterministic-key tests in `tests/platform/golden-snapshot-selection.test.ts`
- [ ] T011 Add Kysely table interfaces, check/unique/index migrations, bounded immutable audit-event retention, and provisioning job additions in `packages/platform/src/db.ts`
- [ ] T012 Implement bounded schemas, lifecycle enums, transition guards, compatibility normalization, and coarse error codes in `packages/platform/src/golden-snapshot-schema.ts`
- [ ] T013 Implement pure exact-first/compatible-older selection by joining source and target `host_bundle_releases.build_time` through snapshot `bundle_version` (never registration or snapshot `created_at`), and reject conflicting release-provenance rewrites in `packages/platform/src/golden-snapshot-selection.ts` and `packages/platform/src/db.ts`
- [ ] T014 Implement idempotent snapshot/build enqueue with `ON CONFLICT`, immutable release-provenance verification, a revoked-base-generation deny check, and audit-event insertion in the same lifecycle transaction in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T015 Implement advisory-lock-serialized capacity claims with a default-2/bounded-1..10 durable-running-build cap, conditional phase advancement, attempt budgets, and lease expiry in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T016 Implement atomic ready/quarantine/revoke/retire transitions, retry/cleanup operator attribution, exact cleanup enqueue, and immutable audit-event insertion in each lifecycle transaction in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T017 Implement atomic selection-plus-provisioning-lease insertion with `ON CONFLICT`, safe release, unreleased-lease retention protection, and stale-lease reconciliation in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T018 Implement protected-reference/rollback/lease-aware retention queries and configured-cap enforcement in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T019 Add bounded disabled-by-default snapshot, compatibility, retry, lease, retention, max-concurrent-build, and rollout config parsing in `packages/platform/src/customer-vps-config.ts`
- [ ] T020 Add transaction/concurrency fault tests for duplicate enqueue, ready-vs-revoke, lease-vs-retire, and cleanup idempotency in `tests/platform/golden-snapshot-repository.test.ts`
- [ ] T021 Run the focused repository/schema/selection tests and `bun run check:patterns` for `packages/platform/src/golden-snapshot-*.ts` and `tests/platform/golden-snapshot-*.test.ts`

**Checkpoint**: `feat(platform): persist golden snapshot lifecycle` is independently testable with no provider resources and no provisioning-path behavior change.

---

## Phase 3: User Story 2 - Snapshot Created for Every Eligible Bundle (Priority: P1)

**Goal**: Build, sanitize, capture, independently validate, and clean up exactly one non-selectable candidate per immutable bundle/compatibility key; only validated candidates become ready.

**Independent Test**: With a fake provider, enqueue one synthetic release twice, drive the worker through builder/sanitation/snapshot/clone validation, and prove one ready canonical image exists only after successful evidence while every failure remains non-selectable and cleanup is durable.

### Tests for User Story 2

- [ ] T022 [P] [US2] Write failing provider request/response parsing, timeout, Action polling, and exact-label reconciliation tests in `tests/platform/golden-snapshot-provider.test.ts`
- [ ] T023 [P] [US2] Write failing worker phase, crash-resume, ambiguous-timeout, retry-budget, and cleanup tests in `tests/platform/golden-snapshot-service.test.ts`
- [ ] T024 [P] [US2] Write failing builder callback auth/body-limit/schema/replay/error-redaction tests, including replay of an earlier event after later phase callbacks, in `tests/platform/golden-snapshot-routes.test.ts`
- [ ] T025 [P] [US2] Write failing static and sandboxed sanitation coverage tests for every approved forbidden-state category, free-block overwrite/sync, and raw-device callback-token/canary scanning without secret command arguments in `tests/platform/golden-snapshot-host-scripts.test.ts`
- [ ] T026 [P] [US2] Write failing two-independent-validation-clone tests for exact digest, health, fresh activation, pairwise-unique machine/SSH identity against builder and peer clone, and forbidden-state absence in `tests/platform/golden-snapshot-validation.test.ts`

### Implementation for User Story 2

- [ ] T027 [US2] Extend the provider interface with bounded image/action/server schemas, per-request 10-second timeouts, image override, and exact-label list/get methods in `packages/platform/src/customer-vps-hetzner.ts`
- [ ] T028 [US2] Implement create-image, image readiness, Action polling, compatibility probes, and exact image/server deletion semantics in `packages/platform/src/customer-vps-hetzner.ts`
- [ ] T029 [US2] Add the synthetic builder cloud-init bootstrap with immutable bundle URL/digest and phase-bound callback in `distro/customer-vps/golden-snapshot-builder-cloud-init.yaml`
- [ ] T030 [US2] Implement fail-closed sanitation covering Matrix env/markers, owner data/DBs, SSH/TLS/authorized keys, machine/random seed, cloud-init, network leases/identity, histories/temp/package credentials, bootstrap tokens, container volumes, secret-bearing logs, free-block overwrite/sync, and raw-device secret/canary scanning in `distro/customer-vps/host-bin/matrix-golden-snapshot-sanitize`
- [ ] T031 [US2] Implement validation evidence collection and synthetic exact-version health checks in `distro/customer-vps/host-bin/matrix-golden-snapshot-validate`
- [ ] T032 [US2] Package builder/sanitizer/validator files and generic provenance marker in `scripts/build-host-bundle.sh`
- [ ] T033 [US2] Implement phase-bound token hashing, constant-time callback consumption, per-event `ON CONFLICT` callback receipts with bounded replay retention, and bounded evidence persistence in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T034 [US2] Implement builder creation, exact-bundle install wait, sanitation, power-off/quiescence verification, snapshot creation, and Action/image reconciliation in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T035 [US2] Implement two sequential independent validation-clone creations, fresh synthetic activation, persisted clone-1 identity, builder/peer pairwise evidence verification, atomic ready transition only after clone 2, and builder/clone cleanup in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T036 [US2] Implement ambiguous create/delete recovery, exact-label adoption, retry budgets, quarantine, and exact-resource cleanup workers in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T037 [US2] Add strict body-limited authenticated enqueue/status/callback routes with generic errors in `packages/platform/src/golden-snapshot-routes.ts`
- [ ] T037A [US2] Write a failing fake-provider end-to-end wiring test covering eligible release registration -> idempotent enqueue -> callbacks -> ready transition -> exact/older selection -> registration or fallback, including bounded worker startup and shutdown, in `tests/platform/golden-snapshot-e2e.test.ts`
- [ ] T038 [US2] Wire the snapshot service, bounded worker interval, and shutdown drain into `packages/platform/src/platform-startup.ts` and `packages/platform/src/main.ts`
- [ ] T039 [US2] Run US2 focused tests, shell syntax checks, `bun run check:patterns`, and `git diff --check`

**Checkpoint**: `feat(vps): build and validate golden snapshots` can produce a ready image under fakes, never selects it yet, and never creates production resources during tests.

---

## Phase 4: User Story 1 - Fast Fresh Computer Provisioning (Priority: P1) MVP

**Goal**: Use an exact or compatible older ready snapshot for a newly authorized customer VPS, inject owner secrets only after clone creation, and route only after exact-version health registration.

**Independent Test**: Seed an exact ready synthetic snapshot, provision two customers concurrently, and verify separate servers, unique identities/credentials/stores/host keys, exact bundle registration, snapshot lease release, and improved readiness instrumentation.

### Tests for User Story 1

- [ ] T040 [P] [US1] Write failing exact snapshot selection/lease and image-override tests in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T041 [P] [US1] Write failing compatible-older activation and exact-target registration tests in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T042 [P] [US1] Write failing concurrent owner isolation, idempotent runtime-slot, secret-injection-boundary, deterministic compatibility-scoped rollout-cohort, authorization/billing-revocation, and rollout-disable/create-intent race tests that pause a durable job before every provider create and before routing in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T043 [P] [US1] Write failing cloud-init exact-snapshot fast path and older-snapshot update tests in `tests/platform/golden-snapshot-host-scripts.test.ts`

### Implementation for User Story 1

- [ ] T044 [US1] Implement immutable target-release resolution, deterministic compatibility-scoped rollout percentage before selection, clean-image fallback for excluded requests, and snapshot selection/lease orchestration in `packages/platform/src/golden-snapshot-activation.ts`
- [ ] T045 [US1] Persist target bundle, image source, snapshot lease, provider Action, and resumable activation steps in `packages/platform/src/customer-vps-provisioning-jobs.ts`
- [ ] T046 [US1] Re-resolve current owner authorization and billing entitlement immediately before the first billable provider create, fail closed without a provider call when either was revoked, then pass exact provider snapshot IDs only after lease commit and preserve existing machine UUID labels in `packages/platform/src/customer-vps.ts`
- [ ] T047 [US1] Extend host config with immutable bundle digest/provenance and keep customer credentials exclusive to clone user-data in `packages/platform/src/customer-vps-cloud-init.ts`
- [ ] T048 [US1] Add fresh identity/key/cloud-init regeneration plus exact-snapshot skip-or-verify and older-snapshot exact-update behavior in `distro/customer-vps/cloud-init.yaml`
- [ ] T049 [US1] Extend the internal registration schema with the installed bundle digest and coarse health evidence; atomically compare version/digest to the persisted target, persist source snapshot/base generation/exact target provenance on the adopted `user_machines` row, require the established local health probe, and re-resolve current owner authorization and billing entitlement immediately before making the machine routable; revoked entitlement leaves the machine unrouted and enters bounded cleanup, while successful registration releases the lease transactionally in `packages/platform/src/customer-vps.ts`
- [ ] T050 [US1] Emit bounded snapshot-selected/activation-latency/registration telemetry without owner secrets or provider errors in `packages/platform/src/golden-snapshot-activation.ts`
- [ ] T051 [US1] Run focused cases in `tests/platform/golden-snapshot-provisioning.test.ts` and `tests/platform/customer-vps.test.ts` and prove the clean-image path is unchanged when the feature flag is off

**Checkpoint**: The snapshot happy path is independently usable for new machines with fakes; the existing clean-image path still passes unchanged tests.

---

## Phase 5: User Story 3 - Safe Provisioning Fallback (Priority: P1)

**Goal**: Preserve provisioning availability and one-authoritative-server guarantees when lookup, clone, provider state, or activation is unsafe.

**Independent Test**: Inject missing, quarantined, incompatible, rejected, timed-out, and activation-failed snapshots; every request either completes through clean Ubuntu or fails generically with no duplicate authoritative server.

### Tests for User Story 3

- [ ] T052 [P] [US3] Write failing no-candidate/quarantined/incompatible/operator-disabled fallback tests in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T053 [P] [US3] Write failing lost-create-response adoption and duplicate exact-resource cleanup tests in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T054 [P] [US3] Write failing partial-activation cleanup-before-fallback and bounded retry tests in `tests/platform/golden-snapshot-provisioning.test.ts`
- [ ] T055 [P] [US3] Write failing generic customer-error and coarse operator-reason tests in `tests/platform/golden-snapshot-routes.test.ts`

### Implementation for User Story 3

- [ ] T056 [US3] Implement snapshot-specific failure classification, quarantine/lease release, and durable `fallback_pending` transitions in `packages/platform/src/golden-snapshot-activation.ts`
- [ ] T057 [US3] Reconcile lost customer-clone responses by immutable machine labels before create retry in `packages/platform/src/customer-vps.ts`
- [ ] T058 [US3] Atomically queue provenance-checked customer-clone cleanup through the existing `provider_deletion_queue` with machine/provider identity while retaining snapshot/label provenance on the provisioning job, then confirm shutdown or network isolation and revoke instance credentials before allowing another authoritative provider server in `packages/platform/src/golden-snapshot-activation.ts`
- [ ] T059 [US3] Resume the same durable provisioning job through configured clean Ubuntu with fresh customer activation material in `packages/platform/src/customer-vps-provisioning-jobs.ts`
- [ ] T060 [US3] Map all snapshot/provider/internal failure details to existing generic customer errors and bounded server-side telemetry in `packages/platform/src/customer-vps-errors.ts`
- [ ] T061 [US3] Run fault-injection cases in `tests/platform/golden-snapshot-provisioning.test.ts` proving 100% no-duplicate-authoritative-server behavior and automatic fallback

**Checkpoint**: Snapshot acceleration is not an availability dependency.

---

## Phase 6: User Story 4 - Fast and Correct Recovery (Priority: P2)

**Goal**: Reuse snapshot acceleration for replacement infrastructure without treating the image as an owner backup or weakening existing recovery guarantees.

**Independent Test**: Recover a synthetic owner backup onto a compatible image, verify base activation precedes restore, only that owner's backup appears, exact target health passes, and old/new cleanup follows current guarantees.

### Tests for User Story 4

- [ ] T062 [P] [US4] Write failing snapshot-based recovery ordering and owner-backup isolation tests in `tests/platform/golden-snapshot-recovery.test.ts`
- [ ] T063 [P] [US4] Write failing no-snapshot fallback, restore-failure, and old-server cleanup tests in `tests/platform/golden-snapshot-recovery.test.ts`
- [ ] T064 [P] [US4] Write failing rejection test for a golden image containing initialized owner home/database state in `tests/platform/golden-snapshot-validation.test.ts`

### Implementation for User Story 4

- [ ] T065 [US4] Reuse atomic snapshot selection/lease for recovery while preserving backup preflight and ownership checks; allocate and lease the stable intended replacement UUID before provider create, then adopt that same UUID into `user_machines` without rotating the lease key in `packages/platform/src/customer-vps.ts`
- [ ] T066 [US4] Make base activation/exact update complete before the existing owner-scoped restore service runs in `distro/customer-vps/cloud-init.yaml`
- [ ] T067 [US4] Preserve replacement adoption, previous-server retirement, and durable cleanup semantics for both snapshot and clean-image sources in `packages/platform/src/customer-vps.ts`
- [ ] T068 [US4] Run focused cases in `tests/platform/golden-snapshot-recovery.test.ts` and `tests/platform/golden-snapshot-validation.test.ts` with snapshot enabled and disabled

**Checkpoint**: Recovery gains acceleration without changing owner-backup semantics.

---

## Phase 7: User Story 5 - Operable Snapshot Fleet (Priority: P2)

**Goal**: Reconcile, retain, revoke, retry, and observe snapshot infrastructure within bounded cost and without deleting protected/in-use images.

**Independent Test**: Seed ready, failed, orphaned, leased, protected, revoked, and superseded records/resources; reconciliation adopts only exact provenance and retention deletes only exact unprotected eligible resources.

### Tests for User Story 5

- [ ] T069 [P] [US5] Write failing retention/quota/protected-channel/rollback/sole-compatible/lease race tests in `tests/platform/golden-snapshot-retention.test.ts`
- [ ] T070 [P] [US5] Write failing orphan adoption/provenance mismatch/provider disappearance/delete-timeout tests in `tests/platform/golden-snapshot-reconciliation.test.ts`
- [ ] T071 [P] [US5] Write failing immediate snapshot/base-generation revocation, durable future-enqueue/readiness denial, bounded generation batching, quarantine-during-active-lease plus high-priority cleanup after final release, cleanup retry, separate release/operator auth, and affected-machine pagination tests in `tests/platform/golden-snapshot-repository.test.ts`
- [ ] T072 [P] [US5] Write failing bounded status/metrics/alert payload tests in `tests/platform/golden-snapshot-routes.test.ts`

### Implementation for User Story 5

- [ ] T073 [US5] Implement bounded provider/DB reconciliation and exact-provenance orphan adoption/deletion in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T074 [US5] Implement retention, rollback/channel protection, only-compatible preservation, quota-pressure selection, and refusal when no safe deletion exists in `packages/platform/src/golden-snapshot-service.ts`
- [ ] T075 [US5] Implement immediate snapshot revocation plus an `ON CONFLICT` durable base-generation deny marker checked by enqueue/readiness/selection, followed by bounded deterministic snapshot/build cleanup batches in `packages/platform/src/golden-snapshot-repository.ts`
- [ ] T076 [US5] Add coarse lifecycle/fallback/cleanup metrics and alerts to `packages/observability/src/events.ts` and `packages/platform/src/golden-snapshot-service.ts`
- [ ] T077 [US5] Keep release enqueue on `PLATFORM_SECRET`; add separately authenticated `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bounded build/cleanup retry, per-snapshot revoke, base-generation revoke, status, and cursor-paginated affected-machine controls without owner/provider details in `packages/platform/src/golden-snapshot-routes.ts`
- [ ] T078 [US5] Run `tests/platform/golden-snapshot-retention.test.ts`, `tests/platform/golden-snapshot-reconciliation.test.ts`, and `tests/platform/golden-snapshot-routes.test.ts` and verify all Maps/Sets/timers/batches are capped and shutdown drains cleanly

**Checkpoint**: Snapshot storage and failure recovery are bounded and operable under synthetic fault injection.

---

## Phase 8: User Story 6 - Existing Computers Continue Normal Updates (Priority: P3)

**Goal**: Automatically enqueue every eligible main/tag/trusted manual-dispatch bundle without blocking publication or the unchanged existing-fleet deployment path.

**Independent Test**: Simulate eligible, preview, repeated-promotion, enqueue-failed, and build-failed releases; eligible identities enqueue once, previews do not, and `/vps/deploy` still runs for existing machines.

### Tests for User Story 6

- [ ] T079 [P] [US6] Write failing enqueue script tests for immutable metadata, eligibility, bounded timeout, generic output, and non-zero internal failure in `tests/platform/host-bundle-snapshot-workflow.test.ts`
- [ ] T080 [P] [US6] Write failing workflow-structure tests proving snapshot enqueue depends on publish but deploy does not depend on snapshot success in `tests/platform/host-bundle-snapshot-workflow.test.ts`
- [ ] T081 [P] [US6] Write failing route tests proving channel promotion reuses bundle identity and preview artifacts are excluded in `tests/platform/golden-snapshot-routes.test.ts`

### Implementation for User Story 6

- [ ] T082 [US6] Implement bounded authenticated idempotent enqueue CLI with `AbortSignal.timeout()` in `scripts/enqueue-golden-snapshot.mjs`
- [ ] T083 [US6] Add non-blocking post-publish snapshot enqueue plus a bounded missing-release/candidate reconciler for eligible main/tag/trusted manual-dispatch bundles while keeping existing-fleet deploy independent in `.github/workflows/host-bundle-release.yml` and platform startup
- [ ] T084 [US6] Preserve release/channel registration semantics and expose coarse snapshot status alongside release metadata in `packages/platform/src/host-bundle-routes.ts`
- [ ] T085 [US6] Add package script wiring for the enqueue helper in `package.json`
- [ ] T086 [US6] Run workflow/route tests and verify a snapshot enqueue/build failure cannot prevent exact-version `/vps/deploy`

**Checkpoint**: `ci(release): create snapshots for eligible host bundles` automatically requests acceleration while existing fleet releases remain independent.

---

## Phase 9: Operations, Rollout, and Cross-Cutting Validation

**Purpose**: Make the public repository operationally safe, document private boundaries, and complete review gates.

- [ ] T087 Document lifecycle, sanitation evidence, rollout gates, disablement, retention, quota, revocation, cleanup, rollback, and incident classification in `docs/dev/golden-vps-snapshots.md`
- [ ] T088 [P] Link the operator guide and preserve the existing clean-image/release path in `docs/dev/vps-deployment.md` and `docs/dev/releases.md`
- [ ] T089 [P] Add public-safe configuration reference without credentials/customer identifiers in `.env.example`
- [ ] T090 Create or update the canonical public golden-snapshot documentation in the private `FinnaAI/matrix-os-site` repository and submit it as a separate reviewable PR; link that PR from `docs/dev/golden-vps-snapshots.md` while keeping private operator incident details in the private support/runbook system
- [ ] T091 Run `bun run check:patterns`, focused Vitest suites, `bun run typecheck`, `bun run test`, and `git diff --check`, recording only the known unrelated baseline failures in PR bodies
- [ ] T092 Perform the three review passes from `docs/dev/review-pipeline.md` across routes, provider calls, Postgres transactions, shell scripts, cleanup, and workflow failure paths
- [ ] T093 After separate authorization, execute the disposable-provider spike from `specs/109-golden-vps-snapshots/quickstart.md` and record public-safe evidence in `docs/dev/golden-vps-snapshots.md`
- [ ] T094 Restack and submit the six draft Graphite child PRs following `docs/dev/stacked-prs.md`, with source-of-truth, lock/transaction scope, acceptable orphan states, authorization source, and deferred scope in every PR body

**Checkpoint**: `docs(vps): document snapshot operations and rollout` completes the repository stack; production selection remains disabled until the separately authorized live spike and rollout gates pass.

---

## Dependencies and Execution Order

### Phase dependencies

- Phase 1 has no dependency and is the first Graphite child.
- Phase 2 depends on Phase 1 and blocks all runtime stories.
- Phase 3 (US2 build/validation) depends on Phase 2.
- Phase 4 (US1 provisioning) depends on Phase 2 and provider image overrides from T027; it can use seeded ready snapshots independently of the live builder.
- Phase 5 (US3 fallback) depends on Phase 4.
- Phase 6 (US4 recovery) depends on Phases 4-5.
- Phase 7 (US5 operations) depends on Phase 2 and integrates Phase 3 provider cleanup.
- Phase 8 (US6 release) depends on the enqueue route from Phase 3 but does not depend on a successful build.
- Phase 9 depends on all desired runtime phases; T093 additionally requires explicit operator authorization.

### User story dependencies

- **US2 (P1)**: independently proves safe snapshot production after persistence.
- **US1 (P1)**: independently proves selection/provisioning with seeded ready records; full end-to-end uses US2 output.
- **US3 (P1)**: extends US1 with failure/fallback guarantees.
- **US4 (P2)**: reuses US1/US3 activation for recovery while preserving backup semantics.
- **US5 (P2)**: independently tests lifecycle operations and then integrates provider cleanup.
- **US6 (P3)**: requires enqueue contract only; publish/deploy remains independent of build outcome.

### Within each story

1. Commit failing tests first and confirm the expected red failure.
2. Implement the smallest behavior to turn the focused tests green.
3. Refactor into focused modules, keeping `db.ts` and `customer-vps.ts` integration narrow.
4. Run focused tests and pattern checks before `gt modify --all`.
5. Preserve provider calls outside transaction/lock scope.

## Parallel Opportunities

- T003-T005 can be drafted independently after T002.
- T009-T010 can run in parallel with the initial repository test T008.
- US2 test files T022-T026 are independent before implementation.
- US1 test slices T040-T043 are independent against fakes.
- US3 fault categories T052-T055 are independent.
- US4 tests T062-T064 and US5 tests T069-T072 are independent once foundational schemas exist.
- Workflow tests T079-T081 can be written independently of runtime worker internals after the enqueue contract is stable.
- Documentation T087-T090 can be drafted in parallel after behavior/config names freeze.

## Parallel Examples

### US2 build and validation

```text
Task T022: provider Action/image contract tests
Task T024: callback auth and schema tests
Task T025: sanitation script tests
Task T026: validation clone tests
```

### US1 provisioning

```text
Task T040: exact selection and lease tests
Task T041: compatible older update tests
Task T042: concurrent owner isolation tests
Task T043: host activation script tests
```

## Graphite Stack Plan

| Layer | Branch/title | Tasks | Independent proof |
|---|---|---|---|
| 1 | `docs(plan): plan golden VPS snapshot implementation` | T001-T007 | Docs/checks only; approved spec unchanged |
| 2 | `feat(platform): persist golden snapshot lifecycle` | T008-T021 | Postgres repository/concurrency tests; no provider I/O |
| 3 | `feat(vps): build and validate golden snapshots` | T022-T039 | Fake-provider build/sanitation/validation; image never ready early |
| 4 | `feat(platform): provision VPSes from golden snapshots` | T040-T078 | Provision/fallback/recovery/operations tests; feature off preserves clean path |
| 5 | `ci(release): create snapshots for eligible host bundles` | T079-T086 | Workflow tests prove enqueue cannot block publish/deploy |
| 6 | `docs(vps): document snapshot operations and rollout` | T087-T094 | Public-safe docs and full review gates |

Create every layer with `gt create`, update with `gt modify --all`, run `gt restack`, and publish with `gt submit --stack --draft`. Do not flatten PR #1053 or its descendants.
The task ranges are dependency groupings, not permission to exceed repository review
limits. If any implementation layer approaches 50 files or 3,000 additions, stop and
split the next independently testable story group into an additional Graphite child;
fallback, recovery, and operations are the preferred split boundaries.

## Implementation Strategy

### MVP sequence

1. Land lifecycle persistence under a disabled feature flag.
2. Prove build/sanitation/validation entirely with fakes.
3. Prove exact/older provisioning and automatic clean fallback with seeded images.
4. Add recovery and bounded fleet operations.
5. Wire non-blocking release enqueue.
6. Complete docs and, only with separate authorization, the disposable-provider spike.

### Safety stop points

- Stop if immutable release digest cannot be proven.
- Stop and quarantine if sanitation or validation is uncertain.
- Stop provider retries while a create/delete outcome is ambiguous; reconcile first.
- Stop retirement when a channel, rollback policy, lease, or sole-compatible fallback protects the image.
- Stop before any production provider creation/deletion or customer deployment without explicit operator authorization.

## Notes

- `[P]` means different-file work with no incomplete prerequisite; shared worktree edits still require coordination.
- No React files are expected; if scope changes, run React Doctor before committing that layer.
- Do not mix the known unrelated full-test/typecheck failures into this stack.
- Update task checkboxes as each TDD increment is completed and committed.
