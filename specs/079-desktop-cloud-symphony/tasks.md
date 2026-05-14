# Tasks: Desktop Cloud Symphony

**Input**: Design documents from `specs/079-desktop-cloud-symphony/`  
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. Matrix OS TDD applies: write tests first and verify they fail before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and stacked PR delivery.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add desktop workspace/package scaffolding and shared test harness without product behavior.

- [X] T001 Create `apps/desktop/package.json` with Electron scripts and workspace metadata
- [X] T002 Create `apps/desktop/tsconfig.node.json` for strict Electron main/preload TypeScript
- [X] T003 Create `apps/desktop/electron.vite.config.ts` for main/preload bundling
- [X] T004 Create `apps/desktop/electron-builder.yml` for macOS/Linux/Windows package metadata based on Slay Zone release conventions
- [X] T005 Add `dev:desktop` and `build:desktop` scripts to `package.json`
- [X] T006 Run `pnpm install` from repository root and update `pnpm-lock.yaml`
- [X] T007 [P] Create desktop test directory `tests/desktop/README.md`
- [X] T008 [P] Create gateway ticket test fixture helper `tests/gateway/tickets-fixtures.ts`
- [X] T009 [P] Create shell desktop test fixture helper `tests/shell/desktop-fixtures.tsx`

**Checkpoint**: Desktop package exists, lockfile is updated, no product behavior added.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define contracts and security foundations that every user story depends on.

**Critical**: No user story implementation should begin until this phase is complete.

- [X] T010 [P] Write failing desktop runtime policy tests in `tests/desktop/runtime-policy.test.ts`
- [X] T011 [P] Write failing desktop navigation security tests in `tests/desktop/navigation-policy.test.ts`
- [X] T012 [P] Write failing gateway desktop runtime route tests in `tests/gateway/desktop-runtime-routes.test.ts`
- [X] T013 [P] Write failing cloud-only agent policy tests in `tests/gateway/cloud-agent-policy.test.ts`
- [X] T014 Create `apps/desktop/src/main/config.ts` with validated Matrix instance configuration
- [X] T015 Create `apps/desktop/src/main/security.ts` with allowed shell/navigation/external URL policy
- [X] T016 Create `apps/desktop/src/preload/index.ts` exposing only the Matrix desktop bridge contract
- [X] T017 Create `apps/desktop/src/preload/index.d.ts` with `window.matrixDesktop` types
- [X] T018 Create `apps/desktop/src/main/index.ts` with hardened BrowserWindow defaults and Matrix shell loading
- [X] T019 Create `packages/gateway/src/desktop/contracts.ts` with Zod schemas for runtime policy responses
- [X] T020 Create `packages/gateway/src/desktop/runtime-policy.ts` enforcing `agentExecution.mode = "cloud"`
- [X] T021 Create `packages/gateway/src/desktop/routes.ts` with `GET /api/desktop/runtime`
- [X] T022 Wire desktop runtime routes in `packages/gateway/src/server.ts`
- [X] T023 Update exported gateway surface in `packages/gateway/src/index.ts`
- [X] T024 Add safe client error helper for desktop-facing stores in `shell/src/lib/desktop-runtime.ts`

**Checkpoint**: Desktop shell can load Matrix and server policy enforces cloud-only execution.

---

## Phase 3: User Story 1 - Launch Matrix As A Desktop Workbench (Priority: P1) MVP

**Goal**: Native desktop app opens Matrix shell/app launcher as the primary workbench.

**Independent Test**: Run desktop against local Matrix, open launcher, launch five apps, restart, and verify shell state returns.

### Tests for User Story 1

- [X] T025 [P] [US1] Write failing desktop app launch test in `tests/desktop/app-launch.test.ts`
- [X] T026 [P] [US1] Write failing shell app-launcher and default-app desktop affordance test in `tests/shell/desktop-app-launcher.test.tsx`
- [X] T027 [P] [US1] Write failing desktop state restore test in `tests/desktop/window-state.test.ts`

### Implementation for User Story 1

- [X] T028 [US1] Implement Matrix shell URL loading and reconnect state in `apps/desktop/src/main/index.ts`
- [X] T029 [US1] Implement local desktop window-state persistence in `apps/desktop/src/main/config.ts`
- [X] T030 [US1] Add desktop runtime detection helper in `shell/src/lib/desktop-runtime.ts`
- [X] T031 [US1] Update shell launcher affordances for desktop runtime in `shell/src/components/CommandPalette.tsx`
- [X] T032 [US1] Verify built-in app routing and desktop-aware default-app presentation stays Canvas/Desktop compatible in `shell/src/components/Desktop.tsx`
- [X] T033 [US1] Add desktop launcher and default-app native-affordance coverage for built-ins in `tests/shell/desktop-app-launcher.test.tsx`

**Checkpoint**: User Story 1 is independently usable as Matrix Desktop MVP.

---

## Phase 4: User Story 2 - Work On Cloud Development Projects (Priority: P1)

**Goal**: Desktop workbench manages cloud projects, worktrees, sessions, previews, and artifacts with no local agent execution.

**Independent Test**: Create/open a cloud worktree, observe a session, start a preview, and verify no local agent process starts.

### Tests for User Story 2

- [X] T034 [P] [US2] Write failing workspace cloud-only test in `tests/gateway/workspace-cloud-only.test.ts`
- [X] T035 [P] [US2] Write failing worktree/session desktop contract test in `tests/gateway/workspace-desktop-contract.test.ts`
- [X] T036 [P] [US2] Write failing workspace UI cloud runtime test in `tests/shell/workspace-cloud-runtime.test.tsx`
- [X] T037 [P] [US2] Write failing repository workflow setup tests in `tests/gateway/project-workflow.test.ts`
- [X] T038 [P] [US2] Write failing cloud preview/browser URL, SSRF, and redirect policy tests in `tests/gateway/project-previews.test.ts`

### Implementation for User Story 2

- [X] T039 [US2] Extend workspace session request schemas with cloud-only policy checks in `packages/gateway/src/workspace-routes.ts`
- [X] T040 [US2] Add cloud runtime policy enforcement to `packages/gateway/src/workspace-session-orchestrator.ts`
- [X] T041 [US2] Add safe cloud session status projection in `packages/gateway/src/workspace-event-publisher.ts`
- [X] T042 [US2] Update workspace UI to show cloud runtime state in `shell/src/components/workspace/WorkspaceApp.tsx`
- [X] T043 [US2] Add cloud session attach/observe controls in `shell/src/components/workspace/WorkspaceApp.tsx`
- [X] T044 [US2] Add disconnected/reconnecting cloud state handling in `shell/src/components/ConnectionIndicator.tsx`
- [X] T045 [US2] Create project workflow contracts in `packages/gateway/src/workflow/contracts.ts`
- [X] T046 [US2] Create project workflow repository/service in `packages/gateway/src/workflow/repository.ts`
- [X] T047 [US2] Create project workflow routes in `packages/gateway/src/workflow/routes.ts`
- [X] T048 [US2] Add preview/browser URL policy, SSRF filtering, redirect validation, timeouts, and sanitized preview refs in `packages/gateway/src/workflow/preview-policy.ts`
- [X] T049 [US2] Add workflow setup UI to `shell/src/components/workspace/WorkspaceApp.tsx`

**Checkpoint**: Cloud development workbench is usable without local coding-agent binaries.

---

## Phase 5: User Story 3 - Sync And Manage Tickets From Linear And Matrix (Priority: P1)

**Goal**: Unified tracked-ticket board/list for Linear and Matrix-native internal tickets.

**Independent Test**: Sync Linear tickets, create Matrix tickets, update metadata, and verify source identity/deduplication.

### Tests for User Story 3

- [X] T050 [P] [US3] Write failing ticket repository tests in `tests/gateway/tickets-repository.test.ts`
- [X] T051 [P] [US3] Write failing Linear sync deduplication and 100-ticket scale tests in `tests/gateway/tickets-linear-sync.test.ts`
- [X] T052 [P] [US3] Write failing internal ticket route tests in `tests/gateway/tickets-routes.test.ts`
- [X] T053 [P] [US3] Write failing unified ticket UI and 200-ticket board scale tests in `tests/shell/unified-tickets.test.tsx`

### Implementation for User Story 3

- [X] T054 [US3] Create ticket contracts and Zod schemas in `packages/gateway/src/tickets/contracts.ts`
- [X] T055 [US3] Create Kysely ticket repository in `packages/gateway/src/tickets/internal-repository.ts`
- [X] T056 [US3] Create Linear sync service in `packages/gateway/src/tickets/linear-sync.ts`
- [X] T057 [US3] Create bounded ticket status hub in `packages/gateway/src/tickets/status-hub.ts`
- [X] T058 [US3] Create ticket REST routes in `packages/gateway/src/tickets/routes.ts`
- [X] T059 [US3] Wire ticket routes into `packages/gateway/src/server.ts`
- [X] T060 [US3] Add unified ticket client helpers in `shell/src/lib/tickets.ts`
- [X] T061 [US3] Add unified ticket board/list surface in `shell/src/components/workspace/WorkspaceApp.tsx`
- [X] T062 [US3] Add ticket source/status display coverage in `tests/shell/unified-tickets.test.tsx`

**Checkpoint**: Linear and Matrix-native tickets share one desktop workbench surface.

---

## Phase 6: User Story 4 - Assign Tickets To Matrix Symphony (Priority: P1)

**Goal**: Manual and rule-based ticket assignment to Symphony creates cloud worktree/session claims safely.

**Independent Test**: Assign Linear and Matrix tickets to Symphony, verify one active claim per ticket, observe status, stop/retry, and survive restart.

### Tests for User Story 4

- [ ] T063 [P] [US4] Write failing Symphony assignment tests in `tests/gateway/symphony-ticket-assignment.test.ts`
- [ ] T064 [P] [US4] Write failing duplicate claim tests in `tests/gateway/symphony-claim-idempotency.test.ts`
- [ ] T065 [P] [US4] Write failing Symphony restart recovery tests in `tests/gateway/symphony-desktop-recovery.test.ts`
- [ ] T066 [P] [US4] Write failing Symphony desktop UI tests in `tests/default-apps/symphony-desktop-app.test.tsx`
- [ ] T067 [P] [US4] Write failing Codex readiness tests in `tests/gateway/symphony-codex-readiness.test.ts`

### Implementation for User Story 4

- [ ] T068 [US4] Extend Symphony contracts for normalized ticket sources in `packages/gateway/src/symphony/contracts.ts`
- [ ] T069 [US4] Extend Symphony repository for unified ticket run links in `packages/gateway/src/symphony/repository.ts`
- [ ] T070 [US4] Extend Symphony orchestrator assignment path in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T071 [US4] Add manual ticket assignment route in `packages/gateway/src/symphony/routes.ts`
- [ ] T072 [US4] Add automatic assignment rule routes in `packages/gateway/src/symphony/routes.ts`
- [ ] T073 [US4] Add duplicate cloud claim prevention in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T074 [US4] Add Codex cloud readiness checks to Symphony setup in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T075 [US4] Update Symphony app for unified ticket assignment in `home/apps/symphony/src/App.tsx`
- [ ] T076 [US4] Update Symphony app styles for desktop workbench density in `home/apps/symphony/src/index.css`

**Checkpoint**: Symphony can claim Linear and Matrix tickets into cloud work safely.

---

## Phase 7: User Story 5 - Operate A Slay-Like Developer Command Center (Priority: P2)

**Goal**: Add Slay-like tabs, panels, artifacts, previews, automations, and status workflows on top of the P1 foundation.

**Independent Test**: Complete a multi-ticket development loop from desktop without using Slay Zone.

### Tests for User Story 5

- [ ] T077 [P] [US5] Write failing task workbench tab tests in `tests/shell/task-workbench-tabs.test.tsx`
- [ ] T078 [P] [US5] Write failing agent status panel tests in `tests/shell/cloud-agent-status-panel.test.tsx`
- [ ] T079 [P] [US5] Write failing ticket artifacts/previews tests in `tests/shell/ticket-resources.test.tsx`
- [ ] T080 [P] [US5] Write failing automation route tests in `tests/gateway/ticket-automations.test.ts`

### Implementation for User Story 5

- [ ] T081 [US5] Create serializable task workbench store in `shell/src/stores/task-workbench.ts`
- [ ] T082 [US5] Create task workbench tab UI in `shell/src/components/workspace/TaskWorkbenchTabs.tsx`
- [ ] T083 [US5] Create cloud agent status panel in `shell/src/components/workspace/CloudAgentStatusPanel.tsx`
- [ ] T084 [US5] Add ticket artifacts/previews panel in `shell/src/components/workspace/TicketResourcesPanel.tsx`
- [ ] T085 [US5] Create ticket automation contracts in `packages/gateway/src/tickets/automation-contracts.ts`
- [ ] T086 [US5] Create ticket automation routes in `packages/gateway/src/tickets/automation-routes.ts`
- [ ] T087 [US5] Wire Slay-like workbench panels into `shell/src/components/workspace/WorkspaceApp.tsx`

**Checkpoint**: Desktop has the core Slay-like command-center workflows.

---

## Phase 8: User Story 6 - Administer Security, Cloud Policy, And Desktop Distribution (Priority: P2)

**Goal**: Owner/admin controls desktop connection, cloud policy, ticket sources, operator access, updates, telemetry, and recovery.

**Independent Test**: Configure desktop/runtime settings, verify cloud-only policy cannot be disabled, revoke access, simulate update/reconnect/failure states.

### Tests for User Story 6

- [ ] T088 [P] [US6] Write failing desktop settings tests in `tests/shell/desktop-settings.test.tsx`
- [ ] T089 [P] [US6] Write failing operator authorization tests in `tests/gateway/desktop-operator-auth.test.ts`
- [ ] T090 [P] [US6] Write failing safe error display tests in `tests/shell/desktop-safe-errors.test.tsx`
- [ ] T091 [P] [US6] Write failing desktop packaging config tests in `tests/desktop/package-config.test.ts`
- [ ] T092 [P] [US6] Write failing release workflow policy tests in `tests/desktop/release-workflow-policy.test.ts`

### Implementation for User Story 6

- [ ] T093 [US6] Add desktop settings and Slay onboarding/import guidance section in `shell/src/components/settings/sections/DesktopSection.tsx`
- [ ] T094 [US6] Wire desktop settings into `shell/src/components/Settings.tsx`
- [ ] T095 [US6] Add operator authorization helpers in `packages/gateway/src/desktop/runtime-policy.ts`
- [ ] T096 [US6] Add desktop-safe error allowlist helper in `shell/src/lib/desktop-runtime.ts`
- [ ] T097 [US6] Finalize desktop packaging metadata in `apps/desktop/electron-builder.yml`
- [ ] T098 [US6] Add desktop update/channel display in `shell/src/components/settings/sections/DesktopSection.tsx`
- [ ] T099 [US6] Add Slay-style desktop release workflow in `.github/workflows/desktop-release.yml`
- [ ] T100 [US6] Add reusable desktop release foundation workflow in `.github/workflows/desktop-release-foundation.yml`
- [ ] T101 [US6] Add release asset manifest/checksum scripts in `scripts/release/desktop/`

---

## Phase 9: User Story 7 - Collaborate On Shared Team Boards (Priority: P3)

**Goal**: Shared Matrix boards allow teammates to see/assign tickets and run authorized Symphony runners.

**Independent Test**: Add two Matrix users to one project board, assign tickets to each, and verify per-user Symphony claim permissions.

### Tests for User Story 7

- [ ] T102 [P] [US7] Write failing shared board membership tests in `tests/gateway/shared-board-membership.test.ts`
- [ ] T103 [P] [US7] Write failing shared board authorization tests in `tests/gateway/shared-board-auth.test.ts`
- [ ] T104 [P] [US7] Write failing shared board UI tests in `tests/shell/shared-board.test.tsx`

### Implementation for User Story 7

- [ ] T105 [US7] Create shared board contracts in `packages/gateway/src/boards/contracts.ts`
- [ ] T106 [US7] Create board membership service in `packages/gateway/src/boards/membership.ts`
- [ ] T107 [US7] Create board membership routes in `packages/gateway/src/boards/routes.ts`
- [ ] T108 [US7] Wire shared board authorization into ticket routes in `packages/gateway/src/tickets/routes.ts`
- [ ] T109 [US7] Wire per-user Symphony claim authorization into `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T110 [US7] Add shared board UI affordances in `shell/src/components/workspace/WorkspaceApp.tsx`

**Checkpoint**: Shared team-board authorization and per-user Symphony claims are ready for broader validation.

---

## Phase 10: Documentation, Parity Map, And Validation

**Purpose**: Document Slay parity, cloud-only differences, and run required gates.

- [ ] T111 [P] Add desktop setup documentation in `docs/dev/desktop.md`
- [ ] T112 [P] Add public desktop user docs in `www/content/docs/desktop.mdx`
- [ ] T113 [P] Update Symphony docs for desktop assignment in `www/content/docs/symphony.mdx`
- [ ] T114 [P] Update developer Symphony docs in `docs/dev/symphony.md`
- [ ] T115 [P] Add Slay Zone parity map in `docs/dev/desktop-slay-parity.md`
- [ ] T116 [P] Add desktop release documentation in `docs/dev/desktop-release.md`
- [ ] T117 Run `bun run typecheck` from repository root
- [ ] T118 Run `bun run check:patterns:diff` from repository root
- [ ] T119 Run focused test suites from `specs/079-desktop-cloud-symphony/quickstart.md`
- [ ] T120 Run desktop app smoke flow from `specs/079-desktop-cloud-symphony/quickstart.md`
- [ ] T121 Run desktop release dry-run workflow or local equivalent and record artifact results
- [ ] T122 Record residual gaps and validation notes in `specs/079-desktop-cloud-symphony/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Phase 1 and blocks all user stories.
- **Phase 3 US1**: Depends on Phase 2. MVP desktop shell.
- **Phase 4 US2**: Depends on Phase 2 and can run after or alongside US1 once shell hooks are stable.
- **Phase 5 US3**: Depends on Phase 2. Independent backend/UI ticket slice.
- **Phase 6 US4**: Depends on US2 and US3 because assignment needs cloud sessions and unified tickets.
- **Phase 7 US5**: Depends on US1-US4.
- **Phase 8 US6**: Depends on Phase 2; can run alongside US5 after runtime policy exists.
- **Phase 9 US7**: Depends on US3 and US4; can be deferred until personal board flow is stable.
- **Phase 10 Validation**: Depends on selected implementation phases.

### Graphite Stack Plan

Use Graphite `gt` for all implementation PRs. Do not flatten this stack unless explicitly requested.

```bash
gt sync
gt stack
```

Suggested stack:

- **Stack 1**: Phase 1 + Phase 2 shared desktop/runtime scaffolding.
- **Stack 2**: Phase 3 Matrix desktop shell/app launcher MVP.
- **Stack 3**: Phase 4 cloud development workspace/session controls.
- **Stack 4**: Phase 5 unified Linear + Matrix-native tickets.
- **Stack 5**: Phase 6 Symphony assignment and duplicate claim prevention.
- **Stack 6**: Phase 7 Slay-like command-center panels.
- **Stack 7**: Phase 8 admin/security/distribution controls and Slay-style release automation.
- **Stack 8**: Phase 9 shared team boards.
- **Stack 9**: Phase 10 docs, parity map, validation notes.

Each stack layer must remain independently reviewable, use Conventional Commit PR titles, and stay under the limits in `docs/dev/review-pipeline.md`.

### Parallel Opportunities

- T007-T009 can run in parallel after T001-T006.
- T010-T013 can run in parallel before T014-T024.
- Tests inside each user story can run in parallel.
- US2 and US3 can progress in parallel after Phase 2.
- US5 and US6 can progress in parallel after the P1 slices are stable.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 only.
3. Validate desktop opens Matrix shell and app launcher with cloud-only runtime policy.
4. Submit Stack 1 and Stack 2 before expanding scope.

### Incremental Delivery

1. Add cloud workspaces/sessions (US2).
2. Add unified tickets (US3).
3. Add Symphony assignment (US4).
4. Add Slay-like command-center depth (US5).
5. Add admin/distribution/release polish (US6).
6. Add shared team boards (US7) when the personal board flow is stable.

### Notes

- Every task that touches backend routes must satisfy the AGENTS.md bodyLimit, validation, timeout, error, and resource-cap rules.
- Any desktop IPC or preload addition must have a matching security test.
- Any new external fetch path must include timeout and SSRF handling before implementation is considered complete.
- Do not add SQLite, Drizzle, or local app-data persistence for Matrix desktop.
