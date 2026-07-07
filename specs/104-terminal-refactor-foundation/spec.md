# Feature Specification: Terminal Refactor Foundation

**Feature Branch**: `codex/104-terminal-refactor-foundation`
**Created**: 2026-07-02
**Status**: In Progress
**Input**: User request: "do a proper spec/task list for this in a new worktree ... start working on this" after identifying `TerminalApp.tsx` as a 6,000+ LOC refactor hotspot.

## Scope Boundary

This spec owns behavior-preserving refactors that reduce the size and coupling of the shell terminal surface. It does not change terminal runtime semantics, zellij session behavior, WebSocket protocols, native app support, or customer VPS deployment flows.

The parallel `/home/deploy/matrix-os.worktrees/native-linux-apps-mvp/` worktree owns native Linux app support. This work must avoid native app runtime files and app packaging behavior unless a later explicit integration task coordinates both branches.

## User Scenarios & Testing

### User Story 1 - Safer Terminal Iteration (Priority: P1)

An engineer changing terminal session UI can work in focused modules instead of editing one giant component that owns session layout, agent launchers, mobile actions, shell rows, file tree state, and terminal chrome at once.

**Independent Test**: Terminal session/agent helper behavior is covered by focused unit tests, and existing `TerminalApp` component tests continue to pass after extraction.

**Acceptance Scenarios**:

1. **Given** terminal agent menu helpers are extracted, **When** tests import them directly, **Then** install command generation and agent-status parsing are verified without rendering `TerminalApp`.
2. **Given** `TerminalApp` renders the new-session menu, **When** users choose Shell, Claude, Codex, OpenCode, or Pi, **Then** existing menu behavior and labels remain unchanged.
3. **Given** a future session-sidebar change, **When** the engineer edits session refresh logic, **Then** unrelated file-tree and agent-logo code does not need to be touched.

### User Story 2 - Incremental Extraction Without Regression (Priority: P1)

A developer can land refactor slices one at a time with small diffs, preserving terminal behavior and the existing test contract at every step.

**Independent Test**: Each extraction slice must pass focused shell terminal tests plus `bun run check:patterns`; broader typecheck/test gates are run before PR readiness when feasible.

**Acceptance Scenarios**:

1. **Given** a refactor slice moves code out of `TerminalApp.tsx`, **When** tests run, **Then** no user-visible terminal behavior changes.
2. **Given** a slice would touch runtime or backend behavior, **When** the change is reviewed, **Then** it is either split into a separate spec or explicitly added to this spec with auth/resource invariants.
3. **Given** the native Linux app worktree is active, **When** this branch changes files, **Then** it does not edit native-app support files.

## Requirements

### Functional Requirements

- **FR-001**: Extract terminal new-session/agent menu model code from `TerminalApp.tsx` into a focused terminal module with direct tests.
- **FR-002**: Extract the new-session menu component from `TerminalApp.tsx` into a focused component file while preserving DOM roles, labels, styling, and light-dismiss behavior.
- **FR-003**: Keep `TerminalApp` as the composition owner during this PR; do not rewrite terminal layout/session runtime behavior in the same slice.
- **FR-004**: Keep all external calls timeout-guarded and preserve existing safe user-facing error messages.
- **FR-005**: Preserve existing mobile and desktop terminal menu behavior, including visible install commands that run in a foreground terminal session.
- **FR-006**: Add follow-up tasks for larger extractions: shell/session sidebar controller, shell row/card components, project/file sidebar modules, and terminal layout controller.
- **FR-007**: Document the native app support branch as out of scope for this PR.

### Non-Goals

- Replacing xterm, zellij, terminal WebSocket protocols, or gateway terminal routes.
- Adding new dependencies.
- Changing native app runtime support.
- Refactoring `packages/platform/src/main.ts`, `packages/gateway/src/server.ts`, or `packages/platform/src/db.ts` in this PR.
- Changing terminal visual design beyond preserving existing styles in extracted components.

## Security Architecture

### Auth Matrix

| Surface | Actor | Required Authorization | Notes |
| --- | --- | --- | --- |
| Terminal agent install session | Runtime owner | Existing terminal session creation auth | This PR preserves existing foreground install command behavior. |
| Terminal session menu | Runtime owner | Existing shell access | UI-only extraction; no new route or privilege. |
| Terminal helper tests | Developer | Local test only | No production surface. |

### Input Validation and Error Policy

- Agent IDs remain allowlisted to `claude`, `codex`, `opencode`, and `pi`.
- Parsed `/api/agents` responses must ignore unknown IDs and malformed install status values.
- Generated install commands must preserve shell quoting and the `/opt/matrix/runtime/node` default prefix.
- No raw provider, filesystem, or platform errors may be introduced into user-facing menu copy.

### Resource Management

- This PR must not add new in-memory registries, timers, WebSocket subscribers, or polling loops.
- Extracted menu light-dismiss listeners must still be removed on unmount.

### Integration Wiring

- `TerminalApp` remains the parent for `createShellSessionTab`.
- `NewSessionMenu` receives callbacks and parsed status state via props.
- Agent command helpers are pure and testable without React.

## Success Criteria

- **SC-001**: `TerminalApp.tsx` loses the terminal agent option/model code and new-session menu component without behavior changes.
- **SC-002**: New focused tests cover agent status parsing, install command construction, and visible install command wrapping.
- **SC-003**: Existing terminal app component tests for new-session menu and agent install state continue to pass.
- **SC-004**: `bun run check:patterns` reports 0 violations.
- **SC-005**: The PR description lists the native Linux app worktree as intentionally out of scope.

## Assumptions

- The safest first slice is extracting pure terminal agent/menu code, not changing runtime lifecycle behavior.
- Larger state-machine extractions should follow once the menu/model code has a reviewed module boundary.
- The native Linux app support branch may later touch app runtime and launcher surfaces; this branch should stay terminal-only.
