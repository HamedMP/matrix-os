# ENG-294: terminal viewer recovery

Scope: repair the proven stale-viewer invalidation and snapshot/live admission
gap. The exact customer incident remains unverified without the client's and
host's release IDs, terminal reference/incarnation and frame trace. Exclude
ENG-293, #2599, process restart/recreation and terminal redesign.

## Contract

- Expiring a viewer removes its subscription and disconnects its transport.
  A captured viewer handle cannot renew a replacement with the same viewer ID
  or acknowledge a heartbeat after eviction.
- Send `attached` before native admission so startup input queues at the socket
  boundary and a slow native attachment cannot stall the client (the existing
  startup-input contract). Admit the live subscriber before reading the replay
  baseline. Buffer output while that read is pending, then send replay-start/
  snapshot/replay-end before draining each buffered output chunk once in order;
  `replay-end` carries the admitted cursor.
- Snapshots replace the rendered presentation; Zellij output is a screen
  presentation stream, not an append-only stdout log. This repair does not
  invent a global equivalence between snapshot and per-connection counters.
- Preserve workspace/tab incarnation and Zellij pane. UI detach never kills
  the owner's command. Preserve existing owner authorization and mutation gates.

## Boundaries and failure handling

Startup wiring is unchanged. `packages/terminal-runtime/src/service.ts:main`
resolves the owner home/socket, checks the user-systemd controller installation,
constructs the Zellij adapter, initializes config and completes migration. It
then creates `TerminalRuntime` with `new TerminalWorkspaceStore({ homePath })`,
the adapter and bounded limits; awaits `runtime.restoreAll()`; creates
`TerminalRuntimeSocketServer({ socketPath, runtime })`; and awaits `server.start()`
before starting the orphan sweeper (`service.ts:98–105`). Shutdown closes the
socket server and orphan sweeper before draining the runtime.

`packages/gateway/src/server.ts` creates `TerminalRuntimeSocketClient` for the
configured socket and injects it into `registerTerminalWebSocketRoutes`.
The browser's authenticated `/ws/terminal/tab` route authorizes owner/runtime,
Chat and live-ownership access before calling that client's `attach`. The
owner-only Unix server opens the handshake, admits the runtime viewer, buffers its
output, reads the snapshot, sends replay framing, then drains the handoff. Gateway frame
forwarding and close propagation remain unchanged. Lifecycle tests construct
the same store/runtime/server/client path over a native Unix socket with a
deterministic Zellij adapter; that test transport is not production startup
evidence.

| Boundary | Authorization / validation |
| --- | --- |
| Browser `/ws/terminal/tab` | Existing gateway request principal, runtime owner access, Chat binding/token and live-ownership checks remain unchanged |
| Runtime Unix socket | Existing owner-only directory/socket permissions, bounded protocol schema and exact terminal reference checks |
| Snapshot reads | Existing expected-incarnation checks remain authoritative |

The output handoff holds at most 1 MiB and 256 chunks. Copies prevent upstream
buffer reuse changing pending output. Overflow or delivery failure closes the
transport; callers receive the existing generic failure path. Socket close
discards pending output and detaches any admitted viewer. Snapshot-read failure
detaches the viewer and discards the queue. Output/size/input and shutdown paths
retain existing ownership, queue limits, timeout and drain behavior.

Runtime workspace mutations remain serialized by the existing queue. Snapshot
I/O happens after admission without holding an additional lock across network
I/O. Stale viewer notification failures are isolated and logged, so eviction
does not silently renew a broken subscription.

## Validation and remaining evidence

The tests first failed for an evicted viewer still receiving pong and numbered
gap markers missing while later live output continued. Require those lifecycle
regressions plus bounded handoff, socket protocol, viewer isolation, attachment
bootstrap and runtime suites to pass. Derive persisted incarnation through the
canonical helper, not an absent internal-store field.

The lifecycle regressions run over a native Unix socket on a Linux host with the
production runtime, protocol/framing, decoder and store unchanged, and the same
tests fail against the pre-fix code. `tests/e2e/terminal-reattach-output.e2e.test.ts`
drives a real xterm renderer in Chromium through the real socket server and
client: the expired viewer's transport closes, the same tab reattaches from its
last cursor, the checkpointed screen is restored and live output continues on the
same Zellij pane. Real process PID retention and the live Web Canvas, Web Desktop,
Electron Desktop and mobile surfaces remain unqualified. Validate them separately
on a reviewed runtime and record exact releases, output/heartbeat frames, process
identity and screenshots/recordings before closing ENG-294.

## Delivery plan

1. Red lifecycle regressions; Green invalidation and handoff; focused helper tests.
2. Extract handoff resource ownership into `output-handoff.ts`, keeping the large
   runtime entrypoint's edits limited to invalidation/handle checks.
3. Recommend terminal/runtime owner review of the recovery boundary.
4. Follow-up public documentation PR in `FinnaAI/matrix-os-site/content/docs/`
   describing validated terminal recovery once release/surface evidence exists.
5. Current-head Greptile 5/5, then `ready-for-ci` and label-triggered CI. No merge
   is authorized. Missing native/surface evidence remains explicit.
