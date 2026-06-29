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

The generated env should include allocated shell/gateway ports, per-instance database names, per-instance object-storage bucket names, and display metadata. Compose project names isolate Docker networks and volumes; env values isolate logical runtime state.

## Local Access Model

The default access model should use Matrix CLI as the transport/forwarding layer, not raw SSH instructions.

`mos dev up` should establish or reuse local forwards:

```text
localhost:<shellPort>   -> VPS/dev instance shell
localhost:<gatewayPort> -> VPS/dev instance gateway
```

This avoids public exposure, avoids Cloudflare credentials, and gives contributors a fast local loop.

## Public Preview Model

Public preview should be opt-in through `mos dev expose <name>`.

Recommended public URL shape:

```text
https://<instance>.<machine-id>.dev.matrix-os.com
```

The parent Matrix app should remain the launcher/control plane at `https://app.matrix-os.com/dev`. Routes are good for launch/control. Subdomains are better for full shell previews because they give clean browser origin isolation for cookies, localStorage, service workers, CSP, OAuth redirects, assets, and WebSockets.

Contributors should not manually copy `.cloudflared/*.json` files. The platform should own tunnel provisioning and route cleanup.

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

### Phase 3: Public Preview

- Platform-owned tunnel provisioning.
- Per-instance hostname lifecycle.
- `mos dev expose/unexpose`.
- Authz for expose and access.
- Cleanup of stale tunnel routes.

### Phase 4: Agent and Terminal Integration

- Update `matrix-dev-vps` skill.
- Add agent docs and examples.
- Add terminal launcher/attach affordances.
- Evaluate TermX vs WASM Ghostty vs native shell terminal surfaces.

## Design Questions

- Should local forwarded ports be bound only on `127.0.0.1`? Proposed answer: yes.
- Should public preview default to opaque instance IDs or human-readable slugs? Proposed answer: human-readable locally, opaque or owner-scoped publicly.
- Should instance metadata live on the local machine, the VPS, or both? Proposed answer: VPS is source of truth; local CLI caches active forwards.
- Should `mos dev up` create containers directly or ask the gateway/sync-agent to do it? Proposed answer: CLI can drive the first version; gateway-managed orchestration is better long term for app UI control.
- Should the dev instance reuse user-level Clerk auth or have an insecure local-only bypass? Proposed answer: local-only bypass can exist for development; public preview must use real auth.
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
