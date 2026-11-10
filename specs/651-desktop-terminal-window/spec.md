# Feature Specification: Electron Desktop Terminal Window

**Feature Branch**: `spec/desktop-terminal-window`
**Created**: 2026-11-10
**Status**: Draft — spec review findings applied 2026-11-10; implementation started
**Tracking**: No Linear ticket recorded. Owner to confirm an existing ENG ticket or authorize a short one before any PR.
**Input**: "A terminal app in the Electron Desktop client, separate from the OS-view Terminal, launched from the top bar in its own window. Like herdr, it shows spaces across machines: this computer and every Matrix computer the user has. Ideally the app can also SSH to the remote computer."

## Goal

Give Electron Desktop users on macOS and Linux one native window that shows
local terminals and Matrix cloud terminals together, grouped by machine:
- **This Computer**: local shells, held by herdr-core (`hc`) so they survive an app restart.
- **Each Matrix computer** in their inventory: the existing Zellij-backed workspaces and tabs.

For Matrix computers, the new work is showing all computers at once instead of
only the selected one. Local terminals and a later direct-SSH transport are new.

## Owner Decisions (2026-11-10)

1. **Launcher**: a terminal icon in the Electron Desktop top bar opens the Terminal window, or focuses it if it is already open.
2. **Local backend**: herdr-core `hc` is the local holder, and local terminals must survive an app restart. It still has to pass a qualification spike first, because Core is a 0.1.x preview. `node-pty` in the main process is the fallback only if that spike fails.
3. **SSH endpoint**: the device connects directly to the computer's public address on port 22. There is no gateway tunnel.
4. **Platforms**: macOS and Linux only. Windows is out of scope.

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
2. Tabs created, renamed, reordered or closed in the new window show in the OS-view Terminal on that computer (Electron, Web Desktop, Web Canvas), and the reverse, after the next list refresh. Neither client keeps a private copy of the tab list.
3. When two clients attach to the same tab, the existing `lease=exclusive|observe` contract applies. The new window shows writer and observer states. It does not take the lease silently.
4. When a computer's credential expires or is revoked (401), only that section returns to "reconnect". Other sections stay attached.

### J3 — Local terminals on This Computer (P1, gated on the herdr-core spike)
The user opens a shell on the laptop in the same window, with the same tab
model, keyboard handling, copy/paste and theme as remote tabs. Local terminals
are held by an `hc` holder process outside the app.

**Acceptance**
1. A new local tab starts the user's login shell in their home directory. Its environment is built from an allowlist (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_*`, `TERM`, `COLORTERM`, `TMPDIR`, `SSH_AUTH_SOCK`, `XDG_*`) and the login shell's own startup files. Nothing else from the Electron process environment is passed, in particular no `MATRIX_*`, `ELECTRON_*`, `NODE_*`, `VITE_*`, `POSTHOG_*`, `CLERK_*` or token-bearing variables.
2. Quitting and relaunching the app (including after a crash) reattaches every local terminal that was alive. Herdr recovers kept terminals with a fresh shell, not a replay. The UI must say so truthfully, for example "Restored — new shell", and must never imply that the scrollback or running process was preserved when it was not.
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
- **FR-012** Delivery includes a separate public docs PR in `FinnaAI/matrix-os-site` under `content/docs/`, covering the Terminal window, local terminals, platform support (macOS/Linux) and SSH setup.

## Local Backend: herdr-core

### Shipping and version pinning
- `hc` is **bundled** in the app's resources, one binary per supported target: macOS arm64 and x64, and Linux x64 plus Linux arm64 if the desktop ships it.
- The app ships the exact version recorded in one manifest (`version`, per-target SHA-256, upstream source URL and tag). The build fetches that artifact, verifies its checksum and fails on mismatch. On macOS the binary is signed and notarized with the app.
- The app never runs an `hc` found on `PATH` or elsewhere on the system. It always runs the bundled binary, resolved from `process.resourcesPath`, and checks its checksum before the first spawn of each app version.
- **No independent auto-update.** `hc` changes only with a desktop release. Any updater or update check in `hc` must be disabled through configuration or flags. If it cannot be disabled, the spike fails (Q4).
- Bumping the `hc` version is a reviewed desktop PR and must respect the repo's 7-day `minimumReleaseAge` policy for the upstream release.

### Socket and process boundary
- **Private config and state.** The bundled holder runs with an app-private config, state and template directory under `<userData>/herdr/` (through `XDG_*` variables or equivalent flags, whichever the spike proves). It never reads or writes the user's own herdr installation (`~/.config/herdr-core`, its machines, templates or sockets), and a user's own `hc` never sees the app's terminals. Core's `notes` feature (typing notes into parent terminals) is disabled in the app's config.
- The app starts its holder with an explicit socket path in a private directory: `<userData>/herdr/`, created with mode 0700 and checked with `lstat` (not a symlink, owned by the user).
  - macOS `sun_path` limits paths to 104 bytes, so if `userData` is too long a short per-user directory under `$TMPDIR` is used with the same checks.
- Only the Electron main process connects to that socket. It is never passed to a renderer, a webview or a preload, never bridged to TCP, and never forwarded over SSH. The app never runs `hc connect` or `hc machine add`; Matrix computers come only from J2.
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

The spike also records two limits for reviewers:
- herdr's `hc connect` over SSH to a Matrix VPS would show herdr terminals, not Zellij workspaces, so it cannot replace J2.
- Kept terminals recover with a fresh shell, not a replay.

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
| `GET /api/ssh/connection` (new, name provisional) | Owner, Electron main | Gateway owner principal via computer-scoped bearer | Returns the computer's public IPv4/IPv6 and its host key fingerprints. `Cache-Control: no-store`. Called fresh for every connection attempt. Where the address comes from (platform record vs. host) is decided in planning, see Open Questions. |
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

### Credentials and errors

Per-computer tokens and SSH private keys stay in the Electron main process. Tokens
are never put in URLs except the existing `/ws/terminal/tab` query-token path, and
never logged. Renderers receive fixed error codes such as `computer_unavailable`,
`reconnect_required`, `identity_changed`, `local_unavailable` and
`local_version_mismatch`.

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

## Integration Wiring

- **Startup (main)**: `app.whenReady` creates the main window as today. It then:
  1. registers the Terminal-window IPC with its sender guard;
  2. creates `ComputerCredentialBroker({ authService, fetch, platformHost })`;
  3. installs Terminal-partition header injection that reads the broker;
  4. adds the top-bar launcher IPC (`terminal-window:open`, main window only), which creates the Terminal window lazily or focuses it.
- **Local backend**: `LocalTerminalHost({ binaryPath: resourcesPath/hc, manifest, socketDir })` is constructed on first This Computer use, or at startup if a holder socket exists, so restored terminals show immediately. It runs the version handshake (lifecycle above) and is detached, not stopped, on `before-quit`.
- **Cross-package**: the renderer imports only `@matrix-os/contracts` schemas. The OSC 7501 parser and visual-status derivation live in a shared pure module so the gateway and Electron use the same code. Its package home is decided in planning; no `globalThis`.
- **Gateway (SSH slice)**: new routes are registered next to the shell terminal routes with the same owner principal middleware, and added to `route-inventory.ts`.
- **Integration tests**:
  - two computer-scoped tokens attach to two real gateways at once while the main selection stays fixed;
  - a tab created in the window is listed by the shell Terminal's list call;
  - the packaged app restarts with the bundled `hc` and local terminals reattach;
  - device key register, fetch connection details, connect with a fingerprint match, revoke, then connect is refused, against a real sshd in a fixture, including a host-key change;
  - negative: every main-window-only channel rejects a Terminal-window sender, and every terminal channel rejects a main-window or unknown sender;
  - negative: Terminal-partition header injection attaches no bearer for a missing, unknown or non-inventory runtime target, or for a non-gateway origin.
- **Per-slice checkpoint**: each slice lands with its own integration test from this list (slice 1: sender-guard negatives and single-flight window; slice 2: two-computer attach and fail-closed injection; slice 3: packaged restart reattach; slice 4: parser-to-projection; slices 5–6: sshd fixture).

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
| Shutdown | Stop the timers, close sockets (detach only), and detach from the `hc` holder without stopping it. |

## Resource Management

- Broker: at most 20 tokens (inventory cap). Entries are evicted on inventory change, sign-out and expiry, and the sweep timer is cleared on quit.
- Attach: at most 4 live sockets, plus an LRU of 8 buffers using the existing serialized-buffer bounds.
- Local tabs: no count ceiling (terminal creation is rate-limited, not count-capped). Creation is limited to 10 per 10 seconds with a visible "try again in a moment" message; the window holds at most 8 live attachments, and the sidebar lists at most the 1 000 terminals the core reports. Renderer scrollback is capped at 10 000 lines per tab, and only visible panes keep a live xterm instance. Each tab's output buffer before render is capped at 1 MiB. One holder per OS user and app channel, and its restarts are bounded (above).
- Holder files: the socket directory is the only `hc` state the app creates. "End all local terminals" and uninstall guidance remove it. Holder logs, if any, go under `userData` with size rotation (cap set in planning after the spike).
- Status: the local projection holds at most 100 snapshots (same cap as the gateway store) with LRU eviction. The attention list is derived and never stored.
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
7. **Connection address source** (gate for slice 5): should `/api/ssh/connection` return the platform's recorded `publicIPv4`/`publicIPv6`, which needs a gateway→platform call, or have the gateway read its own public address? Both must be authoritative, not taken from request headers.
8. **sshd version and `expiry-time`** (gate for slice 5): not verified on the fleet.
9. **SSH client**: `ssh2` (new dependency) or the system OpenSSH binary? Not evaluated.
10. **`~/.ssh` sync** (gate for slice 5): `/home/matrix/home/.ssh` lives under the owner home. Whether sync or backup copies it off the VPS, or restores old keys onto a rebuilt computer, was not verified.
11. **Fleet sshd posture**: the brief's single-VPS sample (password auth on, `ufw` inactive) needs a fleet audit by the platform owner.

## Not In Scope

- **Windows.** Electron Desktop on Windows gets no Terminal window, local terminals or SSH in this feature, and the launcher icon is hidden there.
- Changing the VPS terminal backend (Zellij) or `packages/terminal-runtime`, and shipping herdr-core in the host bundle. herdr-core runs only on the user's device.
- `hc connect`, `hc machine add` and any herdr remote-machine aggregation
- A cloud-to-laptop reverse connector, moving tasks between machines, Herdr mods/panels, and durable task orchestration changes
- A gateway SSH tunnel or relay
- Changing sshd configuration or firewalls on customer VPSes. This is recommended only, and any future firewall must keep port 22 reachable.
- Non-Matrix SSH hosts. The SSH design allows them, but they are a follow-up.
