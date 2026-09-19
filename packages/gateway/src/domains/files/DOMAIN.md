# DOMAIN: `files` — file ops, tree, search, blobs, sync, trash

Owns owner-filesystem access (reads, writes, search, sync, trash). May
import `_shared` only. Path validation via `_shared/path-security`.

## Contents

`file-ops.ts` · `file-utils.ts` · `files-tree.ts` · `file-search.ts` ·
`file-blob-routes.ts` · `file-download-stream.ts` · `file-fallbacks.ts` ·
`trash.ts` · `watcher.ts` · `storage-tracker.ts` · `s3-sync.ts` · `state-ops.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W2): `state-ops.ts` placed here, not `_shared` —
  it carries app-state semantics, not generic infra.
- `sync/` folder stays at `src/` root this phase; a follow-up moves it under
  here (its imports already resolve across the boundary).
