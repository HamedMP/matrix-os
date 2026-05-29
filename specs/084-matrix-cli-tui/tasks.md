# Tasks: Matrix CLI TUI

**Input**: Design documents from `/specs/084-matrix-cli-tui/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required. Matrix OS constitution and this feature plan require TDD; write failing tests before implementation in each phase.

**Organization**: Tasks are grouped by user story to enable independently reviewable Graphite stack layers and incremental delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete tasks.
- **[Story]**: User story label for story phases only.
- Every task includes an exact file path.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the published CLI package and docs/spec references for the TUI work.

- [X] T001 Add Ink, React, and required React typings to `packages/sync-client/package.json`
- [X] T002 Run root `pnpm install` to update `pnpm-lock.yaml`
- [X] T003 Create TUI source directories under `packages/sync-client/src/cli/tui/`
- [X] T004 Create TUI test directories under `packages/sync-client/tests/tui/`
- [X] T005 [P] Add initial public CLI docs placeholder for TUI behavior in `www/content/docs/guide/cli.mdx`
- [X] T006 [P] Add exported TUI module barrel in `packages/sync-client/src/cli/tui/index.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build shared contracts, safe clients, and reusable TUI primitives needed by all stories.

**CRITICAL**: No user story implementation can begin until this phase is complete.

### Tests for Foundation

- [X] T007 [P] Add action registry coverage tests in `packages/sync-client/tests/tui/actions.test.ts`
- [X] T008 [P] Add safe gateway client timeout/error tests in `packages/sync-client/tests/tui/gateway-client.test.ts`
- [X] T009 [P] Add TUI preference read/write recovery tests in `packages/sync-client/tests/tui/preferences.test.ts`
- [X] T010 [P] Add confirmation policy tests in `packages/sync-client/tests/tui/confirmations.test.ts`

### Implementation for Foundation

- [X] T011 Implement typed TUI action registry in `packages/sync-client/src/cli/tui/actions.ts`
- [X] T012 Implement shared timeout-bound gateway client helpers in `packages/sync-client/src/cli/tui/gateway-client.ts`
- [X] T013 Implement safe daemon/status adapter helpers in `packages/sync-client/src/cli/tui/daemon-client.ts`
- [X] T014 Implement owner-readable TUI preference loader with malformed-file recovery in `packages/sync-client/src/cli/tui/preferences.ts`
- [X] T015 Implement confirmation policy helpers in `packages/sync-client/src/cli/tui/confirmations.ts`
- [X] T016 Implement safe error normalization helpers in `packages/sync-client/src/cli/tui/errors.ts`
- [X] T017 Implement terminal capability helpers for TTY/no-color/80x24 detection in `packages/sync-client/src/cli/tui/terminal.ts`

**Checkpoint**: Foundation ready; each user story can use common registry, client, preference, confirmation, error, and terminal helpers.

---

## Phase 3: User Story 1 - Open Matrix From Terminal (Priority: P1) MVP

**Goal**: Bare interactive `matrix` opens a prompt-first TUI home that communicates active state and next action.

**Independent Test**: Launch routing and home render tests prove interactive default behavior, non-TTY fallback, and basic status display without relying on other story flows.

### Tests for User Story 1

- [X] T018 [P] [US1] Add CLI launch routing tests in `packages/sync-client/tests/tui/launch.test.ts`
- [X] T019 [P] [US1] Add status aggregation tests for healthy/degraded/logged-out states in `packages/sync-client/tests/tui/status.test.ts`
- [X] T020 [P] [US1] Add Ink render tests for prompt-first home, no-color, and 80x24 layout in `packages/sync-client/tests/tui/home-render.test.tsx`

### Implementation for User Story 1

- [X] T021 [US1] Add `tui` subcommand and bare interactive launch routing in `packages/sync-client/src/cli/index.ts`
- [X] T022 [US1] Implement TUI entrypoint and render lifecycle in `packages/sync-client/src/cli/tui/app.tsx`
- [X] T023 [US1] Implement status snapshot aggregation in `packages/sync-client/src/cli/tui/status.ts`
- [X] T024 [US1] Implement prompt-first home view in `packages/sync-client/src/cli/tui/views/HomeView.tsx`
- [X] T025 [US1] Implement compact stateful mascot component in `packages/sync-client/src/cli/tui/views/Mascot.tsx`
- [X] T026 [US1] Wire refresh, help, quit, and safe fallback states in `packages/sync-client/src/cli/tui/state.ts`

**Checkpoint**: User Story 1 works independently; `matrix` opens TUI interactively and direct/non-TTY behavior is protected.

---

## Phase 4: User Story 2 - Discover Actions Through Command Palette (Priority: P2)

**Goal**: Users can discover every command family through a searchable command palette and protected action flows.

**Independent Test**: Palette tests prove all command families are searchable and dangerous actions are gated by confirmation.

### Tests for User Story 2

- [X] T027 [P] [US2] Add command palette search tests in `packages/sync-client/tests/tui/command-palette.test.tsx`
- [X] T028 [P] [US2] Add dangerous action confirmation render tests in `packages/sync-client/tests/tui/confirmation-render.test.tsx`
- [X] T029 [P] [US2] Add action registry command-family completeness tests in `packages/sync-client/tests/tui/action-coverage.test.ts`

### Implementation for User Story 2

- [X] T030 [US2] Implement command palette model and fuzzy filtering in `packages/sync-client/src/cli/tui/palette.ts`
- [X] T031 [US2] Implement command palette view in `packages/sync-client/src/cli/tui/views/CommandPalette.tsx`
- [X] T032 [US2] Implement confirmation overlay view in `packages/sync-client/src/cli/tui/views/ConfirmationOverlay.tsx`
- [X] T033 [US2] Wire global `/`, shortcut, Escape, Enter, and modal key handling in `packages/sync-client/src/cli/tui/app.tsx`
- [X] T034 [US2] Populate all command-family actions in `packages/sync-client/src/cli/tui/actions.ts`
- [X] T035 [US2] Add help/about/completion utility views in `packages/sync-client/src/cli/tui/views/UtilityViews.tsx`

**Checkpoint**: User Story 2 works independently; all command families are discoverable through the palette.

---

## Phase 5: User Story 3 - Manage Zellij-Backed Sessions Elegantly (Priority: P3)

**Goal**: Users manage shell and coding sessions through a Matrix session cockpit while zellij remains the hidden runtime layer.

**Independent Test**: Session cockpit tests cover list/detail/create/attach/observe/takeover/send/kill plus shell tabs, panes, and layouts using mocked clients.

### Tests for User Story 3

- [X] T036 [P] [US3] Add shell session client tests in `packages/sync-client/tests/tui/shell-session-client.test.ts`
- [X] T037 [P] [US3] Add coding session client tests in `packages/sync-client/tests/tui/coding-session-client.test.ts`
- [X] T038 [P] [US3] Add session cockpit render/navigation tests in `packages/sync-client/tests/tui/session-cockpit.test.tsx`
- [X] T039 [P] [US3] Add attach/observe/takeover action tests in `packages/sync-client/tests/tui/session-actions.test.ts`

### Implementation for User Story 3

- [X] T040 [US3] Implement shell session TUI client adapter in `packages/sync-client/src/cli/tui/shell-sessions.ts`
- [X] T041 [US3] Implement coding session TUI client adapter in `packages/sync-client/src/cli/tui/coding-sessions.ts`
- [X] T042 [US3] Implement unified session cockpit view in `packages/sync-client/src/cli/tui/views/SessionsView.tsx`
- [X] T043 [US3] Implement session detail view for timeline/status/context in `packages/sync-client/src/cli/tui/views/SessionDetailView.tsx`
- [X] T044 [US3] Implement shell tab/pane/layout manager views in `packages/sync-client/src/cli/tui/views/ShellRuntimeViews.tsx`
- [X] T045 [US3] Implement external attach/observe/takeover handoff and detach return flow in `packages/sync-client/src/cli/tui/session-actions.ts`
- [X] T046 [US3] Implement create session and remote run forms in `packages/sync-client/src/cli/tui/views/SessionForms.tsx`

**Checkpoint**: User Story 3 works independently; `/sessions` delivers the polished zellij-backed Matrix session manager.

---

## Phase 6: User Story 4 - Complete First-Run Setup (Priority: P4)

**Goal**: Logged-out and first-run users can log in, discover instance state, and start sync from inside the TUI.

**Independent Test**: First-run tests walk logged-out, expired-token, post-login refresh, missing-instance, and sync-start flows using mocked profile/login/sync clients.

### Tests for User Story 4

- [X] T047 [P] [US4] Add first-run flow tests in `packages/sync-client/tests/tui/first-run.test.tsx`
- [X] T048 [P] [US4] Add account/profile flow tests in `packages/sync-client/tests/tui/account-profile.test.tsx`
- [X] T049 [P] [US4] Add sync setup flow tests in `packages/sync-client/tests/tui/sync-flow.test.tsx`

### Implementation for User Story 4

- [X] T050 [US4] Implement account/profile TUI adapters in `packages/sync-client/src/cli/tui/account.ts`
- [X] T051 [US4] Implement login/logout/profile views in `packages/sync-client/src/cli/tui/views/AccountViews.tsx`
- [X] T052 [US4] Implement first-run orchestration view in `packages/sync-client/src/cli/tui/views/FirstRunView.tsx`
- [X] T053 [US4] Implement sync setup/status views in `packages/sync-client/src/cli/tui/views/SyncViews.tsx`
- [X] T054 [US4] Implement instance status/logs/restart views in `packages/sync-client/src/cli/tui/views/InstanceViews.tsx`
- [X] T055 [US4] Wire post-login and post-sync refresh behavior in `packages/sync-client/src/cli/tui/state.ts`

**Checkpoint**: User Story 4 works independently; a first-run user can reach login and sync setup without CLI help.

---

## Phase 7: User Story 5 - Preserve Scriptable CLI Behavior (Priority: P5)

**Goal**: Existing explicit commands, help/version, JSON output, and automation behavior remain compatible after the default interactive TUI change.

**Independent Test**: Existing command tests and new regression tests prove direct command behavior does not route through TUI.

### Tests for User Story 5

- [X] T056 [P] [US5] Add direct-command regression tests in `packages/sync-client/tests/tui/direct-command-compat.test.ts`
- [X] T057 [P] [US5] Add JSON/non-TTY compatibility tests in `packages/sync-client/tests/tui/non-interactive-compat.test.ts`
- [X] T058 [P] [US5] Add CLI docs expectation tests if docs tooling supports them in `packages/sync-client/tests/tui/docs-compat.test.ts`

### Implementation for User Story 5

- [X] T059 [US5] Harden direct command bypasses in `packages/sync-client/src/cli/index.ts`
- [X] T060 [US5] Ensure non-TTY fallback copy and exit behavior in `packages/sync-client/src/cli/tui/launch.ts`
- [X] T061 [US5] Update release/package validation expectations in `packages/sync-client/scripts/check-publish.mjs`
- [X] T062 [US5] Update CLI documentation for TUI/default/direct behavior in `www/content/docs/guide/cli.mdx`
- [X] T063 [US5] Update CLI README with default TUI behavior in `packages/sync-client/README.md`

**Checkpoint**: User Story 5 works independently; scripts and direct commands remain compatible.

---

## Phase 8: Workspace Cockpit Completion (Cross-Story Full Spec Coverage)

**Purpose**: Complete remaining full-spec command families beyond the MVP/session/first-run flows.

- [X] T064 [P] Add workspace client tests for projects/worktrees in `packages/sync-client/tests/tui/projects-client.test.ts`
- [X] T065 [P] Add workspace client tests for reviews/tasks/previews/events/export/delete in `packages/sync-client/tests/tui/workspace-client.test.ts`
- [X] T066 [P] Add workspace view render tests in `packages/sync-client/tests/tui/workspace-views.test.tsx`
- [X] T067 Implement projects/worktrees TUI client in `packages/sync-client/src/cli/tui/projects.ts`
- [X] T068 Implement reviews/tasks/previews/workspace data client in `packages/sync-client/src/cli/tui/workspace.ts`
- [X] T069 Implement projects and worktrees views in `packages/sync-client/src/cli/tui/views/ProjectViews.tsx`
- [X] T070 Implement reviews and tasks views in `packages/sync-client/src/cli/tui/views/ReviewTaskViews.tsx`
- [X] T071 Implement previews and workspace data views in `packages/sync-client/src/cli/tui/views/WorkspaceDataViews.tsx`
- [X] T072 Wire workspace actions into `packages/sync-client/src/cli/tui/actions.ts`

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final quality, performance, docs, and release readiness.

- [X] T073 [P] Add accessibility/no-color snapshot coverage in `packages/sync-client/tests/tui/accessibility.test.tsx`
- [X] T074 [P] Add malformed preference and partial status failure regression tests in `packages/sync-client/tests/tui/resilience.test.ts`
- [X] T075 Run and fix `pnpm --filter @finnaai/matrix test`
- [X] T076 Run and fix `pnpm --filter @finnaai/matrix build`
- [X] T077 Run and fix root `bun run typecheck`
- [X] T078 Run and fix root `bun run check:patterns`
- [X] T079 Run relevant gateway session tests from `tests/gateway/workspace-routes.test.ts`, `tests/gateway/session-runtime-bridge.test.ts`, and `tests/gateway/terminal-zellij-ws.test.ts`
- [X] T080 Validate quickstart scenarios from `specs/084-matrix-cli-tui/quickstart.md`
- [X] T081 Update release notes in `docs/dev/cli-release.md`
- [X] T082 Review PR body invariants and stack notes against `docs/dev/review-pipeline.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundation**: Depends on Phase 1; blocks all user stories.
- **Phase 3 US1**: Depends on Phase 2; MVP launch/home slice.
- **Phase 4 US2**: Depends on Phase 2 and benefits from US1 app shell.
- **Phase 5 US3**: Depends on Phase 2 and uses US2 action registry; can be developed after palette foundations exist.
- **Phase 6 US4**: Depends on Phase 2 and US1 status/home shell.
- **Phase 7 US5**: Depends on Phase 3 launch routing; should complete before release.
- **Phase 8 Workspace Cockpit**: Depends on Phase 4 action registry and Phase 2 clients.
- **Phase 9 Polish**: Depends on intended shipped phases.

### User Story Dependencies

- **US1**: No dependency on other stories after foundation.
- **US2**: Requires foundation; best after US1 app shell exists.
- **US3**: Requires foundation and action registry wiring from US2.
- **US4**: Requires US1 home/status shell.
- **US5**: Requires launch routing from US1.

### Parallel Opportunities

- T005 and T006 can run in parallel after dependency setup decisions.
- T007 through T010 can run in parallel because they target different test files.
- T018 through T020 can run in parallel.
- T027 through T029 can run in parallel.
- T036 through T039 can run in parallel.
- T047 through T049 can run in parallel.
- T056 through T058 can run in parallel.
- T064 through T066 can run in parallel.
- T073 and T074 can run in parallel.

---

## Parallel Example: User Story 3

```bash
Task: "T036 Add shell session client tests in packages/sync-client/tests/tui/shell-session-client.test.ts"
Task: "T037 Add coding session client tests in packages/sync-client/tests/tui/coding-session-client.test.ts"
Task: "T038 Add session cockpit render/navigation tests in packages/sync-client/tests/tui/session-cockpit.test.tsx"
Task: "T039 Add attach/observe/takeover action tests in packages/sync-client/tests/tui/session-actions.test.ts"
```

---

## Graphite Stack Plan

- **Stack 1: `feat(cli): add tui foundation`** — Phases 1-2. Dependency setup, TUI scaffolding, action registry, safe clients, preferences, terminal helpers, and foundational tests.
- **Stack 2: `feat(cli): open matrix tui by default`** — Phase 3. Bare interactive launch, prompt-first home, status aggregation, mascot, and launch/home tests.
- **Stack 3: `feat(cli): add tui command palette`** — Phase 4. Command palette, confirmation overlay, utility views, and command-family coverage.
- **Stack 4: `feat(cli): add session cockpit`** — Phase 5. Zellij-backed Matrix session manager, shell/coding session views, attach/observe/takeover, tabs/panes/layouts.
- **Stack 5: `feat(cli): add first-run setup flows`** — Phase 6. Login/profile/sync/instance flows.
- **Stack 6: `feat(cli): preserve direct command compatibility`** — Phase 7. Non-TTY/direct command hardening and docs.
- **Stack 7: `feat(cli): complete workspace cockpit`** — Phase 8. Projects, worktrees, reviews, tasks, previews, workspace data.
- **Stack 8: `chore(cli): validate matrix tui release`** — Phase 9. Accessibility/resilience tests, release docs, full validation.

Each layer must be committed independently, restacked with Graphite, kept below Matrix OS PR size limits, and submitted as a stack. Do not flatten layers unless explicitly requested.

---

## Implementation Strategy

### MVP First

1. Complete Phase 1.
2. Complete Phase 2.
3. Complete Phase 3.
4. Stop and validate `matrix`, `matrix tui`, non-TTY bare `matrix`, help/version/direct commands, and home status rendering.

### Incremental Delivery

1. Foundation and launch/home create a useful MVP.
2. Command palette adds discoverability.
3. Session cockpit delivers the daily developer UX improvement.
4. First-run setup and direct compatibility make it release-safe.
5. Workspace cockpit completes the full command-family spec.

### TDD Rule

For each phase, write and observe failing tests before implementing the corresponding code. Mark tasks complete in this file only after the test or implementation has been completed and checked.
