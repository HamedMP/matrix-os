# Quickstart: Operator (Electron desktop app)

## Prerequisites

- Repo bootstrapped (`flox activate` or Node 24+ / pnpm 10 / bun manually), `pnpm install` run
  at the root after the `desktop/` workspace member exists.
- A Matrix OS account for live testing (device-auth flow) — or run against the stub gateway
  fixture for offline development.

## Develop

```bash
bun run dev:desktop          # electron-vite dev: main+preload watch, renderer HMR
```

The app boots to sign-in. With `OPERATOR_GATEWAY_URL` set (e.g. a local gateway or the stub
fixture below) the device flow targets that host instead of `https://app.matrix-os.com`.

```bash
OPERATOR_GATEWAY_URL=http://localhost:18789 bun run dev:desktop
```

## Test

```bash
bun run test                 # root vitest includes tests/desktop/**
npx vitest run tests/desktop # desktop suites only
bun run test:e2e:desktop     # Playwright _electron against the stub gateway (builds first)
npx react-doctor@latest desktop   # mandatory before committing renderer changes
bun run typecheck            # all packages incl. desktop
```

The stub gateway (`tests/e2e/desktop/fixtures/stub-gateway.ts`) is a small Hono server
implementing the contract subset in `contracts/gateway-contract.md` (device auth approves
instantly, one project, fake zellij echo session, scripted kernel stream) so e2e runs need no
VPS and no credentials.

## Build / package

```bash
bun run build:desktop        # electron-vite build (main/preload/renderer bundles)
cd desktop && npx electron-builder --mac --publish never   # local .app/.dmg (unsigned in dev)
```

Signing/notarization and the auto-update feed activate only when release credentials and the
desktop release-feed delta exist (see plan Phase D); local builds skip both gracefully.

## Manual smoke (mirrors US1 acceptance)

1. Launch → sign in (browser opens, approve) → board renders.
2. Click a task with a linked session → terminal attaches, run `ls`.
3. Toggle Wi-Fi off/on → terminal reconnects, no duplicate lines.
4. Open a second task → switch back → first terminal buffer intact, switch feels instant.
5. ⌘K → "New task" → create + open → composer ⌘⏎ → agent thread streams.
