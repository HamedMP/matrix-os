# Research: Workspace Canvas

## Decision: Use tldraw as the browser rendering engine, not the canonical data model

**Rationale**: The feature asks for a tldraw-powered canvas, and tldraw provides mature spatial editing, selection, zoom/pan, shape utilities, and extensibility for custom node rendering. Matrix still needs typed, recoverable, cross-shell canvas documents, so gateway schemas remain canonical and the shell maps them into tldraw records.

**Alternatives considered**:

- Keep the existing custom canvas renderer only: lower dependency cost, but it would require rebuilding editor primitives that tldraw already handles.
- Store raw tldraw documents as the only source of truth: simpler shell persistence, but too weak for auth, export/delete, recovery, and non-browser consumers.

## Decision: Store canonical canvas documents in user-owned app/workspace storage

**Rationale**: Canvas documents represent app/workspace data with relational links to projects, PRs, review loops, terminal sessions, and files. Per-user Postgres through the existing app data layer is the right canonical store. Export/backup flows can materialize files, but browser-local state and a single `~/system/canvas.json` file are not sufficient for scoped project/PR canvases.

**Alternatives considered**:

- Continue `~/system/canvas.json`: works for global shell layout, but cannot model per-project/PR scopes, revisions, ownership, conflicts, or cross-client updates.
- SQLite kernel DB: constitution reserves SQLite for kernel-internal state; this is user workspace data.

## Decision: Use versioned full-document writes first, with patch events for realtime fanout

**Rationale**: The first implementation can be robust with optimistic `revision` checks and bounded full-document writes. Realtime subscribers receive compact document summary or patch events derived by the service. This avoids introducing CRDT complexity before concurrent editing requirements prove it necessary.

**Alternatives considered**:

- Full CRDT/Yjs layer immediately: stronger collaboration semantics, but higher operational and security complexity for MVP.
- Blind last-write-wins saves: simple, but violates spatial memory and concurrent edit failure-mode requirements.

## Decision: Treat terminal, PR, review, file, and app nodes as references to source-of-truth records

**Rationale**: The canvas organizes live work, but terminal sessions, project records, worktrees, review loops, files, and app windows already have their own owners and lifecycle rules. Canvas nodes should store typed references plus display metadata, never duplicate the domain record as canonical state.

**Alternatives considered**:

- Embed full domain records in nodes: convenient for rendering but creates stale, divergent copies.
- Store only visual nodes with no typed references: flexible, but cannot safely attach terminals, start review loops, enforce auth, or recover.

## Decision: Reconcile stale references on load and recovery

**Rationale**: VPS recovery, gateway restart, deleted sessions, missing worktrees, and expired GitHub auth are expected states. The canvas should preserve user layout and mark nodes as `stale`, `missing`, `unauthorized`, or `recoverable` instead of deleting them.

**Alternatives considered**:

- Delete broken nodes during cleanup: destroys spatial memory and hides recovery problems.
- Fail the entire canvas load: blocks useful work when only one linked runtime is unavailable.

## Decision: Explicit activation budget for expensive live nodes

**Rationale**: A large canvas can contain many terminals, previews, and app windows. Rendering every live surface would degrade the shell. The renderer should mount live content only when focused, sufficiently zoomed in, and within a per-canvas activation budget.

**Alternatives considered**:

- Mount every node: easiest implementation, poor performance and resource behavior.
- Render all live nodes as static forever: safe but loses the workspace value of terminal/app nodes.

## Decision: Dedicated contracts for REST, realtime events, and node schemas

**Rationale**: Browser shell, CLI, future TUI, and future editor integrations need stable interfaces. Contracts also force validation, auth, error behavior, and resource limits into the plan before implementation.

**Alternatives considered**:

- Document only UI behavior: insufficient for headless core and multi-shell.
- Infer contracts from implementation later: conflicts with TDD and Defense in Depth.

## Decision: Map missing specs 068/069/070 to current repository equivalents during planning

**Rationale**: The feature spec references prerequisite specs 068, 069, and 070, but they are not present in this worktree. Planning proceeds by mapping those layers to current implemented or planned equivalents: terminal/session behavior from `specs/056-terminal-upgrade`, project/worktree state from `packages/gateway/src/projects.ts` and related cloud-coding specs, and recovery/export behavior from sync/deployment specs under `specs/066-file-sync`.

**Alternatives considered**:

- Block planning until specs 068-070 are checked in: safest for traceability, but unnecessary for producing a design plan.
- Remove the references: loses important architectural intent from the user request.
