# Data Model: Matrix CLI TUI Action Console Follow-Up

## Parent TUI Contract

Represents the 084 behavior this follow-up must preserve.

**Fields**:
- `homeIdentity`: Matrix OS product identity and prompt-first home copy
- `mascotPresence`: compact decorative rabbit mascot and responsive fallback
- `statusLine`: auth/gateway/sync/session status and next action
- `keyboardHints`: command palette, agents, sessions, quit, refresh, and help shortcuts
- `commandFamilies`: all 084 command-family entries
- `sessionLanguage`: Matrix session terminology and shell/coding session coverage
- `directCliCompatibility`: explicit subcommands and machine-readable output

**Validation Rules**:
- No field may be removed without an approved-removal entry in `spec.md`.
- Regression tests must cover any intentional extension of these fields.

## TUI Action

Represents an executable home or palette action.

**Fields**:
- `id`: stable action identifier
- `label`: user-facing label
- `source`: home shortcut, command palette, wizard, or session cockpit
- `availability`: available, degraded, unavailable, or in-progress
- `requires`: auth, gateway, platform, zellij, sync, project, or local file capability
- `result`: view navigation, backend action, terminal handoff, success, cancelled, or safe failure
- `confirmation`: none, simple confirm, exact phrase, or migration preview confirm

**Validation Rules**:
- Action IDs are stable and testable.
- Unavailable actions include a concrete next step.
- Destructive actions require confirmation.

## Session Operation

Represents a Matrix session operation backed by the zellij/session runtime.

**Fields**:
- `sessionId`: validated Matrix session identifier
- `kind`: shell, coding, agent, or unknown-compatible
- `status`: running, exited, stale, attaching, observing, stopping, or unavailable
- `context`: project, worktree, task, cwd, or runtime summary
- `operation`: create, list, attach, observe, takeover, detach, stop, inspect tabs, inspect panes, inspect layout
- `nativeAttach`: optional command details exposed only when useful

**Validation Rules**:
- Session list reads tolerate stale runtime references.
- Stop/remove actions require confirmation and refresh after confirmed success.
- Missing sessions produce safe user-facing errors.

## Setup Wizard

Represents the agent setup and migration flow.

**Fields**:
- `selectedAgents`: Codex, Claude, or future supported agents
- `migrationChoice`: skip, preview, selected candidates, or cancelled
- `migrationCandidates`: discovered local non-secret files/settings
- `writePlan`: owner-readable changes to Matrix-managed configuration
- `completionState`: done, partial, skipped, cancelled, or failed safely
- `handoff`: terminal action or next-step command

**Validation Rules**:
- Codex is selected by default; Claude is opt-in.
- Secrets, credentials, symlinks, unsupported files, and oversized files are skipped.
- Writes happen only after preview and confirmation.

## Local Capability State

Represents what can be evaluated on a local laptop.

**Fields**:
- `sourceCheckout`: whether the CLI is running from local source
- `gatewayState`: running, unreachable, degraded, or unknown
- `authState`: logged in, logged out, expired, or unknown
- `zellijState`: available, missing, incompatible, or unknown
- `syncState`: running, paused, missing, or unknown
- `nextSteps`: concrete commands or setup actions

**Validation Rules**:
- Source-only mode must not present unavailable actions as working.
- Capability checks have bounded waits and safe failures.
