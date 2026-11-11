# Feature Specification: Herdr Parity for Matrix Terminals and Agents

**Status**: Draft (2026-11-11). Ticket: pending (ENG, requester-assigned). Related: ENG-443, `specs/651-desktop-terminal-window/`.

## Goal

Everything a person or agent can do with terminals and coding agents in Herdr
(`herdr-app` plus `herdr-core`/`hc`) they can do in Matrix OS, on every OS view
and from every programmatic client (CLI, remote-computer MCP, Matrix kernel).
The reference is Herdr's own guide (`herdr-app` `defaults/AGENTS.md`, the file
Herdr writes to `~/.config/herdr-app/AGENTS.md`) and `hc --skill` / `hc schema`
for `hc` 0.1.20. See `research.md` for the capability inventory and spikes.

## Principles

1. **The gateway owns the behavior.** New verbs live in the gateway and
   terminal runtime against canonical project workspaces (`TerminalRef
   { workspaceId, tabId }`). Web Canvas, Web Desktop, Electron Desktop, Web
   Mobile, Native Mobile, `matrix` CLI, the remote-computer MCP server and the
   kernel all consume the same routes. No surface reimplements status,
   waiting or parent logic (Constitution III, AGENTS.md surface parity).
2. **Herdr vocabulary, Matrix storage.** Status words, verb names and
   semantics follow `hc` so agents trained on `hc --skill` transfer directly:
   `run`, `ls`, `get`, `read`, `send`, `keys`, `interrupt`, `wait`, `label`,
   `kill`, `rm`, `put`, `events`, `templates`.
3. **Owner data stays files.** Templates are Markdown files in the owner's
   home; tab metadata stays in the existing terminal workspace state file.
   No new database.

## Parity Matrix

Legend: **have** = shipped; **gap** = this spec adds it; **adapt** = Matrix
equivalent with a deliberate difference; **later** = follow-on stack.

| # | Herdr capability | Matrix today | Plan | Layer |
|---|---|---|---|---|
| 1 | `run` with cwd, argv, name | have (gateway tabs, CLI, MCP) | Electron local: gap | 6 |
| 2 | `ls` / `get` all terminals with state, status, exit code | have, no finished list | gap: `finished` tabs with exit codes, `get` facts | 2 |
| 3 | `attach`, multi-viewer, detach | have | — | — |
| 4 | `read --lines N`: screen plus history as text, no attach | gap | read from checkpoint snapshot | 2 |
| 5 | `send`: paste + Enter, waits for a human draft, refuses `blocked` unless `force` | raw input only | gap | 2 |
| 6 | `keys` by name, encoded for the program's keyboard mode | raw bytes | gap: named-key encoder (normal + application cursor mode) | 2 |
| 7 | `interrupt`: Esc for status-reporting agents, else Ctrl+C; reports what was observed | gap | gap | 2 |
| 8 | Status words `idle working done blocked error` | hooks give running/waiting/finished/idle for 4 agents; per zellij session, not per tab | gap: per-tab status in Herdr words from hooks + status reporter | 3 |
| 9 | OSC 7501 status from any program | gap; zellij drops it (spike S1) | adapt: `matrix-status` reporter + opt-in OSC tap for launched agents | 3 |
| 10 | `wait`: until not working, exit, output match, children any/all, timeout | gap | gap | 3 |
| 11 | `events`: snapshot, ordered facts, heartbeat, `missed` + resnapshot | polling | gap: `/ws/terminal/events` | 3 |
| 12 | Labels `k=v`, list filter by labels | gap | gap | 4 |
| 13 | Parent/child: `parent`, die-with-parent, `--outlive-parent`, reports tagged `<hc from=…>` | gap | gap: `parentRef`, cascade end, `<matrix from=…>` delivery | 4 |
| 14 | Templates: `~/.config/herdr-core/templates/<name>.md`, first message after readiness, `first_message.sent` | gap (Chat-only saved agents) | gap: `~/agents/templates/<name>.md` | 4 |
| 15 | Notes to parent when a child is blocked/error/exited | gap | gap | 4 |
| 16 | Kernel can drive terminals | gap (no kernel tools) | gap: kernel IPC tools over the same service | 4 |
| 17 | MCP / CLI verbs | partial | gap: same verbs in `matrix shell` and MCP | 2–4 |
| 18 | Status roll-up tab → space (blocked > done > working > idle) | per-tab badge | gap | 5 |
| 19 | Attention: sound + toast when blocked or done unseen; `done` → `idle` once seen | partial (waiting badge) | gap | 5 |
| 20 | Agents list, pin, next/prev agent, peek a sub-agent | gap | gap | 5 |
| 21 | Per-terminal find (screen + scrollback) | have (xterm search addon, Web) | Electron: gap | 6 |
| 22 | `put` file beside terminal; paste image | have (paste assets, Web/CLI) | Electron local: gap | 6 |
| 23 | `keep`: lost program becomes a shell in its folder | have for gateway restart; no shell-on-loss | gap | 4 |
| 24 | Worktree spaces nested under repo | partial (projects/worktrees exist) | later | — |
| 25 | Remote machines (`--on`), `exec`, `file read/write/edit` | MCP `run_command`, read, upload; no edit; SSH not started | later stack (see 651 J5 and the Herdr-sessions brief) | — |
| 26 | Layouts, themes, keys.json, JS mods, gallery | Matrix themes, apps | adapt: Matrix apps are the extension model; not ported | — |
| 27 | Mobile inbox (needs you / done / working / idle) | gap | Native + Web Mobile consume layer 3/5 APIs | later |

Rows 24–27 are explicitly deferred to a follow-on stack, so this stack stays within the 10-PR limit.
Row 26 is an architectural difference. Herdr extends its window with GPUI JavaScript mods; Matrix
extends itself with sandboxed Vite apps (Constitution VI). A mod runtime would be a second,
unsandboxed extension system, so it is out of scope.

## Design

### Verbs (layers 2–4)

All verbs are routes under the existing `/api/terminal` mount, nested under a
tab: `/api/terminal/workspaces/:workspaceId/tabs/:tabId/<verb>`. They use the
same owner gate as `createTerminalWorkspaceRoutes` (single owner principal,
preview owner, project admission) and reach only owner tabs (`accessScope:
"owner"`); Chat-bound and legacy tabs keep their own paths. The logic lives
in `packages/gateway/src/terminal-agent/` and runs over the existing
`TerminalRuntimeSocketClient` operations (`ListWorkspaces`, `GetSnapshot`,
`WriteInput` with `expectedIncarnation`). The runtime protocol doesn't change, and
nothing is added to the 1193-LOC `runtime.ts`.

| Verb | Route | Semantics |
|---|---|---|
| get | `GET …/tabs/:tabId` | Tab facts plus `agentStatus`, `labels`, `parentRef`, `exitCode`, `firstMessage` |
| read | `GET …/tabs/:tabId/read?lines=N` | `{screen, history, lines, incomplete?, why?}` from the latest checkpoint snapshot. `lines` 0..10 000 (0 = screen only). While status is `working`/`blocked`/`error`, history reads stay available (snapshots never scroll the program). |
| send | `POST …/tabs/:tabId/send` `{text, force?}` | Single-line text is typed; multi-line text goes as one bracketed paste. Then Enter. Control and escape characters, including paste markers, are stripped. Refuses `blocked` with 409 `terminal_agent_blocked` unless `force`. If a person typed in a live viewer within the last 3 s, it holds until 3 s of keyboard quiet, never more than 60 s. Holding for output quiet comes with the layer 3 event stream. |
| keys | `POST …/tabs/:tabId/keys` `{keys: KeyName[]}` | Named keys (`enter esc tab backspace up down left right home end pageup pagedown delete ctrl+<a-z> alt+<a-z> f1..f12 space`), max 64, encoded by the mouse/keyboard mode state (`application cursor` changes arrows). |
| interrupt | `POST …/tabs/:tabId/interrupt` | Esc when the tab reports agent status, else Ctrl+C; returns `{pressed, observed: status-or-exit within 5 s}`. Never escalates. |
| wait | `POST …/tabs/:tabId/wait` `{output?, timeoutMs?}` | Resolves `{reason: "stopped"|"exited"|"output"|"timeout"|"cancelled"|"shutdown", status?, exitCode?}`. Already not working → immediate; a program that never reported status counts as working until exit. `output` is a literal (≤256 chars) that must occur more often than when the wait began. One request waits at most 90 s (default 60 s), below proxy idle limits. `timeout` is a check-in: `matrix shell wait` keeps re-waiting until its own `--timeout` (default 180 s) and then exits 124, like `hc wait`. A client disconnect cancels the wait. |
| wait children | `POST /api/terminal/wait-children` `{parent, mode: "any"|"all", timeoutMs?}` | `any`: next child status change, report or exit; `all`: none working. |
| label | `PATCH …/tabs/:tabId/labels` `{set?: Record<k,v>, remove?: k[]}` | Free-form, never interpreted except reserved `matrix.*` keys. |
| events | `WS /ws/terminal/events` | Snapshot of owner tabs (facts: name, cwd, project, live/finished, exit code, agent status), then ordered `created removed finished status title` events (`labels`, `turn`, `lost` and `restarted` arrive with layer 4). Server heartbeat every 15 s; the client pings at least every 30 s or is evicted after 60 s; above 1 MiB transport backlog the client gets `missed` and then a fresh snapshot. One shared 1 s poll runs only while someone is subscribed. |
| templates | `GET /api/terminal/templates` | `{name, description}` from `~/agents/templates/*.md` |
| run template | `POST …/workspaces/:id/tabs` `{template, task?, parent?, outliveParent?}` | Starts the template's command; sends body + task as first message once ready (≤60 s, settle retries); records `firstMessage {sent, reason?}` durably. |
| put | existing `paste-assets` | Unchanged; documented as `put`. |

CLI: `matrix shell read|send|keys|interrupt|wait|label|get|templates|events`
mirror the routes. MCP: matching tools on the remote-computer server. Kernel:
IPC tools `terminal_run`, `terminal_read`, `terminal_send`, `terminal_wait`,
`terminal_list` (layer 4) calling the same service in-process through
dependency injection, never `globalThis`.

### Status (layer 3)

Per-tab `agentStatus: idle | working | done | blocked | error` plus `turn`
(monotonic counter) and `statusAt`. `done` means finished while nobody was
looking; it becomes `idle` when a viewer acknowledges (existing
`uiState.lastSeenSeq` path). Sources, highest priority first:

1. **Status reporter.** The terminal PATH bootstrap ships `matrix-status
   <word> [message]`. It identifies the pane from `ZELLIJ_SESSION_NAME` +
   `ZELLIJ_PANE_ID` (set by zellij in every pane) and writes
   `~/system/terminal-status/<session>/<pane>.json` atomically. The runtime
   maps session+pane to the tab through `zellijPaneId`, so status is per tab,
   not per zellij session as agent hooks are today.
2. **OSC 7501 tap (opt-in).** Agents launched from templates or the `+` menu
   run under `matrix-osc-tap -- <argv>`, a pass-through PTY that forwards all
   bytes and turns OSC 7501 reports into `matrix-status` writes. This keeps
   Herdr-compatible programs working without patching zellij (spike S1).
3. **Agent hooks.** Existing Claude/Codex/OpenCode/Pi bridges map phases:
   `running → working`, `waiting → blocked`, `completed → done`,
   `started|ended → idle`; `error` from hook failure events.

Plain programs report nothing; `wait` waits for exit, as in Herdr.

### Parent/child (layer 4)

Tabs gain `parentRef?: TerminalRef`, `outliveParent: boolean`. A tab started
with `MATRIX_TERMINAL_REF` in its environment (exported per pane at creation)
records that tab as parent by default. Ending a parent ends non-outliving
children. Child exit, `blocked` or `error` posts a note to the parent with
`send` semantics, tagged `<matrix from="<tabId> <name>">…</matrix>`. A child
report is plain `matrix shell send $MATRIX_TERMINAL_REF "…"`.

### Shell surfaces (layer 5)

One shared derivation (`packages/ui` or `shell/src/lib`) computes roll-up,
attention and agent order from the events stream; Web Canvas, Web Desktop and
Electron Desktop render it with surface chrome only. Attention uses the shared
`ShellNotificationStack`; sounds respect existing notification preferences.

### Electron local terminals (layer 6)

The bundled `hc` already supports everything Herdr does. Layer 6 exposes
command/agent launch, folder, rename (labels), paste/put, find, and status
through the existing local-terminals IPC allowlist, with Zod-validated payloads.
`keep` stays off, as spec 651 decided (isolation variables).

## User Journeys and Acceptance

- **J1 Delegate from a terminal.** In a Matrix terminal, an agent runs
  `matrix shell run --bg --name review reviewer "review src/x.ts"`. Then
  `matrix shell wait --children any` returns when the child is done, and
  `matrix shell read review --lines 100` returns its output. Done when a
  gateway integration test drives create → template first message → status
  `working` → `done` → read, using a fake agent that calls `matrix-status`.
- **J2 Steer a busy agent.** `send` to a `blocked` tab returns 409 unless
  `force`; `interrupt` reports the status observed afterwards.
- **J3 Notice what needs you.** A tab in a background project turns `blocked`.
  Its project and tab show the blocked roll-up, a toast and a sound fire once,
  and opening the tab clears `done` to `idle`. This holds on Web Canvas, Web
  Desktop and Electron Desktop.
- **J4 Kernel orchestration.** Asked in Chat to "run the tests in a terminal
  and tell me", the kernel uses `terminal_run` + `terminal_wait` + `terminal_read`.
- **J5 Electron local parity.** On This Computer, launch Claude in `~/repo` from
  the `+` menu, rename it, paste an image and see its status.

## Security Architecture

### Auth matrix

| Route | Auth | Notes |
|---|---|---|
| `GET/POST/PATCH /api/terminal/workspaces/:w/tabs/:t/{read,send,keys,interrupt,wait,labels}` and `GET …/tabs/:t` | Existing gateway bearer/session principal; `terminalRuntimeOwnerAccess` single owner; preview owner | Chat-bound tabs (`accessScope: chat`) require the chat authorization already used by pane actions; `repository` scope stays denied |
| `POST /api/terminal/wait-children` | Same | `parent` must be a tab the principal can access |
| `GET /api/terminal/templates` | Same | Read-only |
| `WS /ws/terminal/events` | Same principal; query-token allowlist entry for browsers | Filters out chat-bound tabs the principal cannot see |
| `matrix-status` file writes | Unix permissions: owner home, mode 0600 | Gateway treats contents as untrusted input |
| Kernel IPC tools | Kernel process principal = owner | Same service, same validation |

No route is public. No new credentials.

### Input validation

- Path params: `TerminalWorkspaceIdSchema`, `TerminalTabIdSchema`.
- Bodies: `bodyLimit` 16 KiB on every mutating route (send text ≤ 8 KiB);
  Zod strict schemas; key names from a closed enum; labels ≤ 32 pairs, key
  `^[a-z][a-z0-9_.-]{0,62}$`, value ≤ 256 printable chars; `output` match ≤ 256
  chars, treated as a literal (no regex).
- Status files: ≤ 4 KiB, Zod-validated, word from the closed enum, message
  stripped of control/escape sequences (reuse `agent-session-state`
  sanitizer), symlinks refused (`lstat`), session/pane from the path
  regex-checked.
- Template files: frontmatter Zod schema, `command` an argv array (no shell
  string), name `SAFE_SLUG`, ≤ 64 KiB, at most 200 templates.

### Errors

Clients get the existing generic strings (`Terminal operation failed`,
`Invalid request`, `Terminal operation unavailable`) plus stable codes
`terminal_agent_blocked`, `terminal_wait_timeout` (as a 200 result, not an
error), `terminal_capacity_reached`. No paths, zellij output or stack traces.

## Integration Wiring

- `packages/terminal-runtime/src/agent-verbs/` exports `createTerminalAgentVerbs({ runtime, statusSource, clock })`.
- The gateway server builds it where `TerminalRuntime` is built
  (`server/shell-terminal-routes.ts`), passes it to `createTerminalWorkspaceRoutes`
  as an optional `agentVerbs` dependency, and registers it with the event hub
  and kernel IPC at startup. Missing dependency → 503, never 404.
- Shutdown: the event hub drains subscribers first, then waiters resolve with
  `reason: "shutdown"`, then status watchers close, then the runtime shuts down.

## Failure Modes

| Failure | Behavior |
|---|---|
| Tab ends during `wait` | Resolves `exited` with exit code |
| Tab deleted/recreated with same id | Waiters and sends bind to `incarnation`; mismatch → 404 |
| Gateway restart mid-wait | Waiter connection drops; client re-waits (CLI retries once) |
| Status file torn/invalid | Ignored with a log line; last good status kept |
| Reporter in an unknown pane | Ignored |
| Snapshot stale (no observer) | `read` returns `incomplete: true, why: "stale"` with `updatedAt` |
| First message not delivered | `firstMessage {sent:false, reason}` persisted; never blindly resent |
| Event subscriber slow | Bounded queue (512); overflow → `missed` + resnapshot |
| Partition skips WS close | Stale subscriber sweep by `lastTouched` (60 s) |

## Resource Management

- Waiters: ≤ 256 total, ≤ 16 per tab, each with a timer cleared on resolve.
- Event subscribers: ≤ 64, queue ≤ 512 events each, TTL sweep, shutdown drain.
- Output-match buffers: ≤ 64 KiB rolling per waiter.
- Status map: one entry per live tab, evicted with the tab; status dir swept
  for files of ended panes every 10 min (symlink-safe, recurring, timer cleared on shutdown).
- Template cache: ≤ 200 entries, reloaded on mtime change.

## Delivery: one GitHub native stack (6 PRs)

1. `docs(terminal): specify Herdr parity`: this spec, research, tasks.
2. `feat(terminal): add read, send, keys and interrupt verbs`: runtime module, routes, CLI, MCP.
3. `feat(terminal): report agent status, wait and stream events`: status sources, wait, events WS.
4. `feat(terminal): add parent agents, templates and labels`: plus kernel tools and keep-as-shell.
5. `feat(shell): show agent attention across OS views`: roll-up, toasts, agents list (Web Canvas, Web Desktop, Electron Desktop).
6. `feat(desktop): bring local terminals to parity`: Electron local terminals.

Follow-on stack: remote machines and file edit, worktree spaces, mobile inbox.

## Risks

- `send` draft detection needs viewer keystroke timestamps; Web and Electron
  viewers already send input through the gateway, so the runtime records the
  last human input time per tab.
- The OSC tap adds a process per launched agent; it is opt-in and only wraps
  agents Matrix itself launches.
- Status per tab changes what the existing per-session hook state means; layer
  3 keeps the old shape as a compatibility projection.

## Open Questions

1. Should `matrix-status` also accept Herdr's exact `printf` escape when a
   program writes it directly (requires the tap for every tab, not just
   launched agents)? Proposed: no, launched agents only.
2. Template location: `~/agents/templates/` (proposed, next to
   `~/agents/custom/`) or reuse Herdr's `~/.config/herdr-core/templates/`
   so files are shared with an installed Herdr? Proposed: Matrix path, also
   reading the Herdr path read-only when present.

Suggested reviewers: terminal runtime owner (gateway), Electron Desktop owner,
and the kernel owner for J4.
