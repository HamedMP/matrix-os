# Feature Specification: Matrix CLI TUI Action Console Follow-Up

**Feature Branch**: `085-cli-tui-action-console-v2`
**Created**: 2026-05-29
**Status**: Draft
**Input**: User description: "Remove the previous PR/spec and rebuild the TUI action console spec on top of the 084 Matrix CLI TUI stacked PR, preserving almost everything from the parent PR. Add real command execution, zellij-style session management, an agent setup wizard with optional local config migration, and homepage shortcuts for common shell/session actions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve the Parent TUI While Adding Working Actions (Priority: P1)

A user launches the Matrix CLI TUI from the 084 stack and still sees the parent prompt-first home, product identity, rabbit mascot, status line, keyboard hints, and command-family coverage. New shortcuts and action affordances execute the existing actions instead of replacing or deleting parent UI behavior.

**Why this priority**: The follow-up is only valid if it is additive on top of the parent 084 TUI. Regressing the parent layout, mascot, prompt copy, shortcuts, sessions language, or direct command compatibility invalidates the work.

**Independent Test**: Can be tested by comparing the TUI against the 084 parent branch, then selecting every new home/palette action and verifying that it executes or reports a bounded, safe failure without removing existing entry points.

**Acceptance Scenarios**:

1. **Given** the 084 parent TUI home screen, **When** this follow-up is applied, **Then** the existing prompt text, status line, command-family hints, rabbit mascot, keyboard shortcuts, and command palette remain present unless the spec explicitly lists an approved removal.
2. **Given** a visible home shortcut such as login, doctor, new shell, or sessions, **When** the user activates it, **Then** the TUI runs the corresponding action or opens the corresponding view instead of only changing visual selection state.
3. **Given** any parent 084 view, command-family entry, state helper, or keyboard shortcut, **When** the follow-up changes it, **Then** the change is covered by a regression test and the spec explains why the behavior is preserved or intentionally extended.

---

### User Story 2 - Use Home Shortcuts for Daily Shell Work (Priority: P2)

A returning developer opens the TUI and can immediately create a shell session, list existing Matrix sessions, attach to a session, run doctor/status, or start login from the home screen without knowing slash commands.

**Why this priority**: The user explicitly wants the home page to expose the most-used commands, especially creating shell sessions and listing zellij-backed sessions.

**Independent Test**: Can be tested from the home screen by creating a session, listing sessions, attaching to one, and returning to the TUI without using command syntax.

**Acceptance Scenarios**:

1. **Given** a logged-in user with a reachable gateway, **When** they activate "New Shell" from the home screen, **Then** a Matrix shell session is created through the existing shell/session backend and the user receives attach/observe options.
2. **Given** existing shell or coding sessions, **When** the user activates "Sessions" from the home screen, **Then** the zellij-backed Matrix session cockpit opens with session status, kind, age, context, and available actions.
3. **Given** a missing login, gateway, zellij runtime, or sync dependency, **When** a home shortcut requires it, **Then** the TUI reports a safe, user-actionable message and leaves the user in the current TUI instead of silently doing nothing.

---

### User Story 3 - Manage Sessions Like a Zellij Workspace (Priority: P3)

A developer can create, list, attach, detach, observe, take over, stop, and navigate Matrix sessions with zellij-style mental models while the UI continues to call them Matrix sessions rather than narrowing the surface to "shell sessions" only.

**Why this priority**: Session management is the core daily workflow and must build on the parent session cockpit instead of replacing it with a smaller shell-only screen.

**Independent Test**: Can be tested with fake and real session clients by exercising create/list/attach/observe/takeover/stop flows and verifying state refresh, confirmations, and non-destructive detach behavior.

**Acceptance Scenarios**:

1. **Given** no active sessions, **When** the user opens the session cockpit, **Then** the empty state invites creating a Matrix session while preserving the parent "Matrix sessions" language.
2. **Given** multiple shell and coding sessions, **When** the user opens sessions, **Then** the list supports zellij-style actions such as attach, observe, takeover, stop, tabs, panes, and layout details where available.
3. **Given** a destructive session action, **When** the user selects it, **Then** the TUI requires confirmation and refreshes the session list only after the backend confirms success.

---

### User Story 4 - Complete Agent Setup Through a Wizard (Priority: P4)

A first-run or migrating user can open a setup wizard, choose which coding agents to configure, optionally migrate local non-secret configuration from existing tool directories, and finish in a terminal-ready state.

**Why this priority**: The TUI should explain and perform setup work instead of leaving login/setup commands as visual placeholders.

**Independent Test**: Can be tested in a temporary home directory with Codex and Claude migration fixtures, verifying preview, selection, writeback, skipped secrets, and final terminal handoff.

**Acceptance Scenarios**:

1. **Given** the setup wizard starts, **When** the user reaches the agent selection step, **Then** Codex is preselected, Claude is available but unchecked by default, and choices are keyboard-accessible.
2. **Given** local `.agent`, `.codex`, or `.claude` configuration exists, **When** the user chooses migration, **Then** the TUI previews what non-secret files/settings will be copied or adapted before writing anything.
3. **Given** setup completes, **When** all selected steps succeed or are explicitly skipped, **Then** the TUI opens or offers a terminal handoff with a concise "Done setup" completion state and a next action.

---

### User Story 5 - Make Local Laptop Evaluation Honest (Priority: P5)

A contributor testing locally on their own laptop can tell which actions are fully available, which need a running gateway/platform/auth, and which are disabled in source-only mode.

**Why this priority**: The previous local test looked broken because commands like login appeared selectable but did not visibly do anything. Local evaluation needs explicit capabilities and failure states.

**Independent Test**: Can be tested on a laptop without production services by launching the TUI, attempting login/session/setup actions, and verifying clear capability states and bounded failures.

**Acceptance Scenarios**:

1. **Given** a source checkout without gateway or platform services running, **When** the user opens the TUI, **Then** actions that require those services show unavailable/degraded state and a concrete local command or requirement.
2. **Given** an action starts a backend request, **When** the backend is unreachable or slow, **Then** the TUI uses a bounded wait and shows a safe failure instead of hanging or ignoring input.
3. **Given** the user runs the documented local test command, **When** services and auth are configured, **Then** login, setup, shell creation, and session listing can be evaluated locally without the VPS being special.

### Edge Cases

- The parent 084 TUI changes while this follow-up is in review; this follow-up must rebase/restack and preserve the newest parent behavior.
- Terminal dimensions are 80x24, no-color, or too narrow for both mascot and shortcuts; critical status and prompts take priority while the mascot degrades compactly.
- A shortcut is activated while another action is in progress; duplicate work is prevented and progress remains visible.
- Login, gateway, platform, zellij, or shell backend is unavailable, slow, expired, or returns malformed data.
- Local migration files are missing, unreadable, too large, symlinked, contain secrets, or mix supported and unsupported formats.
- A session disappears between list and attach/stop.
- A user cancels setup or a destructive session action midway.
- The old/obsolete PR remains open in GitHub or Graphite while this replacement branch is reviewed; reviewers must treat this spec as the source of truth for the replacement.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: This follow-up MUST be stacked on `084-matrix-cli-tui-polish` and MUST treat the 084 spec and implementation as the parent source of truth.
- **FR-002**: The follow-up MUST be additive by default: no parent home content, mascot art, shortcuts, command-family entries, session cockpit concepts, state helpers, tests, or direct CLI behavior may be removed unless a later spec revision explicitly lists the removal and the user approves it.
- **FR-003**: The parent prompt-first home identity MUST remain visible, including the Matrix OS identity, "Ask Matrix..." prompt region, command-family hints, status line, and compact decorative rabbit mascot.
- **FR-004**: Homepage shortcuts MUST augment the parent home screen and MUST include at minimum login/setup where relevant, new shell session, sessions list, doctor/status, command palette, and quit.
- **FR-005**: Every visible home shortcut and command-palette action added by this follow-up MUST either execute a real action, open an actionable view, or show a safe unavailable state with a next step.
- **FR-006**: The TUI MUST NOT silently ignore login, setup, shell, session, doctor, or migration commands.
- **FR-007**: New action execution MUST reuse existing CLI/gateway/session clients from the 084 TUI direction rather than adding a separate persistence or command execution source of truth.
- **FR-008**: Session management MUST preserve the parent "Matrix sessions" model while exposing zellij-style operations for shell/coding sessions.
- **FR-009**: Users MUST be able to create a shell session from the home screen or command palette and then attach, observe, or return to the session list.
- **FR-010**: Users MUST be able to list sessions from the home screen and see shell/coding session kind, status, age, project/context, and available attach/observe/takeover/stop actions.
- **FR-011**: Destructive actions such as stopping/removing sessions or overwriting setup files MUST require explicit confirmation beyond initial selection.
- **FR-012**: The setup wizard MUST offer agent selection with Codex selected by default and Claude available but not selected by default.
- **FR-013**: The setup wizard MUST ask whether to migrate local tool configuration from `.agent`, `.codex`, `.claude`, or equivalent Matrix-supported local locations.
- **FR-014**: Migration MUST preview planned non-secret changes before writing and MUST skip secrets, tokens, credentials, symlinks, oversized files, and unsupported formats.
- **FR-015**: Setup completion MUST provide a terminal-ready completion state with a concise "Done setup" result and a next action.
- **FR-016**: Local laptop testing MUST distinguish source-only, gateway-running, authenticated, and fully configured states.
- **FR-017**: Actions that need gateway/platform/auth/zellij MUST show degraded or unavailable status when dependencies are missing and MUST include a concrete next step.
- **FR-018**: All backend, daemon, filesystem, and network calls initiated from the TUI MUST have bounded waits and safe user-facing errors.
- **FR-019**: User-supplied paths, session names, project identifiers, URLs, migration targets, and command inputs MUST be validated before use.
- **FR-020**: Owner-readable setup/config changes MUST be written through existing Matrix-managed files or adapters and MUST avoid copying secrets across tools.
- **FR-021**: Direct CLI subcommands and machine-readable output MUST remain compatible with the parent 084 requirements.
- **FR-022**: Regression tests MUST compare the follow-up against parent 084 preservation requirements for home content, mascot presence, shortcuts, command palette coverage, and session language.
- **FR-023**: Public CLI documentation or local quickstart documentation MUST explain how to run and evaluate the TUI locally, including service/auth prerequisites and expected degraded states.

### Approved Removals From Parent 084

No removals are approved in this spec.

Any future removal must be added here with: parent behavior, reason, user approval reference, replacement behavior, and regression test coverage.

### Key Entities

- **Parent TUI Contract**: The preserved 084 user-visible behavior, including home content, mascot, shortcuts, command palette coverage, session cockpit model, and direct CLI compatibility.
- **TUI Action**: A selectable command surfaced by the home screen or palette, including availability, execution state, success result, safe failure, and follow-up view.
- **Home Shortcut**: A high-priority action visible on the prompt-first home screen without replacing parent prompt/status content.
- **Session Operation**: A zellij-backed Matrix session action such as create, list, attach, observe, takeover, detach, stop, tab, pane, or layout inspection.
- **Setup Wizard**: A multi-step flow for agent selection, optional local config migration, preview, confirmation, writeback, and terminal handoff.
- **Migration Candidate**: A local file or setting discovered from supported tool directories, classified as copyable, adaptable, skipped, secret, unsupported, or unsafe.
- **Local Capability State**: The current evaluation mode for a local laptop, including source-only, gateway-running, authenticated, sync-ready, and zellij-ready states.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visual/regression review confirms 100% of parent 084 required home elements remain present unless explicitly listed under Approved Removals.
- **SC-002**: 100% of home shortcuts introduced by this follow-up execute, navigate to an actionable view, or show a safe unavailable state with a next step.
- **SC-003**: A logged-in local user can create a shell session and open the session list from the home screen within 3 keypresses each.
- **SC-004**: Session create/list/attach/observe/takeover/stop flows have tests covering success, unavailable backend, stale session, and destructive confirmation.
- **SC-005**: Setup wizard tests cover Codex-default selection, Claude opt-in, migration preview, secret skipping, cancellation, and completion handoff.
- **SC-006**: A source-only laptop launch clearly communicates missing gateway/auth/zellij dependencies within 10 seconds and does not present silent no-op actions.
- **SC-007**: Existing direct CLI tests from the parent stack continue passing with no output shape regressions.
- **SC-008**: The TUI remains readable at 80x24 with critical text taking priority over decorative mascot or shortcut density.

## Assumptions

- The old PR that attempted this work is obsolete and should not be reviewed as the implementation source of truth.
- This replacement PR is spec-first. Implementation should follow only after this spec is reviewed or explicitly accepted.
- The 084 TUI parent is allowed to evolve while this follow-up is pending; the follow-up must restack and preserve the newest parent behavior before implementation.
- The zellij runtime remains an implementation detail; user-facing language remains Matrix sessions unless native attach details are needed.
- Migration initially handles only supported non-secret local configuration and should skip uncertain data rather than guessing.
