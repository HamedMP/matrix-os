# Feature Specification: CLI TUI Action Console

**Feature Branch**: `085-cli-tui-action-console`  
**Created**: 2026-05-29  
**Status**: Draft  
**Input**: User description: "Make the Matrix CLI TUI useful instead of decorative: remove the poor mascot/ASCII-poster home screen, execute command palette actions, add a home screen with most-used commands, add persistent shell-session management, add a coding-agent setup wizard for Codex/Claude and local config migration, and finish setup by opening a terminal session."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Useful Actions From The TUI (Priority: P1)

As a Matrix CLI user, I want selecting a command in the TUI to actually run that command so the interface behaves like a usable control surface instead of a static mockup.

**Why this priority**: The current palette presents commands but does not execute them, which makes local testing misleading and blocks every other workflow.

**Independent Test**: Launch the TUI, open the command palette, choose login/status/doctor/whoami, press Enter, and verify that the selected command runs with visible progress, success, failure, and refreshed status.

**Acceptance Scenarios**:

1. **Given** the command palette is open with at least one result, **When** the user presses Enter, **Then** the selected action runs and the TUI shows a running state before success or failure.
2. **Given** an action completes successfully, **When** the TUI returns to the home screen or relevant view, **Then** the status summary is refreshed.
3. **Given** an action fails, **When** the TUI displays the failure, **Then** the user sees a safe, bounded message with a recovery hint and no raw internal details.

---

### User Story 2 - Start From A Practical Home Screen (Priority: P1)

As a terminal-heavy user, I want the TUI home screen to show the most common actions immediately so I can create sessions, list sessions, run setup, diagnose issues, or log in without memorizing command names.

**Why this priority**: The first screen determines whether the TUI feels like a real product. A decorative mascot or oversized wordmark wastes the exact space users need for action.

**Independent Test**: Launch the TUI at multiple terminal widths and verify that quick actions are selectable, keyboard shortcuts work, status remains visible, and no mascot/large poster art appears.

**Acceptance Scenarios**:

1. **Given** the TUI launches in a normal or wide terminal, **When** the home screen appears, **Then** it shows quick actions for new shell session, shell sessions, coding-agent setup, doctor, and login/switch account.
2. **Given** a quick action is selected, **When** the user presses Enter, **Then** the same action execution path as the command palette is used.
3. **Given** the terminal is narrow, **When** the home screen renders, **Then** quick actions and status remain readable without decorative art or overlapping text.

---

### User Story 3 - Manage Persistent Shell Sessions (Priority: P1)

As a developer, I want a session management view for persistent Matrix shell sessions so I can list, create, attach, and stop sessions from the TUI like a lightweight terminal workspace launcher.

**Why this priority**: Session management is the first workflow that makes the TUI materially better than one-shot commands.

**Independent Test**: Open the Sessions view, create a session, see it in the list, attach to it, return, and remove it with confirmation.

**Acceptance Scenarios**:

1. **Given** the gateway is reachable, **When** the user opens Shell Sessions, **Then** the TUI lists existing sessions with name, state, working directory or label, and available actions.
2. **Given** the user chooses New Shell Session, **When** they provide or accept a safe session name, **Then** a persistent shell session is created and shown in the list.
3. **Given** a session exists, **When** the user chooses Attach, **Then** the TUI hands off to the terminal attach flow without losing the session record.
4. **Given** a destructive session action is selected, **When** the user has not confirmed it, **Then** the action does not run.

---

### User Story 4 - Set Up Coding Agents And Local Config (Priority: P2)

As a developer setting up Matrix OS on a laptop or VPS, I want a guided setup wizard to choose coding agents and migrate selected local agent configuration so I can start with Codex or Claude without manually copying files.

**Why this priority**: A setup wizard makes first-run local testing and new-runtime setup explicit, safe, and repeatable.

**Independent Test**: Launch the setup wizard, select Codex and/or Claude, choose which local config directories to import, review the planned changes, confirm, and verify a setup completion screen followed by a terminal session.

**Acceptance Scenarios**:

1. **Given** the setup wizard opens, **When** the agent selection step appears, **Then** the user can toggle Codex and Claude independently and continue with at least one selected agent.
2. **Given** supported local config directories exist, **When** the migration step appears, **Then** the user can choose which detected sources to import and can skip migration entirely.
3. **Given** the user confirms setup, **When** the setup finishes, **Then** the TUI shows completed items, skipped items, and failures separately before offering to open a terminal.
4. **Given** setup completes, **When** the user continues, **Then** a shell session opens with a clear setup-complete message.

---

### User Story 5 - Test Locally With Clear Runtime Boundaries (Priority: P2)

As a user testing the CLI TUI on my personal computer, I want the TUI to explain what can run locally and what requires a reachable Matrix OS gateway so I can evaluate behavior without confusing no-ops.

**Why this priority**: Local laptop testing is the primary feedback loop for this TUI. The UI must distinguish unimplemented actions, local-only actions, and gateway-backed actions.

**Independent Test**: Run the TUI on a laptop that is logged out or has no reachable gateway and verify that login/setup/doctor still behave clearly while session actions report the missing dependency.

**Acceptance Scenarios**:

1. **Given** the user is not logged in, **When** they run Login from the TUI, **Then** the login flow starts or presents the same instructions as the direct CLI command.
2. **Given** the gateway is unavailable, **When** the user opens Sessions, **Then** the TUI shows a clear gateway-unavailable state and suggests doctor/profile recovery.
3. **Given** a command cannot run in the current environment, **When** the user selects it, **Then** the TUI explains the missing prerequisite rather than silently closing.

### Edge Cases

- No command palette results are available and the user presses Enter.
- The selected action changes while an action is already running.
- Login requires browser/device interaction and the user cancels or times out.
- The gateway becomes unavailable while listing or creating sessions.
- A session create request uses an unsafe, duplicate, empty, or too-long name.
- A session attach process exits immediately or cannot allocate a terminal.
- Local config directories are missing, unreadable, symlinks, too large, or contain files outside the allowlist.
- Setup partially succeeds and then fails before opening a terminal.
- A narrow terminal cannot fit the wide quick-action layout.
- A destructive action is requested from the keyboard shortcut path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The TUI MUST dispatch the selected command palette action when the user presses Enter.
- **FR-002**: The home screen MUST provide selectable quick actions for New Shell Session, Shell Sessions, Setup Coding Agents, Run Doctor, and Login/Switch Account.
- **FR-003**: Home quick actions and command palette actions MUST share one action execution path so behavior is consistent.
- **FR-004**: The TUI MUST show visible running, success, failure, and cancelled states for executed actions.
- **FR-005**: The TUI MUST refresh its status summary after any action that can affect login, gateway, or session state.
- **FR-006**: The TUI MUST not render decorative mascot art or large non-actionable ASCII poster art on the home screen.
- **FR-007**: The TUI MUST support keyboard shortcuts for the most-used home actions, including new session, sessions list, setup wizard, doctor, login, command palette, and quit.
- **FR-008**: Users MUST be able to list persistent shell sessions from a dedicated Sessions view.
- **FR-009**: Users MUST be able to create a persistent shell session from the TUI.
- **FR-010**: Users MUST be able to attach to a persistent shell session from the TUI.
- **FR-011**: Users MUST be able to remove or stop a persistent shell session only after confirmation.
- **FR-012**: The Sessions view MUST handle gateway-unavailable and unauthenticated states with clear recovery guidance.
- **FR-013**: The setup wizard MUST allow users to select one or more coding agents, initially Codex and Claude.
- **FR-014**: The setup wizard MUST detect supported local config sources and let users choose whether to import each one.
- **FR-015**: The setup wizard MUST present a confirmation summary before copying or writing any local configuration.
- **FR-016**: The setup wizard MUST report completed, skipped, and failed setup steps separately.
- **FR-017**: After setup completes, the TUI MUST offer to open a persistent shell session with a setup-complete message.
- **FR-018**: Local config migration MUST be opt-in per source and MUST NOT copy secrets or unsupported files without explicit allowlisting.
- **FR-019**: User-visible errors MUST be capped, allowlisted or normalized, and free of internal paths, provider secrets, raw stack traces, or raw gateway errors.
- **FR-020**: Action execution MUST prevent concurrent mutation conflicts by disabling or queuing conflicting actions while one is running.
- **FR-021**: Destructive actions MUST require an explicit confirmation state even when triggered by keyboard shortcut.
- **FR-022**: The feature MUST include public user documentation for TUI quick actions, session management, setup wizard behavior, and local testing expectations.

### Key Entities *(include if feature involves data)*

- **TUI Action**: A selectable command or workflow with title, group, shortcut, risk level, prerequisites, and execution behavior.
- **Action Execution**: A single run of a TUI action, including status, safe output, error code, recovery hint, and refresh behavior.
- **Quick Action**: A high-priority TUI action shown on the home screen with a stable shortcut.
- **Session Summary**: A display record for a persistent shell session, including name, state, working context, and available actions.
- **Setup Wizard State**: The step-by-step choices, detected sources, confirmation summary, progress, and result of coding-agent setup.
- **Coding Agent Selection**: The user's selected agent tools, initially Codex and Claude.
- **Config Migration Source**: A detected local configuration source such as Codex, Claude, or agent config, with eligibility, selected state, and import result.
- **Setup Result**: The completed/skipped/failed outcome list and optional shell session created after setup.

### Assumptions

- Persistent shell-session creation/list/attach/remove should reuse the existing Matrix shell-session service where possible.
- The first setup wizard version supports Codex and Claude only; other agents can be added later through the same selection model.
- Migration defaults to safe metadata and configuration files, not credentials, opaque caches, or large histories.
- Direct terminal attach may hand off from the React TUI to the existing terminal attach flow rather than embedding a second terminal renderer inside the TUI.
- Rich session features such as layout picker, rename, search/filter, and pane management can follow after the MVP if the first session list/create/attach/remove flow is solid.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can run login, doctor, status, or whoami from the command palette and see a visible result without leaving the TUI in at least 95% of successful command attempts.
- **SC-002**: A user can create and attach to a persistent shell session from the TUI in under 60 seconds when the gateway is healthy.
- **SC-003**: A user testing on a laptop without a reachable gateway sees a clear recovery message for session actions in 100% of tested gateway-unavailable cases.
- **SC-004**: A first-run user can complete the coding-agent setup wizard, skip or select migration, and open a terminal in under 3 minutes.
- **SC-005**: No user-visible TUI error message exceeds 240 characters or exposes internal filesystem paths, raw stack traces, provider secrets, or raw gateway error text.
- **SC-006**: Home screen quick actions remain readable and selectable at 60, 80, and 100 terminal columns.
- **SC-007**: Destructive session actions require confirmation in 100% of keyboard and palette invocation paths.
- **SC-008**: Public docs describe local laptop testing, quick actions, session management, setup wizard choices, and known gateway prerequisites before release.
