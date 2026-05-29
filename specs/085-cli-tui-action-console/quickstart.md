# Quickstart: CLI TUI Action Console

## Prerequisites

- Node.js 24+
- pnpm 10.33.4
- Branch `085-cli-tui-action-console`
- PR #249 (`084-matrix-cli-tui-polish`) merged or stacked, because it introduces the current TUI foundation

## Install

```sh
pnpm install
```

## Run The TUI

```sh
pnpm --filter @finnaai/matrix exec matrix tui --no-color
```

Expected home screen:

```text
MATRIX OS

Quick Actions
> New shell session        n
  Shell sessions           s
  Setup coding agents      a
  Run doctor               d
  Login / switch account   l

Status
login required · gateway degraded · 0 sessions

[enter] run   [/] commands   [up/down] select   [q] quit
```

## Manual Acceptance Checks

1. Press `/`, search `doctor`, press Enter. The TUI shows running/result state and refreshes status.
2. Press `l`. Login starts or shows the same actionable login instructions as direct CLI login.
3. Press `s`. If authenticated and gateway is reachable, the Sessions view lists sessions. If not, the TUI shows login/gateway recovery guidance.
4. Press `n`. A new shell session is created or the TUI prompts for a safe name and shows duplicate/invalid-name states cleanly.
5. Press `a`. The setup wizard opens, lets you select Codex/Claude, detects supported local config sources, previews imports, and does not write anything before confirmation.
6. Complete setup. The TUI shows completed/skipped/failed steps and offers to open a terminal session with a setup-complete message.
7. Resize the terminal to 60, 80, and 100 columns. Quick actions remain readable and no mascot/poster art appears.

## Test Commands

Focused TUI tests:

```sh
pnpm --filter @finnaai/matrix exec vitest run \
  tests/tui/action-executor.test.tsx \
  tests/tui/home-actions.test.tsx \
  tests/tui/sessions-view.test.tsx \
  tests/tui/setup-wizard.test.tsx \
  tests/tui/local-config-migration.test.ts \
  tests/tui/command-palette.test.tsx
```

Typecheck:

```sh
pnpm --filter @finnaai/matrix exec tsc --noEmit
```

Pattern scanner:

```sh
bun run check:patterns
```

## Local Laptop Expectations

- Login, setup wizard, doctor/status display, and local config detection should provide useful behavior from a personal laptop.
- Shell session list/create/attach requires a reachable authenticated Matrix gateway. When the gateway is unavailable, the TUI must show a clear unavailable state rather than doing nothing.
