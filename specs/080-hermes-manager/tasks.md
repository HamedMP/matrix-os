# Tasks: Hermes Manager

**Input**: Design documents from `/specs/080-hermes-manager/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required. The spec and constitution require TDD for setup, channel setup, messaging, approvals, auth refusal, secret isolation, stale-resource reconciliation, and duplicate-action prevention.

**Organization**: Tasks are grouped by user story so each phase can be implemented, tested, and reviewed independently. Each backend implementation phase starts with failing tests.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other marked tasks in the same phase after prerequisites are met
- **[Story]**: User story label for story phases only
- Every task includes exact file paths

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the Hermes Manager skeleton, app package, and test files without behavior.

- [ ] T001 Create gateway Hermes module barrel and empty source files in `packages/gateway/src/hermes/index.ts`, `packages/gateway/src/hermes/contracts.ts`, `packages/gateway/src/hermes/auth.ts`, `packages/gateway/src/hermes/repository.ts`, `packages/gateway/src/hermes/credential-store.ts`, `packages/gateway/src/hermes/bridge.ts`, `packages/gateway/src/hermes/event-hub.ts`, and `packages/gateway/src/hermes/routes.ts`
- [ ] T002 [P] Create gateway Hermes test files in `tests/gateway/hermes-routes.test.ts`, `tests/gateway/hermes-bridge.test.ts`, `tests/gateway/hermes-credential-store.test.ts`, `tests/gateway/hermes-event-hub.test.ts`, `tests/gateway/hermes-repository.test.ts`, `tests/gateway/hermes-auth.test.ts`, `tests/gateway/hermes-restart-recovery.test.ts`, and `tests/gateway/hermes-integration.test.ts`
- [ ] T003 [P] Create first-party app skeleton in `home/apps/hermes-manager/package.json`, `home/apps/hermes-manager/index.html`, `home/apps/hermes-manager/tsconfig.json`, `home/apps/hermes-manager/vite.config.ts`, `home/apps/hermes-manager/src/main.tsx`, `home/apps/hermes-manager/src/App.tsx`, `home/apps/hermes-manager/src/index.css`, and `home/apps/hermes-manager/src/matrix-os.d.ts`
- [ ] T004 [P] Add Hermes Manager manifest and icon placeholders in `home/apps/hermes-manager/matrix.json` and `home/system/icons/hermes-manager.svg`
- [ ] T005 [P] Create app test file `tests/default-apps/hermes-manager-app.test.tsx`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define contracts, redaction, auth, bounded resources, bridge dependency checks, and server mounting needed by all stories.

**Critical**: No user story work can begin until this phase is complete.

### Tests First

- [ ] T006 [P] Add failing contract/redaction/schema tests for status/config/channel/session DTOs in `tests/gateway/hermes-routes.test.ts`
- [ ] T007 [P] Add failing auth matrix tests for owner/operator/unauthorized access, including operator denial on owner-only config, credential, gateway action, and export routes in `tests/gateway/hermes-auth.test.ts`
- [ ] T008 [P] Add failing bridge dependency and typed error tests in `tests/gateway/hermes-bridge.test.ts`
- [ ] T009 [P] Add failing bounded subscriber/event retention tests in `tests/gateway/hermes-event-hub.test.ts`
- [ ] T010 [P] Add failing credential-store secret isolation tests in `tests/gateway/hermes-credential-store.test.ts`
- [ ] T010b [P] Add failing Kysely bootstrap/schema creation and repository interface tests in `tests/gateway/hermes-repository.test.ts`
- [ ] T010c [P] Add failing route-to-bridge integration test for app route -> mocked Hermes IPC/CLI bridge -> response wiring in `tests/gateway/hermes-integration.test.ts`

### Implementation

- [ ] T011 Implement Zod schemas, DTO types, constants, generic error helper, redaction guards, and route body limits in `packages/gateway/src/hermes/contracts.ts`
- [ ] T012 Implement Hermes owner/operator authorization helpers in `packages/gateway/src/hermes/auth.ts`
- [ ] T013 Implement file credential store with owner-scoped paths, async fs, atomic writes, and secret-free public metadata in `packages/gateway/src/hermes/credential-store.ts`
- [ ] T014 Implement repository interfaces, Kysely bootstrap/schema creation, and in-memory test doubles for installations, channels, sessions, approvals, capabilities, and operator events in `packages/gateway/src/hermes/repository.ts`
- [ ] T015 Implement `HermesBridge` interface, dependency resolution, timeout runner, typed errors, and redacted result validation in `packages/gateway/src/hermes/bridge.ts`
- [ ] T016 Implement bounded event hub with capped subscribers, stale eviction, failed-send eviction, retained event cap, and shutdown drain in `packages/gateway/src/hermes/event-hub.ts`
- [ ] T017 Implement route helpers for principal resolution, JSON parsing, generic error mapping, owner scope, and duplicate action lock scaffolding in `packages/gateway/src/hermes/routes.ts`
- [ ] T018 Mount Kysely-backed unavailable-safe `/api/hermes` routes in `packages/gateway/src/server.ts` and export Hermes module from `packages/gateway/src/index.ts`
- [ ] T019 Run focused foundation tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-integration.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-routes.test.ts`

**Checkpoint**: Hermes foundation is mounted, secret-safe, bounded, and route-testable with mocked Hermes.

---

## Phase 3: User Story 1 - Onboard Hermes In Matrix (Priority: P1) MVP

**Goal**: Owner can detect/configure Hermes, save model provider state server-side, and reach redacted readiness without shell commands.

**Independent Test**: From no config, save setup/model state through `/api/hermes`, reload status/config, and verify ready/degraded states plus zero browser-visible secrets.

### Tests First

- [ ] T020 [P] [US1] Add failing first-run status/config/setup route tests, including duplicate setup/model mutation guards, in `tests/gateway/hermes-routes.test.ts`
- [ ] T021 [P] [US1] Add failing model credential save/redaction tests in `tests/gateway/hermes-credential-store.test.ts`
- [ ] T022 [P] [US1] Add failing installation/setup-step repository tests in `tests/gateway/hermes-repository.test.ts`
- [ ] T023 [P] [US1] Add failing bridge status/config/model-provider tests in `tests/gateway/hermes-bridge.test.ts`
- [ ] T028 [P] [US1] Add failing restart/read-path stale readiness reconciliation tests in `tests/gateway/hermes-restart-recovery.test.ts`

### Implementation

- [ ] T024 [US1] Implement installation, setup-step, model-provider, and public config repository methods in `packages/gateway/src/hermes/repository.ts`
- [ ] T025 [US1] Implement Hermes status/config/model credential bridge methods in `packages/gateway/src/hermes/bridge.ts`
- [ ] T026 [US1] Implement `GET /api/hermes/status`, `GET /api/hermes/config`, `POST /api/hermes/config`, and `POST /api/hermes/credentials/model` with owner-only duplicate-action guards in `packages/gateway/src/hermes/routes.ts`
- [ ] T027 [US1] Add setup/model operator events and event-hub publishes in `packages/gateway/src/hermes/routes.ts`
- [ ] T029 [US1] Implement readiness reconciliation on main config/status reads in `packages/gateway/src/hermes/routes.ts` and `packages/gateway/src/hermes/repository.ts`
- [ ] T030 [US1] Run US1 tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-restart-recovery.test.ts`

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Connect Messaging Channels (Priority: P1)

**Goal**: Owner/operator can connect, verify, enable, disable, and recover Telegram and WhatsApp through redacted Matrix routes.

**Independent Test**: With Hermes configured, connect mocked Telegram and WhatsApp, disable/re-enable each, and verify generic failure handling and no secret leakage.

### Tests First

- [ ] T031 [US2] Add failing Telegram channel action and secret-store persistence tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T032 [US2] Add failing WhatsApp pairing/action, short-lived pairing display, and secret-store persistence tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T033 [US2] Add failing duplicate channel action lock tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T034 [P] [US2] Add failing channel bridge action tests in `tests/gateway/hermes-bridge.test.ts`
- [ ] T035 [P] [US2] Add failing channel repository/audit tests in `tests/gateway/hermes-repository.test.ts`
- [ ] T035b [P] [US2] Add failing stale channel/pairing reference reconciliation tests in `tests/gateway/hermes-restart-recovery.test.ts`

### Implementation

- [ ] T036 [US2] Implement messaging channel repository methods and operator event persistence in `packages/gateway/src/hermes/repository.ts`
- [ ] T037 [US2] Implement Hermes channel list/action bridge methods for Telegram and WhatsApp in `packages/gateway/src/hermes/bridge.ts`
- [ ] T038 [US2] Implement `GET /api/hermes/channels` and `POST /api/hermes/channels/:channelId/action` with discriminated action schemas and credential-store writes for server-side-only channel secrets in `packages/gateway/src/hermes/routes.ts`
- [ ] T039 [US2] Implement duplicate-action locks for channel connect, pairing, enable, disable, verify, and recover in `packages/gateway/src/hermes/routes.ts`
- [ ] T040 [US2] Publish redacted channel status and operator events through `packages/gateway/src/hermes/event-hub.ts`
- [ ] T041 [US2] Add recovery behavior for stale channel/pairing references on read paths in `packages/gateway/src/hermes/routes.ts`
- [ ] T042 [US2] Run US2 tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts`

**Checkpoint**: Telegram and WhatsApp P1 channel operations are route-testable and secret-safe.

---

## Phase 5: User Story 3 - Message Hermes From The App (Priority: P1)

**Goal**: Owner/operator can start/resume Hermes sessions, send prompts, stream events, observe tool activity, and resolve approvals.

**Independent Test**: Start a mocked Hermes session, stream assistant/tool events, resolve an approval once, reload, and verify the session is recoverable with bounded history.

### Tests First

- [ ] T043 [US3] Add failing session create/list/prompt route tests, including create-session `clientRequestId` idempotency and prompt retry dedupe, in `tests/gateway/hermes-routes.test.ts`
- [ ] T044 [US3] Add failing approval decision route and duplicate decision tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T045 [P] [US3] Add failing session stream retention and subscriber failure tests in `tests/gateway/hermes-event-hub.test.ts`
- [ ] T046 [P] [US3] Add failing Hermes session bridge tests for create/send/approval/recover in `tests/gateway/hermes-bridge.test.ts`
- [ ] T047 [P] [US3] Add failing restart recovery tests for stale session live refs in `tests/gateway/hermes-restart-recovery.test.ts`
- [ ] T047b [P] [US3] Add failing session/approval repository tests in `tests/gateway/hermes-repository.test.ts`

### Implementation

- [ ] T048 [US3] Implement session and approval repository methods in `packages/gateway/src/hermes/repository.ts`
- [ ] T049 [US3] Implement Hermes session create/send/approval/recover bridge methods in `packages/gateway/src/hermes/bridge.ts`
- [ ] T050 [US3] Implement `GET /api/hermes/sessions`, `POST /api/hermes/sessions`, `POST /api/hermes/sessions/:sessionId/prompt`, and `POST /api/hermes/approvals/:approvalId/decision` with persisted `clientRequestId` handling in `packages/gateway/src/hermes/routes.ts`
- [ ] T051 [US3] Implement `GET /api/hermes/events` EventSource stream with heartbeat and session event publishing in `packages/gateway/src/hermes/routes.ts` and `packages/gateway/src/hermes/event-hub.ts`
- [ ] T052 [US3] Add duplicate session-create, prompt, and approval lock handling in `packages/gateway/src/hermes/routes.ts`
- [ ] T053 [US3] Add session stale-resource reconciliation on main read paths in `packages/gateway/src/hermes/routes.ts` and `packages/gateway/src/hermes/repository.ts`
- [ ] T054 [US3] Run US3 tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts`

**Checkpoint**: Hermes messaging, streaming, and approvals work through Matrix routes with bounded state.

---

## Phase 6: User Story 4 - Operate Hermes As Matrix Orchestrator (Priority: P2)

**Goal**: Owner can inspect profiles/models/skills/toolsets, run health/restart/update actions, and manage Hermes as the Matrix orchestrator.

**Independent Test**: With mocked capabilities and gateway status, change defaults, run restart/health/update, and verify redacted operator events and readiness transitions.

### Tests First

- [ ] T055 [US4] Add failing capability list/default model tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T056 [US4] Add failing gateway restart/health/update action tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T057 [P] [US4] Add failing bridge capability/gateway action tests in `tests/gateway/hermes-bridge.test.ts`
- [ ] T057b [P] [US4] Add failing capability repository tests in `tests/gateway/hermes-repository.test.ts`

### Implementation

- [ ] T058 [US4] Implement capability repository methods in `packages/gateway/src/hermes/repository.ts`
- [ ] T059 [US4] Implement capability list and gateway action bridge methods in `packages/gateway/src/hermes/bridge.ts`
- [ ] T060 [US4] Implement `GET /api/hermes/capabilities` and `POST /api/hermes/gateway/action` in `packages/gateway/src/hermes/routes.ts`
- [ ] T061 [US4] Add duplicate restart/update locks and redacted operation progress events in `packages/gateway/src/hermes/routes.ts` and `packages/gateway/src/hermes/event-hub.ts`
- [ ] T062 [US4] Run US4 tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts`

**Checkpoint**: Hermes operational controls are owner-safe and tested.

---

## Phase 7: User Story 5 - Audit, Recover, And Learn Proper Use (Priority: P3)

**Goal**: Owner/operator can inspect redacted audit, export non-secret config, recover stale resources, and read Matrix-specific usage docs.

**Independent Test**: Trigger setup/channel/session/operator events, export config, run recovery, and verify no secrets/raw paths/errors are exposed.

### Tests First

- [ ] T063 [P] [US5] Add failing audit/export/recovery route tests in `tests/gateway/hermes-routes.test.ts`
- [ ] T064 [P] [US5] Add failing export redaction and audit retention tests in `tests/gateway/hermes-repository.test.ts`
- [ ] T064b [US5] Add failing recovery repository helper tests in `tests/gateway/hermes-repository.test.ts` after T064 updates the shared repository test file

### Implementation

- [ ] T065 [US5] Implement audit/export/recovery repository helpers in `packages/gateway/src/hermes/repository.ts`
- [ ] T066 [US5] Implement `GET /api/hermes/audit`, `GET /api/hermes/export`, and recovery action handling in `packages/gateway/src/hermes/routes.ts`
- [ ] T067 [US5] Add user docs for onboarding and everyday Hermes use in `www/content/docs/hermes.mdx`
- [ ] T068 [US5] Add developer wiring and recovery docs in `docs/platform/dev/hermes-manager.md`
- [ ] T069 [US5] Run US5 tests with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts`

**Checkpoint**: Audit/export/recovery/docs complete the supportability story.

---

## Phase 8: First-Party App UX And Packaging

**Purpose**: Deliver the usable Matrix app experience for the completed backend stories.

### Tests First

- [ ] T070 [P] Add failing app render/onboarding/channel/session tests in `tests/default-apps/hermes-manager-app.test.tsx`
- [ ] T070b Add failing operations, audit, recovery, and export app tests in `tests/default-apps/hermes-manager-app.test.tsx` after T070 updates the shared app test file
- [ ] T071 [P] Add failing default app manifest/icon test coverage in `tests/gateway/apps.test.ts`

### Implementation

- [ ] T072 Implement Hermes Manager API client with safe error handling and no raw server error display in `home/apps/hermes-manager/src/lib/api.ts`
- [ ] T073 [P] Implement shared view-model helpers for setup progress, channel grouping, session grouping, and status summaries in `home/apps/hermes-manager/src/lib/view-model.ts`
- [ ] T074 [P] Implement shadcn-style base components or local imports in `home/apps/hermes-manager/src/components/`
- [ ] T075 Implement onboarding, readiness, and model setup UI in `home/apps/hermes-manager/src/components/onboarding/OnboardingPanel.tsx`
- [ ] T076 Implement Telegram/WhatsApp channel cards and actions in `home/apps/hermes-manager/src/components/channels/ChannelControls.tsx`
- [ ] T077 Implement Hermes conversation, event stream, tool activity, and approval UI in `home/apps/hermes-manager/src/components/conversation/HermesConversation.tsx`
- [ ] T078 Implement operations, audit, recovery, and export UI in `home/apps/hermes-manager/src/components/operations/HermesOperations.tsx` and `home/apps/hermes-manager/src/components/audit/HermesAudit.tsx`
- [ ] T079 Style dense Canvas/Desktop-friendly layout with Tailwind in `home/apps/hermes-manager/src/index.css`
- [ ] T080 Finalize manifest permissions/build metadata in `home/apps/hermes-manager/matrix.json`
- [ ] T081 Finalize shipped icon in `home/system/icons/hermes-manager.svg`
- [ ] T081b Run app tests with `bun run test tests/default-apps/hermes-manager-app.test.tsx tests/gateway/apps.test.ts`
- [ ] T082 Run app build with `pnpm --dir home/apps/hermes-manager install --ignore-workspace --prefer-offline` and `pnpm --dir home/apps/hermes-manager build`
- [ ] T083 Run default app build with `node scripts/build-default-apps.mjs home/apps`

**Checkpoint**: Hermes Manager is installable and usable from Matrix app launcher.

---

## Phase 9: Polish, Review Gates, And Stack Publication

**Purpose**: Run required gates, split/publish Graphite stack, and fix review issues.

- [ ] T084 [P] Run `bun run check:patterns` and fix Hermes-related findings in changed files
- [ ] T085 [P] Run focused Hermes test suite with `bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-integration.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts tests/gateway/hermes-routes.test.ts tests/default-apps/hermes-manager-app.test.tsx tests/gateway/apps.test.ts`
- [ ] T086 Run `bun run typecheck` and fix Hermes-related failures
- [ ] T087 Run `git diff --check` and inspect changed-file trust boundaries against `docs/dev/review-pipeline.md`
- [ ] T088 Create Graphite stack layers following `docs/dev/stacked-prs.md` with semantic PR titles and no draft PRs
- [ ] T089 Add backend PR body invariants for each backend-changing Graphite layer
- [ ] T090 Inspect PR state and address actionable review/Greptile findings until all PRs are ready for coding-agent review

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: no dependencies.
- **Phase 2 Foundation**: depends on Phase 1 and blocks all user stories.
- **US1 Onboarding**: depends on Phase 2.
- **US2 Channels**: depends on Phase 2 and can run alongside US1 after shared contracts exist, but stack order places it after US1 for review clarity.
- **US3 Messaging**: depends on Phase 2 and event hub contracts; stack order places it after US2.
- **US4 Operations**: depends on Phase 2 and reuses US1 status/config patterns.
- **US5 Audit/Recovery/Docs**: depends on repository/event patterns from US1-US4.
- **App UX**: can start after the API client contract is stable, but final app tests depend on US1-US5 route contracts.
- **Polish/Publication**: depends on all selected implementation phases.

### Graphite Stack Plan

- **Stack 1**: `docs(hermes): specify manager app` for `spec.md`.
- **Stack 2**: `docs(hermes): plan manager implementation` for research, data model, contracts, quickstart, and plan.
- **Stack 3**: `docs(hermes): break down manager tasks` for `tasks.md`.
- **Stack 4**: `feat(hermes): add manager gateway foundation` for backend Phases 1-7, including auth, setup, channels, sessions, operations, audit, recovery, and tests.
- **Stack 5**: `feat(hermes): add first-party manager app` for Phase 8 app UX, icon, manifest, docs, default app build, and final validation.

If Stack 4 approaches the Matrix OS PR limits, split it before review into 4a Foundation/setup, 4b channels plus messaging, and 4c operations plus audit/recovery. Each split keeps its focused checkpoint command and backend invariants in the PR body.

Each layer must stay independently reviewable, under Matrix OS PR size limits, ready for review rather than draft, and must not be flattened unless explicitly requested.

### User Story Dependencies

- **US1 (P1)**: first MVP story; no dependency on other stories after foundation.
- **US2 (P1)**: independent channel slice after foundation; uses shared channel contracts.
- **US3 (P1)**: independent messaging slice after foundation; uses shared event hub.
- **US4 (P2)**: operations slice after foundation.
- **US5 (P3)**: supportability slice after prior event/repository patterns.

### Parallel Opportunities

- T002-T005 can run in parallel after T001 intent is clear.
- T006-T010, T010b, and T010c can run in parallel because they touch separate test files.
- T020-T023 plus T028, T031-T035b, T043-T047b, T055-T057b, T063-T064, and T070/T071 can run in parallel within their phases; run T064b after T064 because both update `tests/gateway/hermes-repository.test.ts`, and run T070b after T070 because both update `tests/default-apps/hermes-manager-app.test.tsx`.
- Route-test writers in the same phase are sequential despite the wider phase being parallel: run T031-T033 in order, run T043-T044 in order, and run T055-T056 in order because each pair edits `tests/gateway/hermes-routes.test.ts`.
- UI helper/component tasks T073-T074 can run in parallel with API client task T072 once contracts are stable.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2 foundation.
2. Complete US1 onboarding with route tests and readiness reconciliation.
3. Validate US1 independently before expanding to channels/messaging.

### Incremental Delivery

1. Foundation -> US1 onboarding.
2. Add US2 Telegram/WhatsApp channels.
3. Add US3 messaging/approvals/events.
4. Add US4/US5 operations, audit, recovery, docs.
5. Add polished first-party app and package it as the user-facing surface.

### Review Strategy

Use Graphite stacked PRs. Each layer gets focused tests, `check:patterns`, and a PR body with invariants where backend code changes. The final stack should be ready for review, not draft, so coding agents can continue from concrete PRs.

## Notes

- Do not expose Hermes secrets, raw provider errors, filesystem paths, or command output in any client response.
- Keep all Hermes process/API calls behind `HermesBridge`.
- Use `zod/v4`, Hono `bodyLimit`, async `fs/promises`, bounded Maps/Sets, and owner-scoped repository access.
- Continue on the current checked-out Graphite branch for each stack layer; do not switch checkouts unless the operator explicitly assigns a different workspace.
