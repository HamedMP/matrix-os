# Feature Specification: Multi-Device Terminal Efficiency

**Feature Branch**: `codex/terminal-multi-device-spec`
**Created**: 2026-07-13
**Status**: Draft
**Input**: User request: "When a new device joins a terminal session, each device should see the same terminal in its own viewport without resizing the others, terminals should stay fast when several devices are connected, and the session model should be rethought as workspaces (sessions) containing tabs across web, CLI, and mobile."

## Scope Boundary

This spec owns terminal runtime semantics: zellij session/tab topology, the gateway shell WebSocket output pipeline, resize policy across clients, and the persistence model for terminal scrollback. It coordinates with:

- `specs/104-terminal-refactor-foundation/` owns behavior-preserving shell component refactors and explicitly does not change runtime semantics. Implementation work for this spec that touches `TerminalApp.tsx` should land after or rebase onto the 104 extractions where they overlap.
- `specs/056-terminal-upgrade/` defined the current replay/scrollback protocol. This spec changes the persistence write path but keeps the client-facing `output`/`seq`/replay frame contract compatible.
- `specs/075-mobile-shell/` defined the mobile terminal client. This spec changes how mobile participates in session sizing.

Out of scope: true per-client reflow of a shared PTY (impossible at the PTY layer; upstream zellij tracks independent per-client rendering as an open, unimplemented request), VPS capacity/ops changes, and Docker-based dev terminal paths.

## Background and Evidence

Findings from code inspection and live measurement on a production-representative customer VPS (2 vCPU / 4 GB). Full details: `research.md`.

1. **Output is persisted before it is delivered.** `packages/gateway/src/shell/ws.ts` runs `onData -> replayBuffer.writePersistent() -> appendFile -> sendJson(ws)`. Every terminal byte waits on a serialized per-session disk append before the client sees it. Under I/O or memory pressure, full-screen TUIs (codex, vim) that emit large redraw chunks back the queue up by tens of seconds while plain shell typing (tiny output) still feels fast.
2. **Every connected device multiplies persistence writes.** Each WebSocket connection spawns its own `zellij attach` PTY (`packages/gateway/src/shell/zellij.ts`), and each PTY's output stream is separately appended into the same shared per-session scrollback (`buffers.get(safeName)` in `ws.ts`). N devices produce N near-duplicate write streams that interleave in one file, corrupting replay ordering and multiplying disk traffic.
3. **The smallest device resizes everyone.** zellij sizes a shared session to fit all attached clients, so a phone joining shrinks the desktop and CLI views. The only existing mitigation is the client-side `allowRemoteResize={!mobile}` guard in the web shell; the native mobile client and the CLI both send resize unconditionally, and attach PTYs spawn at a hardcoded 120x40.
4. **One zellij server per UI tab.** The web shell creates a separate zellij session (its own server process, ~40-55 MB RSS each) for every terminal tab. Exited sessions accumulate indefinitely in `zellij list-sessions` and `~/system/shell-sessions.json` with no cleanup policy.
5. **No WebSocket backpressure.** Output is written to sockets without checking buffered amounts. A slow consumer (mobile on cellular) buffers unboundedly in gateway memory.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Terminal Echo Is Never Gated on Disk (Priority: P1)

As a user running a full-screen TUI (codex, claude, vim) in an attached terminal, I want keystroke echo and screen updates to stay fluid even when the VPS is under disk or memory pressure, because live output delivery must not wait on scrollback persistence.

**Why this priority**: This is the observed worst failure today: 20-30 second echo latency inside TUIs on a loaded box, making coding agents unusable, while the same session's plain shell feels fine.

**Independent Test**: With scrollback persistence artificially slowed (fault-injected slow store), a TUI generating continuous full-screen redraws must still deliver output frames to the WebSocket within the live-delivery budget, and persistence must catch up asynchronously without data loss within its bounded queue.

**Acceptance Scenarios**:

1. **Given** an attached session with a slow persistence store, **When** the PTY emits a burst of large output chunks, **Then** each chunk is delivered to connected sockets before its persistence write completes.
2. **Given** persistence falls behind live output, **When** the coalescing queue reaches its byte cap, **Then** oldest unpersisted data is dropped from the persistence queue only (never from live delivery), the gap is recorded so replay reports an evicted range, and a warning is logged.
3. **Given** the persistence store throws (disk full, permission), **When** live output continues, **Then** clients keep receiving output, the error is logged server-side once per backoff window, and no raw error reaches the client.

---

### User Story 2 - A Phone Joining Never Shrinks the Desktop (Priority: P1)

As a user with a terminal open on desktop web and CLI, I want to glance at the same session from my phone (native app or PWA) and see the same content fitted to my phone screen, without the desktop or CLI viewport shrinking to phone size.

**Why this priority**: This is the second observed daily pain: every mobile glance reflows and shrinks all other devices, and the session stays wrong-sized after the phone leaves.

**Independent Test**: Attach a desktop web client (e.g. 200x50) and a CLI client (e.g. 190x48), then attach a mobile client (e.g. 60x30). Desktop and CLI cols/rows must not change; the mobile client must render the canonical grid scaled to fit its screen with pan/zoom.

**Acceptance Scenarios**:

1. **Given** a session with a canonical size negotiated from hard clients, **When** a soft client (web mobile viewport, native mobile) attaches, **Then** the session's canonical size is unchanged and every attach PTY remains at the canonical size.
2. **Given** a mobile client viewing a 200x50 canonical grid, **When** content updates, **Then** the mobile renderer shows the full grid scaled to fit width, with pinch-zoom and pan available, and typing works.
3. **Given** only soft clients are attached, **When** the session has no live hard client, **Then** the canonical size falls back to the persisted last canonical size, or the default when none exists.
4. **Given** two hard clients with different sizes, **When** both are attached, **Then** the canonical size is the component-wise minimum of hard-client sizes (a CLI cannot scale its render), and each hard client whose terminal is larger sees the grid anchored top-left.

---

### User Story 3 - Workspaces with Tabs Replace One-Session-per-Tab (Priority: P2)

As a user organizing terminal work, I want a default "main" workspace containing tabs (one per shell/agent), and the ability to create additional named workspaces for projects, so the same model works in web, CLI, and mobile — and each of my devices can focus a different tab of the same workspace.

**Why this priority**: The current one-zellij-session-per-UI-tab model multiplies server processes and memory on small VPSes, fragments session lists, and blocks the per-device-focus benefit zellij's non-mirrored multi-client mode already provides within one session.

**Independent Test**: Create a workspace with three tabs; verify one zellij server process backs all three; attach two clients and verify each can view a different tab concurrently; list workspaces and tabs from web, CLI, and the gateway API with consistent results.

**Acceptance Scenarios**:

1. **Given** a fresh Matrix OS home, **When** the user opens the terminal, **Then** a `main` workspace exists (created on demand) and the first tab opens inside it.
2. **Given** a workspace with tabs, **When** the user adds a terminal tab in the web shell, **Then** a zellij tab is created in the same workspace session instead of a new zellij session.
3. **Given** two devices attached to the same workspace, **When** device A switches to tab 2, **Then** device B's focused tab is unchanged.
4. **Given** existing per-tab legacy sessions from before this change, **When** the user opens the terminal, **Then** exited legacy sessions are converted into `main`-workspace tabs automatically, live legacy sessions remain attachable with a "Move to workspace" affordance (never force-killed), and all new tabs use the workspace model.
5. **Given** the CLI, **When** the user runs `matrix shell ls`, **Then** workspaces are listed with their tabs, and `matrix shell connect -c <workspace>` attaches to the workspace (optionally `--tab <name>`).

---

### User Story 4 - One Persistence Stream per Workspace (Priority: P2)

As a user reconnecting a device, I want scrollback replay to be correct and stored once, regardless of how many devices were attached while output was produced.

**Why this priority**: Today N attached devices append N interleaved copies of the render stream into one scrollback file — write amplification on the exact machines that are memory/IO constrained, plus corrupted replay ordering.

**Independent Test**: Attach three clients to one workspace, generate output, detach all, reconnect one with `fromSeq=0`; replay must contain a single, ordered, non-duplicated stream, and the scrollback file byte volume must be approximately 1x the output volume (not 3x).

**Acceptance Scenarios**:

1. **Given** multiple attached clients, **When** output is produced, **Then** exactly one elected recorder stream is persisted and `seq` numbering is monotonic from that stream only.
2. **Given** the recorder client disconnects, **When** other clients remain attached, **Then** a new recorder is elected and persistence continues with monotonic `seq` (a bounded gap is acceptable and reported via the existing replay-evicted event).
3. **Given** a client reconnects after output occurred with no clients attached (zellij server kept running), **When** it attaches, **Then** the zellij full repaint restores the visible screen even though unwitnessed output was not persisted; the documented persistence guarantee is "output rendered on the recorder's focused tab while a recorder was attached" (see FR-004 for the per-tab scope).

---

### User Story 5 - Bounded Resources Under Many Connections (Priority: P3)

As an operator of a small VPS, I want terminal infrastructure to have caps and cleanup everywhere: slow sockets must not buffer unboundedly, dead sessions must be reaped, and attach counts must be bounded.

**Independent Test**: Simulate a stalled WebSocket consumer and verify PTY flow-control pauses and the socket buffer stays under its cap; burst-create sessions and verify the shared creation rate limiter rejects the burst without introducing a count cap; age exited sessions past the TTL and verify they are deleted from zellij and the registry.

**Acceptance Scenarios**:

1. **Given** a socket whose buffered amount exceeds the high-water mark, **When** more PTY output arrives, **Then** that client's attach PTY is paused (flow control) until the buffer drains below the low-water mark; other clients are unaffected.
2. **Given** exited sessions older than the retention TTL, **When** the periodic sweep runs, **Then** they are deleted from zellij (`delete-session`) and pruned from `~/system/shell-sessions.json`, and their scrollback files are removed.
3. **Given** a workspace at the per-session attach cap, **When** another attach arrives, **Then** the oldest stale attach (no pong within its TTL) is evicted first; if none is stale, the new attach is rejected with a generic error.

### Edge Cases

- A hard client (CLI) attaches with a terminal smaller than the current canonical size: canonical shrinks (min rule) and soft clients re-scale; when that CLI detaches, canonical returns to the min of remaining hard clients.
- Rapid attach/detach loops (mobile network flaps) must not thrash canonical size recomputation; size changes are debounced.
- Resize frames continue to arrive from soft clients (older clients, race windows): the gateway records them as viewport hints but does not apply them to the PTY.
- Workspace and tab names must satisfy the existing `SESSION_NAME_PATTERN`; tab names additionally cap at 64 chars and are validated with Zod at the route boundary.
- `main` is a reserved workspace name; deleting it deletes the session but it is recreated on next terminal open.
- Legacy `/ws/terminal` auto-create (raw bash PTY) path is unchanged and remains deprecated.
- The recorder election must not elect an exited/killed PTY; election runs on attach, detach, and PTY exit.
- Scrollback coalescing flush must run on gateway shutdown (drain) so a restart does not lose the last flush window beyond the documented bound.

## Requirements *(mandatory)*

### Functional Requirements

**Output pipeline**

- **FR-001**: The gateway MUST deliver PTY output to the client WebSocket without awaiting persistence ("send-first"). Sequence numbers MUST be assigned synchronously in memory so the sent frame carries its final `seq`, and MUST be covered by a durable seq reservation: before assigning seqs beyond the current reservation, the gateway persists a high-water reservation covering the next window (default 10,000 seqs), so a crash can never cause a restarted gateway to reissue a `seq` a client already received. On restart, numbering resumes above the persisted reservation and the unpersisted window is reported as a replay-evicted range to `fromSeq` reconnects.
- **FR-002**: Scrollback persistence MUST be asynchronous and coalesced: appends are batched by flush interval (default 250 ms) and byte threshold (default 64 KiB), whichever comes first, with a bounded pending queue (default 4 MiB per session).
- **FR-003**: When the pending persistence queue exceeds its cap, the gateway MUST drop oldest pending data from persistence only, record the evicted seq range, and log a rate-limited warning. Live delivery is never dropped by persistence pressure.
- **FR-004**: Exactly one recorder stream per session MUST feed the replay buffer and scrollback store. Non-recorder client streams are live-delivered only. Persistence therefore captures the recorder's viewpoint (its focused tab): output rendered only on another client's focused tab is live-delivered but not persisted. In-tab history for tabs the recorder is not viewing relies on zellij's own server-side scrollback (available on attach/scroll as today); per-tab persisted scrollback/replay is explicitly out of scope for this spec (see Deferred Scope) and the documented replay guarantee is scoped accordingly.
- **FR-005**: Recorder election MUST be deterministic (oldest live attach), re-run on recorder loss, and MUST keep `seq` monotonic across elections.

**Sizing**

- **FR-006**: Each session MUST have a canonical size (cols x rows) owned by the gateway, persisted in the session registry, defaulting to 200x50 bounded by existing resize limits (cols 1-500, rows 1-200).
- **FR-007**: Clients MUST declare a client class on attach: `hard` (cannot scale its render: CLI/TTY) or `soft` (can scale: web, native mobile). Both WS routes MUST carry this in the attach handshake. A connection without a class declaration (pre-upgrade client on either route) is classified `legacy`, never `hard`: legacy resize frames are applied (today's behavior) only while zero classified clients are attached to the session; once any classified client attaches, legacy clients' resize frames become viewport hints only. This guarantees an un-upgraded phone or browser can never shrink a session that an upgraded client is using, while pure-legacy setups behave exactly as today.
- **FR-008**: Canonical size MUST equal the component-wise minimum across live hard clients' declared sizes; with no hard clients it retains the persisted value (or, in legacy-only sessions, follows legacy resizes per FR-007). Recomputation is debounced (default 500 ms).
- **FR-009**: The gateway MUST resize every attach PTY to the canonical size and MUST ignore (but record as hints) resize frames that did not come from a hard client's own declared-size change.
- **FR-010**: The web shell MUST render soft-client views by scaling the canonical grid to fit the container (font-size fit plus CSS transform fallback), with horizontal pan when scaled below the legibility floor. The `FitAddon`-driven `sendTerminalResize` path is removed for zellij sessions.
- **FR-011**: The native mobile client MUST stop sending resize frames for zellij sessions and MUST render the canonical grid scaled with pinch-zoom/pan.

**Workspaces and tabs**

- **FR-012**: A workspace is exactly one zellij session. The gateway MUST expose workspace CRUD plus tab list/create/rename/close/focus via `/api/terminal` routes, validated with Zod at the boundary, all mutating endpoints behind `bodyLimit`.
- **FR-013**: A `main` workspace MUST be created on demand at first terminal use.
- **FR-014**: The web shell MUST map UI terminal tabs to zellij tabs within the active workspace and provide a workspace switcher. New tabs default into the active workspace; legacy per-tab sessions remain attachable and migrate per FR-021..024.
- **FR-015**: Per-device tab focus MUST be supported: switching tabs on one device does not change another device's focused tab. Mechanism is gated on Spike S1 (see Spikes); if zellij cannot provide per-client focus control programmatically, tab switching falls back to injecting the configured tab-navigation key sequence into that client's own attach PTY.
- **FR-016**: The CLI MUST list workspaces with tabs (`matrix shell ls`), attach to a workspace (`matrix shell connect -c <workspace>`), and optionally select a tab (`--tab <name>`), reusing the existing create-if-missing semantics.

**Migration of existing surfaces (web and CLI)**

- **FR-021**: The gateway MUST classify every registry entry on load: sessions carrying workspace metadata are `workspace`; all others are `legacy`. Legacy sessions remain listable and attachable through both WS routes for the life of this feature; no data is dropped.
- **FR-022**: The gateway MUST provide an idempotent migration operation (`POST /api/terminal/workspaces/migrate`) that converts legacy sessions into workspace tabs: for each exited or idle legacy session (no attached clients), create a tab in the target workspace with the same working directory and display name, seed the tab's scrollback reference from the legacy session's scrollback file, then delete the legacy zellij session and prune its registry entry. Live legacy sessions (attached clients or running foreground processes) are reported as skipped, never force-killed — a running process cannot be moved between zellij sessions.
- **FR-023**: The web shell MUST migrate automatically and visibly: on first load with workspace support, persisted UI tabs that reference exited legacy sessions are recreated as `main`-workspace tabs via FR-022; UI tabs on live legacy sessions keep working unchanged and display a per-tab "Move to workspace" affordance that runs the same migration for that session once it is idle. All new tabs are created as workspace tabs from the first workspace-aware release.
- **FR-024**: The CLI MUST resolve names across both models: `matrix shell connect -c <name>` matches a workspace first, then a legacy session, and prints a one-line notice when attaching to a legacy session (`legacy session; run 'matrix shell migrate' to convert`). `matrix shell ls` labels each entry `workspace` or `legacy`, and `matrix shell migrate [name]` invokes FR-022. `matrix run -it` creates its command surface as a tab in the target workspace (default `main`) instead of a new `run-*` session, keeping the existing `--session` flag as a workspace selector.

**Resource management**

- **FR-017**: WS output delivery MUST implement flow control: when a socket's buffered amount exceeds the high-water mark (default 1 MiB), that client's attach PTY is paused; resumed below the low-water mark (default 256 KiB).
- **FR-018**: Exited sessions MUST be reaped by a periodic sweep (default: exited > 7 days), deleting the zellij session, pruning the registry entry, and removing scrollback files. The sweep MUST be symlink-safe and its timer cleared on shutdown.
- **FR-019**: Live attaches per session MUST be capped (default 8) with stale-attach eviction before rejection. Workspace/session creation stays rate-limited through the existing shared creation rate limiter (`SHELL_SESSION_CREATE_RATE_LIMIT`) plus TTL reaping (FR-018); no hard maximum session count is introduced (shell guidance: creation is rate-limited, not count-capped).
- **FR-020**: Recorder attach PTYs and replay buffers MUST be reaped after all clients detach plus an idle TTL (default 10 minutes); the existing `ReplayBufferCache` `maxBuffers` cap remains.

### Non-Functional Requirements

- **NFR-001**: On a 2 vCPU / 4 GB reference VPS with persistence enabled, p95 live output frame delivery latency (PTY read to WS write) MUST stay under 50 ms while a TUI emits continuous full-screen redraws.
- **NFR-002**: Scrollback write volume with N attached clients MUST be ~1x the recorder stream volume (was ~Nx).
- **NFR-003**: A soft client attaching or detaching MUST cause zero cols/rows change for other clients.
- **NFR-004**: k terminal tabs in one workspace MUST run one zellij server process (was k), holding steady-state RSS for the terminal subsystem roughly flat as tabs grow.

## Security Architecture

- **Auth matrix**: unchanged. Both WS routes keep their existing token auth including the browser query-token allowlist path; workspace/tab REST routes inherit the existing `/api/terminal` auth. No new principals.
- **Input validation**: all new route params/bodies (workspace name, tab name, client class, declared size) validated with Zod at the route boundary; names via `SESSION_NAME_PATTERN`; sizes clamped to existing bounds; per-action payload schemas as discriminated unions, no generic records.
- **Error policy**: no raw errors, filesystem paths, or zellij stderr to clients; generic codes (`attach_failed`, `workspace_limit`, `invalid_message`) with server-side logging. Misconfiguration (missing home, missing zellij binary) returns generic 5xx, never 404.
- **WS frames**: new/changed frame types (`attach` metadata, `viewport-hint`) get bounded Zod schemas validated after JSON parse, consistent with existing frame handling.

## Integration Wiring

- **Startup**: gateway boots as today; the reaper sweep and coalescing flush timers are created in gateway startup and disposed in the shutdown drain path alongside existing WS shutdown handling.
- **Registry migration**: `~/system/shell-sessions.json` — the zellij `ShellRegistry` persist file (`packages/gateway/src/shell/registry.ts`) — gains optional fields (`kind: "workspace" | "legacy"`, `canonicalSize`, `tabs`). Old files load unchanged (fields optional, defaults applied); no schema-version break. Writes remain atomic via the existing atomic-write helper. This file is distinct from `~/system/terminal-sessions.json`, which belongs to the deprecated raw-PTY `SessionRegistry` (`packages/gateway/src/session-registry.ts`); that registry and file are untouched by this spec, and workspace metadata, canonical sizes, and reaper state live exclusively in `shell-sessions.json`.
- **Cross-surface sync**: web shell (`TerminalApp`/`PaneGrid`/`TerminalPane`), CLI (`shell.ts`, `shell-client.ts`), native mobile (`terminal-client.ts`), and gateway must ship the attach-metadata change compatibly: the gateway treats missing client-class metadata with the FR-007 defaults so old clients keep working.
- **Zellij config**: shipped config stays chrome-free; tab-navigation keybinds used by FR-015 fallback are pinned in the generated `config.kdl` so injection sequences are deterministic.

## Failure Modes

- **Persistence store failure**: live output unaffected (FR-001/003); persistence retries with backoff; replay reports evicted ranges.
- **Recorder PTY dies**: re-election on next output or attach event; bounded seq gap surfaced as replay-evicted.
- **zellij server crash**: existing exited-session handling applies; registry reconciliation via `list()` marks it exited; clients get the existing `exit` frame.
- **Slow/dead client**: flow control pauses only that client's PTY; existing stale-attach eviction (FR-019) removes it; other clients unaffected (per-subscriber isolation).
- **Gateway shutdown**: drain notifies clients, flushes the coalescing buffer, disposes timers, then kills attach PTYs; zellij servers keep running (sessions survive restarts as today).
- **Concurrent size changes**: canonical size recomputation is debounced and serialized per session; last committed value wins; PTY resizes are idempotent.
- **Crash between seq assignment and persistence**: bounded loss window equals the coalescing flush interval; the durable seq reservation (FR-001) guarantees restarted numbering never reuses a delivered seq, and the lost window is reported to reconnects as replay-evicted.

## Resource Management

- Per-session pending persistence queue: 4 MiB cap, drop-oldest (FR-003).
- Per-socket buffered output: 1 MiB high-water flow control (FR-017).
- Attach cap 8/session with stale eviction; session creation rate-limited (no count cap); replay buffer cache caps unchanged (FR-019/020).
- Exited-session TTL sweep 7 days, symlink-safe, periodic, timer cleared on shutdown (FR-018).
- Scrollback files: existing compaction retained; deleted with their session by the sweep.

## Rollout Phasing

1. **Phase 1 — output pipeline (gateway only)**: send-first delivery, recorder election, coalesced persistence, WS flow control, exited-session reaper. No client changes; largest latency and write-amplification win; independently shippable.
2. **Phase 2 — canonical sizing**: attach metadata + canonical size arbiter in gateway; web scaled rendering; mobile stops resizing; CLI declares hard size. Shippable behind compatible defaults.
3. **Phase 3 — workspaces/tabs with migration**: gateway tab routes hardening plus the FR-022 migration operation, web workspace/tab UI with automatic legacy conversion (FR-023), CLI workspace resolution, labeling, `migrate`, and `run -it` tab targeting (FR-024). Depends on Spike S1. Mobile and desktop surfaces adopt the same gateway contract in follow-up work coordinated against their in-flight PRs.

## Spikes (throwaway code before Phase 2/3 implementation)

- **S1 (blocks FR-015)**: verify per-client tab focus in zellij 0.44.1 non-mirrored multi-client sessions, and determine the programmatic control mechanism (CLI action vs keybind injection into a specific attach PTY). Verify `zellij action go-to-tab` client targeting behavior.
- **S2 (blocks FR-008/009)**: confirm that pinning every attach PTY to an identical size yields a stable session grid at exactly that size in zellij 0.44.1 (no shrink events), including across attach/detach churn.
- **S3 (blocks FR-017)**: confirm node-pty pause/resume (or `handleFlowControl`) behaves correctly against a `zellij attach` child (no dropped bytes, no deadlock on resume).

## Success Criteria

- **SC-001**: TUI echo latency: p95 live-delivery under 50 ms on the reference VPS under continuous redraw load with persistence enabled (was multi-second to tens of seconds under pressure).
- **SC-002**: Phone attach causes zero resize on desktop/CLI (was: every attach reflowed all devices).
- **SC-003**: Scrollback bytes written with 3 clients ≈ bytes with 1 client (was ~3x), and replay after reconnect is ordered and duplicate-free.
- **SC-004**: One zellij server per workspace regardless of tab count; exited sessions older than TTL no longer appear in `zellij list-sessions`.
- **SC-005**: A stalled WS consumer caps gateway memory growth at the flow-control high-water mark instead of unbounded buffering.

## Deferred Scope

- True per-client reflow of one PTY (upstream zellij limitation; revisit if zellij ships independent per-client rendering).
- Per-tab persisted scrollback/replay: the recorder persists its focused-tab viewpoint (FR-004); history for other tabs comes from zellij's own server-side scrollback. Persisting every tab's stream would require one recorder attach per tab and is deferred until per-device tab focus (Spike S1) proves out.
- Workspace-level layout persistence beyond zellij's own (`~/system/layouts/*.kdl` flows unchanged).
- Desktop (Electron/macOS) and native mobile workspace UI: both consume the same gateway contract, but their migration lands as follow-up work coordinated against those surfaces' in-flight PRs (web and CLI migrate in Phase 3 per FR-021..024).
- Force-migrating live legacy sessions with running foreground processes (impossible to move between zellij sessions; they migrate when idle or exit).
