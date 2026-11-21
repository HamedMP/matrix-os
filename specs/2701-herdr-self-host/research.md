# 2701 research · herdr-app and herdr-core

Read-only study of `herdrdev/herdr-app` and `herdrdev/herdr-core` (shallow
clones, nothing built or run), compared with Matrix `origin/main`. H =
`herdr-app/src`, C = `herdr-core/crates/herdr-core/src`. Nothing here was
measured; impact is estimated.

## Why Herdr feels fast

Herdr is a native Rust app on GPUI (Zed's GPU framework) with libghostty-vt
for terminal state (`herdr-app/Cargo.toml:21-24`, `H/vt.rs:1-2`). Matrix
Electron uses xterm.js with WebGL. We will not copy the renderer; these are the
techniques that transfer.

| # | Technique | Herdr | Matrix today | Impact |
| --- | --- | --- | --- | --- |
| 1 | Keep every open tab attached and its terminal alive; draw only visible ones | `H/window.rs:1567-1568`; hidden output updates state without redraw `H/terminal.rs:637-640` | One `<TerminalView key={sessionName}>` (`TerminalWindowApp.tsx:289,430`); one live socket app-wide, detach on switch (`attach-manager.ts:1-4,74`). Each switch rebuilds xterm + WebGL, writes a snapshot, re-attaches | High |
| 2 | On attach, start from an empty screen and let the core repaint (screen, then history) | `H/terminal.rs:387-390`; core paint `C/viewers.rs:485-506` | Writes its own serialized snapshot (`TerminalView.tsx:461-462`) and then attaches with `history: 2000` (`hc-client.ts:158`). Core paint clears with `ESC[2J` but not `ESC[3J`, so scrollback is likely duplicated and the screen painted twice (inferred, not observed) | High, likely bug |
| 3 | Time-budgeted parsing (6 ms turns, 250 ms first paint) and one shared ~30 fps redraw clock, immediate redraw within 200 ms of a keystroke, skip redraw when nothing visible changed | `H/terminal.rs:24-45,436-455,621-641`, `H/vt.rs:1645-1656` | xterm's own scheduling; credit returned after write callback (`local-terminal-socket.ts:70-84`, good) | Medium |
| 4 | Fewer hops for bytes | socket → parser in one process, binary frames | socket → main framing → UTF-8 decode to string in 256K-char slices (`hc-sessions.ts:192-199`) → IPC per slice → xterm; one `invoke` per input chunk (`local-terminal-socket.ts:110-120`); `Buffer.concat` per read (`hc-protocol.ts:37`) | Medium |
| 5 | Send display FACTS (colors, cell size) and FOCUS frames | `H/hc.rs:516-548` | Defines FOCUS but never sends it; no FACTS (`hc-protocol.ts:4`) | Low for speed, matters for color queries and focus-aware apps |
| 6 | Coalesced resize | core replaces queued output with one repaint (`C/wire.rs:213-220`) | rAF debounce (`TerminalView.tsx:485-493`) | No gap |

Core-side flow control already helps both: binary frames `[chan u32][kind u8][len u32]`,
256 KiB credit per stream, 16 KiB chunks round-robin across streams, and a
viewer more than 4 MiB behind gets a fresh repaint instead of the backlog
(`C/wire.rs:1-31,247-260,284-318`, `C/viewers.rs:206-218`).

## Layer 6 plan (Electron)

1. Keep the last N (start 6) Terminal-window tabs mounted, hidden and
   attached, LRU beyond that; pause WebGL rendering for hidden ones.
2. `terminal.reset()` before the core's attach paint and stop writing the
   renderer snapshot when attaching to herdr-core (fixes item 2).
3. Move bytes as `Uint8Array` over a `MessagePort` per attachment and call
   `xterm.write(Uint8Array)`; batch input writes; reuse a growable buffer in
   the frame decoder.
4. Send FOCUS on focus change and FACTS (theme colors, cell size) on attach.

Measure before and after: attach-to-first-paint, switch time across 10 tabs,
frame time under `yes`-style output, memory with 10 tabs.

## herdr-core facts that shape the gateway adapter

- **Socket**: `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, else
  `/run/user/<uid>/herdr-core/`, else the state dir; `HC_SOCKET`/config
  override, `HC_SESSION` names the session (default `default`)
  (`C/paths.rs:16-47`, `platform/unix.rs:130-137`).
- **One core per session**, enforced by `flock` on `state/core.lock`
  (`server.rs:47-58`). Matrix must connect to it, never start a second one.
- **No socket auth**: trust is the 0700 directory, i.e. any process of that
  Unix user (`platform/unix.rs:140-143`, `docs/security.md:20-31`). This is why
  the gateway must run as the person's own account (decision 3) and why access
  is owner-only.
- **Handshake**: newline-JSON `hello` with `generation` (1); reply lists
  version, methods, features; `framed: true` switches to frames
  (`api.rs:16,194-214`, `server.rs:241,529`).
- **Remote**: `hc connect` over stdio is the same protocol; the Herdr app uses
  it. Using `herdr-core connect` as the transport (spec layer 2) matches.
- **Multiple clients per terminal**: yes. Each terminal has viewers across
  connections, typing or observer. The most recently active typing viewer sets
  PTY size and display facts; observers' query replies never reach the program
  (`viewers.rs:70-112,385-411,476-480`). Matrix attaching as an observer by
  default therefore never fights the Herdr app over size.

## Layer 6 results

### Main-process benchmark

`pnpm exec tsx scripts/bench/desktop-terminal-attach.ts --runs 7` drives the
real `@matrix-os/herdr-core-client` connection and session code against a
scripted core that streams under herdr-core's credit window (256 KiB, 16 KiB
chunks, 64 KiB socket reads). A Node `MessageChannel` stands in for the main →
Terminal window hop, and the window acknowledges every event. It reports two
paths: `text` (main decodes to strings and sends text slices, the Terminal
window's path before layer 6) and `bytes` (the production streams module: the
core's bytes over the attachment's port). It measures the main process only,
not xterm parsing or drawing, and not Electron's own IPC.

Medians of 7 runs, Linux x64, Node 24. "Before" is commit `4ecf7794a` (the
benchmark's first version, on the old decoder), run interleaved with the
current code on the same machine; that machine was saturated by other work
(load average about 32 on 32 cores), so compare columns, not absolute values.
On an idle machine the "before" throughput was 1,180-1,390 MiB/s.

| Measurement | Before | After, text sink | After, port (Terminal window) |
| --- | --- | --- | --- |
| Attach to first delivered output (196 KB first paint) | 0.54-0.62 ms | 0.46-0.52 ms | 0.78-1.19 ms |
| Attach to full first paint delivered | 0.63-0.71 ms | 0.54-0.59 ms | 0.94-1.35 ms |
| Output throughput, 64 MiB | 538-681 MiB/s | 568-659 MiB/s | 258-319 MiB/s |
| Events for 64 MiB | 4,096 | 4,096 | 4,096 |

What this does and does not show:

- The frame decoder change shows up as the text-sink column matching or
  beating "before" despite equal work; its real gain is for frames split over
  many reads (a 256 KiB frame in 1 KB reads went from 262 joins, about 15 s
  under the test spy, to none).
- Over a Node `MessageChannel`, a 16 KiB `Uint8Array` costs more to clone and
  collect than a 16 KiB one-byte string, so the port path moves bytes through
  main at about half the text rate. That is still over 250 MiB/s, far above
  what xterm parses, so main is not the limit either way. Electron's
  `MessagePortMain` serializer is not Node's; this needs measuring on a Mac.
- Not captured here, and the reason for the port: before, every attached
  Terminal-window terminal subscribed to the one `local-terminal:output` event,
  so each output event was schema-checked and delivered once per attached
  terminal. With six terminals kept attached that is six parses per event; a
  port per attachment makes it one. The UTF-8 decode and 256K-character
  slicing in main are gone, and xterm decodes the bytes itself.
- Still to measure on the Mac (Electron Desktop): switch time across 10 tabs,
  frame time under `yes`-style output, memory with 6 kept tabs, and
  attach-to-first-paint in the real window.

### What changed

| # | Technique | Change |
| --- | --- | --- |
| 1 | Keep tabs attached | The Terminal window keeps the 6 most recently shown terminals (local and Matrix tabs) mounted and attached; hidden ones parse output and return credit but are not drawn, focused or resized, and refit, redraw and focus when shown, or attach again if their attachment was given up. Switching computers no longer resets every attachment. The main window keeps one live attachment (many surfaces share its manager and each live cloud tab holds a gateway lease). |
| 2 | Attach repaint | Reproduced with the real xterm parser and herdr-core's paint format: reopening a terminal showed its history twice. Fixed by resetting xterm before the core's paint and keeping no snapshot for sessions the core repaints. |
| 3 | Byte path | Output as bytes over a `MessagePort` per attachment, held by the preload, `xterm.write(Uint8Array)`, credit after xterm's write callback; acknowledgements and typing over the same port, validated in the preload and in main; typing in one turn is one message; the frame decoder no longer joins reads. Electron's `MessagePortMain` cannot transfer `ArrayBuffer`s, so bytes are cloned, sliced first so a frame does not drag its whole socket read along. |
| 4 | FOCUS and FACTS | Sent on xterm focus changes and on attach, theme change and resize. herdr-core 0.1.19 does not list them in `hello.features`, and the core ignores frame kinds it does not know; checked against the installed 0.1.20, where an OSC 11 query is answered with the sent background and focus reports reach the program. Not checked against 0.1.19 itself. |
