# Feature Specification: Matrix CLI TUI

**Feature Branch**: `084-matrix-cli-tui`  
**Created**: 2026-05-28  
**Status**: Implemented  
**Input**: User description: "Create an OpenCode-inspired Matrix OS terminal UI opened by matrix/matrixos/mos, using the supplied Matrix CLI TUI draft plus chat decisions: full command-family coverage, prompt-first status-aware home, zellij-backed session cockpit, Ink + React implementation direction, and bare matrix opens TUI in interactive terminals."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open Matrix From Terminal (Priority: P1)

A Matrix user runs `matrix` in an interactive terminal and lands in a clear Matrix OS control surface rather than command help. They can immediately see whether they are logged in, which profile and instance are active, whether the gateway and sync are healthy, and what action needs attention next.

**Why this priority**: This makes the CLI feel like opening Matrix OS and gives every other TUI workflow a trustworthy starting point.

**Independent Test**: Can be tested by launching `matrix` with different profile/auth/gateway/sync states and verifying the first screen communicates the current state and next action without extra navigation.

**Acceptance Scenarios**:

1. **Given** an interactive terminal with a valid profile and reachable instance, **When** the user runs `matrix`, **Then** the TUI opens and shows the active profile, identity when available, instance, gateway state, sync state, session/project summaries, and any active work.
2. **Given** an interactive terminal with no valid auth, **When** the user runs `matrix`, **Then** the TUI opens in a logged-out state with a clear login action and non-blocking access to help, command palette, and exit.
3. **Given** a non-interactive environment, **When** `matrix` is run with no arguments, **Then** the interactive TUI does not open and the CLI returns concise command guidance using the existing non-interactive conventions.

---

### User Story 2 - Discover Actions Through Command Palette (Priority: P2)

A user presses `/` or the command shortcut and searches for Matrix actions by command name, object name, alias, or plain-language intent. They can reach every existing command family without memorizing syntax.

**Why this priority**: The command palette turns a large CLI surface into a discoverable daily tool while preserving direct commands for power users and scripts.

**Independent Test**: Can be tested by opening the palette and confirming every command family appears, can be searched, and routes to the appropriate view, flow, or direct action.

**Acceptance Scenarios**:

1. **Given** the TUI home screen, **When** the user opens the command palette and searches "sessions", **Then** the session switcher and shell/coding session actions are visible.
2. **Given** the TUI home screen, **When** the user searches for "diagnose" or "doctor", **Then** status and doctor actions are visible.
3. **Given** an action that can destroy or restart resources, **When** it is selected from the palette, **Then** the TUI requires explicit confirmation before proceeding.

---

### User Story 3 - Manage Zellij-Backed Sessions Elegantly (Priority: P3)

A coding user opens the session cockpit to create, inspect, switch, observe, take over, attach to, or stop shell and coding sessions. They see Matrix concepts such as sessions, agents, projects, tasks, and worktrees while zellij remains the underlying runtime detail.

**Why this priority**: Session management is the daily developer workflow and the clearest place to deliver the OpenCode-inspired UX improvement.

**Independent Test**: Can be tested by creating shell and agent sessions, inspecting details, attaching/detaching, observing, taking over, sending input, and safely stopping sessions from the TUI.

**Acceptance Scenarios**:

1. **Given** existing shell and coding sessions, **When** the user opens `/sessions`, **Then** they see a switcher with status, age, kind, context, and attention state.
2. **Given** a selected session, **When** the user chooses attach, observe, takeover, send input, or stop, **Then** the TUI performs the requested action or asks for required confirmation.
3. **Given** a shell session with tabs, panes, or layouts, **When** the user opens session details, **Then** tabs, panes, layouts, and native attach information are discoverable without memorizing subcommands.

---

### User Story 4 - Complete First-Run Setup (Priority: P4)

A first-run user launches the TUI, sees missing setup state, starts login, discovers whether an instance exists, and starts file sync without reading command documentation.

**Why this priority**: First-run success turns the CLI into an onboarding surface rather than a power-user-only tool.

**Independent Test**: Can be tested from an empty or expired profile state by walking through login, profile discovery, instance state, and sync setup prompts.

**Acceptance Scenarios**:

1. **Given** no valid profile/auth exists, **When** the user runs `matrix`, **Then** the TUI presents login as the primary action while keeping command palette and exit available.
2. **Given** login succeeds, **When** the TUI refreshes, **Then** it shows the resolved profile, gateway, platform, instance, and sync state.
3. **Given** sync is not configured, **When** the user chooses setup sync, **Then** they can accept a default sync root or enter a path and start sync.

---

### User Story 5 - Preserve Scriptable CLI Behavior (Priority: P5)

A power user or automation continues using direct commands, help, version, and machine-readable output exactly as before, even though bare interactive `matrix` now opens the TUI.

**Why this priority**: Matrix CLI must become friendlier without breaking docs, scripts, release checks, or developer muscle memory.

**Independent Test**: Can be tested by running existing direct CLI command tests and verifying no behavior change for explicit subcommands and machine-readable output.

**Acceptance Scenarios**:

1. **Given** any environment, **When** the user runs `matrix --help`, `matrix help`, or `matrix --version`, **Then** the CLI prints the expected non-TUI output.
2. **Given** any explicit command such as `matrix status --json` or `matrix shell ls`, **When** it runs, **Then** the direct command path is used without opening the TUI.
3. **Given** an automation pipeline, **When** commands use machine-readable output, **Then** payload shape and exit behavior remain compatible.

---

### Edge Cases

- Interactive input exists but output is not a terminal, or output is piped to another process.
- Gateway or platform is unreachable, slow, returns malformed data, or requires re-authentication.
- Token is missing, expired, rejected, or belongs to a profile different from the active one.
- Sync daemon socket is missing, stale, paused, or returns an oversized/invalid response.
- Terminal is exactly 80x24, very narrow, no-color, or missing decorative glyph support.
- User starts a destructive action by accident and cancels confirmation.
- Session list contains stale, exited, missing-runtime, running, waiting, observed, or owner-attached sessions.
- User detaches from an attached shell and expects to return to the TUI without killing the session.
- A command action depends on a project, worktree, task, preview, or review that no longer exists.
- Native writeback target for an external agent tool is missing, unreadable, or contains unrelated user configuration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Running `matrix`, `matrixos`, or `mos` with no arguments in an interactive terminal MUST open the Matrix OS TUI.
- **FR-002**: Running `matrix --help`, `matrix help`, `matrix --version`, `matrix tui`, or any explicit existing command MUST preserve the expected direct command behavior, except `matrix tui` explicitly opens the TUI.
- **FR-003**: In non-interactive contexts, bare `matrix` MUST NOT launch the TUI and MUST provide concise command guidance or machine-safe behavior consistent with existing CLI conventions.
- **FR-004**: The TUI home screen MUST show product identity, active profile, auth state, identity when available, active instance, gateway reachability, platform reachability when relevant, sync state, sync root, peers, shell sessions, projects, agent runtime status, review status, and blocking actions.
- **FR-005**: The home screen MUST use a prompt-first layout where status and next actions are visible without turning the first view into a dense dashboard.
- **FR-006**: The TUI MUST provide a command palette reachable from keyboard shortcuts and searchable by command name, aliases, object names, and plain-language intent.
- **FR-007**: The command palette MUST expose every current Matrix command family: account/profile, instance, status/doctor, file sync, peers, shell, remote run, projects, worktrees, sessions, agents, reviews, tasks, previews, workspace data, utility, help, version, and completion.
- **FR-008**: The TUI MUST provide first-run flows for login, profile discovery, instance discovery, and sync setup without requiring users to read CLI help.
- **FR-009**: The TUI MUST provide account/profile flows for login, logout, identity display, profile listing, profile switching, profile editing, and expired-token recovery.
- **FR-010**: The TUI MUST provide status and doctor views that distinguish auth, gateway, platform, daemon, sync, protocol, and profile configuration issues.
- **FR-011**: The TUI MUST provide instance views for info, logs, and restart with progress and failure feedback.
- **FR-012**: The TUI MUST provide sync views for starting sync, viewing status, pausing, resuming, viewing peers, viewing sync root, and viewing recent sync metadata.
- **FR-013**: The TUI MUST provide shell and remote run views for session list, create, attach, remove, tabs, panes, layouts, and interactive command running.
- **FR-014**: The TUI MUST provide a zellij-backed session cockpit that presents sessions as Matrix concepts and exposes attach, observe, takeover, send input, stop, and native attach command details.
- **FR-015**: The TUI MUST provide project and worktree views for adding projects, listing projects, inspecting pull requests and branches, creating worktrees from branches or pull requests, listing worktrees, and removing worktrees.
- **FR-016**: The TUI MUST provide coding session and agent views for starting sessions, listing/filtering sessions, inspecting timeline/status, sending input, observing, taking over, killing sessions, listing agents, and viewing sandbox status.
- **FR-017**: The TUI MUST provide review views for starting, listing, watching/status, advancing, approving, and stopping review loops.
- **FR-018**: The TUI MUST provide task views for creating, listing/filtering, starting work, archiving, removing, and inspecting resulting sessions.
- **FR-019**: The TUI MUST provide preview views for adding, listing, opening/copying, and removing preview links.
- **FR-020**: The TUI MUST provide workspace data views for export, project-scoped export, event browsing, filtering, and protected deletion.
- **FR-021**: Destructive actions MUST require explicit confirmation and MUST NOT complete from a single accidental keypress.
- **FR-022**: Workspace data deletion MUST require the exact existing confirmation phrase: `delete project workspace data`.
- **FR-023**: User-entered URLs, paths, IDs, profile names, session names, project slugs, and command inputs MUST be validated before use or submission.
- **FR-024**: TUI-visible errors MUST be safe for users and MUST NOT expose provider internals, raw server errors, database details, filesystem paths, or secrets.
- **FR-025**: All status checks, network calls, daemon calls, and long-running actions initiated by the TUI MUST have bounded waits and visible fallback states.
- **FR-026**: The TUI MUST remain usable by keyboard only and MUST support arrow keys, `j/k`, Enter, Escape, `q`, refresh, help, account/profile, sessions, projects, agents, and doctor/status shortcuts.
- **FR-027**: The TUI MUST remain usable at 80x24 and MUST hide or simplify decorative elements before critical text becomes unreadable.
- **FR-028**: The TUI MUST support no-color mode and MUST not rely on decorative glyphs for core status meaning.
- **FR-029**: The 8-bit rabbit mascot MUST be decorative, compact, stateful, and never obscure or displace critical status text.
- **FR-030**: TUI preferences and Matrix-managed configuration changes MUST be owner-readable and explainable to the user.
- **FR-031**: Native writeback for agent/skill/tool configuration MUST avoid whole-file symlinks for vendor config files and MUST NOT symlink or copy secrets across tools.
- **FR-032**: Direct CLI commands and machine-readable output MUST remain compatible with existing docs, release checks, and automation.
- **FR-033**: Public CLI documentation MUST be updated to describe the default TUI, explicit command behavior, and first-run flow.

### Key Entities

- **CLI Entrypoint**: The command invocation context, including binary alias, arguments, interactivity, output mode, and direct-command routing.
- **TUI Session**: The active terminal UI runtime state, including current view, palette query, selected item, modal state, refresh state, and safe error state.
- **Profile**: A named CLI configuration containing platform and gateway connection settings and active selection state.
- **Auth State**: The user's current authentication status, identity if known, token validity, and recovery action.
- **Matrix Instance**: The active Matrix OS runtime associated with a profile, including handle/name, reachability, health, logs, and restart state.
- **Sync State**: Local sync daemon status, sync root, gateway subtree, pause/running state, peers, manifest/version metadata, and last sync information.
- **Shell Session**: A terminal session backed by the Matrix runtime, including name, status, cwd, tabs, panes, layouts, attach state, and native attach command.
- **Coding Session**: A Matrix workspace session for shell or agent work, including kind, project, worktree, task, pull request, agent, runtime, timeline, write mode, and status.
- **Project**: A tracked coding project with repository identity, branches, pull requests, worktrees, tasks, previews, sessions, reviews, and recent activity.
- **Worktree**: A project workspace tied to a branch or pull request, with path, dirty state, and removal safety state.
- **Agent**: A coding or system agent available to start or continue work, including sandbox/availability status.
- **Review**: A review loop with project, worktree, pull request, status, rounds, findings, and available next actions.
- **Task**: A project-scoped work item with title, priority, status, archived/deleted state, and linked sessions.
- **Preview**: A named URL associated with a project, task, or session, including copy/open/remove actions and status.
- **Workspace Event**: A timestamped activity item filterable by project, task, status, session, review, or preview.
- **TUI Preference**: Owner-readable preferences for theme, no-color behavior, shortcut visibility, default view, and native writeback choices.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 90% of beta users can identify their auth, profile, gateway, and sync state within 10 seconds of launching `matrix`.
- **SC-002**: 100% of current Matrix CLI command families are reachable from the TUI command palette.
- **SC-003**: Existing direct CLI command tests continue passing with no machine-readable output regressions.
- **SC-004**: A logged-out first-run user can start login from the TUI within 2 keypresses from launch.
- **SC-005**: A logged-in user can open the session switcher and attach to an existing shell session within 5 keypresses from launch.
- **SC-006**: 100% of destructive TUI actions require confirmation beyond the initial action selection.
- **SC-007**: The TUI remains readable and navigable at 80 columns by 24 rows with no critical text hidden behind decorative elements.
- **SC-008**: Gateway-offline, token-expired, daemon-stopped, and sync-paused states each produce a clear recovery action on the relevant screen.
- **SC-009**: Users can complete sync start, pause, and resume from the TUI without consulting documentation.
- **SC-010**: Public CLI documentation explains default TUI behavior and explicit command compatibility before release.

## Assumptions

- The TUI is the default interactive entrypoint for installed CLI and local source development.
- The home screen is prompt-first and status-aware rather than dashboard-first.
- The initial feature covers the full command-family surface, even if implementation ships in stacked milestones.
- The mascot remains unnamed in this specification; exact pixel art can be finalized during design.
- Zellij remains the underlying shell/session runtime, but user-facing language should emphasize Matrix sessions.
- Native writeback should initially be explicit and explainable, with secrets excluded and vendor config files modified only through safe adapters or managed snippets.
