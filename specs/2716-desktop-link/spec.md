# 2716 · Desktop link: your Matrix computer runs terminals on your Mac, Linux or Windows desktop

Status: draft for review. Requester and owner: Hamed. Suggested reviewer: Nima.
Linear: [ENG-574](https://linear.app/matrix-os/issue/ENG-574).
Related: [ENG-521](https://linear.app/matrix-os/issue/ENG-521) (Terminal window),
[ENG-524](https://linear.app/matrix-os/issue/ENG-524) / `specs/2707-owned-machines` (owned computers),
[ENG-570](https://linear.app/matrix-os/issue/ENG-570) / `specs/2710-team-terminals` (sharing),
[ENG-519](https://linear.app/matrix-os/issue/ENG-519) / `specs/2701-herdr-self-host` (gateway herdr-core client),
[ENG-495](https://linear.app/matrix-os/issue/ENG-495) / `specs/2698-mac-device-pairing` (device identity).
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

## Platforms (Hamed, 2026-11-25)

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Terminal core | Bundled herdr-core (darwin-arm64, darwin-x64) | Bundled herdr-core (linux-x64; the manifest pins linux-arm64 too, but no arm64 AppImage is built yet) | In-process ConPTY core via node-pty (herdr-core has no Windows build) |
| Default shell | Login shell | Login shell | PowerShell (`powershell.exe -NoLogo`) |
| Switch on | Terminal window panel | Terminal window panel | File menu: Let a Computer Use This Device… (native dialogs; Windows has no Terminal window) |
| Switch off | Panel, app menu | Panel, File menu | File menu |
| Screenshot | desktopCapturer; needs Screen Recording for Matrix OS | desktopCapturer; `screenshot_unavailable` where the session cannot be captured (some Wayland sessions) | desktopCapturer |
| Open a page | `/usr/bin/open` | `xdg-open` | `cmd.exe /c start "" <url>` |
| Verified live | Planned on Hamed's Mac | Not yet (no Linux desktop machine) | Not yet (no Windows machine) |

Each desktop reports `{platform, arch, capabilities: {terminals, screenshot,
input: false}}` in its proof on every connect. The gateway keeps the last
report with the enrolment, and `desktop_list`, `matrix shell machine ls`,
`open` and the Desktops group use it.

**Windows core.** A small in-process core speaks the part of herdr-core's
framed protocol the computer's Herdr adapter uses: the `hello` handshake,
`terminal.list`, `terminal.run`, `terminal.attach`, `terminal.kill`, and the
DATA, CREDIT, RESIZE and CLOSE stream frames. The guard sits in front of it
exactly as in front of herdr-core, and checks folders with Windows path rules.
Caps: 16 live terminals, 64 records, 8 viewers per terminal, 512 KiB of
history per terminal, a 1 MiB credit window per viewer (the program is
paused while any viewer is behind, a viewer 2 MiB behind is dropped). The
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

1. **Enable on the desktop.** In the Electron Terminal window, the "This Computer"
   header has **Let a Matrix computer use this device…**. The person picks one of
   their computers (from the inventory the Terminal window already loads). A
   confirmation says: "*matrix-demo* will be able to open terminals and run
   agents on this device as *hamed*. That is full shell access. You can switch it
   off here or from the app menu at any time." Confirm enrols the desktop with that
   computer and opens the link. Off by default; never enabled implicitly.
2. **See it on the computer.** Within 5 s the computer's Terminal app (Web
   Desktop, Web Canvas, Electron OS view) and its Terminal-window section show a
   **desktops** group with "Hamed's MacBook Pro · Online", its terminals with
   status, and **New terminal** / agent presets (Claude, Codex, OpenCode, Pi).
3. **Use it.** Opening a terminal attaches live; typing, resize, paste and
   Herdr status work as with any Herdr terminal. Agents on the computer use
   `matrix shell machine run <desktop> -- …`, `read`, `send`, `kill`.
4. **Know it is on.** While the link is up, the desktop shows it: the Terminal
   window sidebar ("matrix-demo can use this device · 2 terminals open from it",
   with **Turn off**), and the app menu always offers **Matrix OS → Stop
   Computers Using This device**.
   Terminals started from the computer carry the label
   `matrix.from=<computer>` and a small "from matrix-demo" tag.
5. **Switch off (desktop).** **Turn off** or the app-menu item closes
   the link at once. The computer shows "off on the desktop". Terminals keep
   running on the desktop (like any Herdr terminal); the computer can no longer
   see or reach them. Switching on again needs no new confirmation for the same
   computer, but does need the person's click.
6. **Remove (computer).** The machine row's **Remove** (confirm) revokes the
   enrolment. The live link closes within 1 s and the desktop shows "Removed by
   matrix-demo"; reconnecting is refused until the person enables it again on
   the desktop (a fresh enrolment).
7. **Sleep and networks.** Lid closed: the computer shows "offline · last seen
   2 min ago"; open viewers show "reconnecting". On wake the link is back
   within 5 s of network availability and viewers re-attach with history.

## Surfaces

| Surface | Scope in this spec |
| --- | --- |
| Electron Desktop (desktop side) | Enable, confirmation, status header, app-menu toggle, link client, desktop-side guard |
| Electron Desktop (computer side) | Terminal window computer section and OS-view Terminal: Machines group, open, new, agents, remove |
| Web Desktop | Terminal app Machines group, same actions |
| Web Canvas | Same component as Web Desktop |
| `matrix` CLI (and agents in the computer's terminals) | `matrix shell machine ls|terminals|run|read|send|kill` |
| Kernel tools, remote-computer MCP | Follow-on: they call the same routes |
| Web Mobile, Native Mobile | N/A in this stack: routes are shared; list/attach UI is a follow-on. Needs reviewer approval |

On the desktop itself, the computer's Desktops group leaves that desktop out
(it already shows those terminals as "This Computer"), using the device ids
saved at enrolment (`desktop-link:this-device`, both windows; no key is read).
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

One WebSocket per enrolled desktop and computer. Electron main dials
`wss://<computer route>/ws/desktop-link` with `Authorization: Bearer <computer-scoped
token>` (the credential broker's token for that computer, never a renderer
value). The same platform routing that serves `/ws/terminal/tab` today carries
it, for VPS and owned computers alike.

1. **Admission (text frames, JSON, Zod-validated, each ≤ 4 KiB).**
   - Gateway → `{"t":"challenge","nonce":<32 random bytes b64url>,"computer":<machine id>}`.
   - desktop → `{"t":"proof","deviceId","sig","app":{"version","os"},"name"}`.
     `sig` is Ed25519 over the domain-separated message
     `JSON.stringify(["matrix-desktop-link-v1", ownerId, computerMachineId, deviceId, revision, nonce])`,
     built by the shared proof helper (see Device identity).
   - Gateway verifies the device is enrolled for this owner, not revoked, the
     revision matches and the signature is valid. Then `{"t":"ready"}`. Any
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
   `{"t":"state","terminalsFromComputer":n}` gateway → desktop for the status
   header; `{"t":"bye","reason":...}` before a clean close (desktop: `disabled`,
   `signed-out`, `quit`; gateway: `removed`, `shutdown`).

### desktop-side guard (`desktop/src/main/desktop-link/guard.ts`)

The desktop never trusts the computer beyond "may run terminals". Each core
stream gets a fresh guard. herdr-core starts unframed: the client's first
message is one newline-terminated JSON-RPC `hello`. The guard therefore reads
that line first (at most 64 KiB, must be `{"method":"hello"}` with
`framed: true`, nothing else is forwarded until it is), passes it to the core,
and only then switches to `HcFrameDecoder` for the framed bytes that follow. On
channel 0 it parses JSON-RPC and forwards only:

| Allowed method | Extra checks |
| --- | --- |
| `hello` | only as the stream's first, unframed line, `framed: true` |
| `terminal.list`, `terminal.get`, `terminal.read`, `terminal.wait`, `events.subscribe` | no `on`; no `terminal` address containing `/` |
| `terminal.run` | no `on`; `cwd` resolves (realpath) inside the macOS user's home; no `env` beyond an allowlist (`TERM`, `COLORTERM`, `LANG`, `LC_*`); `argv` ≤ 64 entries, each ≤ 4 KiB; label `matrix.from` forced to the enrolled computer name |
| `terminal.attach`, `terminal.send`, `terminal.keys`, `terminal.interrupt`, `terminal.kill`, `terminal.rm`, `terminal.label` | no `/` in the address; `terminal.label` may not change `matrix.from` |
| `terminal.put`, `terminal.put_begin/_chunk/_finish/_abort` | file ≤ 16 MiB, name per herdr-core rules (pasted images) |

Everything else is refused with a JSON-RPC `denied` error, without reaching the
core: `machine.*` (including `machine.exec`), `file.*`, `doc.*`, `server.*`,
unknown methods, a framed `hello` (a stream handshakes once), oversized requests (channel 0 payload
> 256 KiB), or malformed JSON (which closes the link). Stream frames on other
channels pass through; the core already rejects channels it did not open.
Calls the desktop core makes back to the computer (a child reporting to a parent on
the computer) pass the other way unchanged; the computer's core rules already
limit them.

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
- **Store**: owner Postgres via Kysely, table `desktop_link_devices`
  (`device_id` PK = SHA-256 of the SPKI public key, `owner_id`, `public_key`,
  `name`, `computer_label`, `revision`, `enrolled_at`, `revoked_at`,
  `last_seen_at`). Enrol and revoke are single statements with
  `WHERE revision = :base`; enrol is `INSERT … ON CONFLICT (device_id) DO
  UPDATE … WHERE desktop_link_devices.revoked_at IS NOT NULL` so a live enrolment
  is never silently replaced.
- **Agents on the computer**: the local terminal token (2692) is accepted on
  the desktop terminal routes and the machine list only, from a direct loopback
  caller, so an agent in one of the computer's terminals can use
  `matrix shell machine …`. Enrolling, removing and the link socket still need
  the owner's signed-in session.

### Device identity

**One key module, shared with 2698 (ENG-495).** The desktop's device key is the
one 2698 (#3483) already defines; this spec adds no second key store:

- Key store: `desktop/src/main/desktop-pairing/key-store.ts`,
  `createPairingKeyStore(userData, safeStorage)` → `load` / `loadOrCreate`
  `({ ownerId, origin })`. Ed25519 created in Electron main, PKCS#8 private key
  encrypted with `safeStorage` (refuses `basic_text`), `0600` file under
  `userData/desktop-pairing/`, device ID = SHA-256 of the public SPKI bytes.
- Proof messages: `packages/contracts/src/desktop-pairing.ts`. Desktop link adds
  `desktopLinkProofMessage()` beside `desktopPairingProofMessage()`, sharing the
  same domain-separated `proofMessage(domain, …)` helper with domain
  `matrix-desktop-link-v1`, so a pairing or Chat-action signature can never be
  replayed as a link proof and the reverse.
- Enrolments stay per purpose: 2698 keeps `desktop_pairings` (one desktop per
  owner and computer, Chat actions); this spec keeps `desktop_link_devices`. One
  key, two independent consents and revocations.
- Ownership: whichever PR merges first lands the module at that exact path;
  the other rebases onto it. Layer 2 (gateway) does not depend on it; layer 3
  (Electron) does.

## Security architecture

### Auth matrix

| Route | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `POST /api/desktop-link/enrol/challenge` | Electron main | Owner bearer (computer-scoped JWT, `requireRequestPrincipal`, owner only) | `bodyLimit` 4 KiB; ≤ 5 live challenges per owner, 60 s TTL, single use |
| `POST /api/desktop-link/enrol` | Electron main | Owner bearer + Ed25519 proof over the challenge | `bodyLimit` 8 KiB; ≤ 5 enrolled devices per owner |
| `GET /ws/desktop-link` | Electron main | Owner bearer header on upgrade + per-connection challenge proof | Not in the query-token allowlist (header only; no browser can open it) |
| `GET /api/desktop-link/machines` | Owner shells, CLI, agents | Owner principal or local terminal token | Name, state, last seen, this computer's id; never keys |
| `DELETE /api/desktop-link/machines/:deviceId` | Owner shells | Owner principal | `bodyLimit` 1 KiB, `If-Match: "desktop-link-<machine>-<device>-<revision>"`, closes live link |
| `GET /api/desktop-link/machines/:deviceId/terminals` | Owner shells, CLI, agents | Owner principal or local terminal token | |
| `POST /api/desktop-link/machines/:deviceId/terminals` | Owner shells, CLI, agents | Same | `bodyLimit` 96 KiB; `{cols, rows, agent? \| argv?, cwd?, name?}`; 10 per minute per desktop |
| `DELETE /api/desktop-link/machines/:deviceId/terminals/:address` | Owner shells, CLI, agents | Same | `bodyLimit` 1 KiB |
| `GET /api/desktop-link/machines/:deviceId/terminals/:address/screen?lines=` | CLI, agents | Same | ≤ 2,000 lines |
| `POST /api/desktop-link/machines/:deviceId/terminals/:address/input` | CLI, agents | Same | `bodyLimit` 96 KiB, ≤ 64 KiB of input |
| `GET /ws/desktop-link/terminal?workspaceId=&tabId=\|id=&lease=` | Owner shells | Owner principal; path added to `WS_QUERY_TOKEN_PATHS` | 2701's Herdr viewer socket per desktop; observe by default; write lease as `/ws/terminal/tab` |

Who can open a terminal on the desktop:

- **Allowed**: the owner principal of the computer the desktop enrolled with, and
  that computer's own kernel and agents acting for the owner.
- **Refused**: org members, guests, ENG-570 collaborators, app-share or
  preview principals, platform operators, other computers of the same owner
  (each computer needs its own enrolment), and any request without the owner
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

Clients get coarse codes only: `desktop_offline`, `desktop_disabled`, `desktop_removed`,
`desktop_unsupported`, `busy`, `not_found`, `denied`. No herdr-core messages,
paths, versions, stderr or Postgres errors leave the gateway or Electron main;
details go to server-side logs with the device ID, never the bearer.

### Credentials

- The bearer travels only in the upgrade header from Electron main; never in a
  URL, log or renderer. The link closes at the bearer's `exp`; Electron
  reconnects with a fresh token from the broker.
- The private device key never leaves Electron main. Sign-out deletes the
  profile's link keys and closes links.
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
| desktop: header toggle or app-menu item off | Link closed with `bye`; guard stops forwarding before the close is sent; preference stored per computer | Immediate (same tick) |
| desktop: sign out, switch account, profile change | All links closed; keys deleted | Immediate |
| Computer: Remove machine | Row revoked (revision bump), live link closed `4403`, open viewers get `desktop_removed` | ≤ 1 s |
| Owner credential revoked on the platform | Gateway refuses the next upgrade; live link ends at token `exp` | ≤ token lifetime (computer-scoped tokens, today ≤ 1 h) |
| App quit | Socket closes; computer shows offline | Immediate |

A disabled or removed desktop never reconnects by itself. Terminals already
running on the desktop keep running; only the computer's access ends.

## Integration wiring

- **Gateway start** (`server.ts`): create `DesktopLinkStore(kysely)` after the owner
  database; create `DesktopLinkRegistry({ store, now, caps })`; register
  `/api/desktop-link/*` and `/ws/desktop-link*` routes; add the browser attach pattern
  to `WS_QUERY_TOKEN_PATH_PATTERNS` and the route group to
  `server/route-inventory.ts`; register the desktop machines as a status source for
  the 2692 terminal-agent pipeline (verbs, events, attention).
- **Gateway shutdown**: registry sends `bye`, closes viewer sockets, closes
  `HcConnection`s, then links; the store is closed with the owner database by
  its owner, never by the registry.
- **Electron start** (`desktop/src/main/index.ts`): after auth and the local
  terminal host are ready, create `DesktopLinkService({ host, broker, keys, prefs,
  powerMonitor, net })`; it opens links only for computers whose preference is
  on. IPC: `desktop-link:status`, `desktop-link:enable`, `desktop-link:disable` (validated
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
| Enrol race (two tabs, two clicks) | Revision-fenced statement; loser gets `conflict` and re-reads |
| Lost enrol reply | Electron re-reads `GET /api/desktop-link/machines`-equivalent status before retrying |
| Slow viewer | herdr-core credit flow control stalls only that viewer's channel (credit returns only as the viewer's own socket drains, as in 2701's `herdr/ws.ts`); a browser viewer socket over its cap is closed alone |
| Slow or stuck link | The link's own WebSocket queue (shared by every channel) over 8 MiB on either end closes the whole link (`1008`); the desktop reconnects with backoff and viewers re-attach. Credit flow control keeps a healthy link far below this |
| Malformed or denied frames | Denied calls get errors; malformed JSON or a frame > cap closes the link (`1008`) |
| Partial enrol (row written, link never opens) | Row shows offline; harmless; removable |

### Deadlines

| Wait | Deadline | On expiry |
| --- | --- | --- |
| Upgrade → admission complete | 10 s | Close `4401` |
| herdr-core handshake over the link | 10 s | Close, retry with backoff |
| Each core call | 10 s (`terminal.wait`/`run --wait` use their own timeout + 10 s) | Call rejected `desktop_offline` |
| Ping without pong | 45 s | Link closed |
| Enrol challenge | 60 s | Discarded |
| HTTP calls from Electron | `AbortSignal.timeout(10_000)`, `redirect: "error"` | Error state in UI |

## Resource management

| Resource | Cap | Eviction |
| --- | --- | --- |
| Enrolled devices per owner | 5 | Enrol refused until one is removed |
| Live links per owner | 5 (one per device) | Replace by device; stale sweep every 30 s by `lastPong` |
| Challenges | 5 per owner, 100 total | 60 s TTL sweep |
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
3. Choose Stop Computers Using This device: the open viewer shows "off on the desktop" within
   1 s; new calls get `desktop_disabled`; the terminal keeps running on the desktop.
4. Remove the desktop from the computer: the desktop shows "Removed"; re-enable needs
   a fresh confirmation; old device proof is refused.
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

## Delivery stack (GitHub native stack, ENG-574, ≤ 10 layers)

| # | PR | Main code |
| --- | --- | --- |
| 1 | Spec (this file) | specs |
| 2 | Gateway: store + migration, enrolment routes, `/ws/desktop-link` admission, registry, `HcConnection` over the link | gateway, contracts |
| 3 | Electron: device keys, guard, `DesktopLinkService` (reconnect, sleep, toggle, menu, IPC) | desktop |
| 4 | Gateway: desktop terminal routes, viewer socket, local-token access for agents, `matrix shell machine` | gateway, sync-client |
| 5 | Surfaces: desktop-side controls (Terminal window, confirmation, app menu, IPC) and the shared Desktops group on Web Desktop, Web Canvas and Electron Desktop | ui, shell, desktop |
| 6 | Chat and agents: desktop terminals in the terminal pipeline, `desktop_list`/`desktop_run`, keys/interrupt/wait routes, CLI | gateway, kernel, sync-client |
| 7 | Platforms: each desktop's OS, arch and capabilities; screenshots through desktopCapturer; `desktop_screenshot`; per-OS `open`; the `matrix-linked-desktop` skill | gateway, desktop, kernel, sync-client, ui, skills |
| 8 | Windows: the ConPTY core, Windows path rules in the guard, the File menu switch, node-pty in the Windows package | desktop |
| 9 | Live qualification fixes, repo docs; plus a separate public documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` (enable, switch off, remove, Screen Recording, per-OS notes) | docs, fixes, site |

Layer 2 needs `packages/herdr-core-client` (#3527). If it has not merged when
layer 2 starts, the stack bases on it or waits; it does not copy the client.

## Risks and open questions

1. **2698 overlap (ENG-495, Yuhan).** Resolved as above: one key module at
   `desktop/src/main/desktop-pairing/key-store.ts`, separate enrolments per
   purpose. Flagged on #3483 for Yuhan's agreement.
2. **Which terminals the computer sees. Decision (Hamed, 2026-11-24):** the
   computer sees every terminal in the desktop app's private core, including ones
   the person opened locally. It is the same owner, it matches Herdr's machine
   model (a machine shows all its terminals) and the current setup.
   *Rejected alternative:* only terminals the computer started (`matrix.from`
   filter in the guard). It hides local agents from the computer's agents and
   breaks parity. Left open for Nima's review comment; switching is a guard
   filter, not a protocol change.
3. **Full shell access.** A terminal on the desktop is the signed-in user's shell. A
   compromised computer gateway can run anything the user can. Mitigations:
   off by default, per-computer opt-in, visible indicator, instant off, guard
   limits to Herdr terminals. This is the core trade-off for review.
4. **Token lifetime as the platform-revocation bound.** If computer-scoped
   tokens live longer than 1 h, add a gateway re-validation tick.
5. **herdr-core version skew** between the desktop app and the computer's client:
   pinned 0.1.x range; out-of-range shows `desktop_unsupported`.
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
