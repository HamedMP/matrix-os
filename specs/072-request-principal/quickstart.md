# Quickstart: Request Principal

## Prerequisites

- Repo root: `/home/deploy/matrix-os.worktrees/072-request-principal`
- Node.js 24+, pnpm 10, bun available through the project environment
- No new dependencies are required for this feature

## Red Test Pass

1. Add/extend gateway tests before implementation:

   ```bash
   bun run test -- tests/gateway/request-principal.test.ts
   bun run test -- tests/gateway/sync/user-id-from-jwt.test.ts
   bun run test -- tests/gateway/workspace-routes.test.ts
   bun run test -- tests/gateway/canvas-routes.test.ts
   ```

2. Expected red cases before implementation:

   - canonical principal returns source `jwt`, `configured-container`, or `dev-default`
   - malformed `userId` rejects before owner scope/storage/rate-limit use
   - missing auth-context marker maps to generic server misconfiguration
   - workspace session/project owner id follows principal user id instead of `local`
   - no new/touched protected route calls the legacy raw fallback resolver directly

## Green Implementation Pass

1. Add `packages/gateway/src/request-principal.ts`.
2. Add auth-context readiness marking in `packages/gateway/src/auth.ts`.
3. Migrate sync, canvas, workspace, and WebSocket consumers through the canonical accessor or an injected principal dependency.
4. Keep legacy resolver compatibility documented and covered by a pattern/test guard.
5. Update public docs under `www/content/docs/` for configured container identity behavior, or record a narrow deferral if no public docs page exists yet.

## Verification

Run the pre-PR gate from the repo root:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

Focused verification while iterating:

```bash
bun run test -- tests/gateway/request-principal.test.ts
bun run test -- tests/gateway/sync/user-id-from-jwt.test.ts
bun run test -- tests/gateway/workspace-routes.test.ts
bun run test -- tests/gateway/canvas-routes.test.ts
```

## Rollback Notes

This feature adds no durable state. If implementation must be reverted, remove the shared accessor usage and restore route-specific identity injection while preserving existing sync fail-closed tests.
