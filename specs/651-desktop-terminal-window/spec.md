# Feature Specification: Electron Desktop Terminal Window

**Feature Branch**: `spec/desktop-terminal-window`
**Created**: 2026-11-10
**Status**: Draft — slices 1–3 shipped (PRs #3249–#3253); Herdr sessions (J6) amended 2026-11-10, awaiting owner review; see Implementation Status
**Tracking**: [ENG-443](https://linear.app/matrix-os/issue/ENG-443/electron-desktop-terminal-window-local-and-all-matrix-computers)
**Input**: "A terminal app in the Electron Desktop client, separate from the OS-view Terminal, launched from the top bar in its own window. Like herdr, it shows spaces across machines: this computer and every Matrix computer the user has. Ideally the app can also SSH to the remote computer."

## Implementation Status (2026-11-10)

| Slice | State |
| --- | --- |
| 1 Window shell | Implemented and exercised in the built app (macOS arm64). |
| 2 Per-computer credentials and tabs | Implemented. Attach is exercised in the built app for the selected computer; minting for a second computer is covered by unit tests only. |
| 3 Local terminals | Runtime implemented and exercised in the built app with a developer-supplied `hc` 0.1.19. The pinned binary (`desktop/herdr-core.json`) is fetched, checksum-verified and packed into macOS and Linux builds by the release workflow; an unsigned local package was checked, a signed and notarized one has not been built yet. See `research.md`. |
| 4 Status | Local status from herdr-core's stored reports and a local "Needs attention" list. Matrix tab status and a shared parser are not started. |
| 5–6 SSH | Not started. Open questions 7–10 now have proposed answers; each keeps one check on a real Matrix computer (see Open Questions). |
| 7–8 Herdr sessions (J6) | Spike passed on Linux (`research.md`). The transport-independent main-process core is implemented with tests; the SSH transport, IPC and UI wait for slices 5–6 and owner decisions 6–8. |

Known gaps against this spec, to close before the pinned `hc` version is ever changed:

- **No "Restart local terminals" action.** A holder of another version is detected and reported, but the user is not yet offered the restart described under Local Backend. With one pinned version in the field this state cannot occur; it will on the first version bump.
- **No runtime checksum of the binary.** The archive checksum is verified at build time, and the binary ships inside the signed, notarized macOS app or the read-only Linux AppImage. The per-app-version check before first spawn is not implemented.
- **Matrix tab status** and the shared OSC 7501 parser are not started.

## Goal

Give Electron Desktop users on macOS and Linux one native window that shows
local terminals and Matrix cloud terminals together, grouped by machine:
- **This Computer**: local shells, held by herdr-core (`hc`) so they survive an app restart.
- **Each Matrix computer** in their inventory: the existing Zellij-backed workspaces and tabs.

For Matrix computers, the new work is showing all computers at once instead of
only the selected one. Local terminals and a later direct-SSH transport are new.

Each Matrix computer also gets a second group, **Herdr sessions**: the terminals
held by herdr-core on that computer, which are the same ones the Herdr app shows
for it. A terminal started in either app appears in the other (J6).

## Owner Decisions (2026-11-10)

1. **Launcher**: a terminal icon in the Electron Desktop top bar opens the Terminal window, or focuses it if it is already open.
2. **Local backend**: herdr-core `hc` is the local holder, and local terminals must survive an app restart. It still has to pass a qualification spike first, because Core is a 0.1.x preview. `node-pty` in the main process is the fallback only if that spike fails.
3. **SSH endpoint**: the device connects directly to the computer's public address on port 22. There is no gateway tunnel.
4. **Platforms**: macOS and Linux only. Windows is out of scope.
5. **Herdr sessions over SSH** (added 2026-11-10): each Matrix computer in the Terminal window gets a "Herdr sessions" group next to its Zellij workspaces. It talks, over SSH, to the herdr-core that the Herdr app itself uses on that computer. Accepted trade-off: these terminals do not appear in Web Desktop, Web Canvas, the mobile apps or `matrix shell list`. Having the gateway list herdr terminals was considered and set aside; it is reopened only if this design cannot work.

Proposed in this amendment and still to be confirmed by the owner (see Open Questions 12–14):

6. **Identity**: Herdr sessions use the Matrix-managed device key of J5 and log in as the `matrix` user. The app does not borrow the user's SSH configuration, agent or Herdr machine list.
7. **SSH client**: the `ssh2` library in the Electron main process, not the system OpenSSH binary.
8. **herdr-core on the computer**: the app uses whatever herdr-core the user has installed there and never installs or updates it.

## Verified Current State

Each claim was checked in this worktree at `edd982c69`.

| Fact | Evidence |
| --- | --- |
| The desktop opens one `BrowserWindow`; events go only to `mainWindow`. | `desktop/src/main/index.ts:115,163-169,181` |
| No `node-pty`, `ssh2` or herdr dependency in the desktop. xterm 6 and its addons are present. | `desktop/package.json:50-54` |
| The shared IPC `handle()` wrapper validates payloads with Zod but does not check the sender itself. A few handlers check `event.senderFrame === mainWindow.mainFrame`. | `desktop/src/main/ipc/handlers.ts:188-198`, `desktop/src/main/index.ts:323-326` |
| The renderer never holds the credential. The main process injects one `Authorization` bearer for the active gateway origin only. | `desktop/src/main/auth/header-injection.ts:1-5,143-155` |
| Credentials are scoped to one computer. `selectRuntime` swaps the stored credential and profile using `POST /api/auth/runtime-selection`, which issues a JWT bound to `(handle, runtimeSlot)`. | `desktop/src/main/auth/auth-service.ts:405-461`, `packages/platform/src/computer-routes.ts:203-308` |
| Platform routing prefers the token's slot over the request's `runtime=` query, so one token cannot reach another computer. | `packages/platform/src/session-routing-middleware.ts:848` |
| Runtime selection is rate-limited per principal (30/min) and per source (60/min). | `computer-routes.ts:40-41`, `request-admission.ts:6` |
| The inventory is `GET /api/auth/computers`, at most 20 items, with `selectedSlot` derived from the bearer. | `computer-routes.ts:35,141-198`; `packages/contracts/src/index.ts:346-405` |
| The renderer store `useRuntimeComputers` lists computers and switches one selection. | `desktop/src/renderer/src/stores/runtime-computers.ts` |
| The Electron OS-view Terminal (`TerminalsTab`, used by Mission Control) attaches through a singleton `AttachManager`: one live socket app-wide, with an LRU of 8 serialized buffers. | `features/terminal/attach-manager.ts:1-4,7`, `terminal-runtime.ts` |
| Tabs are opened at `/ws/terminal/tab?workspaceId&tabId&client=electron&lease=exclusive|observe…`. Gateway terminal REST lives under `/api/terminal/workspaces`. Query tokens are allowed for `/ws/terminal/tab`. | `lib/shell-socket.ts:313-327`; `packages/gateway/src/shell/workspace-routes.ts:235-313`; `packages/gateway/src/auth.ts:113-118` |
| The agent status projection is `AgentSessionStateStore`. It is file-backed under `~/system/agent-sessions/`, keyed by session name, capped at 100 snapshots and 200 aliases, and fed by the agent hook bridge CLI. | `packages/gateway/src/shell/agent-session-state.ts:57-60,115-135`; `agent-session-bridge-cli.ts` |
| No tracked source handles OSC 7501. | `git grep 7501` finds only an unrelated commit hash in an evidence file. |
| Hetzner create sends `ssh_keys` (operator key `HETZNER_SSH_KEY_NAME`) and attaches no firewall. Servers have public IPv4/IPv6, which the platform records. | `packages/platform/src/customer-vps-hetzner.ts:193-204,279-294`; `customer-vps-config.ts:112` |
| cloud-init creates the system user `matrix` with no `ssh_authorized_keys`, runs `ssh-keygen -A`, links `/home/matrix/.ssh` to `/home/matrix/home/.ssh`, and writes no `sshd_config` or firewall. | `distro/customer-vps/cloud-init.yaml:6-13,452,611-621` |
| Golden-snapshot activation also runs `ssh-keygen -A`, so a rebuilt or cloned computer has new host keys. | `packages/platform/src/golden-snapshot-service.ts:359-360` |
| `matrix-support-access` manages a separate `matrix-support` user with one operator Ed25519 key. | `distro/customer-vps/host-bin/matrix-support-access:5-28` |
| No gateway, platform or shell route lets an owner register an SSH public key. | `git grep` for `authorized_keys`, `ssh-ed25519`, ssh API paths in `packages/gateway/src`, `packages/platform/src` and `shell/src` |

Not verified in this repo:
- The brief's live-VPS sshd sample (port 22 public, `PasswordAuthentication yes`, `ufw` inactive). It is one sample, not a fleet audit.
- herdr-core's CLI, socket, packaging and update behavior. These are spike items below.

## Affected Surfaces

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Electron Desktop (macOS, Linux) | pass required | pass required | pass required | pass required | pass required |
| Web Canvas | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Web Desktop | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Web Mobile | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Native Mobile | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |

\*Explicit platform limitation; needs reviewer approval. Rationale:
- A browser tab and the mobile apps cannot run a local holder process, hold a
  local PTY or open raw TCP/SSH, and they have no separate native window. "This Computer" and SSH are therefore only possible in Electron.
- Herdr sessions (J6) are reached over SSH with a device key held by the Electron
  main process, so they are Electron-only for the same reason. They are also a
  second terminal namespace on the computer: they are not Zellij tabs, and the
  owner accepted that no other surface lists them (owner decision 5).
- The cross-computer Matrix view needs many computer-scoped credentials held
  outside the renderer. Only the Electron main process has a trusted credential store.
- Matrix workspaces and tabs stay one source of truth in the owner's gateway. A
  tab created, renamed, closed or running in the new window must look the same in every
  surface's existing Terminal. Those surfaces need only regression evidence that
  shared tab state is unchanged; they get no new UI.

## User Journeys

### J1 — Open the Terminal window (P1)
The user clicks the terminal icon in the Electron Desktop top bar, or uses
**View → Terminal Window** (Cmd/Ctrl+Alt+Shift+T). A separate native window opens. If the window is already open,
the icon focuses it and does not open a second one. The sidebar shows local and
cloud terminals together: **This Computer** first, then each Matrix computer by
label, in inventory order. Each section shows its availability, workspaces and
tabs. The window's size, position, collapsed sections and last-focused tab persist across restarts.

**Acceptance**
1. Given a signed-in user with N≤20 computers, the window shows N Matrix sections plus This Computer within 3 s of a warm open. Each section loads independently, so one slow computer does not block the others.
2. Given an unavailable or stopped computer, its section shows its status and a retry. No error text leaks provider, path or token detail.
3. Given a signed-out app, the Matrix area shows a sign-in empty state, with headline, description and CTA, that hands off to the main window's sign-in. This Computer stays usable.
4. Closing the Terminal window kills neither a Matrix tab's command nor a local terminal, and never closes the main window.

### J2 — Work across Matrix computers (P1)
The user expands any computer, opens or creates a tab and types. They do not
switch the app's selected computer, so the main window keeps its current computer.

**Acceptance**
1. Attaching to a tab on computer B while the main window is on computer A leaves the main window's selection, credential and profile unchanged.
2. Tabs created, renamed, reordered or closed in the new window show in the OS-view Terminal on that computer (Electron, Web Desktop, Web Canvas), and the reverse, after the next list refresh. Neither client keeps a private copy of the tab list. On window focus, refresh targets must match the currently committed listings, including when focus arrives before passive effects; the refresh keeps visible tabs on screen and does not query unopened computers.
3. When two clients attach to the same tab, the existing `lease=exclusive|observe` contract applies. The new window shows writer and observer states. It does not take the lease silently.
4. When a computer's credential expires or is revoked (401), only that section returns to "reconnect". Other sections stay attached.

### J3 — Local terminals on This Computer (P1, gated on the herdr-core spike)
The user opens a shell on the laptop in the same window, with the same tab
model, keyboard handling, copy/paste and theme as remote tabs. Local terminals
are held by an `hc` holder process outside the app.

**Acceptance**
1. A new local tab starts the user's login shell in their home directory. Its environment is built from an allowlist (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_*`, `TERM`, `COLORTERM`, `TMPDIR`, `SSH_AUTH_SOCK`, `XDG_*`) and the login shell's own startup files. Nothing else from the Electron process environment is passed, in particular no `MATRIX_*`, `ELECTRON_*`, `NODE_*`, `VITE_*`, `POSTHOG_*`, `CLERK_*` or token-bearing variables.
2. Quitting and relaunching the app (including after a crash) reattaches every local terminal that was alive, with its process still running. If the holder process itself dies, its terminals end and the UI shows them as ended; the app does not use herdr's `keep` recovery, because a shell herdr starts on its own would inherit the core's isolation variables (see `research.md`).
3. Local terminal output and input never leave the device. They are never sent to a Matrix computer or to analytics. The Terminal window loads no analytics capture, session replay or console capture, and its terminal surfaces carry `ph-no-capture`.
4. If `hc` is missing, damaged or the wrong version, This Computer shows a recovery state (§Failure Modes). Matrix sections are unaffected.

### J4 — Cross-machine attention (P2)
A tab whose agent is waiting for input shows a badge in its machine section. A
window-level **Needs attention** list collects these across all machines.

**Acceptance**
1. A Matrix tab's status comes from the existing `AgentSessionStateStore` projection for that computer, the same one the OS-view Terminal shows. No second Matrix projection is introduced.
2. A local tab's status uses the same event schema and visual-status derivation, held in memory in the Electron main process. It is never written to any Matrix computer.

### J5 — Direct SSH to a Matrix computer (P3, later slice)
The user enables "Direct SSH" for one computer. The app registers this device's
public key. On each connection attempt it fetches the computer's public address
and host key fingerprint from the authenticated owner route, then connects
straight to port 22 for a shell or a port forward.

**Acceptance**
1. The private key is generated on the device and never leaves it. Only the public key is sent.
2. Every attempt uses freshly fetched address and fingerprint data. The connection proceeds only if the presented host key matches that fingerprint. On a mismatch, the connection is blocked with a "computer identity changed" state. The app never offers a "trust anyway" prompt and never uses a cached address.
3. A rebuilt computer, with a new address or host key, is reached on the next attempt without manual steps, provided the device key is registered again (§Failure Modes).
4. Sign-out, device removal or revocation from another device removes the key from the computer's `authorized_keys`. Hand-added keys are untouched. Sign-out also destroys the device private key; the next sign-in generates a new one.
5. Port forwards listen on loopback only (`127.0.0.1` and `::1`), never on other interfaces. At most 8 forwards per computer; each closes when its SSH session ends or the Terminal window closes.

**Rationale for direct connection (owner decision 3)**:
- Port 22 is already publicly reachable.
- The owner can already learn their computer's address from inside their own terminal.
- A gateway tunnel would remove SSH's benefits (independence from gateway health, native port forwarding) and add a relay surface to secure and operate.

**Consequence**: any future fleet firewall must keep port 22 reachable for
owner device keys, or this slice must be revisited.

### J6 — Herdr sessions on a Matrix computer (P2, after slices 5–6)
The user expands a Matrix computer and sees two groups: its Zellij workspaces
(J2) and **Herdr sessions**. The second group lists the terminals held by
herdr-core for the `matrix` user on that computer. These are the terminals the
Herdr app shows for the same computer when it was added there as the `matrix`
user. The user opens one, types, starts a new one or ends one.

**Acceptance**
1. A terminal started in the Herdr app on that computer appears in the group at the next refresh (at most 3 s while the window is visible). A terminal started from the group appears in the Herdr app. Neither app keeps a private copy of the list; herdr-core on the computer is the only source.
2. Opening a terminal that the Herdr app also has open shows the same screen in both. Both can type. The terminal takes the size of whichever viewer attached or resized last. herdr has no writer lease, so the group shows none; its help text says a session may be open in the Herdr app at the same time.
3. A new terminal starts that computer's own shell in the `matrix` user's home directory. The app sends no program, arguments or environment of its own beyond the terminal type.
4. Ending a terminal asks for confirmation when it was not started from this window in this session, because it may belong to work in the Herdr app.
5. Closing the window, quitting the app or losing the network ends no terminal. On return, every terminal that is still running is listed and can be reopened with its recent history.
6. If herdr-core is not installed on the computer, the group shows an empty state: headline "No Herdr sessions here yet", a one-line description, and a link to the Herdr install guide. The Zellij group is unaffected. The app does not install it.
7. If Direct SSH is off for that computer, the group shows the same enable action as J5 instead of a list. Enabling it registers this device's key once for both J5 and J6.
8. The group never appears for This Computer: local terminals stay in the app's private core (J3), and the user's own local herdr is still untouched.
9. Nothing about these terminals is written to the gateway, the platform or analytics. The Zellij tab list, `matrix shell list` and every other surface are unchanged.

**The sharing condition.** Two clients share terminals only when they reach the
same OS user and the same herdr session on the computer. This app always uses
the `matrix` user and the default session. A user whose Herdr app logs in as a
different user (for example `root`) sees a different set there; the group's
help text states which user it shows.

## Functional Requirements

- **FR-001** The Terminal window is a second `BrowserWindow`, one instance per app, opened or focused from the top-bar terminal icon. Creation is single-flight: concurrent open requests share one in-progress creation and never produce two windows. It loads the same sandboxed preload bundle as the main window (a sandboxed preload is a single bundled entry) with a role argument, so the bridge exposes only the Terminal window channel allowlist; the main-process sender policy enforces the same allowlist independently. It renders a dedicated root from the same trusted renderer bundle, selected by a `?window=terminal` query, so the main app's stores, analytics and embeds never load there. It runs in its own session partition, which the default session's bearer injection never touches, and that session grants no web permissions. It keeps `contextIsolation`, `sandbox`, no `nodeIntegration`, and deny-all `window.open` the same as the main window.
- **FR-002** Every IPC channel the Terminal window uses must check the sender: the frame must be the Terminal window's main frame at its trusted URL. Main-window-only channels must reject it. Event fan-out must name its target window instead of assuming `mainWindow`.
- **FR-003** A main-process **computer credential broker** holds at most one access token per `(handle, runtimeSlot)` in the current inventory. It gets them from `POST /api/auth/runtime-selection` and never writes them to the profile or credential store. The selected-computer credential remains the only persisted one. Broker tokens expire with the parent session, are dropped on sign-out or `authGeneration` change, and are never exposed to any renderer. Minting is single-flight per `(handle, runtimeSlot)`; a mint that completes after the `authGeneration` it started under has changed is discarded, never stored.
- **FR-004** Requests from the Terminal window go through a dedicated session partition. Header injection picks the bearer from the request's runtime target (`runtime=` query or `/vm/<slot>` path, the same parser as `buildGatewayUrl`). A request with neither targets the primary computer, which is the convention every desktop client already uses, so shared client code stays identical in both windows. Injection fails closed (no bearer, and any renderer-supplied `Authorization` header is removed) when the target is malformed, ambiguous, or not in the inventory, and for any origin other than the gateway.
- **FR-005** Token acquisition is lazy. It happens when a section is expanded or a tab is attached, never for all 20 computers at startup. It must stay under the platform limits (30/min per principal) with jittered backoff on 429.
- **FR-006** The window gets its own attach manager (it is a separate renderer process, so the existing manager is naturally per-window). The first release shows one terminal at a time, so one live socket; multi-pane (at most 4) is a follow-up. It keeps a separate buffer LRU of 8. This preserves the main window's single-attachment rule (L4) for its own `AttachManager`.
- **FR-007** Matrix workspace and tab state is read only from `/api/terminal/workspaces` on each computer. Layout-only preferences (section collapse, window bounds, last focus) are stored locally in Electron, keyed by `machine|workspaceId|tabId`. A local preference never creates, renames or deletes a server tab.
- **FR-008** Local terminals are held by herdr-core `hc`, under the rules in §Local Backend: herdr-core. Only the Electron main process talks to `hc`. Spawn, input, resize and kill calls coming from the renderer over IPC are validated with bounded Zod schemas, then translated by main into `hc` JSON-RPC. The renderer never sees the socket path or raw JSON-RPC.
- **FR-009** OSC 7501 parsing (payload format to be confirmed, see Open Questions) produces `NormalizedAgentEventSchema` events. Matrix events are applied to that computer's existing `AgentSessionStateStore`, and local events to an in-memory projection that uses the same reducer. Unknown, oversized or malformed sequences are dropped and counted, never rendered as status.
- **FR-010** SSH (J5) uses one Ed25519 key per device. The private key is encrypted at rest with Electron `safeStorage` in a 0600 file under `userData`. If OS-backed encryption is unavailable, including the Linux `basic_text` backend, the key is not generated or saved and SSH shows a fixed "Direct SSH is unavailable on this device" state; this reuses the check the plan vault (`createPlanVault`) already applies. The public key is registered through an authenticated owner-scoped gateway route. Each connection attempt fetches `{ addresses, hostKeyFingerprints }` from the authenticated owner route and connects directly to port 22. Addresses and fingerprints are never cached between attempts, never read from DNS or user input, and never shown in logs.
- **FR-011** User-facing errors use fixed copy. Logs carry error names and correlation IDs, never tokens, key material, VPS addresses or terminal content.
- **FR-012** Delivery includes a separate public docs PR in `FinnaAI/matrix-os-site` under `content/docs/`, covering the Terminal window, local terminals, platform support (macOS/Linux), SSH setup and Herdr sessions (including the sharing condition).
- **FR-013** Herdr sessions (J6) are served by the Electron main process only. For each computer it opens one SSH connection with the device key (FR-010), runs the fixed remote line of §Herdr Sessions, and speaks herdr-core's API over that command's stdin and stdout. The connection ends in the main process: no renderer, preload, local socket or TCP port ever carries it, and no SSH port or socket forwarding is requested for it.
- **FR-014** The main process sends a remote herdr-core only these methods: `hello`, `terminal.list`, `terminal.run`, `terminal.attach` and `terminal.kill`. It never sends `server.*`, `machine.*`, `file.*`, `doc.*`, `terminal.send`, `terminal.keys`, `terminal.put`, `terminal.keep`, `terminal.label` or `terminal.rm`. `terminal.run` carries only `size`, `env: { TERM, COLORTERM }`, `no_parent`, `no_notify` and `wait: false`: no `argv`, `line`, `cwd`, `on` or `keep`. The allowlist is enforced in one place that every call passes through.
- **FR-015** A remote core is accepted when its handshake reports protocol generation 1, framed mode, a version of at least 0.1.14 in the 0.1 line, and every feature and method this feature uses (`framed`, `attach`, `shell`; the five methods of FR-014). Anything else is reported as `herdr_unsupported` and nothing further is sent. The private local core keeps its exact-version rule.
- **FR-016** Herdr sessions reuse the local terminals' client, attachment table, output acknowledgement and flow control (one shared module with two transports). The renderer talks to them through the same kind of validated, sender-checked IPC as FR-008, with the computer named by `(handle, runtimeSlot)` from the inventory and the terminal by herdr's `t<digits>` address. The renderer never sees an address, host key, key material, SSH error text or raw API message.

## Local Backend: herdr-core

### Shipping and version pinning
- `hc` is **bundled** in the app's resources, one binary per supported target: macOS arm64 and x64, and Linux x64 plus Linux arm64 if the desktop ships it.
- The app ships the exact version recorded in one manifest (`version`, per-target SHA-256, upstream source URL and tag). The build fetches that artifact, verifies its checksum and fails on mismatch. On macOS the binary is signed and notarized with the app.
- The app never runs an `hc` found on `PATH` or elsewhere on the system. It always runs the bundled binary, resolved from `process.resourcesPath`, and checks its checksum before the first spawn of each app version.
- **No independent auto-update.** `hc` changes only with a desktop release. Any updater or update check in `hc` must be disabled through configuration or flags. If it cannot be disabled, the spike fails (Q4).
- Bumping the `hc` version is a reviewed desktop PR and must respect the repo's 7-day `minimumReleaseAge` policy for the upstream release.

### Socket and process boundary
- **Private config and state.** The bundled holder runs with an app-private config, state and template directory under `<userData>/herdr/` (through `XDG_*` variables or equivalent flags, whichever the spike proves). The holder keeps its configuration, templates and terminals separate from the user's Herdr installation. While Desktop Link is paired and active, its inventory reader can query `machine.list` on the user's already-running local Core. It sends only registered names and connection states. The reader does not start Core or expose its socket, SSH targets or terminals through the link. Core's `notes` feature (typing notes into parent terminals) is disabled in the app's config.
- Sockets live in `~/.matrixos/dt/<8 hex of the profile>/`, because Unix socket paths are length-limited and `userData` is too long on macOS. State and config live in `<userData>/herdr/`. Every directory is created 0700 and checked with `lstat` (a directory, not a symlink, owned by the user, closed to group and others). A path that would exceed the limit makes local terminals unavailable.
- Only the Electron main process connects to that socket. It is never passed to a renderer, a webview or a preload, never bridged to TCP, and never forwarded over SSH.
- The bundled binary is never run as `hc connect` or `hc machine add`, and the app's private core never has a machine list. Matrix computers come only from the J2 inventory. *(Amended 2026-11-10. The earlier wording, "the app never runs `hc connect`", also ruled out J6. What J6 does is different in kind: the main process asks a Matrix computer, over its own SSH connection, to run that computer's `herdr-core connect`. The bundled binary, its socket and its private state take no part. See §Herdr Sessions.)*
- Anything that can open the socket can run commands as the user, because Core has no per-client permission checks. Owner-only filesystem permissions are therefore the whole boundary, and the spike must prove them.

### Lifecycle and version mismatch
- **On launch**, main looks for its holder at the socket path.
  - If the holder is alive and its version matches the bundled one, main reattaches.
  - If no holder is alive, main starts one.
  - A stale socket file is removed only after `lstat` and a failed connect.
- **On quit**, the app detaches but leaves the holder running. Survival across restarts is the point. "End all local terminals" is an explicit user action that stops the holder.
- **Version mismatch** (the holder belongs to an older app version, or reports a version other than the bundled one):
  - The app speaks no protocol beyond the version handshake.
  - This Computer shows "Local terminals were started by a different version". The user chooses **Restart local terminals**, which stops the old holder and starts the bundled one, so terminals come back as fresh shells, or **Not now**. While deferred, This Computer shows only that notice and the restart action, and says that no new local terminals can be created until the restart. The old holder is stopped by signal to its recorded PID after verifying that PID owns the socket, since no JSON-RPC is spoken to it.
  - The app never sends JSON-RPC calls to a holder of an unknown version.
- **Missing or damaged binary** (not found, checksum mismatch, exec fails): This Computer shows "Local terminals are unavailable — reinstall Matrix OS". Matrix sections keep working. The app makes no network fetch to "repair" the binary.

### Licence
Core is Apache-2.0. The app bundle includes Core's `LICENSE` and any `NOTICE`
unchanged, plus an entry in the desktop's third-party notices and About screen.
Its attribution must not suggest that herdr endorses Matrix OS.

### Qualification spike (must pass before slice 3 ships product code)
The spike is throwaway code outside the shipped bundle. Its result is recorded in
`specs/651-desktop-terminal-window/research.md`. Every item is pass/fail on
macOS arm64, macOS x64 and Linux x64.

| # | Pass criterion | How measured |
| --- | --- | --- |
| Q1 | The pinned upstream release builds or downloads reproducibly with a matching checksum, is Apache-2.0, and has no runtime dependency outside the bundle. | Clean-machine install from the manifest |
| Q2 | It can be signed and notarized inside the app on macOS, and the packaged DMG smoke test (CLAUDE.md) still passes. | Local package + `hdiutil`/`ditto` smoke |
| Q3 | The socket path can be set explicitly. The socket and its directory are owner-only. No TCP or other network listener is opened. A second OS user cannot connect. | `stat`, `lsof -i`, second-user connect attempt |
| Q4 | Auto-update and any outbound network calls can be disabled. With them disabled, `hc` makes no network connections while running. | Packet capture / `lsof` during a 10 min session |
| Q5 | The holder survives app quit, a main-process crash (`kill -9`) and a renderer crash. After relaunch, every terminal is listed again and the UI can show its recovery mode (fresh shell). No orphaned or duplicate holders. | Scripted kill/relaunch × 20 |
| Q6 | A version handshake exists, or can be implemented safely, so the app can tell matching and mismatched holders apart before any other call. | Protocol test with two pinned versions |
| Q7 | Input-to-echo latency within 10 ms of the existing remote xterm path on loopback, and throughput of at least 50 MB/s with `yes` without renderer stalls | Scripted benchmark |
| Q8 | A holder crash is detected within 2 s and reported. The app restarts it at most 3 times per 5 min. The spike records whether terminals die with the holder. | Fault injection |
| Q9 | With a separate user-installed `hc` running on the same account, the bundled holder shares no config, state, socket, machine list or templates with it, and neither lists the other's terminals. | Side-by-side run with a populated `~/.config/herdr-core` |

If any criterion fails, the owner is told which one. If the owner does not
accept a patched or newer `hc`, the fallback is **`node-pty` in the Electron main process**:
- Local terminals then do **not** survive an app restart, and the UI says "ended".
- The fallback still meets Q2, Q3 and Q7 equivalents, and still runs the packaging and `minimumReleaseAge` checks.

Q9 is about the user's device. On a Matrix computer, J6 deliberately talks to
the user's own herdr-core, because sharing its terminals is the feature; the
limits on what the app may do there are in §Herdr Sessions.

The spike also records two limits for reviewers:
- herdr's `hc connect` over SSH to a Matrix VPS shows herdr terminals, not Zellij workspaces, so it cannot replace J2. J6 adds it beside J2 as a separate group.
- Kept terminals recover with a fresh shell, not a replay.

## Herdr Sessions on Matrix Computers (J6)

Spike result: `research.md`, "Herdr sessions over SSH spike". No blocker found.

### Which identity and which core

Two clients share terminals only if they reach the same OS user and the same
herdr session on the computer. Two designs were compared.

| | A. Matrix-managed device key (chosen) | B. Borrow the user's SSH setup and Herdr machine list |
| --- | --- | --- |
| Login | Device key of FR-010, user `matrix` | Whatever `~/.ssh/config`, the user's agent and the user's `hc machine ls` say |
| Remote core | `matrix` user's default herdr session | Whichever user and session the Herdr machine entry names |
| Address and host key | Fetched fresh from the authenticated owner route for every attempt | From the user's files and DNS; host keys trusted on first use in `known_hosts` |
| Reads on the device | Nothing outside the app's own storage | `~/.ssh/config`, the agent socket, the user's herdr state |
| Works without slices 5–6 | No | Yes |
| Shares with the Herdr app | When the Herdr app added the computer as `matrix` | Always, by construction |

**Recommendation: A.** Reasons:

- B makes the app execute the user's SSH configuration. `ProxyCommand`, `Match exec` and `LocalCommand` run arbitrary commands, so a file the app does not own would decide what the main process runs.
- B replaces "address and host key from an authenticated owner route" with DNS and trust-on-first-use, which is the exact weakness FR-010 exists to remove. A rebuilt computer would produce a host-key warning the app cannot resolve safely.
- B reads the user's own herdr state on the device, which the local design promises never to touch (Q9), and it cannot tell which machine entry is which Matrix computer without matching on addresses.
- B gives the main process the user's whole agent. A gives it one key that works on the owner's Matrix computers only, expires, and is revocable per device.
- A grants nothing new: the device key already allows a shell as `matrix` (J5), and the owner terminal API already runs commands as `matrix`.

The cost of A is honest: J6 cannot ship before slices 5–6, and a user whose Herdr
app logs in as another user must add the computer there as `matrix` to share.
The public docs and the group's help text say so.

### How the four earlier rules change

| Earlier rule | After this amendment |
| --- | --- |
| 1. "The app never runs `hc connect` or `hc machine add`; Matrix computers come only from J2." | **Narrowed.** The bundled binary still never runs either, and the private core never has machines. The main process may run the fixed line below on a Matrix computer over its own SSH connection. Computers still come only from the J2 inventory. `machine.add` is never called, locally or remotely (FR-014). |
| 2. The bundled holder uses private config and state and never touches the user's own herdr installation (Q9). | **Unchanged on the device.** On a Matrix computer J6 uses the user's herdr-core on purpose, limited to listing, starting a shell, attaching and ending terminals. It never installs, updates, configures, restarts or stops it, and never reads or writes its files. |
| 3. The `hc` socket is "never forwarded over SSH". | **Unchanged.** No socket or port is forwarded in either direction. The API travels on the standard input and output of one remote command and ends in the main process. |
| 4. Tokens and SSH private keys stay in the main process; addresses and host-key fingerprints come fresh from an authenticated owner route. | **Unchanged, and now also binding on J6.** This is why design B and herdr's own `machine add` are rejected: both would store an address and reconnect with it later. |

### The remote command

The only command the app ever runs on a Matrix computer for J6 is this constant:

```sh
sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || exit 127; exec "$p" connect'
```

It is the shape herdr's own client sends (seen in the spike), without a session
name, so it reaches the default session. Nothing from the renderer, the
inventory or the network is interpolated into it. Exit status 127 means
"herdr-core is not installed here".

### Is herdr-core on Matrix computers, and who owns it

- **Not by default.** Nothing under `distro/`, the host bundle or the platform installs herdr-core. It is there only when the user put it there, normally because `hc machine add` in their Herdr app copied it over.
- **The user's Herdr app installs and updates it** (`hc machine add --install`, `hc machine update`). Matrix OS does not ship it in the host bundle (still Not In Scope) and the desktop app never copies its bundled binary to a computer. Shipping it would make Matrix OS responsible for a second terminal runtime on every VPS, with its own update and security lifecycle, for a feature whose point is to mirror what the user's Herdr app already set up.
- **Its files stay on the computer.** The binary and state live under `/home/matrix/.local`, which the home mirror never uploads (`home-mirror-ignore.ts`), and which golden-snapshot activation clears. A rebuilt computer has no herdr-core until the user's Herdr app adds it again; J6 then shows the "not installed" empty state.
- **A core that is installed but not running** is started by `connect` itself, as herdr's own client relies on.

### Version skew

Three versions meet: the app's bundled 0.1.19 (local terminals only), the user's
Herdr app (0.1.20 on the requester's Mac) and the computer's core (0.1.14 reported there).

- The bundled binary takes no part in J6, so its version does not matter here. What matters is the protocol the app's client speaks against the computer's core.
- The spike ran the app's client unchanged against 0.1.14 and 0.1.20 cores: handshake, list, run, attach, resize and kill all passed on both.
- The rule is FR-015: generation 1, at least 0.1.14, required features and methods present. A core that fails it shows "This computer's Herdr is not supported by this version of Matrix OS" (`herdr_unsupported`), with no restart or update action, because the core is not the app's to change.
- The local `version-mismatch` state keeps its meaning and its exact-version rule; the two rules live in one client behind one option.
- When herdr ships a second protocol generation, J6 stops for those cores until a desktop release adds it. That is preferred over guessing.

## Security Architecture

### Auth matrix

| Boundary | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `GET /api/auth/computers` (existing) | Electron main | Parent session bearer | Unchanged |
| `POST /api/auth/runtime-selection` (existing) | Electron main broker | Parent session bearer | Reused to mint per-computer tokens without persisting them. Existing `bodyLimit` and rate limits apply. |
| `/api/terminal/workspaces*` (existing) | Terminal window renderer | Computer-scoped bearer injected by main (FR-004) | Unchanged gateway auth and mutation limits |
| `/ws/terminal/tab` (existing) | Terminal window renderer | Computer-scoped bearer, header or query token per the existing allowlist | Unchanged lease and ownership checks |
| Terminal-window IPC (new) | Terminal window main frame only | Sender-frame + URL check, Zod per channel | Main-window-only channels reject it |
| `hc` Unix socket (new, local) | Electron main only | OS ownership: 0700 dir, owner-only socket | No renderer, network or SSH exposure |
| Herdr-session IPC (new, J6) | Terminal window main frame only | Sender-frame + URL check, Zod per channel | Computer named by inventory `(handle, runtimeSlot)`; unknown computers are refused in main |
| `herdr-core connect` on the VPS (new use, J6) | Electron main, over SSH | Device key as `matrix`; host key matched to the freshly fetched fingerprint first | Fixed remote line; method allowlist of FR-014. herdr-core itself has no per-client permissions, so the SSH login is the whole boundary |
| `GET /api/ssh/connection` (new, name provisional) | Owner, Electron main | Gateway owner principal via computer-scoped bearer | Returns the computer's public IPv4/IPv6 and its host key fingerprints, both read on the host (Open Question 7). `Cache-Control: no-store`. Called fresh for every connection attempt, for J5 and J6 alike. |
| `GET/POST /api/ssh/device-keys` (new) | Owner | Gateway owner principal | `bodyLimit` 4 KiB; Zod: one `ssh-ed25519` key line, label ≤64 chars, device ID UUID |
| `DELETE /api/ssh/device-keys/:id` (new) | Owner | Gateway owner principal | `bodyLimit`; `:id` validated with Zod; repeat deletes are no-ops |
| sshd on the VPS, port 22 (existing, public) | Device key | Public key | Config is not changed by this spec. Platform owner is asked to set `PasswordAuthentication no` fleet-wide as a prerequisite. |

Collaboration principals (org members) and preview-terminal owners must be
**denied** on `/api/ssh/*`. Only the computer owner may read connection details
or register keys.

### Input validation and writes

- Key routes accept only `ssh-ed25519 <base64> [comment]` matching the pattern used in `matrix-support-access`. Options, newlines and other key types are rejected.
- `authorized_keys` changes touch only a marked managed block (`# >>> matrix device keys` … `# <<<`). Lines outside the block are preserved byte-for-byte. Writes are serialized per computer and use `lstat` to refuse symlinked files or a symlinked `.ssh` beyond the cloud-init link. The file is written to a temp file in the same directory, `fsync`ed, renamed, and set to 0600. If the file was edited between read and rename, the write is retried; it never clobbers.
- Managed key lines carry `restrict,pty,port-forwarding` and a mandatory `expiry-time=` (7 days, refreshed while the device stays signed in). Slice 5 is gated on confirming the fleet's OpenSSH supports `expiry-time` (8.2+); if it does not, the slice does not ship.
- Every registration and revocation writes an owner-visible audit record (device label, key fingerprint, time, action), and the Terminal window lists registered devices. A registration made by another device raises a notice on the owner's other signed-in clients.
- The 10-key cap is enforced inside the serialized `authorized_keys` write, not by a prior read.
- The client validates the connection response with Zod before use: it must be an IP literal (no hostnames), in a public range (no loopback, private, link-local or multicast), with port fixed at 22 and SHA-256 fingerprints only.
- A device key gives no more power than the existing owner terminal API, which already runs commands as `matrix`. It adds a direct network transport, which is why fleet-wide password-auth hardening is a prerequisite.
- **Herdr-session IPC (J6).** Requests carry `{ handle, runtimeSlot }` with the inventory's own schemas, a terminal address matching `^t[0-9]{1,6}[a-z]{0,2}$` (never a `machine/` prefix or a name), sizes of 20–500 columns and 5–200 rows, and input of at most 65 536 characters. Main refuses a computer that is not in the current inventory before any network call.
- **What a remote core says is untrusted input.** It runs on a computer whose programs can print anything. The handshake is capped at 64 KiB and must be one JSON line; text before it (a chatty shell startup file) is a protocol error, not a crash. Frames are capped at 16 MiB. Each listed terminal is parsed on its own, limited to 1 000 entries, and reduced to an address, a bounded title with control and bidirectional characters removed, and a status from the fixed vocabulary. Error text from the core or from SSH never crosses IPC.
- **Terminal output is rendered, never interpreted by the app.** It goes to xterm in the Terminal window exactly as local terminal output does; the app adds no link opening, clipboard write or file transfer for it beyond what the existing terminal view already allows.

### Credentials and errors

Per-computer tokens and SSH private keys stay in the Electron main process. Tokens
are never put in URLs except the existing `/ws/terminal/tab` query-token path, and
never logged. Renderers receive fixed error codes such as `computer_unavailable`,
`reconnect_required`, `identity_changed`, `local_unavailable` and
`local_version_mismatch`. J6 adds `herdr_not_installed`, `herdr_unsupported`,
`herdr_unavailable` and `ssh_not_enabled`, and reuses `identity_changed`.

J6 adds no credential. It uses the J5 device key, held in memory in the main
process only while a connection is being authenticated, and the per-attempt
address and fingerprint of FR-010. The SSH client is given no agent, no
configuration file, no known-hosts file and no password or keyboard-interactive
method; it offers the one device key and nothing else.

### Timeouts

| Call | Timeout | On timeout |
| --- | --- | --- |
| `GET /api/auth/computers`, `POST /api/auth/runtime-selection` | 10 s (`AbortSignal.timeout`) | Section retry state |
| `/api/terminal/workspaces*` from the window | 10 s | Section retry state |
| `GET /api/ssh/connection`, device-key routes | 10 s | `computer_unavailable` |
| Gateway → platform address lookup (if chosen, Q7) | 5 s | Generic 503 |
| SSH TCP connect / handshake + auth | 10 s / 15 s | "Direct SSH unavailable" |
| SSH keepalive | 15 s interval, 3 missed | Session ended state |
| `hc` exec for version/handshake | 3 s | `local_unavailable` |
| `hc` holder start until socket ready | 5 s | `local_unavailable` |
| `hc` JSON-RPC unary call | 5 s | Per-tab error, no retry storm |
| J6: connection details, SSH connect, handshake + auth | as J5 above (10 s / 10 s / 15 s) | `herdr_unavailable` for that computer's group only |
| J6: remote command start until herdr handshake | 10 s | `herdr_unavailable`; exit 127 gives `herdr_not_installed` |
| J6: remote API unary call | 10 s (a round trip to the computer, not loopback) | Per-terminal error, no retry storm |
| J6: SSH keepalive | 15 s interval, 3 missed | Group shows "Disconnected"; open terminals show "ended here" and offer reconnect |
| J6: idle connection (no attachment, window hidden or group collapsed) | closed after 60 s | Reopened on next use |

## Integration Wiring

- **Startup (main)**: `app.whenReady` creates the main window as today. It then:
  1. registers the Terminal-window IPC with its sender guard;
  2. creates `ComputerCredentialBroker({ authService, fetch, platformHost })`;
  3. installs Terminal-partition header injection that reads the broker;
  4. adds the top-bar launcher IPC (`terminal-window:open`, main window only), which creates the Terminal window lazily or focuses it.
- **Local backend**: `LocalTerminalHost({ binaryPath: resourcesPath/hc, manifest, socketDir })` is constructed on first This Computer use, or at startup if a holder socket exists, so restored terminals show immediately. It runs the version handshake (lifecycle above) and is detached, not stopped, on `before-quit`.
- **Cross-package**: the renderer imports only `@matrix-os/contracts` schemas. The OSC 7501 parser and visual-status derivation live in a shared pure module so the gateway and Electron use the same code. Its package home is decided in planning; no `globalThis`.
- **Gateway (SSH slice)**: new routes are registered next to the shell terminal routes with the same owner principal middleware, and added to `route-inventory.ts`.
- **Herdr sessions (J6)**:
  - One module, `hc-sessions`, owns what local terminals and Herdr sessions have in common: listing, attachments, output acknowledgement, flow control and release. `LocalTerminalHost` and `HerdrSessionHost` are both built on it; neither copies it.
  - `HerdrSessionHost({ open, sink })` serves one computer. `open` returns a byte stream to that computer's `herdr-core connect`; the host knows nothing about SSH.
  - `HerdrSessionRegistry` maps inventory computers to hosts, creates them lazily, and drops a host when its computer leaves the inventory, on sign-out and on `authGeneration` change, the same events that clear broker tokens.
  - The SSH transport (slice 8) builds `open` from the J6 pieces of slice 6: fetch connection details, connect, verify the host key, authenticate with the device key, start the fixed remote line. It resolves its dependencies when registered; a missing key store or connection client makes the group report `ssh_not_enabled`, never a late failure inside a call.
  - No gateway, platform or `packages/*` code changes for J6 beyond slice 5. There is no `globalThis`; main-to-renderer events name the Terminal window as their target.
- **Integration tests**:
  - two computer-scoped tokens attach to two real gateways at once while the main selection stays fixed;
  - a tab created in the window is listed by the shell Terminal's list call;
  - the packaged app restarts with the bundled `hc` and local terminals reattach;
  - device key register, fetch connection details, connect with a fingerprint match, revoke, then connect is refused, against a real sshd in a fixture, including a host-key change;
  - negative: every main-window-only channel rejects a Terminal-window sender, and every terminal channel rejects a main-window or unknown sender;
  - negative: Terminal-partition header injection attaches no bearer for a missing, unknown or non-inventory runtime target, or for a non-gateway origin.
  - J6: against the sshd fixture with a real herdr-core behind it, a terminal started through the app's host is listed by plain `hc ls` on the fixture, a terminal started with plain `hc run` is listed by the app's host, each side can end the other's, and a second viewer sees the app's output. Run against the oldest supported core (0.1.14) and the newest released one.
  - J6 negative: a wrong host key, a missing herdr-core, text before the handshake, an unsupported core and a method outside the allowlist each produce their fixed outcome and send nothing further.
- **Per-slice checkpoint**: each slice lands with its own integration test from this list (slice 1: sender-guard negatives and single-flight window; slice 2: two-computer attach and fail-closed injection; slice 3: packaged restart reattach; slice 4: parser-to-projection; slices 5–6: sshd fixture; slice 7: the shared module's suite passes for both hosts and the opt-in real-core lane passes; slice 8: the J6 sshd fixture test).

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Inventory fetch fails | Matrix sections show retry. This Computer keeps working. |
| Token mint 429/5xx | Per-section backoff (1 s→30 s, jittered), no global retry storm |
| Computer 401 | Drop that broker token only. Re-mint once; if it fails again, show reconnect. |
| Parent session expires | All broker tokens are dropped and all Matrix sections detach. The window shows sign-in. This Computer is unaffected. |
| Socket handshake timeout | Existing `ShellSocket` timeout and reconnect apply per pane. |
| Main window switches computer | The switch replaces the app's credential, which changes `authGeneration`, so broker tokens are dropped (FR-003) and minted again on the next request for each computer. Open Matrix panes reconnect through the existing socket retry. The new window does not follow the selection. |
| `hc` binary missing or checksum mismatch | `local_unavailable` with reinstall guidance. No network repair. |
| Holder version differs from bundled | `local_version_mismatch`. The user chooses restart (fresh shells) or defers; while deferred, no new local terminals. No other JSON-RPC calls. |
| Holder crash | Detected within 2 s. At most 3 automatic restarts per 5 min, then a manual retry. Terminals show "Restored — new shell" or "ended" truthfully. |
| Stale or foreign socket file | `lstat` plus ownership check. Remove only the app's own stale socket. A socket owned by another user or a symlink is refused and logged. |
| OSC flood or malformed payload | Parser caps payloads at 4 KiB and events at 20/s per tab. Excess is dropped and counted. |
| `authorized_keys` concurrently edited | Retry up to 3 times, then return a generic 409. Hand edits are kept. |
| SSH connection route unavailable (gateway down) | That attempt fails with `computer_unavailable`. There is no cached-address fallback, so SSH depends on the gateway only at connect time; an open SSH session survives later gateway outages. |
| Host key mismatch against freshly fetched fingerprint | Block the connection (`identity_changed`) and log a correlation ID. Retry only after a new fetch. |
| Computer rebuilt (new address and host key) | The next attempt fetches both fresh and connects if they match. The device key must be registered again on the new disk, and the app does this automatically while the device is signed in. |
| Port 22 unreachable (future firewall, network) | Fixed "Direct SSH unavailable" copy. J2 terminals still work. |
| Sign-out while offline | A local revocation intent (computer, key fingerprint, owner ID) is queued, at most 20 entries, and retried only when the same owner signs in again; intents for a different owner are discarded. The mandatory `expiry-time` bounds exposure if the retry never happens. |
| J6: herdr-core not installed on the computer (remote line exits 127) | `herdr_not_installed` empty state with the install guide link. No retry until the user refreshes or reopens the group. |
| J6: remote core fails FR-015 (older than 0.1.14, another generation, missing a feature) | `herdr_unsupported`. Nothing is sent after the handshake. No restart or update action. |
| J6: text before the handshake, an oversized or malformed handshake or frame | Protocol error: the connection is closed and the group shows `herdr_unavailable`. Logged by error name only. |
| J6: host key mismatch | Same as J5: blocked with `identity_changed`, retried only after a new fetch. The Zellij group keeps working. |
| J6: device key not registered, expired or revoked (auth refused) | The app registers the key again once while signed in, then retries once; if that fails, `ssh_not_enabled`. |
| J6: SSH line drops (network, sleep, computer restart) | Every open stream ends within the keepalive window. Terminals keep running on the computer. The group reconnects with jittered backoff (1 s→30 s) while it is visible, and each open terminal is reattached, replaying recent history (herdr's `resumed` attach option exists for this and is to be tried in slice 8). |
| J6: herdr-core on the computer restarts or is updated by the user | Streams end; the next call reconnects and repeats the handshake, so a core that is now unsupported is caught. Terminals the core kept are listed again. |
| J6: the computer's core dies with its holder | Its terminals are gone. The list shows what the core reports; nothing is shown as running from memory. |
| J6: the Herdr app ends or resizes a terminal the window has open | An ended terminal closes here with "ended". A resize changes the shared size; the window repaints on the next output and reasserts its own size only on user input or window resize, so two viewers do not fight. |
| J6: two creates at once, or create while disconnected | Creates run one at a time per computer and are rate-limited (10 per 10 s). A create while disconnected connects first; if that fails the user sees a fixed "could not start" notice and the list is unchanged. |
| J6: computer leaves the inventory, sign-out, `authGeneration` change, main window switches computer | That computer's host is disposed: streams close, the SSH connection ends, nothing on the computer is ended. Sign-out and `authGeneration` change dispose every host. Switching the main window's computer does not affect J6 hosts for computers still in the inventory, because they use the device key, not broker tokens. |
| J6: Terminal window closes, reloads or its renderer crashes | All attachments are released in main (the existing release epoch), connections go idle and close after 60 s. No terminal ends. |
| Shutdown | Stop the timers, close sockets (detach only), detach from the `hc` holder without stopping it, and close every J6 SSH connection without ending any remote terminal. |

## Resource Management

- Broker: at most 20 tokens (inventory cap). Entries are evicted on inventory change, sign-out and expiry, and the sweep timer is cleared on quit.
- Attach: at most 4 live sockets, plus an LRU of 8 buffers using the existing serialized-buffer bounds.
- Local tabs: no count ceiling (terminal creation is rate-limited, not count-capped). Creation is limited to 10 per 10 seconds with a visible "try again in a moment" message; the window holds at most 8 live attachments, and the sidebar lists at most the 1 000 terminals the core reports. Renderer scrollback is capped at 10 000 lines per tab, and only visible panes keep a live xterm instance. Each tab's output buffer before render is capped at 1 MiB. One holder per OS user and app channel, and its restarts are bounded (above).
- Holder files: the socket directory is the only `hc` state the app creates. "End all local terminals" and uninstall guidance remove it. Holder logs, if any, go under `userData` with size rotation (cap set in planning after the spike).
- Status: the local projection holds at most 100 snapshots (same cap as the gateway store) with LRU eviction. The attention list is derived and never stored.
- Herdr sessions (J6):
  - At most one SSH connection and one API channel per computer; at most 4 computers connected at once, least recently used first to close (it reconnects on use). The registry holds at most 20 hosts, the inventory cap. These connections count toward the 4 SSH sessions per computer below.
  - The window's 8 live attachments are shared between local terminals and Herdr sessions; per connection at most 32 streams and 64 pending calls, as today.
  - Output is flow-controlled end to end: the core sends only what the window has acknowledged, so a slow renderer slows the remote program instead of filling main's memory. Each output event is at most 262 144 characters; history replay on attach is 2 000 lines.
  - Listings are capped at 1 000 terminals and polled every 3 s only while the window is visible and the group is expanded.
  - No file is written on the device or on the computer for J6. No temp files, no known-hosts file, no logs of terminal content. Connection details live for one attempt.
- SSH: at most 4 SSH sessions and 8 loopback forwards per computer from one device. At most 10 managed device keys per computer, enforced in the route. Stale-device cleanup is offered in the UI. Connection details are held only for the duration of one attempt.
- Third parties:
  - herdr-core is a bundled Apache-2.0 binary that runs locally and makes no network calls (Q4).
  - SSH goes directly from the device to the owner's VPS.
  - Analytics record only coarse events such as window open, section count bucket and local-tab created, never commands, output or addresses.

## Delivery Slices (one native stack, 6 PRs)

Compared with the brief: the credential broker is split out because it is the
riskiest boundary, and SSH is split into server and client layers. Because
herdr-core is decided, slice 3 runs the qualification spike and then ships
herdr; there is no backend comparison.

1. **Window shell**: second window, dedicated preload, sender-guarded IPC, top-bar terminal icon launcher (open/focus), and a sidebar with machine sections fed by the existing inventory. Includes empty, loading and error states. Until slice 2, Matrix sections list computers and their availability only; they show no workspaces or tabs, because the window holds no per-computer credential yet.
2. **Computer credential broker + aggregation**: per-computer tokens, Terminal-partition injection, independent attach manager, and tab CRUD through the existing gateway API, with cross-surface parity tests.
3. **Local terminals via herdr-core**: the qualification spike result in `research.md` (throwaway code is not committed), then the `hc` manifest, build fetch and checksum, signing, `LocalTerminalHost`, version handshake, restart survival, licence notices and the missing or mismatched states. If the spike fails, this slice ships the `node-pty` fallback instead, after the owner confirms.
4. **Status**: shared OSC 7501 parser, ingestion into the existing projection, local in-memory projection and the attention list.
5. **SSH server side**: `/api/ssh/connection`, device-key routes, the managed `authorized_keys` writer, and the sshd fixture tests.
6. **SSH client side**: device key generation and storage, connection details fetched per attempt, fingerprint check, direct shell and port forwarding, and automatic re-registration after a rebuild.

7. **Herdr sessions, shared core** (main process only, no user-visible change): extract the shared `hc-sessions` module from `LocalTerminalHost`; add the FR-015 acceptance rule to the client beside the exact-version rule; add `HerdrSessionHost` over an injected byte stream with the FR-014 allowlist. Lands with unit tests for both hosts and an opt-in lane against a real herdr-core.
8. **Herdr sessions, transport and UI**: the SSH transport built on slice 6, `HerdrSessionRegistry`, sender-checked IPC, the "Herdr sessions" group with its empty, not-enabled, unsupported and disconnected states, and the J6 sshd fixture test. Needs slices 5–6 merged.

Slices 1–3 and bundling already merged as one stack. Slices 4–8 are a follow-on
stack of at most five layers, inside the 10-layer limit. Slice 7 has no
dependency on 4–6 and may lead that stack.

Each layer needs live Electron Desktop evidence on macOS and Linux (screenshots
plus a recording), and regression evidence that shared tab state is unchanged on
the other surfaces, per CLAUDE.md. Recommended reviewers are the Electron
Desktop owner, terminal/gateway owner and platform owner (for the SSH
hardening prerequisite and the firewall consequence).

## Risks

- **Credential fan-out**: holding up to 20 live computer tokens enlarges what an Electron main-process compromise can reach. This is mitigated by lazy minting, no persistence and dropping tokens on sign-out.
- **IPC widening**: today's generic `handle()` trusts any frame with the preload. A second window makes the missing sender checks a real exposure; FR-002 must land in slice 1.
- **Surface parity challenge**: local terminals and SSH are true Electron-only limits. The cross-computer Matrix view and attention list are Electron-only by design choice (credential custody in the main process), so a reviewer may ask for a web follow-up; the N/A needs explicit approval.
- **Divergence**: the two terminal UIs could drift. Both must share the terminal view components and socket client and keep different window chrome only.
- **herdr-core maturity**: Core was created 2026-10-16, is a 0.1.x preview protocol with effectively one maintainer and about 150 open issues. This is contained by exact pinning, no auto-update, the qualification spike, the version handshake and the `node-pty` fallback.
- **Local socket = local code execution**: any process running as the user that can open the socket can run commands. This is equal to the user's own shell privileges but is a new long-lived endpoint; the spike must prove the owner-only boundary (Q3).
- **Public port 22**: SSH value depends on keeping 22 reachable and on fleet hardening this spec does not do. With password auth on (one sample), the direct path is only as strong as the fleet's sshd configuration.
- **Second terminal namespace**: a computer now has Zellij tabs and Herdr sessions side by side, and only Electron shows the second. Users may expect a Herdr session in Web Desktop or `matrix shell list`. The group's label and help text, and the docs, must say plainly that these are Herdr's terminals. The owner accepted this (decision 5).
- **Sharing depends on the Herdr app's login**: if the user's Herdr app reaches the computer as a user other than `matrix`, the two apps show different terminals and the feature looks broken. Which user the requester's Herdr app uses was not verified (Open Question 12).
- **Remote herdr-core is unmanaged third-party code**: its version, health and presence are the user's. A 0.1.x protocol can change under the app; FR-015 fails closed, so the worst case is "not supported" until a desktop release.
- **No per-client permission in herdr-core**: anyone who can log in as `matrix` can drive every terminal there. That is already true of the owner terminal API and of J5, so J6 adds no new authority, but it adds a second place where a stolen device key is useful until it expires or is revoked.
- **SSH library in the main process**: `ssh2` parses network input in the most privileged process of the app. Mitigations: host key checked before authentication, one fixed command, exact version pin, the repo's 7-day release-age rule, and no native add-on.

## Open Questions

Number note: `651` is also used by other in-flight specs with different names (`651-ai-usage`, `651-hosted-bots`, `651-native-claude-chat-scheduling`); this repo already shares numbers across specs.

1. **Linear ticket**: none recorded. No Linear tool was available in the session that wrote this spec.
2. **OSC 7501 payload format**: no definition exists in the repo, and herdr's spec was not read here. Confirm the source and schema.
3. **OSC visibility for Matrix tabs**: the gateway sees output only through per-viewer attaches (spec 606, `terminal-ws-routes.ts`), so gateway parsing misses tabs nobody is watching. Options:
   - (a) accept status only while attached;
   - (b) observe output in `packages/terminal-runtime`, which needs a separate spec under decision 1;
   - (c) keep the existing agent hook bridge as the Matrix source and use OSC 7501 only for local tabs.

   Also unverified: whether Zellij 0.44.1 passes unknown OSC sequences through to attached clients.
4. **Renderer bundle** (resolved in slice 1): one renderer bundle and one preload bundle serve both windows; the Terminal window is selected by `?window=terminal` and a preload role argument (FR-001).
5. **herdr-core facts**: none of these are verified, and Q1–Q6 must establish them:
   - release artifacts per target, or whether it must be built from source;
   - socket-path configuration;
   - auto-update and telemetry behavior;
   - a version handshake;
   - whether a `NOTICE` file exists.
6. **Linux targets**: does the desktop ship Linux arm64 as well as x64? This sets the `hc` binaries to bundle.
7. **Connection address source** (gate for slice 5) — **proposed answer, one check left.** The gateway reads both values on the host: host key fingerprints from `/etc/ssh/ssh_host_*_key.pub`, and addresses from its own network interfaces, keeping only public unicast addresses. Reasons: the host keys can only come from the host anyway; no gateway→platform call means no extra timeout or failure mode at connect time; nothing is taken from request headers; and the answer is authentic because the client reached this gateway through the platform's session routing with a computer-scoped token. *Remaining gate:* confirm on one real Matrix computer that the public IPv4 and IPv6 are configured on the interface (true for Hetzner primary IPs as far as known, not verified here). If they are not, fall back to the platform's recorded addresses.
8. **sshd version and `expiry-time`** (gate for slice 5) — **proposed answer, one check left.** New computers are built from `ubuntu-24.04` (`customer-vps-config.ts:111`, also the golden-snapshot base), which ships OpenSSH 9.6; `expiry-time` needs 8.2. The device-key route also checks the local OpenSSH version before writing a key and refuses with a fixed error below 8.2, so an unexpected older image fails closed instead of writing a key that never expires. *Remaining gate:* a fleet query for any computer not on that image.
9. **SSH client** — **proposed answer: `ssh2`** (owner decision 7 to confirm). Checked in a throwaway spike (`ssh2` 1.17.0, pure JavaScript, no native build): the key was passed in memory, the host key was matched by SHA-256 fingerprint in a callback before authentication, a wrong fingerprint was refused during the handshake, and `herdr-core connect` answered over an exec channel in 328 ms. Against the system OpenSSH binary: it needs the private key in a file or an agent socket, which FR-010's "encrypted at rest, in main only" does not allow without building an agent; it pins host keys only through a known-hosts file holding the full public key, not a fingerprint; and its behaviour varies with the installed version and with configuration the app would have to switch off flag by flag. `ssh2` also serves J5's shell and loopback forwards with one client. Cost: a new dependency that parses network input in the main process (see Risks).
10. **`~/.ssh` sync** (gate for slice 5) — **mostly answered, one check left.** The home mirror never uploads `.ssh`; it is a hard exclusion that an owner `.syncignore` cannot undo (`packages/gateway/src/sync/home-mirror-ignore.ts`). Golden-snapshot activation clears `/home/matrix/.ssh`. The scheduled backup is the database only. So managed keys are not copied off the computer by those paths, and a rebuilt computer starts without them, which is what J5 acceptance 3 assumes. *Remaining gate:* read `matrix-restore.sh` and the R2 restore path end to end to confirm nothing restores an old `authorized_keys`, and confirm the sync client's own default patterns (which do not list `.ssh`) are never applied to the computer's home.
11. **Fleet sshd posture**: the brief's single-VPS sample (password auth on, `ufw` inactive) needs a fleet audit by the platform owner.
12. **Which user does the Herdr app log in as** (gate for slice 8): on the requester's Matrix computer, check `hc machine ls` on the Mac for the target of that machine and `whoami` in one of its terminals. If it is `matrix`, J6 shares as designed. If it is another user, decide between documenting "add the computer as `matrix`" (recommended) and letting the group name a different user, which would need a second managed `authorized_keys` and is not designed here.
13. **Owner decisions 6–8** need confirmation: device-key identity, `ssh2`, and not installing herdr-core.
14. **Where is herdr-core on a Matrix computer**: the remote line looks on the non-interactive `PATH` and then in `~/.local/bin`, as herdr's own client does. Confirm that is where `hc machine add --install` put it for the `matrix` user.
15. **Linear ticket for J6**: ENG-443 or a new ENG ticket, the requester's choice before any PR.
16. **Live updates**: the group polls every 3 s like local terminals. herdr's `events.subscribe` would give instant updates over the same connection; it was not spiked and is left out of slices 7–8.

## Not In Scope

- **Windows.** Electron Desktop on Windows gets no Terminal window, local terminals or SSH in this feature, and the launcher icon is hidden there.
- Changing the VPS terminal backend (Zellij) or `packages/terminal-runtime`, and shipping herdr-core in the host bundle. herdr-core runs only on the user's device.
- Running the bundled `hc` as `hc connect` or `hc machine add`, and any herdr machine list in the app. (J6 runs the computer's own `herdr-core connect` over the app's SSH connection instead; see §Herdr Sessions.)
- Installing, updating, configuring or stopping herdr-core on a Matrix computer, and shipping it in the host bundle.
- Herdr sessions in Web Desktop, Web Canvas, the mobile apps, `matrix shell list` or the gateway (owner decision 5), and Herdr sessions for This Computer or for non-Matrix hosts.
- herdr features beyond terminals: templates, notes, labels, `keep`, files, documents, machine-to-machine links and sending text to agents.
- A cloud-to-laptop reverse connector, moving tasks between machines, Herdr mods/panels, and durable task orchestration changes
- A gateway SSH tunnel or relay
- Changing sshd configuration or firewalls on customer VPSes. This is recommended only, and any future firewall must keep port 22 reachable.
- Non-Matrix SSH hosts. The SSH design allows them, but they are a follow-up.
