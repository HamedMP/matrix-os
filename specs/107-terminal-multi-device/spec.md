# Feature Specification: Project-Scoped Zellij Terminal Workspaces

**Feature Branch**: `codex/project-scoped-zellij-workspaces`
**Created**: 2026-07-13
**Revised**: 2026-08-11
**Status**: Accepted for coordinated implementation

## Scope and locked decisions

This specification replaces the earlier phased and compatibility-oriented terminal design. The implementation ships as one coordinated Matrix OS activation across the browser Canvas/Desktop shells, Electron, native mobile, CLI, gateway, supervisor, and host bundle.

- Every project owns exactly one terminal workspace backed by exactly one Zellij session.
- `main` is the only unscoped workspace.
- Every Matrix terminal is a Zellij tab with exactly one managed pane.
- Matrix splits are client-side views and may show any tabs; they never create Zellij panes.
- Device/window tab selection is local. Multiple devices may view and type into the same tab.
- All tabs receive durable background scrollback, including with zero viewers.
- Existing foreground processes are intentionally stopped once during cutover and are not relaunched.
- Older clients are unsupported after activation. There is no legacy coexistence or partial feature mode.
- Project deletion requires explicit confirmation before its workspace and running tabs are terminated.

True per-client reflow of one PTY is impossible. A workspace therefore owns one canonical grid. CLI is a hard-size client; browser, Canvas, Electron, and native mobile are soft clients that scale or pan without changing the canonical grid.

## User stories and acceptance

### P1: durable project terminal work

As an owner, I can open a project on any shell and see the same project workspace and tabs. With 23 tabs, exactly one Zellij server exists for that project, and idle tabs keep running without gateway-owned terminal processes.

Acceptance:

1. Opening a known project ensures its unique workspace; opening outside a project ensures `main`.
2. Creating, renaming, reordering, or terminating a tab produces the same stable workspace/tab identity on every current client.
3. Closing a view detaches only that view. Explicit termination stops only the selected tab.
4. Gateway restart does not stop Zellij servers or tab processes.

### P1: independent multi-device viewing and serialized input

As an owner, I can view the same or different tabs from two devices without either device changing the other's selection or dimensions.

Acceptance:

1. Two devices may view one tab through one shared attachment and both receive its raw output.
2. Concurrent input from all viewers and agent controllers is serialized in message-arrival order for that tab.
3. Different tabs use different attachments. An attachment is closed after its last viewer leaves without stopping the tab process.
4. A mobile/browser/Electron attach never changes the workspace canonical size. CLI hard-size updates do.

### P1: background observation and reconnect

As an owner, I can leave an agent or build running with no connected device and later restore its terminal state.

Acceptance:

1. One structured Zellij `subscribe` observer per workspace checkpoints ANSI screen, viewport, and scrollback for every managed pane.
2. Observer state includes background tabs and continues with zero viewers.
3. Reconnect carries a durable snapshot, monotonic revision, and bounded replay/gap events.
4. Browser, Electron, and mobile retry indefinitely with capped exponential backoff and jitter; no refresh is required.

### P1: one-time cutover

As an existing owner, I retain terminal names, canonical working directories, metadata, layouts, references, preferences, and scrollback while accepting that current process memory is lost once.

Acceptance:

1. Startup enters maintenance mode and writes an idempotent migration journal before stopping anything.
2. Recorded project ownership wins; otherwise canonical cwd classification is used; ambiguity maps to `main`.
3. New workspace/tab records and all reference rewrites are staged before old Zellij sessions stop.
4. Fresh shell tabs start in preserved cwd; old commands and agents are not relaunched.
5. Interrupted staging retries safely; corrupt state is rejected without stopping old sessions.
6. A rollback backup and command recreate old topology and metadata, but document that terminated process memory cannot be restored.

### P2: safe project deletion

As an owner, I see the running-tab impact before project deletion and must explicitly confirm terminal termination.

Acceptance:

1. An unconfirmed delete with running tabs returns a conflict and bounded tab impact.
2. Confirmed deletion stops the project Zellij session, removes the workspace, then removes project state.
3. Failure to inspect or delete the terminal workspace prevents project deletion and returns a generic error.

## Data model

`TerminalWorkspace` contains stable Matrix ID, `scope` (`project` or `main`), project ID when scoped, opaque internal Zellij session name, canonical size, status, revision, and timestamps. A unique persisted scope guarantees one workspace per project and one `main`.

`TerminalTab` contains stable Matrix tab ID, current structured Zellij tab/pane IDs, opaque internal tab name, display name, canonical cwd, agent/git metadata, status, UI state, monotonic revision, ordering, exit state, and timestamps. Runtime IDs are reconciled from the opaque name after a Zellij restart.

`TerminalRef` is `{ workspaceId, tabId }`. It replaces the former public scalar terminal identifier in agent requests/events/summaries, Canvas references, runtime summaries, handoffs, preferences, layouts, and stop reconciliation.

Owner-controlled state is stored under the Matrix home with atomic writes, bounded files, symlink rejection, and a schema version. Runtime-only attachments, observers, input queues, and replay buffers are bounded in memory and never become a second persistence authority.

## Runtime architecture

`matrix-terminal-runtime` is a VPS-native host service in a cgroup separate from `matrix-gateway`. It owns Zellij servers, observers, shared PTY attachments, replay/checkpoint state, migration, and the protected Unix-socket control API. The socket is owner-only; requests and frames are length-prefixed, bounded, and schema validated. Gateway shutdown drains WebSockets and socket clients but does not stop the terminal service.

The exact bundled binary is checksum-verified Zellij 0.44.3. Runtime control uses structured `list-tabs --json` and `list-panes --json` identifiers, targeted tab/pane actions, and `subscribe --format json`; tab-index shifting is prohibited.

One observer exists per active workspace. One attachment exists per viewed tab, shared by all viewers. Attachments have viewer TTL eviction, caps, shutdown drains, bounded input queues, and isolated broadcast failure handling. Creation remains rate-limited without a user-facing tab-count ceiling; cgroups and eviction bound actual resources.

## HTTP and WebSocket contract

All routes use existing owner authentication. Every path/query/body/frame is validated with Zod 4. Mutations use `bodyLimit`; errors are generic and bounded.

| Surface | Auth | Behavior |
|---|---|---|
| `GET /api/terminal/workspaces` | owner bearer/session | List workspaces and tabs |
| `POST /api/terminal/workspaces/ensure` | owner + body limit | Idempotently ensure project or `main` |
| `/api/terminal/workspaces/:workspaceId/tabs...` | owner + body limit on mutations | Create, rename, reorder, UI-state, paste asset, terminate |
| `GET /api/terminal/workspaces/:workspaceId/deletion-impact` | owner | Report running tabs |
| `DELETE /api/terminal/workspaces/:workspaceId` | owner + body limit | Require explicit termination confirmation |
| `/ws/terminal/tab?workspaceId=...&tabId=...&client=...` | owner bearer or registered query token | Snapshot, replay, live output/input, sizing, exit, heartbeat |
| old terminal session/run REST and WS routes | owner | `426 client_upgrade_required`; never create aliases or sessions |

The WS protocol carries `TerminalRef` on every tab-specific frame, canonical size, revision, snapshots, replay start/end/eviction, live sequenced output, exit, ping/pong, resize class, input, and detach. Browser query-token authorization is explicitly registered for the exact tab path. Subscriber registries evict stale connections and drain on shutdown.

## Client contract

- Browser Canvas and Desktop use one workspace-aware store. Sidebar rows are Zellij tabs grouped by project; opening a project selects its workspace. Split panes remain local mappings to tab refs.
- Electron and native mobile use the identical API and keep selected tab locally per window/device.
- `matrix shell list` groups tabs by project. `matrix shell connect --project <project> --tab <tab>` attaches one tab. Inside a known project, commands default there; otherwise to `main`.
- `matrix run -it` creates a tab in the resolved workspace. Legacy session and native Zellij-pane commands are removed.
- Agent execution creates a normal project tab and sends targeted serialized input without requiring a viewer attachment.
- Canvas terminal source refs carry `TerminalRef`; create/attach/write/terminate actions resolve through the host runtime.

## Migration and rollback

The migration phases are `journaled`, `staged`, `legacy_stopped`, `runtime_created`, and `committed`. Before `legacy_stopped`, failures preserve the old runtime. After that point, retries use staged records and do not relaunch old commands. Schema commit is atomic and only occurs after every new workspace/tab has been reconciled.

The rollback bundle preserves old registry/state bytes plus generated commands to recreate the old Zellij topology and metadata. Rollback is explicit, idempotent, validates its backup, and never claims to restore process memory.

## Resource and failure policy

- Socket connections, viewers/tab, attachment cache, observer count, snapshots, scrollback bytes, pending frames, pending input bytes, reference files, and migration candidates are capped.
- Stale viewers are swept by TTL; failed senders are evicted after isolated delivery failure.
- Snapshot writes are serialized and atomic. Background checkpoint failure is logged and retried without exposing paths or raw Zellij errors.
- Gateway or supervisor reconnect does not interrupt Zellij. Runtime restart reconciles stable Matrix refs from opaque tab names and restores observers.
- Missing runtime/socket configuration is a generic 503, never a not-found response.
- Shutdown notifies clients, stops accepting work, drains bounded writes/checkpoints, closes attachments/observers, and releases owned resources.

## Verification requirements

Tests are written red-first for contracts, migration, runtime orchestration, gateway boundaries, every client, and failure behavior.

1. Real-Zellij tests run against the exact bundled 0.44.3 binary and verify IDs, targeted input, observer output, lifecycle, and restart reconciliation.
2. A 23-idle-tab measurement asserts one Zellij server and substantially less RSS than 23 sessions; gateway RSS excludes terminal processes.
3. Multi-device tests cover same tab, different tabs, independent switching, shared output, and serialized concurrent input.
4. Browser, Canvas, Desktop, Electron, native mobile, CLI, agent, and gateway resolve identical refs.
5. Zero-viewer agent/build output survives gateway and supervisor reconnect.
6. Soft-client attaches never alter hard canonical dimensions.
7. Detach preserves processes, explicit terminate affects one tab, and project deletion is confirmation-gated.
8. Migration tests cover classification, duplicates, interruption, corruption, scrollback, rewrites, atomic commit, and rollback.
9. Security/failure tests cover auth, query tokens, Zod boundaries, body limits, generic errors, stale eviction, drains, and bounded buffers.
10. Repository audit finds no unresolved former public terminal identifier in active clients/contracts and proves old endpoints cannot create terminal state.

## Delivery

This is one `matrix-os` implementation PR and one separate `FinnaAI/matrix-os-site` documentation PR. Updated browser, Electron, mobile, CLI, gateway, supervisor, and host bundle activate together. There is no prototype flag or staged compatibility mode. Greptile 5/5 must match the final Matrix OS PR head before `ready-for-ci`; label-triggered CI must then pass.

## Explicitly superseded decisions

The following decisions from the 2026-07-13 draft are rejected: legacy sessions remaining attachable, migration waiting for sessions to become idle, old-client fallback behavior, a recorder that only persists the focused tab, background-tab persistence being deferred, browser/Electron acting as hard-size clients, and mobile/desktop workspace adoption landing in later PRs.
