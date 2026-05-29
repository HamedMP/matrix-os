# Tasks: Matrix CLI TUI Action Console Follow-Up

**Input**: Design documents from `/specs/085-cli-tui-action-console-v2/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required. This feature must follow TDD and must add preservation tests before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and review.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the replacement spec as the source of truth and make the parent stack explicit.

- [ ] T001 Confirm the implementation branch is stacked on `084-matrix-cli-tui-polish` using Graphite before code changes
- [ ] T002 [P] Add a parent-preservation fixture or snapshot baseline for the 084 home screen in `packages/sync-client/tests/tui/`
- [ ] T003 [P] Add a local evaluation fixture plan for source-only, gateway-running, authenticated, and zellij-ready states in `packages/sync-client/tests/tui/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the action execution and preservation guardrails that all stories depend on.

- [ ] T004 Write failing preservation tests for home prompt, mascot, keyboard hints, status line, command palette coverage, and Matrix session language in `packages/sync-client/tests/tui/`
- [ ] T005 Write failing tests proving visible home/palette actions cannot silently no-op in `packages/sync-client/tests/tui/`
- [ ] T006 Implement or extend the TUI action result contract in `packages/sync-client/src/cli/tui/actions.ts`
- [ ] T007 Add safe unavailable/degraded action state handling in `packages/sync-client/src/cli/tui/state.ts`
- [ ] T008 Run the preservation tests and confirm they fail before implementation work begins

**Checkpoint**: Parent preservation and action outcome contracts are testable.

---

## Phase 3: User Story 1 - Preserve Parent While Adding Working Actions (Priority: P1) MVP

**Goal**: Keep the 084 TUI intact while making added actions observable.

**Independent Test**: Compare parent-visible home elements and activate each added action.

- [ ] T009 [US1] Restore or preserve parent home prompt, status line, command hints, and mascot rendering in `packages/sync-client/src/cli/tui/views/HomeView.tsx`
- [ ] T010 [US1] Preserve parent mascot art and responsive alignment in `packages/sync-client/src/cli/tui/views/Mascot.tsx`
- [ ] T011 [US1] Preserve parent TUI state exports/helpers or provide compatible replacements in `packages/sync-client/src/cli/tui/state.ts`
- [ ] T012 [US1] Wire action execution results into the home and palette flows in `packages/sync-client/src/cli/tui/app.tsx`
- [ ] T013 [US1] Run parent preservation tests and direct CLI compatibility tests for `packages/sync-client`

**Checkpoint**: User Story 1 is fully functional and testable independently.

---

## Phase 4: User Story 2 - Home Shortcuts for Daily Shell Work (Priority: P2)

**Goal**: Add home shortcuts for new shell, sessions, doctor/status, login/setup, palette, and quit without replacing parent content.

**Independent Test**: Create and list sessions from home without slash commands.

- [ ] T014 [P] [US2] Write failing render tests for additive home shortcuts in `packages/sync-client/tests/tui/`
- [ ] T015 [P] [US2] Write failing action tests for new shell, sessions, doctor/status, login/setup, palette, and quit in `packages/sync-client/tests/tui/`
- [ ] T016 [US2] Add additive shortcut rendering to `packages/sync-client/src/cli/tui/views/HomeView.tsx`
- [ ] T017 [US2] Wire shortcut actions to existing CLI/gateway/session clients in `packages/sync-client/src/cli/tui/actions.ts`
- [ ] T018 [US2] Add bounded progress and safe failure states for shortcut actions in `packages/sync-client/src/cli/tui/state.ts`

**Checkpoint**: Home shortcuts execute, navigate, or report unavailable state.

---

## Phase 5: User Story 3 - Zellij-Style Matrix Session Management (Priority: P3)

**Goal**: Add session create/list/attach/observe/takeover/stop flows while preserving Matrix session language.

**Independent Test**: Exercise session operations against fake and real session clients.

- [ ] T019 [P] [US3] Write failing tests for Matrix session empty/list/detail language in `packages/sync-client/tests/tui/`
- [ ] T020 [P] [US3] Write failing tests for create/list/attach/observe/takeover/stop operation outcomes in `packages/sync-client/tests/tui/`
- [ ] T021 [US3] Implement session operation action handlers in `packages/sync-client/src/cli/tui/actions.ts`
- [ ] T022 [US3] Update the session cockpit view in `packages/sync-client/src/cli/tui/views/SessionsView.tsx`
- [ ] T023 [US3] Add stale-session, missing-runtime, timeout, and stop-confirmation handling in `packages/sync-client/src/cli/tui/state.ts`

**Checkpoint**: Matrix sessions support zellij-style operations with safe failures.

---

## Phase 6: User Story 4 - Agent Setup Wizard (Priority: P4)

**Goal**: Add Codex-default/Claude-opt-in setup wizard with safe local migration preview.

**Independent Test**: Run wizard against temporary home fixtures and verify preview/write/cancel behavior.

- [ ] T024 [P] [US4] Write failing wizard selection tests in `packages/sync-client/tests/tui/`
- [ ] T025 [P] [US4] Write failing migration preview and secret-skip tests in `packages/sync-client/tests/tui/`
- [ ] T026 [US4] Add setup wizard state and view files under `packages/sync-client/src/cli/tui/setup/`
- [ ] T027 [US4] Implement migration candidate discovery and classification in `packages/sync-client/src/cli/tui/setup/`
- [ ] T028 [US4] Implement preview, confirmation, cancellation, writeback, and terminal handoff states in `packages/sync-client/src/cli/tui/setup/`

**Checkpoint**: Setup wizard is safe, preview-first, and terminal-ready.

---

## Phase 7: User Story 5 - Honest Local Laptop Evaluation (Priority: P5)

**Goal**: Make source-only/local service states explicit and testable.

**Independent Test**: Launch locally with missing and available dependencies and verify state messaging.

- [ ] T029 [P] [US5] Write failing local capability tests for source-only, gateway-running, authenticated, and zellij-ready states in `packages/sync-client/tests/tui/`
- [ ] T030 [US5] Add local capability detection with bounded waits in `packages/sync-client/src/cli/tui/actions.ts`
- [ ] T031 [US5] Surface capability states and next steps in `packages/sync-client/src/cli/tui/views/HomeView.tsx`
- [ ] T032 [US5] Document local run/test commands and expected degraded states in `www/content/docs/guide/cli.mdx`

**Checkpoint**: Local laptop testing is explicit and does not look like silent failure.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, docs, and review readiness.

- [ ] T033 Run `bun run typecheck`
- [ ] T034 Run `bun run check:patterns`
- [ ] T035 Run `bun run test`
- [ ] T036 Run focused TUI local quickstart validation from `specs/085-cli-tui-action-console-v2/quickstart.md`
- [ ] T037 Update PR body invariants with source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, and deferred scope

---

## Dependencies & Execution Order

- **Phase 1**: No dependencies.
- **Phase 2**: Depends on Phase 1 and blocks all implementation stories.
- **US1 / Phase 3**: Must land before any UI additions.
- **US2 / Phase 4**: Depends on US1 preservation.
- **US3 / Phase 5**: Depends on foundational action handling and can proceed after US1.
- **US4 / Phase 6**: Depends on foundational action handling and can proceed after US1.
- **US5 / Phase 7**: Depends on foundational degraded-state handling and can proceed after US1.
- **Phase 8**: Depends on selected implementation phases.

## Graphite Stack Plan

- **Stack 1**: This replacement spec-only PR on top of `084-matrix-cli-tui-polish`.
- **Stack 2**: Parent preservation tests and action result contract.
- **Stack 3**: Additive home shortcuts and real action wiring.
- **Stack 4**: Matrix session cockpit operations.
- **Stack 5**: Setup wizard and migration preview.
- **Stack 6**: Local laptop capability states, docs, and final validation.

Each layer must stay below Matrix OS PR size limits and must not flatten the stack unless explicitly requested.

## Parallel Opportunities

- T002 and T003 can run in parallel.
- T014 and T015 can run in parallel.
- T019 and T020 can run in parallel.
- T024 and T025 can run in parallel.
- US3, US4, and US5 can be developed in parallel after US1 if each branch preserves the parent contract.

## Implementation Strategy

### MVP First

1. Land this replacement spec-only PR.
2. Add failing preservation tests.
3. Preserve/restored parent UI while wiring observable action outcomes.
4. Stop and validate before adding larger session or setup flows.

### Incremental Delivery

Implement each user story as a stacked Graphite PR with tests first, then run typecheck, pattern checks, focused TUI tests, and Greptile review before merge.
