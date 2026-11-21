# 2706 · Terminal window like Herdr: status sidebar, shortcuts, panes, remote speed

Linear: [ENG-521](https://linear.app/matrix-os/issue/ENG-521) (follow-on stack after ENG-519).
Builds on: [2701 Herdr self-host](../2701-herdr-self-host/spec.md) (Terminal window
speed-ups, layer 6), [2692 Herdr parity](../2692-herdr-parity/spec.md) (OSC 7501
status, attention), [2697 chat and terminal agents](../2697-chat-terminal-agents/spec.md).

## Goal

The Electron Desktop Terminal window should look, behave and feel as fast as the
Herdr app, for terminals on this Mac and on Matrix computers:

- a left sidebar that sorts terminals by what they need from the person
  (Needs you, Done, Working, Idle), with collapsible sections;
- Herdr's keyboard shortcuts;
- split panes, where every pane is its own terminal with its own status;
- Matrix computer terminals that switch instantly, stay quiet when idle and echo
  keystrokes close to network latency.

## Measured starting point (2026-11-21, Mac on Wi-Fi, PR #3536 dev build)

| Measurement | Result |
| --- | --- |
| Local tab switch (8 tabs, 6 kept) | about 70 ms to shown, no long tasks |
| Matrix tab switch, before #3536 fix | 3 WebSocket reconnects and 450-840 KB replay per click |
| Matrix tab switch, after #3536 fix | 0 reconnects |
| Idle traffic, 4 Matrix tabs, before fix | 465 KB per 10 s |
| Idle traffic after fix | 213 KB per 10 s, still a full repaint about every 2 s per tab |
| Cause of the idle repaint | the runtime's held-pane exit sweep runs `zellij action list-panes` every 2 s (`terminal-runtime/src/service.ts`), and Zellij redraws every attached client after any CLI action (test server: 5 `list-panes` calls = 151 KB to one client) |
| Keystroke echo, Matrix computer | median 73 ms; network round trip to Hetzner about 31 ms |
| Zellij's share of echo | 12 ms per keystroke locally (bash on a bare pty: 0.1 ms) |

Herdr keeps one ssh connection per machine, every terminal attached, binary
frames with credit, and no multiplexer under the terminal, so its echo is close
to the network round trip and idle terminals send nothing.

## Decisions (2026-11-21, Hamed)

1. Splits use **one terminal per pane**, as Herdr does: a herdr-core terminal on
   this Mac, a Matrix tab on a computer, a Herdr session when the computer has
   one. Not Zellij panes. Web adopts the same model later.
2. Remote speed comes from **fixing the gateway path first** (no Zellij polling
   repaints, kept attachments, binary frames, one connection per computer). A
   Herdr transport straight to computers is not in scope.
3. This is a **new stack** after ENG-519, with its own ENG ticket.

## Behaviour

### Sidebar

- Top: machines (This Mac, then Matrix computers), each foldable, with a `+`.
  Fold state persists per machine.
- Below: terminals by status, in this order: **Needs you** (blocked or error),
  **Done** (finished and not yet seen), **Working**, **Idle**. Every section
  folds and shows a count when folded. A second view groups by machine.
- Done means finished since the person last looked. Opening the terminal marks
  it seen; seen is shared across the person's windows and devices.
- A row shows the agent icon, name (tab name or agent title), machine tag for
  remote terminals, time since the last change, and a status mark (spinner,
  "Needs you" pill, filled dot, ring). A parent agent folds its sub-agents and
  takes the most urgent status among them.
- Below 160 px the sidebar becomes a numbered rail; Cmd+B toggles it.

### Shortcuts (macOS)

Cmd+T new terminal, Cmd+W close, Cmd+1..9 select, Cmd+] / Cmd+[ next and
previous terminal in sidebar order, Ctrl+Tab and Ctrl+Shift+Tab cycle,
Cmd+D split right, Cmd+Shift+D split down, Cmd+Shift+W close pane,
Cmd+Shift+Enter zoom pane, Cmd+Alt+arrows focus pane, Cmd+Alt+Shift+arrows swap
pane, F2 rename, Cmd+B sidebar, Cmd+P picker, Cmd+F find, plus the existing
terminal editing keys. They are menu accelerators in the Terminal window only
and reuse `packages/contracts/src/terminal-keyboard.ts`.

### Panes

A tab holds a tree of rows and columns. Each leaf is one terminal. Split
creates a new terminal on the same machine (and folder when known), zoom shows
one leaf, swap and focus move by direction, dividers resize. The layout is
saved per machine and restored when the window opens; a leaf whose terminal is
gone is dropped.

### Remote speed

- The runtime stops asking Zellij on a timer. Only command tabs (`new-tab --
  <cmd>`) are held after exit; a shell tab that exits closes its pane and
  Zellij reports that. `zellij subscribe` does not report a held pane's exit
  (checked on Zellij in the 2026-11 bundle), so:
  1. Record at activation whether a tab runs a command, and sweep only
     workspaces with a live command tab (shell-only workspaces go quiet).
  2. Then remove the sweep for command tabs too: either a launcher that writes
     the exit code to a file in the runtime's 0700 directory, which the runtime
     watches, or the existing Zellij plugin pushing `PaneUpdate` exits. A spike
     decides, checking Ctrl-C delivery to agents and the `pane_command` value
     the legacy shell path reads (`gateway/src/shell/zellij.ts`).
- Native scroll queries run only for the terminal on screen and back off when
  the computer has no history (done in #3536).
- Later layers: binary output frames, one WebSocket per computer carrying all
  its tabs with credit, Herdr sessions as the default backend where a computer
  runs herdr-core (removes Zellij's 12 ms).

## Surfaces

Electron Desktop only for the sidebar, shortcuts and panes (the Terminal window
exists only there; spec 651). The runtime change affects every surface that
shows Matrix terminals (Web Desktop, Web Canvas, Web Mobile, Native Mobile)
only by removing idle repaints; their UI does not change. The shared sidebar
component lives in `packages/ui` so Web can adopt it later.

## Layers

| # | Layer | Base |
| --- | --- | --- |
| 1 | This spec | main |
| 2 | Runtime: exit detection without Zellij polling | main |
| 3 | `packages/ui` status sidebar model and component | after ENG-519 |
| 4 | Status data: local `events.subscribe` and seen; computers subscribe to `/ws/terminal/events`, seen per tab | after ENG-519 |
| 5 | Terminal window: sidebar wired in, Herdr shortcuts | after ENG-519 |
| 6 | Panes: split tree, one terminal per pane | after ENG-519 |
| — | Public docs: Terminal window sidebar, shortcuts and panes (separate PR in `FinnaAI/matrix-os-site`, `content/docs/`) | site repo, after layer 6 |

Binary frames, one connection per computer and Herdr-backed computer terminals
are a following stack.

## Integration wiring

Startup (`packages/terminal-runtime/src/service.ts`):

1. Load the workspace store.
2. Create the exit recorder at `~/system/terminal-workspaces/exits` and create
   the directory (0700) before the runtime is constructed, so the first tab
   launched can already write to it.
3. Construct the runtime with the recorder and recover saved tabs. A tab whose
   launch was cut short keeps its saved `exitRecorded` choice (it is saved
   before the program starts).
4. Start the 2 s sweep: read exit files first, then run the `list-panes`
   sweep only for workspaces with a command tab that does not record its own
   exit (shell tabs close on exit and are never asked about). Shutdown sets `shuttingDown`, stops the timer, and
   lets a pass in flight finish.

Status path (layer 4): runtime store (`status: exited`, `exitCode`) → the
gateway's existing terminal status pipeline (2692) → `/ws/terminal/events` →
the Terminal window's per-computer subscription → sidebar rows. Local
terminals take the herdr-core `events.subscribe` path instead.

End-to-end checkpoint, added with layer 4 before the sidebar is wired in:
create a command tab through the real runtime and wrapper (`/bin/sh`), let the
program exit with code 4, and assert in one test: the stored tab is `exited`
with code 4, `/ws/terminal/events` emits that exit for the tab's ref, and the
sidebar model files the row under Done. A second case stops the runtime, writes
an exit file while it is down, starts a new runtime on the same store and
directory, and asserts the exit is recorded on the first sweep and reaches the
event stream. Each layer's own tests do not replace this one.

## Acceptance

- Idle Matrix tab in the Terminal window: no output frames for 30 s when its
  program prints nothing.
- Program exit in a Matrix command tab is noticed within 2 s, without any
  `zellij action` call while it runs.
- Matrix tab switch among kept tabs: no WebSocket opened; shown within one frame.
- Sidebar sections, counts, fold, seen and rail behave as above for local and
  computer terminals; shortcuts work; panes split, zoom, swap, focus, resize and
  restore.
- Live evidence on Electron Desktop for every layer that changes UI.

## Security

- No new endpoints in layers 2-3. Layer 4 reuses the authenticated
  `/ws/terminal/events` stream per computer (same auth as the main window) and
  adds a bounded "mark seen" frame validated with Zod; only the owner's tabs.
- The exit record is written by the tab's launcher inside the owner's runtime
  directory (0700), named by tab id (validated), never by user input.
- Shortcuts run only in the trusted Terminal window renderer; no new IPC
  beyond existing terminal verbs.

## Failure modes and resources

- Exit watcher: one `fs.watch` per workspace directory, closed with the
  workspace; if watching fails, fall back to the 2 s sweep for that workspace
  only and log the error name.
- Event subscriptions: at most one per available computer, closed when the
  window closes or the computer becomes unavailable; reconnect with backoff.
- Seen map: bounded by the runtime's tab cap; finished history trimmed as today.
- Layout store: one small record per machine, capped leaves per tab (16).
- Kept attachments stay capped at 6 per window (2701 layer 6).

## Risks

- Zellij may still redraw on other actions (rename, new tab); those are user
  driven and rare.
- One terminal per pane diverges from the Web split path until Web migrates.
