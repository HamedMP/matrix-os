---
name: matrix-dev-vps
description: Work on Matrix OS from inside a Matrix user VPS with near-realtime development, hot reload, previews, and safe separation between customer code and platform secrets.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Matrix OS, VPS, development, HMR, devops]
    related_skills: [matrix-app-builder, matrix-debug-app, matrix-integrations]
---

# Matrix Dev VPS

## When to Use

Use this when developing Matrix itself, Matrix apps, or Matrix-adjacent projects from inside a Matrix user VPS.

## Mental Model

- Production user VPSes run the built Matrix image.
- A dev VPS can run most services in containers while shell and backend run natively with hot reload.
- Platform owns shared sensitive integration credentials.
- User/project work happens in the user's home and project directories.
- The dev loop should feel like a normal user coding inside Matrix, with preview URLs routed back into Matrix.

## Expected Dev Shape

```text
Matrix platform
  owns Clerk, Pipedream, provisioning, shared secrets

User/dev VPS
  runs gateway, shell, proxy, Postgres, app builds
  contains user projects
  uses cloudflared or tunnel routing for dev.matrix-os.com
```

## Common Commands

From the Matrix repo:

```bash
pnpm install
pnpm --filter './packages/gateway' dev
pnpm --filter './shell' dev
```

For Docker-backed services, prefer the repo's documented compose file and env file:

```bash
docker compose --env-file .env -f docker-compose.dev-vps.yml up -d
```

For apps:

```bash
cd ~/apps/<slug>
pnpm install
pnpm build
```

## Preview Rules

- Prefer Matrix app windows for user-facing preview.
- For raw dev servers, use SSH forwarding or the configured tunnel.
- Do not expose unauthenticated dev servers publicly.
- `dev.matrix-os.com` should require auth.

## Codex, Claude, and Hermes on VPS

- Use `pnpm`, not `npm`, for project dependencies.
- Global agent CLIs must be writable by the `matrix` user if self-update is expected.
- If a global npm install fails with `EACCES`, fix ownership of the runtime node global prefix rather than running day-to-day development as root.

## What Users Can Do

- Build apps in `~/apps`.
- Work on coding projects in `~/projects`.
- Use Matrix integrations through platform-owned routes.
- Preview apps in Matrix.
- Run agent-assisted development tasks.

## What Users Should Not Do

- Store platform Pipedream, Clerk, or provider secrets on a customer VPS.
- Modify production platform state directly from a dev VPS.
- Use Docker volume reset commands unless explicitly resetting state.
- Build Matrix features that only work outside Canvas mode.

## Verification

- Shell loads with auth.
- Gateway `/health` is healthy.
- App previews work from Matrix windows.
- Hot reload works for shell and gateway in dev mode.
- Integration routes proxy to platform instead of requiring customer VPS secrets.
