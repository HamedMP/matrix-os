# Feature Specification: Cloud Coding Workspaces

**Feature Branch**: `[069-cloud-coding-workspaces]`
**Created**: 2026-04-26
**Status**: Draft; browser IDE proxy slice implemented and deployed 2026-04-26
**Input**: User description: "Full Matrix-native project management and cloud coding workspace: bring a desktop coding-board experience into Matrix OS, with project management beside the shell, Matrix CLI workflows, remote cloud coding, zellij-native terminal sessions, task/worktree workflows, browser code editor, browser/preview panels, GitHub PR workflows, autonomous multi-agent review loops, and nearly full functionality/UI/UX as a first-class Matrix app."

## Overview

Matrix OS becomes a cloud coding environment where GitHub repositories are projects, branches and pull requests can be opened as isolated worktrees, tasks own durable shell or agent sessions, and humans can attach from web, CLI/TUI, desktop, or local terminal without losing state. Coding agents such as Claude, Codex, OpenCode, and Pi run inside Matrix-managed sessions, while a browser IDE and preview panels sit beside project/task context.

The workspace has two layers:

1. **Headless source of truth**: file-backed project, task, worktree, session, review, transcript, and activity records under the user's Matrix home.
2. **Multiple shells**: Matrix web workspace, terminal app, desktop app, browser IDE, Matrix CLI, and Ink TUI all read and mutate the same state through gateway APIs.

The advanced workflow is an autonomous review loop: Matrix checks out a PR in a worktree, runs a reviewer agent, parses structured findings, runs an implementer agent, commits fixes, and repeats until a convergence gate passes or the loop stalls.

### Implemented Slice: Browser IDE Proxy

The first implementation slice delivers `https://code.matrix-os.com/?folder=/home/matrixos/home` through the Matrix platform. Each user container starts code-server on private port `8787`, the orchestrator records and exposes that private port, and the platform routes authenticated `code.matrix-os.com` HTTP and WebSocket traffic to the user's container without exposing code-server directly.

The slice also handles browser editor subresources: Matrix issues a short-lived `matrix_code_session` cookie, preserves `Host: code.matrix-os.com` for code-server WebSockets, strips Matrix credentials before proxying to code-server, serves non-user code-server static application assets when browsers omit cookies, and marks those asset responses `no-store` for browser and CDN caches so auth HTML cannot poison JavaScript, worker, service-worker, icon, or font URLs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Projects Beside Shells (Priority: P1)

A developer opens Matrix OS and manages coding projects from a dedicated workspace that combines project list, git status, task queue, and live terminal sessions in one place.

**Why this priority**: The core value is replacing a separate desktop coding manager with a Matrix-native workspace where the shell and project context are visible together.

**Independent Test**: Can be fully tested by opening the workspace, selecting a project under the user's projects folder, and starting or attaching to a live shell session without leaving Matrix OS.

**Acceptance Scenarios**:

1. **Given** the user has one or more projects, **When** they open the workspace, **Then** they see a searchable project list with status indicators and a primary action to open a shell for each project.
2. **Given** the user selects a project, **When** the project detail view opens, **Then** the workspace shows project metadata, active sessions, task summary, and git state without requiring a separate terminal-only window.
3. **Given** a project has no active shell session, **When** the user chooses "Open Shell", **Then** Matrix creates a durable cloud coding session associated with that project and displays it in the workspace.
4. **Given** a project already has an active shell session, **When** the user opens it from the workspace, **Then** Matrix attaches to the existing session without losing terminal state.

---

### User Story 2 - Run Agent Work Per Task (Priority: P1)

A developer creates a task, assigns it to an agent or manual shell, and tracks progress through a task-focused workspace where the task, shell, git state, and output remain linked.

**Why this priority**: Task-to-session linkage is the central workflow for cloud coding: every meaningful unit of work needs context, execution, status, and persistence.

**Independent Test**: Can be tested by creating a task in a project, starting an agent session for it, changing task status, and reattaching later to the same running session.

**Acceptance Scenarios**:

1. **Given** a project is open, **When** the user creates a task, **Then** the task appears in the project's board/list with title, status, priority, and optional description.
2. **Given** a task exists, **When** the user starts an agent session for it, **Then** Matrix creates or attaches to a durable session named and scoped to that task.
3. **Given** an agent session is running for a task, **When** the agent output indicates waiting, running, failed, or complete state, **Then** the task row/card reflects that state.
4. **Given** the user closes the workspace or reloads Matrix OS, **When** they return to the task, **Then** they can reattach to the same session and see task context preserved.

---

### User Story 3 - Edit Project Files In The Browser (Priority: P1)

A developer opens an authenticated browser IDE for their Matrix workspace and views, edits, searches, and saves files in their projects without exposing the in-container editor directly.

**Why this priority**: Cloud coding is incomplete if users can only run shells. They need a first-class file editor for inspecting project structure, editing source files, and using familiar coding workflows from any browser.

**Independent Test**: Can be tested by opening the browser IDE for `/home/matrixos/home`, selecting a project folder, editing a file, saving it, and confirming the change is visible to the same user's shell and workspace surfaces.

**Acceptance Scenarios**:

1. **Given** the user is authenticated, **When** they open the code workspace, **Then** Matrix opens the user's in-container editor at the requested project or home folder.
2. **Given** the user opens a project folder in the browser IDE, **When** they browse the file tree, **Then** they can view, edit, create, rename, and delete files according to their container filesystem permissions.
3. **Given** the user saves a file in the browser IDE, **When** they inspect the same file from a Matrix shell or project workspace, **Then** the saved content is immediately visible in the user's container.
4. **Given** the editor loads scripts, fonts, icons, service workers, or WebSocket connections, **When** those resources are requested, **Then** Matrix serves them through the authenticated editor route without cacheable auth HTML or MIME-type corruption.
5. **Given** the user is not authenticated or their editor session expires, **When** browser IDE assets or sockets are requested, **Then** Matrix rejects those requests without leaking files or serving misleading editor assets.

---

### User Story 4 - Use Worktrees and Git Safely (Priority: P2)

A developer starts isolated work for a task, reviews changes, and manages branch/worktree state from the workspace without manually juggling folders and terminal state.

**Why this priority**: Worktree-per-task is a major productivity feature, but it must be built on Matrix's file ownership and git safety model rather than local desktop assumptions.

**Independent Test**: Can be tested by creating a task worktree, making a change, viewing changed files, and closing or preserving the worktree according to explicit user choice.

**Acceptance Scenarios**:

1. **Given** a git project is selected, **When** the user creates an isolated task workspace, **Then** Matrix creates a task-scoped working area with clear source branch and current branch information.
2. **Given** a task workspace has changes, **When** the user opens the review view, **Then** they see changed files, branch, dirty count, and available next actions.
3. **Given** a task workspace is no longer needed, **When** the user removes it, **Then** Matrix requires confirmation when uncommitted changes exist and explains what will be preserved or deleted.

---

### User Story 5 - Preview Apps and Browser Context (Priority: P2)

A developer runs local or cloud dev servers from a project session and opens previews, docs, or issue links beside the task and shell.

**Why this priority**: Full coding workflow requires feedback loops beyond the terminal: app preview, documentation, issue references, and screenshots.

**Independent Test**: Can be tested by running a dev server in a project, detecting or entering a preview URL, and opening it in a workspace panel that persists with the task/project.

**Acceptance Scenarios**:

1. **Given** a session emits a local preview URL, **When** Matrix detects it, **Then** the workspace offers to open it in the project preview panel.
2. **Given** a task has browser/preview URLs saved, **When** the user reopens the task, **Then** the preview panel restores the saved URLs.
3. **Given** a preview fails to load, **When** the user views the preview panel, **Then** Matrix shows a recoverable error with retry and open-external options.

---

### User Story 6 - Control Everything From Matrix CLI (Priority: P3)

A developer can script the same workspace actions from the Matrix CLI: list projects, create tasks, open sessions, attach shells, and inspect task/session state.

**Why this priority**: The CLI must be a first-class peer to the web workspace so remote workflows, agents, and future extensions share one contract.

**Independent Test**: Can be tested by using CLI commands to create a task, create or attach the session, and observe the workspace update with the same project/task state.

**Acceptance Scenarios**:

1. **Given** Matrix CLI is logged in, **When** the user lists projects or tasks, **Then** output matches the workspace state.
2. **Given** the user creates a task from CLI, **When** they open the web workspace, **Then** the new task appears without manual refresh.
3. **Given** the user attaches to a task session from CLI, **When** the web workspace also attaches, **Then** both clients observe the same running session.

---

### User Story 7 - Manage GitHub Pull Requests As Projects (Priority: P1)

A developer adds a GitHub repository to Matrix, browses branches and pull requests, opens a PR in an isolated worktree, and starts shell or agent sessions against that worktree.

**Why this priority**: GitHub PRs and branches are the most common unit of cloud coding work. The workspace must make them first-class rather than forcing users to manually clone and checkout from a terminal.

**Independent Test**: Can be tested by authenticating `gh`, adding a repository, listing open PRs, creating a PR worktree, starting a session on it, and confirming the project/worktree/session records are visible from web and CLI.

**Acceptance Scenarios**:

1. **Given** the user has authenticated GitHub in their container, **When** they add `github.com/{owner}/{repo}`, **Then** Matrix clones the repository into a managed project folder and records GitHub owner/repo metadata.
2. **Given** a GitHub-backed project exists, **When** the user opens the project PR view, **Then** Matrix lists pull requests with number, title, branch, author, status, and last refresh time.
3. **Given** a PR is selected, **When** the user chooses "Open Worktree", **Then** Matrix creates or reuses a PR-scoped git worktree and links it to the project, PR, task, and sessions.
4. **Given** GitHub auth is missing, expired, or rate-limited, **When** a GitHub operation is attempted, **Then** Matrix shows an actionable state without corrupting project metadata or leaking provider errors.

---

### User Story 8 - Run Autonomous Multi-Agent Review Loops (Priority: P1)

A developer starts a review loop for a pull request and Matrix coordinates reviewer and implementer agents through structured findings, commits, re-review rounds, and convergence checks.

**Why this priority**: The distinctive cloud coding workflow is not just remote shells; it is durable, inspectable AI work that can review, fix, and verify pull requests while the user watches or intervenes.

**Independent Test**: Can be tested with mock agents by starting a review loop, producing findings in round 1, applying a fix in round 1, producing zero findings in round 2, and observing the review transition to converged with round history preserved.

**Acceptance Scenarios**:

1. **Given** a GitHub PR worktree exists, **When** the user starts a review loop, **Then** Matrix creates a review record, acquires the worktree write lease, and starts the configured reviewer agent.
2. **Given** the reviewer completes a round, **When** structured findings and a control file are atomically written, **Then** Matrix parses findings, records severity counts, and decides whether to converge or spawn an implementer.
3. **Given** findings exist, **When** the implementer agent finishes, **Then** Matrix records the fix commit and starts the next reviewer round.
4. **Given** the reviewer produces zero findings and verification gates pass, **When** Matrix parses the round output, **Then** the loop becomes converged and releases the worktree write lease.
5. **Given** parsing fails, verification fails, max rounds are reached, or an agent exits unexpectedly, **When** the loop can no longer progress safely, **Then** Matrix records a distinct recoverable state and exposes next/approve/stop actions according to the state.

---

### User Story 9 - Use An Interactive Matrix TUI (Priority: P2)

A developer runs `matrixos` with no subcommand and gets an interactive dashboard for sessions, projects, PRs, worktrees, tasks, and review loops without memorizing commands.

**Why this priority**: The CLI should be a complete remote interface, not only a collection of scriptable commands. A TUI gives SSH/local-terminal users parity with the web workspace.

**Independent Test**: Can be tested by opening the TUI, navigating projects and sessions, starting or attaching to a session, and confirming the same changes appear in the web workspace.

**Acceptance Scenarios**:

1. **Given** the user is logged in with Matrix CLI auth, **When** they run `matrixos` or `matrixos tui`, **Then** Matrix opens a keyboard-driven dashboard with sessions, reviews, projects, tasks, and PRs.
2. **Given** the dashboard is open, **When** the user selects a session, **Then** Matrix can attach in the TUI, hand off to native Zellij attach, or open the shared gateway terminal stream.
3. **Given** project or review state changes outside the TUI, **When** the dashboard refreshes, **Then** the changed state is visible without restarting the TUI.

---

### User Story 10 - Attach Through Zellij-Native Sessions (Priority: P1)

A developer starts durable coding sessions backed by Zellij, attaches locally when available, and falls back to Matrix terminal streaming when native attach is unavailable.

**Why this priority**: Zellij provides durable human-facing terminal sessions, layout restoration, and local attach semantics. Matrix still needs a gateway-backed bridge so browser and desktop clients can share the same sessions.

**Independent Test**: Can be tested by starting an agent session, attaching through the web terminal, attaching through `matrixos session attach --terminal`, restarting the gateway, and confirming transcript replay plus session metadata recover.

**Acceptance Scenarios**:

1. **Given** Zellij is available in the container, **When** Matrix starts an agent session, **Then** it creates a named Zellij session from a generated layout and stores the runtime metadata.
2. **Given** a browser client attaches to the session, **When** the gateway connects, **Then** Matrix streams output through the terminal registry with bounded replay and live fanout.
3. **Given** a local terminal client asks for native attach, **When** Zellij attach is available, **Then** Matrix provides or runs the native attach command and preserves the same session identity.
4. **Given** Zellij is unavailable or degraded, **When** a session is started or recovered, **Then** Matrix records the degraded runtime state and falls back to tmux or direct PTY only according to documented policy.

### Edge Cases

- If the project folder disappears, Matrix keeps task metadata visible and marks shell/session actions unavailable until the path is restored or reassigned.
- If a session exits unexpectedly, Matrix preserves task and session metadata, records the exit state, and offers restart or archive actions.
- If two clients attach to the same session, Matrix treats the session as shared and clearly indicates multiple active clients.
- If a native Zellij session exists but the Matrix gateway was restarted, Matrix reconciles persisted session records, Zellij runtime state, bridges, and transcript replay before reporting the session as healthy.
- If a project has more tasks or sessions than can be shown comfortably, Matrix paginates or virtualizes lists without hiding status changes.
- If git status collection times out, Matrix shows stale or unknown git state without blocking task/session management.
- If a task worktree has uncommitted changes, destructive cleanup actions require explicit confirmation and never run silently.
- If a worktree is locked by an active session or review loop, competing writes are rejected with holder information and read-only attach remains available.
- If a GitHub clone, PR checkout, or branch refresh times out, Matrix cleans up staged paths and preserves the last known good project record.
- If review findings cannot be parsed, Matrix records `failed_parse` and never treats the round as converged.
- If a review loop reaches max rounds, Matrix marks it stalled and exposes stop, next, and approve actions subject to explicit user choice.
- If an agent sandbox preflight fails, Matrix refuses to launch privileged or unsafe sessions unless an administrator has explicitly configured an override.
- If the user's permissions do not allow accessing a path, Matrix returns a generic user-facing error and records detailed diagnostics server-side.
- If browser IDE static application assets are requested without credentials, Matrix may serve only non-user editor bundle assets and must mark those responses as non-cacheable by shared/CDN caches. Matrix must never return cacheable auth HTML that can poison JavaScript, font, icon, or service worker caches.
- If the browser IDE WebSocket reconnects after a reload, Matrix preserves the public editor host and routes the socket back to the same user's in-container editor.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a Matrix-native workspace app for browsing, searching, and opening coding projects owned by the current user.
- **FR-002**: System MUST show project-level status including path availability, git repository presence, current branch, dirty change count, active session count, and recent task activity.
- **FR-003**: Users MUST be able to create, edit, reorder, filter, and archive tasks within a project.
- **FR-004**: Tasks MUST support at minimum title, description, status, priority, project association, optional parent task, optional due date, linked session, and linked working area.
- **FR-005**: System MUST support both board and list views for project tasks, with view preference persisted per project or user.
- **FR-006**: Users MUST be able to create or attach durable project and task shell sessions from the workspace.
- **FR-007**: Shell sessions MUST preserve state across Matrix web reloads, workspace close/open cycles, and CLI attach/detach cycles.
- **FR-008**: Session tabs and panes MUST be represented as workspace-visible concepts so users can see and navigate the same shell structure from web and CLI clients.
- **FR-009**: Users MUST be able to start an agent session from a task using task context as the initial work context.
- **FR-010**: System MUST reflect session activity state on associated project/task surfaces using clear states such as starting, running, waiting, failed, exited, and complete.
- **FR-011**: Users MUST be able to create an isolated task working area from a project and see its source branch, current branch, and change summary.
- **FR-012**: System MUST prevent accidental loss of uncommitted work by requiring explicit confirmation before deleting or detaching task working areas with changes.
- **FR-013**: Users MUST be able to view changed files and basic diff summaries for a task working area.
- **FR-014**: Users MUST be able to save project/task preview URLs and reopen them in a workspace preview panel.
- **FR-015**: System SHOULD detect preview URLs emitted by sessions and offer to associate them with the active project or task.
- **FR-016**: Users MUST be able to run equivalent project, task, and session workflows from the Matrix CLI and observe those changes in the web workspace.
- **FR-017**: System MUST store project workspace state in Matrix-owned user data, not in a desktop-local application database.
- **FR-018**: System MUST expose all user-owned project/task/session metadata for export and deletion according to Matrix OS data ownership rules.
- **FR-019**: System MUST validate all project paths, file paths, task identifiers, branch names, and session names before use.
- **FR-020**: System MUST scope every project, task, session, preview, and working area operation to the authenticated user or authorized organization context.
- **FR-021**: System MUST never expose internal filesystem paths, provider errors, stack traces, or raw validation details in user-facing error responses.
- **FR-022**: System MUST bound in-memory session, event, preview, and task activity collections with eviction or pagination policies.
- **FR-023**: System MUST define recovery behavior for session crashes, stale task links, missing working areas, git timeouts, and preview failures.
- **FR-024**: System MUST include end-to-end verification that a project task can create a session, run work, update status, and reattach from both workspace and CLI.
- **FR-025**: System MUST include public Matrix documentation for cloud coding workspace workflows, CLI usage, and data ownership.
- **FR-026**: Users MUST be able to open an authenticated browser IDE for their Matrix home folder and for any project folder they are allowed to access.
- **FR-027**: Browser IDE sessions MUST support viewing, editing, creating, renaming, deleting, searching, and saving files inside the user's container filesystem according to container permissions.
- **FR-028**: Browser IDE file edits MUST be reflected in Matrix shells, project metadata, git status, and task working areas without requiring a separate sync step.
- **FR-029**: Browser IDE HTTP resources and WebSocket upgrades MUST be authenticated by Matrix and MUST NOT require exposing the in-container editor directly to the public internet.
- **FR-030**: Browser IDE JavaScript, worker, font, icon, and WebSocket resources MUST preserve correct content types, host routing, and cache behavior so the editor remains usable after reloads and auth transitions.
- **FR-031**: Users MUST be able to add GitHub repositories as Matrix projects by URL, with safe clone staging, slug generation, GitHub owner/repo metadata, and cleanup on failure.
- **FR-032**: Users MUST be able to list GitHub pull requests and remote branches for a project through web workspace, CLI, and TUI surfaces.
- **FR-033**: Users MUST be able to create, list, and remove branch-scoped and PR-scoped git worktrees using stable Matrix worktree identifiers that do not depend on unsafe branch-name path segments.
- **FR-034**: Worktree mutation MUST use exclusive write leases so active agent sessions and review loops cannot corrupt the same checkout concurrently.
- **FR-035**: Matrix MUST support agent sessions for at least Claude, Codex, OpenCode, and Pi when installed, and MUST expose installed/missing/degraded agent status.
- **FR-036**: Agent sessions MUST support Zellij as the preferred durable runtime and tmux or direct PTY as documented fallback modes.
- **FR-037**: Agent session records MUST include project, task, PR, worktree, agent, runtime, terminal session, transcript, status, owner, started time, last activity, and exit metadata.
- **FR-038**: Matrix MUST provide a session runtime bridge that registers Zellij/tmux-backed coding sessions with the terminal registry for web/desktop attach, bounded replay, and multi-client fanout.
- **FR-039**: Session transcripts MUST be durably persisted with retention, truncation, export, and rehydration behavior defined.
- **FR-040**: Users MUST be able to send input, kill, observe, take over, and natively attach to sessions according to explicit permissions and session mode.
- **FR-041**: Matrix MUST provide an autonomous review loop engine for GitHub PRs with reviewer and implementer agents, structured findings, round history, fix commits, max rounds, and terminal states.
- **FR-042**: Review loop convergence MUST require successful parsing of structured findings and zero findings, and MAY require configured verification commands before marking the loop converged.
- **FR-043**: Review loop failures MUST distinguish agent failure, parse failure, verification failure, stalled max rounds, missing worktree, and operator stop.
- **FR-044**: Matrix MUST expose review loop operations from web, CLI, and TUI surfaces, including start, status, watch, next, approve, and stop.
- **FR-045**: The Matrix CLI MUST support project, worktree, task, session, review, and agent-sandbox commands with scriptable output modes.
- **FR-046**: Running `matrixos` with no subcommand or `matrixos tui` MUST open an interactive Ink-based dashboard for projects, PRs, tasks, sessions, worktrees, and reviews.
- **FR-047**: The TUI MUST support keyboard navigation, attach/watch actions, project browsing, review status, and native terminal handoff.
- **FR-048**: All GitHub, git, agent, and runtime subprocesses MUST use argument-vector execution, bounded timeouts, sanitized environments, and structured error mapping.
- **FR-049**: Codex-style or otherwise sandboxed agent launches MUST perform a startup/preflight check and fail closed when required sandbox capabilities are unavailable.
- **FR-050**: Startup recovery MUST reconcile file-backed records, runtime sessions, worktree leases, transcript state, review loops, and browser IDE availability before serving healthy workspace state.

### Security Architecture

- Every project/task/session endpoint, stream, and CLI-backed operation MUST require authenticated user context and MUST enforce ownership or organization authorization before reading or mutating data.
- The spec treats user-controlled paths, names, branch refs, session names, preview URLs, and commands as untrusted input. Each boundary MUST validate and normalize input before use.
- Mutating operations MUST apply request body size limits before buffering request bodies.
- Destructive operations MUST distinguish "not found", "permission denied", validation failure, and internal failure without leaking internals to clients.
- Browser/preview surfaces MUST only navigate to allowed URL schemes and MUST not inherit privileged Matrix credentials.
- Browser IDE access MUST be scoped to the authenticated user's container and MUST use short-lived Matrix-issued editor session credentials for subresources and WebSocket reconnects.
- Browser IDE static application assets that contain no user data MAY be served without user credentials when browsers omit cookies for module, worker, font, or icon fetches.
- Multi-step state changes that update more than one persistent record MUST be atomic or explicitly document acceptable orphan states and recovery.
- GitHub URLs, branch names, PR numbers, worktree identifiers, task identifiers, session identifiers, review identifiers, and agent names MUST be validated before any filesystem or subprocess use.
- Agent execution MUST run as the non-root Matrix user and MUST NOT receive Matrix platform secrets except through explicitly scoped launch context.
- Review loop prompts and generated control files MUST be treated as untrusted inputs until validated; malformed findings cannot advance a review to convergence.
- Native terminal attach and takeover MUST distinguish observe/read-only mode from write mode.

### Integration Wiring Requirements

- The workspace app, Matrix shell terminal surface, Matrix CLI, and future editor extensions MUST share the same project/task/session source of truth.
- The browser IDE MUST open from project/task workspace context and MUST support deep links to the user's home folder, selected project folders, and task working areas.
- Session creation and attachment MUST resolve dependencies at registration/startup time, not lazily at first user action.
- Workspace UI MUST subscribe to project/task/session changes so CLI actions and web actions converge without manual refresh.
- The implementation plan MUST define startup order for project state, session state, browser IDE availability, git status collection, preview detection, and workspace event broadcasting.
- GitHub project actions MUST route through the same project manager used by CLI, TUI, web, and desktop clients.
- `/api/sessions` MUST be the business source of truth for coding sessions; low-level terminal registry APIs remain transport primitives.
- Review loop state MUST be visible as project/task/session activity so desktop/web/TUI users can attach to the active agent round.

### Resource and Failure Requirements

- Git status checks, preview detection, and external metadata refreshes MUST have bounded timeouts.
- Browser IDE proxy requests and editor startup MUST have bounded timeouts and recoverable failure states.
- Long-running session streams MUST have bounded replay buffers and documented cleanup behavior.
- Task and project lists MUST handle large workspaces without unbounded memory growth.
- Temporary files, screenshots, generated previews, and exported artifacts MUST have cleanup policies.
- Crashes during worktree/session creation MUST leave recoverable metadata and must not silently lose user work.
- Repository clones MUST use a bounded staging flow with size/time limits and cleanup on failure.
- Review loops MUST have bounded round counts, bounded transcript storage, and explicit stop/recovery behavior.
- Zellij/tmux/runtime process discovery MUST have bounded startup and reconciliation timeouts.
- Worktree leases MUST expire or become recoverable when the owning runtime is confirmed dead.

### Key Entities *(include if feature involves data)*

- **Project**: A user-owned or org-owned coding root with display name, Matrix path, git summary, task preferences, preview links, and associated sessions.
- **Task**: A unit of project work with title, description, status, priority, order, parent/child relationships, linked session, linked working area, and activity history.
- **Workspace Session**: A durable interactive shell context associated with a project or task, with tabs, panes, attached clients, lifecycle state, and replay/reattach metadata.
- **Browser IDE Session**: An authenticated browser editing surface connected to the user's container, opened at a home, project, or task working-area folder, with editor subresources and WebSockets routed through Matrix.
- **Working Area**: A task-scoped project checkout or branch/worktree context with source branch, current branch, dirty state, and cleanup status.
- **Preview**: A saved or detected URL associated with a project or task, including label, last status, and display preference.
- **Activity Event**: A bounded event record for task/session/git/preview changes used to update the workspace and CLI clients.
- **GitHub Remote**: Optional project metadata containing owner, repo, remote URL, default branch, auth state, last PR refresh, and last branch refresh.
- **Worktree Lease**: An exclusive write reservation for a working area, held by a session or review loop and released on normal exit or recovery.
- **Agent Session**: A workspace session launched with an agent command, runtime adapter, prompt/context, sandbox profile, transcript, and lifecycle status.
- **Review Loop**: A PR-scoped state machine with reviewer/implementer agents, round records, findings, commits, convergence gate, failure state, and operator controls.
- **Review Round**: One reviewer or implementer pass with prompts, report paths, control files, parse result, severity counts, commit SHA, timestamps, and terminal session links.
- **Session Transcript**: Append-only durable output history for replay, audit, search, and recovery, bounded by retention and truncation policy.

### Assumptions

- "Full Matrix-native" means Matrix OS is the source of truth for project/task/session state; no Electron main process or desktop-local database is required.
- The initial project scope is personal user workspaces; organization/shared workspaces may be planned as an extension but must not be blocked by the data model.
- Existing Matrix terminal and app runtime surfaces will be reused where appropriate, but the product requirement is a project workspace rather than a terminal-only view.
- The first browser IDE implementation uses the in-container code-server process behind Matrix's authenticated editor proxy; future implementations may replace it if they preserve the same user-facing file editing and security contract.
- The feature may be delivered in phases as long as each phase preserves the shared source of truth and does not introduce a separate terminal/session model.
- GitHub.com support is v1; self-hosted GitHub Enterprise, Gitea, and GitLab can be added later without changing the project/session source of truth.
- Zellij is the preferred human-facing session runtime, while tmux/direct PTY fallback exists for compatibility and recovery.
- File-backed JSON records are the initial durable store. Reverse indexes are derived or rebuilt; canonical mutation paths use atomic writes and operation logs where multi-record updates are required.
- Agent CLIs may be absent or unauthenticated in a container; Matrix surfaces that as explicit availability status instead of hiding launch actions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open a project, create a task, start a task shell session, and reattach to that session after reload in under 90 seconds.
- **SC-002**: A user can perform the same task-session attach workflow from both the web workspace and Matrix CLI with the same session state visible in both clients.
- **SC-003**: Project lists with at least 100 projects and task lists with at least 1,000 tasks remain usable, searchable, and responsive without blocking primary actions.
- **SC-004**: Session exit, missing project path, git timeout, and preview load failure each produce recoverable user-facing states with no raw internal errors.
- **SC-005**: No destructive working-area cleanup can complete without explicit confirmation when uncommitted changes are present.
- **SC-006**: 90% of first-time users can identify where to create a task, open a shell, and see session status without reading documentation.
- **SC-007**: End-to-end tests cover project creation/discovery, task creation, session create/attach, CLI/web convergence, worktree safety, and preview persistence.
- **SC-008**: Public docs describe cloud coding workspace concepts, CLI workflows, and data ownership before the feature is marked complete.
- **SC-009**: A user can open the browser IDE, edit and save a project file, reload the editor, and still see icons, fonts, workers, and WebSocket-backed editor features load with correct MIME types and authentication behavior.
- **SC-010**: A user can add a GitHub repository, list PRs, create a PR worktree, and start an agent session on that worktree without manually running git commands.
- **SC-011**: A user can attach to the same coding session from web terminal, CLI stream, TUI, and native Zellij attach with replay available after gateway restart.
- **SC-012**: A review loop can complete at least three autonomous rounds on a PR worktree, record findings and commits for each round, and stop as converged, stalled, failed, or operator-approved with no ambiguous terminal state.
- **SC-013**: Session attach completes in under 3 seconds for an existing healthy session, and live output fanout latency remains under 1 second for normal container network conditions.
- **SC-014**: Competing write sessions on the same worktree are rejected consistently, while observe/read-only attach remains available.
