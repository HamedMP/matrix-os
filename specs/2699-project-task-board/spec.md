# Feature Specification: Project Task Board (Kanban)

**Status**: Draft (2026-11-19)
**Requester**: Hamed
**Linear**: [ENG-508](https://linear.app/matrix-os/issue/ENG-508/specify-the-project-kanban-board-and-the-agent-message-board) (spec). Implementation stacks get their own ENG tickets.
**Builds on**: `specs/2689-organization-project-access/`, `specs/2692-herdr-parity/`, `specs/2697-chat-terminal-agents/` (PR #3472), `specs/652-cross-surface-notifications/`, `specs/2691-project-agent-context/`
**Related**: `specs/2700-agent-message-board/` (separate feature, bridged in its last layer)
**Reference product**: SlayZone (`github.com/debuglebowski/SlayZone`, GPL-3.0). We match its behavior. We do not copy its code.
**Suggested reviewers**: Yuhan (Projects UI, Chat), Nima (collaboration and org project access), Amin (notifications, spec 652)

## Goal

Every project gets a **Board** view. A project holds tasks, and **every task is
a chat**: each task has exactly one chat, and every chat in a project is a task
on its board. A task has a status, priority, labels, assignee, comments and an
activity log. Its chat is where the work happens, optionally in the task's own
git worktree, together with any terminals attached to it and the branch and
pull request that come out of it. People and
agents can create, move, comment on and close tasks. Tasks can be linked to
Linear issues and kept in sync. When the project is shared with an
organization, every member sees the same board and can work it.

The short version, borrowed from the reference product: card, then terminal,
then agent. The card is the unit of work, and everything needed to do the work
opens from it.

## Today (origin/main @ `0ee903d13`)

| Area | What exists | Gap |
|---|---|---|
| Task store | `packages/gateway/src/task-manager.ts`: JSON files under `~/system/projects/<slug>/tasks/`, statuses `todo running waiting blocked complete archived`, one `linkedSessionId`, one `linkedWorktreeId` | No comments, assignee, labels, external ID or revision. Files cannot support concurrent edits or sharing. |
| Task routes | `POST/GET/PATCH/DELETE /api/projects/:slug/tasks[/:taskId]` in `workspace-routes.ts`; `task.created` / `task.updated` on `/api/workspace/events` | Same gaps as the store |
| Worktrees | `worktree-manager.ts`: `createWorktree`, `WorktreeRecord` with `pr`, `dirtyState`, write lease | Not started from a task |
| Sessions | Chats run in a worktree (`CanonicalChatExecutionRootRef` `worktree{projectId, worktreeId}`); terminal tabs take a `cwd` | No task binding on chats or tabs |
| Board UI | Electron Desktop: `ProjectViewSchema` still lists `"board"`, `stores/board.ts` and `TaskWorkspace.tsx` remain, the board itself was removed. Web: none. | No board on any surface |
| Pull requests | `GET /api/projects/:slug/prs` through `gh` on the owner's computer | Not shown per task, no checks or review state |
| Linear | Connected integration with `list_issues`, `create_issue`, `update_issue`, `comment_issue`, `list_workflow_states` | On demand only. No sync, no webhook receiver. |
| Org sharing | Shared projects give members chats, terminals, files and git on the owner's computer | Tasks are not a shared resource |
| Agent status | Spec 2692: per-tab `idle working done blocked error`. Spec 2697 extends it to chats as `AgentSession`. | Not shown on a card |

## Principles

1. **Task status is the person's progress. Agent status is the agent's state.**
   They are two fields and never overwrite each other silently. A card in
   `in_progress` shows its sessions' agent status as a badge. Only the explicit
   automation rules in this spec move a card.
2. **A task is a chat.** (Amended 2026-11-22; this replaces "a task owns
   sessions; it does not replace them".) Every task has exactly one chat and
   every chat in a project has exactly one task, enforced in the store.
   Creating either creates both, whichever path is used (Chat app, board, CLI,
   agent tool). The chat stays an ordinary Matrix chat: Chat, attention and the
   inbox keep working unchanged, and the Chat surface shows the task's
   properties in an editable ticket header. Terminals may still attach to a
   task as extra sessions; an extra chat would itself be a task, so there are
   none.
3. **The owner's Postgres is the source of truth.** Tasks move from files to
   owner-controlled Postgres through Kysely. Linear is a mirror the owner opts
   into, never the authority.
4. **The gateway owns the behavior.** Web Canvas, Web Desktop, Electron
   Desktop, Web Mobile, Native Mobile, the `matrix` CLI, MCP and the kernel all
   call the same routes. The board UI lives once in `packages/ui`.
5. **One notification path.** Assignments, mentions and attention go through
   the spec 652 router. This spec adds sources, not a delivery path.
6. **Sharing is role-free, like the project.** Whoever can work in a shared
   project can work its board (spec 2689 organization project access).

## Design

### 1. Data model

New owner store `packages/gateway/src/project-tasks/` with `database.ts`
(`bootstrapProjectTaskDatabase`, versioned migrations in the style of
`bots/database-migrations.ts`, advisory lock `matrix-project-task-schema`).
Every row carries `owner_id`; every unique index includes it. CHECK
constraints mirror the Zod bounds in `packages/contracts/src/project-tasks.ts`.

| Table | Purpose | Key columns |
|---|---|---|
| `project_tasks` | The card | `id` (`task_…`), `project_id` (`proj_…`), `chat_id` (the task's chat; unique per owner), `number` (per-project sequence), `title`, `description` (Markdown), `status`, `priority`, `rank` (fractional index, text), `assignee` (actor ref or null), `labels`, `parent_task_id`, `due_at`, `worktree_id`, `branch`, `pr_number`, `created_by` (actor ref), `revision`, `archived_at`, `deleted_at`. `title` and `archived_at` mirror the chat (see "Every task is a chat" below). |
| `project_task_relations` | `blocks` relations between tasks | `task_id`, `blocked_by_task_id` |
| `project_task_sessions` | Terminal tabs attached to the task | `task_id`, `session_ref` (`term.<ws>.<tab>`), `created_by` |
| `project_task_comments` | Comments | `id`, `task_id`, `author` (actor ref), `body` (Markdown), `external_id`, `edited_at`, `deleted_at` |
| `project_task_activity` | Append-only log: created, moved, assigned, session started, PR opened, synced | `seq`, `task_id`, `actor`, `kind`, `data` JSONB |
| `project_task_external_links` | Link to a Linear issue | `task_id`, `provider`, `external_id`, `external_key`, `url`, `remote_updated_at`, `field_synced_at` JSONB |
| `project_board_settings` | Per-project board settings | `project_id`, `task_key` (short prefix, for example `MOS`), automation flags, Linear link, sync cursor |
| `project_task_operations` | Idempotency for creates | `client_request_id`, `payload_hash`, `result_ref` |

**Every task is a chat** (amended 2026-11-22):

- `project_tasks.chat_id` has a unique index on `(owner_id, chat_id)`, and
  every create path sets it. It is nullable only for rows written before this
  change (the file import); the backfill gives each of those a chat. A task
  without a chat and a project chat without a task are both invalid states.
- One creation path. The board registers a hook with the chat repository at
  startup; the repository calls it inside the transaction that inserts a chat
  with a `projectId`, so the chat row and its task row commit together. Every
  path that creates a project chat goes through it. A board "New task" is a
  chat create that carries ticket fields (title, description, status Backlog
  or To do, priority, labels, assignee); a plain chat create gets `todo` and
  moves to `in_progress` on its first accepted turn. (Refinement of the
  requester's "a new chat lands In progress": an empty chat is not yet work in
  progress. One constant, `DIRECT_CHAT_STATUS`, reverts it.) A Chat app "New
  chat" that is only a client draft has no chat row and so no task until its
  first message. The chat row is created eagerly with no turns, so a board task
  starts its agent only when its first message is sent. Retries reuse the
  chat's `clientRequestId` (`ON CONFLICT` on the chat's request key and on
  `(owner_id, chat_id)`).
- The chat is authoritative for the title and archived state. The task row
  keeps a copy of both for search, sorting and the Linear mirror, written only
  inside the same transaction as the chat change, so the two never diverge. A
  title set on the board renames the chat and marks its title manual, so
  generated titles never overwrite it (limit 160 characters). Archiving or
  restoring either side changes both. Deleting the chat soft-deletes its task.
- Personal-owner project chats only in stack 1; organization-owned chats get
  tasks with organization sharing (section 7).
- Moving a chat to another project moves its task (a new number on the target
  board, history kept); removing a chat's project archives its task.
- Backfill, once per chat, bounded per board open (500 rows) and safe to
  re-run: project chats without a task become tasks in `done`, or in
  `in_progress` when the chat's latest run is accepted, running or waiting for
  approval or input (refinement of the requester's "existing chats go to Done";
  one mapping, `backfillStatus`, reverts it); tasks without a chat
  (for example from the file import) get an empty chat titled after the task.
  Chats outside any project get no task.
- The first turn on a `backlog` or `todo` task's chat moves it to
  `in_progress` (automation flag `startMovesToInProgress`).

**Statuses** are fixed in v1: `backlog`, `todo`, `in_progress`, `in_review`,
`done`, `canceled`. The board shows the first five as columns; `canceled` and
archived tasks are behind a filter. Custom columns are deferred (see Risks).
The vocabulary matches Linear's state types and the requester's existing
personal board, so nothing needs translating.

**Priority**: `none`, `low`, `normal`, `high`, `urgent`.

**Actor refs** identify who did something: `user:<clerkUserId>`,
`agent:<AgentSessionRef>` or `system:<source>` (for example `system:linear`).
The server sets the actor from the authenticated principal. It is never taken
from the request body.

**Task key**: `number` comes from a per-project counter incremented in the
same transaction as the insert. The display key is `<task_key>-<number>`, for
example `MOS-42`. A Linear-linked task also shows the Linear key.

**Migration from files**: on first bootstrap per project, an idempotent import
reads `~/system/projects/<slug>/tasks/*.json` and inserts with
`ON CONFLICT (owner_id, id) DO NOTHING`. Mapping: `todo` stays, `running` and
`waiting` become `in_progress`, `blocked` becomes `in_progress` with label
`blocked`, `complete` becomes `done`, `archived` sets `archived_at`.
`linkedSessionId` and `linkedWorktreeId` carry over. The files are owner data
and are left in place (user data invariant). A marker row records the import
so it never reruns.

### 2. Routes

The existing mount stays: `/api/projects/:slug/tasks`. The gateway resolves
`slug` to `proj_` through `project-identity-index` and stores the `proj_` ID.

| Route | Behavior |
|---|---|
| `GET /tasks?status&assignee&label&q&cursor&limit` | Board page. Default limit 200, max 500, cursor paged. Excludes deleted; excludes archived unless asked. |
| `POST /tasks` | Create. Idempotent on `clientRequestId`. |
| `GET /tasks/:taskId` | Task with labels, relations, sessions, external link, PR summary |
| `PATCH /tasks/:taskId` | Edit title, description, priority, assignee, labels, due date, parent. Requires `baseRevision`; the `UPDATE` carries `WHERE revision = :baseRevision`. A mismatch returns 409 with the current task. |
| `POST /tasks/:taskId/move` | `{status, afterTaskId?, beforeTaskId?}`. One targeted `UPDATE` of `status` and `rank`. Moves are last-writer-wins and do not need `baseRevision`. |
| `POST /tasks/:taskId/archive` and `/unarchive` | Sets or clears `archived_at` |
| `DELETE /tasks/:taskId` | Soft delete with `deleted_at IS NULL` in the `WHERE`. A repeat delete returns 404. |
| `GET/POST /tasks/:taskId/comments`, `PATCH/DELETE …/comments/:commentId` | Comments. Only the author edits or deletes their own comment. |
| `GET /tasks/:taskId/activity?after` | Activity log page |
| `POST /tasks/:taskId/start` | Start work (section 3) |
| `POST /tasks/:taskId/sessions` and `DELETE …/sessions/:ref` | Attach or detach an existing chat or terminal tab |
| `GET /tasks/:taskId/git` | Branch, dirty state, ahead/behind, changed-file summary, PR summary (section 4) |
| `GET/PUT /board/settings` | Task key, automation flags, Linear link |
| `POST /board/linear/import`, `POST /tasks/:taskId/linear/link`, `POST …/linear/unlink` | Linear (section 6) |

Every mutation writes the task row and its `project_task_activity` row in one
transaction, then publishes on `/api/workspace/events` after commit:
`task.created`, `task.updated`, `task.moved`, `task.deleted`,
`task.comment_added`, each with `taskId`, `revision` and timestamp. Events are
change signals. Clients refetch what changed.

### 3. Task sessions and worktrees

> Amended 2026-11-22: a task's chat is created with the task, so Start work no
> longer creates chats. `POST …/start` with `kind: "chat"` prepares the task's
> own chat (worktree and branch per step 1, the chat's default execution root
> bound to that worktree, the first message returned for the composer when no
> model is selected); `kind: "terminal"` attaches a terminal as below. Attach
> and detach accept terminal tabs only. The rest of this section describes the
> terminal path.

**Start work** (`POST …/start` with `{kind: "chat" | "terminal", harness?,
template?, worktree: "new" | "existing" | "none", message?}`):

1. If `worktree` is `new` and the task has none, create one through
   `worktree-manager.createWorktree` with a new branch named
   `task/<key>-<title-slug>` (lowercase, at most 60 characters) from the
   project's default branch. Record `worktree_id` and `branch` on the task.
   Scratch and folder projects that are not git repositories skip the worktree
   and run in the project folder.
2. Create the session through the existing owners:
   - chat: a canonical chat with `projectId` and execution root
     `worktree{projectId, worktreeId}`;
   - terminal: `POST /api/terminal/workspaces/:id/tabs` with `cwd` set to the
     worktree and the harness command or a spec 2692 template.
3. Insert `project_task_sessions`. The first session is `main`.
4. Send the first message: the task key, title and description, followed by
   the caller's `message` if given. Sessions get `MATRIX_TASK_ID` and
   `MATRIX_PROJECT_ID` in their environment so the CLI can default to the
   current task.
5. If the task is in `backlog` or `todo`, move it to `in_progress`.

The steps are not one transaction because they cross subsystems. Each is
idempotent and the task records what succeeded, so a retry resumes rather than
duplicating (see Failure modes).

A task can hold up to 16 sessions. More chats or terminals can be added at any
time, and each uses the same worktree unless the caller asks otherwise.

**Card badge**: the board reads agent status for the task's sessions from the
spec 2697 agent session index and rolls it up with the 2692 rule
(`blocked > done > working > idle`). A blocked agent shows on the card and
raises attention through the existing path.

**Closing**: moving a task to `done` or `canceled` while one of its agents is
`working` asks for confirmation in the UI, and the CLI and tools refuse
without `--force` (same rule as the reference product). Closing never deletes
chats, terminal tabs, the worktree or the branch. A separate "Clean up
worktree" action on a closed task removes the worktree only when it is clean
and its branch is merged or pushed; otherwise it explains why not.

### 4. Git and pull request state

`GET …/git` combines `WorktreeRecord` (branch, dirty state), the project's
code metadata (ahead/behind) and a pull request summary: number, URL, state,
draft, review decision, mergeable, and the checks roll-up. The summary comes
from `gh pr view --json` on the owner's computer for the task's branch.

- Results are cached per task for 60 seconds. There are no GitHub webhooks,
  so discovery is a bounded refresh while a viewer is connected: at most once
  a minute, the board refreshes visible cards that have a branch, whether or
  not a PR is known yet, so a PR an agent opens while the board is open is
  found and can move the card to `in_review`. Each refresh covers at most 20
  cards, least recently checked first, and runs `gh` lookups one at a time.
  Nothing refreshes in the background with no viewer.
- `gh` runs with a 10 second timeout. A missing or signed-out `gh` yields
  `prStatus: "unavailable"` with a prompt to connect GitHub, not an error card.
- The task detail has **Create pull request** (pushes the branch and opens the
  PR through `gh`), plus links to the existing diff and commit views.

**Automation** (per-project flags, default on):

| Trigger | Result |
|---|---|
| First session started | `backlog` or `todo` becomes `in_progress` |
| PR opened for the task's branch | `in_progress` becomes `in_review` |
| PR merged | task becomes `done` |

Automation only moves a card forward along that path and records
`system:automation` as the actor. A person's later move always wins.

### 5. Agent access

Agents use the same routes through three adapters. Names avoid the kernel's
existing work-queue tools (`list_tasks`, `create_task`, `claim_task`), which
are a different thing.

- **CLI**: `matrix tasks list | get | create | update | move | comment | start |
  done | open`. Inside a task session, the task defaults to `MATRIX_TASK_ID`,
  so `matrix tasks comment "PR is up"` and `matrix tasks done` need no ID.
  New command group in `packages/sync-client/src/cli/commands/tasks.ts`.
- **MCP**: `project_task_list`, `project_task_get`, `project_task_create`,
  `project_task_update`, `project_task_move`, `project_task_comment`,
  `project_task_start`. They ship on the same server spec 2697 uses for
  cross-harness agent tools (Matrix Core MCP, PR #3311); if that has not
  landed, on `packages/integrations-mcp` with the `chat` and `full` surfaces.
- **Kernel**: the same seven tools as in-process IPC tools, with the service
  injected at registration and verified non-undefined then.

An agent's writes are attributed to `agent:<AgentSessionRef>`, taken from the
run context, not from model input. An agent session is bounded to its own
project: it cannot read or write another project's tasks.

### 6. Linear sync

A project owner links the board to one Linear team, and optionally one Linear
project, using their existing Linear connection. Linking is optional; a board
works fully without it.

- **Import**: pull issues by filter (assigned to me, a Linear project, a
  label, or all open in the team). Each becomes a task with an external link.
  Re-import is idempotent on `(owner_id, provider, external_id)`.
- **Local tasks**: stay local unless the owner turns on "Create Linear issues
  for new tasks" for the board or chooses **Send to Linear** on a task.
- **Synced fields**: title, description, status, priority, assignee, due date
  and comments. Labels are not synced in v1.
- **Status mapping**: by Linear state type (`backlog`, `unstarted`, `started`,
  `completed`, `canceled`). `in_review` maps to a `started` state whose name
  contains "review" when the team has one, otherwise to the default `started`
  state. The owner can override the mapping in board settings.
- **Assignee mapping**: by email between Linear users and organization
  members. No match leaves the other side unassigned and unchanged.
- **Mechanism**: polling. The sync job asks for issues with `updatedAt` after
  the stored cursor every 60 seconds while a viewer has the board open and
  every 5 minutes otherwise. Outbound changes are sent after the local commit
  from a durable outbox row, so a failed send retries. Webhooks are a later
  improvement; there is no receiver today.
- **Conflicts**: per field, last writer wins by timestamp.
  `field_synced_at` records the last value written to or read from Linear per
  field, which also suppresses echoes: an inbound change equal to what we last
  wrote is ignored.
- **Comments**: mirrored both ways, append-only. A comment written in Matrix
  by someone other than the connection owner is posted with a first line
  naming the author, because Linear attributes it to the connected account.
- **Shared projects**: sync runs on the owner's computer under the owner's
  Linear connection. Members do not need their own connection.
- **Data flow**: task titles, descriptions and comments of linked tasks are
  sent to Linear through the connected integration. Unlinked tasks never leave
  the owner's computer.

### 7. Organization sharing

Tasks become a resource of a shared project. A member gets everything the
owner gets on the board except board settings and the Linear link: view,
create, edit, move, comment, assign, archive, start sessions and attach
sessions. Starting a session from a card uses the member's existing shared
terminal and chat access, bounded to the project, on the owner's AI route.

- Routes: `/api/collaboration/scopes/:scopeId/tasks…`, mirroring section 2,
  registered next to `chat-routes.ts` and `terminal-routes.ts`. Reads use the
  `read` action, task writes `mutate_project`, comments `discuss`.
- The adapter follows `discussion-adapter.ts`: one transaction that calls
  `lockAndReauthorize`, records the idempotent operation, writes the task
  rows, and calls `appendEvent`. After commit it notifies the scope.
- `CollaborationEventFrameSchema` gains `resourceKind: "task"`. Members
  receive `changed` and refetch.
- `SharedProjectView` in `packages/ui` gains the Board view, using the same
  board components as the owner's view with a different client.
- Assignee options are the active members of the organization the project is
  shared with. Authorship shows each member's name and avatar.
- Unsharing removes member access and keeps every task, comment and activity
  row. A removed member's past comments stay, attributed by name.

### 8. Board and task UI

One implementation in `packages/ui/src/project-board/`. Surface adapters
supply chrome, navigation and how a chat or terminal opens.

**Board view** on the project page, next to the existing overview:

```
[Overview] [Board] [Chats]                    filter: status priority label assignee  search   [+ New task]
Backlog        To do          In progress        In review        Done
+----------+   +----------+   +---------------+  +------------+   +---------+
| MOS-41   |   | MOS-44   |   | MOS-42  ● wrk |  | MOS-39 PR✓ |   | MOS-37  |
| title    |   | title    |   | title         |  | title      |   | title   |
| ▲high ◎a |   | ◎b       |   | ⎇ task/…  ◎me |  | ◎c  2 💬   |   |         |
+----------+   +----------+   +---------------+  +------------+   +---------+
```

- Drag and drop between and within columns, with keyboard equivalents.
  Columns virtualize beyond 50 cards.
- A card shows key, title, priority, labels, assignee, comment count, branch,
  PR state with checks, and the rolled-up agent status.
- A list view shows the same tasks as a sortable table.
- Empty state: icon, "No tasks yet", one line on what a task is, and
  **New task** plus **Import from Linear** when a connection exists.
- Filters and the chosen view persist per project and per surface.

**Opening a card opens its chat** (amended 2026-11-22). The Chat surface shows
a shared ticket header from `packages/ui` above the conversation whenever the
chat belongs to a project: key, title (the chat title), status, priority,
labels and assignee, all editable, plus **Details** for the description,
comments, activity, blockers, subtasks, due date, branch and pull request, and
**Start terminal**. The same component ships on Web Desktop, Web Canvas and
Electron Desktop. There is no sessions tab strip, no **Start chat** and no
**Attach existing** for chats.

The original task detail below describes the Details view:

**Task detail** opens over the board (the board keeps its place):

- left: title, description editor, comments and activity in one timeline,
  with a composer that supports `@` mentions of members;
- right rail: status, priority, assignee, labels, due date, blockers, parent
  and subtasks, Linear link, branch and PR state with **Create pull request**;
- sessions: a tab strip of the task's chats and terminals with their agent
  status, **Start chat**, **Start terminal** and **Attach existing**. A session
  renders with the existing Chat and Terminal components. "Open in window"
  hands it to the surface's normal Chat or Terminal window.

**Surfaces**:

- Electron Desktop: revive the `"board"` value of `ProjectViewSchema` and
  render it from `WorkTab` / `ProjectLanding`. Replace `stores/board.ts` with
  the shared client. `TaskWorkspace.tsx` is replaced by the shared task detail.
- Web Desktop and Web Canvas: `WebProjectHome` gains the same view switch.
- Shared projects: `SharedProjectView` on web and Electron.
- Web Mobile and Native Mobile: a list grouped by status with move, assign,
  comment and open session. No drag and drop. Ships in stack 2.

### 9. Notifications

New sources on the spec 652 router, each with a dedupe key:

| Source | Dedupe key | Recipient |
|---|---|---|
| Assigned to you | `task:<id>:assigned:<actor>` | New assignee |
| Mentioned in a comment | `task:<id>:comment:<commentId>:<user>` | Mentioned member |
| Comment on a task you are assigned to or created | `task:<id>:comment:<commentId>` | Assignee and creator, not the author |

Agent attention on a task's sessions already flows through 2692/2697.
Delivery to members of a shared project depends on how 652 reaches a member
whose home is another computer; see Risks.

## Reference parity

| SlayZone capability | Plan |
|---|---|
| Projects from a folder; tasks on a kanban with drag and drop | Board view on existing projects |
| Statuses `inbox backlog todo in_progress review done` | `backlog todo in_progress in_review done canceled`; no separate inbox |
| Priority, tags, blockers, subtasks | Priority, labels, `blocks` relations, parent and subtasks |
| Filter by status, priority, tag; per-project filter memory | Same, plus assignee and text |
| Terminal behind every card; several agents per task | Chats and terminal tabs per task, up to 16 |
| Agent auto-status on the card | Rolled-up agent status from 2692/2697 |
| Worktree per task; merge into parent | Worktree and branch per task; merge goes through a pull request |
| Diff, commit and conflict UI | Existing project diff and commit views, linked from the task. Conflict resolution UI deferred. |
| Embedded browser per task | Adapt: the task's previews open in the existing preview window. No per-task browser panel in v1. |
| Agents update the board through CLI and MCP | `matrix tasks`, `project_task_*` tools |
| Refuse to close while an agent is mid-reply unless forced | Same |
| Closing a task stops its agents | Not by default. Sessions outlive the card; a "Stop agents" option is offered on close. |
| Templates | Spec 2692 templates in **Start terminal** and **Start chat** |
| Project sharing with members and roles | Role-free organization sharing (spec 2689) |
| Hubs, multiple computers, moving tasks between computers | Not applicable: one computer per owner |
| Automations | Deferred; spec 2700 watchers are the intended mechanism |
| Linear sync, PR status | Not confirmed in the reference; specified here from the request |

## User journeys and acceptance

1. **Create and move.** On a project, open Board, create a task, drag it to To
   do. Reload: it is where it was left. A second window on the same project
   shows the move within 2 seconds without a reload.
2. **Every task is a chat.** Create a task on the board: it sits in Backlog
   with an empty chat. Open the card: its chat opens with the ticket header.
   Send the first message: the agent starts and the card moves to In progress
   with a working badge. Start a new chat in the project from the Chat app: a
   card appears in In progress. Rename either the card or the chat: both show
   the new title. Change the status from the chat's ticket header: the card
   moves on the board.
3. **Agent reports.** Inside that session the agent runs
   `matrix tasks comment "…"`. The comment appears on the task, attributed to
   the agent session.
4. **Pull request.** The agent opens a PR for the task branch. While the board
   is open, the card shows the PR and its checks and moves to In review within
   a minute when 20 or fewer visible cards have branches, and within
   `ceil(cards / 20)` minutes otherwise. After merge it moves to Done.
5. **Linear.** Link the board to a Linear team and import assigned issues.
   Change a status in Linear: the card moves within the polling interval.
   Move the card in Matrix: the Linear issue changes. Neither change bounces.
6. **Shared project.** A colleague in the organization opens the shared
   project, sees the same board, moves a card and comments. The owner sees
   both within 2 seconds, with the colleague's name on them.
7. **Conflict.** Two people edit the same description. The second save gets a
   conflict notice with both versions and the local edit is kept on screen
   until the person chooses.
8. **Failure.** With the gateway unreachable, a drag snaps back with a
   generic error and local state is unchanged.

## Surface matrix (target)

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | required | required | required | required | required |
| Web Desktop | required | required | required | required | required |
| Electron Desktop | required | required | required | required | required |
| Web Mobile | stack 2 | stack 2 | stack 2 | stack 2 | stack 2 |
| Native Mobile | stack 2 | stack 2 | stack 2 | stack 2 | stack 2 |

Electron Desktop is the visual reference. Validate Web Canvas first, then Web
Desktop, then Electron Desktop.

## Security architecture

### Auth matrix

| Route | Auth | Authorization |
|---|---|---|
| `/api/projects/:slug/tasks…`, `/board/settings`, `/board/linear/…` | Owner principal (existing project route gate) | Owner; project admission as for other project routes |
| `/api/collaboration/scopes/:scopeId/tasks…` | Direct-session ticket validated by the owner's home | `read`, `mutate_project` or `discuss`, re-authorized inside the transaction |
| `/api/workspace/events` | Existing owner gate | Owner |
| `/ws/collaboration/scopes/:scopeId/events` | Existing ticket | Scope members |
| Agent tools and `matrix tasks` from a session | Run-scoped token (chat) or pane loopback token (terminal) | Bounded to the session's own project |

### Input validation

- Path and query parameters are validated at the route boundary with Zod:
  `slug` against `PROJECT_SLUG_REGEX`, `taskId`, `commentId`, `scopeId`,
  cursors, limits (1 to 500), `status`, `q` (at most 200 characters).
- Bodies are Zod schemas from contracts. Every mutating route, including
  `DELETE`, has `bodyLimit` (256 KiB).
- Bounds: title 1 to 300 characters, description at most 50,000, comment 1 to
  10,000, labels at most 20 per task and 48 characters each, at most 50
  relations and 100 subtasks per task, 16 sessions per task.
- Branch names are built by the server from the task key and a slug of the
  title. Client-supplied branch names are validated against the same safe
  pattern the worktree manager uses.
- Markdown is rendered with the shared sanitizing renderer. Nothing from a
  task is interpolated into a shell command; the first message is sent through
  the session send path.

### Errors

Typed errors and one mapper per route file. Clients get generic messages and
stable codes (`task_not_found`, `task_revision_conflict`, `task_agent_working`,
`task_limit_reached`, `board_sync_unavailable`). Provider names, `gh` output,
SQL errors and paths stay in server logs. A missing database handle or
registry is a 503, not a 404.

### Credentials

The Linear connection stays platform-owned and is reached through the existing
integrations proxy with the gateway's existing token. No Linear or GitHub
secret is written to task rows, activity or logs.

## Integration wiring

- `startup/owner-database.ts` calls `bootstrapProjectTaskDatabase` after the
  chat and collaboration bootstraps.
- `ProjectTaskService` is constructed once at gateway startup with the owner
  database, project registry and identity index, worktree manager, the chat
  and terminal services, the agent session index, the workspace event
  publisher, the notification router and the integrations client. All are
  injected; nothing uses `globalThis`.
- `workspace-routes.ts` delegates its task routes to the new service through a
  thin adapter. `task-manager.ts` stays read-only for the import and is
  removed in a follow-up once no caller remains.
- Collaboration: `registerTaskRoutes` is added to `collaboration/routes.ts`
  and wired through `route-support.ts`.
- The Linear sync job starts with the gateway, holds a per-project lock, and
  stops on shutdown before the database handle is destroyed.
- Kernel tools resolve `ProjectTaskService` at registration.

## Failure modes

| Case | Behavior |
|---|---|
| Two edits to one task | Content edits use `WHERE revision = :base`; the loser gets 409 and keeps its local text. Moves are a single targeted update and last writer wins. |
| Two creates with the same `clientRequestId` | One row; the second returns the first result |
| Start work fails after the worktree is created | The task keeps `worktree_id`; a retry reuses it. An unused worktree is an acceptable orphan and is listed under the project's worktrees. |
| Start work fails after the session is created but before the link row | The link insert is retried with the same session ref; duplicates are prevented by a unique index |
| `gh` missing, signed out or slow | 10 s timeout; `prStatus: "unavailable"`; cards render without PR state |
| Linear unreachable or the connection revoked | Sync pauses with backoff (1 min to 30 min), the board shows "Linear sync paused", local edits continue and queue in the outbox |
| Outbox send succeeds but the response is lost | The retry is recognized by the stored remote timestamp and field values; no duplicate comment is created because comments carry a client marker |
| Member's access is revoked mid-edit | Re-authorization inside the transaction fails; the client gets a generic access error |
| Gateway restart | No in-memory authority. Sync resumes from the stored cursor; the outbox is durable. |
| Task deleted while a session is running | The session keeps running as an ordinary chat or tab; the link row goes with the task |
| Chat and task created at the same time from two paths | One transaction inserts both; the unique indexes on the chat request key and `(owner_id, chat_id)` make the loser return the existing pair |
| The ticket hook fails inside a chat create | The whole chat create rolls back with a generic error; no chat without a task is committed |
| Backfill interrupted or run by two gateways | Each chat is checked under a row lock and linked at most once (unique `(owner_id, chat_id)`); the next board open continues where it stopped, at most 500 rows per open |
| A chat is deleted | Its task is soft-deleted in the same transaction; terminals attached to it keep running |

## Resource management

- Up to 5,000 non-archived tasks per project; creation beyond that returns
  `task_limit_reached`. Lists are cursor paged.
- PR summary cache: at most 500 entries, 60 s TTL, least recently used
  eviction.
- Activity rows older than 400 days are pruned daily, keeping the latest 200
  per task.
- Outbox rows are deleted on success and dropped to a failed state after 20
  attempts, visible in board settings.
- Sync runs at most one job per project and four per owner at a time.
- No temp files. No unbounded in-memory collections.

## Integration test checkpoint

Each stack layer ends with unit tests plus one test through real boundaries:

- store and routes against real Postgres, including the file import, the
  revision conflict and concurrent moves;
- start work against a real git repository and the real worktree manager;
- collaboration against two principals with re-authorization;
- Linear sync against a recorded-contract fake of the integrations proxy,
  including echo suppression and a lost response;
- a runtime check on a preview VPS for each layer that changes the gateway,
  and live captures per surface for each UI layer.

## Delivery

Two sequential GitHub native stacks, each with its own ENG ticket.

**Stack 1: the board for one owner (6 PRs)**

1. Contracts, owner Postgres store, file import, upgraded task routes and events
2. Comments, activity, labels, relations and subtasks; notification sources
3. Start work: worktree, chat and terminal sessions, task git and PR state, automation
4. Shared board and task detail in `packages/ui`; Web Canvas and Web Desktop
5. Electron Desktop board view, replacing the leftover board store and task tab
6. Agent access: `matrix tasks`, MCP tools, kernel tools

**Stack 2: with other people and other tools (4 PRs)**

1. Organization sharing: collaboration adapter, routes, event kind, shared project view
2. Linear link, import and two-way sync
3. Web Mobile and Native Mobile list view
4. Docs, agent skill text for `matrix tasks`, removal of `task-manager.ts` callers

Public docs: a separate PR in `FinnaAI/matrix-os-site` under `content/docs/`
covering the board, start work, `matrix tasks` and Linear sync, opened once
each stack's behavior is final.

Stack 1 layers 3 and 6 depend on spec 2697's `AgentSessionRef`. If 2697 has
not merged, they store the same string form (`chat_<id>`, `term.<ws>.<tab>`)
and read status from the 2692 terminal status service and chat run state.

## Risks and open questions

1. **Fixed columns.** Teams with different Linear workflows may want custom
   columns. Deferred: fixed statuses keep agent vocabulary, automation and
   Linear mapping simple. Revisit after use.
2. **Polling Linear.** A one to five minute delay is visible. A webhook
   receiver on the platform would fix it and is a follow-up.
3. **Member notifications.** The 652 router is owned by each person's gateway.
   Notifying a member of a mention on another owner's board needs either a
   member-side poll of shared scopes or a relay hop. Decide with the 652 owner
   before stack 2 layer 1.
4. **Mentioning agents.** `@agent` in a comment could send the comment to the
   task's main session. Useful, but it spends the owner's AI budget on a
   member's keystroke. Left out of v1.
5. **GitHub issues.** Not synced in v1. The external link table allows a
   second provider later.
6. **Name.** The view is "Board". The message board in spec 2700 needs a
   clearly different name in the UI so the two are not confused.
7. **Old default app.** `home/apps/task-manager` is a personal Trello-style
   app with its own tables. It stays as it is; this board is project work.
