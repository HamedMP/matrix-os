# Feature Specification: Electron Desktop Terminal Window

**Feature Branch**: `spec/desktop-terminal-window`
**Created**: 2026-11-10
**Status**: Draft — owner review before planning
**Tracking**: No Linear ticket recorded. Owner to confirm an existing ENG ticket or authorize a short one before any PR.
**Input**: "A terminal app in the Electron Desktop client, separate from the OS-view Terminal, launched from the top bar in its own window. Like herdr, it shows spaces across machines: this computer and every Matrix computer the user has. Ideally the app can also SSH to the remote computer."

## Goal

Give Electron Desktop users one native window that lists every terminal they
own, grouped by machine: **This Computer** (local shells) and each Matrix
computer in their inventory. Matrix computers keep their existing Zellij-backed
workspaces and tabs; the new work is showing all computers at once instead of
only the selected one. Local terminals and a later SSH transport are new.

## Verified Current State

Each claim was checked in this worktree at `edd982c69`.

| Fact | Evidence |
| --- | --- |
| The desktop opens one `BrowserWindow`; events go only to `mainWindow`. | `desktop/src/main/index.ts:115,163-169,181` |
| No `node-pty` or `ssh2` in the desktop. xterm 6 and its addons are present. | `desktop/package.json:50-54` |
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
| Hetzner create sends `ssh_keys` (operator key `HETZNER_SSH_KEY_NAME`) and attaches no firewall. | `packages/platform/src/customer-vps-hetzner.ts:279-294`; `customer-vps-config.ts:112` |
| cloud-init creates the system user `matrix` with no `ssh_authorized_keys`, runs `ssh-keygen -A`, links `/home/matrix/.ssh` to `/home/matrix/home/.ssh`, and writes no `sshd_config` or firewall. | `distro/customer-vps/cloud-init.yaml:6-13,452,611-621` |
| Golden-snapshot activation also runs `ssh-keygen -A`, so a rebuilt or cloned computer has new host keys. | `packages/platform/src/golden-snapshot-service.ts:359-360` |
| `matrix-support-access` manages a separate `matrix-support` user with one operator Ed25519 key. | `distro/customer-vps/host-bin/matrix-support-access:5-28` |
| No gateway, platform or shell route lets an owner register an SSH public key. | `git grep` for `authorized_keys`, `ssh-ed25519`, ssh API paths in `packages/gateway/src`, `packages/platform/src` and `shell/src` |

The brief's live-VPS sshd sample (port 22 public, `PasswordAuthentication yes`,
`ufw` inactive) was not re-checked here. It is one sample, not a fleet audit.

## Affected Surfaces

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Electron Desktop | pass required | pass required | pass required | pass required | pass required |
| Web Canvas | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Web Desktop | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Web Mobile | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |
| Native Mobile | N/A* | N/A* | shared state unchanged, regression only | N/A* | N/A* |

\*Explicit platform limitation; needs reviewer approval. Rationale:
- A browser tab and the mobile apps cannot spawn local processes, hold a local
  PTY or open raw TCP/SSH, and they have no separate native window. "This Computer" and SSH are therefore only possible in Electron.
- The cross-computer Matrix view needs many computer-scoped credentials held
  outside the renderer. Only the Electron main process has a trusted credential store.
- Matrix workspaces and tabs stay one source of truth in the owner's gateway. A
  tab created, renamed, closed or running in the new window must look the same in every
  surface's existing Terminal. Those surfaces need only regression evidence that
  shared tab state is unchanged; they get no new UI.

## User Journeys

### J1 — Open the Terminal window (P1)
From the Electron top bar, the user clicks **Terminal**, or uses its shortcut
shown in the tooltip. A separate native window opens or comes to the front.
Clicking the trigger again focuses the open window; it does not open another one. The sidebar
lists **This Computer**, then each Matrix computer by label, in inventory order. Each
section shows its availability, workspaces and tabs. The window's size, position,
collapsed sections and last-focused tab persist across restarts.

**Acceptance**
1. Given a signed-in user with N≤20 computers, the window shows N Matrix sections plus This Computer within 3 s of a warm open. Each section loads independently, so one slow computer does not block the others.
2. Given an unavailable or stopped computer, its section shows its status and a retry. No error text leaks provider, path or token detail.
3. Given a signed-out app, the window shows a sign-in empty state, with headline, description and CTA, that hands off to the main window's sign-in. This Computer stays usable.
4. Closing the Terminal window never kills a Matrix tab's command and never closes the main window.

### J2 — Work across Matrix computers (P1)
The user expands any computer, opens or creates a tab and types. They do not
switch the app's selected computer, so the main window keeps its current computer.

**Acceptance**
1. Attaching to a tab on computer B while the main window is on computer A leaves the main window's selection, credential and profile unchanged.
2. Tabs created, renamed, reordered or closed in the new window show in the OS-view Terminal on that computer (Electron, Web Desktop, Web Canvas), and the reverse, after the next list refresh. Neither client keeps a private copy of the tab list.
3. When two clients attach to the same tab, the existing `lease=exclusive|observe` contract applies. The new window shows writer and observer states. It does not take the lease silently.
4. When a computer's credential expires or is revoked (401), only that section returns to "reconnect". Other sections stay attached.

### J3 — Local terminals on This Computer (P1, behind the spike gate)
The user opens a shell on the laptop in the same window, with the same tab
model, keyboard handling, copy/paste and theme as remote tabs.

**Acceptance** (final wording depends on the spike result)
1. A new local tab starts the user's login shell in their home directory with an inherited, filtered environment.
2. The local backend chosen by the spike decides what happens on app restart. The UI must state it truthfully: either "restored, with a fresh shell" or "ended".
3. Local terminal output and input never leave the device and are never sent to a Matrix computer or analytics.

### J4 — Cross-machine attention (P2)
A tab whose agent is waiting for input shows a badge in its machine section. A
window-level **Needs attention** list collects these across all machines.

**Acceptance**
1. A Matrix tab's status comes from the existing `AgentSessionStateStore` projection for that computer, the same one the OS-view Terminal shows. No second Matrix projection is introduced.
2. A local tab's status uses the same event schema and visual-status derivation, held in memory in the Electron main process. It is never written to any Matrix computer.

### J5 — SSH to a Matrix computer (P3, later slice)
The user enables "Direct SSH" for one computer. The app registers this device's
public key, pins the computer's host key and can open a direct SSH session or a
port forward.

**Acceptance**
1. The private key is generated on the device and never leaves it. Only the public key is sent.
2. The first connection succeeds only when the presented host key matches the fingerprint delivered over the authenticated gateway. A mismatch blocks the connection with a "computer identity changed" state. The app never offers a "trust anyway" prompt.
3. Sign-out, device removal or revocation from another device removes the key from the computer's `authorized_keys`. Hand-added keys are untouched.

## Functional Requirements

- **FR-001** The Terminal window is a second `BrowserWindow`, one instance per app. It uses its own preload that exposes only terminal channels, and a renderer entry built from the trusted renderer bundle. It keeps `contextIsolation`, `sandbox`, no `nodeIntegration`, and deny-all `window.open` the same as the main window.
- **FR-002** Every IPC channel the Terminal window uses must check the sender: the frame must be the Terminal window's main frame at its trusted URL. Main-window-only channels must reject it. Event fan-out must name its target window instead of assuming `mainWindow`.
- **FR-003** A main-process **computer credential broker** holds at most one access token per `(handle, runtimeSlot)` in the current inventory. It gets them from `POST /api/auth/runtime-selection` and never writes them to the profile or credential store. The selected-computer credential remains the only persisted one. Broker tokens expire with the parent session, are dropped on sign-out or `authGeneration` change, and are never exposed to any renderer.
- **FR-004** Requests from the Terminal window go through a dedicated session partition. Header injection picks the bearer from the request's runtime target (`runtime=` query or `/vm/<slot>` path, the same parser as `buildGatewayUrl`). It fails closed when the target is missing, unknown or not in the inventory, and only for the gateway origin.
- **FR-005** Token acquisition is lazy. It happens when a section is expanded or a tab is attached, never for all 20 computers at startup. It must stay under the platform limits (30/min per principal) with jittered backoff on 429.
- **FR-006** The window gets its own attach manager. It allows one live socket per visible pane, at most 4 at once, and keeps a separate buffer LRU of 8. This preserves the main window's single-attachment rule (L4) for its own `AttachManager`.
- **FR-007** Matrix workspace and tab state is read only from `/api/terminal/workspaces` on each computer. Layout-only preferences (section collapse, window bounds, last focus) are stored locally in Electron, keyed by `handle|runtimeSlot|workspaceId|tabId`. A local preference never creates, renames or deletes a server tab.
- **FR-008** The local backend is chosen only after the spike (§Spike Gate). Whichever wins, local processes run as the signed-in OS user, outside any renderer, behind the FR-002 IPC checks. Spawn, input, resize and kill calls are validated with bounded Zod schemas.
- **FR-009** OSC 7501 parsing (payload format to be confirmed, see Open Questions) produces `NormalizedAgentEventSchema` events. Matrix events are applied to that computer's existing `AgentSessionStateStore`, and local events to an in-memory projection that uses the same reducer. Unknown, oversized or malformed sequences are dropped and counted, never rendered as status.
- **FR-010** SSH (J5) uses one Ed25519 key per device. The private key is encrypted at rest with Electron `safeStorage` in a 0600 file under `userData`. The public key is registered through an authenticated owner-scoped gateway route (§Auth matrix), and the host key fingerprint is read from the same authenticated channel and pinned per `(handle, runtimeSlot)`.
- **FR-011** User-facing errors use fixed copy. Logs carry error names and correlation IDs, never tokens, key material, VPS IPs or terminal content.
- **FR-012** Delivery includes a separate public docs PR in `FinnaAI/matrix-os-site` under `content/docs/`, covering the Terminal window, local terminals and SSH setup.

## Spike Gate: Local Terminal Backend

The spike is throwaway code outside the shipped bundle. It ends with a written
decision in `specs/2691-desktop-terminal-window/research.md` before slice 3b
starts. It compares:

- **A: `node-pty` in the Electron main process** (or a utility process it owns)
- **B: herdr-core `hc` as a local holder process** reached over its Unix-socket JSON-RPC

Must-pass criteria (failing any one rules the option out):

| # | Criterion | How measured |
| --- | --- | --- |
| M1 | Builds, signs and notarizes in the existing desktop pipeline for mac arm64 and x64. Windows and Linux are also checked if the desktop ships them (`electron-builder.windows.mjs` exists). | CI-equivalent local package plus the DMG smoke steps from CLAUDE.md |
| M2 | Every dependency is installable under `minimumReleaseAge: 10080` and the frozen lockfile, with a compatible license. | `pnpm install --frozen-lockfile` in a scratch worktree |
| M3 | No local endpoint is reachable by other OS users. A socket or pipe must be owner-only (mode/ACL verified), and no TCP listener is opened. | `ls -l`/`icacls`, `lsof -i` |
| M4 | A renderer crash or window close does not kill local shells. A main-process crash either keeps them (B) or kills them cleanly with no orphan processes (A). | Kill tests with process-tree check |
| M5 | Input-to-echo latency within 10 ms of the existing remote xterm path on loopback, and throughput of at least 50 MB/s with `yes` without renderer stalls | Scripted benchmark |

Weighted criteria (used to choose once both pass): survival across app restart
(B's main benefit; truthful UI copy if A), maintenance risk (core 0.1.x,
preview protocol, one maintainer, about 150 open issues, versus node-pty's
history of Electron ABI rebuilds), binary size added, update path, Windows
parity, and the security model. `hc` grants command and file access to any
client of its socket with no per-client checks, so M3 is the only boundary.

The spike must also record:
- that `hc connect` over SSH to a Matrix VPS shows herdr terminals, not Zellij workspaces, and so cannot replace J2;
- that kept `hc` terminals recover with a fresh shell, not a replay.

No winner is presumed. If neither option passes M1–M5, slice 3b is deferred and This Computer
shows "Local terminals are not available yet".

## Security Architecture

### Auth matrix

| Boundary | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `GET /api/auth/computers` (existing) | Electron main | Parent session bearer | Unchanged |
| `POST /api/auth/runtime-selection` (existing) | Electron main broker | Parent session bearer | Reused to mint per-computer tokens without persisting them. Existing `bodyLimit` and rate limits apply. |
| `/api/terminal/workspaces*` (existing) | Terminal window renderer | Computer-scoped bearer injected by main (FR-004) | Unchanged gateway auth and mutation limits |
| `/ws/terminal/tab` (existing) | Terminal window renderer | Computer-scoped bearer, header or query token per the existing allowlist | Unchanged lease and ownership checks |
| Terminal-window IPC (new) | Terminal window main frame only | Sender-frame + URL check, Zod per channel | Main-window-only channels reject it |
| Local backend endpoint (new, spike) | Electron main only | OS ownership (M3) | No network listener |
| `GET /api/ssh/host-keys` (new, name provisional) | Owner | Gateway owner principal | Returns public host key fingerprints only |
| `GET/POST /api/ssh/device-keys` (new) | Owner | Gateway owner principal | `bodyLimit` 4 KiB; Zod: one `ssh-ed25519` key line, label ≤64 chars, device ID UUID |
| `DELETE /api/ssh/device-keys/:id` (new) | Owner | Gateway owner principal | `bodyLimit`; `:id` validated with Zod; repeat deletes are no-ops |
| sshd on the VPS (existing) | Device key | Public key | Out of scope to change. Platform owner is asked to set `PasswordAuthentication no` fleet-wide as a prerequisite. |

Collaboration principals (org members) and preview-terminal owners must be
**denied** on `/api/ssh/*`. Only the computer owner may register SSH keys.

### Input validation and writes

- Key routes accept only `ssh-ed25519 <base64> [comment]` matching the pattern used in `matrix-support-access`. Options, newlines and other key types are rejected.
- `authorized_keys` changes touch only a marked managed block (`# >>> matrix device keys` … `# <<<`). Lines outside the block are preserved byte-for-byte. Writes are serialized per computer and use `lstat` to refuse symlinked files or a symlinked `.ssh` beyond the cloud-init link. The file is written to a temp file in the same directory, `fsync`ed, renamed, and set to 0600. If the file was edited between read and rename, the write is retried; it never clobbers.
- Managed key lines carry `no-agent-forwarding,no-X11-forwarding` and an `expiry-time=` option when sshd supports it (version unverified), refreshed while the device stays signed in.
- A device key gives no more power than the existing owner terminal API, which already runs commands as `matrix`. It adds a direct network transport, which is why fleet-wide password-auth hardening is a prerequisite.

### Credentials and errors

Per-computer tokens and SSH private keys stay in the Electron main process. Tokens
are never put in URLs except the existing `/ws/terminal/tab` query-token path, and
never logged. Renderers receive fixed error codes such as `computer_unavailable`,
`reconnect_required` and `identity_changed`.

## Integration Wiring

- **Startup (main)**: `app.whenReady` creates the main window as today. It then registers the Terminal-window IPC with its sender guard, creates `ComputerCredentialBroker({ authService, fetch, platformHost })`, and installs Terminal-partition header injection that reads the broker. The Terminal window is created lazily on first launch request.
- **Local backend**: after the spike, `LocalTerminalHost` is constructed lazily on the first local tab and torn down on `before-quit`. For option B, it either spawns or connects to the holder.
- **Cross-package**: the renderer imports only `@matrix-os/contracts` schemas. The OSC 7501 parser and visual-status derivation live in a shared pure module so the gateway and Electron use the same code. Its package home is decided in planning; no `globalThis`.
- **Gateway (SSH slice)**: new routes are registered next to the shell terminal routes with the same owner principal middleware, and added to `route-inventory.ts`.
- **Integration tests**:
  - two computer-scoped tokens attach to two real gateways at once while the main selection stays fixed;
  - a tab created in the window is listed by the shell Terminal's list call;
  - device key register, connect with a pinned host key, revoke, then connect is refused, against a real sshd in a fixture.

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Inventory fetch fails | Matrix sections show retry. This Computer keeps working. |
| Token mint 429/5xx | Per-section backoff (1 s→30 s, jittered), no global retry storm |
| Computer 401 | Drop that broker token only. Re-mint once; if it fails again, show reconnect. |
| Parent session expires | All broker tokens are dropped and all Matrix sections detach. The window shows sign-in. |
| Socket handshake timeout | Existing `ShellSocket` timeout and reconnect apply per pane. |
| Main window switches computer | Broker tokens are unaffected. The new window does not follow the selection. |
| Local backend crash | Tabs show "ended", or "restored with a fresh shell" (B). No silent respawn loops: at most 3 restarts per 5 min. |
| OSC flood or malformed payload | Parser caps payloads at 4 KiB and events at 20/s per tab. Excess is dropped and counted. |
| `authorized_keys` concurrently edited | Retry up to 3 times, then return a generic 409. Hand edits are kept. |
| Host key mismatch (rebuild, golden clone, MITM) | Block the connection and re-fetch the fingerprint over the gateway. If it matches the new key, pin it and tell the user the computer's identity changed. Otherwise stay blocked. |
| Computer deleted or rebuilt | Its device-key registration is gone with the VPS. The client drops its pin and key mapping on the next inventory refresh. |
| Sign-out while offline | A local revocation intent is queued and retried on next sign-in. `expiry-time` bounds exposure if the retry never happens. |
| Shutdown | Stop the timers, close sockets (detach only), then close the local backend per the spike outcome. |

## Resource Management

- Broker: at most 20 tokens (inventory cap). Entries are evicted on inventory change, sign-out and expiry, and the sweep timer is cleared on quit.
- Attach: at most 4 live sockets, plus an LRU of 8 buffers using the existing serialized-buffer bounds.
- Local tabs: a soft cap of 32 with a visible message, plus rate limiting on create. Each tab's output buffer before render is capped at 1 MiB.
- Status: the local projection holds at most 100 snapshots (same cap as the gateway store) with LRU eviction. The attention list is derived and never stored.
- SSH: at most 10 managed device keys per computer, enforced in the route. Stale-device cleanup is offered in the UI.
- Third parties: none in slices 1–4. Option B adds a bundled third-party binary (Apache-2.0); a local holder sends nothing off-device. Analytics record only coarse events such as window open, section count bucket and local-tab created, never commands or output.

## Delivery Slices (one native stack, 6 PRs)

The brief's order is kept. The credential broker is split out because it is the
riskiest boundary, and SSH is split into server and client layers.

1. **Window shell**: second window, dedicated preload, sender-guarded IPC, top-bar launcher, machine-sectioned sidebar fed by the existing inventory, and empty/loading/error states. Matrix sections are read-only.
2. **Computer credential broker + aggregation**: per-computer tokens, Terminal-partition injection, independent attach manager, and tab CRUD through the existing gateway API, with cross-surface parity tests.
3. **Local backend**: the spike decision recorded in `research.md` (throwaway code is not committed), then the chosen backend behind FR-008.
4. **Status**: shared OSC 7501 parser, ingestion into the existing projection, local in-memory projection and the attention list.
5. **SSH server side**: device-key and host-key routes, the managed `authorized_keys` writer, and the sshd fixture tests.
6. **SSH client side**: device key generation and storage, host key pinning, and direct shell and port forwarding.

Each layer needs live Electron Desktop screenshots and a recording, and
regression evidence that shared tab state is unchanged on the other surfaces,
per CLAUDE.md. Recommended reviewers are the Electron Desktop owner,
terminal/gateway owner and platform owner (for the SSH hardening prerequisite).

## Risks

- **Credential fan-out**: holding up to 20 live computer tokens enlarges what an Electron main-process compromise can reach. This is mitigated by lazy minting, no persistence and dropping tokens on sign-out.
- **IPC widening**: today's generic `handle()` trusts any frame with the preload. A second window makes the missing sender checks a real exposure; FR-002 must land in slice 1.
- **Divergence**: the two terminal UIs could drift. Both must share the terminal view components and socket client and keep different window chrome only.
- **herdr-core maturity**: a preview protocol from a young, single-maintainer project. The spike's must-pass gates and the "no winner presumed" rule contain this risk.
- **Public port 22 with password auth (one sample)**: SSH value depends on fleet hardening this spec does not do.

## Open Questions

1. **Linear ticket**: is there an existing ENG ticket?
2. **OSC 7501 payload format**: no definition exists in the repo, and herdr's spec was not read here. Confirm the source and schema.
3. **OSC visibility for Matrix tabs**: the gateway sees output only through per-viewer attaches (spec 606, `terminal-ws-routes.ts`), so gateway parsing misses tabs nobody is watching. Options:
   - (a) accept status only while attached;
   - (b) observe output in `packages/terminal-runtime`, which needs a separate spec under decision 1;
   - (c) keep the existing agent hook bridge as the Matrix source and use OSC 7501 only for local tabs.

   Also unverified: whether Zellij 0.44.1 passes unknown OSC sequences through to attached clients.
4. **Renderer bundle**: should the Terminal window be a second Vite entry or a route of the existing renderer? `electron.vite.config.ts:99` has one entry today.
5. **Top-bar placement**: the exact launcher location is unconfirmed (`DesktopHeaderTabs.tsx` or `DesktopModeControls.tsx`). This is a design decision for the Electron owner.
6. **Local restart survival**: is surviving app restart a P1 requirement? This decides how heavily the spike weighs it.
7. **SSH target address**: the client needs a reachable host. Exposing a computer's public IP to the owner's device is a new disclosure. Should the platform return it, or should SSH tunnel over the authenticated gateway?
8. **sshd version and `expiry-time`**: not verified on the fleet.
9. **SSH client**: `ssh2` (new dependency) or the system OpenSSH binary? Not evaluated.
10. **`~/.ssh` sync**: `/home/matrix/home/.ssh` lives under the owner home. Whether sync or backup copies it off the VPS was not verified.
11. **Windows support**: are Windows desktop builds in scope for local terminals, and does `hc` support Windows?
12. **Fleet sshd posture**: the brief's single-VPS sample (password auth on, `ufw` inactive) needs a fleet audit by the platform owner.

## Not In Scope

- Changing the VPS terminal backend (Zellij), `packages/terminal-runtime`, or shipping herdr-core in the host bundle
- A cloud-to-laptop reverse connector, moving tasks between machines, Herdr mods/panels, and durable task orchestration changes
- Changing sshd configuration or firewalls on customer VPSes. This is recommended only.
- Non-Matrix SSH hosts. The SSH design allows them, but they are a follow-up.
