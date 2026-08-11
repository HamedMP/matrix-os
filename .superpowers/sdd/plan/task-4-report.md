# Task 4 report — safe per-item move and batch execution

## Outcome

Implemented MAT-268 Task 4 without adding HTTP routes or Trash behavior.

- `moveFileItem` freshly validates policy, containment, symlinks, source/destination type, current-directory moves, and directory self/descendant moves before every native attempt.
- Production execution uses only the Linux native direct no-replace move boundary. Unsupported platforms, missing capability, cross-device moves, and unexpected native failures fail closed; there is no copy/delete or pathname-based production fallback.
- Keep Both uses bounded atomic retries, Finder-style `copy` numbering, continuation from existing copy numbers, UTF-8-safe 255-byte truncation, and preserves occupied file, directory, and symlink claimants.
- `FileBatchMoveService` executes at most 100 items sequentially in source order, returns independent stable per-item results, performs no batch rollback, and reports the authoritative source/destination directories.
- Owner/request preflight records are bounded to 512 entries, expire ten minutes after original completion without replay extension, and are coupled to the Task 3 owner+namespace result cache for preflight and execute idempotency.
- Detailed server failure logs include the validated request ID; responses contain only stable safe codes.

## TDD evidence

All commands ran from the MAT-268 manual worktree through Flox.

### Initial RED

```sh
flox activate -- pnpm exec vitest run tests/gateway/file-batch-move.test.ts
```

Representative output before the implementation modules existed:

```text
FAIL  tests/gateway/file-batch-move.test.ts
Error: Cannot find module '../../packages/gateway/src/file-management/batch-service.js'
Test Files  1 failed (1)
Tests  no tests
```

### Review-cycle RED: preflight expiry

The regression test replays preflight at 9:59.999 and then executes after the original ten-minute deadline:

```sh
flox activate -- pnpm exec vitest run tests/gateway/file-batch-move.test.ts -t "expires preflight"
```

Before the fix it failed because replay incorrectly extended the destructive-operation record:

```text
FAIL  ... expires preflight ten minutes after its original completion even when replayed
AssertionError: promise resolved ... instead of rejecting
Test Files  1 failed (1)
```

After retaining the original expiry, the same test passed.

### Review-cycle RED: Keep Both edge claims

```sh
flox activate -- pnpm exec vitest run tests/gateway/file-batch-move.test.ts -t "continues existing|symlink Keep Both"
```

Before the fixes:

```text
FAIL  ... continues existing Finder copy numbering and truncates valid 255-byte names
Expected report copy 2.md; received report copy copy.md
Expected moved for the 255-byte name; received invalid_destination

FAIL  ... treats a symlink Keep Both name as an atomic conflict and retries the next candidate
Expected shared copy 2.txt moved; received invalid_destination
Test Files  1 failed (1)
Tests  2 failed
```

After numbering/truncation moved into candidate generation and final-name claim decisions were left to the native no-replace boundary, the focused edge set passed 4/4.

### GREEN

```sh
flox activate -- pnpm exec vitest run tests/gateway/file-batch-move.test.ts
```

Final focused result:

```text
Test Files  1 passed (1)
Tests  13 passed (13)
```

The suite covers file/directory moves, numbered and byte-bounded Keep Both names, atomic late/symlink/concurrent claimants, no overwrite/merge, Skip, cancel-before-execute, fail-closed cross-device behavior, ordered partial results, execute replay, immutable ten-minute preflight expiry, 100/101 item boundaries, traversal, protected roots, source/destination symlink swaps, missing stale sources, self/descendant moves, and fingerprint mismatch.

## Verification

```sh
flox activate -- pnpm exec vitest run \
  tests/gateway/file-batch-move.test.ts \
  tests/gateway/file-batch-preflight.test.ts \
  tests/gateway/file-operation-result-cache.test.ts \
  tests/gateway/file-management-contracts.test.ts \
  tests/gateway/files-tree.test.ts \
  tests/gateway/file-ops.test.ts \
  tests/gateway/file-management-copy-safety.test.ts \
  tests/gateway/file-management-typed-ops.test.ts \
  tests/gateway/native-file-capability.test.ts \
  tests/gateway/native-file-capability-boundaries.test.ts
```

```text
Test Files  6 passed | 4 skipped (10)
Tests  45 passed | 64 skipped (109)
```

The skipped tests are the existing Linux x64/glibc native-only suites on macOS. Task 4 uses a filesystem-backed injected no-replace capability in tests; the production default remains the native addon and has no fallback.

```sh
flox activate -- pnpm --filter '@matrix-os/gateway' exec tsc --noEmit
git diff --check
```

Both complete successfully. Production files are 217 and 224 lines; the focused test is 448 lines, all below the 500-line target.

## Files changed

- `packages/gateway/src/file-management/move.ts`
- `packages/gateway/src/file-management/batch-service.ts`
- `packages/gateway/src/file-ops.ts`
- `tests/gateway/file-batch-move.test.ts`
- `.superpowers/sdd/plan/task-4-report.md`

## Self-review

The requested two-axis review found one hard standards issue and three spec edge gaps; all were addressed before final verification.

- Replaced the test's mutable unbounded failure `Map` with one bounded forced-failure slot.
- Reused the existing Task-4-owned same/descendant predicate and named the injection contract `NoReplaceFileMoveCapability` to expose its semantic guarantee.
- Kept the narrow `file-ops.ts` bridge because Task 4 explicitly requires the smallest integration there; it does not add a fallback or a second mutation implementation.
- Added Finder number continuation and UTF-8 byte-aware truncation instead of rejecting valid maximum-length source names.
- Allowed occupied final symlinks to reach the native no-replace linearization point, while continuing to reject source and parent symlinks during authorization.
- Added request-ID correlation to authorization and native-failure logs without placing absolute paths or raw errors in results.
- Batch execution uses a plain ordered loop intentionally: later items continue after prior failures, and repeated execute payloads replay the cached terminal result without touching the filesystem twice.

## Concerns

The Linux native addon cannot load on this macOS host, so Linux-only Task 2 capability suites are reported as skipped. The injected test capability exercises real files, directories, atomic file-name claims, and the complete production batch/move service path; Linux CI remains responsible for the actual `renameat2(RENAME_NOREPLACE)` syscall boundary.
