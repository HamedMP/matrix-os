# 2716 · Mac link: your Matrix computer runs terminals on your Mac

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
platform under 2707) can open Herdr terminals and start coding agents on that
person's Mac. The person's Electron Desktop app keeps one outbound,
owner-authenticated WebSocket to the computer's gateway. The gateway lists the
Mac as a machine in the Terminal app, the Terminal window and `matrix shell`,
and runs terminals on it through that link. The owner can switch the link off
on the Mac, or remove the Mac from the computer, and access ends at once.

There is no Tailscale, no `hc machine add`, no ssh and no listening port on the
Mac.

## Non-goals

- Anything on the Mac other than Herdr terminals: no file browsing, GUI input,
  screen capture, app control or ENG-495's Chat-approved checks (that stack
  stays separate).
- The person's own Herdr app and its herdr-core. Only the Electron app's
  private core (session `mx`, `desktop/src/main/local-terminals/host.ts`) is
  exposed.
- Machines reached onward from the Mac (the Mac core's own ssh machines).
- Windows and Linux desktop clients (the design is not macOS-specific, but v1
  is qualified on macOS only).
- Sharing a Mac with anyone else. ENG-570 shares single terminals; this spec
  adds no share path for Mac terminals (see Auth).

## Today (main @ `60e6b5b0a4`)

- Electron bundles a pinned herdr-core (`desktop/herdr-core.json`, shipped as
  `<resources>/herdr/hc`) and runs "This Computer" terminals in a private core
  over a Unix socket (`host.ts`, `hc-client.ts`, `hc-protocol.ts`). The core and
  its terminals outlive the app.
- Electron reaches *other* machines over ssh (`hc-machines.ts`,
  `ssh-command.ts`, `tailscale.ts`). The direction is always Mac → machine.
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
3. A Mac-side filter that parses channel-0 JSON-RPC refused `machine.exec` and
   any call carrying `on` with a JSON-RPC error, without the core seeing it.

## Journey

1. **Enable on the Mac.** In the Electron Terminal window, the "This Computer"
   header has **Let a Matrix computer use this Mac…**. The person picks one of
   their computers (from the inventory the Terminal window already loads). A
   confirmation says: "*matrix-demo* will be able to open terminals and run
   agents on this Mac as *hamed*. That is full shell access. You can switch it
   off here or from the app menu at any time." Confirm enrols the Mac with that
   computer and opens the link. Off by default; never enabled implicitly.
2. **See it on the computer.** Within 5 s the computer's Terminal app (Web
   Desktop, Web Canvas, Electron OS view) and its Terminal-window section show a
   **Machines** group with "Hamed's MacBook Pro · online", its terminals with
   status, and **New terminal** / agent presets (Claude, Codex, OpenCode, Pi).
3. **Use it.** Opening a terminal attaches live; typing, resize, paste and
   Herdr status work as with any Herdr terminal. Agents on the computer use
   `matrix shell run --machine <name> -- …`, `read`, `send`, `wait`.
4. **Know it is on.** While the link is up, the Mac shows it: the Terminal
   window header ("matrix-demo can use this Mac · 2 terminals open from it")
   and a checked **Matrix OS → Let matrix-demo Use This Mac** app-menu item.
   Terminals started from the computer carry the label
   `matrix.from=<computer>` and a small "from matrix-demo" tag.
5. **Switch off (Mac).** Unchecking the menu item or the header toggle closes
   the link at once. The computer shows "off on the Mac". Terminals keep
   running on the Mac (like any Herdr terminal); the computer can no longer
   see or reach them. Switching on again needs no new confirmation for the same
   computer, but does need the person's click.
6. **Remove (computer).** The machine row's **Remove** (confirm) revokes the
   enrolment. The live link closes within 1 s and the Mac shows "Removed by
   matrix-demo"; reconnecting is refused until the person enables it again on
   the Mac (a fresh enrolment).
7. **Sleep and networks.** Lid closed: the computer shows "offline · last seen
   2 min ago"; open viewers show "reconnecting". On wake the link is back
   within 5 s of network availability and viewers re-attach with history.

## Surfaces

| Surface | Scope in this spec |
| --- | --- |
| Electron Desktop (Mac side) | Enable, confirmation, status header, app-menu toggle, link client, Mac-side guard |
| Electron Desktop (computer side) | Terminal window computer section and OS-view Terminal: Machines group, open, new, agents, remove |
| Web Desktop | Terminal app Machines group, same actions |
| Web Canvas | Same component as Web Desktop |
| `matrix` CLI, kernel, remote-computer MCP | `--machine <name>` on `shell list/run/read/send/keys/wait/kill` |
| Web Mobile, Native Mobile | N/A in this stack: routes are shared; list/attach UI is a follow-on. Needs reviewer approval |

The Mac's own Electron app hides its own entry under the computer section (it
already shows those terminals as "This Computer").

## Architecture

```
Browser / CLI / kernel ──► computer gateway ──(WS, Mac dialled out)──► Electron main ──► app's private herdr-core (Unix socket)
                           MacLinkRegistry       /ws/mac-link             MacLinkGuard        terminals as the macOS user
                           HcConnection over link                         (allowlist filter)
```

### Link protocol (`/ws/mac-link`)

One WebSocket per enrolled Mac and computer. Electron main dials
`wss://<computer route>/ws/mac-link` with `Authorization: Bearer <computer-scoped
token>` (the credential broker's token for that computer, never a renderer
value). The same platform routing that serves `/ws/terminal/tab` today carries
it, for VPS and owned computers alike.

1. **Admission (text frames, JSON, Zod-validated, each ≤ 4 KiB).**
   - Gateway → `{"t":"challenge","nonce":<32 random bytes b64url>,"computer":<machine id>}`.
   - Mac → `{"t":"proof","deviceId","sig","app":{"version","os"},"name"}`.
     `sig` is Ed25519 over the domain-separated message
     `JSON.stringify(["matrix-mac-link-v1", ownerId, computerMachineId, deviceId, revision, nonce])`,
     built by the shared proof helper (see Device identity).
   - Gateway verifies the device is enrolled for this owner, not revoked, the
     revision matches and the signature is valid. Then `{"t":"ready"}`. Any
     failure closes with a coarse code (`4401` auth, `4403` revoked or
     disabled, `4409` replaced, `4429` rate limited) and no detail.
   - Admission must finish within 10 s of the upgrade.
2. **Core stream (binary frames).** After `ready`, binary messages in both
   directions are an opaque herdr-core byte stream, exactly what `herdr-core
   connect` would carry. The gateway is the herdr-core client (handshake,
   calls, attach, credit); the Mac pipes to its private core socket.
3. **Control (text frames).** `ping`/`pong` every 15 s from both ends;
   `{"t":"state","terminalsFromComputer":n}` gateway → Mac for the status
   header; `{"t":"bye","reason":"disabled"|"signed-out"}` before a clean close.

### Mac-side guard (`desktop/src/main/mac-link/guard.ts`)

The Mac never trusts the computer beyond "may run terminals". The guard
decodes every frame from the gateway with `HcFrameDecoder` and, on channel 0,
parses JSON-RPC and forwards only:

| Allowed method | Extra checks |
| --- | --- |
| `hello` | first frame only, `framed: true` |
| `terminal.list`, `terminal.get`, `terminal.read`, `terminal.wait`, `events.subscribe` | no `on`; no `terminal` address containing `/` |
| `terminal.run` | no `on`; `cwd` resolves (realpath) inside the macOS user's home; no `env` beyond an allowlist (`TERM`, `COLORTERM`, `LANG`, `LC_*`); `argv` ≤ 64 entries, each ≤ 4 KiB; label `matrix.from` forced to the enrolled computer name |
| `terminal.attach`, `terminal.send`, `terminal.keys`, `terminal.interrupt`, `terminal.kill`, `terminal.rm`, `terminal.label` | no `/` in the address; `terminal.label` may not change `matrix.from` |
| `terminal.put`, `terminal.put_begin/_chunk/_finish/_abort` | file ≤ 16 MiB, name per herdr-core rules (pasted images) |

Everything else is refused with a JSON-RPC `denied` error, without reaching the
core: `machine.*` (including `machine.exec`), `file.*`, `doc.*`, `server.*`,
unknown methods, a second `hello`, oversized requests (channel 0 payload
> 256 KiB), or malformed JSON (which closes the link). Stream frames on other
channels pass through; the core already rejects channels it did not open.
Calls the Mac core makes back to the computer (a child reporting to a parent on
the computer) pass the other way unchanged; the computer's core rules already
limit them.

The guard runs in Electron main, next to the core's socket, so a compromised
or buggy gateway still cannot reach the Mac's ssh machines, files or settings
through Herdr's API. Terminals themselves are full shell access by design, and
the confirmation says so.

### Gateway side (`packages/gateway/src/mac-link/`)

- **`MacLinkRegistry`**: live links by `deviceId`, one per device (a new
  admitted link replaces the old, which closes with `4409`). Holds one
  `HcConnection` per link from `packages/herdr-core-client`'s `connectHc`,
  given a socket adapter over the WebSocket, with acceptance
  `acceptsMacCore` (0.1.x from the pinned desktop version's minimum, features
  `framed`, `attach`, `shell`, `events`).
- **Reuse 2701's adapter**: each admitted link gets its own
  `createHerdrAdapter({ open })` (ENG-519, `packages/gateway/src/herdr/adapter.ts`),
  whose `open()` returns an `HcSocket` over the link instead of a
  `herdr-core connect` child. Listing, attach, credit backpressure, viewer caps,
  idle sweep and the browser attach socket (`herdr/ws.ts`) are reused per Mac,
  not rewritten. The Mac terminal routes below are thin wrappers that pick the
  adapter by `deviceId`.
- **Second allowlist**: the gateway wraps the connection with
  `restrictHcConnection` (2701) using the same method list, so it never even
  tries what the Mac would refuse.
- **Store**: owner Postgres via Kysely, table `mac_link_devices`
  (`device_id` PK = SHA-256 of the SPKI public key, `owner_id`, `public_key`,
  `name`, `computer_label`, `revision`, `enrolled_at`, `revoked_at`,
  `last_seen_at`). Enrol and revoke are single statements with
  `WHERE revision = :base`; enrol is `INSERT … ON CONFLICT (device_id) DO
  UPDATE … WHERE mac_link_devices.revoked_at IS NOT NULL` so a live enrolment
  is never silently replaced.
- **Verbs**: a Mac terminal is addressed as machine `<name>` plus its herdr-core
  address. 2692 verbs and the kernel tools gain `machine`; `TerminalRef`
  callers that do not pass it are unchanged.

### Device identity

**One key module, shared with 2698 (ENG-495).** The Mac's device key is the
one 2698 (#3483) already defines; this spec adds no second key store:

- Key store: `desktop/src/main/desktop-pairing/key-store.ts`,
  `createPairingKeyStore(userData, safeStorage)` → `load` / `loadOrCreate`
  `({ ownerId, origin })`. Ed25519 created in Electron main, PKCS#8 private key
  encrypted with `safeStorage` (refuses `basic_text`), `0600` file under
  `userData/desktop-pairing/`, device ID = SHA-256 of the public SPKI bytes.
- Proof messages: `packages/contracts/src/desktop-pairing.ts`. Mac link adds
  `macLinkProofMessage()` beside `desktopPairingProofMessage()`, sharing the
  same domain-separated `proofMessage(domain, …)` helper with domain
  `matrix-mac-link-v1`, so a pairing or Chat-action signature can never be
  replayed as a link proof and the reverse.
- Enrolments stay per purpose: 2698 keeps `desktop_pairings` (one Mac per
  owner and computer, Chat actions); this spec keeps `mac_link_devices`. One
  key, two independent consents and revocations.
- Ownership: whichever PR merges first lands the module at that exact path;
  the other rebases onto it. Layer 2 (gateway) does not depend on it; layer 3
  (Electron) does.

## Security architecture

### Auth matrix

| Route | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `POST /api/mac-link/enrol/challenge` | Electron main | Owner bearer (computer-scoped JWT, `requireRequestPrincipal`, owner only) | `bodyLimit` 4 KiB; ≤ 5 live challenges per owner, 60 s TTL, single use |
| `POST /api/mac-link/enrol` | Electron main | Owner bearer + Ed25519 proof over the challenge | `bodyLimit` 8 KiB; ≤ 5 enrolled devices per owner |
| `GET /ws/mac-link` | Electron main | Owner bearer header on upgrade + per-connection challenge proof | Not in the query-token allowlist (header only; no browser can open it) |
| `GET /api/mac-link/machines` | Owner shells, CLI, kernel | Owner principal | Name, state, last seen; never keys |
| `DELETE /api/mac-link/machines/:deviceId` | Owner shells, CLI | Owner principal | `bodyLimit` 1 KiB, `If-Match: <revision>`, closes live link |
| `GET /api/mac-link/machines/:deviceId/terminals` | Owner shells, CLI, kernel | Owner principal | |
| `POST /api/mac-link/machines/:deviceId/terminals` | Owner shells, CLI, kernel | Owner principal | `bodyLimit` 64 KiB; run rate limit |
| `DELETE /api/mac-link/machines/:deviceId/terminals/:address` | Owner shells, CLI, kernel | Owner principal | `bodyLimit` 1 KiB |
| `POST /api/mac-link/machines/:deviceId/terminals/:address/{send,keys,interrupt}` | Owner CLI, kernel | Owner principal | `bodyLimit` 64 KiB |
| `GET /ws/mac-link/terminal?device=&terminal=&lease=` | Owner shells | Owner principal; query token pattern added to `WS_QUERY_TOKEN_PATH_PATTERNS` | observe by default; write lease as `/ws/terminal/tab` |

Who can open a terminal on the Mac:

- **Allowed**: the owner principal of the computer the Mac enrolled with, and
  that computer's own kernel and agents acting for the owner.
- **Refused**: org members, guests, ENG-570 collaborators, app-share or
  preview principals, platform operators, other computers of the same owner
  (each computer needs its own enrolment), and any request without the owner
  principal. Collaboration and share scopes never resolve to `mac-link` routes.
- **Sharing**: none in this stack. A later ENG-570 extension may let the owner
  share one *terminal* (never the machine) after an explicit, per-terminal
  confirmation on the Mac; that needs its own spec change and review.

### Input validation

- `deviceId`: `^[a-f0-9]{64}$`. Terminal address: herdr-core form
  `^t[0-9]{1,9}$` or label-addressed names per `hc schema`, ≤ 128 chars, no
  `/`. Machine name: `^[a-z0-9][a-z0-9._-]{0,31}$`.
- All bodies, query params and admission/control frames: Zod 4 schemas at the
  boundary, bounded strings and arrays. `terminal.run` body: `{argv?, cwd?,
  name?, agent?}`; `agent` maps to the fixed commands in `host.ts`
  (`AGENT_COMMANDS`); `cwd` is a path string the Mac validates.
- Names and titles from the Mac (device name, terminal titles, cwd) are
  untrusted: stripped of control and bidi characters and capped before storage
  or display.
- Browser attach frames reuse `TerminalTabClientFrameSchema`.

### Errors

Clients get coarse codes only: `mac_offline`, `mac_disabled`, `mac_removed`,
`mac_unsupported`, `busy`, `not_found`, `denied`. No herdr-core messages,
paths, versions, stderr or Postgres errors leave the gateway or Electron main;
details go to server-side logs with the device ID, never the bearer.

### Credentials

- The bearer travels only in the upgrade header from Electron main; never in a
  URL, log or renderer. The link closes at the bearer's `exp`; Electron
  reconnects with a fresh token from the broker.
- The private device key never leaves Electron main. Sign-out deletes the
  profile's link keys and closes links.
- Nothing about the Mac (keys, names, terminals) is sent to the platform; the
  platform only routes the WebSocket.

## Revocation

| Action | Effect | Bound |
| --- | --- | --- |
| Mac: header toggle or app-menu item off | Link closed with `bye`; guard stops forwarding before the close is sent; preference stored per computer | Immediate (same tick) |
| Mac: sign out, switch account, profile change | All links closed; keys deleted | Immediate |
| Computer: Remove machine | Row revoked (revision bump), live link closed `4403`, open viewers get `mac_removed` | ≤ 1 s |
| Owner credential revoked on the platform | Gateway refuses the next upgrade; live link ends at token `exp` | ≤ token lifetime (computer-scoped tokens, today ≤ 1 h) |
| App quit | Socket closes; computer shows offline | Immediate |

A disabled or removed Mac never reconnects by itself. Terminals already
running on the Mac keep running; only the computer's access ends.

## Integration wiring

- **Gateway start** (`server.ts`): create `MacLinkStore(kysely)` after the owner
  database; create `MacLinkRegistry({ store, now, caps })`; register
  `/api/mac-link/*` and `/ws/mac-link*` routes; add the browser attach pattern
  to `WS_QUERY_TOKEN_PATH_PATTERNS` and the route group to
  `server/route-inventory.ts`; register the Mac machines as a status source for
  the 2692 terminal-agent pipeline (verbs, events, attention).
- **Gateway shutdown**: registry sends `bye`, closes viewer sockets, closes
  `HcConnection`s, then links; the store is closed with the owner database by
  its owner, never by the registry.
- **Electron start** (`desktop/src/main/index.ts`): after auth and the local
  terminal host are ready, create `MacLinkService({ host, broker, keys, prefs,
  powerMonitor, net })`; it opens links only for computers whose preference is
  on. IPC: `mac-link:status`, `mac-link:enable`, `mac-link:disable` (validated
  Zod payloads, computer slot only); menu item wired through
  `platform/menu-template.ts`.
- **Cross-package**: the gateway and Electron share `packages/herdr-core-client`
  (2701 layer 2) and the allowlist constant in `packages/contracts`
  (`MAC_LINK_METHODS`). No `globalThis`.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Mac sleeps / network drops | Both ends miss pongs; link closed after 45 s. Gateway marks offline with `last_seen_at`; viewers show reconnecting. Electron reconnects on `powerMonitor` `resume` and `online` immediately, else 1 s → 30 s backoff with jitter |
| Cloudflare or proxy idle cut | 15 s pings stay under the 100 s idle limit |
| Gateway restarts | Links drop; Electron reconnects with backoff; no state lost (Postgres rows) |
| Mac core restarts or is upgraded | Guard reconnects to the socket once; the gateway handshake re-runs over the same link; unsupported version → `mac_unsupported` on the computer, "update Matrix OS" on the Mac |
| Two links for one device | Newer admitted link wins; older closed `4409` |
| Enrol race (two tabs, two clicks) | Revision-fenced statement; loser gets `conflict` and re-reads |
| Lost enrol reply | Electron re-reads `GET /api/mac-link/machines`-equivalent status before retrying |
| Slow viewer | herdr-core credit flow control stalls only that channel; WS `bufferedAmount` > 8 MiB on any side closes that viewer, not the link |
| Malformed or denied frames | Denied calls get errors; malformed JSON or a frame > cap closes the link (`1008`) |
| Partial enrol (row written, link never opens) | Row shows offline; harmless; removable |

### Deadlines

| Wait | Deadline | On expiry |
| --- | --- | --- |
| Upgrade → admission complete | 10 s | Close `4401` |
| herdr-core handshake over the link | 10 s | Close, retry with backoff |
| Each core call | 10 s (`terminal.wait`/`run --wait` use their own timeout + 10 s) | Call rejected `mac_offline` |
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
   enable for that computer, see the Mac online in the Web Desktop Terminal
   app within 5 s, open a new terminal there, run `uname -s` → `Darwin`, start
   Claude from the agent preset.
2. From a terminal on the computer, `matrix shell run --machine <mac> -- uname
   -s` then `matrix shell read` returns `Darwin`.
3. Uncheck the app-menu item: the open viewer shows "off on the Mac" within
   1 s; new calls get `mac_disabled`; the terminal keeps running on the Mac.
4. Remove the Mac from the computer: the Mac shows "Removed"; re-enable needs
   a fresh confirmation; old device proof is refused.
5. Sleep the Mac 2 minutes: computer shows offline; on wake the viewer
   re-attaches with history within 5 s of network.
6. With a forged gateway (test harness), `machine.exec`, `file.read`, any `on`
   call, `cwd` outside home and a second `hello` are all refused by the Mac
   guard against the real pinned herdr-core.
7. An org member or collaborator principal gets `403` on every `mac-link`
   route and cannot open `/ws/mac-link/terminal`.

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
  client playing the Mac, Postgres via the existing test database helper;
  auth matrix rows each have a red test (org member, collaborator, revoked
  device, wrong revision, replayed nonce, expired challenge).
- Fault injection: drop pongs, kill the core, replace a link, oversize frames.
- End to end: Electron `MacLinkService` against a local gateway and real core
  (layer 3), then live Mac + preview VPS (last layer).

## Delivery stack (GitHub native stack, ENG-574, ≤ 6 layers)

| # | PR | Main code |
| --- | --- | --- |
| 1 | Spec (this file) | specs |
| 2 | Gateway: store + migration, enrolment routes, `/ws/mac-link` admission, registry, `HcConnection` over the link | gateway, contracts |
| 3 | Electron: device keys, guard, `MacLinkService` (reconnect, sleep, toggle, menu, IPC) | desktop |
| 4 | Gateway: Mac terminal routes, browser attach WS, verbs/CLI/kernel `--machine` | gateway, sync-client, kernel |
| 5 | Surfaces: shared Machines group (packages/ui), Web Desktop/Canvas Terminal app, Electron Terminal window, Mac-side header and confirmation | ui, shell, desktop |
| 6 | Docs and live qualification fixes | docs, fixes |

Layer 2 needs `packages/herdr-core-client` (#3527). If it has not merged when
layer 2 starts, the stack bases on it or waits; it does not copy the client.

## Risks and open questions

1. **2698 overlap (ENG-495, Yuhan).** Resolved as above: one key module at
   `desktop/src/main/desktop-pairing/key-store.ts`, separate enrolments per
   purpose. Flagged on #3483 for Yuhan's agreement.
2. **Which terminals the computer sees. Decision (Hamed, 2026-11-24):** the
   computer sees every terminal in the Mac app's private core, including ones
   the person opened locally. It is the same owner, it matches Herdr's machine
   model (a machine shows all its terminals) and the current setup.
   *Rejected alternative:* only terminals the computer started (`matrix.from`
   filter in the guard). It hides local agents from the computer's agents and
   breaks parity. Left open for Nima's review comment; switching is a guard
   filter, not a protocol change.
3. **Full shell access.** A terminal on the Mac is the macOS user's shell. A
   compromised computer gateway can run anything the user can. Mitigations:
   off by default, per-computer opt-in, visible indicator, instant off, guard
   limits to Herdr terminals. This is the core trade-off for review.
4. **Token lifetime as the platform-revocation bound.** If computer-scoped
   tokens live longer than 1 h, add a gateway re-validation tick.
5. **herdr-core version skew** between the Mac app and the computer's client:
   pinned 0.1.x range; out-of-range shows `mac_unsupported`.
6. **Keychain prompt in development.** A fresh profile triggers the "Matrix OS
   Safe Storage" prompt; live qualification uses a profile that already holds
   access, or a dev-only key store, never approving a prompt on the owner's
   machine without the owner.
