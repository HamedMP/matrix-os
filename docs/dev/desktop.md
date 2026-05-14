# Matrix Desktop

Matrix Desktop is the native workbench wrapper for the Matrix shell. It loads a
local, VPS, or hosted Matrix instance and keeps coding-agent execution in the
Matrix cloud runtime. The desktop app must not start Claude, Codex, OpenCode,
Pi, or other coding-agent binaries on the user machine.

## Local Setup

From the repository root:

```bash
pnpm install
bun run dev
bun run dev:desktop
```

`bun run dev` starts the gateway, proxy, and shell. `bun run dev:desktop` starts
the Electron wrapper from `apps/desktop`.

The desktop app reads Matrix connection defaults from `apps/desktop/src/main`
configuration and opens the shell URL. In development, the runtime policy
endpoint advertises:

- shell URL
- gateway URL
- build/version
- cloud-only agent execution
- desktop-safe navigation capabilities

## Runtime Policy

Desktop runtime policy lives in `packages/gateway/src/desktop/`. The shell
calls `GET /api/desktop/runtime` and treats the gateway as the source of truth
for supported desktop capabilities.

Cloud-only behavior is enforced in two places:

- the Electron bridge exposes no local agent start API
- gateway workspace/session routes reject local agent execution requests

If a user needs to attach to work, they observe or take over a cloud session
through Matrix workspace APIs. Local terminal handoff remains a shell/session
affordance, not a desktop-side agent runner.

## Workbench Surfaces

The desktop workbench reuses Matrix shell surfaces:

- Canvas/Desktop shell and app launcher
- Workspace app for projects, tickets, worktrees, sessions, previews, events,
  workflow setup, and shared board members
- Symphony app for ticket assignment and run control
- Settings Desktop section for connection, cloud policy, update, and Slay
  migration guidance
- built-in apps with desktop-aware launch affordances

Keep new desktop-facing UI Canvas/Desktop compatible. Built-in paths such as
`__workspace__`, `__terminal__`, and `__chat__` must not fall through to generic
app file routing.

## Security Requirements

Every desktop-facing route needs request-principal authorization, route-boundary
validation, generic client errors, and body limits for mutations.

Preview/browser URLs are server-side trust boundaries. User-controlled URLs must
be parsed, DNS/SSRF checked, use timeouts, and reject unsafe redirects before
fetching.

Desktop-visible errors must go through allowlisted/capped helpers before they
are shown in the shell. Do not expose provider names, raw database messages,
filesystem paths, credentials, or cloud runner secrets.

## Focused Validation

```bash
pnpm test \
  tests/desktop/runtime-policy.test.ts \
  tests/desktop/navigation-policy.test.ts \
  tests/desktop/app-launch.test.ts \
  tests/desktop/window-state.test.ts \
  tests/shell/desktop-app-launcher.test.tsx \
  tests/shell/workspace-cloud-runtime.test.tsx \
  tests/gateway/workspace-cloud-only.test.ts \
  tests/gateway/project-previews.test.ts

bun run typecheck
bun run check:patterns:diff
```

Use `docs/dev/desktop-release.md` for packaging and release validation.
