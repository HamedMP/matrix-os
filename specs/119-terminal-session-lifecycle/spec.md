# Terminal Session Lifecycle

## Problem

Deleting a shell session can leave three independent kinds of state behind: a saved Terminal window layout, a user-systemd runtime descriptor, and an exited/resurrectable Zellij session. A later Terminal mount can then interpret the saved name as a request to create a new shell, making a session the user deleted appear to return. Multiple Terminal windows also overwrite one global layout, so stale windows can restore or repersist another window's tabs.

## Goals

- A confirmed session deletion is authoritative and cannot be undone by layout restoration.
- A missing runtime caused by interruption is shown as recoverable but is never recreated without a user action.
- Closing an ordinary Terminal window detaches from durable shells; closing a tab or deleting a shell keeps the existing explicit semantics.
- Each ordinary Terminal window owns an independent, stable, revisioned layout.
- Agent sign-in/setup terminals are ephemeral and never enter ordinary durable layout restoration.
- Exited unreferenced `matrix-rt_*` sessions are removed from Zellij and never listed as live.

## Non-goals

- Reserving or automatically creating a `main` session.
- Changing workspace-agent `matrix-sess_*` ownership.
- Restoring legacy UUID PTYs after a gateway restart.
- Merging or deleting a user's independent Terminal window layouts.

## Source of truth and invariants

1. `shell-sessions.json` is authoritative for durable shell identity.
2. `system/terminal-window-layouts.json` is the owner-controlled, revisioned source of truth for ordinary Terminal window layouts and bounded deletion tombstones.
3. A layout reference is never authority to create a runtime.
4. Runtime descriptors map durable shell names to internal `matrix-rt_*` Zellij names; only descriptors whose exact user unit is active are live.
5. Deletion removes the runtime, exact raw Zellij session, registry record, aliases/references, and every persisted layout reference before success is reported. A failure after runtime deletion returns an error and remains idempotently retryable.
6. A 30-day tombstone (maximum 256, oldest evicted) prevents stale layout writes from restoring a deliberately deleted name. Explicit creation or recovery of the same valid name clears its tombstone.
7. Ordinary outer-window close does not delete durable sessions. Setup windows explicitly opt out of persistence and delete their temporary session when closed.

## User experience

- A new Terminal with no sessions shows the existing empty state and **New Shell** action. It creates nothing until the action is used.
- A saved tab whose runtime is unexpectedly absent shows its label and a recoverable placeholder with **Recover session** and **Close tab** actions.
- Recovering creates exactly one new runtime incarnation for the saved name and reconnects that pane.
- A deliberately deleted session is silently removed from stale layouts rather than offered for recovery.
- Each Terminal window restores only its own tabs, active tab, sidebar state, and pane tree.

## API contract

All routes use the existing authenticated VPS gateway boundary. No route is public.

| Route | Method | Authentication | Validation | Result |
|---|---|---|---|---|
| `/api/terminal/window-layouts/:layoutId` | GET | Existing gateway session/JWT | `layoutId`: `term-layout_` plus 32 lowercase hex chars | Returns `{ layoutId, revision, layout }`; missing returns an empty revision-0 layout |
| `/api/terminal/window-layouts/:layoutId` | PUT | Existing gateway session/JWT | 100 KB body limit; strict bounded layout schema; exact `baseRevision` | Atomically writes the next revision, or returns `409 layout_revision_conflict` |
| `/api/terminal/window-layouts/:layoutId` | DELETE | Existing gateway session/JWT | 512-byte body limit; validated ID | Deletes only that visual layout; shells remain durable |
| `/api/terminal/sessions/:name/recover` | POST | Existing gateway session/JWT | 1 KB body limit; existing safe session-name schema; optional bounded relative cwd | Explicitly creates one missing recoverable runtime and clears its tombstone |
| `/api/terminal/sessions/:name` | DELETE | Existing gateway session/JWT | Existing validation/body limit | Performs authoritative cross-store deletion |

`window-layouts` is deliberately distinct from the existing `/api/terminal/layouts/:name` KDL-layout API. The legacy `/api/terminal/layout` endpoint remains read-compatible for migration but must not be used by new Terminal windows.

## Security architecture

- Route parameters and bodies are parsed with strict Zod 4 schemas before filesystem access.
- Layout paths are derived only from validated IDs under the fixed owner-controlled layout directory.
- Mutating endpoints use Hono `bodyLimit` before body parsing.
- Persistent JSON uses exclusive temporary files plus atomic rename; no synchronous filesystem calls occur in request handlers.
- Client responses use stable error codes and generic messages. Detailed filesystem, systemd, and Zellij errors remain server-side.
- Layout tab/pane/session counts and string lengths are bounded to prevent owner-state amplification.
- Existing gateway authentication and per-VPS owner isolation remain the auth source of truth.

## Concurrency and failure modes

- Layout PUT enforces optimistic concurrency in the atomic mutation under the per-layout lock. On conflict, the client keeps its local layout visible and offers/retries an explicit refresh; it never silently replaces local tabs.
- Runtime/registry deletion and layout reconciliation use their respective bounded mutation locks. If runtime deletion fails, the registry record and tombstone are not committed, leaving the delete retryable.
- Once runtime deletion succeeds, the layout tombstone is committed before success is returned. A crash or layout-write failure in between returns an error; repeating forced deletion completes the idempotent tombstone/layout cleanup even when the runtime is already absent.
- Zellij exit code 2 during exact deletion means the session is already absent and is accepted. Other failures retain the descriptor for retry.
- Invalid/corrupt layout state fails closed with a generic server error, preserves the owner's file without overwriting it, and produces a structured server log without exposing paths.
- A recover request is idempotent: an already-live name returns its active session; concurrent recovery resolves through the registry mutation lock.

## Resource management

- Tombstones: maximum 256, 30-day TTL, pruned during registry reads and writes.
- Layout state: maximum 64 ordinary Terminal layouts in one atomic owner-controlled file; the oldest layout is evicted first. Setup terminals create no layout record.
- Layouts: maximum 32 tabs, 64 panes, 128-character labels, and 4,096-character cwd values within the 100 KB route limit.
- Runtime descriptor listing remains capped at 256.
- Orphan sweep runs at startup and every 15 minutes, checks at most 32 `matrix-rt_*` candidates per pass, skips descriptor-backed runtimes, and clears its timer on shutdown.

## Integration wiring

1. Desktop and Canvas window creation assign a stable `terminalLayoutId` to ordinary Terminal windows and persist it with window state.
2. Both renderers pass the ID into `TerminalApp`; setup/login renderers pass `persistence="ephemeral"`.
3. `TerminalApp` reads and writes only its ID-scoped layout and never POSTs while restoring.
4. The gateway layout store reconciles tombstoned session IDs on every read and write.
5. The shell registry deletion path calls the user-systemd adapter, writes its tombstone, and invokes the layout store to remove all matching pane references.
6. Runtime deletion stops the exact unit, executes generation-pinned `zellij delete-session <matrix-rt_* session> --force`, then removes descriptor assets.
7. Gateway startup and shutdown own the bounded orphan-sweep timer.

## Observability

Emit structured lifecycle events with no raw command output or owner paths:

- `terminal.session.delete.requested|completed|failed`
- `terminal.session.recover.requested|completed|failed`
- `terminal.layout.read|write|conflict|reconciled`
- `terminal.runtime.orphan.detected|deleted|failed`

Fields are bounded identifiers, revision numbers, reason codes, and counts.

## Test strategy

- Unit: tombstone TTL/cap, layout schema, deletion reconciliation, revision conflicts, exited Zellij filtering, runtime purge ordering/failure retention.
- Gateway integration: create → persist in two layouts → delete → both reads omit the name → remount performs no create; recover missing non-tombstoned name explicitly.
- React: saved missing sessions cause zero POSTs; recover button causes one recover request; deleted names disappear; two Terminal windows use distinct layout endpoints; setup windows do not load/save layouts.
- End-to-end: Canvas first, then Desktop—create two windows, delete a shell, reload both, confirm it does not return; exercise Codex sign-in and confirm no durable setup tab remains.

## Documentation and rollout

- Publish a separate `FinnaAI/matrix-os-site` documentation PR describing durable sessions, window close versus shell delete, recovery, and setup-terminal behavior.
- Ship through the VPS-native host bundle channel, deploy to a disposable test VPS first, then deploy the exact verified bundle to `@nima`.
- Before deployment, capture counts from registry, layouts, descriptors, active units, and raw Zellij. After deployment, verify deleted names remain absent across reload and orphan counts converge to zero.

## Visual evidence

- [Canvas recoverable session](evidence/canvas-recoverable-session.png): a saved missing shell renders an explicit recovery action and does not attach or create a session.
- [Desktop empty Terminal](evidence/desktop-empty-terminal.png): an empty durable Terminal stays empty until **New shell** is selected.
