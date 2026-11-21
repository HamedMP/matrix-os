# 2701 · Herdr sessions in self-hosted Matrix

Status: draft for review. Requester and owner: Hamed.
Linear: [ENG-519](https://linear.app/matrix-os/issue/ENG-519/show-herdr-sessions-in-self-hosted-matrix-and-pair-machines).
Builds on: [2692 Herdr parity](../2692-herdr-parity/spec.md),
[651 Electron Terminal window](../651-desktop-terminal-window/spec.md) (herdr-core client, J6 Herdr sessions),
[103 self-host installer](../103-self-host-installer/spec.md).
Related: [2697 Chat and Terminal agents](https://github.com/HamedMP/matrix-os/pull/3472) (agent session model),
[2698 Mac pairing](https://github.com/HamedMP/matrix-os/pull/3483) (device identity, Yuhan).

## Goal

Someone who already runs Herdr on a server installs Matrix there with one
command. Matrix shows their existing Herdr sessions next to Matrix terminals in
Web Desktop, Web Canvas and Electron Desktop, with status, attention and the
`matrix shell` verbs. The Herdr app keeps working against the same sessions.
The install offers browser use and puts the UI behind Tailscale or Headscale
instead of a password page.

## Decisions (Hamed, 2026-11-21)

1. **Reverse spec 651 owner decision 5.** The gateway lists and attaches Herdr
   terminals. Electron's SSH path (651 J6) stays for computers without this
   adapter.
2. **Show Herdr only when it exists.** A "Herdr sessions" group appears only
   when the computer has a reachable herdr-core with at least one terminal.
   Otherwise there is no Herdr UI and every terminal is a Matrix terminal.
   New terminals created from Matrix are always Matrix terminals.
3. **Own account.** Self-host runs as the installing person's Unix account, so
   the gateway reaches their herdr-core as them.
4. **Private-network login.** Tailscale or Headscale is the default access
   path. nginx Basic Auth remains only as an explicit, warned fallback.
5. **Browser use is in the installer**, offered as a prompt.
6. **Later, not in this stack:** Matrix AI gateway login and billing for
   self-host; pairing more machines from Settings; self-host updates (design
   notes below so this stack does not block them).

## Today (main @ `b37f50a08`)

- The managed and self-hosted gateway runs terminals on Zellij
  (`packages/terminal-runtime`). It does not know herdr-core exists.
- Electron already speaks herdr-core: `desktop/src/main/local-terminals/`
  `hc-protocol.ts` (frames), `hc-client.ts` (handshake, calls, attach, credit
  flow control), `hc-sessions.ts` (list, create rate limit, attachment slots,
  acks), `herdr-session-host.ts` (a core the app does not own: only
  `terminal.list|run|attach|kill`, 0.1.x from 0.1.14, given any byte stream).
- `scripts/install-server.sh` creates a system user `matrix`, requires
  `MATRIX_HOME` under `/home/matrix`, protects the UI with nginx Basic Auth, and
  does not install browser use. Browser use exists for managed computers
  (`matrix-install-browser`, `matrix-browser-runtime.service`).

## Design

### Layer 1 · Shared herdr-core client package

Move `hc-protocol`, `hc-client`, `hc-sessions`, `herdr-session-host` and their
tests into `packages/herdr-core-client` (Node only, no Electron imports).
`desktop/src/main/local-terminals/*` re-exports from it with the same names,
so Electron behaviour and open PRs touching `host.ts` (Yuhan's ENG-495 stack)
only need an import rebase. No behaviour change; Electron tests must pass
unchanged.

### Layer 2 · Gateway Herdr adapter

`packages/gateway/src/herdr/`:

- **Transport.** `open()` spawns `herdr-core connect` as the gateway's own user
  (decision 3) and uses its stdio as the byte stream, exactly as 651 J6 does
  over SSH. No socket path is hard-coded; herdr-core resolves its own. Missing
  binary → `not-installed`; handshake outside 0.1.x ≥ 0.1.14 → `unsupported`.
- **Same restrictions as J6.** Only `terminal.list`, `terminal.run`,
  `terminal.attach`, `terminal.kill`, plus read-only status/label methods if
  the core advertises them in `hello.methods`. Matrix never changes the user's
  Herdr config, templates or machine list.
- **Discovery.** On start and every 30 s (and on demand), list terminals. Cache
  the list (≤ 500, 2 s TTL). No herdr-core or zero terminals → the group is
  hidden (decision 2).
- **Routes.**
  - `GET /api/terminal/herdr` → `{available, status, sessions[]}` with
    `{id, title, cwd?, status?, statusMessage?, labels?}`.
  - `WS /ws/terminal/herdr?id=` → attach, same frame format and lease rules as
    `/ws/terminal/tab`, bridged to the herdr-core channel with its credit flow
    control. Query-token auth registered like `/ws/terminal/tab`.
  - `DELETE /api/terminal/herdr/:id` → `terminal.kill`, owner-only,
    confirmation in UI.
- **Verbs and status.** Herdr terminals join 2692's verbs through a
  `TerminalRef`-compatible ref (`workspaceId: "herdr"`, `tabId` derived as a
  stable hash of the herdr id, mapping kept in a bounded LRU). `read`, `send`,
  `keys`, `wait` work; `interrupt` sends Ctrl+C. Status comes from herdr-core's
  own reports (OSC 7501 is native there), so Herdr sessions get Herdr's five
  words without hooks, and feed the attention pop-up and later the 2697 inbox.
- **Coexistence.** The Herdr app attaches to the same core concurrently.
  Viewers observe by default (`lease=observe`); a pane that asks for and holds
  the exclusive lease, under the same rules as `/ws/terminal/tab`, is the
  writer: it types and sets the terminal's size. Only the writer resizes, so
  Matrix never resizes a terminal while nobody in Matrix is typing in it.
- **Writer size for verbs.** The adapter remembers the last size a Matrix
  writer used per terminal (LRU, bounded). `send`/`keys` type through a short
  attachment at that size (120×36 when none), so a verb does not fight the
  open pane's size. `read` attaches as an observer and renders the core's paint
  on a grid at least as large as the last writer's size, bounded to the
  largest allowed terminal (500×200), and 300×100 when no writer is known
  (≤ 10,000 scrollback lines, ≤ 8 MiB), so the core's screen is neither
  wrapped nor clipped. The requested history depth is passed to the core and
  is part of the short (400 ms) capture cache key.

### Layer 3 · Surfaces

- Shared `packages/ui` group component, "Herdr sessions", rendered after the
  project workspaces in the Terminal app on Web Desktop, Web Canvas and the
  Electron OS-view Terminal, and in the Electron Terminal window's computer
  section (replacing the SSH path when the gateway adapter is available).
- Rows show title, cwd, status dot; actions Open, Close (confirm). No create
  action: new terminals are Matrix terminals (decision 2).
- `matrix shell list` prints a "herdr" section when present.
- Native and Web Mobile: list and attach through the same routes (follow-on;
  recorded as N/A for this stack, needs reviewer approval).

### Layer 4 · Installer

`install-server.sh` gains questions, each with a flag for non-interactive use.
With no TTY, defaults apply and nothing blocks.

| Question | Flag | Default |
| --- | --- | --- |
| Run Matrix as which account? | `--user <name>` | `$SUDO_USER`, refuse `root` |
| Show existing Herdr sessions? (asked only if `herdr-core` is on that user's PATH) | `--herdr` / `--no-herdr` | yes when found |
| Enable browser use? | `--browser` / `--no-browser` | yes |
| How will you reach Matrix? | `--access tailscale\|headscale\|public` | `tailscale` |
| Headscale server | `--login-server <url>` | — |

- **Own account (spike S1 first).** Today many paths assume user `matrix` and
  `/home/matrix`. S1 lists every assumption in `install-server.sh`, systemd
  units and `distro/customer-vps/host-bin`, and picks one of:
  (a) parametrise the run user (`MATRIX_RUN_USER`, `MATRIX_HOME` under that
  user's home, e.g. `~/matrix`), or (b) keep the `matrix` system user and add
  a tiny per-user `matrix-herdr-bridge.service` running as the person that
  exposes `herdr-core connect` on a socket only the gateway's group can open.
  (a) is the decision; (b) is the fallback if S1 shows (a) would fork the
  managed VPS layout. Either way, owner data rules (AGENTS.md "user data
  invariant") hold.
- **Browser use.** Runs the existing `matrix-install-browser` and enables
  `matrix-browser-runtime.service` for the run user; verification step waits
  for its health check. Failure warns and continues (core readiness must not
  depend on it).
- **Tailscale / Headscale.** Install Tailscale from its signed apt repo, run
  `tailscale up` (with `--login-server` for Headscale; the auth URL is printed,
  or `--authkey` is read from a file, never argv). Serve Matrix with
  `tailscale serve` over HTTPS on the tailnet only; nginx listens on loopback.
  The gateway trusts the `Tailscale-User-Login` header only from the local
  `tailscale serve` proxy and only when it matches the owner login recorded at
  install. `public` keeps today's nginx Basic Auth with a printed warning and
  docs pointing to the private options.
- Telemetry stays opt-out as today and records only the chosen options, never
  hostnames, logins or keys.

### Layer 5 · Electron terminal performance

Findings from studying herdr-app are in [`research.md`](./research.md).
Herdr is native (GPUI + libghostty-vt), so we keep xterm.js but adopt what
transfers, as one focused PR measured before and after (attach-to-first-paint,
switch time across 10 tabs, frame time under heavy output, memory):

1. Keep the last 6 Terminal-window tabs mounted, hidden and attached (LRU);
   today every switch rebuilds xterm and WebGL and re-attaches.
2. Reset xterm before the core's attach repaint and stop also writing our own
   snapshot; reading the code, this likely duplicates scrollback today.
3. Bytes as `Uint8Array` over a `MessagePort`, batched input, no per-read
   `Buffer.concat`.
4. Send FOCUS and display FACTS frames.

## Later (designed for, not built here)

- **Pairing more machines.** Settings → Computers → "Add a machine" prints a
  one-line install with a short-lived join code; the new machine joins the same
  tailnet (Tailscale or Headscale) and registers with the first computer over
  it. Reuse 2698's device identity (Ed25519, challenge, revision) rather than a
  new scheme. Each machine's Matrix and Herdr sessions appear as their own
  section, like Herdr's machine list.
- **Self-host updates.** We cannot push to these computers. Plan: a systemd
  timer runs `matrix-update check` daily against the public channel feed,
  Settings → System → Updates shows it (already exists), the owner clicks
  install or opts into auto-install for security releases. Bundles must carry
  a signature verified against a key shipped in the installed bundle, not only
  a `.sha256` fetched from the same origin as today. Rollback keeps the
  previous `/opt/matrix/app`.
- **Matrix AI gateway.** "Connect to Matrix account" in Settings issues a
  scoped token from the platform for the funded gateway and billing.

## Acceptance

1. On a fresh Ubuntu VPS with Herdr installed and two Herdr terminals running,
   `curl … install-server.sh | sudo bash` with defaults finishes; the printed
   tailnet URL opens Matrix; Terminal shows "Herdr sessions" with both; opening
   one shows live output; typing works; the Herdr app still shows and drives
   both.
2. On a VPS without Herdr, no Herdr UI appears anywhere.
3. `matrix shell read` and `wait` work on a Herdr session; an agent in a Herdr
   terminal that turns blocked raises the attention pop-up.
4. Browser use works from Chat on the self-hosted computer.
5. With `--access public`, the warning is printed and Basic Auth protects
   every path; with Tailscale, nothing listens on a public interface.
6. Electron Desktop tests and the 651 J6 tests pass unchanged after layer 1.

## Surface matrix (target)

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass | pass | pass | pass | pass |
| Web Desktop | pass | pass | pass | pass | pass |
| Electron Desktop | pass | pass | pass | pass | pass |
| Web Mobile | N/A (follow-on) | N/A | N/A | N/A | N/A |
| Native Mobile | N/A (follow-on) | N/A | N/A | N/A | N/A |

Mobile N/A: the routes are shared, only the mobile list/attach UI is deferred.
Needs reviewer approval.

## Security architecture

| Route | Principal | Check |
| --- | --- | --- |
| `GET /api/terminal/herdr` | Owner (self-host gateway auth) | Owner only; org members never see Herdr sessions |
| `WS /ws/terminal/herdr` | Owner, query token | Same; observe lease by default |
| `DELETE /api/terminal/herdr/:id` | Owner | `bodyLimit`, id schema, UI confirmation |

- herdr-core's socket has no authentication of its own; any process of the
  same Unix user is trusted (research.md). Access therefore equals a shell as
  the run user. The adapter is enabled
  only on self-host (or managed computers whose run user owns the core) and
  only for the owner principal.
- Allowed-method list enforced in the shared client (`restrictHcConnection`).
- Ids validated (`^[A-Za-z0-9_-]{1,128}$` or the core's documented format),
  titles and cwd bounded and sanitised before display.
- Errors are coarse (`not-installed`, `unsupported`, `unavailable`); no paths,
  versions or stderr reach clients.
- Tailscale identity header accepted only on loopback from the serve proxy and
  only for the recorded owner login; any other value is rejected.
- Installer: Tailscale auth keys read from a root-only file and deleted after
  use; never in argv, logs or telemetry.

## Integration wiring

- Gateway start: after the terminal runtime, start the Herdr adapter if
  `MATRIX_HERDR=on` (installer writes it); register routes; register the status
  source with the terminal-agent status pipeline (2692) so verbs, events and
  attention see Herdr terminals.
- Shutdown: close attachments, then the herdr-core connection; drain WS
  subscribers first.
- Electron Terminal window prefers the gateway adapter when
  `GET /api/terminal/herdr` reports `available`, else falls back to J6 SSH.

## Failure modes

- herdr-core restarts or upgrades: connection drops, adapter backs off
  1 s → 30 s, attached clients see "reconnecting" and resume; list refreshes.
- herdr-core upgraded past 0.1.x: `unsupported`, group shows a short notice
  for the owner only.
- Slow client: credit flow control stops reading from the core channel for
  that viewer only; other viewers and the Herdr app are unaffected.
- Gateway restart: no Herdr state is owned by Matrix; nothing to recover
  beyond the LRU id map, rebuilt from the next list.

## Deadlines and cleanup

| Wait | Deadline | On expiry |
| --- | --- | --- |
| `herdr-core connect` handshake and each core call | 10 s | Child killed (SIGTERM, SIGKILL after 2 s); adapter reports `unavailable` and retries with 1 s → 30 s backoff |
| First paint on a new viewer | 250 ms | Viewer is attached anyway; the paint follows |
| `read` capture | 1.5 s (quiet after 120 ms of no output) | Returns what was rendered; attachment closed |
| Installer: find `herdr-core` on the login PATH | 15 s | Treated as not installed |
| Installer: install Tailscale | 300 s | Install fails with a message |
| Installer: Tailscale login (auth key, or the interactive wait) | 120 s | Warns, prints the retry command, continues without private access |
| Installer: browser use install, then health check | 30 min, then 60 s | Warns and continues; the unit retries at boot |

Every spawned child and attachment is closed on its deadline; nothing is left
waiting after the installer exits or the gateway shuts down.

## Resource management

- One herdr-core connection per gateway; attachments share the existing slot
  budget (`createAttachmentSlots`).
- List cache 2 s; id map LRU 1,024; WS viewers per session ≤ 8; per owner ≤ 32
  with stale eviction and shutdown drain.
- Spawned `herdr-core connect` child is killed on close and on gateway exit.

## Delivery stack (one native stack, ENG-519)

| # | PR | Main code |
| --- | --- | --- |
| 1 | Spec (this file) and `research.md` | specs |
| 2 | Shared `packages/herdr-core-client`, Electron re-exports | packages, desktop |
| 3 | Gateway Herdr adapter, routes, verbs and status | gateway |
| 4 | "Herdr sessions" group on three surfaces, `matrix shell list` | packages/ui, shell, desktop, sync-client |
| 5 | Installer: own account (after S1), Herdr, browser use, Tailscale/Headscale | scripts, distro, docs |
| 6 | Electron terminal performance from herdr-app findings | desktop |
| — | Public docs: self-host install, Herdr sessions, private network (separate PR in `FinnaAI/matrix-os-site`, `content/docs/`) | site repo, after this stack merges |

## Risks and open questions

1. **Own account vs managed layout** (S1). If parametrising the run user
   touches too much shared host code, use the bridge fallback.
2. **herdr-core protocol stability.** We pin to 0.1.x from 0.1.14 and
   negotiate features; a breaking 0.2 needs an adapter update.
3. **Two clients, one terminal size.** Matrix observes by default to avoid
   fighting the Herdr app over size.
4. **Tailscale dependency.** Requires an account (or a Headscale server);
   `public` stays available with a warning.
