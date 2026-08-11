# Task 5 report — batch Trash and hardened manifest serialization

## Outcome

Implemented MAT-268 Task 5 without changing routes or Desktop code.

- `FileBatchTrashService` validates the existing 1–100 same-parent contract, executes sources sequentially, preserves ordered partial results, and replays terminal results through the Task 3 owner/namespace/request cache.
- Trash results use stable request-safe codes (`trashed`, `source_missing`, `protected`, `invalid_destination`, `failed`). Raw filesystem errors and absolute paths stay in server logs.
- One service-owned `TrashManifestQueue` serializes batch and legacy Trash operations by resolved home. It caps both active home keys (128) and total pending work (512), removes idle keys, rejects work after shutdown, and drains/clears accepted work on `close()`.
- Manifest reads treat only `ENOENT` as empty Trash. Invalid JSON, invalid entry structure/namespace, unreadable manifests, manifest symlinks, and a symlinked `.trash` directory fail safely.
- Manifest writes retain atomic exclusive temporary-file creation plus rename, use unique operation temp names, and clean failed temp files explicitly.
- Source and parent symlink escapes, protected roots, special entries, request mismatch, and the 101-source boundary fail without permanent deletion or batch-wide rollback.

## TDD evidence

All commands ran in the MAT-268 manual worktree through Flox.

### Initial RED

```sh
flox activate -- pnpm exec vitest run \
  tests/gateway/trash.test.ts \
  tests/gateway/file-batch-trash.test.ts
```

Representative output before production edits:

```text
FAIL  tests/gateway/trash.test.ts
TypeError: TrashManifestQueue is not a constructor
AssertionError: promise resolved "{ entries: [] }" instead of rejecting

FAIL  tests/gateway/file-batch-trash.test.ts
TypeError: FileBatchTrashService is not a constructor

Test Files  2 failed (2)
Tests  12 failed | 18 passed (30)
```

The failures were the intended missing queue/batch service and the existing behavior that converted malformed/read manifest failures into empty Trash.

### Review-cycle REDs

The bounded-queue mutation check initially showed a same-home promise chain was still unbounded:

```text
FAIL  ... bounds pending operations even when they all target one home
AssertionError: expected 'pending' to be 'rejected'
Test Files  1 failed (1)
```

Manifest namespace and symlink hardening tests also failed before their fixes:

```text
FAIL  ... rejects manifest entries whose trash path is outside the Trash namespace
AssertionError: promise resolved "{ entries: [] }" instead of rejecting

FAIL  ... fails safely when the Trash directory is a symlink outside owner home
Expected code "failed"; received "trashed"

FAIL  ... rejects a manifest symlink instead of reading through it
Expected { ok: false, error: "Trash operation failed", status: 500 };
received { ok: true, trashPath: ".trash/stay.md" }
```

The shared legacy/batch service seam failed before it was added:

```text
FAIL  ... serializes legacy and batch Trash operations through the same owned home queue
TypeError: service.delete is not a function
```

### Focused GREEN

```sh
flox activate -- pnpm exec vitest run \
  tests/gateway/trash.test.ts \
  tests/gateway/file-batch-trash.test.ts
```

```text
Test Files  2 passed (2)
Tests  37 passed (37)
```

## Final verification

```sh
flox activate -- pnpm exec vitest run \
  tests/gateway/file-batch-trash.test.ts \
  tests/gateway/trash.test.ts \
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
Test Files  8 passed | 4 skipped (12)
Tests  84 passed | 64 skipped (148)
```

The 64 skips are the existing Linux x64/glibc native-only Task 2 suites on this macOS host.

```sh
flox activate -- pnpm --filter '@matrix-os/gateway' exec tsc --noEmit
git diff --check
```

Both commands completed successfully with no diagnostics. Focused files remain below 500 lines.

## Files changed

- `packages/gateway/src/trash.ts`
- `packages/gateway/src/file-management/batch-service.ts`
- `tests/gateway/trash.test.ts`
- `tests/gateway/file-batch-trash.test.ts`
- `.superpowers/sdd/plan/task-5-report.md`

## Self-review

- Queue identity uses the resolved home path, never client request data, and capacity rejection does not evict or bypass already accepted work.
- The service tracks active cached batch promises before shutdown and the owned manifest queue drains legacy operations; injected queues/caches are not closed by non-owners.
- Batch execution intentionally uses a plain ordered loop. A failed item does not clear prior results, stop later items, or trigger rollback.
- Manifest parsing validates the stored source basename, owner-relative paths, the direct `.trash/<name>` namespace, and deletion timestamps while retaining compatibility with existing source names permitted by the path contract.
- Manifest contents are read before the source rename, so malformed/unreadable manifests leave the source in place. A later atomic-write failure may retain the moved item as a safe Trash orphan and returns only the generic `failed` result.
- The service exposes single-delete/list/restore/empty methods through the same owned queue so Task 6 can wire legacy and batch routes without reintroducing a second serialization domain.

## Concerns

The Linux native capability suites remain skipped on macOS and require Linux CI. Task 6 must register and close one `FileBatchTrashService` for both legacy Trash routes and the new batch route; using the top-level helpers without the service queue would intentionally bypass cross-request serialization.
