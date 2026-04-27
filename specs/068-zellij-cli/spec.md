# Feature Specification: Zellij-Native Shell and Unified CLI

**Feature Branch**: `068-zellij-cli`
**Created**: 2026-04-26
**Status**: Draft
**Input**: User description: "Unify the Matrix OS CLI around the published matrix command, make user-facing terminal sessions zellij-native, and define a stable contract for CLI and VSCode integrations."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resume The Same Terminal Everywhere (Priority: P1)

As a Matrix OS user, I want terminal sessions to be shared across the browser shell, CLI, and editor integrations so I can start work in one place and continue it elsewhere without losing tabs, panes, or running commands.

**Why this priority**: This is the core user value. Without shared persistent sessions, the CLI and shell continue to feel like separate products with separate state.

**Independent Test**: Create a named terminal session from one surface, attach to it from a second surface, and verify that the same running session, tabs, panes, and command output are visible.

**Acceptance Scenarios**:

1. **Given** a user has a named terminal session running, **When** they attach from another supported surface, **Then** they see the same live session state without creating a duplicate session.
2. **Given** a command is running inside a named session, **When** the user disconnects from one surface and reconnects from another, **Then** the command remains running and recent output is available.
3. **Given** multiple users or clients attach to the same owned session, **When** one client changes focus or sends input, **Then** the behavior is predictable and consistent with the shared-session model.

---

### User Story 2 - Use One Cloud-First CLI (Priority: P1)

As a developer or power user, I want one `matrix` CLI to handle login, profiles, sync, shell access, diagnostics, and instance operations so I do not need to remember separate development-only and published command surfaces.

**Why this priority**: The current split between repo-only commands and published commands causes drift, documentation confusion, and mismatched behavior between local and cloud use.

**Independent Test**: Install or run the Matrix CLI, log in to cloud or local mode, inspect status, and perform shell/session operations without using the old development CLI.

**Acceptance Scenarios**:

1. **Given** a new user has installed the CLI, **When** they run the login flow, **Then** the CLI guides them into an active profile and reports who they are logged in as.
2. **Given** a developer is working against a local Matrix OS stack, **When** they choose the local profile or development shortcut, **Then** the same CLI commands target the local environment.
3. **Given** a user asks for CLI help, **When** they inspect the shell command namespace, **Then** session, tab, pane, and layout operations are discoverable from the CLI itself.

---

### User Story 3 - Manage Sessions, Tabs, Panes, And Layouts (Priority: P2)

As a terminal-heavy user, I want first-class commands for sessions, tabs, panes, and layouts so I can script and repeat my Matrix OS workspace setup.

**Why this priority**: Persistent sessions provide the foundation, but structured management is what makes them usable for repeatable workflows and automation.

**Independent Test**: Use CLI commands to create a session, add tabs, split panes, save a layout, apply that layout, and remove the session.

**Acceptance Scenarios**:

1. **Given** no session exists with a chosen name, **When** the user creates a new named session, **Then** the session is created and the user can attach immediately.
2. **Given** a session exists, **When** the user adds a named tab or pane, **Then** the new workspace element appears in the session list and is available on reattach.
3. **Given** a user saves a layout, **When** they apply it to a later session, **Then** the expected workspace structure is restored or the user receives a clear validation error.

---

### User Story 4 - Give Editor Integrations A Stable Contract (Priority: P2)

As an extension author, I want a stable machine-readable local contract for session and sync operations so VSCode and future integrations can work without scraping human CLI output or reading internal files.

**Why this priority**: The VSCode extension and future tools need a durable integration surface before they can be built safely.

**Independent Test**: Build a minimal client that lists sessions, attaches to a session, requests auth context, and observes sync status using the documented contract.

**Acceptance Scenarios**:

1. **Given** a local integration client is authorized, **When** it requests session state, **Then** it receives versioned machine-readable data with stable field names.
2. **Given** the contract version changes in the future, **When** an older client connects, **Then** supported v1 operations continue to behave as documented for the compatibility window.
3. **Given** an integration client encounters an error, **When** the operation fails, **Then** it receives a stable error code and a generic safe message.

---

### User Story 5 - Diagnose And Recover From Common Failures (Priority: P3)

As a user, I want the CLI to explain login, daemon, sync, gateway, and session problems clearly so I can recover without needing internal knowledge of Matrix OS services.

**Why this priority**: Diagnostics are not the primary feature, but they reduce support load and make the unified CLI viable as the user's primary entry point.

**Independent Test**: Simulate expired auth, unavailable local services, missing session state, malformed layout input, and interrupted connections; verify the CLI reports actionable generic guidance.

**Acceptance Scenarios**:

1. **Given** the user is not logged in or their token is expired, **When** they run a command that requires auth, **Then** the CLI explains that login is required and names the relevant profile.
2. **Given** the session service is unavailable, **When** the user runs diagnostics, **Then** the CLI reports the failing dependency and suggests the next recovery action.
3. **Given** a terminal connection drops, **When** the user reconnects, **Then** the session remains available unless the underlying session was explicitly removed.

---

### User Story 6 - Browser Shell Parity With Modern Terminals (Priority: P2)

As a developer who lives in the browser shell, I want fonts, ligatures, theme controls, image rendering, durable scrollback, and command-block awareness on par with native terminals so I don't have to leave Matrix OS to get a polished terminal experience.

**Why this priority**: The persistent zellij sessions deliver the core workflow value, but the surrounding UX is what determines whether users adopt the browser shell as their primary terminal instead of a native app. Command-block awareness and a durable scrollback also unblock later AI workflows that rely on addressable command output.

**Independent Test**: Open a session, change font and theme through the preferences UI, run a command that emits an inline image, scroll back through more output than the in-memory hot buffer holds, and copy a single command block via the block-aware scrollback shortcut.

**Acceptance Scenarios**:

1. **Given** a user has set a custom font, ligature preference, cursor style, and theme override on a session, **When** they detach and reattach from any supported surface, **Then** their preferences are restored.
2. **Given** a session emits an iTerm2 or sixel inline-image escape sequence, **When** the user views the session live or via replay, **Then** the image renders without breaking adjacent output.
3. **Given** a session has produced more output than fits in the hot replay buffer, **When** the user scrolls back, **Then** older output is restored from the durable scrollback in original byte order with no gaps within the retained window.
4. **Given** the running shell emits OSC 133 semantic prompt marks, **When** the user views the session, **Then** the UI groups output by command block and the user can copy or reference one entire block by command.
5. **Given** the user clicks a recognized commit SHA, issue reference, or package specifier in terminal output, **When** the link is recognized, **Then** the user sees a clear action without losing terminal focus.

### Edge Cases

- A user attaches to a session that does not exist.
- A user attempts to create a duplicate session name.
- A user supplies an invalid session, tab, layout, profile, or path name.
- A layout is malformed, too large, or references unsupported workspace structure.
- A terminal connection disconnects during command execution.
- Multiple clients attach to the same session at the same time.
- The local daemon is stopped, stale, or running an incompatible protocol version.
- Auth expires while a user is performing a long-running operation.
- Legacy auth and configuration files exist from an older CLI version.
- A local profile and cloud profile both exist and the user runs a command without specifying a profile.
- A deprecated terminal surface still exists during migration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide one user-facing Matrix CLI for cloud and local development workflows.
- **FR-002**: The CLI MUST support named profiles, including predefined cloud and local profiles.
- **FR-003**: Users MUST be able to select a profile per command without permanently changing their active profile.
- **FR-004**: Users MUST be able to log in, log out, inspect identity, inspect status, and run diagnostics through the unified CLI.
- **FR-005**: Users MUST be able to list, create, attach to, and remove named terminal sessions.
- **FR-006**: Creating a new named terminal session MUST attach the user to that session by default.
- **FR-007**: Attaching to a missing session MUST fail with a clear message that tells the user how to create the session.
- **FR-008**: Users MUST be able to list, create, switch to, and close tabs within a named session.
- **FR-009**: Users MUST be able to split and close panes within the focused context of a named session.
- **FR-010**: Users MUST be able to list, view, save, apply, and remove named terminal layouts.
- **FR-011**: Terminal sessions MUST persist after an attached browser, CLI, or editor client disconnects.
- **FR-012**: The browser shell, CLI, and editor integrations MUST observe the same authoritative session state.
- **FR-013**: The CLI MUST offer machine-readable output for one-shot operations and streaming operations.
- **FR-014**: All machine-readable CLI and local integration messages MUST include a protocol version.
- **FR-015**: Local integrations MUST be able to use a documented contract for auth context, session control, and sync status.
- **FR-016**: Terminal byte streams MUST support reconnect behavior that avoids losing the user's active session.
- **FR-017**: The system MUST preserve enough recent terminal output for a reconnecting client to regain context.
- **FR-018**: Legacy CLI auth and configuration MUST migrate into the profile model without requiring users to manually edit files.
- **FR-019**: The old development-only CLI surface MUST be removed or redirected so users do not see competing command sets.
- **FR-020**: User-facing documentation MUST describe login, profiles, shell/session usage, machine-readable output, and migration from the old CLI.

### Security, Reliability, And Resource Requirements

- **FR-021**: Every session, tab, pane, layout, profile, and path value supplied by a user MUST be validated before use.
- **FR-022**: Mutating operations MUST enforce an explicit request size limit before reading request bodies or streamed input.
- **FR-023**: Session and layout operations MUST be authorized against the active user's identity and MUST NOT allow access to another user's environment.
- **FR-024**: Browser clients MUST use short-lived credentials for terminal connections; non-browser clients MAY use their active profile token when supported.
- **FR-025**: Client-visible errors MUST use stable generic messages and MUST NOT expose provider names, filesystem paths, raw command failures, or internal stack details.
- **FR-026**: Long-running external operations MUST have bounded timeouts and clear failure behavior.
- **FR-027**: Persistent session metadata and layout state MUST be written atomically.
- **FR-028**: In-memory client, replay, and session tracking structures MUST have bounded size and eviction behavior.
- **FR-029**: Temporary or derived session artifacts MUST have a cleanup policy.
- **FR-030**: The implementation plan MUST define the auth matrix, input validation rules, error policy, integration wiring, failure modes, resource limits, and cleanup behavior before implementation begins.

### Browser Shell Parity Requirements

- **FR-031**: Browser shell sessions MUST support per-session presentation preferences for font family, font size, ligature toggle, cursor style, and theme override, persisted with session metadata and restored on reattach.
- **FR-032**: Inline-image escape sequences (sixel and iTerm2) MUST be preserved through the gateway byte stream and rendered in the browser shell without corrupting adjacent text output.
- **FR-033**: Recent terminal output MUST be retained beyond the in-memory replay window through a per-session durable scrollback that survives gateway restart and is bounded in size per session.
- **FR-034**: The system MUST recognize OSC 133 semantic prompt marks emitted by supported shells and expose command-block ranges to clients without modifying the underlying byte stream.
- **FR-035**: The browser shell MUST detect commit SHAs, issue references, and package specifiers in terminal output and offer a safe action without altering the byte stream or stealing terminal focus.
- **FR-036**: Per-session preferences and durable scrollback MUST follow the same auth, validation, atomic-write, size-cap, and cleanup rules as other persistent session state.

### Key Entities *(include if feature involves data)*

- **Profile**: A named local configuration scope containing platform destination, gateway destination, active auth, and sync-related settings.
- **Terminal Session**: A persistent named workspace that can be attached from supported clients and can contain tabs, panes, running commands, and layout state.
- **Tab**: A workspace subdivision inside a terminal session, optionally named by the user.
- **Pane**: A focused terminal area inside a tab that can run commands and participate in split layouts.
- **Layout**: A named reusable terminal workspace structure that can be saved, validated, applied, and removed.
- **Daemon Request**: A versioned local integration message used by the CLI or editor integrations to request control-plane operations.
- **Stream Event**: A versioned machine-readable event emitted for long-running or streaming operations.
- **Legacy CLI Configuration**: Existing auth and sync settings from earlier CLI versions that must migrate into the profile model.
- **Session Preferences**: Per-session presentation settings (font family, font size, ligatures, cursor style, theme override) stored alongside session metadata.
- **Scrollback Archive**: A durable per-session append-only record of recent output beyond the in-memory hot buffer, bounded in size and cleaned up with the session.
- **Command Block**: A range of session output bounded by OSC 133 semantic prompt marks that clients can group, copy, and address as a unit.

### Assumptions

- The active feature scope covers the CLI, gateway/session service, local daemon contract, documentation, and compatibility during migration.
- Full browser shell migration to zellij-native sessions can be delivered after the foundational session APIs and CLI are available.
- The first editor integration target is VSCode, but the contract should be general enough for future editor or launcher integrations.
- Layout publishing and marketplace behavior are outside this feature.
- Renaming sessions is outside this feature unless a concrete user need appears during planning.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can log in, create a named terminal session, detach, and reattach from another supported surface in under 3 minutes during usability testing.
- **SC-002**: At least 95% of reconnect attempts to an existing named session restore live session access without creating duplicate sessions.
- **SC-003**: A new user can discover the shell session commands from CLI help without reading source code or internal docs.
- **SC-004**: A developer can switch between cloud and local profiles for the same command set without editing configuration files.
- **SC-005**: Machine-readable CLI output is parseable for 100% of documented one-shot and streaming operations.
- **SC-006**: A minimal local integration client can list sessions, request auth context, inspect sync status, and attach to a terminal using only the documented contract.
- **SC-007**: Legacy auth/config migration succeeds without manual file edits for existing users with supported legacy configuration.
- **SC-008**: Security review finds an explicit auth, validation, timeout, resource-limit, error-message, and cleanup policy for every new mutating or streaming operation.
- **SC-009**: User-facing docs cover login, profiles, shell session management, JSON output, and migration from the old CLI before release.
- **SC-010**: A user can change font, ligatures, cursor style, and theme override from the browser shell preferences UI without editing any configuration file, and the change persists across reattach.
- **SC-011**: At least 95% of replays that span beyond the in-memory hot buffer return output in original byte order with no gaps within the retained scrollback window.
- **SC-012**: With a shell configured to emit OSC 133, at least 95% of completed commands appear as a single addressable command block in the browser shell.
