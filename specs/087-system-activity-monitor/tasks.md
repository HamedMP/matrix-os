# Tasks: System Activity Monitor

**Input**: Design documents from `/specs/087-system-activity-monitor/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: TDD is mandatory for this feature. Test tasks are included before implementation tasks and must fail before corresponding implementation work begins.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish shared types, module boundaries, and built-in app entry points.

- [ ] T001 Create `packages/gateway/src/system-activity/types.ts` with ActivitySnapshot, MachineIdentity, ResourceSummary, ServiceStatus, ProcessSummary, CleanupCandidate, CleanupAction, CleanupHistoryEntry, and AutoCleanupPolicy DTO types.
- [ ] T002 Create `packages/gateway/src/system-activity/routes.ts` with placeholder Hono route factory and dependency interface wired for tests but not registered.
- [ ] T003 [P] Create `shell/src/stores/systemActivityStore.ts` with serializable initial state, refresh status, cleanup status, and error fields.
- [ ] T004 [P] Create `shell/src/components/system-activity/ActivityMonitorApp.tsx` as a minimal built-in app shell with loading and unavailable states.
- [ ] T005 Add the System Activity Monitor built-in app manifest/icon wiring in the existing shell built-in app registry files discovered during implementation.
- [ ] T006 Update `www/content/docs/guide/system-activity-monitor.mdx` with user-facing monitor and cleanup safety overview.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared collectors, route validation, error policy, and protected cleanup primitives that all user stories rely on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T007 [P] Add failing contract tests for `GET /api/system/activity`, `POST /api/system/activity/actions`, policy routes, history route, auth failures, generic errors, and body limits in `tests/gateway/system-activity-routes.test.ts`.
- [ ] T008 [P] Add failing collector tests for CPU, memory, cgroup memory decomposition, disk, pressure, service accounting, process limits, subprocess timeouts, and sanitized warnings in `tests/gateway/system-activity-collector.test.ts`.
- [ ] T009 [P] Add failing cleanup classifier tests for stale app servers, active app servers, zellij sessions, code-server, cache scopes, protected paths, candidate TTL, and bounded candidate cache in `tests/gateway/system-activity-cleanup.test.ts`.
- [ ] T010 [P] Add failing history/policy tests for owner-file atomic writes, bounded retention, malformed file handling, and safe generic errors in `tests/gateway/system-activity-history.test.ts`.
- [ ] T011 Implement host metric collectors with bounded readers and subprocess timeouts in `packages/gateway/src/system-activity/collector.ts`.
- [ ] T012 Implement service and process snapshot collection with allowlisted service ids, capped process rows, sanitized display names, and no raw command stderr in `packages/gateway/src/system-activity/collector.ts`.
- [ ] T013 Implement cleanup candidate cache with TTL, max size, opaque candidate ids, and shutdown drain in `packages/gateway/src/system-activity/cleanup.ts`.
- [ ] T014 Implement protected path helpers and cleanup policy/history owner-file persistence with atomic writes and symlink-safe cleanup in `packages/gateway/src/system-activity/history.ts`.
- [ ] T015 Implement Zod route schemas, `bodyLimit` on mutating endpoints, owner auth dependency checks, and generic error mapper in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T016 Register system activity routes at gateway startup with dependency resolution at registration time in `packages/gateway/src/server.ts`.

**Checkpoint**: Foundation ready - all user story slices can build on trusted collection, validation, and persistence.

---

## Phase 3: User Story 1 - Inspect My Matrix Computer (Priority: P1) MVP

**Goal**: Users can open a read-only monitor and understand their current machine, resource pressure, service health, and top processes.

**Independent Test**: Open the built-in monitor on a running Matrix computer and verify identity, release, CPU, RAM, disk, service, and process sections refresh without destructive actions.

### Tests for User Story 1

- [ ] T017 [P] [US1] Add failing shell store tests for refresh lifecycle, safe error strings, section-level unavailable states, and stable serializable state in `tests/shell/system-activity-app.test.tsx`.
- [ ] T018 [P] [US1] Add failing component tests for MachineSummary, ResourceMeters, ProcessTable, service health rendering, refresh button behavior, and no layout overlap in `tests/shell/system-activity-app.test.tsx`.

### Implementation for User Story 1

- [ ] T019 [US1] Implement `GET /api/system/activity` snapshot assembly and process limit handling in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T020 [P] [US1] Implement `MachineSummary.tsx` in `shell/src/components/system-activity/MachineSummary.tsx`.
- [ ] T021 [P] [US1] Implement `ResourceMeters.tsx` in `shell/src/components/system-activity/ResourceMeters.tsx`.
- [ ] T022 [P] [US1] Implement `ProcessTable.tsx` in `shell/src/components/system-activity/ProcessTable.tsx`.
- [ ] T023 [US1] Implement dashboard refresh, polling, abort handling, and safe client error capping in `shell/src/stores/systemActivityStore.ts`.
- [ ] T024 [US1] Wire `ActivityMonitorApp.tsx` into Canvas and Desktop built-in app handling in `shell/src/components/canvas/CanvasWindow.tsx` and `shell/src/components/Desktop.tsx`.
- [ ] T025 [US1] Add responsive Canvas-first layout polish and loading/empty states in `shell/src/components/system-activity/ActivityMonitorApp.tsx`.

**Checkpoint**: User Story 1 is fully functional as a read-only MVP.

---

## Phase 4: User Story 2 - Review Cleanup Suggestions (Priority: P2)

**Goal**: Users can see explainable cleanup suggestions without taking action.

**Independent Test**: Known stale and active fixtures produce correct suggestions and omissions.

### Tests for User Story 2

- [ ] T026 [P] [US2] Add failing classifier fixture tests for orphaned app servers with deleted executables, high-port listeners, no active connections, active zellij sessions, idle code-server, old bundles, and cache scopes in `tests/gateway/system-activity-cleanup.test.ts`.
- [ ] T027 [P] [US2] Add failing UI tests for cleanup suggestion cards, confidence/risk labels, estimated reclaim, confirmation affordance, and manual-review-only state in `tests/shell/system-activity-app.test.tsx`.

### Implementation for User Story 2

- [ ] T028 [US2] Implement stale app server, zellij, code-server, cache, and old-bundle cleanup classifiers in `packages/gateway/src/system-activity/cleanup.ts`.
- [ ] T029 [US2] Include cleanup suggestions in `GET /api/system/activity` only when requested and only after candidate cache registration in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T030 [P] [US2] Implement `CleanupSuggestions.tsx` with risk, confidence, target, reason, and estimated reclaim display in `shell/src/components/system-activity/CleanupSuggestions.tsx`.
- [ ] T031 [US2] Add suggestion rendering and disabled/manual-review states to `ActivityMonitorApp.tsx`.

**Checkpoint**: Users can inspect safe cleanup opportunities without mutating the runtime.

---

## Phase 5: User Story 3 - Clean Up Safely by Click (Priority: P3)

**Goal**: Users can execute approved cleanup suggestions and see audited results.

**Independent Test**: Each approved action affects only its target, active work remains intact, and cleanup history records the outcome.

### Tests for User Story 3

- [ ] T032 [P] [US3] Add failing action execution tests for stale app server stop, stale terminal session close, idle code-server restart, cache cleanup, old bundle pruning, already-clean targets, candidate mismatch, and generic errors in `tests/gateway/system-activity-cleanup.test.ts`.
- [ ] T033 [P] [US3] Add failing route tests for action schema validation, candidate expiry, confirmation mismatch, body limit, owner auth, history write, and refresh recommendation in `tests/gateway/system-activity-routes.test.ts`.
- [ ] T034 [P] [US3] Add failing UI tests for confirmation flow, pending state, result state, safe error display, and post-action refresh in `tests/shell/system-activity-app.test.tsx`.

### Implementation for User Story 3

- [ ] T035 [US3] Implement typed cleanup executors with idempotent already-clean handling in `packages/gateway/src/system-activity/cleanup.ts`.
- [ ] T036 [US3] Implement `POST /api/system/activity/actions` with candidate revalidation, confirmation checks, history writes, and generic errors in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T037 [US3] Implement cleanup history query endpoint in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T038 [US3] Implement confirmation and action submission flow in `CleanupSuggestions.tsx` and `systemActivityStore.ts`.
- [ ] T039 [US3] Add cleanup history summary UI in `ActivityMonitorApp.tsx`.

**Checkpoint**: Manual cleanup is safe, typed, audited, and visible.

---

## Phase 6: User Story 4 - Enable Automatic Cleanup Policy (Priority: P4)

**Goal**: Users can opt into conservative automatic cleanup and review actions.

**Independent Test**: Auto-clean handles only enabled high-confidence stale classes after grace period and records every action.

### Tests for User Story 4

- [ ] T040 [P] [US4] Add failing auto-clean policy tests for disabled default, allowed type validation, grace period, rate limiting, active-resource skip, and shutdown drain in `tests/gateway/system-activity-cleanup.test.ts`.
- [ ] T041 [P] [US4] Add failing policy UI tests for enable/disable, allowed type controls, grace period display, and history visibility in `tests/shell/system-activity-app.test.tsx`.

### Implementation for User Story 4

- [ ] T042 [US4] Implement auto-clean policy read/update routes with body limits and bounded validation in `packages/gateway/src/system-activity/routes.ts`.
- [ ] T043 [US4] Implement conservative auto-clean scheduler with TTL/rate limits and shutdown drain in `packages/gateway/src/system-activity/cleanup.ts`.
- [ ] T044 [US4] Implement policy controls and auto-clean history indicators in `ActivityMonitorApp.tsx`.
- [ ] T045 [US4] Document auto-clean safety, defaults, and rollback guidance in `www/content/docs/guide/system-activity-monitor.mdx`.

**Checkpoint**: Automatic cleanup is opt-in, conservative, and auditable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validation, operations docs, release readiness, and review hardening.

- [ ] T046 [P] Run and fix focused gateway tests in `tests/gateway/system-activity-collector.test.ts`, `tests/gateway/system-activity-cleanup.test.ts`, `tests/gateway/system-activity-routes.test.ts`, and `tests/gateway/system-activity-history.test.ts`.
- [ ] T047 [P] Run and fix focused shell tests in `tests/shell/system-activity-app.test.tsx`.
- [ ] T048 Run `bun run typecheck` and fix all issues.
- [ ] T049 Run `bun run check:patterns` and fix all violations.
- [ ] T050 Run `bun run test` or document exact unrelated failures.
- [ ] T051 Run `npx react-doctor@latest shell` and resolve findings for React changes.
- [ ] T052 Validate quickstart flows on a disposable customer VPS and update `specs/087-system-activity-monitor/quickstart.md`.
- [ ] T053 Add PR body invariants for source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, and deferred scope in the GitHub PR description.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **US1 Read-only Monitor (Phase 3)**: Depends on Foundational; MVP.
- **US2 Cleanup Suggestions (Phase 4)**: Depends on Foundational and benefits from US1 UI surfaces.
- **US3 Manual Cleanup (Phase 5)**: Depends on US2 candidates.
- **US4 Automatic Cleanup (Phase 6)**: Depends on US3 audited manual cleanup.
- **Polish (Phase 7)**: Depends on implemented story phases.

### Graphite Stack Plan

This feature should ship as a stacked series, not one oversized PR:

- **Stack 1**: Spec Kit artifacts only: `specs/087-system-activity-monitor/**`, `.specify/feature.json`, and agent context update.
- **Stack 2**: Gateway read-only collector, route scaffolding, contracts, and US1 backend tests.
- **Stack 3**: Shell built-in read-only System Activity Monitor UI for Canvas and Desktop.
- **Stack 4**: Cleanup suggestions and classifier tests.
- **Stack 5**: Manual cleanup actions and cleanup history.
- **Stack 6**: Opt-in automatic cleanup policy and operations docs.

Each layer should stay below Matrix OS PR size limits and follow `docs/dev/stacked-prs.md`.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational; no dependency on cleanup.
- **User Story 2 (P2)**: Starts after Foundational; can be backend-first while US1 UI lands.
- **User Story 3 (P3)**: Requires US2 candidates.
- **User Story 4 (P4)**: Requires US3 action execution and history.

### Parallel Opportunities

- T003, T004, and T006 can run in parallel after T001.
- T007-T010 can run in parallel.
- T020-T022 can run in parallel after T019 contract shape is stable.
- T026 and T027 can run in parallel.
- T032-T034 can run in parallel.
- T040 and T041 can run in parallel.

## Parallel Example: User Story 1

```bash
Task: "T020 [US1] Implement MachineSummary.tsx in shell/src/components/system-activity/MachineSummary.tsx"
Task: "T021 [US1] Implement ResourceMeters.tsx in shell/src/components/system-activity/ResourceMeters.tsx"
Task: "T022 [US1] Implement ProcessTable.tsx in shell/src/components/system-activity/ProcessTable.tsx"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup.
2. Complete Foundational collectors and route validation.
3. Complete US1 read-only dashboard.
4. Stop and validate on local dev plus one disposable VPS.

### Incremental Delivery

1. Ship read-only dashboard.
2. Add suggestions without mutation.
3. Add manual cleanup with confirmation and audit.
4. Add opt-in automatic cleanup only after manual cleanup proves safe.

### Notes

- Do not introduce arbitrary process kill or arbitrary path deletion.
- Do not use Docker Compose as the production customer runtime path.
- Do not expose raw command output, filesystem paths, stack traces, provider names, or database/systemd errors to clients.
- Keep UI state serializable and selectors stable.
- Use Canvas as the primary manual verification surface before Desktop.
