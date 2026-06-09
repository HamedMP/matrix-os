# Feature Specification: macOS Developer Experience

**Feature Branch**: `088-macos-native-shell`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "Plan a Ghostty- and VS Code-level terminal and code editor experience for the Matrix OS macOS app, including whether CodeMirror is enough or Monaco is required."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work In A First-Class Terminal (Priority: P1)

A developer opens the Matrix OS macOS app, selects a project, and works in a fast, persistent terminal that feels native to macOS while attaching to the same Matrix-owned sessions used by the web shell, mobile shell, and CLI.

**Why this priority**: Terminal quality is the core developer trust test. If typing, rendering, resize, reconnect, and session persistence feel weak, the macOS app cannot become the user's daily coding surface.

**Independent Test**: Can be tested by opening a project terminal, running an interactive program, switching tabs, relaunching the app, and verifying that the same session remains usable without duplicated PTYs or lost output.

**Acceptance Scenarios**:

1. **Given** a developer has an authenticated Matrix runtime, **When** they open a project terminal in the macOS app, **Then** they can type, paste, resize, interrupt, and run interactive terminal programs in a persistent session.
2. **Given** a terminal command is still running, **When** the developer switches workspace tabs or relaunches the macOS app, **Then** Matrix offers to resume the same session instead of silently creating a new one.
3. **Given** the terminal transport disconnects, **When** the app reconnects, **Then** the UI shows a generic reconnecting state and resumes from the latest available stream position without exposing raw transport errors.

---

### User Story 2 - Edit Code With VS Code-Class Expectations (Priority: P2)

A developer opens files from the project tree and edits code with modern editor affordances: fast large-file handling, syntax highlighting, multi-file tabs, keyboard-first navigation, find/replace, diagnostics, formatting, and language intelligence.

**Why this priority**: A polished terminal alone is not enough for "VS Code-level greatness." Developers need a credible editor surface for everyday project work, not just a preview pane.

**Independent Test**: Can be tested by opening a TypeScript project, editing several files, using search/find/replace, viewing diagnostics, saving changes, and confirming the files change through the owner-controlled runtime file APIs.

**Acceptance Scenarios**:

1. **Given** a developer opens a supported code file, **When** the editor appears, **Then** it shows syntax highlighting, line numbers, selection, undo/redo, save state, and keyboard shortcuts consistent with macOS expectations.
2. **Given** a project has language tooling available, **When** the developer edits code, **Then** diagnostics, hover, completion, and go-to-definition are available without blocking typing.
3. **Given** a file changes externally, **When** the editor has unsaved local edits, **Then** Matrix warns about the conflict and does not overwrite local edits without an explicit user action.

---

### User Story 3 - Use One Coding Workspace, Not Separate Tools (Priority: P3)

A developer keeps terminal, editor, file tree, git, browser preview, artifacts, and agent work in one native workspace with persistent layout and a command palette that can route actions across all panes.

**Why this priority**: Matrix OS should not merely embed a terminal and editor. Its advantage is coordinating project state, agents, files, and review loops in one owner-controlled workspace.

**Independent Test**: Can be tested by opening a task workspace, arranging terminal and editor panes, asking the command palette to open a file and run a command, relaunching the app, and verifying layout plus state restoration.

**Acceptance Scenarios**:

1. **Given** a developer is in a task workspace, **When** they open terminal and editor panes, **Then** the panes share the active project, branch, task context, and safe file/session contracts.
2. **Given** a developer uses the command palette, **When** they search for a file, command, terminal session, or agent action, **Then** the action can be completed without leaving the workspace.
3. **Given** the app relaunches, **When** the developer returns to the workspace, **Then** Matrix restores the useful layout and recoverable references while marking stale resources clearly.

### Edge Cases

- The selected runtime is offline, provisioning, billing-locked, or missing; the app must show a recoverable state and avoid creating local-only source-of-truth state.
- The same project is open in the web shell and native macOS shell; file edits, terminal attachment, and session metadata must remain owner-scoped and conflict-aware.
- Terminal output bursts faster than the renderer can draw; the app must coalesce output, preserve interaction responsiveness, and respect bounded scrollback.
- A file is too large or binary-like for the full editor; the app must offer safe preview or open-external actions rather than freezing.
- Language tooling is unavailable or crashes; editing and saving must still work, while diagnostics fall back to unavailable state.
- WebView/editor workers fail to initialize; the app must show a safe editor failure state and keep the file tree/workspace usable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The macOS app MUST provide a first-party terminal workspace that can create, attach to, resume, detach from, and intentionally end Matrix-owned terminal sessions.
- **FR-002**: Terminal sessions MUST remain durable across workspace tab switching, app relaunch, and short network interruptions unless the user explicitly closes or ends the session.
- **FR-003**: Terminal UI MUST support interactive programs, copy/paste, resize, search, special key input, selectable themes, font preferences, and native macOS keyboard conventions.
- **FR-004**: Terminal error states MUST show generic user-safe messages while retaining internal diagnostics for logs or telemetry.
- **FR-005**: The implementation MUST keep the existing SwiftTerm terminal path as the launch-safe baseline until a Ghostty/libghostty spike proves build, rendering, licensing, lifecycle, and integration viability.
- **FR-006**: The implementation MUST define a terminal renderer abstraction so SwiftTerm and a future Ghostty/libghostty renderer can share the same Matrix session lifecycle contract.
- **FR-007**: The macOS app MUST provide a code editor workspace that can open, edit, save, close, and restore multiple project files through Matrix-owned file APIs.
- **FR-008**: The editor MUST support line numbers, syntax highlighting, undo/redo, dirty state, save/revert, find/replace, multi-file tabs, keyboard shortcuts, and conflict-safe saves.
- **FR-009**: The editor plan MUST treat CodeMirror as acceptable for lightweight file preview/editing and Monaco as the default target for the VS Code-class workspace editor.
- **FR-010**: Language intelligence MUST be provided through explicit language-service contracts and must not block core editing when unavailable.
- **FR-011**: File and editor operations MUST validate project IDs, file paths, revisions, encodings, file size limits, and write permissions at the route or IPC boundary.
- **FR-012**: The workspace MUST persist useful layout, selected project, open files, active panes, recoverable terminal references, and editor dirty/conflict states without storing raw secrets.
- **FR-013**: The command palette MUST expose project files, terminal sessions, git actions, agent actions, and editor commands with keyboard-first navigation.
- **FR-014**: The macOS app MUST use native windows, menus, settings, command routing, file panels, and AppKit bridges where native behavior materially improves developer experience.
- **FR-015**: Public documentation under `www/content/docs/` MUST be updated when the implementation ships.

### Key Entities *(include if feature involves data)*

- **Developer Workspace**: A project-scoped native workspace containing open panes, selected project, task context, and persisted layout.
- **Terminal Surface**: A rendered view attached to a Matrix terminal session, including renderer kind, focus, dimensions, search state, and recoverable session reference.
- **Editor Surface**: A rendered editor tab or split attached to a project file, including path, revision, dirty state, cursor/selection, diagnostics state, and conflict state.
- **Language Service Session**: A bounded project-scoped process or service that provides diagnostics, completion, hover, formatting, and navigation for supported files.
- **Workspace Command**: A command palette action with scope, label, input requirements, permissions, and execution result.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of dogfood users can open a project terminal, run an interactive command, switch away, return, and continue the same session without data loss.
- **SC-002**: Terminal input-to-echo latency stays under 50 ms p95 on a healthy local network to the user runtime, excluding command execution time.
- **SC-003**: 95% of supported text/code files under 2 MB open to an editable state in under 1 second after file content is received.
- **SC-004**: The editor remains responsive while diagnostics or language services are starting, unavailable, or restarting.
- **SC-005**: No validation test can make terminal, editor, or workspace routes expose raw provider errors, filesystem paths outside the allowed project context, database errors, or secret-looking values to users.
- **SC-006**: A usability script covering file open/edit/save, find/replace, terminal run/resume, command palette open-file, and app relaunch succeeds for 90% of dogfood users without using an external editor.
