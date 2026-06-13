# Operator Task-First Cloud Coding Handoff

## Objective

Continue the Matrix Operator desktop app as a task-first cloud coding control surface. Matrix is not a local IDE and does not need cloud LSP as the core experience. The coding work happens on the user's Matrix cloud computer through terminal sessions and agent CLIs. The desktop app should make the cloud computer feel direct, persistent, reviewable, and faster to operate than raw SSH.

Primary product loop:

1. Create or open a task.
2. Attach a project, repo path, branch, and cloud worktree.
3. Start one or more terminal sessions in the correct cwd.
4. Launch a coding agent CLI with task context.
5. Inspect files, logs, preview, diff, and run status.
6. Review and ship the result.
7. Resume the same task from desktop, web, mobile, or CLI.

Task is the primary object. Terminals, files, previews, logs, diffs, background jobs, chat, and agent runs hang off the task.

## Product Positioning

Matrix should lead with cloud coding for developers, then expand into team sessions, workshops, hackathons, and Hermes/company workflows.

- Individual wedge: a private cloud computer for coding with agents.
- Team wedge: shared task sessions, reviewable workspaces, and org rollout.
- Program wedge: workshops, hackathons, and classes with preinstalled software and access.
- Hermes wedge: background business agents connected to tools, schedules, approvals, logs, and company context.

Do not position Operator as another editor. The file viewer and editor are utility surfaces for inspection and small edits. The main coding interface is terminal access to the cloud computer plus task-aware orchestration.

## Reference Research Protocol

Use the owner-supplied private reference app repository and the installed desktop coding app as interaction references when needed. Study their UX patterns for:

- Sidebar density, collapse behavior, profile footer, and active state treatment.
- Top tab strip behavior, icon usage, tab close affordances, and keyboard navigation.
- Command palette scope and action naming.
- Terminal/session surfacing, status indicators, and reconnect behavior.
- Resizable workspace layouts and pane activation.
- Empty states, loading states, and error recovery.

Rules for references:

- Do not copy source code, product copy, brand marks, icons, screenshots, or assets.
- Do not write private reference product names into source code, comments, commits, PR title/body, screenshots, generated docs, or test names.
- If a PR needs to explain provenance, say "private reference review" or "desktop coding app interaction review" without naming the products.
- Keep implementation names Matrix-native: task workspace, terminal session, command palette, cloud worktree, agent run, preview, diff, job, schedule.

## P0 UX Fixes

### 1. Resizable Task Panes

Problem: task panes are not reliably resizable, which makes the task workspace feel like a demo rather than a daily coding surface.

Requirements:

- Use the installed `react-resizable-panels` package.
- Persist pane layout per task and per tab identity.
- Support at minimum: terminal, file viewer, editor, preview, logs/processes, git/diff, and chat panes.
- Let users collapse and restore panes without losing state.
- Keep pane resize handles visible enough to discover but quiet enough for daily use.
- Do not put cards inside cards. The task workspace should be a dense, utilitarian work surface.
- Avoid layout shift when opening transient panels. Persistent panes may resize the workspace with smooth transitions.

Acceptance:

- A user can resize terminal/file/preview panels, switch away, return, and see the same layout.
- A collapsed pane restores to its previous size.
- Text, tabs, and toolbar controls do not overflow at narrow desktop widths.

### 2. File Viewer That Works for Cloud Coding

Problem: the file viewer is not reliable enough for task work.

Requirements:

- Provide a tree view with refresh, loading, empty, and safe error states.
- Support quick open/search by filename.
- Open files into the editor pane or tab without replacing terminal state.
- Handle large files and binary files explicitly.
- Support small edits and conflict-safe save through the existing CodeMirror path.
- Show path, dirty state, save status, and last refresh time.
- Keep this scoped as a utility viewer/editor, not an IDE clone.

Acceptance:

- A user can inspect files changed by an agent, open a file, make a small edit, save it, and return to the terminal without losing session focus.
- File read/save errors are generic and safe for users while detailed logs stay server-side.

### 3. Icons, Shortcuts, and Command Palette

Problem: the app needs a keyboard-first desktop feel.

Requirements:

- Use installed icon libraries for controls. Prefer recognizable icons over text-only buttons for common actions.
- Add tooltips for icon-only controls.
- Add or complete a command palette for task, tab, pane, terminal, sidebar, and app actions.
- Add shortcuts for:
  - Toggle sidebar: `Cmd+B`
  - Command palette: `Cmd+K`
  - Switch tabs: `Cmd+Shift+[` and `Cmd+Shift+]`
  - Close active tab: `Cmd+W`
  - Reopen closed tab if supported: `Cmd+Shift+T`
  - Activate panes: `Cmd+1` through `Cmd+6`
  - New task terminal: `Cmd+Shift+Enter`
  - Toggle terminal pane: `Cmd+J`
  - Escape closes the topmost transient UI
- Terminal focus must capture shell-relevant keystrokes. Global shortcuts should only fire when focus is not inside an interactive terminal input path, except for explicitly reserved app shortcuts.
- Add a shortcuts reference in Settings or the command palette.

Acceptance:

- A user can navigate the task workspace, tabs, sidebar, and terminal sessions without using the mouse.
- Shortcut behavior is covered by tests around terminal focus vs global focus.

### 4. Terminal Sessions as Task Tabs

Problem: terminals are the product core but are not first-class enough inside tasks.

Requirements:

- Show task terminal sessions in a top task tab bar or task session strip.
- Use clear icons/status for terminal, agent running, detached, exited, needs attention, and failed.
- Support multiple terminal sessions per task.
- Users can create, attach, detach, observe, take over, rename, close, and kill sessions from the task.
- Sessions must link to task, project, worktree, branch, cwd, and agent run metadata.
- Returning to a task restores terminal tabs and active session selection.
- Dead or missing sessions should become recoverable UI, not disappear silently.

Acceptance:

- From inside a task, a user can create two terminal sessions, launch an agent in one, run tests in another, switch between them from the top session strip, leave the task, return, and reattach.

### 5. Task Creation and Task Activation

Problem: users cannot reliably create tasks or activate terminal sessions from inside a task.

Required happy path:

1. Create task from board, command palette, or task workspace.
2. Choose project or repo.
3. Create or select cloud worktree.
4. Open task workspace.
5. Create terminal session in the correct cwd.
6. Optionally launch a configured agent CLI with task context.

Task header should show:

- Task title and status.
- Project/repo.
- Worktree/branch.
- Active terminal count.
- Active agent run.
- Preview health.
- Dirty diff count.
- Last activity.
- Needs-input indicator.

Acceptance:

- A new task can become an active cloud coding workspace in one continuous flow.
- Failed steps keep enough state to retry safely without duplicating tasks, worktrees, or sessions.

### 6. Agent CLI Launching

Problem: Matrix should make existing terminal agent CLIs excellent before inventing another agent runtime.

Requirements:

- Support configurable launch templates for `claude`, `codex`, and custom commands.
- Launch inside the selected task worktree/cwd.
- Inject task context into the launch prompt: title, description, acceptance criteria, project, branch/worktree, relevant files if available, and verification expectations.
- Track agent run metadata: command, taskId, sessionId, projectId, worktreeId, startedAt, endedAt, status, exit state, and needs-input state.
- Let users abort or stop a run without destroying unrelated terminal sessions.

Acceptance:

- A user can open a task, click or command-palette launch an agent, watch it run in a terminal, and see its run status reflected in the task UI.

## P1 Platform and Workflow Features

### Preview, Processes, and Logs

- Detect and list preview URLs/ports per task.
- Provide embedded preview and open-external actions.
- Show process/job health, logs, stop, restart, and copy command actions.
- Make preview/process state part of task restore.

### Git, Diff, and Ship Loop

- Implement real diff content endpoint wiring in Operator.
- Show changed files, hunks, dirty count, commit action, PR action, and CI/review state.
- Let users ask an agent to fix a selected hunk by launching an agent prompt into the task terminal.
- Keep commits and PR actions human-confirmed.

### Cross-Device Realtime State

- Push task, session, agent-run, preview, process, diff, and needs-input events.
- Ensure desktop, web, mobile, and CLI attach to the same source-of-truth records.
- Notifications should distinguish done, failed, needs input, and review ready.

### Board as Coding Control Plane

Task cards should show:

- Running agent.
- Linked session count.
- Worktree/branch.
- Dirty diff count.
- Preview state.
- Last activity.
- Needs input.
- PR/review status.
- Quick actions for open task, attach terminal, launch agent, preview, and review diff.

## P2 Hermes, Jobs, and Matrix Skills

### Ship CLI and Sync Engine With Operator

- Bundle or install the Matrix CLI with the desktop app distribution.
- Ensure desktop auth/runtime selection and CLI auth/runtime selection converge on the same Matrix account and runtime.
- Ship or install the sync engine alongside Operator when appropriate.
- Add upgrade/version display for desktop, CLI, sync engine, and gateway compatibility.

### Matrix Skills for Local Coding Agents

Provide Matrix skills so local coding agents can manage Matrix jobs through official interfaces.

Required skills:

- List jobs.
- Create background or cron job.
- Edit job.
- Preview job config.
- Monitor logs and status.
- Pause, resume, and delete job.
- Open Matrix UI for a job.

Rules:

- Skills should use Matrix gateway or CLI APIs.
- Avoid ad hoc file edits unless the file is the documented source of truth.
- Skills must warn before actions that can mutate schedules, secrets, tool permissions, or production jobs.

### Hermes Background Agent Control Plane

Hermes should become the UI/RPC/CLI layer for business background agents.

Jobs need:

- Owner and scope.
- Schedule or trigger.
- Tool permissions.
- Connected accounts.
- Run history.
- Logs.
- Artifacts.
- Approval points.
- Pause/resume/delete.
- Notification rules.

Company model:

- A company can have an org Matrix instance as the company brain.
- Employees can have their own Matrix instances.
- Personal and org data stay separate.
- Shared workflows use explicit org scopes and permissions.

## Implementation Constraints

- Keep credentials and tokens in main/gateway-owned secure paths. Do not expose them to renderer state.
- Validate every IPC and gateway boundary with schemas.
- Keep in-memory registries capped and evicted.
- No unbounded terminal buffers.
- Do not expose raw filesystem, provider, database, or process errors to clients.
- Do not duplicate derived Zustand logic in components.
- Avoid fresh arrays/objects in selectors.
- Use mature installed UI libraries rather than hand-rolled controls.
- Do not add cloud LSP as part of this work.

## Verification

Before committing each implementation slice:

1. Run desktop typecheck.
2. Run desktop unit tests.
3. Run React audit for desktop React changes.
4. Rebuild the Electron app before e2e.
5. Run Playwright Electron e2e against the stub gateway.
6. Capture screenshots for changed UI states.

Minimum e2e coverage:

- Create task.
- Attach project/worktree.
- Create terminal session from task.
- Launch an agent CLI command template.
- Resize task panes.
- Switch task panes by keyboard.
- Switch top tabs by keyboard.
- Hide/show sidebar.
- Open file viewer and save a small edit.
- Restore task workspace after navigating away.
- Show needs-input and exited-session states.

## Definition of Done

A user can create a task, attach a cloud worktree, start one or more terminal sessions, launch a coding agent CLI in the right cwd, inspect files, resize panes, switch tabs with keyboard shortcuts, hide/show sidebar, preview the app, monitor logs/jobs, review diffs, and resume the whole workspace later from desktop, web, mobile, or CLI.
