# Quickstart: Matrix Symphony

## Local Validation Path

1. Start from the `078-matrix-symphony` worktree.

2. Install dependencies if missing:

   ```bash
   pnpm install --frozen-lockfile
   ```

3. Run focused tests while implementing:

   ```bash
   pnpm exec vitest run \
     tests/gateway/symphony-repository.test.ts \
     tests/gateway/symphony-linear-source.test.ts \
     tests/gateway/symphony-orchestrator.test.ts \
     tests/gateway/symphony-routes.test.ts \
     tests/gateway/symphony-restart-recovery.test.ts \
     tests/default-apps/symphony-app.test.tsx
   ```

4. Run required repo gates before PR:

   ```bash
   bun run typecheck
   bun run check:patterns
   bun run test
   ```

## Manual Product Smoke

1. Open Matrix shell and launch Symphony.
2. Connect Linear or add a server-side Linear API secret.
3. Select team, optional project, `symphony` label, active states, and one or more assignees.
4. Confirm eligible ticket preview shows only matching tickets.
5. Start Symphony with concurrency set to 1.
6. Confirm one Matrix worktree and one agent session appear for the matching ticket in the dashboard run list.
7. Stop the run and confirm the session stops and the worktree lease releases.
8. Reload the gateway/app and confirm dashboard state reconstructs without exposing credentials.

## PR Readiness

- All task checkboxes in `tasks.md` complete.
- Focused tests pass.
- Required repo gates pass locally.
- PR body includes backend invariants: source of truth, transaction/lock scope, acceptable orphan states, auth source of truth, and deferred scope.
