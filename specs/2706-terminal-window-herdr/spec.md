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

Added 2026-11-22 (Hamed):

4. **Add an ssh machine** from the sidebar's machines list, as Herdr does. It
   reuses herdr-core's machine model (`machine.add`, `machine.list`,
   `machine.connect`, `machine.rm`) on the Terminal window's bundled core, so
   the machine and its terminals behave like `hc machine add` ones.
5. **Drag to rearrange panes**: drag a pane by its header onto another pane's
   edge to split there.

## Behaviour

### Layout (Herdr, 2026-11-22)

The window follows Herdr's layout: a left sidebar, a top tab bar, panes, and a
bottom status bar.

- **Sidebar**: **Spaces** on top (machines, each with its projects, a `+` and
  a status dot), then **Agents** (the status sections below). **Settings** and
  **Add machine…** sit at the foot.
- **Top tab bar**: one tab per opened pane tab (a terminal on its own is a tab
  of one), showing the agent's icon, the focused terminal's name, the pane
  count, a spinner while any pane works, and a close button; `+` starts a new
  terminal on the machine on screen. Closing a tab only takes it off the bar;
  its terminals keep running and stay in the sidebar. The bar holds at most 24
  tabs and is kept per viewer.
- **Panes**: every pane, a lone terminal included, has a header (agent icon,
  name, machine and project or folder, then split right, split down, zoom and
  close buttons). Panes have gaps and rounded borders; the focused pane has a
  blue outline. Every visible pane streams live on an attachment of its own;
  only the focused one takes the keyboard.
- **Status bar**: the machine on screen, its project and branch or folder, the
  agent count with how many work or need you, and "⌘⇧P commands".
- **A machine as its own tab**: clicking a machine (or one of its spaces)
  filters Agents to it, shown as a chip that clears the filter.

### Sidebar

- **Spaces** (top), as Herdr's: an **All** row (every terminal; the state with
  no filter), then each machine (This Mac, ssh machines, then Matrix computers)
  as a compact muted header: icon, name, what it is and whether it can be used
  now, then `+`, a status dot and a fold chevron. Under it, that machine's
  spaces (projects or workspaces) as compact rows with a colored rounded letter
  avatar, the name and a terminal count. Fold state persists per machine.
  Unavailable machines fold into **Unavailable (n)** at the end; the list
  scrolls on its own past 40% of the window. **Add machine…** sits at the foot
  beside Settings (see Ssh machines).
- Choosing a machine or a space filters the Agents list and the tab bar (and
  Ctrl+Tab) to it; the chosen row is highlighted, and **All** clears it.
- A space's menu (hover `…` or right-click) renames it, picks one of eight
  colors, picks an icon in place of the letter, moves it up or down, or resets
  its look; spaces also reorder by drag. This dressing is kept per viewer and
  never renames the project.
- **Agents** (below): **Pinned** first, then **Needs you** (blocked or error),
  **Done** (finished and not yet seen), **Working**, **Idle**, each foldable
  with a count (needs-you and working in amber, done green, idle grey). A
  second view groups by machine; there, and under a machine filter, rows are
  inset and do not repeat the machine's name. Agents is the only list of
  terminals: Spaces shows machines and their spaces, never terminals again.
- Done means finished since the person last looked. Opening the terminal marks
  it seen; seen is shared across the person's windows and devices.
- A row shows the agent icon, the project in bold then " · title" muted, the
  time since the last change right-aligned in a fixed column, and a status mark
  (spinner, amber dot for needs you, filled dot, ring) in a fixed last column,
  so times and marks line up; long names truncate before the time. The second
  line names the machine (only where machines mix), what runs there, and a
  "Needs you" pill. Hover gives the row a rounded tint and shows pin and close
  in place of the time. Sub-agents hang from their parent on connector lines,
  folded with a chevron; the parent takes their most urgent status. Child
  processes and a muted mark follow once herdr-core reports them.
- Below 160 px the sidebar becomes a numbered rail; Cmd+B toggles it.

### Shortcuts (macOS)

Cmd+N (and Cmd+T) new terminal, Cmd+W close only the focused pane (it ends
that pane's terminal, asking first while a program runs; the tab and its other
panes stay and the pane beside it takes focus; closing the last pane closes the
tab), Cmd+1..9 select, Cmd+] / Cmd+[ next and
previous terminal in sidebar order, Ctrl+Tab and Ctrl+Shift+Tab cycle the tab
bar's open tabs (in bar order, wrapping),
Cmd+D split right, Cmd+Shift+D split down, Cmd+Shift+W hide pane (its terminal
keeps running),
Cmd+Shift+Enter zoom pane, Cmd+Alt+arrows focus pane, Cmd+Alt+Shift+arrows swap
pane, F2 rename, Cmd+B sidebar, Cmd+P and Cmd+Shift+P picker, Cmd+F find, plus
the existing terminal editing keys. They are menu accelerators in the Terminal
window only and reuse `packages/contracts/src/terminal-keyboard.ts`.

Every shortcut works while a terminal has focus: a focused terminal leaves the
window's keys to the menu (it neither sends them to its program nor cancels
them), so the terminal's own bindings (for example Cmd+Alt+Shift+arrows as
resize) cannot swallow them. Cmd+C, Cmd+V and Cmd+A stay with the terminal.

### Panes

In the Terminal window the pane buttons (split, zoom, pane controls) and keys
drive this tree, not Zellij panes. Zellij stays only as the per-tab session
keeper on computers; it leaves the runtime once herdr-core runs on every
computer (a later stack).

A tab holds a tree of rows and columns. Each leaf is one terminal. Split
creates a new terminal on the same machine (and folder when known), zoom shows
one leaf, swap and focus move by direction, dividers resize. The layout is
saved per machine and restored when the window opens; a leaf whose terminal is
gone is dropped. A tab holds at most 16 leaves; split is refused beyond that.

Drag to rearrange: dragging a pane's header over another pane of the same tab
shows a labelled drop zone ("Split left", and so on) for the nearest edge
(left, right, top, bottom); dropping moves the pane there,
splitting that pane in that direction. Dropping on the pane's own position, or
outside any pane, changes nothing. Escape cancels a drag. Keyboard swap
(Cmd+Alt+Shift+arrows) stays the non-mouse way to rearrange.

### Ssh machines

**Add machine…** opens a small form: the ssh target (`host`, `user@host`,
`user@host:port`, or a `Host` alias from `~/.ssh/config`) and an optional name.
The trusted main process validates both and calls `machine.add` on the bundled
core. The machine then appears under machines with its line state
(connecting, connected, needs login, unreachable); its terminals come through
the same `events.subscribe` stream as `machine/t7` addresses, and `+` starts a
shell there with `terminal.run` and `on`. Remove forgets the machine
(`machine.rm`); its terminals keep running there.

When the dial fails because ssh does not know the host's key, needs a password,
or `hc` is missing there, the form says so and offers **Open in terminal**: a
local terminal running `ssh <target>` (fixed argv built in the main process),
where the person checks the fingerprint or types their password themselves,
then retries.

Added 2026-11-22 (Hamed):

- **Custom ssh**: besides `user@host[:port]` and a `~/.ssh/config` alias, the
  form takes a port, an identity file (a path on this Mac, never uploaded) and
  a jump host (ProxyJump). With any of them, the main process builds the
  core's `via` line itself: `ssh -o BatchMode=yes [-p port] [-i path]
  [-J jump] -- user@host`, every value checked against a strict pattern (no
  leading `-`, no spaces, quotes or shell signs) and single-quoted. **Open in
  terminal** runs the same argv without `BatchMode`, so OpenSSH shows a new
  host key's fingerprint there; nothing ever accepts a key silently.
- **Tailscale**: the form lists the person's tailnet peers from the local
  `tailscale status --json` (online, OS, MagicDNS name), each addable in one
  click. A peer that offers Tailscale SSH is reached with `tailscale ssh`, any
  other with plain ssh to its MagicDNS name. Tailscale missing, stopped or
  logged out shows a short note instead of the list. The CLI runs with a
  timeout and a capped output; only peers' names, OS and online state are read.
- **No mosh**: herdr-core needs a byte pipe for its RPC, and mosh only syncs a
  screen. herdr-core already redials a lost machine on its own (`connecting`
  until `connected`, retry interval `HC_RECONNECT_MS`); terminals keep running
  there. Attachments end on a lost line; the window offers to attach again, and
  refreshes each machine's line state while visible.
- **Core on added machines** (layer 8): adding a machine installs the same
  pinned herdr-core the app ships, if it has none or an older one, and every
  connect keeps it current. `machine.add` over RPC does not install (only the
  CLI's `--install` copies its own binary), so the app does it:
  - over the same ssh options, into `~/.local/bin` (no sudo), choosing the
    build by `uname -sm` (linux and macOS, x64 and arm64) from the pinned
    `desktop/herdr-core.json`, verifying its SHA-256 before it runs;
  - an upgrade writes to a temporary file in that directory, verifies it, and
    renames it into place, then asks the remote core to restart; herdr-core
    keeps terminals across `server restart`, otherwise the person is asked
    first because their sessions would end;
  - the previous binary is kept beside it for rollback; nothing outside that
    install directory is touched;
  - each machine row shows its core version and update state, with a clear
    error when install fails.
  - Bounds and failures: the upload of the binary (scp over the same ssh
    options) times out after 2 minutes and the whole install after 3; one
    install or upgrade runs per machine at a time (a second request waits for
    it, then sees the result); an interrupted upload leaves only
    `~/.local/bin/.herdr-core.<random>.tmp`, which the next attempt removes
    before writing, and the installed binary changes only by the final
    rename. A failed install leaves the machine added and listed with the
    error and a Retry.

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
| 6 | Panes: split tree, one terminal per pane, drag to rearrange | after ENG-519 |
| 7 | Ssh machines: add (custom ssh, Tailscale peers), list, remove, terminals on them | after ENG-519 |
| 8 | Core on added machines: install, verify, keep current, roll back | after ENG-519 |
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

Seen (layer 4):

- Matrix computers: the gateway keeps the time each tab was last opened,
  saved in `~/system/terminal-seen.json` (owner file, atomic write). The
  events hub sends an `attention` frame after each snapshot and whenever it
  changes: every done tab (finished, or reporting `done`) with when it became
  done and whether it was opened since. A client marks a tab seen with a
  `seen` frame naming its ref. Clients that do not know these frames ignore
  `attention`, and a client sends `seen` only after it has received an
  `attention` frame, so older gateways never see an unknown client frame.
- This Mac and ssh machines: herdr-core's own `herdr.seen` label (the
  terminal's `turn` when it was last looked at), as the Herdr app uses, so
  seen is shared with every client of that core.

Local events (layer 4): the main process opens one extra plain-mode
connection to the bundled core, calls `events.subscribe`, keeps the facts it
needs per terminal, and sends the Terminal window compact rows. It reconnects
with backoff and replaces its state on every snapshot (including after
`missed`).

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
  computer terminals; shortcuts work, including while a terminal has focus;
  panes split, zoom, swap, focus, resize, close, drag to a new edge and
  restore, from the keys and from each pane's header buttons.
- Every visible pane streams live, and the top tab bar opens, closes and adds
  tabs without ending terminals (except Cmd+W and a pane's close button, which
  end the pane's terminal after confirmation while a program runs).
- An ssh machine with a known host key and key-based login is added from the
  sidebar, its terminals appear and a new one starts there; an unknown host key
  is refused with the Open in terminal path.
- Live evidence on Electron Desktop for every layer that changes UI.

## Security

- No new endpoints in layers 2-3. Layer 4 reuses the authenticated
  `/ws/terminal/events` stream per computer (same auth as the main window) and
  adds a bounded "mark seen" frame validated with Zod; only the owner's tabs,
  and only refs the hub currently lists are stored.
- Ssh machines (layer 7):
  - No private key, password or passphrase is uploaded to Matrix or stored by
    the app. herdr-core dials with the system `ssh` in `BatchMode`, so keys
    stay in `~/.ssh`, the ssh agent or the macOS keychain, and the core keeps
    only the target and name in its own data directory (the app's userData).
  - Host keys are verified by OpenSSH against `~/.ssh/known_hosts`; the app
    never passes `StrictHostKeyChecking=no` or any option that weakens host
    key checks. The only `-o` option it ever passes is `BatchMode=yes`. An
    unknown or changed key fails the dial, and the person accepts a new key
    only in a real terminal running ssh (same port, identity and jump host),
    where OpenSSH shows the fingerprint.
  - The target is validated in the main process (letters, digits, `.`, `-`,
    `_`, optional `user@` and `:port`, at most 255 characters, never starting
    with `-`), the name with herdr-core's terminal-name rules. A plain target
    reaches `machine.add` as `target` and `name` only.
  - With custom ssh fields or a Tailscale SSH peer, `machine.add` also gets a
    `via` line, built only by the main process from fixed parts: `ssh -o
    BatchMode=yes [-p <port>] [-i '<path>'] [-J '<jump>'] -- '<user@host>'`,
    or `tailscale ssh -- '<user@host>'`. Each value is checked against its own
    strict pattern (port 1-65535; a path of letters, digits, `.`, `_`, `-`,
    `/` and a leading `~/`; a jump host as a target) and single-quoted. The
    renderer sends only these fields, never a command; any other `via` is
    refused.
  - New IPC: `local-terminal:machines`, `:machine-add`, `:machine-remove`,
    `:machine-connect`, `:ssh-login`, `:tailscale-peers`, Terminal window
    only, each with a strict Zod schema. Errors reach the window as
    herdr-core's stable kinds, never messages.
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
- Local events connection: one per app; a snapshot line is capped (16 MiB)
  and the facts map by the core's own terminal limits; reconnect with backoff
  up to 30 s.
- Machine dial: `machine.add` waits at most 30 s; the form stays usable and
  can be retried.
- Kept attachments stay capped at 6 per window (2701 layer 6).

## Risks

- Zellij may still redraw on other actions (rename, new tab); those are user
  driven and rare.
- One terminal per pane diverges from the Web split path until Web migrates.
