# Tasks: Terminal Refactor Foundation

## Phase 1 - Spec and Safety Boundary

- [x] T001 Create `specs/104-terminal-refactor-foundation/spec.md` with scope, auth/resource invariants, non-goals, and native Linux app worktree boundary.
- [x] T002 Create this task list with incremental extraction phases.
- [x] T003 Include PR body note that `/home/deploy/matrix-os.worktrees/native-linux-apps-mvp/` is out of scope and was not modified.

## Phase 2 - First Extraction Slice

- [x] T004 Add focused tests for terminal agent status parsing and install command generation.
- [x] T005 Extract terminal agent option types, status parsing, and install command helpers from `TerminalApp.tsx` to `shell/src/components/terminal/terminal-agent-options.ts`.
- [x] T006 Extract `NewSessionMenu`, `NewSessionMenuItem`, and `TerminalAgentLogo` from `TerminalApp.tsx` to `shell/src/components/terminal/NewSessionMenu.tsx`.
- [x] T007 Update `TerminalApp.tsx` imports/usages and remove now-local agent/menu code.

## Phase 3 - Verification

- [x] T008 Run focused helper tests: `bun run test -- tests/shell/terminal-agent-options.test.ts`.
- [x] T009 Run focused terminal component tests that cover the new-session menu: `bun run test -- tests/shell/terminal-app-component.test.tsx`.
- [x] T010 Run `bun run check:patterns`.
- [x] T011 Run `bun run typecheck` if the worktree is hydrated enough for broad validation; otherwise record the exact environment blocker.

## Phase 4 - PR and Monitoring

- [x] T012 Commit with a Conventional Commit message.
- [x] T013 Push `codex/104-terminal-refactor-foundation`.
- [x] T014 Open PR with `Summary`, `Tests`, `Review/Monitoring`, and `Invariants`.
- [ ] T015 Monitor review feedback until latest trusted Greptile is `5/5`.
- [ ] T016 Add `ready-for-ci` only after Greptile is `5/5`.
- [ ] T017 Monitor label-triggered CI to completion.

## Deferred Follow-Up Refactors

- [ ] F001 Extract shell/session sidebar state controller from `LocalTerminalSidebar`.
- [ ] F002 Split shell cards, collapsed rail, session cards, project cards, and file tree into separate files.
- [ ] F003 Extract terminal layout persistence/hydration controller from `TerminalApp`.
- [ ] F004 Split `tests/shell/terminal-app-component.test.tsx` by behavior area.
- [ ] F005 Plan separate platform/gateway/database refactor specs for `packages/platform/src/main.ts`, `packages/gateway/src/server.ts`, and `packages/platform/src/db.ts`.
