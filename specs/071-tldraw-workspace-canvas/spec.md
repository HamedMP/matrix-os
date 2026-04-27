# Feature Specification: Workspace Canvas

**Feature Branch**: `071-tldraw-workspace-canvas`  
**Created**: 2026-04-27  
**Status**: Draft  
**Input**: User description: "Specify a tldraw-powered workspace canvas for Matrix OS where users can visually organize live terminal nodes, GitHub pull requests, review threads, files, notes, and app windows; support custom nodes later, persistent per-project canvases, safe shell integration, and PR review workflows. Build upon specs 068, 069, and 070."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See PR Work Visually (Priority: P1)

A developer opens a project or pull request workspace and sees the active work as a spatial canvas containing PR context, review status, linked tasks, and live terminal sessions.

**Why this priority**: The core value is replacing scattered terminals, browser tabs, and review notes with one inspectable workspace for active PR work.

**Independent Test**: Open a GitHub-backed project with an active PR worktree and verify that the canvas shows the PR, review state, linked task, and at least one attachable terminal node.

**Acceptance Scenarios**:

1. **Given** a project has an open pull request worktree, **When** the user opens the workspace canvas, **Then** the canvas shows a PR node linked to its worktree, task, review state, and terminal sessions.
2. **Given** the PR has unresolved review findings, **When** the user opens the PR node, **Then** the user can see finding counts, review rounds, and the next available action without leaving the canvas.
3. **Given** multiple PRs are active, **When** the user filters or focuses on one PR, **Then** unrelated nodes are de-emphasized without destroying their saved positions.

---

### User Story 2 - Use Live Terminals As Nodes (Priority: P1)

A developer opens, arranges, and attaches to live terminal sessions directly from canvas nodes while preserving the shared session behavior defined by Matrix terminal and CLI workflows.

**Why this priority**: Terminal nodes are the reason this canvas is a workspace, not a drawing tool. The canvas must respect durable session identity instead of creating duplicate terminal state.

**Independent Test**: Create or attach a terminal session from the canvas, reattach from the CLI or browser shell, and verify that all surfaces observe the same live session.

**Acceptance Scenarios**:

1. **Given** a project or task has no active terminal, **When** the user creates a terminal node, **Then** Matrix creates a durable owned session associated with that project or task.
2. **Given** a terminal session already exists, **When** the user opens its canvas node, **Then** Matrix attaches to the existing session rather than creating a duplicate session.
3. **Given** the user moves or resizes a terminal node, **When** they reload the workspace, **Then** the terminal node returns to the saved canvas position and can reattach to the same session.

---

### User Story 3 - Coordinate Review Loops (Priority: P1)

A developer starts or watches an autonomous PR review loop from the canvas and can inspect reviewer rounds, implementer rounds, findings, commits, and convergence state spatially.

**Why this priority**: Review loops are a primary cloud-coding workflow from spec 069, and the canvas should make their state visible instead of burying it in terminal output.

**Independent Test**: Start a review loop for a PR, complete at least one reviewer round and one implementer round, and verify the canvas records the round graph and current state.

**Acceptance Scenarios**:

1. **Given** a PR worktree exists, **When** the user starts a review loop from the canvas, **Then** the canvas shows the active review loop linked to the PR, worktree, agent sessions, and verification status.
2. **Given** a reviewer produces findings, **When** the findings are recorded, **Then** finding nodes or grouped summaries appear with severity, affected files, and associated round.
3. **Given** a loop converges, stalls, fails, or is stopped by the user, **When** the user returns later, **Then** the final state and round history remain visible.

---

### User Story 4 - Persist Project Canvases (Priority: P2)

A developer can maintain a saved canvas per project or per PR so spatial organization survives reloads, client changes, and VPS recovery.

**Why this priority**: Spatial memory is only valuable if it persists as Matrix-owned data and can be recovered with the user's workspace state.

**Independent Test**: Arrange nodes in a project canvas, reload from the browser, inspect from another client, and verify the layout and node links persist.

**Acceptance Scenarios**:

1. **Given** a user arranges a project canvas, **When** they reload Matrix OS, **Then** node positions, grouping, selection state, and view preferences are restored.
2. **Given** a user opens the same project from another supported surface, **When** that surface supports canvas viewing, **Then** it reads the same canvas document rather than a browser-local layout.
3. **Given** a VPS is recovered from backup, **When** the user opens the project canvas, **Then** the canvas document and node references are restored or marked recoverable if the linked runtime is missing.

---

### User Story 5 - Add Custom Nodes Safely (Priority: P2)

A developer can add notes, files, browser previews, app windows, GitHub issues, and later custom node types without weakening data ownership or terminal/session safety.

**Why this priority**: The canvas needs to become a general workspace substrate, but custom nodes must be explicit, typed, and bounded.

**Independent Test**: Add a note, file, preview, and app-window node to a project canvas, persist them, and verify invalid node definitions are rejected with a recoverable error.

**Acceptance Scenarios**:

1. **Given** a project canvas is open, **When** the user adds a note node, file node, or preview node, **Then** the node appears with validated metadata and persists with the canvas.
2. **Given** an app or extension proposes a custom node, **When** the node definition is missing required fields or exceeds limits, **Then** Matrix rejects it without corrupting the canvas document.
3. **Given** a custom node type is no longer available, **When** the canvas loads, **Then** Matrix displays a safe fallback node preserving the underlying data.

---

### User Story 6 - Navigate Large Workspaces (Priority: P3)

A developer can search, filter, group, zoom, and focus a large project canvas without losing orientation or waiting for inactive nodes to render fully.

**Why this priority**: PR-heavy users may have many terminals, tasks, previews, and findings. The canvas must scale beyond a demo board.

**Independent Test**: Load a canvas with at least 200 nodes and verify search, focus, filtering, and overview navigation remain usable.

**Acceptance Scenarios**:

1. **Given** a canvas has many nodes, **When** the user searches for a PR, task, file, or session, **Then** matching nodes are highlighted and can be focused.
2. **Given** the user zooms out, **When** live terminal nodes are too small for useful interaction, **Then** Matrix uses lightweight previews until the user focuses or zooms in.
3. **Given** the user groups related work, **When** they collapse the group, **Then** the canvas shows summary status while preserving member layout.

### Edge Cases

- A canvas references a terminal session that exited, was deleted, or has not recovered after gateway restart.
- A canvas references a worktree that is locked, missing, dirty, or recovered under a new runtime identifier.
- A review loop round fails to parse, reaches max rounds, or is stopped while the user is watching the canvas.
- A GitHub operation is unavailable because auth is missing, expired, or rate-limited.
- Multiple browser clients edit the same canvas at the same time.
- The user's VPS is provisioning, recovering, unreachable, or restored from older backup data.
- A custom node type is removed, malformed, oversized, or unauthorized.
- A canvas document grows beyond size limits or contains references to records the user no longer owns.
- A user tries to open a privileged file, unsafe URL, or unauthorized app from a node.
- A large canvas contains enough live nodes that rendering every embedded surface would degrade the workspace.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a Matrix workspace canvas for visually organizing project, task, PR, review, terminal, file, preview, note, and app-window nodes.
- **FR-002**: The workspace canvas MUST build on the shared session model from spec 068, so browser, CLI, editor, and canvas surfaces observe the same terminal session identity.
- **FR-003**: The workspace canvas MUST build on the cloud coding project model from spec 069, so projects, tasks, worktrees, pull requests, agent sessions, review loops, transcripts, and activity records remain the source of truth.
- **FR-004**: The workspace canvas MUST build on the VPS-per-user recovery model from spec 070, so canvas data is part of the user's recoverable Matrix-owned state rather than browser-local state.
- **FR-005**: Users MUST be able to open a canvas scoped to a project, task, pull request, or review loop.
- **FR-006**: Users MUST be able to create, attach, focus, move, resize, minimize, and close terminal nodes while preserving durable session state.
- **FR-007**: Terminal nodes MUST link to existing project/task/session records and MUST NOT create duplicate sessions when an attachable session already exists.
- **FR-008**: PR nodes MUST show owner/repo, PR number, title, branch/worktree state, review status, and linked sessions when that data is available.
- **FR-009**: Review loop nodes MUST expose current state, round history, finding summaries, fix commits, verification status, and allowed next actions.
- **FR-010**: Users MUST be able to add note, file, preview, app-window, issue, task, PR, review, and terminal nodes through explicit canvas actions.
- **FR-011**: Users MUST be able to connect compatible nodes visually without changing the underlying source-of-truth records unless they confirm a mutation.
- **FR-012**: The canvas MUST persist node positions, dimensions, grouping, links, viewport preferences, and per-canvas display options.
- **FR-013**: The canvas MUST support saved scopes at minimum for global developer workspace, project workspace, PR workspace, and review-loop workspace.
- **FR-014**: Users MUST be able to search, filter, focus, group, collapse, and expand canvas nodes.
- **FR-015**: The canvas MUST show lightweight previews for inactive or zoomed-out live nodes and only activate expensive live surfaces when focused or sufficiently zoomed in.
- **FR-016**: The system MUST support forward-compatible custom node types with typed metadata, migrations, validation, and safe fallback rendering.
- **FR-017**: Users MUST be able to export and delete their canvas documents with the rest of their Matrix-owned project data.
- **FR-018**: Canvas state changes made from one supported client MUST become visible to other clients without requiring a full Matrix OS restart.
- **FR-019**: User-facing documentation MUST explain workspace canvas concepts, terminal nodes, PR review nodes, data ownership, and recovery expectations.

### Security, Reliability, And Resource Requirements

- **FR-020**: Every canvas read, write, subscription, terminal action, PR action, review action, file action, and app-window action MUST enforce authenticated user or authorized organization context.
- **FR-021**: Every node identifier, canvas identifier, project identifier, session identifier, PR reference, worktree reference, file path, URL, custom node type, and custom node payload MUST be validated before use.
- **FR-022**: Mutating canvas operations MUST apply request body size limits before buffering payloads.
- **FR-023**: Client-visible errors MUST use safe generic messages and MUST NOT expose internal filesystem paths, raw provider output, stack traces, or raw validation details.
- **FR-024**: Multi-record updates that affect canvas documents plus project/task/session/review records MUST be atomic or document acceptable orphan states and recovery behavior.
- **FR-025**: Canvas document writes MUST be crash-safe and recoverable after gateway restart or VPS recovery.
- **FR-026**: Live terminal and app-window nodes MUST honor existing observe/write/takeover permissions and MUST NOT bypass terminal access controls.
- **FR-027**: Preview and browser nodes MUST restrict unsafe URL schemes and MUST NOT inherit privileged Matrix credentials into untrusted content.
- **FR-028**: In-memory canvas subscribers, render caches, pending saves, node previews, and collaboration presence records MUST have explicit caps and eviction or cleanup behavior.
- **FR-029**: The canvas MUST define degradation behavior for unavailable GitHub auth, missing worktrees, exited sessions, failed review rounds, and unavailable custom node renderers.
- **FR-030**: The implementation plan MUST include integration tests covering canvas-to-terminal attach, PR worktree display, review loop display, persistence, auth rejection, invalid payload rejection, and VPS recovery restore.

### Key Entities *(include if feature involves data)*

- **Canvas Document**: A Matrix-owned saved spatial workspace scoped to a user or organization and optionally to a project, task, PR, or review loop.
- **Canvas Node**: A typed visual item with position, dimensions, display state, metadata, and a link to a source-of-truth record or embedded canvas-owned content.
- **Canvas Edge**: A visual relationship between nodes, with optional label and metadata, that may represent navigation or an explicitly confirmed domain relationship.
- **Terminal Node**: A canvas node linked to a durable terminal or coding session from the shared session model.
- **PR Node**: A canvas node linked to a GitHub pull request and its Matrix project/worktree records.
- **Review Loop Node**: A canvas node linked to a review loop and its round history, findings, commits, verification status, and operator controls.
- **Custom Node Definition**: A versioned definition for rendering and validating a non-core node type.
- **Canvas View State**: Per-user viewport, selection, grouping, collapsed state, and display preferences for a canvas document.
- **Node Renderer**: A safe rendering capability for a node type, with fallback behavior when unavailable or unauthorized.

### Assumptions

- Specs 068, 069, and 070 are prerequisite architecture layers: shared Zellij-native sessions and CLI contract, cloud coding workspace records, and VPS-per-user recovery.
- The canvas is a first-class Matrix shell/workspace surface, not a sandboxed third-party app with direct access to terminal internals.
- The initially approved canvas engine has production licensing available, but the user-facing requirements are expressed around workspace behavior and data ownership.
- The initial scope is personal developer workspaces; organization-shared canvases can reuse the same ownership and authorization model later.
- Freeform sketching is served by the default Whiteboard app; this feature is for live workspace organization and PR review workflows.
- Existing Matrix window canvas behavior can be reused or migrated, but the source of truth must become typed canvas documents that survive reload and recovery.

### Security Architecture

| Surface | Operations | Auth Method | Public? | Authorization / Notes |
|---------|------------|-------------|---------|-----------------------|
| Canvas documents | list, read, create, update, delete, export | Matrix session or CLI token | No | User/org owns canvas scope; project/PR/task scopes must also be authorized. |
| Canvas subscriptions | watch canvas updates and presence | Matrix session or CLI token | No | Subscribers receive only authorized canvas and linked record summaries. |
| Terminal nodes | create, attach, observe, send input, takeover, kill | Matrix session or CLI token | No | Delegates to spec 068/069 session permissions; canvas never bypasses session controls. |
| PR/review nodes | refresh, start review, next, approve, stop | Matrix session or CLI token | No | Delegates to spec 069 project/worktree/review authorization and lease checks. |
| File nodes | open, preview, link, reveal | Matrix session or CLI token | No | Path must resolve within authorized project/home roots; no raw filesystem path leaks. |
| Preview/browser nodes | save URL, open preview, health check | Matrix session or CLI token | No | URL scheme allowlist; untrusted content isolated from privileged credentials. |
| Custom nodes | register, render, migrate, validate | Matrix session, CLI token, or approved app permission | No | Node definitions are versioned and scoped; invalid definitions fail closed. |

### Integration Wiring Requirements

- The canvas MUST read project, task, worktree, PR, review, agent session, transcript, and activity state from the workspace source of truth defined by spec 069.
- Terminal-node actions MUST route through the shared terminal/session contract from spec 068 and MUST preserve Zellij-native attach semantics when available.
- Canvas data MUST be included in the user-owned recoverable state covered by spec 070 R2 backup and VPS recovery flows.
- The browser shell, Matrix CLI, future TUI, and future editor integrations MUST be able to address canvas documents by stable identifiers.
- Startup recovery MUST reconcile canvas documents with current session, worktree, project, and review-loop state before reporting the canvas as healthy.
- The canvas renderer MUST degrade to safe summary nodes when a linked live surface is unavailable, unauthorized, or too expensive to render.

### Failure Modes And Resource Management

- Canvas document size MUST be bounded. Oversized documents must be rejected before persistence with a recoverable user-facing error.
- Canvas list and node queries MUST paginate or virtualize results for large workspaces.
- Live embedded terminals, previews, and app windows MUST have activation limits so a large canvas cannot mount every live surface at once.
- Save operations MUST be debounced and crash-safe; failed saves must leave the previous valid canvas document intact.
- Concurrent edits MUST either merge predictably or reject conflicting writes with a recoverable conflict state.
- Missing linked records MUST leave placeholder nodes that preserve the user's layout and explain the missing dependency safely.
- Temporary previews, derived thumbnails, exported canvas bundles, and renderer caches MUST have cleanup policies.
- Recovery after VPS reprovision MUST distinguish restored canvas documents, missing runtime sessions, and stale node references.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open a PR workspace canvas, identify the active PR, review state, linked task, and terminal node in under 30 seconds.
- **SC-002**: A user can create or attach to a terminal node and reattach to the same session from another supported surface with no duplicate session in at least 95% of attempts.
- **SC-003**: Canvas layout changes persist across browser reload and a second client can read the same layout without manual file editing.
- **SC-004**: A review loop with at least two rounds is represented on the canvas with round history, finding counts, and final state in 100% of successful test runs.
- **SC-005**: A canvas with 200 nodes remains searchable, focusable, and navigable without blocking primary interactions for more than 1 second under normal workspace conditions.
- **SC-006**: Invalid canvas payloads, unauthorized node references, unsafe URLs, and missing linked records each produce recoverable safe user-facing states.
- **SC-007**: VPS recovery restores saved canvas documents and marks unavailable runtime-linked nodes as recoverable rather than losing the canvas layout.
- **SC-008**: Security review confirms explicit auth, validation, timeout, resource-limit, error-message, and cleanup policy for every new canvas operation.
- **SC-009**: Public docs cover workspace canvas concepts, PR review workflows, terminal nodes, custom node boundaries, and data ownership before release.
