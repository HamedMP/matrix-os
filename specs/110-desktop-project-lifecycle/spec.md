# Feature Specification: Desktop Project Lifecycle

**Feature Branch**: `codex/mat-267-desktop-project-lifecycle`
**Linear Issue**: `MAT-267`
**Spec Directory**: `specs/110-desktop-project-lifecycle/`
**Created**: 2026-08-06
**Status**: Draft — product design approved; written spec review pending
**Input**: Add discoverable archive, restore, and permanent-delete controls for
projects shown in the Electron desktop sidebar. Archived projects are managed in
Settings. Permanent deletion removes Matrix-owned project data while preserving
owner-controlled external folders.

## Problem

Projects can be created from the Electron desktop sidebar, but the same surface has
no way to archive or delete them. The Gateway already exposes a project delete route,
but its current behavior is unsafe to expose directly: it recursively removes the
Matrix-managed project directory, accepts no explicit confirmation, does not provide
archive/restore semantics, and does not reconcile every related Desktop reference.

The project lifecycle must remain a headless Gateway capability. Electron is one
renderer and must not become the source of truth for whether a project is active,
archived, or deleted.

## Product Decisions

1. Each expanded sidebar project row exposes an overflow menu on hover and keyboard
   focus.
2. The menu contains `Archive project` and a destructive `Delete project` action.
3. Archived projects disappear from the normal sidebar and appear in
   `Settings > Projects`, where they can be restored or permanently deleted.
4. Archive is reversible and never deletes repository, workspace, task, chat, or
   worktree data.
5. Permanent deletion removes Matrix-owned project metadata, tasks, chats, reviews,
   previews, and internal workspaces after explicit typed confirmation.
6. A folder project that points at an existing owner-controlled directory loses its
   Matrix registration and related Matrix state, but the external directory and its
   contents are never deleted.
7. Archive and delete are rejected while project-scoped work is active. The user must
   stop active coding-agent turns, sessions, previews, and leased worktrees first.
8. The renderer does not optimistically hide a project. It reconciles local state only
   after the Gateway confirms the lifecycle transition.

## User Scenarios and Testing

### User Story 1 — Archive a Sidebar Project (Priority: P1)

A builder can archive a project from the sidebar without losing any project data.

**Independent Test**: Archive an idle project from its sidebar overflow menu. Verify
that it disappears from active project lists, its open Desktop surfaces close, its
files and project history remain intact, and it appears under Settings > Projects.

**Acceptance Scenarios**:

1. **Given** an active project row, **when** the user opens its overflow menu, **then**
   `Archive project` is keyboard accessible and does not trigger from the row's normal
   open action.
2. **Given** an idle project, **when** archive succeeds, **then** the project is removed
   from the active sidebar only after the server response and is listed as archived in
   Settings.
3. **Given** an archive request fails, **when** the error settles, **then** the project
   remains visible and open, and the UI shows bounded, actionable copy.
4. **Given** active project-scoped work, **when** archive is requested, **then** the
   Gateway rejects it without changing project state and the Desktop explains that the
   work must be stopped first.

### User Story 2 — Restore an Archived Project (Priority: P1)

A builder can restore an archived project from Settings and resume using it without
losing its existing state.

**Independent Test**: Restore a project from Settings > Projects. Verify that it moves
back to the active sidebar, retains its tasks and chats, and can be opened normally.

**Acceptance Scenarios**:

1. **Given** an archived project, **when** restore succeeds, **then** it disappears from
   the archived list and returns to the active sidebar.
2. **Given** a restore request fails, **when** the error settles, **then** the project
   remains archived and the restore action becomes available again.
3. **Given** a project is already active, **when** an idempotent restore is repeated,
   **then** the server returns the current active projection without duplicating data.

### User Story 3 — Permanently Delete a Project (Priority: P1)

A builder can permanently delete a project with clear scope and strong confirmation.

**Independent Test**: Delete one Matrix-managed project and one connected folder
project. Verify that Matrix-owned state is removed for both, the managed checkout is
removed, and the connected external folder is unchanged.

**Acceptance Scenarios**:

1. **Given** an active or archived project, **when** the user chooses delete, **then** a
   dialog identifies the project and explains exactly which data is deleted or
   preserved.
2. **Given** the confirmation text does not exactly match the project name, **when**
   delete is submitted, **then** no request is sent.
3. **Given** an idle Matrix-managed scratch or GitHub project, **when** delete succeeds,
   **then** its project metadata, checkout, tasks, project chats, reviews, previews,
   worktrees, and other Matrix-owned project state are no longer accessible.
4. **Given** an idle folder project backed by an external owner directory, **when**
   delete succeeds, **then** Matrix registration and related Matrix state are removed
   while the external directory remains byte-for-byte untouched.
5. **Given** active project-scoped work, **when** delete is requested, **then** the
   request fails safely without partial deletion.
6. **Given** a delete operation partially completes after its durable deletion marker
   is written, **when** startup recovery runs, **then** it resumes cleanup and never
   re-exposes the project as active.

## UX Design

### Sidebar

- Preserve the existing row click target for opening the project.
- Add a dedicated overflow trigger that is visible on hover and keyboard focus.
- Use the existing Radix-based menu and dialog primitives.
- Keep `Archive project` neutral and `Delete project` visually destructive.
- Do not put archived projects in a second sidebar group.

### Settings

- Add a `Projects` section under the Machine group.
- Display archived projects with name, project type, archived timestamp, `Restore`,
  and `Delete` actions.
- Show an empty state when there are no archived projects.
- Fetch archived projects from the selected Matrix computer; never persist this list in
  Electron local state.

### Confirmation and Feedback

- Archive uses a confirmation dialog that states data is retained.
- Delete requires the exact project name and mode-specific scope copy.
- Disable repeated submission while a request is pending.
- Cancel closes the dialog and changes nothing.
- Failure keeps the dialog or project row recoverable and displays allowlisted copy.
- Success closes every tab associated with the project, clears its cached board and
  project-view state, selects Home if the deleted/archived project was active, refreshes
  active and archived project projections, and refreshes the coding-agent summary.

## Architecture

### Project Lifecycle Module

Introduce one deep Gateway module whose interface is the lifecycle test surface:

```ts
applyProjectLifecycleAction(
  principal: RequestPrincipal,
  projectSlug: string,
  action: ProjectLifecycleAction,
): Promise<ProjectLifecycleResult>
```

`ProjectLifecycleAction` is a Zod discriminated union:

```ts
type ProjectLifecycleAction =
  | { type: "archive" }
  | { type: "restore" }
  | { type: "delete"; confirmation: string };
```

The module hides ownership checks, project locking, active-work checks, durable state
transitions, related-state cleanup, external-folder preservation, recovery markers,
and safe error mapping. HTTP routes and tests cross the same interface.

The module accepts existing managers/stores as injected dependencies. It does not add
hypothetical ports: production adapters and in-memory test adapters already exist for
the project, task, worktree, session, preview, review, and coding-agent thread stores.

### Canonical Project State

Extend the persisted project configuration with:

```ts
kind: "scratch" | "github" | "folder";
archivedAt?: string;
deletingAt?: string;
```

- `kind` makes deletion scope explicit and prevents the renderer from guessing from a
  path. Existing records are classified once by the Gateway from their validated
  configuration and atomically rewritten before their first lifecycle transition.
- `archivedAt` is the canonical reversible lifecycle state.
- `deletingAt` is a durable tombstone. Once set, normal project reads and mutations
  must not expose the project. Recovery may resume cleanup safely.
- Active project list projections exclude archived and deleting projects by default.
- Explicit archived projections include archived projects but never deleting projects.
- Relation validation rejects archived or deleting projects for new tasks, chats,
  sessions, previews, and worktrees.

### HTTP Interface

| Route | Method | Auth | Body/query | Purpose |
|---|---|---|---|---|
| `/api/workspace/projects` | GET | Verified runtime principal | Validated `visibility=active\|archived\|all` | Return the requested owner-scoped projection. Default is `active`. |
| `/api/projects/:slug/actions` | POST | Verified runtime principal | `ProjectLifecycleActionSchema` | Archive, restore, or permanently delete one owned project. |
| `/api/projects/:slug` | DELETE | Verified runtime principal | Explicit confirmation schema during compatibility period | Delegate to the lifecycle module; no bodyless destructive delete remains. |

Every mutating route uses `bodyLimit` before parsing, validates the slug and action at
the route seam with Zod 4, and returns generic client errors. The Gateway logs internal
filesystem, provider, and persistence details.

The CLI `project rm` command must send explicit confirmation or be replaced by a
clearly named lifecycle command. Existing callers must not retain a bodyless destructive
path.

### Lifecycle Transitions

```text
active --archive--> archived --restore--> active
active --delete--> deleting --cleanup--> absent
archived --delete--> deleting --cleanup--> absent
```

- Archive and restore run under the existing per-project lock and atomically rewrite
  the project config.
- Delete first verifies ownership, typed confirmation, and absence of active work.
- Delete then writes `deletingAt` atomically before any irreversible cleanup.
- Related Matrix state is removed through owner-scoped store operations.
- The managed project directory is removed last. For folder projects, only the Matrix
  registry directory is removed; the resolved external `localPath` is never passed to
  `rm`.
- Startup recovery resumes `deleting` projects. A failed cleanup stays hidden and is
  retryable; it must not return to active state automatically.

## Functional Requirements

- **FR-001**: The Gateway MUST be the source of truth for active, archived, deleting,
  and absent project state.
- **FR-002**: Archive and restore MUST be owner-scoped, serialized per project, and
  idempotent.
- **FR-003**: Delete MUST require an exact project-name confirmation verified by the
  Gateway, not only by the renderer.
- **FR-003a**: The Gateway MUST provide a canonical project kind and MUST NOT rely on
  the renderer to infer whether a local path is Matrix-managed or externally owned.
- **FR-004**: Archive and delete MUST reject a project with active coding-agent turns,
  workspace sessions, live previews, reviews, or leased worktrees.
- **FR-005**: Archive MUST preserve all project data and relationships.
- **FR-006**: Restore MUST return the original project state without duplicating
  records or losing relationships.
- **FR-007**: Delete MUST remove Matrix-owned project state and related project chats.
- **FR-008**: Delete MUST preserve an external folder project's owner-controlled
  directory and contents.
- **FR-009**: Normal project projections MUST hide archived and deleting projects.
- **FR-010**: Settings MUST retrieve archived projects from the selected runtime and
  allow restore and delete.
- **FR-011**: Desktop MUST reconcile tabs, selection, caches, and summaries only after
  confirmed success.
- **FR-012**: Failed lifecycle operations MUST keep the previous visible state and show
  safe bounded errors.
- **FR-013**: A runtime/account switch while an action is pending MUST discard the stale
  response and MUST NOT mutate the new runtime's renderer state.
- **FR-014**: Existing bodyless project deletion MUST be removed or made non-destructive;
  all destructive callers MUST provide server-verified confirmation.
- **FR-015**: Lifecycle changes MUST be observable by other shells through the canonical
  project projection and existing realtime refresh path.

## Data Ownership and Deletion Invariants

- **Source of truth**: Project lifecycle state lives in the owner-scoped Gateway
  project configuration. Desktop local state is a cache only.
- **Lock scope**: Archive, restore, delete tombstoning, and delete recovery serialize
  under the same project lock used by creation.
- **External-owner invariant**: No delete operation may call `rm` on a folder project's
  persisted external `localPath`.
- **Acceptable orphan state**: A project may remain durably tombstoned as `deleting`
  after cleanup failure. It stays hidden, retains enough metadata for retry, and is
  reported in server logs. Returning it to active state automatically is forbidden.
- **Unacceptable orphan state**: A visible active/archived project whose managed
  directory or owner-scoped relationships were partially deleted.
- **Auth source of truth**: The verified Gateway runtime principal and persisted
  project `ownerScope`; renderer identity and request headers are not authoritative.

## Error Contract

The lifecycle module returns typed internal errors mapped to bounded client codes:

- `project_not_found`
- `project_archived`
- `project_active`
- `project_busy`
- `confirmation_required`
- `lifecycle_conflict`
- `lifecycle_unavailable`

Clients receive generic messages. Filesystem paths, provider names, raw database
errors, and internal cleanup details are logged server-side only.

## Testing Strategy

Tests are written first and exercise the lifecycle interface rather than private
helpers.

### Gateway

- Archive, repeat archive, restore, and repeat restore.
- Owner mismatch and invalid slug/action rejection.
- Active-work rejection before state changes.
- Exact server-side confirmation validation.
- Managed project deletion removes Matrix-owned data.
- Folder project deletion preserves the external directory and contents.
- Tombstone-before-cleanup ordering and restart recovery.
- Failure at each cleanup boundary remains hidden and retryable.
- Route body limits, query validation, auth, and safe error mapping.
- Existing CLI deletion cannot bypass confirmation.

### Desktop Stores and UI

- Project lists parse active and archived projections without mixing them.
- Archive/restore/delete do not mutate local state before success.
- Failure preserves the row, tab, cache, and dialog recovery path.
- Success closes all project-bound tabs and chooses a deterministic next tab.
- Runtime-generation guards ignore stale lifecycle responses.
- Sidebar overflow behavior is mouse and keyboard accessible.
- Confirmation copy and project-name matching vary correctly by project type.
- Settings > Projects renders empty, loading, archived, restoring, deleting, and error
  states.

### End-to-End

- Build and run the Electron app against a controlled Gateway fixture.
- Archive a project from the sidebar, restore it in Settings, then reopen it.
- Permanently delete a managed project and verify it does not reappear after restart.
- Delete a connected folder project and verify the external fixture files remain.
- Capture screenshot evidence for the sidebar menu, archive confirmation, archived
  settings list, and delete confirmation.

## Success Criteria

- **SC-001**: A user can discover archive or delete from a sidebar project row without
  navigating away from the project.
- **SC-002**: An archived project can be restored from Settings with all prior project
  data intact.
- **SC-003**: No failed request removes or hides a project from the current renderer.
- **SC-004**: Automated tests prove that external folder contents are never deleted.
- **SC-005**: Automated tests prove there is no bodyless destructive project-delete
  path.
- **SC-006**: The Electron flow passes focused tests, typecheck, pattern scan, production
  build, and manual runtime validation.

## Delivery and Documentation

- Keep the implementation in focused review layers. If the diff crosses the normal
  review target, use a Graphite stack with Gateway lifecycle/contracts first and
  Desktop UI second.
- PR titles and commits use Conventional Commit English.
- The implementation PR body includes source-of-truth, lock scope, acceptable orphan
  state, auth source-of-truth, and deferred-scope invariants.
- A separate English documentation PR in `FinnaAI/matrix-os-site` documents project
  archive, restore, permanent deletion, external-folder preservation, and recovery.
- Merge requires CI and Greptile 5/5. Live customer rollout is outside this spec.

## Out of Scope

- Trash-style retention or delayed purge after permanent deletion.
- Bulk archive/delete.
- Renaming projects.
- Cross-owner or organization project transfer.
- Automatic stopping of active work to force deletion.
- Mobile-specific lifecycle UI. Mobile and browser shells consume the same Gateway
  state but receive dedicated renderer work later.
