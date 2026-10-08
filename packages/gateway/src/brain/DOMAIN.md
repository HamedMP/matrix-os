# Company Brain Store

The durable store behind the Company Brain: what an organisation or a person
has published or synced into their brain, with revisions, tombstones, sync
cursors and sync receipts.

## Scope

- Owns the nine `brain_*` tables (`brain_sources`, `brain_documents`,
  `brain_document_revisions`, `brain_document_refs`, `brain_sync_cursors`,
  `brain_sync_receipts`, plus `brain_claims`, `brain_extraction_state` and
  `brain_extraction_runs` from `claims/database.ts`) and `BrainRepository`,
  the only reader and writer of those tables.
- Out of scope, deferred to later PRs in the stack: organization scopes and
  scheduled source sync. The git adapter
  lives in `git/`; the project routes, the `brain_why` agent tool and startup
  wiring live in `why.ts` and `api/`; claim extraction lives in `claims/`;
  each feature folder has its own `DOMAIN.md` (all below).
- Out of scope permanently: authorization (the caller resolves the scope),
  `onboarding/company-brain-readiness.ts` (an unrelated in-memory readiness
  service), and PR #2078's `company_brain_*` tables under `company-brain/`.
- Name clash to keep in mind: `company-brain/` exports `BrainSourceIdSchema`,
  `BrainCitation` and `BrainEvidenceProof` under the same names with opposite
  meanings. Its `BrainSourceIdSchema` (`^[a-f0-9]{64}$`) and `sourceId` fields
  correspond to this store's `document_id` / `BrainDocumentIdSchema`; this
  store's `BrainSourceIdSchema` (`^src_[a-f0-9]{32}$`) names a connected source
  and has no counterpart there. Import from one folder per module and alias on
  import if both are needed.

## Source Of Truth

- Owner Postgres, tables prefixed `brain_`. Every row carries
  `(owner_id, scope_id)` and every primary key starts with that pair.
- The GIN full-text index, the per-document revision snapshots and the claims
  are derived and bounded (10 snapshots per document id, 50 receipts per
  source, 50 claims per document and extractor, 50,000 claims per scope).
- The store keeps no in-memory registry, cache, or file state; the git adapter
  and the claims job keep only capped (`GIT_MAX_CONCURRENT_SYNCS`,
  `BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS`) in-process sets of running keys,
  cleared in `finally`.

## Public API

- `index.ts` exports `BrainRepository`, `bootstrapBrainDatabase`,
  `computeBrainContentHash`, every type and constant in `types.ts`, and the
  Zod schemas plus `parseBrainInput` from `schemas.ts`.
- `BrainRepository.listDocumentRefs(scope, documentId)` returns a live
  document's refs (at most `BRAIN_DOCUMENT_REFS_MAX`, ordered by kind then
  value); refs are written only through `applySyncBatch` upserts.
- The internals (`documents.ts`, `document-reads.ts`, `document-refs.ts`,
  `sources.ts`, `sync.ts`, `mappers.ts`, `schemas.ts`) are not imported by
  other domains; they are reached through the repository.

## Auth And Trust Boundaries

- The caller authorizes the `BrainScopeKey` (via `requireRequestPrincipal` or
  the collaboration authority) before calling the repository; the repository
  never authorizes and never takes a bare id without a scope key.
- A row outside the caller's `(owner_id, scope_id)` is invisible: reads return
  `null` or empty pages, writes throw `not_found`. Exceptions, which never say
  which part failed: `assertCurrent` throws `forbidden` when a proof does not
  match a live row; `applyDocumentExtraction` throws `conflict` for a run that
  is not the scope's running run and returns `applied: false` for an unseen
  document.
- Every input is parsed by a strict, bounded Zod schema before any SQL runs;
  SQL CHECK constraints mirror the same limits.
- Errors are `BrainStoreError` codes (`invalid`, `not_found`, `conflict`,
  `capacity`, `forbidden`) with one fixed message. Zod issues stay in the
  `cause`. Postgres errors propagate unchanged for the route layer to map to a
  generic 503; they are never exposed to clients.

## Concurrency And Recovery

- Every write is one transaction that sets `lock_timeout = 5s` and
  `statement_timeout = 15s`, then takes `pg_advisory_xact_lock` keyed on the
  owner and `brain:<scopeId>`. Capacity counting, CAS, cursor advance,
  receipt pruning and erase all run under that lock. Reads do not lock.
- The repository clock is read only after the lock is held, so a writer that
  waited on the lock never commits an older timestamp than the writer that
  released it: `updated_at`, `superseded_at`, `started_at` and `finished_at`
  are monotonic within a scope, which the snapshot and receipt prunes and the
  newest-first listings rely on.
- Optimistic concurrency lives in the write predicate: `revision = expected`
  on sources and documents, `cursor = expected` on sync cursors, and
  `status = 'running'` on receipts. A miss is `conflict`.
- A sync batch and its cursor advance commit together, so the cursor can never
  run ahead of or behind the documents it describes.
- A `running` receipt left by a crashed run is closed as `interrupted` by the
  next `openSyncReceipt` for that source, or by `deleteSource` when the source
  is removed (nothing can open another receipt for a tombstoned source), so
  `running` never lingers.
- Revision snapshots record the `source_id` that owned the document when they
  were taken. `deleteSource` purges by that column as well as by current
  ownership, so a removed source's content does not survive in the history of
  a document id that another source later revived. Snapshots with another
  `source_id`, or none, survive a source delete only when their document id is
  not owned, live or tombstoned, by the deleted source.
- Refs (`brain_document_refs`) are an index over live synced documents.
  `applySyncBatch` is their only writer: each upsert carries its complete ref
  set (omitted means none), the stored set is compared first and replaced only
  when it differs, in the batch transaction. Every tombstone path
  (`applyDelete`, `deleteSource`) removes a document's refs and `eraseScope`
  deletes refs first, so only live documents have refs. Refs are not
  snapshotted into revisions.
- Orphan states: none across tables, because every multi-row write is one
  transaction. Tombstones, revision snapshots, receipts and extraction runs
  (50 per scope, plus at most 1,000 runs that cost anything in the last 30 days)
  are the retained history, each bounded by count; claims of an
  older revision stay, flagged stale, until re-extracted; claims and state of
  an older rules version stay, readable, until the current rules version
  writes that document; a crashed `running` extraction run blocks its scope
  until its 5-minute lease expires.
  `eraseScope` removes everything for a scope, except its billed extraction
  runs of the last 30 days, which move to the owner's retired-runs scope id
  (counts and usage only) so the owner's model spend cap still counts them;
  the next run that opens drops them once they leave the window.
- Bootstrap is idempotent (`CREATE ... IF NOT EXISTS`) under a schema-wide
  advisory lock, so concurrent gateway processes can start safely.

## Tests

`pnpm exec vitest run tests/gateway/brain-store.test.ts tests/gateway/brain-store-capacity.test.ts tests/gateway/brain-store-sync.test.ts tests/gateway/brain-store-refs.test.ts`
(PGlite-backed; fixtures live in `tests/gateway/helpers/brain-store-helpers.ts`).

`MATRIX_TEST_POSTGRES_URL=<disposable server> pnpm exec vitest run tests/gateway/brain-store-postgres.test.ts`
proves the cross-connection behaviour PGlite cannot (concurrent bootstrap,
concurrent `createSource`, two concurrent `applySyncBatch` calls where exactly
one wins); it is skipped when the variable is unset.

## Git source adapter (`git/`)

Spec: `specs/552-company-brain-git-source/spec.md`.

- `git/index.ts` exports `syncGitSource`, `defaultGitRunner`, `openGitRepository`,
  `deriveWebBase`, `parseWebBase`, `resolveGitWebBase` and the types and limits in
  `git/types.ts`. `brain/index.ts` does not re-export it; import `brain/git/index.js`.
- Source of truth: the repository's git history on its default branch, read-only.
  The adapter writes only through `BrainRepository` (`applySyncBatch`, receipts).
- One document per first-parent commit (a pull request document when the commit is a
  GitHub squash or merge of `#N`, or a GitLab merge of `!N`; otherwise a commit document)
  and one document per spec file part (by default `specs/*/` `spec.md`, `plan.md`,
  `research.md`, `data-model.md`, `quickstart.md`, and top-level `specs/*.md`). Ids are sha256 of
  `["brain_git_v1", externalRef, kind, ...]`, never of content. Changed paths, PR numbers
  and spec directories are refs. A spec file is written only in a window whose end already
  holds its content at the run's tip, so a first sync or a rescan never rolls it back.
- Each `applySyncBatch` call commits its documents, refs and cursor write in one
  transaction; only a window's final batch moves the cursor to the window end, so a crash
  replays the window as no-ops. The cursor (`git/cursor.ts`) is the last fully applied
  first-parent sha, plus the run's tip when the run stopped short of it, or an in-progress
  token naming the run that holds the window. A cursor that is no longer on the way to the
  branch tip (force-push, garbage-collected object, read-ahead commits gone) triggers a
  bounded rescan from the root.
- The caller authorizes the scope and resolves `repoPath` and `homePath`;
  `openGitRepository` refuses anything whose realpath is not strictly inside
  `realpath(homePath)`, is not the repository top level, or whose git directory, common
  directory or object alternates leave home or enter home's own `.git`. One run per source
  per process; across processes the cursor compare-and-set decides (`cursor_conflict`),
  and a window's first batch takes the cursor, so a competing run fails before it writes.
- Git runs through an injectable runner: execFile with an argv array, an environment built
  from scratch (absolute `PATH` entries only, `GIT_ALLOW_PROTOCOL=none`), pinned `-c`
  overrides, a timeout and a maxBuffer on every call. Only local git objects are read; no
  network, no working tree, never `HEAD`.
- Errors are stable codes in `GitSyncResult`, and on the receipt once one is open
  (`invalid_options`, `sync_in_progress` and the `source_*` codes come before it and are
  only returned). `history_rewritten` and `documents_rejected` are info codes on
  successful runs. stderr and paths go to server logs only.
- Tests: `tests/gateway/brain-git-*.test.ts` (fixture repos are built with git plumbing in
  a temp directory by `tests/gateway/helpers/brain-git-fixture.ts`; the sync suites share
  `helpers/brain-git-harness.ts`, the pure suites `helpers/brain-git-pure.ts`).

