# Company Brain store

**Status:** Implementation target (PR 1 of the brain stack)  
**Owner:** gateway `brain` domain (`packages/gateway/src/brain/`)  
**Date:** 2026-10-01

## Outcome

Matrix keeps a durable, owner-controlled record of the documents a company (or a
single person) has published into its Brain: where each document came from, what
it said at every recent revision, when it was deleted, and how far each connected
source has been synced. Every row belongs to exactly one `(ownerId, scopeId)` pair
and nothing outside that pair can read or change it. A later caller can prove that
a citation still points at the current revision of a live document.

This increment ships only the store: five `brain_*` Postgres tables (spec 552
adds a sixth, `brain_document_refs`), their bootstrap, bounded Zod input schemas,
and a `BrainRepository` class that reads and writes them with scope enforcement.
It adds no HTTP routes, no agent tools, no sync adapters, no extraction, no
ranking, and no startup wiring. The wiring point is described below and lands in
PR 2.

Spec 552 (git source adapter) adds `brain_document_refs` and its lookup index;
see `specs/552-company-brain-git-source/spec.md`. The table, its limits and the
store rules that maintain it are part of this store and are described below.

## Scope of this increment

In scope:

- Tables `brain_sources`, `brain_documents`, `brain_document_revisions`,
  `brain_sync_cursors`, `brain_sync_receipts` with CHECK constraints that mirror
  the limits in `types.ts`.
- `bootstrapBrainDatabase(db)`: idempotent, concurrency-safe DDL in one transaction.
- `schemas.ts`: one strict Zod schema per input type, plus `parseBrainInput`.
- `BrainRepository`: sources, documents with revisions and tombstones, sync
  cursors, sync receipts, evidence proof checks, full scope erase.
- A plain full-text GIN index on live documents (no ranking, no headlines).
- Tests on PGlite (`tests/gateway/brain-store.test.ts`,
  `tests/gateway/brain-store-capacity.test.ts`,
  `tests/gateway/brain-store-sync.test.ts`, and the shared fixtures in
  `tests/gateway/helpers/brain-store-helpers.ts`), plus
  `tests/gateway/brain-store-postgres.test.ts` for the cross-connection cases
  PGlite cannot prove (see Integration test checkpoint).
- `packages/gateway/src/brain/DOMAIN.md`.

Out of scope (no stubs or placeholders left for it):

- Routes, request authorization, agent tools, sync adapters (Slack or otherwise),
  claim extraction, search ranking, `ts_headline`, startup wiring, shutdown hooks.
- Any change to `packages/gateway/src/onboarding/company-brain-readiness.ts` or
  `company-brain-routes.ts`.
- Any change to PR #2078's `packages/gateway/src/company-brain/` (on branch
  `origin/codex/slack-company-brain-store`, not yet merged) or its
  `company_brain_*` tables.
- A bridge between `brain_*` and `company_brain_*` (described under
  "Relationship to existing work"; built later).

This PR changes no user-visible surface: no UI, copy, or route. The OS-view
surface matrix is therefore N/A for PR 1; PR 2 and later carry it where UI ships.

## Scope model

- A scope key is `BrainScopeKey { scopeId, ownerId }`. The caller (route or
  service in PR 2) resolves and authorizes it. The repository never authorizes; it
  only enforces that every query is bound to the key it was given.
- `scopeId` is opaque text, 1..256 chars, chosen by the caller: a collaboration
  scope uuid (spec 124) for an organization brain, or `personal:<ownerId>`-style
  text for a personal brain. The store does not parse it.
- Every row in all six tables carries `owner_id` and `scope_id` (1..256 chars
  each). Every primary key starts with `(owner_id, scope_id, ...)`. Every SELECT,
  UPDATE, and DELETE carries both predicates. No helper takes a bare id.
- A row whose `(owner_id, scope_id)` differs from the caller's key is invisible.
  A scope mismatch is indistinguishable from a missing row: reads return `null`
  or an empty page, mutations throw `not_found`, and `assertCurrent` throws the
  same `forbidden` it throws for an unknown id, so existence is not leaked.
- Per-scope write serialization: every write transaction first runs
  `SELECT pg_advisory_xact_lock(hashtext(ownerId), hashtext('brain:' || scopeId))`.
  Capacity counting, revision and cursor CAS, receipt pruning, and erase all run
  under this lock. Reads do not lock. The repository clock (`options.now`) is read
  only after the lock is held, so `updated_at`, `superseded_at`, `started_at` and
  `finished_at` are monotonic within a scope even when a writer waited on the
  lock; the newest-first prunes and listings depend on that.
- Every write transaction begins with `SET LOCAL lock_timeout = '5s'` and
  `SET LOCAL statement_timeout = '15s'`.

## Data model

All DDL runs through `sql\`...\`.execute(trx)` in one transaction. Timestamps are
`TIMESTAMPTZ` written by the repository clock (`options.now`, default
`() => new Date()`); the database never defaults them.

### Identifier rules

| Id | Rule | Chosen by |
| --- | --- | --- |
| `document_id` | `^[a-f0-9]{64}$`: sha256 hex of a stable external identity tuple, for example `sha256(JSON.stringify(["slack", teamId, channelId, threadTs]))` or `sha256(JSON.stringify(["manual", scopeId, randomUUID()]))`. Never a content hash. Same hashing recipe as #2078 `source_id` (`sha256` over `JSON.stringify` of a stable identity tuple; #2078 hashes `[appId, teamId, channelId, eventId]` for Slack, and the tuple here is the adapter's choice). | adapter or service |
| `source_id` | `^src_[a-f0-9]{32}$` = `"src_" + randomUUID()` without dashes | repository (`createSource`) |
| `receipt_id` | `^rcp_[a-f0-9]{32}$` = `"rcp_" + randomUUID()` without dashes | repository (`openSyncReceipt`) |
| `incarnation` | uuid from `randomUUID()` on the app side (never `gen_random_uuid()`). Assigned on create, kept across updates and across the tombstone, replaced only when a tombstoned id is recreated. | repository |
| `revision` | integer, 1 on create, +1 on every update and on delete (the tombstone is revision N+1). Recreate after a tombstone restarts at 1 under the new incarnation. Callers may present at most `BRAIN_MAX_REVISION` as `expectedRevision`; the stored value is bounded only by INTEGER and is never expected to approach it. | repository |
| `content_hash` | `sha256(JSON.stringify([title, body]))` hex; permalink excluded. Drives the `unchanged` outcome. | repository |
| `kind`, `provenance` | `^[a-z][a-z0-9_]{0,31}$`. First values: kind `manual`, `slack`; provenance `manual`, `slack_thread`. Regex CHECK, not an enum, so adapters add values without a migration. | caller |
| `error_code` | `^[a-z][a-z0-9_]{0,63}$`; a stable machine code, never provider text. | caller (adapter) |

### `brain_sources`

| Column | Type | Rule |
| --- | --- | --- |
| `owner_id`, `scope_id` | TEXT | 1..256 chars |
| `source_id` | TEXT | `^src_[a-f0-9]{32}$` |
| `kind` | TEXT | kind regex |
| `external_ref` | TEXT | 1..512 chars; an identifier, never a credential |
| `label` | TEXT | 1..300 chars |
| `status` | TEXT | `active`, `paused`, `disabled` |
| `revision` | INTEGER | > 0 |
| `created_at`, `updated_at` | TIMESTAMPTZ | not null |
| `deleted_at` | TIMESTAMPTZ | null while live |

Primary key `(owner_id, scope_id, source_id)`. Partial unique index
`brain_sources_live_ref` on `(owner_id, scope_id, kind, external_ref) WHERE
deleted_at IS NULL`: one live source per external identity per scope; a tombstoned
source frees the key.

### `brain_documents`

| Column | Type | Rule |
| --- | --- | --- |
| `owner_id`, `scope_id` | TEXT | 1..256 chars |
| `document_id` | TEXT | `^[a-f0-9]{64}$` |
| `source_id` | TEXT, nullable | null for manual publication; otherwise `^src_[a-f0-9]{32}$`. No foreign key (see below). |
| `incarnation` | UUID | not null |
| `title` | TEXT | <= 300 chars |
| `body` | TEXT | `octet_length(body) <= 65536` |
| `permalink` | TEXT | <= 2048 chars; `""` when none |
| `content_hash` | TEXT | `^[a-f0-9]{64}$` |
| `byte_count` | INTEGER | 0..65536 |
| `provenance` | TEXT | kind regex |
| `revision` | INTEGER | > 0 |
| `source_updated_at`, `published_at`, `updated_at` | TIMESTAMPTZ | not null |
| `deleted_at` | TIMESTAMPTZ | null while live |

Primary key `(owner_id, scope_id, document_id)`. Two table CHECKs enforce the
tombstone shape: `deleted_at IS NULL OR (title = '' AND body = '' AND permalink =
'' AND byte_count = 0)` and `deleted_at IS NOT NULL OR (char_length(title) >= 1 AND
char_length(body) >= 1)`. Indexes: `brain_documents_search` GIN on
`to_tsvector('simple', title || ' ' || body) WHERE deleted_at IS NULL` (the
`'simple'` config is the existing `chat/database.ts` convention and is
language-neutral), and `brain_documents_source` on `(owner_id, scope_id,
source_id, document_id) WHERE deleted_at IS NULL`.

`source_id` has no foreign key on purpose: sources are physically deleted only by
`eraseScope`, which deletes documents first; a tombstoned source keeps its row.

### `brain_document_revisions`

Prior-state snapshots. Same content columns as `brain_documents` (`title`, `body`,
`permalink`, `content_hash`, `byte_count`, `provenance`, `source_updated_at`) plus
`source_id` (nullable, same CHECK as `brain_documents.source_id`: the source that
owned the document when the snapshot was taken, so `deleteSource` can purge a
removed source's content even from a document id later re-incarnated under
another source), `incarnation`, `revision` (the revision being superseded),
`change` in (`updated`, `deleted`), and `superseded_at`. Primary key `(owner_id,
scope_id, document_id, incarnation, revision)`. At most
`BRAIN_REVISIONS_PER_DOCUMENT` (10) rows per document id, newest kept.

### `brain_sync_cursors`

`(owner_id, scope_id, source_id)` primary key, `cursor` TEXT 1..2048 chars
(opaque provider position), `updated_at`. Foreign key to `brain_sources` with
`ON DELETE CASCADE`. One row per source.

### `brain_sync_receipts`

| Column | Rule |
| --- | --- |
| `receipt_id` | `^rcp_[a-f0-9]{32}$` |
| `status` | `running`, `succeeded`, `partial`, `failed`, `interrupted` |
| `read_count`, `written_count`, `unchanged_count`, `deleted_count`, `failed_count` | INTEGER >= 0, default 0 |
| `next_action` | <= 500 chars matching `^([a-z][a-z0-9_]*)?$` (table CHECK), default `''`; a bounded operator hint such as `reconnect_slack` or `retry_after_backoff`, never provider text |
| `error_code` | null or error-code regex |
| `cursor_before`, `cursor_after` | null or 1..2048 chars |
| `started_at` | not null |
| `finished_at` | null exactly while `status = 'running'` (table CHECK) |

Primary key `(owner_id, scope_id, source_id, receipt_id)`; foreign key to
`brain_sources` with `ON DELETE CASCADE`; index `brain_sync_receipts_started` on
`(owner_id, scope_id, source_id, started_at DESC)`. At most
`BRAIN_RECEIPTS_PER_SOURCE` (50) rows per source; `running` rows are never pruned.

### `brain_document_refs`

What a synced document touches, for lookups by value (the planned
`brain_why(path)`, spec 552).
Columns `owner_id`, `scope_id`, `document_id` (`^[a-f0-9]{64}$`), `kind` (kind
regex, for example `path`, `pr`, `spec`) and `value` (TEXT `COLLATE "C"`, 1..512
bytes). Primary key `(owner_id, scope_id, document_id, kind, value)`; foreign key
`(owner_id, scope_id, document_id)` to `brain_documents` with `ON DELETE CASCADE`.
Index `brain_document_refs_lookup` on `(owner_id, scope_id, kind, value)`. Refs
are an index over live synced documents only and are never snapshotted into
revisions.

### Bootstrap

`bootstrapBrainDatabase(db)` runs one `db.transaction()` that in order sets
`SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '30s'`, takes
`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('brain_schema'))`,
then issues the six `CREATE TABLE IF NOT EXISTS` and five `CREATE INDEX IF NOT
EXISTS` statements. It is idempotent, safe to run from concurrent gateway
processes, and runs under PGlite. Future schema changes are appended to the same
function as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` plus backfill plus `SET NOT
NULL`, exactly as `chat/database.ts` does. There is no migrations table. The
#2078 lock key `219784012` is never used.

Exact inventory after bootstrap: tables `brain_document_refs`,
`brain_document_revisions`, `brain_documents`, `brain_sources`,
`brain_sync_cursors`, `brain_sync_receipts`; indexes `brain_sources_live_ref`,
`brain_documents_search`, `brain_documents_source`, `brain_sync_receipts_started`,
`brain_document_refs_lookup` plus the six `*_pkey`.

## Store semantics

Every repository method parses `scope` with `BrainScopeKeySchema` and its input
with the matching schema before touching the database. Every write method runs
inside one transaction that sets the deadlines and takes the scope lock first.

### Sources

- `createSource`: `INSERT ... ON CONFLICT (owner_id, scope_id, kind, external_ref)
  WHERE deleted_at IS NULL DO NOTHING RETURNING *`. No row returned means the live
  row is selected by the same key and returned with `created: false`. Idempotent.
  Label differences are not applied on the duplicate path. Revision 1, status
  defaults to `active`.
- `updateSource`: `UPDATE ... SET label/status, revision = expected + 1,
  updated_at WHERE key AND revision = expected AND deleted_at IS NULL RETURNING *`.
  No row: select without the revision predicate; missing or tombstoned gives
  `not_found`, otherwise `conflict`. An input with neither `label` nor `status`
  is `invalid`.
- `deleteSource`, one transaction under the scope lock: the same CAS UPDATE sets
  `deleted_at = now`, `updated_at = now` and `revision + 1`; then every revision
  snapshot the source contributed is deleted (`WHERE key AND (source_id = ? OR
  document_id IN (documents of this source))`, so content from an earlier
  incarnation of a document id that another source later revived is purged too.
  Manual snapshots (`source_id IS NULL`) and other sources' snapshots survive
  only when their document id is not currently owned (live or tombstoned) by the
  deleted source; a prior-incarnation snapshot of an id the deleted source now
  owns is purged with it); then the refs of its documents are deleted; then its
  live documents are tombstoned in one
  statement (`title = '', body = '', permalink = '', byte_count = 0, revision =
  revision + 1, updated_at = now, deleted_at = now WHERE key AND source_id = ? AND
  deleted_at IS NULL`) with no history snapshot, because the user removed the
  source and its content must not linger; then a `running` receipt of the source,
  if any, is closed as `interrupted` with `finished_at = now` (no later
  `openSyncReceipt` can do it for a tombstoned source); then its cursor row is
  deleted. Receipts (metadata only) are kept. A second delete gives `not_found`.
- `getSource` returns `null` for missing or tombstoned. `listSources` excludes
  tombstones and pages by keyset on `source_id`.

