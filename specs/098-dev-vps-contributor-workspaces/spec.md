# Dev VPS Contributor Workspaces

Status: design proposal
Review: @HamedMP

## Summary

Matrix OS should make it easy to clone the Matrix OS repo onto a user VPS, boot one or more isolated development instances, and access each instance from the contributor local machine through the Matrix CLI. Matrix-in-Matrix is the first validation target, but the same machinery should become the preferred development path for Matrix OS generally.

The default path should not require Cloudflare credentials, public DNS, or manual SSH port forwarding. Public preview URLs should be opt-in for OAuth callback testing, webhook testing, mobile testing, and teammate review.

## Problem

- Repo dev defaults can collide with the installed Matrix OS on a user VPS.
- The current dev-VPS compose path assumes a Cloudflare tunnel credential file at `.cloudflared/matrix-os-dev.json`.
- Missing tunnel credentials mean `dev.matrix-os.com` cannot route even if the dev container is healthy.
- Running multiple branches or checkouts concurrently is not modeled.
- Agents do not yet have a crisp preferred workflow for Matrix OS development on a VPS.
- Contributors may not have a polished terminal setup, even when Matrix CLI can attach to remote shells.

## Goals

- One command starts a Matrix OS dev instance from a repo path.
- Default access works from the local terminal via Matrix CLI forwarding.
- Multiple named dev instances can run concurrently without port, database, object storage, or home-directory collisions.
- The CLI can infer a Matrix OS repo from a path or current working directory.
- Public HTTPS preview is available but optional.
- The workflow improves Matrix OS development generally, not only Matrix-in-Matrix.
- Agents know and prefer this workflow when contributing to Matrix OS.
- The design leaves room for a first-class terminal surface so users do not need to install and configure a separate terminal.

## Non-Goals

- Replacing production/customer VPS ports (`3000` shell, `4000` gateway).
- Making every dev instance public by default.
- Requiring contributors to handle raw Cloudflare tunnel credentials.
- Solving full OAuth/webhook/mobile preview in the first local-only milestone.
- Shipping implementation in this design PR.

## Proposed UX

From the local machine:

```bash
mos dev up --path ~/projects/matrix-os-src
```

From inside a Matrix OS repo:

```bash
mos dev up
```

Multiple versions:

```bash
mos dev up --name main --path ~/projects/matrix-os-src
mos dev up --name symphony-test --path ~/projects/matrix-os-symphony
mos dev up --name auth-rework --path ~/projects/matrix-os-auth
```

Discovery and access:

```bash
mos dev list
mos dev open symphony-test
mos dev logs symphony-test
mos dev stop symphony-test
mos dev rm symphony-test
```

Optional public exposure:

```bash
mos dev expose symphony-test
```

Expected `mos dev list` shape:

```text
NAME            PATH                         BRANCH        SHELL                  GATEWAY                 STATUS
main            ~/projects/matrix-os-src     main          http://localhost:3100  http://localhost:4100   healthy
symphony-test   ~/projects/matrix-os-src     symphony-v2   http://localhost:3101  http://localhost:4101   healthy
auth-rework     ~/projects/matrix-os-auth    auth-rework   http://localhost:3102  http://localhost:4102   starting
```

## Repo Detection

`mos dev up --path <path>` should verify the target is a Matrix OS checkout by checking for:

- `pnpm-workspace.yaml`
- `package.json` with Matrix OS workspace identity
- `docker-compose.dev-vps.yml`
- `packages/gateway/package.json`
- `shell/package.json`

If no path is provided, the CLI should walk upward from the current directory until it finds those markers.

## Instance Identity

Each dev instance should have a stable name. If omitted, derive one from repo basename and branch, for example `matrix-os-src-main` or `matrix-os-src-symphony-v2`.

Names must be normalized to a safe slug like `[a-z0-9][a-z0-9-]{0,62}`. The slug becomes the key for ports, compose project name, data volumes, logs, and optional public hostname.

## Local Port Allocation

Default base ranges:

```text
shell:   3100+
gateway: 4100+
editor:  8787+ or disabled by default per instance
```

The CLI should allocate the first free shell/gateway pair and persist it in instance metadata. It should never silently steal a port from another instance.

Suggested metadata location:

```text
~/.matrix/dev/instances/<name>.json
```

## Compose Isolation

Each instance should run under a distinct compose project name:

```bash
docker compose -p matrix-dev-<name> --env-file ~/.matrix/dev/instances/<name>.env -f docker-compose.dev-vps.yml up -d
```

The per-instance env file should be generated outside the repo by default to avoid mutating checkout state:

```text
~/.matrix/dev/instances/<name>.env
```

The generated env should include allocated shell/gateway ports, per-instance database names, per-instance object-storage bucket names, display metadata, exposure mode, and the local bypass validation secret when local bypass is enabled. Compose project names isolate Docker networks and volumes; env values isolate logical runtime state.

Local-mode env must include a server-side validation value such as:

```text
MATRIX_DEV_EXPOSURE=local
MATRIX_DEV_LOCAL_BYPASS_TOKEN=<random per-instance secret>
```

The CLI forwarder may inject the same value into local requests, but shell/gateway must validate it against the env-provided value at startup. If `MATRIX_DEV_EXPOSURE=public`, shell/gateway must ignore local bypass headers/cookies entirely and require platform auth.

## Local Access Model

The default access model should use Matrix CLI as the transport/forwarding layer, not raw SSH instructions.

`mos dev up` should establish or reuse local forwards:

```text
localhost:<shellPort>   -> VPS/dev instance shell
localhost:<gatewayPort> -> VPS/dev instance gateway
```

Forwarders must bind only to `127.0.0.1` on the local machine unless the user explicitly asks for a public preview. The VPS-side dev shell and gateway should remain reachable only from the Matrix CLI transport, the Docker network, or loopback-bound host mappings selected by the implementation. No local-mode command should bind `0.0.0.0` or create an unauthenticated public listener.

This avoids public exposure, avoids Cloudflare credentials, and gives contributors a fast local loop.

## Public Preview Model

Public preview should be opt-in through `mos dev expose <name>`.

Preferred public URL shape, subject to platform routing confirmation:

```text
https://<opaque-instance-id>.dev.matrix-os.com
```

`<opaque-instance-id>` should be a single DNS label generated by the platform from non-secret routing state, such as a stable Matrix VPS machine identifier plus the dev instance slug. It must not expose the user's handle, email, raw public IP, branch name, local path, or an unvalidated hostname. Keeping the preview identifier to one label under `dev.matrix-os.com` lets a normal `*.dev.matrix-os.com` wildcard certificate cover it; nested names such as `<instance>.<machine-id>.dev.matrix-os.com` require deeper wildcard/TLS support and should not be the default.

This is intentionally scoped under `.dev.matrix-os.com`, not `<handle>.matrix-os.com`. Matrix OS currently does not support per-handle root-domain subdomains, and this design must not generate or assume them. Before implementation, platform owners must confirm that wildcard DNS/TLS and Cloudflare routing for single-label `*.dev.matrix-os.com` preview hosts can coexist with existing Workers, preview environments, and app routing. If that is not true, public previews should fall back to a platform-owned path route such as:

```text
https://dev.matrix-os.com/i/<opaque-instance-id>
```

The path-route fallback is acceptable for public preview launch, but implementers should treat it as less ideal for full shell hosting because it weakens browser-origin isolation and makes assets, redirects, service workers, OAuth callbacks, and WebSockets more fragile.

The parent Matrix app should remain the launcher/control plane at `https://app.matrix-os.com/dev`. Routes are good for launch/control. Subdomains are better for full shell previews when the platform can support them safely.

Contributors should not manually copy `.cloudflared/*.json` files. The platform should own tunnel provisioning and route cleanup.

## Security Architecture

### Auth Matrix

| Surface | Caller | Authn | Authz | Exposure | Notes |
| --- | --- | --- | --- | --- | --- |
| `mos dev up` | Local Matrix CLI user | Existing Matrix CLI profile/session | User must own or have write access to the target VPS/session | Local command | Starts or reconciles a named dev instance. |
| VPS instance metadata files | Matrix CLI over VPS session | Existing Matrix CLI transport | Same user/session that owns the VPS dev workspace | VPS filesystem | Stored under `~/.matrix/dev/instances/`; never served directly. |
| Docker compose control | Matrix CLI command executor on VPS | Existing VPS shell/session principal | Same user/session; future gateway-managed path requires owner/admin principal | VPS-local IPC | Must not be exposed over HTTP. |
| Local shell forward | Local browser on contributor machine | Loopback-only local access plus Matrix CLI transport | Local OS user with access to the forwarded port | `127.0.0.1` only | No public bind in local mode. |
| Local gateway forward | Local browser/tools on contributor machine | Loopback-only local access plus Matrix CLI transport | Local OS user with access to the forwarded port | `127.0.0.1` only | No public bind in local mode. |
| `mos dev expose` | Local Matrix CLI user | Existing Matrix CLI profile/session plus platform auth | VPS owner or authorized team member | Public HTTPS | Must provision platform-owned authz before route activation. |
| Public preview URL | Browser user | Platform preview auth, not local bypass | Owner/team/share policy | Public HTTPS | Must reject if instance is in local-auth-bypass mode without a public auth wrapper. |

### Local Auth Bypass Gate

A development auth bypass may exist only for local mode, and only when all of these conditions are true:

1. The dev instance is marked `exposure=local` in instance metadata.
2. The shell/gateway are reachable through Matrix CLI forwarding or loopback-only host mappings.
3. The local forward binds `127.0.0.1`, not `0.0.0.0`.
4. The bypass token is generated per instance, stored in the instance metadata with owner-only file permissions, written into the per-instance env as `MATRIX_DEV_LOCAL_BYPASS_TOKEN`, read by shell/gateway at startup, and injected as an HTTP-only local session or request header by the CLI forwarder.
5. `mos dev expose` refuses to expose an instance while local bypass is enabled unless it first switches the instance to public auth mode, removes `MATRIX_DEV_LOCAL_BYPASS_TOKEN` from the generated env, restarts the shell/gateway, and verifies the bypass is no longer accepted.

Public preview mode must never rely on the local bypass. It must use platform-owned authz, or the command must fail closed. The implementation must include an integration test proving a local bypass token that works in local mode is rejected after switching the same instance to public mode.

### Input Validation Plan

- Repo paths must resolve to an absolute path under the user allowed workspace roots on the VPS.
- Repo detection must validate required Matrix OS markers before running compose.
- Instance names must be normalized to `[a-z0-9][a-z0-9-]{0,62}` and rejected if normalization changes semantics ambiguously.
- Port values must be integers within configured dev ranges and must not collide with known production/customer ports.
- Compose project names, DB names, and bucket names must be derived from the validated slug only.
- Public preview hostnames must use either a platform-confirmed `*.dev.matrix-os.com` wildcard with a DNS-safe machine routing slug or opaque IDs generated by the platform.

### Error Policy

- CLI errors should be actionable but must not print secrets, tunnel credentials, auth tokens, or full env files.
- Public preview errors should be generic to browsers and detailed only in owner-visible logs.
- Docker/compose failures should preserve command exit status and include bounded log excerpts.
- Missing credentials should be reported as missing capability, not by printing expected secret contents.

### Credential Handling

- Cloudflare or platform tunnel credentials are platform-owned and must not be checked into repos or copied manually by contributors.
- Per-instance bypass tokens must be generated locally, stored with owner-only permissions, and rotated on `mos dev rm`, `mos dev expose`, and explicit `mos dev doctor --rotate-token`.
- Env files must be generated outside the repo by default and redacted in logs.

## Integration Wiring

### Startup Sequence

`mos dev up --path <repo> --name <name>` should execute this sequence:

1. Resolve the target repo path on the VPS.
2. Validate Matrix OS repo markers.
3. Normalize or derive the instance name.
4. Acquire the global dev-instance allocation lock.
5. Load existing instance metadata, if any.
6. Allocate or reuse a shell/gateway port pair.
7. Write instance metadata and env files atomically, including `MATRIX_DEV_EXPOSURE` and any local-mode bypass validation secret.
8. Release the allocation lock.
9. Start Docker compose with `-p matrix-dev-<name>` and the generated env file.
10. Poll gateway health with a bounded timeout.
11. Start or refresh local Matrix CLI forwards for shell and gateway.
12. Print the local URLs and health state.

`mos dev expose <name>` should execute this sequence:

1. Load instance metadata.
2. Verify the caller owns or can administer the instance.
3. Verify the instance is healthy locally or start it.
4. Refuse exposure if local auth bypass is enabled and public auth cannot be configured; otherwise rewrite env to public mode and remove the local bypass validation secret.
5. Restart shell/gateway so any in-process local bypass validation secret is evicted before public routing begins.
6. Verify the old local bypass token is rejected after restart.
7. Ask the platform to provision a tunnel/route.
8. Persist public exposure metadata only after platform route creation succeeds.
9. Verify the public URL returns an authenticated shell response and still rejects the old local bypass token.

### Cross-Package Communication

The first implementation can drive Docker directly from the CLI over the existing Matrix shell/session transport. A future app-driven implementation should call a gateway or sync-agent capability with explicit dependencies; it must not use `globalThis` or hidden process state. Platform-owned tunnel provisioning should be exposed through a typed platform API rather than direct Cloudflare CLI calls from customer code.

### Config Injection

Runtime config flows from generated per-instance env files into compose and then into shell/gateway processes. Production/customer systemd units remain the source of truth for installed Matrix OS and keep `3000/4000` unless explicitly changed by deployment code.

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| Two `mos dev up` commands race | Allocation lock serializes metadata/port selection; losing command reloads metadata and retries. |
| Metadata write fails midway | Write to temp file then rename; never leave partially-written JSON as canonical state. |
| Env write fails midway | Write to temp file then rename; compose is not started until env and metadata are durable. |
| Compose start fails | Keep metadata with `status=failed`; surface bounded logs; `mos dev rm` can clean up. |
| Gateway health times out | Mark instance degraded; keep logs available; do not start public exposure. |
| Local forward fails | Instance may remain healthy; CLI reports forwarding failure and suggests a new port or cleanup. |
| Public route provisioning fails | Local mode remains usable; no public metadata is committed unless route verification succeeds. |
| CLI crashes after metadata write but before compose | Next `mos dev up` reconciles metadata with actual Docker state. |
| VPS reboots | `mos dev list` reconciles metadata, Docker state, and forwarded sessions; stale forwards are dropped. |

Default timeouts:

- Docker compose start: 120 seconds before degraded status.
- Gateway health polling: 60 seconds, 2 second interval.
- Local forward establishment: 10 seconds.
- Public route verification: 30 seconds.

Errors must propagate to the CLI caller. Implementation must not swallow compose, filesystem, or platform-route errors silently.

## Atomic Port Allocation

Port allocation must be protected by an exclusive lock file under the instance metadata directory, for example:

```text
~/.matrix/dev/instances/.allocation.lock
```

The implementation should acquire the lock using exclusive file creation (`open` with `flag: 'wx'`) and write lock owner metadata including PID, hostname, command, and timestamp. If the lock exists, the CLI waits with a bounded timeout and treats stale locks as recoverable only after verifying the owning process is gone or the timestamp exceeds the stale-lock threshold.

After acquiring the lock, the CLI must:

1. Reload all instance metadata.
2. Probe candidate ports.
3. Reserve the selected pair in metadata.
4. Write metadata atomically via temp file + rename.
5. Release the lock.

This avoids the check-then-write race where two concurrent commands pick the same first free port.

## Resource Management

- `mos dev stop <name>` stops containers and forwards but preserves metadata, volumes, and generated env.
- `mos dev rm <name>` removes local forwards, compose containers, compose network, generated env, metadata, and public exposure metadata after confirmation.
- Volume deletion should require either `--volumes` or an interactive confirmation because it can delete workspace state.
- `mos dev prune` can remove stopped instances older than a TTL, but must default to dry-run.
- Metadata files should be small JSON documents; log commands should stream bounded tails by default.
- Public preview routes should have owner, instance, created-at, last-used-at, and TTL metadata for cleanup.
- VPS deprovisioning must revoke public routes and remove platform-owned tunnel credentials.
- Local forwards should be closed on CLI exit and reconciled by `mos dev list` if the CLI crashes.

## CLI Surface

Initial commands:

```bash
mos dev up [--path <path>] [--name <name>] [--branch <branch>] [--no-open]
mos dev list
mos dev open <name>
mos dev logs <name> [--service shell|gateway|all]
mos dev stop <name>
mos dev rm <name>
mos dev expose <name>
mos dev unexpose <name>
```

Future commands:

```bash
mos dev doctor <name>
mos dev ports <name>
mos dev exec <name> -- <command>
mos dev attach <name>
```

## Agent Guidance

Agents should prefer this workflow when asked to develop Matrix OS on a VPS:

1. Detect Matrix OS repo path.
2. Use `mos dev up --path <repo> --name <task-or-branch>`.
3. Use `mos dev logs` and `mos dev doctor` for diagnosis.
4. Avoid manually exposing raw dev servers publicly.
5. Avoid mutating production `app.matrix-os.com` nginx or customer VPS service ports for dev work.
6. Use public `mos dev expose` only when HTTPS/webhook/OAuth/mobile/team review is required.

The `matrix-dev-vps` skill and repo docs should be updated once the design is accepted.

## Terminal Experience

Matrix CLI attach is powerful, but contributors should not need to install and tune a separate terminal to get a good experience.

We should evaluate exposing a high-quality terminal surface backed by the same Matrix CLI/session transport:

- TermX-style terminal surface.
- WASM Ghostty wrapper if practical.
- Native desktop terminal integration for the macOS shell path.
- Browser terminal inside Matrix OS for quick access.

The terminal should support named session attach, dev logs/shells, `mos dev up`, forwarded URL display, scrollback, copy/paste, and secret-safe transcript handling.

## Implementation Plan

### Phase 0: Design PR

- Agree on local-first vs public-first model.
- Agree on CLI command shape.
- Agree on instance metadata location.
- Agree on subdomain strategy for public preview.
- Agree on agent guidance and terminal direction.

### Phase 1: Dev Port and Compose Hygiene

- Make dev defaults avoid production VPS ports.
- Keep production/customer systemd ports pinned to `3000/4000`.
- Make `docker-compose.dev-vps.yml` consume shell/gateway port env vars.
- Ensure health checks follow the configured gateway port.

### Phase 2: `mos dev up` Local Mode

- Repo detection.
- Instance naming.
- Port allocation.
- Per-instance env generation.
- Compose project isolation.
- Health checks.
- Local forwarding through Matrix CLI transport.
- `mos dev list/open/logs/stop/rm`.

### Stretch Goal: Public Preview

- Platform-owned tunnel provisioning.
- Per-instance hostname lifecycle.
- `mos dev expose/unexpose`.
- Authz for expose and access.
- Cleanup of stale tunnel routes.

### Phase 3: Agent and Terminal Integration

- Update `matrix-dev-vps` skill.
- Add agent docs and examples.
- Add terminal launcher/attach affordances.
- Evaluate TermX vs WASM Ghostty vs native shell terminal surfaces.

## Design Questions

- Should local forwarded ports be bound only on `127.0.0.1`? Proposed answer: yes.
- Should public preview default to opaque instance IDs or human-readable slugs? Proposed answer: human-readable locally, opaque or owner-scoped publicly.
- Should instance metadata live on the local machine, the VPS, or both? Proposed answer: VPS is source of truth; local CLI caches active forwards.
- Should `mos dev up` create containers directly or ask the gateway/sync-agent to do it? Proposed answer: CLI can drive the first version; gateway-managed orchestration is better long term for app UI control.
- Should the dev instance reuse user-level Clerk auth or have an insecure local-only bypass? Proposed answer: local-only bypass may exist only under the explicit gate in Security Architecture; public preview must use platform auth and must fail closed if that gate cannot be disabled.
- How should multiple repo checkouts share or isolate package cache and Docker build cache? Proposed answer: share caches, isolate runtime state.
- What terminal surface should become the default for contributors who do not have a polished terminal installed?

## Risks

- Public tunnel provisioning can accidentally expose unauthenticated dev surfaces.
- Path-proxying a full shell through `app.matrix-os.com/dev/<name>` may cause subtle browser-origin bugs.
- Multi-instance Docker volume cleanup must avoid deleting user data accidentally.
- Local forwarding must avoid binding public interfaces.
- Agent automation could mutate production services unless guidance is explicit.

## Success Criteria

- A new contributor can clone Matrix OS onto their VPS and run one command from their local terminal to open a dev Matrix OS shell.
- A contributor can run at least two Matrix OS branches concurrently and switch between them locally.
- The workflow does not require Cloudflare credential files for local development.
- Public preview is available for cases that need real HTTPS.
- Agents consistently use the documented `mos dev` workflow.
