# 2716 · Desktop link: your Matrix computer runs terminals on your Mac, Linux or Windows desktop

Status: draft for review. Requester and owner: Hamed. Suggested reviewer: Nima.
Linear: [ENG-574](https://linear.app/matrix-os/issue/ENG-574).
Related: [ENG-521](https://linear.app/matrix-os/issue/ENG-521) (Terminal window),
[ENG-524](https://linear.app/matrix-os/issue/ENG-524) / `specs/2707-owned-machines` (owned computers),
[ENG-570](https://linear.app/matrix-os/issue/ENG-570) / `specs/2710-team-terminals` (sharing),
[ENG-519](https://linear.app/matrix-os/issue/ENG-519) / `specs/2701-herdr-self-host` (gateway herdr-core client),
[ENG-495](https://linear.app/matrix-os/issue/ENG-495) / `specs/2698-mac-device-pairing` (pairing, consent, Mac Activity).
This spec is the transport half of 2698: see [One system with 2698](#one-system-with-2698-hamed-2026-11-25).
Builds on: `specs/651-desktop-terminal-window`, `specs/2706-terminal-window-herdr`.

## Goal

A person's Matrix computer (a cloud VPS, or an owned machine enrolled with the
platform under 2707) can open terminals, run processes and start coding agents
on that person's own desktop: a Mac, Linux or Windows machine running the
Matrix OS desktop app. The person's Electron Desktop app keeps one outbound,
owner-authenticated WebSocket to the computer's gateway. The gateway lists the
desktop as a machine in the Terminal app, the Terminal window and `matrix shell`,
and runs terminals on it through that link. The owner can switch the link off
on the desktop, or remove the desktop from the computer, and access ends at once.

There is no Tailscale, no `hc machine add`, no ssh and no listening port on the
desktop.

## Non-goals

- Anything on the desktop other than terminals and one-shot screenshots: no
  file browsing, mouse or keyboard input, app control or ENG-495's
  Chat-approved checks. Mouse, keyboard and app control are the next stack
  under ENG-495 with their own spec; this one reserves `input: false` in each
  desktop's capabilities for it. Screenshots on macOS need the person's Screen
  Recording permission for Matrix OS (see Chat and agents).
- The person's own Herdr app and its herdr-core. Only the Electron app's
  private core (session `mx`, `desktop/src/main/local-terminals/host.ts`) is
  exposed.
- Machines reached onward from the desktop (the desktop core's own ssh machines).
- Sharing a desktop with anyone else. ENG-570 shares single terminals; this spec
  adds no share path for desktop terminals (see Auth).

## One system with 2698 (Hamed, 2026-11-25)

2698 (ENG-495, merged on main) and this spec are one system. 2698 owns who a
desktop is and what the owner allowed; this spec owns how the computer reaches it.

| Concern | Owner | Where |
| --- | --- | --- |
| Device key | 2698 | `desktop/src/main/desktop-pairing/key-store.ts` (`createPairingKeyStore`), unchanged |
| Pairing (device ID, revision, enrol, disconnect) | 2698 | `/api/desktop-pairing`, owner table `desktop_pairings`, unchanged contract |
| Consent | 2698 | Native approval per action, or the owner's Full Access consent bound to the pairing revision ([Consent](#consent)) |
| Activity and Stop | 2698 | Mac Activity indicator (all three platforms), Stop |
| Mac Verification | 2698 | Unchanged here; moves onto the link in the follow-up stack |
| Transport | 2716 | `/ws/desktop-link`, the only path from a computer to a desktop |

- **Admission is pairing.** The link admits exactly the device paired with this
  computer, at the current pairing revision, proved with the pairing key. There is
  no second enrolment, table or key store: this spec's former
  `desktop_link_devices` table, `/api/desktop-link/enrol*` routes and its copy of
  `key-store.ts` are dropped.
- **Revocation is a revision bump.** Disconnect (desktop) or Remove (computer)
  goes through `DELETE /api/desktop-pairing/:deviceId`; the revision bump closes the
  live link at once ([Revocation](#revocation)).
- **Pairing beyond macOS.** Linux and Windows pair the same way ([Pairing on
  Linux and Windows](#pairing-on-linux-and-windows)).
- **Retired later, not here.** 2698's terminal-check paths (#3460 background
  checks, #3468 terminal checks, #3484 snapshot and watch) and its 3-second Chat
  polling loop keep working unchanged in this stack. A follow-up stack retires them
  and moves Mac Verification onto the link. The superseded 2698 sections carry a
  note pointing here.

### Decisions (Hamed, 2026-11-25)

- **D1 Desktops per computer**: one paired desktop per owner and computer, as
  2698's `desktop_pairings` (owner, machine) key has it. Pairing another device
  asks to disconnect the first. Multi-desktop is a later pairing schema change.
- **D2 Consent for link actions**: native approval per action, or Full Access for
  this desktop ([Consent](#consent)).
- **D3 Device name, system and last seen**: nullable columns on
  `desktop_pairings`, added by an idempotent `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS` in the link's layer: `device_name` (1–64 printable characters),
  `device_platform` (`darwin` \| `linux` \| `win32`), `device_arch` (`x64` \| `arm64`),
  `device_screenshot` (boolean) and `last_seen_at`. They are written only for the
  paired device at its current revision (`WHERE device_id = … AND revision = …`):
  once on admission, and `last_seen_at` by a targeted update at most once a
  minute per device. Pair and disconnect clear them in the same statement that
  bumps the revision, so a new pairing never inherits an old device's
  description. The name is the desktop's own report: shown, never used for
  authorization.
- **D4 Linux without a system keyring**: pairing is unavailable and says so
  (2698's key store refuses `basic_text`). No weaker fallback.

### Consent

Recommended (D2). The link being on never runs anything by itself:

| Action from the computer | Consent |
| --- | --- |
| Start a terminal, program or agent (`terminal.run`) | Native approval on the desktop naming the computer and the command, unless Full Access is allowed |
| Read, type into, wait on, interrupt or end a terminal the link started | Covered by that terminal's start approval |
| List terminals (titles and status) | None: the computer sees every terminal's title (Risks 2) |
| Read or type into a terminal the link did not start | Native approval per terminal (2698 existing-terminal rule), unless Full Access is allowed |
| Screenshot | Native approval per capture, unless Full Access is allowed |

**Full Access for this desktop** is the owner's one-time native consent on the
desktop, stored like 2698's Chat Full Access (encrypted, bound to owner, computer,
device and pairing revision; capability `desktop-link`, separate from
`mac-verification`). Re-pairing drops it. The pairing dialog offers **Allow / Revoke
Desktop Link Full Access** on every platform; Full Access is read fresh on every
check, so revoking takes effect on the next action.

- The approval names the computer and the request ("matrix-demo wants to run a
  command on this Mac") and shows the whole command and the folder it starts in:
  argv quoted part by part the way the desktop's OS reads it (POSIX quoting, or
  the Windows command line), a shell line as written, and every character that
  would not show as itself (newlines, escapes, zero-width, direction marks, tags,
  combining marks, separators other than a space) written out as `⟨U+XXXX⟩`, and
  a run of spaces as `⟨N spaces⟩`. A command or folder longer than 500
  characters once shown is refused, never shortened. A start is refused without
  asking when `argv[0]` could name a herdr-core template (compared by its last
  path part, without case or `.md`; a relative path with a separator is refused
  outright), since the core would run the template's command, not the one shown,
  and when the core cannot say which templates it has. The dialog says the
  computer can then see and type into the terminal it starts. A terminal approval
  leads with the address and shows the program, folder and title from the core's
  own record, the title marked as set by the program. The computer's name is
  shown the same way (≤ 64 characters), inside the fixed phrase "Your Matrix
  computer “…”". One approval is on screen at a time, the next opens a second
  after the last closes; at most four wait; more are refused at once, and a
  request whose deadline passes while it waits never gets a dialog. Approved terminals are remembered for the pairing revision
  (≤ 256, oldest forgotten first) as one terminal instance, address and start
  time, so an address the core gives a later terminal (after the core restarts)
  is asked about again; Stop, disconnect, sign-out, an account or
  computer switch, and re-pairing forget them and close any approval on screen.
- Deadlines nest: approval 60 s, the computer's core call or screenshot 75 s,
  clients that may trigger an approval (shell, Electron, `matrix shell machine`)
  90 s. Each approval's deadline starts when the request arrives, not when its
  dialog shows; an answer after it counts as no. The computer's own terminal
  listing waits at most 3 s on a desktop, then leaves its terminals out.
- While an approval is on screen, the call waiting for it is decided off the
  stream's queue: later calls, typing and credit on that stream keep moving.
  After an approval the guard re-reads the terminal and refuses the call if it is
  no longer the same instance.
- Calls waiting for the owner are decided off the core stream's queue: other
  calls, typing, resizes and credit on the same stream keep moving.
- The guard refuses: a start carrying both `argv` and `line` (the owner sees one
  program); a start naming `parent` or `caller`; a terminal call that names no
  terminal or a name instead of an address (`^t[0-9]+[a-z]{0,2}$`); and any call
  reusing the id of a call still awaiting its answer, so the core's answer to an
  approved start (which marks that terminal covered) can never be a reply to
  another call. A core frame the guard cannot decode ends the stream.
- A declined screenshot answers `capture-failed` with reason `declined`
  (`denied` to API, CLI and Chat); a declined start or terminal call gets the
  guard's `denied` JSON-RPC error and never reaches the core.
- Activity: on macOS, where 2698's Mac Activity indicator runs, the link is one
  entry (kind `desktop-link`, no worktree) while it is on, recorded as stopped,
  revoked or failed when it ends; the indicator's Stop closes the link and keeps
  the pairing. On Windows and Linux, Stop is the File menu's **Stop Computers
  Using This Device** and the pairing dialog; a tray indicator there is a follow-up.

### Pairing on Linux and Windows

2698's code is device-neutral except for these, which this stack changes:

- `desktop/src/main/index.ts` creates `createDesktopPairing` on every platform,
  not only `darwin`.
- Menu: macOS app menu **Mac Pairing…** (unchanged); File menu **Pair This PC…**
  (Windows) and **Pair This Desktop…** (Linux). Dialog copy uses the same noun
  (this Mac, this PC, this desktop). Chat Full Access for Mac Verification stays
  macOS-only.
- The Terminal window panel shows the link's state with Turn off / Turn on and,
  when unpaired, **Pair this device with your computer…**, which opens the same
  native dialog (IPC `desktop-link:pair`).
- Key protection: Windows DPAPI via `safeStorage`; Linux needs libsecret or
  KWallet. `basic_text` keeps refusing (D4).
- Activity indicator: macOS only in this stack (see [Consent](#consent)); Windows
  and Linux stop from the File menu.
- Contracts, routes and `desktop_pairings` need no change: nothing in them is
  macOS-specific. The gateway gate stays `MATRIX_DESKTOP_PAIRING_ENABLED=1`, primary
  runtime slot, HTTPS origin; the link additionally needs
  `MATRIX_DESKTOP_LINK_ENABLED=1`.

## Platforms (Hamed, 2026-11-25)

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Terminal core | Bundled herdr-core (darwin-arm64, darwin-x64) | Bundled herdr-core (linux-x64; the manifest pins linux-arm64 too, but no arm64 AppImage is built yet) | In-process ConPTY core via node-pty (herdr-core has no Windows build) |
| Default shell | Login shell | Login shell | PowerShell (`powershell.exe -NoLogo`) |
| Pair, switch on | App menu: Mac Pairing… | File menu: Pair This Desktop… | File menu: Pair This PC… (Windows has no Terminal window) |
| Switch off, Stop | Activity indicator, pairing dialog, Terminal window panel | Same | Activity indicator, pairing dialog |
| Screenshot | desktopCapturer; needs Screen Recording for Matrix OS | desktopCapturer; `screenshot_unavailable` where the session cannot be captured (some Wayland sessions) | desktopCapturer |
| Open a page | `/usr/bin/open` | `xdg-open` | `cmd.exe /c start "" <url>` |
| Verified live | Planned on Hamed's Mac | Not yet (no Linux desktop machine) | Not yet (no Windows machine) |

Each desktop reports `{platform, arch, capabilities: {terminals, screenshot,
input: false}}` in its proof on every connect. The gateway keeps the last
report in `desktop_pairings` (D3), and `desktop_list`, `matrix shell machine ls`,
`open` and the Desktops group use it.

**Windows core.** A small in-process core speaks the part of herdr-core's
framed protocol the computer's Herdr adapter uses: the `hello` handshake,
`terminal.list`, `terminal.run`, `terminal.attach`, `terminal.kill`, and the
DATA, CREDIT, RESIZE and CLOSE stream frames. That is everything the adapter
asks of a core (`HERDR_SESSION_METHODS`): reads and waits for agents and Chat
(`read`, `wait`, `screen`) are built on `terminal.attach` with history, so
herdr-core's `terminal.read`, `terminal.wait` and `events.subscribe` are not
needed here, and the core announces only the `framed`, `attach` and `shell`
features. The guard sits in front of it
exactly as in front of herdr-core, and checks folders with Windows path rules.
Caps: 16 live terminals, 64 records, 8 viewers per terminal, 512 KiB of
history per terminal, a 1 MiB credit window per viewer. A viewer out of
credit pauses the program; a viewer 2 MiB behind is dropped, and so is any
viewer still behind 10 s after the pause began (a paused program stops
producing, so a stalled viewer would otherwise hold it paused for everyone).
The
shell gets the user's environment without `ELECTRON_*`, `NODE_OPTIONS` or
`MATRIX_*`. Every terminal ends when the app quits (there is no daemon).
node-pty ships in the Windows package only.

## Today (main @ `60e6b5b0a4`)

- Electron bundles a pinned herdr-core (`desktop/herdr-core.json`, shipped as
  `<resources>/herdr/hc`) and runs "This Computer" terminals in a private core
  over a Unix socket (`host.ts`, `hc-client.ts`, `hc-protocol.ts`). The core and
  its terminals outlive the app.
- Electron reaches *other* machines over ssh (`hc-machines.ts`,
  `ssh-command.ts`, `tailscale.ts`). The direction is always desktop → machine.
- The cloud gateway runs Matrix terminals on Zellij and has no herdr-core
  client on main. 2701 (#3527, #3529) moves the client into
  `packages/herdr-core-client` and adds a gateway adapter for the computer's
  own herdr-core.
- Electron already holds an owner credential and mints computer-scoped bearers
  for the Terminal window (`terminal-window/credential-broker.ts`), stored with
  Electron `safeStorage` (`auth/credential-store.ts`).

## Spike results (throwaway, not committed)

1. Node 24's global `WebSocket` (the one Electron main uses) sends an
   `Authorization` header on the upgrade: `new WebSocket(url, { headers })`.
   The link therefore needs no query token. To re-check in Electron 41 in
   layer 3.
2. herdr-core's framed protocol runs unchanged over a WebSocket: a gateway-side
   client sent `hello`, `terminal.run`, `terminal.attach`, read live output and
   returned credit, against a real 0.1.22 core reached only through an
   outbound client that piped to its Unix socket. WebSocket messages do not
   align with frames; both ends use the incremental decoder.
3. A desktop-side filter that parses channel-0 JSON-RPC refused `machine.exec` and
   any call carrying `on` with a JSON-RPC error, without the core seeing it.

## Journey

1. **Pair on the desktop.** The person pairs the desktop with their primary
   computer through 2698's pairing dialog (Mac Pairing… on macOS, Pair This PC…
   on Windows, Pair This Desktop… on Linux, or from the Terminal window panel).
   Pairing opens the link. Off by default; never paired implicitly.
2. **See it on the computer.** Within 5 s the computer's Terminal app (Web
   Desktop, Web Canvas, Electron OS view) shows a **Desktops** group with
   "Hamed's MacBook Pro · macOS arm64 · Online", its terminals with status, and
   **New terminal** / agent presets (Claude, Codex, OpenCode, Pi). The Electron
   Terminal window lists the same terminals under "Desktop · Hamed's MacBook Pro".
3. **Use it.** Opening a terminal attaches live; typing, resize, paste and
   Herdr status work as with any Herdr terminal. Agents on the computer use
   `matrix shell machine run <desktop> -- …`, `read`, `send`, `kill`.
4. **Know it is on.** While the link is up, the desktop shows it: the Terminal
   window sidebar ("matrix-demo can use this device", with **Turn off**), the
   activity indicator on macOS, and the app menu's **Stop Computers Using This
   Device**. Terminals started from the computer carry the label
   `matrix.from=<computer>` (not shown as a separate tag in this stack).
5. **Switch off (desktop).** **Stop** in the activity indicator, **Turn off** in
   the Terminal window, or **Disconnect** in the pairing dialog closes the link
   at once (Disconnect also ends the pairing). The computer shows "off on the desktop". Terminals keep
   running on the desktop (like any Herdr terminal); the computer can no longer
   see or reach them. Switching on again needs no new confirmation for the same
   computer, but does need the person's click.
6. **Remove (computer).** The machine row's **Remove** (confirm) disconnects the
   pairing (`DELETE /api/desktop-pairing/:deviceId`, revision bump). The live link
   closes within 1 s and the desktop shows "Removed by matrix-demo"; reconnecting
   is refused until the person pairs again on the desktop.
7. **Sleep and networks.** Lid closed: the computer shows "offline · last seen
   2 min ago"; open viewers show "reconnecting". On wake the link is back
   within 5 s of network availability and viewers re-attach with history.

## Surfaces

| Surface | Scope in this spec |
| --- | --- |
| Electron Desktop (desktop side) | Enable, confirmation, status header, app-menu toggle, link client, desktop-side guard |
| Electron Desktop (computer side) | OS-view Terminal: Desktops group (open, new, agents, remove). Terminal window: each computer's section lists its linked desktop's terminals as a "Desktop · <name>" group and opens them; starting one there is a follow-up |
| Web Desktop | Terminal app Machines group, same actions |
| Web Canvas | Same component as Web Desktop |
| `matrix` CLI (and agents in the computer's terminals) | `matrix shell machine ls|terminals|run|read|send|kill` |
| Kernel tools, remote-computer MCP | Follow-on: they call the same routes |
| Web Mobile, Native Mobile | N/A in this stack: routes are shared; list/attach UI is a follow-on. Needs reviewer approval |

On the desktop itself, the computer's Desktops group leaves that desktop out
(it already shows those terminals as "This Computer"), using the device ids
of its pairing (`desktop-link:this-device`, both windows; no key is read).
A terminal started from the Desktops group opens at once.

Terminals on a desktop use their own workspace id per desktop in every `TerminalRef`:
`tws_000000000064736b` + the first 16 hex digits of the device id. Two desktops
never collide, and every OS view picks the `/ws/desktop-link/terminal` socket by
the id alone.

## Architecture

```
Browser / CLI / kernel ──► computer gateway ──(WS, desktop dialled out)──► Electron main ──► app's private herdr-core (Unix socket)
                           DesktopLinkRegistry       /ws/desktop-link             DesktopLinkGuard        terminals as the macOS user
                           HcConnection over link                         (allowlist filter)
```

### Link protocol (`/ws/desktop-link`)

One WebSocket per paired desktop and computer. Electron main dials
`wss://<computer route>/ws/desktop-link` with `Authorization: Bearer <computer-scoped
token>` (the credential broker's token for that computer, never a renderer
value). The same platform routing that serves `/ws/terminal/tab` today carries
it, for VPS and owned computers alike.

1. **Admission (text frames, JSON, Zod-validated, each ≤ 4 KiB).**
   - Gateway → `{"t":"challenge","nonce":<32 random bytes b64url>,"machineId":<machine id>}`.
   - desktop → `{"t":"proof","name","deviceId","revision","signature","app":{"version","os"},"device":{platform,arch,capabilities}}`.
     `sig` is Ed25519 over the domain-separated message
     `JSON.stringify(["matrix-desktop-link-v1", ownerId, computerMachineId, deviceId, revision, nonce])`,
     built by the shared proof helper (see Device identity).
   - Gateway reads `desktop_pairings` through 2698's `DesktopPairingRepository`:
     the proof's device must be the paired device at exactly the current
     revision (`readRegisteredKey(deviceId, revision)`), and the signature must
     verify against that key. The upgrade is admitted only for the bearer the
     pairing routes accept (verified runtime bearer, owner principal from `jwt` or
     `platform-verified`). Then `{"t":"ready"}`. Any
     failure closes with a coarse code (`4401` auth, `4403` revoked or
     disabled, `4409` replaced, `4429` rate limited) and no detail.
   - Admission must finish within 10 s of the upgrade.
2. **Core bytes (binary frames).** After `ready`, binary messages in both
   directions are an opaque herdr-core byte stream, exactly what `herdr-core
   connect` would carry. The gateway is the herdr-core client (handshake,
   calls, attach, credit); the desktop pipes to its private core socket.
3. **Core streams.** The herdr-core client opens and closes connections over
   time (it idles one out after 60 s and reconnects after a core restart), so
   the link carries numbered streams, one at a time: gateway
   `{"t":"open","stream":n}` → the desktop connects to its core socket and pipes;
   gateway `{"t":"close","stream":n}` or desktop `{"t":"end","stream":n}` ends it.
   The two directions are ordered separately, so each direction marks its own
   switch: gateway → desktop binary after `open(n)` belongs to `n` (the desktop queues
   it until its core connection is up); desktop → gateway binary belongs to `n`
   only after the desktop's `{"t":"opened","stream":n}`, which the desktop sends after
   it stopped piping every earlier stream. The gateway drops desktop bytes that
   arrive between its `open(n)` and that `opened(n)`, so a late reply from an
   old stream never reaches a new handshake.
4. **Control (text frames).** `ping`/`pong` every 15 s from both ends;
   `{"t":"bye","reason":...}` before a clean close (desktop: `disabled`,
   `signed-out`, `quit`; gateway: `removed`, `shutdown`); the close code, not the
   reason, decides what happens next. Screenshots: `capture` → `capture-part`
   (≤ 48 KiB of base64 each, ≤ 8 MiB in all) or `capture-failed`
   (`permission` | `declined` | `unavailable` | `failed` | `too_large`).

### desktop-side guard (`desktop/src/main/desktop-link/guard.ts`)

The desktop never trusts the computer beyond "may run terminals". The guard
terminates the protocol on both sides and denies by default; each core stream
gets a fresh guard on its own connection to the core.

- **The handshake is the guard's.** On connecting, the guard sends the core the
  one fixed `{"method":"hello","params":{"framed":true}}` line, exactly what the
  Herdr client sends, and writes nothing else, not even its own questions,
  until the core answers that hello with `framed: true` at protocol generation 1.
  Anything else ends the stream with nothing more written; bytes waiting for the
  handshake are capped at 1 MiB. The computer's own first line must be exactly
  `hello` with `framed: true` (≤ 64 KiB); the guard answers it with the core's
  version and features and only the four methods below, and never forwards it.
- **Channel 0** carries JSON-RPC. The guard accepts exactly the four calls the
  computer's Herdr session host makes (`HERDR_SESSION_METHODS`,
  `DESKTOP_LINK_METHODS` in contracts), each through a strict schema that lists
  every allowed parameter:

| Method | Allowed parameters |
| --- | --- |
| `terminal.list` | none |
| `terminal.run` | `argv` (1-64 entries, each ≤ 4 KiB) or `line` (≤ 16 KiB), never both; `cwd`, which must resolve (realpath) inside the user's home; `name`; `size`; `env` from `TERM`, `COLORTERM`, `LANG`, `LC_*`; `no_parent: true`, `no_notify: true`, `wait: false` |
| `terminal.attach` | `terminal` (a local address `tN`), `cols`, `rows`, `history`, `observe` |
| `terminal.kill` | `terminal` (a local address `tN`) |

A call with any other method, any other parameter (top level or nested), an
address on another machine (`vps/t1`) or a name instead of an address is
answered `denied` and never reaches the core: `machine.*`, `file.*`, `doc.*`,
`server.*`, `templates.*`, `events.subscribe`, `terminal.get/read/wait/send/keys/
interrupt/rm/label/put*`, a framed `hello`. Notifications are dropped. A call
that reaches the core is rebuilt from what the schema parsed, nothing is spread
from the request, and goes under a call id the guard owns (the computer's id
goes back on the answer). A start is fixed as `keep: false`, `no_parent: true`,
`no_notify: true`, `wait: false`, labelled `matrix.from` with the paired
computer's name: it never becomes a shell when its program ends, and never
reports into another terminal. At most 256 calls wait for the core per stream.
Oversized requests (channel 0 payload > 256 KiB) or malformed JSON close the
stream. `env` values are plain words (≤ 64 characters), and a `name` never looks
like an address.

- **Other channels** carry a terminal's bytes. A frame from the computer passes,
  rebuilt, only on a channel the guard saw the core open in answer to an attach
  it forwarded, and only as data, credit, resize or close; a close forgets the
  channel. A frame on any other channel, or of another kind, closes the link.
  The core's own bytes for channels the computer was not given stay on the
  desktop.

Answers are rebuilt too. The core's handshake offers only the four methods and
drops the core's id, name and login details. A listing carries each local
terminal's address, state, title and status, never its program, arguments,
folder or screen, and leaves out terminals on machines the core reaches. A start
answers with the address and state, an attach with its channel, a failure with
its kind only. Anything else the core sends on channel 0 stays on the desktop.

Before an attach or kill of a terminal it does not already cover, and before a
start with `argv`, the guard asks the core itself (`terminal.list`,
`templates.list`) under its own ids; those answers never reach the computer.

The guard runs in Electron main, next to the core's socket, so a compromised
or buggy gateway still cannot reach the desktop's ssh machines, files or settings
through Herdr's API. Terminals themselves are full shell access by design, and
the confirmation says so.

### Gateway side (`packages/gateway/src/desktop-link/`)

- **`DesktopLinkRegistry`**: live links by `deviceId`, one per device (a new
  admitted link replaces the old, which closes with `4409`). Holds one
  `HcConnection` per link from `packages/herdr-core-client`'s `connectHc`,
  given a socket adapter over the WebSocket, with acceptance
  `acceptsDesktopCore` (0.1.x from the pinned desktop version's minimum, features
  `framed`, `attach`, `shell`, `events`).
- **Reuse 2701's adapter**: each admitted link gets its own
  `createHerdrAdapter({ open })` (ENG-519, `packages/gateway/src/herdr/adapter.ts`),
  whose `open()` returns an `HcSocket` over the link instead of a
  `herdr-core connect` child. Listing, attach, credit backpressure, viewer caps,
  idle sweep and the browser attach socket (`herdr/ws.ts`) are reused per desktop,
  not rewritten. The desktop terminal routes below are thin wrappers that pick the
  adapter by `deviceId`.
- **Second allowlist**: the gateway wraps the connection with
  `restrictHcConnection` (2701) using the same method list, so it never even
  tries what the desktop would refuse.
- **Store**: no table of its own. Pairing state is 2698's `desktop_pairings`
  (revision-fenced, single statements). The pairing routes notify the registry
  after a pair or disconnect commits (an in-process `onPairingChanged(state)`
  passed in at startup), and the registry also re-reads the pairing before each
  new core stream and screenshot, so a missed notice cannot keep a revoked link
  working. Name, system and last seen are the nullable D3 columns.
- **Agents on the computer**: the local terminal token (2692) is accepted on
  the desktop terminal routes and the machine list only, from a direct loopback
  caller, so an agent in one of the computer's terminals can use
  `matrix shell machine …`. Pairing, removing and the link socket still need
  the owner's signed-in session.

### Device identity

2698's, unchanged: `createPairingKeyStore(userData, safeStorage)` in
`desktop/src/main/desktop-pairing/key-store.ts`, scope `{ ownerId, origin }`,
Ed25519 encrypted with `safeStorage`, device ID = SHA-256 of the SPKI bytes. The
link adds one signing domain beside 2698's enrolment and action proofs,
`desktopLinkProofMessage()` = `["matrix-desktop-link-v1", ownerId, machineId,
deviceId, revision, nonce]`, so no pairing or Chat-action signature can be replayed
as a link proof and the reverse.

## Security architecture

### Auth matrix

| Route | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `/api/desktop-pairing/*` | Electron main, owner shells | 2698, unchanged | Pair and disconnect; Remove in the Desktops group calls its `DELETE` |
| `GET /ws/desktop-link` | Electron main | Same gate as the pairing routes on upgrade + per-connection proof from the paired key at the current revision | Not in the query-token allowlist (header only; no browser can open it) |
| `GET /api/desktop-link/machines` | Owner shells, CLI, agents | Owner principal or local terminal token | Name, state, last seen, this computer's id; never keys |
| `GET /api/desktop-link/machines/:deviceId/terminals` | Owner shells, CLI, agents | Owner principal or local terminal token | |
| `POST /api/desktop-link/machines/:deviceId/terminals` | Owner shells, CLI, agents | Same | `bodyLimit` 96 KiB; `{cols, rows, agent? \| argv?, cwd?, name?}`; 10 per minute per desktop |
| `DELETE /api/desktop-link/machines/:deviceId/terminals/:address` | Owner shells, CLI, agents | Same | `bodyLimit` 1 KiB |
| `GET /api/desktop-link/machines/:deviceId/terminals/:address/screen?lines=` | CLI, agents | Same | ≤ 2,000 lines |
| `POST /api/desktop-link/machines/:deviceId/terminals/:address/input` | CLI, agents | Same | `bodyLimit` 96 KiB, ≤ 64 KiB of input |
| `POST /api/desktop-link/machines/:deviceId/terminals/:address/keys` | CLI, agents, Chat | Same | `bodyLimit` 1 KiB; named keys only |
| `POST /api/desktop-link/machines/:deviceId/terminals/:address/interrupt` | CLI, agents, Chat | Same | `bodyLimit` 1 KiB |
| `POST /api/desktop-link/machines/:deviceId/terminals/:address/wait` | CLI, agents, Chat | Same | `bodyLimit` 1 KiB; `{output?, timeoutMs?}` bounded by the terminal-wait maximum |
| `POST /api/desktop-link/machines/:deviceId/screenshot` | CLI, agents, Chat | Same | `bodyLimit` 1 KiB; 6 per minute per desktop; JPEG ≤ 8 MiB; owner approval or Full Access on the desktop |
| `GET /ws/desktop-link/terminal?workspaceId=&tabId=\|id=&lease=` | Owner shells | Owner principal; path added to `WS_QUERY_TOKEN_PATHS` | 2701's Herdr viewer socket per desktop; observe by default; write lease as `/ws/terminal/tab` |

Who can open a terminal on the desktop:

- **Allowed**, after the desktop's [consent](#consent): the owner principal of the computer the desktop is paired with, and
  that computer's own kernel and agents acting for the owner.
- **Refused**: org members, guests, ENG-570 collaborators, app-share or
  preview principals, platform operators, other computers of the same owner
  (each computer needs its own pairing), and any request without the owner
  principal. Collaboration and share scopes never resolve to `desktop-link` routes.
- **Sharing**: none in this stack. A later ENG-570 extension may let the owner
  share one *terminal* (never the machine) after an explicit, per-terminal
  confirmation on the desktop; that needs its own spec change and review.

### Input validation

- `deviceId`: `^[a-f0-9]{64}$`. Terminal address: herdr-core form
  `^t[0-9]{1,9}$` or label-addressed names per `hc schema`, ≤ 128 chars, no
  `/`. Machine name: `^[a-z0-9][a-z0-9._-]{0,31}$`.
- All bodies, query params and admission/control frames: Zod 4 schemas at the
  boundary, bounded strings and arrays. `terminal.run` body: `{argv?, cwd?,
  name?, agent?}`; `agent` maps to the fixed commands in `host.ts`
  (`AGENT_COMMANDS`); `cwd` is a path string the desktop validates.
- Names and titles from the desktop (device name, terminal titles, cwd) are
  untrusted: stripped of control and bidi characters and capped before storage
  or display.
- Browser attach frames reuse `TerminalTabClientFrameSchema`.

### Errors

Clients get coarse codes only: `desktop_offline`, `busy`, `not_found`, `denied`
(the desktop's guard or owner refused), `screen_recording_not_allowed`,
`screenshot_unavailable`, `screenshot_failed`. No herdr-core messages,
paths, versions, stderr or Postgres errors leave the gateway or Electron main;
details go to server-side logs with the device ID, never the bearer.

### Credentials

- The bearer travels only in the upgrade header from Electron main; never in a
  URL, log or renderer. The link closes at the bearer's `exp`; Electron
  reconnects with a fresh token from the broker.
- The private device key never leaves Electron main. Sign-out, an account or
  computer change closes links; the key stays encrypted for a later explicit
  re-pair, as in 2698.
- Nothing about the desktop (keys, names, terminals) is sent to the platform; the
  platform only routes the WebSocket.

## Chat and agents (Hamed, 2026-11-25)

A fresh agent on the computer, asked "do you see my desktop?", must find and use
the desktop without SSH or Tailscale.

- **Terminal pipeline.** Each linked desktop is one more workspace in 2692's
  terminal pipeline (`desktop-link/verb-runtime.ts`), under its desktop workspace id.
  `terminal_list` shows it with `machine: <name>`; `terminal_read`, `_send`,
  `_keys`, `_interrupt` and `_wait` reach it, and so do the generic
  `/api/terminal/workspaces/:ws/tabs/:tab/*` verbs. The owner gate there
  treats a desktop workspace like Herdr's: the owner's principal only, never
  preview delegation, and no project admission.
- **Kernel tools.** `desktop_list` (with platform, arch and capabilities),
  `desktop_run` (shell, agent preset or argv; the description names each OS's
  page opener) and `desktop_screenshot` (returns the image), present only
  when the desktop link is on.
- **Routes.** Besides list, start, read, input and end: `POST
  .../terminals/:address/{keys,interrupt,wait}` (2692 verbs, `bodyLimit` 1 KiB,
  strict schemas) and `POST /api/desktop-link/machines/:deviceId/screenshot`
  (JPEG, `no-store`). Starts are limited to 10 a minute and screenshots to 6
  a minute per desktop, shared by routes and the kernel.
- **Screenshots.** The gateway sends `{"t":"capture","id"}`. The desktop
  captures the primary screen with Electron's `desktopCapturer` in the main
  process (at most 1600 px on the long side, JPEG via `nativeImage`, 10 s),
  and answers with `capture-part` frames of at most 48 KiB of base64 each
  (8 MiB in all, 20 s), or `capture-failed` (`permission`, `unavailable`,
  `failed`, `too_large`). On macOS nothing is captured until Screen Recording
  is allowed (`systemPreferences.getMediaAccessStatus("screen")`), and the
  caller gets `screen_recording_not_allowed`; a Linux session that gives
  nothing to capture answers `screenshot_unavailable`. The skill turns either
  into one plain request to the person.
- **CLI.** `matrix shell machine keys|interrupt|wait|open|screenshot`.
- **Skill.** `skills/matrix/linked-desktop` (`matrix-linked-desktop`) teaches the
  above, and that SSH, Tailscale and `hc machine add` are not the path to the
  owner's desktop.

## Revocation

| Action | Effect | Bound |
| --- | --- | --- |
| Desktop: Stop (activity indicator) or Turn off | Link closed with `bye`; guard stops forwarding first; pairing kept; stays off until the person turns it on | Immediate (same tick) |
| Desktop: Disconnect (pairing dialog) | Link closed before the `DELETE` is sent (2698: grants end on confirm); revision bump | Immediate |
| Desktop: Revoke Full Access | Later actions need per-action approval again; link stays | Immediate |
| Computer: Remove | `DELETE /api/desktop-pairing/:deviceId`; registry closes the link `4403`; open viewers get `desktop_removed` | ≤ 1 s |
| Re-pair (new revision) | Old link and its grants closed; Full Access needs fresh consent | ≤ 1 s |
| Sign out, account or computer change | All links closed | Immediate |
| Owner credential revoked on the platform | Gateway refuses the next upgrade; live link ends at token `exp` | ≤ token lifetime |
| App quit | Socket closes; computer shows offline | Immediate |

A stopped or removed desktop never reconnects by itself. Terminals already
running on the desktop keep running; only the computer's access ends.

## Integration wiring

- **Gateway start** (`server.ts`): create `DesktopLinkRegistry({ pairing, now, caps })`
  over 2698's `DesktopPairingRepository` and pass its `onPairingChanged` to
  `createRuntimeDesktopPairingRoutes`; register
  `/api/desktop-link/*` and `/ws/desktop-link*` routes; add the browser attach pattern
  to `WS_QUERY_TOKEN_PATH_PATTERNS` and the route group to
  `server/route-inventory.ts`; register the desktop machines as a status source for
  the 2692 terminal-agent pipeline (verbs, events, attention).
- **Gateway shutdown**: registry sends `bye`, closes viewer sockets, closes
  `HcConnection`s, then links; the store is closed with the owner database by
  its owner, never by the registry.
- **Electron start** (`desktop/src/main/index.ts`): after auth and the local
  terminal host are ready, create `DesktopLinkService({ host, pairing, prefs,
  powerMonitor, net })` with 2698's `createDesktopPairing` (key store, pairing
  state, consent); it opens a link only while this desktop is paired and not
  stopped. IPC: `desktop-link:status`, `desktop-link:enable`, `desktop-link:disable` (validated
  Zod payloads, computer slot only); menu item wired through
  `platform/menu-template.ts`.
- **Cross-package**: the gateway and Electron share `packages/herdr-core-client`
  (2701 layer 2) and the allowlist constant in `packages/contracts`
  (`DESKTOP_LINK_METHODS`). No `globalThis`.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| desktop sleeps / network drops | Both ends miss pongs; link closed after 45 s. Gateway marks offline with `last_seen_at`; viewers show reconnecting. Electron reconnects on `powerMonitor` `resume` and `online` immediately, else 1 s → 30 s backoff with jitter |
| Cloudflare or proxy idle cut | 15 s pings stay under the 100 s idle limit |
| Gateway restarts | Links drop; Electron reconnects with backoff; no state lost (Postgres rows) |
| desktop core restarts or is upgraded | The desktop's core socket closes; the desktop sends `end` for that stream. The gateway's `HcConnection` for it ends (pending calls fail, attachments report `disconnected`). The adapter opens a new stream: a fresh core connection, a fresh guard and a fresh handshake, on the same WebSocket. Unsupported version → `desktop_unsupported` on the computer, "update Matrix OS" on the desktop |
| Two links for one device | Newer admitted link wins; older closed `4409` |
| Pair race, lost pair reply | 2698: revision-fenced statement; a fresh read reconciles; never resubmitted |
| Pairing changes during a link action | Registry re-reads pairing before each stream and capture; a mismatch closes the link `4403` |
| Slow viewer | herdr-core credit flow control stalls only that viewer's channel (credit returns only as the viewer's own socket drains, as in 2701's `herdr/ws.ts`); a browser viewer socket over its cap is closed alone |
| Slow or stuck link | The link's own WebSocket queue (shared by every channel) over 8 MiB on either end closes the whole link (`1008`); the desktop reconnects with backoff and viewers re-attach. Credit flow control keeps a healthy link far below this |
| Malformed or denied frames | Denied calls get errors; malformed JSON or a frame over its cap (checked as the header arrives) ends the stream; a frame on a channel the computer was not given closes the link |
| Paired, link never opens | Desktops group shows "Paired desktop · offline"; Remove still works |

### Deadlines

| Wait | Deadline | On expiry |
| --- | --- | --- |
| Upgrade → admission complete | 10 s | Close `4401` |
| herdr-core handshake over the link | 10 s | Close, retry with backoff |
| Each core call over the link | 75 s, from arrival (it may wait for the owner's approval, 60 s); a start queued behind others is never sent once its 75 s have passed, and the core gets only the time left | Call rejected `desktop_offline` |
| Owner's native approval | 60 s from the request's arrival | Counted as Don't Allow |
| Clients that may trigger an approval (shell, Electron, `matrix shell machine`) | 90 s | Error shown |
| Ping without pong | 45 s | Link closed |
| Link admission challenge | 10 s (admission deadline) | Close `4401` |
| HTTP calls from Electron | `AbortSignal.timeout(10_000)`, `redirect: "error"` | Error state in UI |

## Resource management

| Resource | Cap | Eviction |
| --- | --- | --- |
| Paired desktops per computer | 1 (2698, D1) | Pairing another asks to disconnect the first |
| Live links per computer | 1 (the paired desktop) | Replaced by a newer link of the same device; stale sweep every 15 s by last pong (45 s) |
| Admission attempts | 30 a minute per computer | Refused `4429` |
| Admission challenge | one nonce per connection, 10 s | Closed `4401` |
| Calls in flight per core stream (guard) | 256 | Further calls refused |
| Approvals waiting on the desktop | 1 on screen, 4 waiting | Further approvals refused |
| Remembered approved terminals | 256 per pairing revision | Oldest forgotten first |
| Windows core | 16 live terminals, 64 records, 8 viewers, 512 KiB history, 1 MiB credit, 2 MiB queue | Viewer dropped at 2 MiB or after a 10 s pause |
| Attachments per link | 32 (herdr-core-client `MAX_STREAMS`) | `busy` |
| Viewers per terminal / per owner | 8 / 32 | Oldest stale viewer evicted; shutdown drain |
| Pending calls per link | 64 | `busy` |
| `terminal.run` from the computer | 10 per minute per device | `busy` |
| Frame sizes | admission/control 4 KiB; channel-0 request 256 KiB; WS `maxPayload` 4 MiB | Close `1009` |
| Decoder buffer | 16 MiB (herdr-core frame cap) + one header | Close |

All Maps in the registry and the guard are bounded as above and cleared with
their link. No temp files.

## Acceptance

1. On a preview VPS, with Electron Desktop on a Mac signed in as the owner:
   enable for that computer, see the desktop online in the Web Desktop Terminal
   app within 5 s, open a new terminal there, run `uname -s` → `Darwin`, start
   Claude from the agent preset.
2. From a terminal on the computer, `matrix shell machine run <desktop> -- uname
   -s` then `matrix shell machine read <desktop> <id>` shows `Darwin`.
3. Choose Stop Computers Using This Device: the open viewer disconnects within
   1 s; new calls get `desktop_offline`; the terminal keeps running on the desktop.
4. Remove the desktop from the computer: the desktop shows it is no longer paired;
   turning it on again needs a fresh pairing; the old revision's proof is refused.
5. Sleep the desktop 2 minutes: computer shows offline; on wake the viewer
   re-attaches with history within 5 s of network.
6. With a forged gateway (test harness), `machine.exec`, `file.read`, any `on`
   call, `cwd` outside home and a framed `hello` are all refused by the desktop
   guard against the real pinned herdr-core.
7. An org member or collaborator principal gets `403` on every `desktop-link`
   route and cannot open `/ws/desktop-link/terminal`.
8. A fresh Claude on the test computer, asked "do you see my desktop?", runs
   `matrix shell machine ls`, opens a page on the desktop and takes a screenshot
   it then describes. Without Screen Recording permission it asks the person
   to allow it once instead of retrying.
9. With the platform mocked, a Windows desktop runs PowerShell, an argv
   program and an agent through the ConPTY core and the real guard, link and
   gateway adapter, refuses a folder outside the user's home by Windows path
   rules, and ends every terminal when the app quits. A Linux desktop that
   cannot capture its screen answers `screenshot_unavailable`.

## Surface matrix (target)

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass | pass | pass | pass | pass |
| Web Desktop | pass | pass | pass | pass | pass |
| Electron Desktop | pass | pass | pass | pass | pass |
| Web Mobile | N/A (follow-on) | N/A | N/A | N/A | N/A |
| Native Mobile | N/A (follow-on) | N/A | N/A | N/A | N/A |

## Testing

- Guard: table tests per method against the **real pinned herdr-core** in a
  temp runtime dir (as 2706 tests do), including the refused list.
- Registry and routes: real Hono app with the auth middleware, a real `ws`
  client playing the desktop, Postgres via the existing test database helper;
  auth matrix rows each have a red test (org member, collaborator, revoked
  device, wrong revision, replayed nonce, expired challenge).
- Fault injection: drop pongs, kill the core, replace a link, oversize frames.
- End to end: Electron `DesktopLinkService` against a local gateway and real core
  (layer 3), then live desktop + preview VPS (last layer).

## Delivery stack (GitHub native stack, ENG-574, ≤ 7 layers)

| # | PR | Main code |
| --- | --- | --- |
| 1 | Spec (this file; 2698 superseded notes) | specs |
| 2 | Gateway: `/ws/desktop-link` admission over 2698 pairing, link proof domain, registry, revocation hook in the pairing routes, `HcConnection` over the link | gateway, contracts |
| 3 | Electron: guard, `DesktopLinkService` on 2698's key store and pairing, consent and Full Access, activity kind, pairing on Linux and Windows | desktop |
| 4 | Gateway: desktop terminal routes, viewer socket, local-token access for agents, `matrix shell machine` | gateway, sync-client |
| 5 | Surfaces: Desktops group on Web Desktop, Web Canvas and Electron Desktop (Remove = pairing disconnect), Terminal window link state | ui, shell, desktop |
| 6 | Chat and agents: desktop terminals in the terminal pipeline, `desktop_list`/`desktop_run`, keys/interrupt/wait routes, CLI, skill | gateway, kernel, sync-client, skills |
| 7 | Platforms: OS, arch and capabilities; screenshots; `desktop_screenshot`; per-OS `open`; Windows ConPTY core and path rules | gateway, desktop, kernel, sync-client, ui |

Docs, live qualification fixes and the public site PR follow on the preview VPS
check. Follow-up stack (not ENG-574): retire 2698's terminal-check paths and
3-second polling, and move Mac Verification onto the link.

## Risks and open questions

1. **2698 overlap (ENG-495).** Resolved (Hamed, 2026-11-25): one system, see
   [One system with 2698](#one-system-with-2698-hamed-2026-11-25). Decisions D1 to
   D4 are decided there.
2. **Which terminals the computer sees. Decision (Hamed, 2026-11-24):** the
   computer sees every terminal in the desktop app's private core, including ones
   the person opened locally. It is the same owner, it matches Herdr's machine
   model (a machine shows all its terminals) and the current setup.
   *Rejected alternative:* only terminals the computer started (`matrix.from`
   filter in the guard). It hides local agents from the computer's agents and
   breaks parity. Left open for Nima's review comment; switching is a guard
   filter, not a protocol change. *Exposure (review):* listing needs no approval. The
   guard reduces it to each terminal's address, state, title and status; a title
   is the program's own and can say anything the program sets. Reading the
   screen, typing and ending need approval.
3. **Full shell access.** A terminal on the desktop is the signed-in user's shell. A
   compromised computer gateway can run anything the user can. Mitigations:
   pairing (2698) is the opt-in, the owner approves each start, screenshot and
   foreign terminal on the desktop, a visible indicator, instant off, guard
   limits to Herdr terminals. This is the core trade-off for review.
   *Full Access widens it (review):* with Desktop Link Full Access allowed, any
   process on the computer holding the owner's local terminal token (its agents,
   scripts and dev servers run as the same user) can start programs on the
   desktop without a prompt. The pairing dialog says so before the owner allows it.
   *An approved program reaches the core (review):* a program the owner approved
   runs as the desktop user, so it can open the desktop core's socket directly,
   outside the guard, and do anything the core allows (other terminals, added
   machines). The guard bounds what the computer asks for, not what an approved
   program does: approving a start is approving that program.
   *Folder checks race (review):* the guard resolves symlinks before the core
   changes into the folder; a process already on the desktop could swap a link
   in between. It already runs as the same user, so this adds nothing it could
   not do directly.
4. **Token lifetime as the platform-revocation bound.** If computer-scoped
   tokens live longer than 1 h, add a gateway re-validation tick.
5. **herdr-core version skew** between the desktop app and the computer's client:
   pinned 0.1.x range; an out-of-range core fails the stream's handshake and the
   desktop shows as unreachable (`desktop_offline`).
6. **Keychain prompt in development.** A fresh profile triggers the "Matrix OS
   Safe Storage" prompt; live qualification uses a profile that already holds
   access, or a dev-only key store, never approving a prompt on the owner's
   machine without the owner.
7. **Windows and Linux are not verified live.** There is no Windows or Linux
   desktop machine yet. The Windows core is tested in CI with a fake pty and
   end to end through the real guard, link and gateway adapter; the Linux path
   is the same herdr-core path as macOS. Each PR says so until someone runs
   them on real machines.
8. **node-pty in the Windows package.** It is a native module; the Windows
   build rebuilds it for Electron, and the macOS and Linux packages exclude
   it. A Windows build failure blocks only the Windows terminal path.
9. **Linux screenshots on Wayland.** desktopCapturer needs the desktop's
   screen-sharing portal; without it the answer is `screenshot_unavailable`.
