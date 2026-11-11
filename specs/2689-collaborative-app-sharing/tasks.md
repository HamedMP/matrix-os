# Tasks: Collaborative App Sharing

**Input**: Design documents from `specs/2689-collaborative-app-sharing/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/collaborative-app-sharing.md`, `quickstart.md`
**Tracking**: [ENG-29](https://linear.app/matrix-os/issue/ENG-29) · specification PR [#3123](https://github.com/HamedMP/matrix-os/pull/3123)

**Tests**: TDD is mandatory. For every test task, capture a failure caused by the missing production behavior before implementing the paired task, then capture the green result. Fixture, setup, or skipped-assertion failures do not count as red evidence.

**Organization**: Tasks are grouped by user story so each outcome remains independently testable. The five architecture layers are logical review boundaries, not a fixed PR count. Use the fewest Matrix OS PRs practical, split before 3,000 changed lines, and never exceed ten Matrix OS PRs. The separate public-documentation PR does not count toward ten.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it changes different files and has no dependency on an incomplete task.
- **[Story]**: Maps implementation work to the user story in `spec.md`.
- Every task names the exact production, test, specification, or external documentation path it changes or validates.

## Phase 1: Setup and Compatibility Gates

**Purpose**: Freeze the additive contract, fixtures, and compatibility boundary before implementation.

- [X] T001 Reconcile direct ready-app sharing with the project-only rule and document legacy behavior in `specs/124-organization-collaboration/spec.md`
- [X] T002 [P] Add strict bounded collaborative build, readiness, share, launch-target, participant, mutation, change-signal, and safe-error schemas in `packages/contracts/src/collaborative-app-sharing.ts`
- [X] T003 [P] Add exact-build capability and compatibility declarations in `packages/contracts/src/collaboration-capabilities.ts`
- [X] T004 [P] Write failing serialization, bounds, unknown-field, and owner/shared launch-union contract tests in `tests/contracts/collaborative-app-sharing.test.ts`
- [X] T005 [P] Add tracker, organization, guest, newcomer, departed-member, wrong-organization, and outsider fixtures while leaving the deferred second-principal credential source unimplemented in `tests/e2e/fixtures/collaborative-app-sharing.ts`
- [X] T006 Export the additive collaborative app contracts without changing legacy collaboration exports in `packages/contracts/src/index.ts`

**Checkpoint**: Additive contracts compile, deliberately reject roles/grants/acceptance fields, and old collaboration types remain source-compatible.

---

## Phase 2: Foundational Exact-Build and Persistence Infrastructure

**Purpose**: Establish immutable identity, persistence, bounds, and wiring shared by all four stories.

**⚠️ CRITICAL**: No user-story implementation begins until this phase is green.

- [X] T007 [P] Write failing exact registration/build identity tests covering same-slug replacement and manifest/schema/asset/bridge/runtime-ABI drift in `tests/gateway/collaborative-app-identity.test.ts`
- [X] T008 [P] Write failing immutable snapshot, content digest, reference retention, symlink-safe cleanup, and ordinary-restart stability tests in `tests/gateway/app-runtime/collaborative-build-snapshot.test.ts`
- [X] T009 [P] Write failing real-Postgres migration and repository tests for readiness uniqueness, state constraints, CAS revisions, and soft-delete filtering in `tests/gateway/collaborative-app-readiness-postgres.test.ts`
- [X] T010 [P] Write failing real-Postgres migration and repository tests for one active binding, exact certificate matching, data revision, rebind, and stop in `tests/gateway/collaborative-app-binding-postgres.test.ts`
- [X] T011 Add `collaboration_app_readiness` and `collaboration_app_bindings` tables, constraints, indexes, and migration revision handling in `packages/gateway/src/collaboration/database-migrations.ts`
- [X] T012 Implement canonical registration/build identity and bounded digest inputs in `packages/gateway/src/collaboration/collaborative-app-identity.ts`
- [X] T013 Capture immutable qualified build bytes under the existing build lock and expose reference-counted snapshots in `packages/gateway/src/app-runtime/build-cache.ts`
- [X] T014 Integrate exact snapshot capture and drift detection with the production build flow in `packages/gateway/src/app-runtime/build-orchestrator.ts`
- [X] T015 Add strict collaborative manifest, bridge-contract, runtime-ABI, and declared-schema validation in `packages/gateway/src/app-runtime/manifest-schema.ts`
- [X] T016 Implement readiness persistence with idempotent `ON CONFLICT`, CAS updates, bounded gate results, typed errors, and owner-only resource cleanup in `packages/gateway/src/collaboration/collaborative-app-readiness-repository.ts`
- [X] T017 Implement exact scope/build binding persistence, global data revisions, CAS rebind/stop, and ownership-aware lifecycle methods in `packages/gateway/src/collaboration/collaborative-app-share-repository.ts`
- [X] T018 Wire repository ownership and destruction into gateway startup/shutdown without allowing injected wrappers to close shared pools in `packages/gateway/src/startup/collaboration.ts`
- [X] T019 Add recurring reference-aware, symlink-safe immutable-build cleanup with bounded retention and cleared shutdown timers in `packages/gateway/src/app-runtime/build-cache.ts`
- [X] T020 Run the foundational contract, snapshot, and real-Postgres suites and record red/green plus migration rollback evidence using `tests/contracts/collaborative-app-sharing.test.ts`, `tests/gateway/app-runtime/collaborative-build-snapshot.test.ts`, `tests/gateway/collaborative-app-readiness-postgres.test.ts`, and `tests/gateway/collaborative-app-binding-postgres.test.ts`

**Checkpoint**: Exact identity cannot drift or reattach by slug, qualified assets are immutable, and readiness/binding persistence is transaction-ready.

---

## Phase 3: User Story 2 — Know Whether an App Is Ready (Priority: P1)

**Goal**: Certify only the exact app build that passes a two-principal production-path proof and return actionable safe reasons for ineligible apps.

**Independent Test**: Run readiness for a working Postgres-backed tracker and a browser-local app. Only the tracker receives a ready exact-build certificate; changing manifest, schema, assets, bridge ABI, or runtime ABI makes it stale while preserving owner records.

### Tests for User Story 2

- [X] T021 [P] [US2] Write failing readiness evaluator tests for declaration, exact build, owner Postgres, recipient launch, participant identity, retry, conflict, signal, provider safety, and cleanup gates in `tests/gateway/collaborative-app-readiness.test.ts`
- [X] T022 [P] [US2] Write failing route tests for owner auth, strict path/body schemas, pre-buffer body limits, idempotent replay, bounded errors, and no-store responses in `tests/gateway/collaborative-app-readiness-routes.test.ts`
- [X] T023 [P] [US2] Write a failing production-boundary readiness journey that rejects browser storage, broken recipient launch, unsafe provider use, duplicate retry, lost update, and missing signals, and returns blocked while the second-principal source is unconfigured, in `tests/gateway/collaborative-app-readiness-production-path.test.ts`
- [X] T024 [P] [US2] Write failing stale-certificate and same-slug replacement regression tests in `tests/gateway/collaborative-app-readiness-drift.test.ts`

### Implementation for User Story 2

- [X] T025 [US2] Implement the bounded readiness state machine and safe actionable gate mapping in `packages/gateway/src/collaboration/collaborative-app-readiness.ts`
- [X] T026 [US2] Implement the purpose-bound verifier interface and fail-closed unconfigured result; do not issue ready until the deferred second-principal identity source is approved, then use the real launch, bridge, Postgres, mutation, event, and tagged-cleanup paths in `packages/gateway/src/collaboration/collaborative-app-readiness.ts`
- [X] T027 [US2] Add owner-only GET/check routes with Zod boundaries, `bodyLimit`, per-actor rate limits, idempotency, no-store caching, and generic error mapping in `packages/gateway/src/collaboration/collaborative-app-readiness-routes.ts`
- [X] T028 [US2] Mount readiness routes and resolve every dependency at registration time in `packages/gateway/src/collaboration/routes.ts`
- [X] T029 [US2] Invalidate readiness after catalog deletion/replacement and exact input drift without treating compatible runtime restart as drift in `packages/gateway/src/collaboration/resource-catalog.ts`
- [X] T030 [US2] Block required app behavior that depends on creator credentials, connected providers, or AI funding under shared-provider policy in `packages/gateway/src/collaboration/shared-provider-readiness.ts`
- [X] T031 [P] [US2] Add checking, blocked, ready, stale, failed, and recheck client state with allowlisted bounded messages in `packages/ui/src/collaboration/useCollaborativeAppSharing.ts`
- [X] T032 [P] [US2] Add an actionable owner readiness summary that never displays raw verifier/provider/database errors in `packages/ui/src/collaboration/ReadinessSummary.tsx`
- [X] T033 [US2] Integrate readiness state into the owner app viewer without enabling share before a current ready certificate in `shell/src/components/AppViewer.tsx`
- [X] T034 [US2] Prove the independent readiness journey and record named red/green faults in `tests/gateway/collaborative-app-readiness-production-path.test.ts` and `tests/ui/collaborative-app-readiness.test.tsx`

**Checkpoint**: User Story 2 is independently usable: an owner gets one actionable result for the current exact build, and declaration-only or drifted apps fail closed.

---

## Phase 4: User Story 1 — Share and Use One Live App (Priority: P1) 🎯 MVP

**Goal**: Let an owner share one qualified exact app with one organization and let a current member discover and use the creator-hosted app against the same existing records.

**Independent Test**: With a ready tracker containing 20 tasks, create one organization share, open it as a second member, perform confirmed CRUD from both accounts, reload, and verify one record set; an outsider cannot discover HTML, assets, or data.

### Tests for User Story 1

- [X] T035 [P] [US1] Write failing preflight/create/get/stop contract tests for no project, role, grant, invitation, acceptance, or record-filter fields in `tests/gateway/collaborative-app-share-routes.test.ts`
- [X] T036 [P] [US1] Write failing real-Postgres atomicity/idempotency tests for scope, binding, owner invariant, operation, audit, event, and outbox creation in `tests/gateway/collaborative-app-share-postgres.test.ts`
- [X] T037 [P] [US1] Write failing platform discovery and launch tests for current members, typed app items, cursor bounds, proof-bound sessions, and outsider omission in `tests/platform/collaborative-app-discovery.test.ts`
- [ ] T038 [P] [US1] Write failing launch-facade security tests for session recheck, path confinement, immutable bytes, strict content types, `nosniff`, redirect rejection, stream limits, cancellation, and credential non-disclosure in `tests/platform/collaborative-app-launch-facade.test.ts`
- [ ] T039 [P] [US1] Write failing owner/recipient common-data tests for 20 existing rows, CRUD, reload, lost-response replay, and content-free change signals in `tests/gateway/collaborative-app-two-home-postgres.test.ts`
- [ ] T040 [P] [US1] Write failing shared-viewer transport tests proving recipients never fall back to a local same-slug app or owner credentials in `tests/ui/collaborative-app-viewer.test.tsx`

### Share lifecycle and discovery implementation

- [X] T041 [US1] Enable direct app preflight only for the current ready exact build while preserving legacy/project scope behavior in `packages/gateway/src/collaboration/standalone-resource-scope.ts`
- [X] T042 [US1] Atomically create/select the unique app scope and exact binding with operation, audit, event, and directory outbox writes in `packages/gateway/src/collaboration/scope-routes.ts`
- [X] T043 [US1] Add owner preflight/create/get/DELETE routes with confirmation binding, strict schemas, body limits, per-actor rate limits, revision predicates, replay, and safe errors in `packages/gateway/src/collaboration/collaborative-app-readiness-routes.ts`
- [X] T044 [US1] Project active app scopes as `current_membership` directory entries without activation or recipient rows in `packages/gateway/src/collaboration/directory-outbox.ts`
- [ ] T045 [US1] Add bounded and per-actor-rate-limited current-membership shared-app discovery and exact-build launch endpoints in `packages/platform/src/collaboration/routes.ts`
- [X] T046 [US1] Persist and query app/build/lifecycle routing metadata only, excluding owner app records and per-recipient grants, in `packages/platform/src/collaboration/repository.ts`
- [X] T047 [US1] Issue proof-key-bound owner-runtime tickets only after active share, current membership, exact readiness, and host checks in `packages/platform/src/collaboration/ticket-issuer.ts`

### Owner-hosted runtime and common-data implementation

- [ ] T048 [US1] Implement bounded launch-session TTL/LRU state, stale sweeps, revocation, and shutdown drain in `packages/platform/src/collaboration/relay.ts`
- [ ] T049 [US1] Implement the same-origin authenticated launch facade with per-request session/share/membership/build/host reauthorization in `packages/platform/src/collaboration/routes.ts`
- [ ] T050 [US1] Serve only immutable qualified assets with confined paths, bounded streams, cancellation, safe headers, and timed trusted-origin relay calls in `packages/gateway/src/collaboration/resource-routes.ts`
- [ ] T051 [US1] Inject bounded participant context and expose only the restricted parent-mediated data bridge in `packages/gateway/src/collaboration/collaborative-app-runtime.ts`
- [ ] T052 [US1] Route owner and recipient reads to the same bounded declared owner tables without using scope as a row namespace in `packages/gateway/src/collaboration/scoped-app-bridge.ts`
- [ ] T053 [US1] Route owner and recipient mutations through one transactional coordinator that commits data revision, mutation, operation receipt, audit, and event together in `packages/gateway/src/collaboration/collaborative-app-runtime.ts`
- [ ] T054 [US1] Emit bounded content-free app change signals and require client authoritative rereads in `packages/gateway/src/collaboration/events.ts`

### Recipient rendering and owner control implementation

- [ ] T055 [P] [US1] Add typed owner/shared transport, launch, read, write, retry, conflict, and signal reconciliation in `packages/ui/src/collaboration/shared-app-transport.ts`
- [ ] T056 [P] [US1] Add a mounted shared-app renderer with host attribution and safe overlays in `packages/ui/src/collaboration/SharedAppViewer.tsx`
- [ ] T057 [US1] Hydrate typed app cards in Shared with me and open shared targets without Chat/project or local-app fallback in `packages/ui/src/collaboration/ChatCollaboration.tsx`
- [ ] T058 [US1] Add direct Share app controls with one organization selector and existing-data/all-members/creator-host disclosures in `packages/ui/src/collaboration/CollaborativeAppShareDialog.tsx`

**Checkpoint**: User Story 1 is independently complete on the shared web renderer: one qualified owner app, one organization, one existing owner record set, and no recipient copy or secondary permission flow.

---

## Phase 5: User Story 3 — Work With the Organization (Priority: P2)

**Goal**: Derive full app access from fresh organization membership, handle newcomers/departures, and make retries/conflicts/revocation safe without app-specific roles or member rows.

**Independent Test**: Share with one organization, let two members use full functionality, add a newcomer, remove one member, and race two stale updates. The newcomer gains access automatically, the departed member loses every boundary, and one stale writer receives a recoverable conflict with no silent loss.

### Tests for User Story 3

- [X] T059 [P] [US3] Write failing authority tests for active exact share plus current membership, guest access, sharing by any member-owner, full functionality, no admin approval or Viewer/Editor mapping, and preserved legacy project roles in `tests/gateway/collaborative-app-authority.test.ts`
- [ ] T060 [P] [US3] Write failing newcomer/departed/wrong-org/outsider tests across discovery, launch, asset, read, write, subscribe, resume, broadcast, and reconnect in `tests/gateway/collaborative-app-membership-revocation.test.ts`
- [ ] T061 [P] [US3] Write failing concurrent-write and idempotency tests for revision predicates in the write statement, same-ID replay, different-payload rejection, uncertain outcome, and retained local input in `tests/gateway/collaborative-app-concurrency-postgres.test.ts`
- [ ] T062 [P] [US3] Write failing stop/rebind tests for scope/binding CAS, auth-epoch bump, post-commit session closure, event delivery, and owner-data retention in `tests/gateway/collaborative-app-stop-postgres.test.ts`

### Implementation for User Story 3

- [X] T063 [US3] Authorize new app scopes from active exact binding plus fresh organization membership while preserving existing project/grant semantics in `packages/gateway/src/collaboration/authority.ts`
- [X] T064 [US3] Map every current organization member including guests to full declared app functionality, allow every member to share an app they own, and create no recipient grant, permission, activation, invitation, approval, or role rows in `packages/gateway/src/collaboration/app-instance-adapter.ts`
- [ ] T065 [US3] Recheck bounded organization membership with explicit timeouts and generic failures at every owner-runtime admission boundary in `packages/gateway/src/collaboration/organization-membership-client.ts`
- [ ] T066 [US3] Enforce the global app `data_revision` predicate inside each mutation transaction and return bounded authoritative conflict metadata in `packages/gateway/src/collaboration/collaborative-app-runtime.ts`
- [ ] T067 [US3] Reuse stable request IDs and payload hashes for replay/uncertain outcomes without duplicate owner records in `packages/gateway/src/collaboration/scoped-app-bridge.ts`
- [ ] T068 [US3] Reauthorize event open, resume, broadcast, and reconnect; evict failed/dead senders and continue other subscribers in `packages/gateway/src/collaboration/event-websocket-route.ts`
- [ ] T069 [US3] CAS stop/rebind, bump auth epoch, commit operation/audit/event/outbox, then revoke direct/launch sessions and subscriptions in `packages/gateway/src/collaboration/collaborative-app-share-repository.ts`
- [ ] T070 [P] [US3] Preserve optimistic edits through conflict and uncertain-save states and require deliberate retry/reload in `packages/ui/src/collaboration/shared-app-transport.ts`
- [ ] T071 [US3] Prove newcomer, departure, conflict, retry, stop, and no-recipient-row outcomes at real gateway/platform/Postgres boundaries in `tests/e2e/collaborative-app-membership.spec.ts`

**Checkpoint**: User Story 3 is independently complete: organization membership is the only recipient authority and concurrency/revocation outcomes are explicit and recoverable.

---

## Phase 6: User Story 4 — Understand Host Availability (Priority: P2)

**Goal**: Show creator-hosted availability honestly, retain unsaved input while offline, and recover the same confirmed records after the owner runtime returns.

**Independent Test**: Save as a recipient, stop the owner runtime, keep typed input mounted behind a safe unavailable overlay, restart the owner runtime, reconnect, and verify all confirmed records remain.

### Tests for User Story 4

- [ ] T072 [P] [US4] Write failing host-offline/restart tests that distinguish availability from stopped access, readiness drift, membership loss, and replacement in `tests/platform/collaborative-app-host-availability.test.ts`
- [ ] T073 [P] [US4] Write failing Web Canvas/Desktop/mobile tests proving the iframe remains mounted and unsaved input survives offline, conflict, uncertain, recheck, and access-ended overlays in `tests/shell/collaborative-app-viewer.test.tsx`
- [ ] T074 [P] [US4] Write failing Electron tests proving the isolated `WebContentsView` uses the shared facade and remains mounted through offline/recovery in `tests/desktop/collaborative-app-embed.test.ts`

### Implementation for User Story 4

- [ ] T075 [US4] Return typed retryable host-offline outcomes without stopping the share or deleting readiness/binding/data state in `packages/platform/src/collaboration/relay.ts`
- [ ] T076 [P] [US4] Add a shared deep-link page that resolves only typed exact-build targets in `shell/src/app/shared/app/[scopeId]/page.tsx`
- [ ] T077 [US4] Refactor the web app viewer into common mounted rendering with owner and shared transports in `shell/src/components/AppViewer.tsx`
- [ ] T078 [P] [US4] Carry shared launch targets through Canvas, desktop windows, mobile launcher, and stable window deduplication in `shell/src/components/canvas/CanvasAppViewer.tsx`, `shell/src/components/desktop/DesktopWindow.tsx`, `shell/src/components/mobile/MobileShell.tsx`, and `shell/src/hooks/useWindowManager.ts`
- [ ] T079 [US4] Route the restricted shared bridge and safe lifecycle overlays without exposing owner tokens in `shell/src/lib/os-bridge.ts`
- [ ] T080 [P] [US4] Extend typed IPC so Electron distinguishes owner and shared exact-build launch targets in `desktop/src/shared/ipc-contract.ts`
- [ ] T081 [US4] Load the authenticated shared facade in the isolated embed and retain the `WebContentsView` across offline recovery in `desktop/src/main/embeds/app-launch.ts`, `desktop/src/main/embeds/native-app-bridge.ts`, and `desktop/src/renderer/src/features/embeds/EmbedHost.tsx`

**Checkpoint**: User Story 4 is independently complete across supported shells: host outage is retryable, confirmed data survives, and local input is not destroyed by transport state.

---

## Phase 7: Owner UX, Qualification, and Cross-Cutting Completion

**Purpose**: Complete the fifth Matrix OS stack layer, qualify the union, publish evidence, and create the sixth public-documentation deliverable.

- [ ] T082 [P] Add the Share app button as a distinct action from Gallery publication and public Sites in `packages/ui/src/collaboration/CollaborativeAppShareButton.tsx`
- [ ] T083 Complete the owner hook for readiness, preflight, create, current share, recheck, and stop with serializable state and stable selectors in `packages/ui/src/collaboration/useCollaborativeAppSharing.ts`
- [ ] T084 Show exactly one organization selector, active organization, Stop sharing, safe state copy, and no project/person/role/acceptance controls in `packages/ui/src/collaboration/CollaborativeAppShareDialog.tsx`
- [ ] T085 Export collaborative sharing UI and typed transport APIs from `packages/ui/src/index.ts`
- [ ] T086 [P] Add owner readiness/share/stop component tests and all required disclosures in `tests/ui/collaborative-app-sharing-controls.test.tsx`
- [ ] T087 [P] Add full owner/member/outsider Web Canvas and Web Desktop journeys with 20 preexisting rows, CRUD, reload, conflict, lost response, membership loss, stop, rebuild, and replacement in `tests/e2e/collaborative-app-sharing.spec.ts`
- [ ] T088 [P] Add responsive web-mobile sharing, recipient edit, conflict, offline, and recovery coverage in `tests/e2e/collaborative-app-sharing-mobile.spec.ts`
- [ ] T089 [P] Add Electron shared-app launch, common-record, offline/recovery, and retained-view coverage in `tests/e2e/app-collaborative-sharing-electron.e2e.test.ts`
- [ ] T090 Run focused suites, full Vitest, real-Postgres integration, shell production build, desktop build, and affected-package coverage exactly as listed in `specs/2689-collaborative-app-sharing/quickstart.md`; require 100% coverage for new collaborative-sharing code, no overall coverage regression, and no missing prerequisites or skipped required assertions
- [ ] T091 Qualify the final Matrix OS stack head on a disposable VPS with the exact bundle and actor/data/concurrency/restart matrix in `specs/2689-collaborative-app-sharing/quickstart.md`
- [ ] T092 Capture separate Web Canvas, Web Desktop, Electron Desktop, and web-mobile live evidence outside the repository, attach it to the final Matrix OS stack-head PR and Slack `#tech`, and record exact commit/build, ENG-29, scenarios, limitations, and Slack permalink as required by `specs/2689-collaborative-app-sharing/quickstart.md`
- [ ] T093 Record the Native Mobile V1 N/A architecture rationale and reviewer approval, and verify any listing says Open on web without claiming parity, in `specs/2689-collaborative-app-sharing/quickstart.md`
- [ ] T094 Open the sixth deliverable in `FinnaAI/matrix-os-site` with readiness, existing-record, organization access, creator hosting, retry/CAS/signals, identity/provider limits, stop behavior, and Gallery/Sites distinctions in `content/docs/apps/collaborative-app-sharing.mdx`

**Checkpoint**: Every Matrix OS stack PR is below 3,000 changed lines, green, and Greptile 5/5; the stack has at most ten Matrix OS PRs, the exact stack head passes live qualification on all supported surfaces, evidence is in the PR and Slack `#tech`, and the separate public docs PR matches the qualified behavior.

---

## Dependencies and Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: Starts immediately from the approved spec/plan.
- **Phase 2 — Foundation**: Depends on Phase 1 and blocks every story.
- **Phase 3 — US2 readiness**: Depends on Phase 2 and must land before any share can be created.
- **Phase 4 — US1 live sharing**: Depends on the current exact readiness certificate from Phase 3.
- **Phase 5 — US3 organization behavior**: Depends on the active share/runtime path from Phase 4; its test fixtures can be authored in parallel with late Phase 4 implementation.
- **Phase 6 — US4 host availability**: Depends on the shared launch/runtime path from Phase 4; its platform, shell, and Electron tests can be authored in parallel with Phase 5.
- **Phase 7 — Qualification/docs**: Depends on all desired stories and validates the exact stack-head union.

### User Story Dependency Graph

```text
Foundation
  └─ US2 exact-build readiness (P1)
       └─ US1 share and use one live app (P1, MVP outcome)
            ├─ US3 current-membership access and concurrency (P2)
            └─ US4 creator-host availability and recovery (P2)
                 └─ Stack-head qualification + public docs
```

US3 and US4 are independent after the US1 shared runtime exists and may proceed in parallel. Neither may weaken US1/US2 authorization, persistence, or exact-build invariants.

### Within Each User Story

1. Write the named production-boundary tests and capture the expected red failure.
2. Implement persistence/models before services, services before routes, and routes before UI integration.
3. Keep every multi-write state transition in one Kysely transaction with revision predicates in the write statement.
4. Run focused green tests, then the affected package/type/build lanes without skipped required assertions.
5. Complete the independent story test before advancing the dependent stack layer.

## Parallel Opportunities

- Phase 1 contract, fixture, and compatibility tasks marked `[P]` can run together.
- Phase 2 identity, immutable-build, readiness-repository, and binding-repository failing tests can run together before their paired implementations.
- US2 evaluator, route, production-path, and drift tests can run together.
- US1 gateway, platform, launch-facade, common-data, and viewer failing tests can run together; after backend contracts stabilize, transport and renderer tasks can proceed together.
- US3 authority, membership-revocation, concurrency, and stop tests can run together; safe client-state work can proceed beside backend revocation work.
- US4 platform, shell, and Electron failing tests can run together, followed by parallel web deep-link and IPC work.
- Phase 7 component, web, mobile, and Electron tests can run in parallel before one stack-head qualification pass.

## Parallel Execution Examples

### User Story 2

```text
T021 readiness evaluator fault matrix
T022 readiness route boundary/auth tests
T023 two-principal production-path readiness test
T024 drift and replacement regression tests
```

### User Story 1

```text
T035 share route contract tests
T036 atomic real-Postgres share tests
T037 platform discovery/launch tests
T038 launch-facade security tests
T039 common-data two-home tests
T040 shared-viewer transport tests
```

### User Story 3

```text
T059 current-membership authority tests
T060 revocation-at-every-boundary tests
T061 concurrent-write/idempotency tests
T062 stop/rebind transaction tests
```

### User Story 4

```text
T072 platform host-availability tests
T073 mounted web-renderer recovery tests
T074 mounted Electron WebContentsView recovery tests
```

## Implementation Strategy

### MVP First

The smallest trustworthy MVP is not declaration-only sharing. It is:

1. Complete Setup and Foundation.
2. Complete US2 exact-build readiness.
3. Complete US1 share/common-data/recipient-renderer outcome.
4. Stop and run the US1 independent test with two real principals and 20 preexisting owner records.

US3 membership transitions/concurrency hardening and US4 host-availability UX follow as additive P2 outcomes, but the feature is not release-qualified until all four stories and Phase 7 pass.

### Incremental Delivery

1. Exact-build compatibility foundation → no sharing enabled.
2. Readiness certificate → broken apps fail before sharing.
3. Organization share lifecycle → members discover the exact app.
4. Owner-hosted runtime/common data → confirmed CRUD and signals use one source of truth.
5. Supported shells and owner UX → recoverable multi-surface product journey.
6. Exact stack-head qualification and public docs → reviewable release candidate.

## GitHub Stack Plan

Use GitHub native stacks via `gh stack` and reuse ENG-29 in every layer. The five layers below are logical review boundaries, not a fixed PR count. Use the fewest Matrix OS PRs practical, keep each below the preferred 1,000 additions/20 files where possible, split before 3,000 changed lines or 50 files, and never exceed ten Matrix OS PRs. The separate public docs PR does not count toward ten. Every task has exactly one owning logical layer; dependencies are references, not duplicate ownership. Never flatten completed layers.

### Layer 1 — Exact-version readiness and compatibility foundation

- **Title**: `feat(collaboration): add exact-version app readiness`
- **Tasks**: T001–T030
- **Review boundary**: additive contracts, exact build identity/snapshots, migrations, readiness repository/evaluator/routes, compatibility, and readiness owner state.
- **Evidence**: contract/real-Postgres/production-path receipts; backend-only visual N/A requires architecture rationale and reviewer approval.

### Layer 2 — Organization-wide app share lifecycle and discovery

- **Title**: `feat(collaboration): enable organization app shares`
- **Tasks**: T035–T037, T041–T047, T059–T060, T062–T065, and T069
- **Review boundary**: preflight/create/get/stop, binding lifecycle, current-membership directory projection, discovery, tickets, and no recipient rows.
- **Evidence**: API/real-Postgres receipts; backend-only visual N/A requires reviewer approval.

### Layer 3 — Owner-hosted launch, data, concurrency, and realtime

- **Title**: `feat(collaboration): run shared apps on the owner host`
- **Tasks**: T038–T039, T048–T054, T061, T066–T068, and T070–T071
- **Review boundary**: authenticated launch facade, immutable assets, one mutation coordinator, CAS/idempotency, signals, reauthorization, revocation, and headless two-home journey.
- **Evidence**: real owner/platform/gateway/Postgres integration receipts; backend-only visual N/A requires reviewer approval.

### Layer 4 — Recipient experience on supported shells

- **Title**: `feat(shell): render owner-hosted shared apps`
- **Tasks**: T040, T055–T057, and T072–T081
- **Review boundary**: typed owner/shared targets, Shared with me hydration, common mounted renderer, web shells, deep links, Electron IPC/facade, and recoverable overlays.
- **Evidence**: separate live captures for Web Canvas, Web Desktop, Electron Desktop, and web mobile.

### Layer 5 — Owner controls and stack qualification

- **Title**: `feat(apps): add collaborative readiness and sharing controls`
- **Tasks**: T031–T034, T058, and T082–T093
- **Review boundary**: readiness/share/recheck/stop owner UX, disclosures, complete E2E/VPS qualification, evidence, and Native Mobile N/A approval.
- **Evidence**: exact stack-head owner/member/outsider captures for all four supported surfaces in the PR and Slack `#tech`.

### Separate public documentation repository

- **Repository**: `FinnaAI/matrix-os-site`
- **Title**: `docs(apps): explain collaborative app sharing`
- **Task**: T094
- **Review boundary**: public behavior, limitations, ownership/availability disclosures, safe write semantics, and distinctions from Gallery/Public Sites after the qualified contracts and copy stabilize.

## Completion Rules

- Every task remains unchecked until its named outcome and validation evidence exist.
- Every test task must show a meaningful red caused by missing production behavior and a green after implementation.
- Every backend layer must document source of truth, transaction/lock scope, orphan behavior, auth authority, and deferred scope in its PR body.
- Every layer links ENG-29, PR #3123/spec, and the GitHub native stack; every current head reaches Greptile 5/5 before merge.
- Visual evidence stays outside the repository and is attached to the relevant PR plus Slack `#tech`.
- The final Matrix OS stack head, not any isolated layer, is the only build that may claim complete feature qualification.
