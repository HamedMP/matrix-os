# Research: Multi-Device Terminal Efficiency

Investigation date: 2026-07-13. Sources: code inspection of the gateway shell stack, live measurement on a production-representative customer VPS (2 vCPU / 4 GB, zellij 0.44.1), and upstream zellij issue tracker review. No customer-identifying details are recorded here.

## R1: Output is persisted before delivery (root cause of TUI latency)

`packages/gateway/src/shell/ws.ts` wires PTY output as:

```
onData -> outputCompat.write -> replayBuffer.writePersistent(data)
       -> (await serialized queue -> scrollbackStore.append -> appendFile)
       -> .then(() => sendJson(ws, { type: "output", seq, data }))
```

`ShellReplayBuffer.writePersistent` (`replay-buffer.ts`) chains every chunk through a serialized `persistentQueue` promise, and `ScrollbackStore.append` (`scrollback-store.ts`) issues an `appendFile` per call. The WebSocket send happens only after the disk append resolves.

Consequence: live echo latency is coupled to disk latency. Full-screen TUIs (codex, claude, vim) emit large, frequent redraw chunks; under I/O or memory pressure the serialized queue backs up and echo lags by tens of seconds, while plain shell typing (tiny chunks, empty queue) stays fast. This exactly matches observed production behavior (interactive shell fine, codex TUI 20-30 s).

**Decision**: send-first delivery; persistence becomes async + coalesced (spec FR-001..003).

## R2: Per-client attach multiplies persistence writes and corrupts replay ordering

Every WS connection spawns its own `zellij attach <name>` node-pty child (`zellij.ts`, `attachProcess`, hardcoded 120x40). The replay buffer is shared per session name (`buffers.get(safeName)`, `ws.ts`), so with N devices attached, N near-duplicate render streams are appended into one scrollback file with interleaved seq assignment.

Effects: ~Nx disk write amplification on the smallest, most loaded machines; replay after reconnect interleaves different clients' render streams (their bytes differ when sizes or focus differ), producing duplicated/garbled restore output.

**Decision**: exactly one elected recorder stream persists per session (spec FR-004/005).

## R3: zellij sizing — smallest attached client wins; per-client viewports are not supported upstream

zellij sizes a shared session to fit all attached clients; a phone attaching shrinks desktop and CLI views. Independent per-client rendering is an open, unimplemented upstream feature request:

- zellij-org/zellij issue #4253 "Independent Per-Client Layout Rendering in Shared Sessions" (open, no maintainer commitment as of 2026-07)
- Discussions #3816, #5066, #3124 describe the same multi-device pain and confirm no built-in workaround beyond separate sessions or read-only mirrors.

This is a PTY-layer constraint, not a zellij bug: a PTY has one size and the foreground app lays out to that grid; no multiplexer (tmux included) renders one pane at two sizes simultaneously.

Existing partial mitigation in-repo: web shell passes `allowRemoteResize={!mobile}` (`TerminalApp.tsx`) so mobile-web viewports skip sending resize — but the native mobile client (`apps/mobile/lib/terminal-client.ts`) and the CLI (`shell-client.ts`, SIGWINCH) still send resize unconditionally, and attach PTYs spawn at 120x40 regardless, so the guard is incomplete.

**Decision**: gateway-owned canonical size; hard clients (CLI/TTY, cannot scale their render) negotiate via component-wise min; soft clients (web, native mobile) render the canonical grid scaled client-side with pan/zoom and never influence size (spec FR-006..011). Client-side scaling is the only physically possible version of "same terminal, own viewport", and is the approach used by mature mobile SSH clients.

## R4: Live measurement — zellij multi-client cost is small; host pressure dominates

Controlled test on the reference VPS (throwaway session, continuous output loop, clients attached at 200x50 / 80x24 / 120x40 via `script`-allocated PTYs):

- zellij server process: ~4-7% of one core under continuous output; going from 1 to 3 attached clients raised server CPU only modestly; each attach client process stayed at ~0-3%.
- Host, however, was under severe memory pressure during the same window: `kswapd0` at 77-82% CPU, 0% idle, D-state processes; SSH temporarily failed banner exchange.
- Kernel log confirmed an OOM kill of a ~710 MB anon-RSS node child inside the gateway service cgroup; the box has **no swap configured**. Service restarts earlier in the window were deploy SIGTERMs, not crashes.

Interpretation: perceived "zellij lag with many connections" is primarily (a) the persist-before-send pipeline of R1 amplified by the duplicate writes of R2, and (b) whole-host memory pressure — not zellij render fan-out. The spec therefore prioritizes the output pipeline (Phase 1) over any zellij replacement.

Ops follow-ups (out of spec scope, tracked separately): add swap/zram and per-service memory limits on customer VPSes; investigate the large gateway child process footprint.

## R5: One zellij server per UI tab wastes memory; workspaces map cleanly onto zellij

The web shell creates a separate zellij session per UI terminal tab (`TerminalApp.tsx` `addTab` -> `POST /api/terminal/sessions`). Each zellij server process measured ~40-55 MB RSS. Sessions also accumulate: the reference VPS listed 5 exited sessions dating back 10+ days ("attach to resurrect"), never reaped, alongside a growing `~/system/shell-sessions.json`.

zellij natively supports tabs within a session, and the gateway already exposes `listTabs`/`createTab` (`zellij.ts`) and `/api/terminal/sessions/:name/tabs` (`routes.ts`) — currently unused by the web shell. zellij's non-mirrored multi-client mode (default; shipped config does not set `mirror_session`) gives each attached client its own focus, which is the basis for per-device tab focus.

**Decision**: workspaces (user-facing name) = zellij sessions; tabs = zellij tabs; default `main` workspace; legacy per-tab sessions stay attachable (spec FR-012..016). Open verification items are captured as spikes S1/S2 in the spec because per-client focus control and uniform-size pinning behavior are undocumented (repo rule: spike before build for undocumented zellij/SDK behavior).

## R6: No WS backpressure; unbounded socket buffering

`sendJson` writes to sockets without consulting buffered amounts; a stalled consumer (mobile on cellular, laptop lid close) makes the gateway buffer PTY output unboundedly in memory — exactly the resource pattern CLAUDE.md bans for Maps/Sets, applied to sockets. node-pty supports pause/resume flow control; verification against a `zellij attach` child is spike S3.

**Decision**: high/low-water flow control per socket, pausing only that client's attach PTY (spec FR-017).

## Alternatives considered

- **Single gateway-held attach per session, broadcast to all sockets** (the legacy raw-PTY model): removes per-client attach processes and gives one persistence stream for free, but forces full mirroring — every device sees the same tab and focus — defeating per-device tab focus, and makes canonical sizing mandatory rather than negotiated. Rejected as the default; revisit if spike S1 fails.
- **Replace zellij with tmux**: tmux has the same shared-size constraint (`window-size smallest/latest`), would discard the shipped zellij config/layout/session tooling from spec 068, and offers no per-client rendering either. Rejected.
- **Client-side terminal emulator in the CLI** (render canonical grid scaled in a TUI): would let the CLI become a soft client, but is a large new surface; deferred.
- **Immediate resize-follow (status quo) with faster rendering**: does not fix any of R1/R2/R3. Rejected.
