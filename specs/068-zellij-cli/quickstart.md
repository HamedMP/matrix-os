# Quickstart: Zellij-Native Shell and Unified CLI

This quickstart defines the expected verification flow after implementation.

## Prerequisites

- Node.js 24+
- pnpm 10+
- bun
- Docker dev environment with zellij installed in the user container
- A local Matrix OS stack or a valid cloud profile

## Setup

```bash
pnpm install
bun run dev
```

For local profile testing:

```bash
matrix profile use local
matrix login --dev
matrix whoami
```

## Gateway Session Flow

Create and list a session:

```bash
matrix shell new main
matrix shell ls --json
```

Expected:

- `main` appears once.
- JSON output includes `"v": 1`.
- Detaching leaves the session running.

Reconnect:

```bash
matrix shell attach main
```

Expected:

- The existing session is reused.
- Recent output is replayed within the configured replay window.

Missing session:

```bash
matrix shell attach does-not-exist
```

Expected:

- Non-zero exit.
- Generic error with a stable code.
- Human output suggests `matrix shell new does-not-exist`.

## Layout Flow

```bash
matrix shell layout save dev
matrix shell layout ls
matrix shell layout show --name dev --json
matrix shell new workspace --layout dev
```

Expected:

- Layout content validates before save.
- Invalid layout content is rejected without overwriting the previous file.

## Profile Migration Flow

Start with legacy files:

```text
~/.matrixos/auth.json
~/.matrixos/config.json
```

Run:

```bash
matrix status
```

Expected:

- `~/.matrixos/profiles.json` is created.
- Legacy auth/config are moved under `~/.matrixos/profiles/cloud/`.
- Re-running the command is idempotent.

## Contract Tests

Run focused tests:

```bash
pnpm exec vitest run tests/cli
pnpm exec vitest run tests/gateway/shell-routes.test.ts
pnpm exec vitest run tests/gateway/terminal-zellij-ws.test.ts
pnpm exec vitest run tests/sync-client/daemon-ipc-v1.test.ts
```

Run review gates:

```bash
bun run typecheck
bun run check:patterns
bun run test
```
