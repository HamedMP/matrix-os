# Research: CLI TUI Action Console

## Decision: Build on the PR #249 TUI foundation, but treat it as a prerequisite

**Rationale**: `origin/main` does not yet contain `packages/sync-client/src/cli/tui/*`, while `origin/084-matrix-cli-tui-polish` includes the current TUI action registry, palette, home view, status aggregator, and tests. The implementation should either land after PR #249 merges or stack on that branch. Planning against the PR #249 shape avoids inventing a second TUI framework.

**Alternatives considered**:
- Rebuild a separate TUI from `main`: rejected because it duplicates unmerged work and increases merge risk.
- Keep this as a visual-only iteration: rejected because the user explicitly needs actions to execute.

## Decision: Use a shared `TuiActionExecutor` for palette and home quick actions

**Rationale**: The current palette closes on Enter without dispatching. A shared executor prevents drift between `/` command palette actions and home quick actions such as `n`, `s`, `a`, `d`, and `l`. It also provides one place for running/success/failure state, confirmation, refresh behavior, and local-vs-gateway prerequisites.

**Alternatives considered**:
- Execute commands directly inside React components: rejected because it makes tests harder and mixes rendering with side effects.
- Shell out arbitrary command strings: rejected because arbitrary palette text must never become a shell command.

## Decision: Reuse existing shell session client and gateway routes for session management

**Rationale**: `packages/sync-client/src/cli/shell-client.ts` already provides `listSessions`, `createSession`, `deleteSession`, and `attachSession` over existing gateway `/api/terminal/sessions` and `/ws/terminal/session` surfaces. The TUI should adapt those instead of creating a parallel session backend.

**Alternatives considered**:
- Add new TUI-specific session endpoints: rejected because the existing session contract already exists and is scriptable through `matrix shell`.
- Manage zellij directly from the laptop CLI: rejected because sessions live in the Matrix runtime/gateway environment, not necessarily on the user's laptop.

## Decision: Home screen becomes a quick-action list, not a mascot/ASCII poster

**Rationale**: The user feedback was that the rabbit/large decorative ASCII feels bad and does not help the workflow. The home screen should make the most common tasks visible: new shell session, shell sessions, setup coding agents, doctor, and login/switch account. Structural ASCII borders are acceptable; mascot/poster art is not.

**Alternatives considered**:
- Improve the mascot art: rejected because the product should feel like a practical operator console.
- Keep the large wordmark but add actions below: rejected because it wastes terminal height and harms narrow layouts.

## Decision: Setup wizard uses explicit detect-preview-confirm-execute-finish states

**Rationale**: Importing local agent configuration can affect secrets and runtime behavior. A wizard state machine lets the user opt in to Codex/Claude setup, choose migration sources, preview what will be copied, confirm, see per-step results, and then open a terminal session. No writes happen before confirmation.

**Alternatives considered**:
- Auto-import every detected config directory: rejected because it risks copying secrets/caches and violates explicit ownership.
- Ask only yes/no for all migration: rejected because Codex and Claude users may want different behavior per source.

## Decision: Local config migration starts with allowlisted metadata/config only

**Rationale**: Candidate sources are local paths such as `~/.codex`, `~/.claude`, `~/.agent`, and `~/.agents`. The first implementation should skip symlinks, credentials, tokens, logs, histories, caches, sockets, binaries, and oversized files by default. This gives a useful migration without leaking secrets.

**Alternatives considered**:
- Raw recursive copy: rejected due to secret leakage and unbounded traversal risk.
- No migration support: rejected because the user explicitly requested local config migration.

## Decision: Attach can hand off to the existing CLI terminal attach path

**Rationale**: Embedding a live terminal renderer inside the Ink TUI would create a second terminal stack. The existing shell client already handles WebSocket attach and terminal modes. The TUI can create/list/select sessions and then hand off to attach while preserving reattach hints.

**Alternatives considered**:
- Build nested terminal rendering inside the TUI: deferred because it is high risk and unnecessary for MVP.
- Only print the command to run manually: rejected because the user asked for an actionable TUI.

## Decision: Local laptop testing is a first-class mode with clear boundaries

**Rationale**: Users will run the CLI from personal laptops. Login/setup/doctor can provide useful local behavior, while session list/create/attach need a reachable Matrix gateway. The TUI must show gateway-unavailable states rather than silently doing nothing.

**Alternatives considered**:
- Treat local laptop failures as generic command errors: rejected because it repeats the current confusion.
- Require VPS-only testing: rejected because the CLI is meant to run locally.
