---
name: launch-app
description: Launch Matrix OS runtime surfaces for validation. Use when Symphony agents need runtime checks for shell, gateway, platform, or bundled app changes in this repo.
---

# Launch App

## Local Runtime

Matrix OS uses `bun` for scripts and `pnpm` for installs.

```bash
pnpm install --frozen-lockfile
bun run dev
```

This starts gateway, proxy, and shell together. For narrower checks:

```bash
bun run dev:gateway
bun run dev:shell
bun run dev:platform
```

For automated or agent-driven Electron checks that exercise the stub device
authorization flow, disable system-browser side effects explicitly:

```bash
OPERATOR_DISABLE_EXTERNAL_BROWSER=1 bun run dev:desktop
```

Keep this variable unset for manual authentication checks. Desktop E2E tests
set it centrally through `vitest.e2e.config.ts` so clicking **Continue in
browser** can complete stub authorization without stealing foreground focus.

## Bundled Default Apps

First-party apps live under `home/apps/**` and build to `dist/`.

```bash
node scripts/build-default-apps.mjs home/apps
```

For one app, run its own build from the app directory:

```bash
pnpm --dir home/apps/symphony install
pnpm --dir home/apps/symphony build
```

## Validation

- Canvas is the primary shell surface; verify user-visible shell changes there first.
- Built-in app paths must work in Canvas and Desktop.
- For bundled apps, verify `dist/index.html` exists before handoff.
- Public website changes are validated in the private `FinnaAI/matrix-os-site` repository.
- Run the relevant targeted tests, then the repo gates when scope warrants:
  ```bash
  bun run typecheck
  bun run check:patterns
  bun run test
  ```
