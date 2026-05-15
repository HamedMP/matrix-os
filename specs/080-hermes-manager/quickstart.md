# Quickstart: Hermes Manager

## Prerequisites

- Matrix OS running from the 080 worktree.
- Hermes repo available locally for development, defaulting to `/home/deploy/hermes-agent` when present.
- Node.js 24+, pnpm 10.33.4, and bun available through the existing Matrix OS setup.

## Development Loop

1. Install dependencies after app/package changes:

   ```bash
   pnpm install
   ```

2. Run the focused Hermes Manager tests during implementation:

   ```bash
   bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts tests/default-apps/hermes-manager-app.test.tsx
   ```

   The focused loop intentionally includes `hermes-event-hub.test.ts` for bounded subscriber/event retention, `hermes-repository.test.ts` for idempotency and retained-state caps, and `hermes-restart-recovery.test.ts` for stale live-reference reconciliation.

3. Run the mandatory pre-PR gates:

   ```bash
   bun run typecheck
   bun run check:patterns
   bun run test
   bun run test tests/gateway/hermes-auth.test.ts tests/gateway/hermes-routes.test.ts tests/gateway/hermes-bridge.test.ts tests/gateway/hermes-credential-store.test.ts tests/gateway/hermes-event-hub.test.ts tests/gateway/hermes-repository.test.ts tests/gateway/hermes-restart-recovery.test.ts tests/default-apps/hermes-manager-app.test.tsx
   ```

   The full `bun run test` run is the project-wide gate from `CLAUDE.md`. The focused Hermes subset must also pass and must keep `hermes-event-hub.test.ts` and `hermes-repository.test.ts`; they cover resource-management and persistence invariants that route/app tests do not fully exercise.

4. Build default apps before bundling or validating installable app output:

   ```bash
   node scripts/build-default-apps.mjs home/apps
   ```

5. Launch local Matrix OS for manual validation:

   ```bash
   bun run dev
   ```

6. Open Hermes Manager from the Matrix app launcher. Expected P1 path:

   - readiness shows Hermes installed or actionable setup state
   - owner can save model provider state without browser-visible secrets
   - Telegram and WhatsApp can be connected/disabled/recovered through mocked or local Hermes bridge
   - user can start a Hermes session, stream events, and resolve an approval

## Manual Review Checklist

- Browser network responses contain no provider tokens, gateway secrets, raw stack traces, command output, or filesystem paths.
- Unauthorized requests to `/api/hermes/*` return generic auth errors and no owner state.
- Mutating endpoints apply body limits and reject invalid action payloads.
- Hermes bridge dependencies fail fast at route registration/startup when missing.
- Event history and in-memory lock maps are capped.
- App works in Canvas and Desktop launch paths.
