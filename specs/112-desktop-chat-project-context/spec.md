# Feature Specification: Desktop Chat Project and Repository Context

**Feature Branch**: implementation branch created after written-spec approval

**Linear Issue**: created after written-spec approval

**Spec Directory**: `specs/112-desktop-chat-project-context/`

**Created**: 2026-08-13

**Status**: Approved — product design and written specification approved

**Depends On**: MAT-299 persistent Hermes conversations

**Input**: Make the Figma `Add to project` and `Repository` composer controls
truthful and persistent by connecting them to canonical Gateway project data
and per-dispatch Kernel working context.

## Problem

The Desktop Hermes composer currently renders static project, VPS, and branch
pills. They do not select or persist context and do not affect where the Kernel
works. A renderer-only selection would be misleading: reopening the chat from
another shell or after reconnect would silently lose the repository context.

Matrix OS already has a canonical project model. Each project has one validated
owner-controlled local path and may carry canonical GitHub owner/repository
metadata. The conversation should reference that project by ID. The renderer
must never send an arbitrary working directory to the Kernel.

## Product Decisions

1. `Add to project` opens a picker sourced from the selected runtime's canonical
   active projects.
2. `Repository` uses the same project-backed source of truth. Matrix OS projects
   currently own at most one repository/folder root, so both controls converge
   on one persisted `projectId` rather than creating two drifting selections.
3. Selecting Repository first also associates the chat with the owning project.
   Selecting Add to project first derives the repository label and working root
   from that project.
4. The conversation stores only `projectId`. Repository name, kind, path label,
   and working directory are derived server-side from the current ProjectConfig.
5. A project selection applies to future turns only. It never rewrites prior
   messages or claims old tool actions ran in the selected repository.
6. Project context persists across reopen, reconnect, and supported shells that
   use the same Gateway conversation contract.
7. Changing or clearing context is rejected while that conversation has an
   active turn.
8. If the project is archived, deleting, missing, or inaccessible, the Gateway
   refuses dispatch. Desktop keeps the transcript visible and offers `Choose
   another project` or `Remove project context`.
9. Voice, multi-repository projects, worktree selection, branch switching,
   collaboration, renderer-owned persistence, and MAT-268 are excluded.

## User Scenarios and Acceptance

### User Story 1 — Add a Chat to a Project (P1)

A user associates a persistent Hermes conversation with one active Matrix
project.

**Independent Test**: Select a project from the composer, close and reopen the
conversation, and verify the same project and derived repository label return
from the Gateway.

1. The picker displays active projects from `/api/workspace/projects`; it does
   not use a hard-coded first project.
2. Loading, empty, runtime unavailable, and project-list error states are
   explicit.
3. On success, the composer shows the project name and a derived repository or
   folder label.
4. On update failure, the previous context remains visible and active.
5. A runtime switch closes the picker, clears stale choices, and reloads context
   from the new runtime.

### User Story 2 — Work in the Selected Repository (P1)

Future turns in the conversation execute with the selected project's validated
working root while retaining the user's Matrix home for identity, memory, and
system tools.

**Independent Test**: Associate a GitHub project, send a turn that reads the
current directory and repository status, and verify the Kernel cwd is the
canonical project path resolved by the Gateway rather than a renderer-supplied
path.

1. The WebSocket message continues to carry session ID and prompt text; it does
   not accept a path from Desktop.
2. Gateway loads conversation context and ProjectConfig at dispatch time.
3. Dispatcher passes an internal validated working directory to the Kernel for
   that turn only.
4. Kernel `homePath` remains unchanged; only SDK `cwd` changes.
5. Reconnect and session switching do not require the renderer to resend
   context.

### User Story 3 — Recover from Stale Context (P1)

A chat remains readable when its project is no longer eligible for new work.

**Independent Test**: Associate a project, archive or remove it through the
canonical project lifecycle, reopen the chat, and verify history remains
readable while sending is blocked with recovery actions.

1. The Gateway never falls back silently to Matrix home when persisted context
   is invalid.
2. The transcript and context label remain inspectable.
3. The user can remove context or choose another active project.
4. A failed recovery mutation preserves the prior context and safe error state.

## UX and Components

### Composer Controls

- Reuse the shared `PromptInput` controls/footer slots and existing Desktop
  menu/popover primitives.
- Replace static project/repository pills with buttons that display their actual
  state: unselected, loading, selected, stale, or unavailable.
- `Add to project` is the primary empty-state label. `Repository` is shown only
  when the selected project has a folder/repository working root.
- Do not show a fake `main` branch. Branch and git-status UI remains deferred
  until a canonical live git projection exists.
- Context changes are disabled while the conversation is running.

### Picker

- List active projects with name and kind (`GitHub`, `Folder`, or `Scratch`).
- For GitHub projects, show `owner/repo` from canonical metadata.
- For folder and scratch projects, show a safe display label, never an absolute
  filesystem path in ordinary UI or errors.
- Include `Remove project context` when a selection exists.
- Empty state links to the existing project-creation surface rather than
  embedding a second create-project flow in Chat.

## Architecture

### Canonical Conversation Context

Extend the existing owner-controlled conversation record with an optional
context object:

```ts
interface ConversationContext {
  projectId: string;
}

interface ConversationFile {
  // existing fields
  context?: ConversationContext;
}
```

This extends the existing canonical ConversationStore record; it does not add a
renderer database, localStorage key, alternate embedded database, or duplicate
repository metadata. The record write must be async and atomic (temporary file,
fsync where supported, rename) and must serialize against delete/finalize for
the same conversation.

The Gateway resolves the current ProjectConfig every time context is read for a
mutation or dispatch. Persisted absolute paths, branch names, GitHub labels, and
project copies inside the conversation record are forbidden because they can
become stale and expand the deletion/privacy surface.

### Context API

Add one focused route:

```text
PATCH /api/conversations/:id/context
{ "projectId": "project-slug" | null }
```

The response is a safe projection:

```ts
interface ConversationContextProjection {
  projectId: string;
  projectName: string;
  projectKind: "scratch" | "github" | "folder";
  repositoryLabel?: string;
  status: "ready" | "unavailable";
}
```

Conversation list and history responses include this projection when context
exists. They never include `localPath`.

### Route Validation and Resolution

The Gateway:

1. validates conversation ID and the strict update object with Zod 4 under
   `bodyLimit`;
2. gets the verified runtime principal from existing auth;
3. loads the conversation and confirms no active run;
4. loads the project through the canonical owner-scoped ProjectManager;
5. rejects missing, archived, deleting, or unauthorized projects;
6. updates only `projectId` atomically under the conversation mutation lock;
7. returns a safe derived projection; and
8. emits or triggers the existing conversation refresh path so other shells
   converge.

The renderer cannot supply `localPath`, repository URL, branch, owner scope, or
runtime identity.

### Gateway to Kernel Data Flow

At message dispatch:

```text
Desktop message + sessionId
  -> authenticated Gateway WebSocket
  -> ConversationStore context lookup
  -> owner-scoped ProjectManager lookup
  -> validated internal workingDirectory
  -> Dispatcher per-turn context
  -> KernelConfig { homePath, cwd }
  -> Agent SDK query({ cwd })
```

Extend the internal dispatcher context with a non-client-constructible project
working context. `KernelConfig` gains an optional `cwd`; `kernelOptions` uses
`cwd ?? homePath` for the Agent SDK while preserving `homePath` for SOUL,
memory, protected paths, IPC tools, configuration, and owner identity.

The project root is resolved once at dispatch admission and remains fixed for
that turn. A project lifecycle transition must use existing active-work guards
to reject archive/delete while the turn is running.

## HTTP and Auth Matrix

| Route | Method | Auth | Validation | Purpose |
|---|---|---|---|---|
| `/api/conversations` | GET | Verified runtime principal through existing Gateway auth | Existing bounded response schema extended with safe context projection | Load chat list and persisted association. |
| `/api/conversations/:id` | GET | Verified runtime principal through existing Gateway auth | Conversation ID and bounded history query | Load history plus safe context projection. |
| `/api/conversations/:id/context` | PATCH | Verified runtime principal through existing Gateway auth | `bodyLimit`; conversation ID; strict `{projectId: ProjectIdSchema.nullable()}` | Set, replace, or clear context. |
| `/api/workspace/projects` | GET | Verified runtime principal through existing Gateway auth | Existing active-project projection | Populate the picker. |
| `/ws` | WebSocket | Existing authenticated browser/native route | Existing bounded message schema; no new path field | Resolve server-owned context before dispatch. |

No route is public. No browser-controlled header or path is trusted for owner,
project, repository, or filesystem authorization.

## Error Contract

Internal failures map to stable safe codes:

- `conversation_not_found`;
- `conversation_busy`;
- `project_not_found`;
- `project_unavailable`;
- `project_context_conflict`; and
- `conversation_context_unavailable`.

The Desktop allowlists these codes. Raw project paths, Git remotes, provider
errors, database errors, and filesystem failures are logged server-side only.

## Concurrency and State Invariants

- **Source of truth**: Gateway conversation record contains only `projectId`;
  ProjectManager remains authoritative for project metadata and local path.
- **Lock scope**: Context update, conversation delete, and finalization serialize
  per conversation. The lock registry is bounded and evicted.
- **Run scope**: Project eligibility and working root are fixed when a turn is
  admitted. Context cannot change mid-turn.
- **Renderer state**: Project picker state is ephemeral; persisted selection is
  always reloaded from Gateway.
- **Runtime safety**: Responses from a prior runtime generation are discarded.
- **No silent fallback**: Invalid persisted context blocks send until the user
  repairs or removes it.
- **Acceptable orphan state**: A conversation may reference a project that was
  independently archived or removed; the transcript stays readable and the
  context projects as unavailable.
- **Unacceptable orphan state**: Executing in Matrix home or another project
  after the selected context failed validation.

## Compatibility and Migration

- Existing conversations without `context` remain valid and continue to run at
  Matrix home.
- MAT-299 list/history parsers treat context as optional and strictly validate
  the safe projection when present.
- A Gateway predating the context endpoint leaves the controls disabled with
  `Update this Matrix computer to add project context`; it does not persist a
  local fallback.
- Other shells may ignore the optional projection initially, but their sends
  still receive server-resolved context because dispatch is Gateway-owned.
- Conversation record updates preserve unknown forward-compatible fields only
  through the canonical schema/versioning policy; clients never round-trip the
  whole record.

## Testing Strategy

Tests are written first.

### Gateway and Contracts

- strict body parsing, body limit, ID validation, and owner-scoped project
  resolution;
- set, replace, clear, repeat clear, and reopen persistence;
- missing/archived/deleting project rejection;
- active-run rejection and context/delete/finalize serialization;
- atomic-write failure preserves the previous record;
- context projections never expose local paths;
- WebSocket dispatch resolves current ProjectConfig and passes the validated
  cwd;
- project removed between admission and dispatch does not fall back silently;
- bounded lock cleanup; and
- generic client errors with detailed server logging.

### Kernel and Dispatcher

- no-context dispatch keeps `cwd === homePath`;
- selected context passes `cwd === canonicalProject.localPath`;
- `homePath` remains unchanged for identity, IPC, memory, and protected-file
  hooks;
- per-turn cwd does not leak into another queued or concurrent conversation;
  and
- reconnect/session switch resolves context from Gateway, not renderer state.

### Desktop Store and UI

- project list loading, empty, error, and runtime-switch states;
- set/replace/clear success only updates after server confirmation;
- failure preserves the prior selection;
- selected project and repository labels restore after reopen;
- running state disables mutations;
- stale/unavailable context blocks send and exposes recovery actions;
- no absolute paths in normal UI or error copy; and
- Gateway capability/version fallback does not create local persistence.

### Electron Evidence

Run the real Desktop and Gateway under Flox and verify:

- select project from Add to project;
- derive repository/folder label;
- reopen and reconnect persistence;
- execute a harmless cwd/repository inspection in the selected project;
- clear context and return to Matrix home on the next turn;
- archive/remove the project and recover from unavailable context; and
- switch runtimes while a picker or mutation is pending.

Compare equal-viewport screenshots with the Figma composer states and pair them
with Gateway record and Kernel cwd evidence.

## Delivery and Documentation

- Implement after MAT-299 using one focused PR and one independent top-level
  Codex Task.
- Create a separate Linear issue from this spec after written-spec review.
- Keep Linear at `PR In Review` until merge and read back PR, reviewer, CI,
  Greptile 5/5, attachment, and Linear state.
- Add a separate public documentation PR to `FinnaAI/matrix-os-site` explaining
  how a persistent chat uses project context. Do not recreate a local `www/`
  tree.

## Explicitly Deferred

- Voice;
- multiple repositories per project;
- worktree selection or management;
- branch selection, checkout, ahead/behind, and git-status UI;
- collaboration avatars and shared conversation ownership;
- renaming, archive, and bulk chat lifecycle actions;
- broad Chat/coding-agent conversation unification from Figma Sandbox; and
- all MAT-268 behavior.
