# Quickstart: Matrix CLI TUI

## Prerequisites

- Use the manual feature worktree for `084-matrix-cli-tui`.
- Install dependencies from the repository root after dependency changes.
- Keep direct CLI command behavior compatible throughout implementation.

## Implementation Validation Loop

1. Add failing tests for launch routing and action registry coverage.
2. Implement the minimum TUI entrypoint and route bare interactive `matrix` to it.
3. Add failing render tests for home, palette, no-color, and 80x24 layout.
4. Implement status aggregation with safe partial-failure states.
5. Add failing client tests for account/sync/instance/session/workspace flows.
6. Implement clients and views in stacked milestones.
7. Add destructive confirmation tests before enabling mutating actions.
8. Update CLI docs before release.

## Manual Smoke Scenarios

```bash
matrix --help
matrix --version
matrix status --json
matrix tui
matrix
```

Verify:

- `matrix --help` and `matrix --version` never open TUI.
- Bare `matrix` opens TUI only in an interactive terminal.
- Non-interactive bare `matrix` returns concise command guidance.
- Logged-out state shows login and command palette.
- Logged-in state shows profile, gateway, sync, sessions, projects, and next action.
- `/sessions` opens the session cockpit.
- Destructive actions require confirmation.

## Automated Checks

```bash
pnpm --filter @finnaai/matrix test
pnpm --filter @finnaai/matrix build
bun run typecheck
bun run check:patterns
bun run test -- tests/gateway/workspace-routes.test.ts tests/gateway/session-runtime-bridge.test.ts tests/gateway/terminal-zellij-ws.test.ts
```

## Documentation Check

Update `www/content/docs/guide/cli.mdx` so it documents:

- default TUI launch,
- explicit direct command compatibility,
- first-run login/sync setup,
- session detach/return behavior,
- no-color/non-interactive behavior.
