# Plan: Concurrent Kernel Dispatch

**Spec**: `specs/004-concurrent/spec.md`
**Depends on**: Phase 3 (complete)
**Estimated effort**: Small (3 tasks, existing code modifications)

## Approach

1. Modify dispatcher to not await `spawnKernel()` -- fire-and-forget with Promise tracking
2. Add process registration to kernel startup/shutdown (SQLite rows)
3. Add conflict awareness to kernel prompt (reads active processes before acting)

## Files to Modify

- `packages/gateway/src/dispatcher.ts` -- concurrent dispatch
- `packages/kernel/src/index.ts` -- process registration on spawn/complete
- `packages/kernel/src/schema.ts` -- process tracking columns (if not already sufficient)
- `packages/kernel/src/prompt.ts` -- include active processes in L1 cache

## Testing

- Unit test: dispatcher fires multiple kernels concurrently
- Unit test: process registration is atomic (no double-claim)
- Integration test: two parallel requests complete without conflict
