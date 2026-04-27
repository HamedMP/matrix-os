# 068: Zellij-Native Shell, Unified CLI, and VSCode Contract

## Overview

Today the Matrix OS CLI surface is fragmented:

- A **dev CLI** at `bin/matrixos.{mjs,ts}` registered via the root `package.json`'s `bin` exposes `start / send / status / doctor` and has its own help text. It is meant for in-repo testing.
- A **published CLI** at `packages/sync-client/` (npm `@finnaai/matrix`, also `matrix` / `matrixos` / `mos`) exposes `login / logout / sync / peers / keys / ssh` via citty.
- The web shell (`shell/src/components/terminal/TerminalApp.tsx`) drives **gateway PTY sessions** as one-off tabs, with an opt-in "Launch Zellij" button per tab.
- `matrix ssh` attaches a `tmux` session called `main` on the SSH bastion (`packages/sync-client/src/cli/commands/ssh.ts:67`).

This means three different "session" models (gateway PTY, in-tab zellij, bastion tmux) and two different CLIs.

This spec replaces all of that with **one CLI**, **zellij-native sessions everywhere a user-facing terminal lives**, and a **stable contract for the upcoming VSCode extension**. Local development and the published cloud experience use the same binary against different profiles.

## Motivation

- **One mental model.** When the user opens a terminal -- in the browser, in the CLI, or in VSCode -- they see the same set of zellij sessions, with the same tabs, the same panes, and the same layouts.
- **Cloud-first CLI.** `matrix login` should be the obvious first command, not buried under dev verbs that only matter inside the repo.
- **Local test = published.** Removing the dev CLI eliminates the divergence trap. A single `--profile local` flag flips the same binary onto a localhost stack.
- **Extensibility.** The VSCode extension, the upcoming Raycast extension, and any future scripted integration all need a stable, machine-readable contract. The local sync daemon already exists and is the natural place for that contract to live.

## Goals / Non-Goals

### Goals

1. Delete the in-repo dev CLI and make `@finnaai/matrix` the only CLI.
2. `matrix shell` namespace: zellij sessions, tabs, panes, and layouts as first-class CLI verbs.
3. Gateway endpoints that wrap zellij as the source of truth for sessions/tabs/panes.
4. Profiles: `~/.matrixos/profiles.json` with `cloud` and `local` predefined, plus `--dev` sugar for `--profile local`.
5. Daemon IPC extended into a versioned protocol (`v: 1`) used by both the CLI and the VSCode extension.
6. New user-facing docs page at `www/content/docs/guide/cli.mdx`.
7. `matrix shell new <name>` creates **and** attaches (per design call).
8. With no args, `matrix shell` prints subcommand help (kubectl-style; per design call).
9. Tabs may be anonymous (zellij default) but `--name` is documented as the recommended path.

### Non-Goals

- Web shell rewrite to use zellij sessions directly. Phase 4; out of scope for this spec.
- Replacing `matrix ssh`'s tmux attach with zellij. The bastion is a different surface; tracked separately.
- Headless `zellij` plugin/RPC integration. v1 shells out to the `zellij` binary and parses text output.
- New web/marketing site copy for the CLI launch.

## Architecture

```
                user's container (matrixos-{handle})
                +------------------------------------+
                | zellij sessions (the source of truth)
                |   |- "main"   tabs/panes/layout    |
                |   |- "code"   tabs/panes/layout    |
                |   `- "agent"  tabs/panes/layout    |
                |            ^                       |
                |            |  zellij attach <name> |
                |   gateway (in-container, :4000)    |
                |     |- REST: list/create/destroy   |
                |     |  (shells out to zellij CLI)  |
                |     `- WS:  PTY <-> zellij attach  |
                +----------+-------------------------+
                           | /api/sessions, /ws/terminal?session=
              +------------+-------------+
              v            v             v
         web shell     matrix CLI   VSCode extension
                           ^
                           | ~/.matrixos/daemon.sock (JSON-line, versioned)
                           v
                        sync-client daemon
                        (multiplexer for live streams)
```

Zellij is already installed in the user container image (`Dockerfile:122`, `Dockerfile.dev:80`) with a pinned version and SHA. No image changes required for v1.

### Where zellij runs

Zellij runs **inside the user container**, not in the gateway process. The gateway shells out via `child_process.execFile("zellij", [...])` for control operations and `child_process.spawn("zellij", ["attach", name], { pty: true })` for the WS bridge. Since the gateway is itself in-container (same `matrixos-{handle}` container as the user shell), there is no docker-exec hop.

### Why not headless / RPC

Zellij has a plugin API but no stable JSON-output mode for `list-sessions`, `query-tab-names`, etc. Parsing the human-readable output is brittle but well-bounded for the small set of commands we use, and changes are gated to specific zellij versions we pin in the Dockerfile.

For state we cannot reliably read from zellij (per-tab cwd, per-pane command, layout drift after manual edits), the gateway maintains a **shadow registry** at `$MATRIX_HOME/system/sessions.json`. The registry is best-effort: it records what we asked zellij to do, and is reconciled against `zellij list-sessions` output on each list call.

## Server-side endpoints

All under `packages/gateway/src/server.ts`. Auth: existing sync JWT (Bearer or `?token=`). Errors follow the existing `{ error: { code, message } }` shape.

### Sessions

```
GET    /api/sessions
       => [{ name, status: "active"|"exited", tabs: [{ name?, idx }], attachedClients, createdAt }]
       Implementation: parse `zellij list-sessions --no-formatting` + reconcile with shadow registry.

POST   /api/sessions
       body: { name: string, layout?: string, cwd?: string }
       => { name, created: true }
       Implementation: `zellij --session <name> --layout <layout-or-default> options --attach-to-session false`
       run detached so it persists. Validate `name` against /^[a-z][a-z0-9-]{0,30}$/.

DELETE /api/sessions/:name?force=1
       => { ok: true }
       Implementation: `zellij delete-session <name>` (or `kill-session` with force).
```

### Tabs

```
GET    /api/sessions/:name/tabs
       => [{ idx, name?, focused: boolean }]
       Implementation: shadow registry primary; reconciled via `zellij action query-tab-names`
       (which returns names only, no indices -- registry holds the indices).

POST   /api/sessions/:name/tabs
       body: { name?: string, layout?: string, cwd?: string }
       => { idx, name }

DELETE /api/sessions/:name/tabs/:idx
       => { ok: true }
       Implementation: `zellij action go-to-tab <idx>` then `zellij action close-tab`.
```

### Panes

```
POST   /api/sessions/:name/panes/split
       body: { direction: "right"|"down", cmd?: string, cwd?: string }
       => { ok: true }
       Implementation: `zellij action new-pane --direction <...> [-- <cmd>]`.

DELETE /api/sessions/:name/panes/focused
       => { ok: true }
       Implementation: `zellij action close-pane`.
       Pane targeting is by-focus only in v1 (zellij's CLI does not expose stable pane IDs).
       Implication: scripts that split + run a command + close the pane later
       must rely on the focused-pane invariant or use `zellij action focus-next-pane`
       to navigate. Stable pane IDs would require either a zellij plugin or
       reading $ZELLIJ_PANE_ID inside the spawned command -- both are out of scope
       for v1.
```

### Layouts

```
GET    /api/layouts
       => [{ name, path, modifiedAt }]
       Implementation: `ls $MATRIX_HOME/system/layouts/*.kdl`.

GET    /api/layouts/:name
       => { name, kdl: string }

PUT    /api/layouts/:name
       body: { kdl: string }
       => { ok: true }
       Validation: parse with a KDL parser before write to reject malformed input.

DELETE /api/layouts/:name
       => { ok: true }

POST   /api/sessions/:name/layout/dump
       => { kdl: string }
       Implementation: `zellij --session <name> action dump-layout` (zellij 0.44.x).
       Used by `matrix shell layout save <name>` to snapshot the active session.
```

### WebSocket bridge

```
WS /ws/terminal?session=<name>[&fromSeq=<n>]
   On connect: spawn `zellij attach <name>` PTY in the user's home dir.
   Existing replay-buffer protocol (attached/output/replay-start/exit/error)
   carries over unchanged from the current /ws/terminal implementation.
```

The query parameter `?cwd=` is dropped -- sessions are addressed by name only. The auto-create-on-attach path used by the current web shell is retired.

**Auth on the WS upgrade.** Browsers can't set headers on WS upgrades, so the existing flow uses `?token=<short-lived-ws-token>` from `GET /api/auth/ws-token`. Node clients (CLI, VSCode extension) can set headers, so they pass the long-lived sync JWT as `Authorization: Bearer <token>` directly -- the gateway already accepts both per `packages/gateway/src/server.ts:1584-1770`. CLI implementations should prefer the bearer header path (no extra round-trip for a ws-token).

**Multi-client attach.** Zellij natively supports multiple `attach` clients on one session (mirrored view, input from any goes to the focused pane). The gateway therefore allows multiple WS connections to the same session, each spawning its own `zellij attach` process. We do **not** multiplex inside the gateway or daemon -- see "Daemon role split" below.

## CLI surface

Source moves remain inside `packages/sync-client/`. New citty subcommands under `packages/sync-client/src/cli/commands/`:

```
matrix
+-- login [--platform URL] [--profile NAME]
+-- logout
+-- whoami                                    handle, gateway, token expiry
+-- status                                    daemon, sync, gateway, last error
+-- doctor                                    deeper diagnostics + fix hints
|
+-- profile
|     +-- ls
|     +-- show [<name>]
|     +-- use <name>
|     `-- set <name> --platform ... --gateway ...
|
+-- shell                                     (alias: matrix sh)
|     +-- (no args: print subcommand help)
|     +-- ls
|     +-- new <name> [--layout <name|path>] [--cwd <path>]
|     +-- attach <name>                       (alias: connect)
|     +-- rm <name> [--force]
|     +-- tab
|     |     +-- ls [<session>]
|     |     +-- new [<session>] [--name] [--layout] [--cwd]
|     |     +-- go <n|name>                  Integer-first parsing: "3" -> idx 3,
|     |     |                                "editor" -> name. A tab named "3"
|     |     |                                is addressed via `--name 3`.
|     |     `-- close [<session>] <n|name>
|     +-- pane
|     |     +-- split <right|down> [--cmd "<...>"] [--cwd <path>]
|     |     `-- close
|     `-- layout
|           +-- ls
|           +-- show <name>
|           +-- save <name>                   snapshot active session -> KDL
|           +-- apply <session> <name>
|           `-- rm <name>
|
+-- sync                                      (current behavior preserved)
|     +-- start [<path>] [--folder]
|     +-- stop                                NEW -- clean daemon shutdown
|     +-- status | pause | resume
|     +-- ls [<remote>]                       NEW -- browse remote tree
|     `-- push|pull <local> <remote>          NEW -- one-shot transfer
|
+-- ssh [<handle>]                            (current; tmux attach kept for bastion)
+-- peers
+-- keys
|     +-- add <pubkey-path>
|     +-- ls                                  NEW
|     `-- rm <key-id>                         NEW
|
+-- instance                                  NEW -- your container ops
|     +-- info                                hits platform: GET  /api/instance
|     +-- restart                             hits platform: POST /api/instance/restart
|     `-- logs [--follow]                     hits platform: GET  /api/instance/logs (new)
|
`-- completion <bash|zsh|fish>                NEW
```

### Global flags

```
--profile <name>      Use a named profile (default: profiles.json:active)
--platform <url>      Override platform URL (also $MATRIXOS_PLATFORM_URL)
--gateway <url>       Override gateway URL (also $MATRIXOS_GATEWAY_URL)
--token <jwt>         Override auth (also $MATRIXOS_TOKEN; useful in CI)
--json                Machine-readable output (NDJSON for streams)
--no-color            Disable ANSI
-q | --quiet
-v | --verbose
--dev                 Sugar: implies `--profile local`
```

### Output contract (`--json`)

Documented in `docs/cli-json-schema.md` (new file in this spec). Versioned: every JSON object includes `"v": 1`.

- One-shot commands: single JSON object on stdout, non-zero exit on error. Errors emitted to stderr as `{ "v": 1, "error": { "code": "...", "message": "..." } }`.
- Streams (`shell attach --no-tty`, `sync events`, `shell log --follow`): NDJSON, one event per line. Each event includes `"v"`, `"type"`, and `"data"`.

### Detach UX

`matrix shell attach` and `matrix shell new <name>` enter raw mode and bridge to `/ws/terminal?session=<name>`. Detach combo is **`Ctrl-\ Ctrl-\`** (rare, won't conflict with zellij's own `Ctrl-q` quit or shell shortcuts). On detach, the CLI prints:

```
Detached. Reattach: matrix shell attach <name>
```

The session keeps running in the container.

## Daemon IPC contract

The existing daemon at `~/.matrixos/daemon.sock` is extended. Wire format remains line-delimited JSON. Every request and response carries `"v": 1`.

### Requests / responses

```jsonc
// request
{ "id": "<uuid>", "v": 1, "command": "<namespace>.<verb>", "args": { ... } }

// success response (one-shot)
{ "id": "<uuid>", "v": 1, "result": { ... } }

// error response
{ "id": "<uuid>", "v": 1, "error": { "code": "...", "message": "..." } }

// stream event (when client called a streaming verb)
{ "id": "<uuid>", "v": 1, "event": "<event-name>", "data": { ... } }

// stream end
{ "id": "<uuid>", "v": 1, "result": { "ok": true } }
```

### Verbs (additive over today's `status / pause / resume`)

```
auth.whoami
auth.refresh
shell.list                   -> { sessions: [...] }
shell.create                 args: { name, layout?, cwd? }
shell.attach (stream)        args: { name, fromSeq? }
                             events: "output" { bytes }, "exit" { code }
shell.input                  args: { id, bytes }     (id from a prior shell.attach)
shell.resize                 args: { id, cols, rows }
shell.detach                 args: { id }
shell.destroy                args: { name, force? }
tab.list                     args: { session }
tab.create                   args: { session, name?, layout?, cwd? }
tab.go                       args: { session, target } (number or name)
tab.close                    args: { session, target }
pane.split                   args: { session, direction, cmd?, cwd? }
pane.close                   args: { session }
layout.list
layout.show                  args: { name }
layout.save                  args: { session, name }
layout.apply                 args: { session, name }
layout.delete                args: { name }
sync.status
sync.pause | sync.resume
sync.events (stream)         events: "file-changed", "manifest-updated", "peer-status"
```

The CLI is implemented as a thin wrapper around these verbs. The VSCode extension speaks the same protocol directly.

### Daemon role split: control plane vs data plane

The daemon is the **control plane** contract. Terminal byte streams are **not** proxied through it.

- **Control plane (via daemon IPC):** all one-shot verbs -- `auth.*`, `shell.list/create/destroy`, `tab.*`, `pane.*`, `layout.*`, `sync.*`. Cheap, cached auth, no round-trip to disk for tokens. This is the stable contract VSCode and other extensions consume.
- **Data plane (direct WS to gateway):** `matrix shell attach` opens its own WS to `/ws/terminal?session=<name>` using the auth token (read from disk, or fetched once via `auth.token`). The VSCode extension does the same. This matches zellij's native multi-client model -- every attach is its own zellij client, no gateway-side multiplexing, no daemon-side fan-out.

Why this split:
1. WS multiplexing inside the daemon would require demuxing keystrokes back to the right client and reconciling per-client resize -- fighting zellij's own multi-client behavior.
2. Letting each consumer own its WS keeps the daemon stateless w.r.t. terminals -- failure modes stay simple (one bad client doesn't poison the others).
3. The `ws` library is small and already a sync-client dependency (`packages/sync-client/package.json:59`); reimplementing it in the extension is ~50 lines.

The daemon may expose `auth.token` as a convenience verb so consumers don't need to read `auth.json` themselves; the verb returns the active access token (refreshing if near expiry).

## Profiles

`~/.matrixos/profiles.json`:

```json
{
  "active": "cloud",
  "profiles": {
    "cloud": {
      "platformUrl": "https://app.matrix-os.com",
      "gatewayUrl":  "https://app.matrix-os.com"
    },
    "local": {
      "platformUrl": "http://localhost:9000",
      "gatewayUrl":  "http://localhost:4000"
    }
  }
}
```

`auth.json` becomes per-profile: `~/.matrixos/profiles/<name>/auth.json`. Same shape as today, just scoped.

`config.json` (sync) similarly scopes to a profile, but only sync-related fields. `peerId` stays per-machine, not per-profile.

`--dev` flag is a runtime alias -- does not mutate `profiles.json`. It implies `--profile local`.

### `matrix login` semantics per profile

`matrix login` writes auth into the **active profile** (or whichever was passed via `--profile`):

- `--profile cloud` (default): runs the OAuth device flow against `platformUrl` and writes a real access token. Same as today's `matrix login` against `app.matrix-os.com`.
- `--profile local` / `--dev`: skips the device flow and writes the dev stub (`accessToken: "dev-token"`, expires in 1y). The local gateway in dev mode (no `MATRIX_AUTH_TOKEN`) accepts any bearer. This replaces today's `matrix login --dev` flag with profile-driven behavior.

The success line always names the profile that was just written, e.g. `Logged in to local as @dev` -- eliminates the "which profile am I on" question.

### Migration of legacy `~/.matrixos/auth.json` and `config.json`

On every CLI invocation, before resolving config, the CLI checks:

1. If `~/.matrixos/profiles.json` does **not** exist, AND
2. `~/.matrixos/auth.json` (legacy) **does** exist:
   - Write `~/.matrixos/profiles.json` with `active: cloud` and the two predefined profiles.
   - Move `~/.matrixos/auth.json` -> `~/.matrixos/profiles/cloud/auth.json`.
   - Move `~/.matrixos/config.json` -> `~/.matrixos/profiles/cloud/config.json` if it exists.

The migration is idempotent and runs at most once. After migration, the legacy paths are gone.

## Migration: removing the dev CLI

1. Delete `bin/matrixos.{mjs,ts}` and `bin/cli.ts`.
2. Root `package.json`: remove the `bin` block (or repoint to `./packages/sync-client/bin/matrix.mjs` so `pnpm exec matrix` still resolves inside the repo).
3. Move `start` to `pnpm dev` (already exists) -- no replacement needed.
4. Delete `send`. If we want kernel-message debugging back, it returns later as `matrix message send` (lowercased noun namespace). Out of scope for v1.
5. `status` and `doctor` are reborn in the published CLI as cloud-aware, profile-aware versions.
6. Update `AGENTS.md`, `CLAUDE.md`, and any in-repo docs that reference `bin/matrixos.mjs`.

## Phased delivery

Each phase is a separate PR.

### Phase 1 -- server endpoints (2-3 days)

- Implement `/api/sessions` (list/create/delete) wrapping zellij in `packages/gateway/`.
- Implement `/api/sessions/:name/tabs` (list/create/delete).
- Implement `/api/sessions/:name/panes/split` and `.../panes/focused` DELETE.
- Implement `/api/sessions/:name/layout/dump` (wraps `zellij action dump-layout`).
- Implement `/api/layouts` CRUD.
- Update `/ws/terminal` to accept `?session=<name>` and spawn `zellij attach`.
- Shadow registry at `$MATRIX_HOME/system/sessions.json`.
- Implement per-user-scoped `/api/instance` and `/api/instance/restart` in `packages/platform/` (uses sync JWT, scopes to caller's container -- not the existing `/containers/:handle/*` routes which require `PLATFORM_SECRET`).
- Tests against a containerized zellij in CI; pin against `ZELLIJ_VERSION=0.44.1` matching the Dockerfile.
- Backwards compat: keep the old `/api/terminal/sessions` endpoints alive (deprecated) so the web shell does not break before phase 5.

### Phase 2 -- daemon IPC + CLI verbs (2-3 days)

- Extend daemon IPC handler with `shell.* / tab.* / pane.* / layout.*` verbs.
- Build CLI subcommands as thin daemon clients (citty).
- Raw-mode TTY bridge for `matrix shell attach`.
- Profiles + `--dev` sugar.
- Delete the dev CLI per the migration list.
- Update root `package.json`, `AGENTS.md`, `CLAUDE.md`, and in-repo READMEs.

### Phase 3 -- docs and JSON schema (parallel with Phase 2)

- Author `www/content/docs/guide/cli.mdx`.
- Author `docs/cli-json-schema.md`.
- Update `homebrew-tap/Formula/matrix.rb` test block if needed.
- Add `cli` to `www/content/docs/guide/meta.json` `pages`.

### Phase 4 -- VSCode extension contract (separate workstream)

- Stable daemon protocol doc -- already produced as part of phase 2, but tagged as a public contract here.
- Reference extension implementation (likely a separate repo). v1 architecture:
  - **Custom terminal profile** registered via `vscode.window.registerTerminalProfileProvider`. The profile spawns `matrix shell attach <name>` as a pseudoterminal -- VSCode handles the TTY, the CLI handles the WS bridge. No custom xterm renderer required.
  - **Sidebar tree view** (sessions / tabs / layouts) backed by daemon IPC: `shell.list`, `tab.list`, `layout.list`. Tree nodes have inline actions (new tab, attach, destroy) that call `tab.create`, send a `WorkspaceEdit` to spawn the terminal profile, or `shell.destroy`.
  - **Status bar item** showing active profile and sync status from `auth.whoami` and `sync.status`.
  - The extension consumes the daemon's `auth.token` verb for terminal profile auth, so the user's `~/.matrixos/profiles/...` is the single source of credentials.

### Phase 5 -- web shell rewrite (separate spec)

- Migrate browser tabs onto zellij sessions.
- Retire the deprecated `/api/terminal/sessions` endpoints kept alive in phase 1.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Zellij output parsing drifts between versions. | Pin zellij version in Dockerfile (already done). Add a CI smoke test that runs `zellij list-sessions` against the pinned binary and asserts on the format. |
| Shadow registry drifts from real zellij state. | Reconcile on every list call. Treat zellij-side state as authoritative for "does this session exist"; treat the registry as authoritative for tab/pane indices. |
| The detach combo `Ctrl-\ Ctrl-\` collides with a user's terminal binding. | Make it configurable via `~/.matrixos/profiles/<name>/cli.json`. Ship `Ctrl-\ Ctrl-\` as the default. |
| Daemon protocol versioning becomes a liability once VSCode ships. | `"v": 1` on every message from day one. Bumps are additive; legacy verbs stay supported for two minor versions. |
| `matrix login` on a fresh machine creates a `cloud` profile but the user expected `local` (during dev). | `matrix login --dev` and `matrix login --profile local` both work; `matrix login` without args writes to whichever profile is `active`. Show the profile in the success line. |
| Removing the dev CLI breaks an existing `pnpm matrix` script someone has in muscle memory. | Document the change in the release notes and keep `pnpm dev` (already exists) as the boot path. |

## Resolved design calls

1. **Inline command on session create.** `POST /api/sessions` and `matrix shell new` accept an optional `cmd?: string`. Implementation: pass through to `zellij --session <name> options ... -- <cmd>`. Used by the upcoming "spawn an agent in a session" flow (e.g. `matrix shell new agent --cmd "claude"`).
2. **Session rename.** Deferred. Zellij has no native rename; a destroy+recreate-with-state-preserved would be misleading. Revisit in v1.1 if a concrete need surfaces.
3. **Layout publishing to a marketplace.** Out of scope for this spec.
4. **Resize handling on `matrix shell attach`.** Use `process.stdout.on('resize', cb)` -- Node's portable wrapper around SIGWINCH on POSIX and the equivalent Windows mechanism. No polling, no platform branch.

## Open questions for review

1. **`matrix shell attach <name>` against a non-existent session.** Two choices: (a) error with `session "foo" not found, create with: matrix shell new foo`, or (b) auto-create + attach. **Recommendation: (a) -- explicit.** The `new` verb already creates-and-attaches, so auto-create on `attach` would just be a confusing duplicate.
2. **Detach combo `Ctrl-\ Ctrl-\`.** Defaulting to this. Zellij uses `Ctrl-q` for quit and `Ctrl-o d` for native detach; the CLI's wrapper-detach intercepts before forwarding bytes to zellij, so they don't conflict. Make configurable via `~/.matrixos/profiles/<name>/cli.json`. OK to ship?
3. **Phase 1 backwards-compat surface.** Keeping `/api/terminal/sessions` alive for the web shell is straightforward, but we should decide whether the *existing* sessions migrate (each becomes a zellij session) or stay as raw PTYs until phase 5. **Recommendation: stay as raw PTYs;** they're ephemeral and migration risk isn't worth it.

## Out-of-band changes touched by this spec

- `Dockerfile` -- no change required for v1 (zellij already in the image).
- `Dockerfile.dev` -- same.
- `homebrew-tap/Formula/matrix.rb` -- no functional change; CI release workflow continues to bump url/sha.
- `AGENTS.md`, `CLAUDE.md` -- remove references to `bin/matrixos.mjs` and the dev `start / send / status / doctor` commands.
