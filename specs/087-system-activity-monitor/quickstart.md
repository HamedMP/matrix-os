# Quickstart: System Activity Monitor

## Prerequisites

- Matrix OS worktree on the System Activity Monitor branch.
- Node.js 24+, pnpm 10, bun available through Flox or local setup.
- A local dev runtime for gateway and shell, or a disposable customer VPS for full host-service validation.

## Read-Only MVP Validation

1. Start gateway and shell:

   ```bash
   bun run dev:gateway
   bun run dev:shell
   ```

2. Open the shell in Canvas mode.

3. Open the built-in System Activity Monitor.

4. Verify the dashboard shows:
   - machine identity
   - release/version
   - uptime
   - CPU load and pressure
   - RAM with process/cache distinction
   - disk usage
   - Matrix service health
   - top processes

5. Run focused tests:

   ```bash
   pnpm exec vitest run \
     tests/gateway/system-activity-collector.test.ts \
     tests/gateway/system-activity-routes.test.ts \
     tests/shell/system-activity-app.test.tsx
   ```

## Manual Cleanup Validation

1. Create or identify a safe stale app server fixture.

2. Confirm the monitor shows a cleanup suggestion with reason, risk, confidence, and estimated reclaim.

3. Confirm cleanup from the UI.

4. Verify:
   - the stale resource is gone
   - active Matrix services remain healthy
   - cleanup history records the action
   - the dashboard refreshes with updated resource values

5. Run focused tests:

   ```bash
   pnpm exec vitest run \
     tests/gateway/system-activity-cleanup.test.ts \
     tests/gateway/system-activity-history.test.ts \
     tests/gateway/system-activity-routes.test.ts
   ```

## Automatic Cleanup Validation

1. Enable auto-clean only for high-confidence safe classes in the policy UI.

2. Create stale fixture resources and wait for the grace period.

3. Verify:
   - eligible stale resources are cleaned
   - active resources are skipped
   - all automatic actions are visible in history
   - rate limits prevent cleanup loops

## Required Gates Before PR

```bash
bun run typecheck
bun run check:patterns
bun run test
npx react-doctor@latest shell
```

If a change touches only the Spec Kit documents, run markdown/path validation and explain why runtime gates were skipped.
