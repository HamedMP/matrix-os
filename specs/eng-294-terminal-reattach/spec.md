# ENG-294: terminal viewer recovery

Scope: repair the proven stale-viewer invalidation and snapshot/live admission
gap. The exact customer incident remains unverified without the client's and
host's release IDs, terminal reference/incarnation and frame trace. Exclude
ENG-293, #2599, process restart/recreation and terminal redesign.

## Contract

- Expiring a viewer removes its subscription and disconnects its transport.
  A captured viewer handle cannot renew a replacement with the same viewer ID
  or acknowledge a heartbeat after eviction.
- Admit the live subscriber before obtaining the handshake snapshot. Buffer
  output while the snapshot read is pending, then send attached/replay/snapshot/
  replay-end before draining each buffered output chunk once in order.
- Snapshots replace the rendered presentation; Zellij output is a screen
  presentation stream, not an append-only stdout log. This repair does not
  invent a global equivalence between snapshot and per-connection counters.
- Preserve workspace/tab incarnation and Zellij pane. UI detach never kills
  the owner's command. Preserve existing owner authorization and mutation gates.

## Boundaries and failure handling

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

Local sandbox execution substitutes only the OS socket transport; production
runtime, protocol/framing, decoder and store execute unchanged. Native Unix
socket binding, real process PID retention and live surfaces remain unqualified.
Validate Web Canvas, Web Desktop and Electron Desktop separately, plus mobile
where applicable, on a reviewed runtime. Record exact releases, output/heartbeat
frames, process identity and screenshots/recordings before closing ENG-294.

## Delivery plan

1. Red lifecycle regressions; Green invalidation and handoff; focused helper tests.
2. Extract handoff resource ownership into `output-handoff.ts`, keeping the large
   runtime entrypoint's edits limited to invalidation/handle checks.
3. Recommend terminal/runtime owner review of the recovery boundary.
4. Follow-up public documentation PR in `FinnaAI/matrix-os-site/content/docs/`
   describing validated terminal recovery once release/surface evidence exists.
5. Current-head Greptile 5/5, then `ready-for-ci` and label-triggered CI. No merge
   is authorized. Missing native/surface evidence remains explicit.
