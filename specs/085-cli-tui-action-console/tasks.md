# Tasks: CLI TUI Action Console

**Input**: Design documents from `/specs/085-cli-tui-action-console/`  
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. Matrix OS constitution requires TDD, and the feature specification requires independently testable user stories.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, reviewed, and demoed independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete tasks.
- **[Story]**: User story label for story phases only.
- Every task includes concrete file paths.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the branch, docs, and test scaffolding for implementation.

- [X] T001 Stack or merge PR #249 TUI foundation into `packages/sync-client/src/cli/tui/app.tsx`, `packages/sync-client/src/cli/tui/actions.ts`, and `packages/sync-client/tests/tui/command-palette.test.tsx`
- [X] T002 [P] Add CLI TUI public docs stub in `www/content/docs/guide/cli-tui.mdx`
- [X] T003 [P] Register the CLI TUI docs page in `www/content/docs/guide/meta.json`
- [X] T004 [P] Add shared TUI test fixture helpers in `packages/sync-client/tests/tui/test-utils.tsx`
- [X] T005 [P] Add shell-session test fixtures in `packages/sync-client/tests/tui/session-fixtures.ts`
- [X] T006 [P] Add setup wizard test fixtures in `packages/sync-client/tests/tui/setup-fixtures.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create shared types, safe error handling, and state infrastructure required by every user story.

**Critical**: No user story implementation should begin until this phase is complete.

- [ ] T007 Define TUI action execution types and safe result envelopes in `packages/sync-client/src/cli/tui/action-executor.ts`
- [ ] T008 Extend the TUI action registry with `shell.new`, `setup.agents`, `status.whoami`, refresh metadata, and prerequisites in `packages/sync-client/src/cli/tui/actions.ts`
- [ ] T009 [P] Add quick action definitions and shortcut mapping in `packages/sync-client/src/cli/tui/quick-actions.ts`
- [ ] T010 [P] Add safe TUI message capping helpers in `packages/sync-client/src/cli/tui/errors.ts`
- [ ] T011 [P] Add TUI view-mode and selection state types in `packages/sync-client/src/cli/tui/state.ts`
- [ ] T012 Add executor dependency injection props to `MatrixTuiApp` in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T013 Add a reusable action status renderer in `packages/sync-client/src/cli/tui/views/ActionStatusView.tsx`
- [ ] T014 Add a reusable confirmation renderer for dangerous actions in `packages/sync-client/src/cli/tui/views/ConfirmActionView.tsx`
- [ ] T015 [P] Add foundational registry validation tests in `packages/sync-client/tests/tui/actions-registry.test.ts`
- [ ] T016 [P] Add safe error capping tests in `packages/sync-client/tests/tui/error-messages.test.ts`

**Checkpoint**: Shared action, error, state, status, and confirmation infrastructure is ready for story work.

---

## Phase 3: User Story 1 - Run Useful Actions From The TUI (Priority: P1) MVP

**Goal**: Selecting a command palette result and pressing Enter runs the selected registered action with visible running/result/failure state and status refresh.

**Independent Test**: Launch the TUI, open the palette, choose login/status/doctor/whoami, press Enter, and verify running/result state plus safe errors and status refresh.

### Tests for User Story 1

- [ ] T017 [P] [US1] Add failing executor tests for registered direct command dispatch in `packages/sync-client/tests/tui/action-executor.test.tsx`
- [ ] T018 [P] [US1] Add failing command palette Enter dispatch tests in `packages/sync-client/tests/tui/command-palette-dispatch.test.tsx`
- [ ] T019 [P] [US1] Add failing status refresh tests after action success in `packages/sync-client/tests/tui/action-refresh.test.tsx`
- [ ] T020 [P] [US1] Add failing safe action failure rendering tests in `packages/sync-client/tests/tui/action-status-view.test.tsx`

### Implementation for User Story 1

- [ ] T021 [US1] Implement trusted registered-action dispatch in `packages/sync-client/src/cli/tui/action-executor.ts`
- [ ] T022 [US1] Wire command palette Enter to `TuiActionExecutor.execute` in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T023 [US1] Render running, success, failed, and cancelled states through `ActionStatusView` in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T024 [US1] Refresh `aggregateTuiStatusSnapshot` after refreshable actions in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T025 [US1] Implement safe handling for no-result Enter and concurrent action attempts in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T026 [US1] Add login, doctor, status, and whoami executor adapters using existing CLI command services in `packages/sync-client/src/cli/tui/action-executor.ts`

**Checkpoint**: User Story 1 works independently; command palette actions are no longer decorative.

---

## Phase 4: User Story 2 - Start From A Practical Home Screen (Priority: P1)

**Goal**: Replace decorative home content with a quick-action console for session creation, session listing, setup, doctor, and login.

**Independent Test**: Render the home screen at 60, 80, and 100 columns; verify quick actions, shortcuts, selection, status, and no mascot/poster art.

### Tests for User Story 2

- [ ] T027 [P] [US2] Add failing quick-action render tests for 60, 80, and 100 columns in `packages/sync-client/tests/tui/home-actions.test.tsx`
- [ ] T028 [P] [US2] Add failing home shortcut dispatch tests for `n`, `s`, `a`, `d`, and `l` in `packages/sync-client/tests/tui/home-shortcuts.test.tsx`
- [ ] T029 [P] [US2] Add failing no-mascot/no-poster regression tests in `packages/sync-client/tests/tui/home-render.test.tsx`

### Implementation for User Story 2

- [ ] T030 [US2] Replace home mascot/wordmark layout with quick-action list and status layout in `packages/sync-client/src/cli/tui/views/HomeView.tsx`
- [ ] T031 [US2] Add selected quick-action state and up/down navigation in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T032 [US2] Wire home Enter and shortcuts to the shared executor in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T033 [US2] Remove obsolete mascot rendering from `packages/sync-client/src/cli/tui/views/Mascot.tsx` or delete the file if no longer referenced
- [ ] T034 [US2] Update home rendering tests to assert practical console layout in `packages/sync-client/tests/tui/home-render.test.tsx`

**Checkpoint**: User Story 2 works independently; the first screen is a useful action surface.

---

## Phase 5: User Story 3 - Manage Persistent Shell Sessions (Priority: P1)

**Goal**: Add a Sessions view that lists, creates, attaches to, refreshes, and removes persistent Matrix shell sessions using the existing shell client/gateway session APIs.

**Independent Test**: Open Sessions, create a session, see it in the list, attach to it, return, and remove it only after confirmation.

### Tests for User Story 3

- [ ] T035 [P] [US3] Add failing session action adapter tests in `packages/sync-client/tests/tui/session-actions.test.ts`
- [ ] T036 [P] [US3] Add failing Sessions view render tests for list, empty, unauthenticated, and gateway-unavailable states in `packages/sync-client/tests/tui/sessions-view.test.tsx`
- [ ] T037 [P] [US3] Add failing session keyboard tests for Enter, `n`, `r`, `k`, and Escape in `packages/sync-client/tests/tui/sessions-keyboard.test.tsx`
- [ ] T038 [P] [US3] Add failing destructive confirmation tests for session removal in `packages/sync-client/tests/tui/session-confirmation.test.tsx`

### Implementation for User Story 3

- [ ] T039 [US3] Implement shell session TUI adapter over `createShellClient` in `packages/sync-client/src/cli/tui/sessions/session-actions.ts`
- [ ] T040 [US3] Create `SessionsView` list, empty, unauthenticated, and gateway-unavailable states in `packages/sync-client/src/cli/tui/views/SessionsView.tsx`
- [ ] T041 [US3] Wire `shell.sessions` and `s` to Sessions view mode in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T042 [US3] Wire `shell.new` and `n` to create a safe default session or prompt state in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T043 [US3] Wire selected session attach to existing `ShellClient.attachSession` handoff in `packages/sync-client/src/cli/tui/sessions/session-actions.ts`
- [ ] T044 [US3] Wire confirmed session remove/stop through existing `ShellClient.deleteSession` in `packages/sync-client/src/cli/tui/sessions/session-actions.ts`
- [ ] T045 [US3] Normalize duplicate, not-authenticated, gateway-unavailable, and attach-failed session errors in `packages/sync-client/src/cli/tui/sessions/session-actions.ts`
- [ ] T046 [US3] Add session count refresh after create/delete in `packages/sync-client/src/cli/tui/app.tsx`

**Checkpoint**: User Story 3 works independently; shell sessions can be managed from the TUI.

---

## Phase 6: User Story 4 - Set Up Coding Agents And Local Config (Priority: P2)

**Goal**: Add a setup wizard for Codex/Claude selection, opt-in safe local config migration, preview/confirmation, per-step result reporting, and terminal-session handoff.

**Independent Test**: Open setup, select Codex/Claude, select or skip detected local sources, preview, confirm, see results, and open a terminal session.

### Tests for User Story 4

- [ ] T047 [P] [US4] Add failing setup wizard state-machine tests in `packages/sync-client/tests/tui/setup-wizard.test.tsx`
- [ ] T048 [P] [US4] Add failing local config detection tests for missing, present, unreadable, and symlink sources in `packages/sync-client/tests/tui/local-config-migration.test.ts`
- [ ] T049 [P] [US4] Add failing migration allowlist and size-cap tests in `packages/sync-client/tests/tui/setup-migration-plan.test.ts`
- [ ] T050 [P] [US4] Add failing setup result rendering tests in `packages/sync-client/tests/tui/setup-result-view.test.tsx`
- [ ] T051 [P] [US4] Add failing gateway import route tests in `tests/gateway/coding-agent-setup-routes.test.ts`

### Implementation for User Story 4

- [ ] T052 [US4] Implement coding agent selection model for Codex and Claude in `packages/sync-client/src/cli/tui/setup/setup-state.ts`
- [ ] T053 [US4] Implement safe local config source detection with `lstat`, home resolution, and symlink skipping in `packages/sync-client/src/cli/tui/setup/detect-sources.ts`
- [ ] T054 [US4] Implement allowlisted migration preview with file count, byte caps, and skipped reasons in `packages/sync-client/src/cli/tui/setup/migration-plan.ts`
- [ ] T055 [US4] Implement setup execution with completed/skipped/failed step results in `packages/sync-client/src/cli/tui/setup/setup-runner.ts`
- [ ] T056 [US4] Create `SetupWizardView` for agents, migration, preview, running, complete, and failed steps in `packages/sync-client/src/cli/tui/views/SetupWizardView.tsx`
- [ ] T057 [US4] Wire `setup.agents` and `a` to setup wizard mode in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T058 [US4] Add optional authenticated gateway import route with `bodyLimit` and Zod schemas in `packages/gateway/src/setup/coding-agent-routes.ts`
- [ ] T059 [US4] Add owner-home atomic setup/import writes in `packages/gateway/src/setup/coding-agent-store.ts`
- [ ] T060 [US4] Register optional setup routes with gateway startup wiring in `packages/gateway/src/server.ts`
- [ ] T061 [US4] Create or open setup completion shell session through `session-actions.ts` in `packages/sync-client/src/cli/tui/setup/setup-runner.ts`

**Checkpoint**: User Story 4 works independently; setup is explicit, safe, and ends with a terminal handoff.

---

## Phase 7: User Story 5 - Test Locally With Clear Runtime Boundaries (Priority: P2)

**Goal**: Make local laptop behavior explicit: local actions work where possible, gateway-backed actions show clear prerequisites, and nothing silently no-ops.

**Independent Test**: Run the TUI logged out or with an unreachable gateway and verify login/setup/doctor guidance plus sessions recovery states.

### Tests for User Story 5

- [ ] T062 [P] [US5] Add failing local logged-out behavior tests in `packages/sync-client/tests/tui/local-laptop-mode.test.tsx`
- [ ] T063 [P] [US5] Add failing gateway-unavailable recovery tests in `packages/sync-client/tests/tui/gateway-unavailable.test.tsx`
- [ ] T064 [P] [US5] Add failing command prerequisite tests for auth and gateway requirements in `packages/sync-client/tests/tui/action-prerequisites.test.tsx`

### Implementation for User Story 5

- [ ] T065 [US5] Add prerequisite evaluation for auth, gateway, and local-profile actions in `packages/sync-client/src/cli/tui/action-executor.ts`
- [ ] T066 [US5] Add local laptop recovery copy and action hints in `packages/sync-client/src/cli/tui/views/ActionStatusView.tsx`
- [ ] T067 [US5] Add gateway-unavailable and unauthenticated branches to `SessionsView` actions in `packages/sync-client/src/cli/tui/views/SessionsView.tsx`
- [ ] T068 [US5] Ensure login/setup/doctor actions remain reachable from unavailable states in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T069 [US5] Update quickstart local laptop expectations in `specs/085-cli-tui-action-console/quickstart.md`

**Checkpoint**: User Story 5 works independently; users can evaluate the TUI on a personal computer without hidden no-ops.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, hardening, and final review preparation across all stories.

- [ ] T070 [P] Document quick actions, command palette execution, sessions, setup wizard, and local testing in `www/content/docs/guide/cli-tui.mdx`
- [ ] T071 [P] Update CLI docs navigation metadata in `www/content/docs/guide/meta.json`
- [ ] T072 [P] Add public-facing setup safety notes to `www/content/docs/guide/cli-tui.mdx`
- [ ] T073 Run focused TUI tests and update validation notes in `specs/085-cli-tui-action-console/quickstart.md`
- [ ] T074 Run `pnpm --filter @finnaai/matrix exec tsc --noEmit` and record result in PR body
- [ ] T075 Run `bun run check:patterns` and fix or document any warnings related to changed files in PR body
- [ ] T076 Run `git diff --check` and fix whitespace issues in changed files
- [ ] T077 Review changed files against `docs/dev/review-pipeline.md` trust-boundary checklist and document invariants in PR body

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies; can start immediately after PR #249 foundation is available.
- **Phase 2 Foundational**: Depends on Phase 1 and blocks all user stories.
- **US1 (Phase 3)**: Depends on Phase 2; MVP.
- **US2 (Phase 4)**: Depends on Phase 2 and can proceed in parallel with US1 after executor interfaces are stable, but integrates best after US1.
- **US3 (Phase 5)**: Depends on Phase 2; can proceed in parallel with US1/US2 once session adapter interfaces are stable.
- **US4 (Phase 6)**: Depends on Phase 2 and uses US3's session adapter for terminal handoff.
- **US5 (Phase 7)**: Depends on Phase 2 and should be validated against US1/US3 states.
- **Polish (Phase 8)**: Depends on selected user stories being complete.

### User Story Dependencies

- **US1 Run Useful Actions**: No story dependency; recommended MVP.
- **US2 Practical Home Screen**: Uses the executor from US1 but remains independently testable with mocked executor.
- **US3 Shell Sessions**: Uses existing shell client/gateway APIs; independent of setup wizard.
- **US4 Setup Wizard**: Depends on session action adapter when opening a terminal after setup.
- **US5 Local Runtime Boundaries**: Cross-cuts US1 and US3 states; can be implemented after prerequisite evaluation exists.

### Parallel Opportunities

- Setup fixture/docs tasks T002-T006 can run in parallel.
- Foundational tasks T009-T011 and T015-T016 can run in parallel after T007 is sketched.
- US1 test tasks T017-T020 can run in parallel.
- US2 test tasks T027-T029 can run in parallel.
- US3 test tasks T035-T038 can run in parallel.
- US4 test tasks T047-T051 can run in parallel.
- US5 test tasks T062-T064 can run in parallel.
- Docs polish tasks T070-T072 can run in parallel after behavior is stable.

---

## Parallel Example: User Story 3

```bash
# Parallel test-first tasks for session management:
Task: "T035 [P] [US3] Add failing session action adapter tests in packages/sync-client/tests/tui/session-actions.test.ts"
Task: "T036 [P] [US3] Add failing Sessions view render tests for list, empty, unauthenticated, and gateway-unavailable states in packages/sync-client/tests/tui/sessions-view.test.tsx"
Task: "T037 [P] [US3] Add failing session keyboard tests for Enter, n, r, k, and Escape in packages/sync-client/tests/tui/sessions-keyboard.test.tsx"
Task: "T038 [P] [US3] Add failing destructive confirmation tests for session removal in packages/sync-client/tests/tui/session-confirmation.test.tsx"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete US1 so palette actions execute and report status.
3. Validate US1 independently with focused TUI tests.
4. Demo `matrix tui --no-color`, open palette, run doctor/status/login/whoami, and observe safe result states.

### Incremental Delivery

1. US1: actionable command palette.
2. US2: practical home quick actions using the same executor.
3. US3: shell session list/create/attach/remove.
4. US5: local laptop/gateway boundary polish for core workflows.
5. US4: setup wizard and safe config migration.
6. Phase 8: docs, validation, review hardening.

### Graphite Stack Plan

Use `docs/dev/stacked-prs.md` and keep each layer below Matrix OS PR size limits.

- **Stack 1**: Spec/tasks/docs setup and PR #249 stack dependency notes (`specs/085-cli-tui-action-console/*`, `AGENTS.md`, `.specify/feature.json`).
- **Stack 2**: Foundational TUI executor/state/error infrastructure (T007-T016).
- **Stack 3**: US1 command palette execution MVP (T017-T026).
- **Stack 4**: US2 practical home quick actions (T027-T034).
- **Stack 5**: US3 shell session management (T035-T046).
- **Stack 6**: US5 local laptop and gateway boundary states (T062-T069).
- **Stack 7**: US4 setup wizard and optional gateway setup import routes (T047-T061).
- **Stack 8**: Public docs, validation, and review hardening (T070-T077).

Do not flatten the stack unless explicitly requested.
