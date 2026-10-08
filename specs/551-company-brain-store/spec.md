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

### Documents

Tombstone shape: `deleted_at` set; `title`, `body`, `permalink` empty;
`byte_count = 0`; `content_hash = sha256 of ["",""]`; `revision = N + 1`;
`incarnation`, `source_id`, `provenance`, `published_at`, `source_updated_at`
retained. Tombstones count toward `maxDocumentsPerScope` and contribute 0 bytes to
`maxBytesPerScope`. They are excluded from `getDocument`, `listDocuments`,
`searchDocuments`, `assertCurrent`, and the GIN index. Only `eraseScope` removes
them.

`upsertDocument`, one transaction under the scope lock:

1. If `sourceId` is non-null, the source must exist live in this scope, else
   `not_found`.
2. Load the row (tombstone included) by primary key `FOR UPDATE`.
3. `expectedRevision`: `0` requires no live row (a tombstone passes); `N` requires
   a live row at revision N; omitted means unconditional. Failure gives `conflict`.
4. A live row whose `source_id` differs from the input gives `conflict`. A live
   document's source never changes; delete then recreate moves it.
5. A live row with equal `content_hash` and equal `permalink` returns
   `{ outcome: "unchanged" }` with no write; revision, `source_updated_at` and
   `provenance` stay as they were; a differing `provenance` or `sourceUpdatedAt`
   alone does not count as a change.
6. Capacity, counted under the lock with one `SELECT count(*), coalesce(sum(byte_count), 0)`
   over the scope: a new row when `count >= maxDocumentsPerScope` gives
   `capacity`; `bytes - (live ? old.byte_count : 0) + newBytes > maxBytesPerScope`
   gives `capacity`.
7. Live row: insert a snapshot of the old state into `brain_document_revisions`
   (`change = 'updated'`, `revision = old.revision`), prune that document's
   snapshots to the newest 10 (`ORDER BY superseded_at DESC, revision DESC OFFSET
   10`), then `UPDATE ... SET content fields, revision = old + 1 WHERE PK AND
   revision = old.revision AND deleted_at IS NULL RETURNING *`; no row gives
   `conflict`. Outcome `updated`.
8. Tombstone: `UPDATE` the same row back to live with a fresh `incarnation`,
   `revision = 1`, `published_at = now`, `deleted_at = NULL`, the new `source_id`,
   `WHERE PK AND deleted_at IS NOT NULL RETURNING *`; no row gives `conflict`
   (unreachable after the `FOR UPDATE`). Prior-incarnation snapshots stay in
   history until pruned by count. Outcome `created`.
9. Absent: `INSERT ... ON CONFLICT (owner_id, scope_id, document_id) DO NOTHING
   RETURNING *`; no row gives `conflict` (unreachable after the `FOR UPDATE`, but
   the predicate stays). Outcome `created`.

`reviseDocument`: partial patch with mandatory CAS on a live row only
(`not_found` otherwise). The patch is merged over the stored row, the combined
byte limit is re-checked (`invalid` on breach), capacity is checked as in step 6,
then the same snapshot, prune, and CAS UPDATE as step 7. Equal content still bumps
the revision: an explicit edit is a change. A patch with no fields is `invalid`.

`deleteDocument`: live row only, else `not_found`; `expectedRevision` mismatch
gives `conflict`; snapshot the live state (`change = 'deleted'`, `revision =
old.revision`), prune, then `UPDATE ... SET tombstone fields, revision = old + 1
WHERE PK AND revision = old.revision AND deleted_at IS NULL RETURNING *`; no row
gives `conflict`; the document's refs are deleted in the same transaction.
Returns the tombstone (`deletedAt` set, `body` empty).

Reads: `getDocument` returns `null` for missing or tombstoned. `listDocuments`
returns summaries (no `body`), keyset on `document_id`, optional `sourceId`
filter, fetches `limit + 1` to compute `nextCursor`. `searchDocuments` returns
summaries matching `to_tsvector('simple', title || ' ' || body) @@
plainto_tsquery('simple', query)`, ordered `updated_at DESC, document_id`, limit
<= 50, no ranking. `listRevisions` returns at most 10 snapshots newest first
(`superseded_at DESC, revision DESC`), bodies included. `listDocumentRefs(scope,
documentId)` returns at most 200 refs ordered by `kind`, then `value`; lookup by
value is deferred (spec 552).

`assertCurrent(scope, proofs)`: empty proofs return. Otherwise one `SELECT
document_id, incarnation, revision FROM brain_documents WHERE key AND document_id
IN (...) AND deleted_at IS NULL`; every proof must match a returned triple
exactly. Any missing, tombstoned, re-incarnated, or revised document gives
`forbidden`. Duplicate proofs are allowed. This mirrors #2078 `verifyEvidence`
(exact `(id, incarnation, revision)` match against live rows, duplicates
allowed) so the later bridge keeps its contract; the per-call proof bound differs
(100 here, 6 in #2078), and the bridge applies the stricter one.

### Sync cursors

One row per source. `cursor` is opaque text 1..2048 chars; `updated_at` is the
repository clock at the last advance. `getSyncCursor` returns `null` when no row
exists. The only writer is `applySyncBatch`, so the cursor can never run ahead of
or behind the documents it describes.

### `applySyncBatch`, one transaction under the scope lock

1. The source must exist live with `status = 'active'`: missing or tombstoned
   gives `not_found`; `paused` or `disabled` gives `conflict`.
2. Capacity totals are loaded once, then tracked per item.
3. Each upsert runs upsert steps 2 and 4-9 with `sourceId = batch.sourceId` and no
   `expectedRevision`. A live row owned by another source, or by manual
   publication (`source_id IS NULL`), is skipped and its id appended to
   `rejected`; nothing about it changes. `created`, `updated`, and `unchanged`
   are counted. Each upsert carries its complete ref set (omitted means none);
   for every upsert that is not rejected the stored set is compared first and
   replaced wholesale only when it differs. A refs-only change still counts as
   `unchanged` at the same revision. `applySyncBatch` is the only writer of refs.
4. Each deletion runs `deleteDocument` semantics without CAS, only when the live
   row's `source_id` equals the batch source. A missing, tombstoned, or
   foreign-source id is silently skipped so replays are idempotent. `deleted`
   counts rows tombstoned; a tombstoned document's refs are deleted with it.
5. Cursor CAS in the write predicate: `expectedCursor === null` means
   `INSERT ... ON CONFLICT (owner_id, scope_id, source_id) DO NOTHING RETURNING *`;
   a string means `UPDATE ... SET cursor = next, updated_at WHERE key AND cursor =
   expected RETURNING *`. No row gives `conflict` and the whole batch rolls back.
6. `nextCursor === expectedCursor` is allowed: a batch that found nothing new
   still refreshes `updated_at`.
7. Capacity exceeded anywhere gives `capacity` and the whole batch rolls back.
   Validation failure of any item gives `invalid` and nothing is written. The
   repository never reports `failed` counts; provider-side failures belong to the
   adapter and go in the receipt.

### Sync receipts

- `openSyncReceipt`, under the scope lock: the source must be live and `active`
  (`not_found` / `conflict`). First `UPDATE ... SET status = 'interrupted',
  finished_at = now WHERE key AND source_id = ? AND status = 'running'`, so a
  crashed previous run is closed by the next one and `running` never lingers.
  Then insert `{ receipt_id, status: 'running', cursor_before: current cursor or
  null, started_at: now }`. Then prune non-running rows beyond the newest 49 so at
  most 50 remain including the new one.
- `closeSyncReceipt`: load by primary key; missing gives `not_found`; `status !==
  'running'` gives `conflict`; `UPDATE ... SET status, counts, next_action,
  error_code, cursor_after = current cursor or null, finished_at = now WHERE PK AND
  status = 'running' RETURNING *`; no row gives `conflict`.
- A receipt closes to `succeeded` (no failures), `partial` (finished with
  `failed > 0`), or `failed` (aborted; `errorCode` expected). These are
  conventions for the adapter; the store does not cross-check `status` against
  `counts.failed` or `errorCode`. `errorCode` matches `^[a-z][a-z0-9_]{0,63}$`
  and `nextAction` matches `^([a-z][a-z0-9_]*)?$`, so a raw provider message is
  rejected as `invalid` before any SQL runs.
- `listSyncReceipts(scope, sourceId, { limit? })` returns up to `limit` (int
  1..50, default 50) receipts ordered `started_at DESC, receipt_id DESC`.

### `eraseScope`

One transaction under the scope lock: `DELETE` from `brain_document_refs`,
`brain_document_revisions`, `brain_documents`, `brain_sync_receipts`,
`brain_sync_cursors`, `brain_sources`, in that order, each `WHERE owner_id = ?
AND scope_id = ?`. The cascades would cover cursors and receipts; explicit
deletes keep the order obvious. Physical delete; frees capacity; a later create
yields new incarnations. Returns `void`.

## Error policy

`BrainStoreError` has `code`, `name = "BrainStoreError"`, the fixed message
`"Brain store request failed"`, and an optional `cause` kept for server-side logs.

| code | when |
| --- | --- |
| `invalid` | Zod rejection of any input; a revise result over the byte cap |
| `not_found` | target row absent, tombstoned, or outside the caller's scope |
| `conflict` | CAS mismatch (revision, cursor); source not active; live document owned by another source; receipt not running |
| `capacity` | document count or byte cap for the scope |
| `forbidden` | `assertCurrent` proof mismatch (the only use in PR 1) |

Postgres errors, including lock timeout `55P03` and statement timeout `57014`,
propagate unchanged; the repository never wraps them. Zod issues never leave the
module. PR 2 maps codes to HTTP 400 / 404 / 409 / 429 / 403 and everything else
to 503 with a generic body.

## Security architecture

### Auth matrix

This PR exposes no route, WebSocket, webhook, IPC tool, or file I/O. The trust
boundary is the `BrainRepository` method call. Every method takes a
`BrainScopeKey` that the caller has already resolved and authorized; the
repository binds every statement to that key and never widens it.

| Entry point | Authentication / authorization | Scope enforcement | Errors |
| --- | --- | --- | --- |
| HTTP routes | none in this PR (PR 2 adds routes behind `requireRequestPrincipal` and, for organization scopes, fresh spec 124 membership, role, and authority checks) | n/a | n/a |
| `createSource`, `updateSource`, `deleteSource`, `getSource`, `listSources` | caller-resolved `BrainScopeKey`; repository trusts it | `(owner_id, scope_id)` in every predicate; live-ref uniqueness per scope | `invalid`, `not_found`, `conflict` |
| `upsertDocument`, `reviseDocument`, `deleteDocument` | same | same; source must be live in the same scope | `invalid`, `not_found`, `conflict`, `capacity` |
| `getDocument`, `listDocuments`, `searchDocuments`, `listRevisions`, `listDocumentRefs` | same | same; tombstones excluded | `invalid` |
| `assertCurrent` | same | same; live rows only | `invalid`, `forbidden` |
| `applySyncBatch` | same | same; source must be live and `active` | `invalid`, `not_found`, `conflict`, `capacity` |
| `getSyncCursor` | same | same | `invalid` |
| `openSyncReceipt`, `closeSyncReceipt`, `listSyncReceipts` | same | same | `invalid`, `not_found`, `conflict` (`listSyncReceipts`: `invalid` only) |
| `eraseScope` | same; PR 2 restricts it to the scope owner | same | `invalid` |
| `bootstrap`, `destroy` | startup code only | n/a | Postgres errors propagate |

Spec 124's rule that admins have no content privilege holds by construction: the
store cannot grant what the key does not name.

### Input validation plan

- Every public method parses its scope and input with a `.strict()` Zod schema
  from `schemas.ts` (`import { z } from "zod/v4"`) before any database call.
  Every free-text string has `.max()` or a regex/format that bounds its length;
  `body` is bounded by the combined title + body byte refine rather than
  `.max()`; every array has `.max()`; every number is `.int()`. Schemas import
  the `BRAIN_*` constants rather than retyping numbers.
- Document content: title `.trim().min(1).max(300)`; body `.min(1)`; permalink
  `.max(2048)` and either `""` or an `https` URL with no username or password in
  canonical form (`new URL(value).href === value`, so surrounding whitespace, raw
  control characters, an uppercase scheme, or an un-normalized host are rejected
  rather than stored verbatim and echoed back in citations);
  `sourceUpdatedAt` is `z.iso.datetime({ offset: true })`; `provenance` matches
  the kind regex; a `.refine` rejects combined utf8 bytes of title + body over
  `BRAIN_DOCUMENT_MAX_BYTES`. `reviseDocument` repeats the byte check after merging
  with the stored row.
- Upsert adds `sourceId: BrainSourceIdSchema.nullable()` and `expectedRevision:
  int 0..BRAIN_MAX_REVISION` optional. Sync batch: upserts and deletions each
  `.max(200)`, document ids unique within each array (an id may appear in both
  arrays; it is upserted, then tombstoned, in that order), `expectedCursor`
  1..2048 nullable, `nextCursor` 1..2048. Receipt close: counts
  `int 0..1000000000`, `nextAction .max(500)` matching `^([a-z][a-z0-9_]*)?$`,
  `errorCode` regex nullable. List: limit `int 1..100` default 50, cursor
  `.max(256)` nullable. Receipt list: limit `int 1..50` default 50. Search: query
  `.trim().min(1).max(500)`, limit `int 1..50` default 10. Evidence proofs
  `.max(100)`, incarnation `z.uuid()`, revision `int 1..MAX`.
- SQL CHECK constraints mirror the same limits so a bypassed or future caller
  cannot store an oversize or malformed row.
- Every free-text string (`scopeId`, `ownerId`, title, body, permalink, source
  label and `externalRef`, sync cursors, list cursors, the search query) refuses
  U+0000, because Postgres rejects it with driver error `22021`, which is not a
  `BrainStoreError`; a NUL anywhere in a sync batch therefore surfaces as
  `invalid` with nothing written. Regex-bound fields exclude it already.
- `parseBrainInput(schema, value)` runs `safeParse` and throws
  `BrainStoreError("invalid", { cause })`.
- Search input reaches SQL only as a bound parameter to `plainto_tsquery`; no
  identifier or fragment is built from user text.

### Error response policy

Clients (PR 2) see only the `BrainStoreError` code and the fixed message. Zod
issues, column names, constraint names, and Postgres messages stay in server logs.
Unknown errors become a generic 503. `next_action` and `error_code` are bounded,
regex-checked values so a raw provider error cannot be persisted or echoed.

### Credential handling

The store holds no secrets. The repository receives a `Kysely` instance (shared
owner pool) or a `Dialect`; the connection string comes from the existing
owner-database startup via environment, never from this module. `external_ref`
is an identifier, not a token. `cursor` is an opaque provider position; adapters
(PR 3) must not place tokens in it. No value from these tables is ever written to
a URL or log line by this module.

## Integration wiring

Nothing is wired in this PR. `index.ts` exports `BrainRepository`,
`bootstrapBrainDatabase`, `computeBrainContentHash`, the schemas, and the types;
no production code imports it yet.

Planned startup sequence (PR 2, `packages/gateway/src/startup/owner-database.ts`):
add `brainRepository: BrainRepository | null` to `OwnerDatabaseServices` after
`messagingRepository`, initialize it to `null` in the services literal, and after
`await messagingRepository.bootstrap();` run

```ts
const brainRepository = new BrainRepository(kysely as Kysely<any>);
services.brainRepository = brainRepository;
await brainRepository.bootstrap();
```

The assignment happens before the awaited bootstrap so
`teardownOwnerDatabaseServices` can release on partial failure. No shutdown or
fallback entry is added: the repository is built on the shared `kysely`, does not
own the pool, and `appDb.destroy()` closes it. `server.ts` destructures
`ownerDatabaseServices?.brainRepository ?? null` only once a consumer exists.
#2078 does not touch `owner-database.ts`, so this PR and PR 2's
`owner-database.ts` change will not conflict with it. #2078 does change
`packages/gateway/src/server.ts` and adds
`startup/bots.ts`, `startup/company-bot-runtime.ts`, and
`startup/scope-runtime-host.ts`, and it is stacked on `codex/slack-company-pi`
(#2077); PR 2's one-line `server.ts` destructure is rebased over whichever lands
first.

Cross-package communication: none. The repository is injected where needed; no
`globalThis`, no IPC. `BrainRepository.kysely` is a public readonly handle to the
underlying `Kysely<BrainDatabase>` (used by tests to inspect rows); PR 2 callers
must not use it to bypass the scoped methods. Config injection:
`BrainRepositoryOptions { now, maxDocumentsPerScope, maxBytesPerScope }`;
defaults 10000 documents and 256 MiB per scope. Both are floored and clamped to a
minimum of 1, documents to a ceiling of 100000 and bytes to
`Number.MAX_SAFE_INTEGER` (no product ceiling, so a caller may raise it above the
default); a non-finite value falls back to the default. No environment variables
are read by this module.

## Failure modes

- Timeouts: every repository transaction sets `lock_timeout = '5s'` and
  `statement_timeout = '15s'`; bootstrap sets `lock_timeout = '5s'` and
  `statement_timeout = '30s'`. Both are `SET LOCAL`, so they never leak to the
  shared pool. The module makes no `fetch()` and no network call inside or
  outside a transaction, so no `AbortSignal` is needed here; adapters (PR 3) own
  their provider deadlines.
- Concurrent access: writes to one scope are serialized by the advisory
  transaction lock, so capacity checks cannot race (no TOCTOU). Optimistic
  concurrency is enforced in the write statement itself (`WHERE revision =
  expected`, `WHERE cursor = expected`, `WHERE status = 'running'`, `WHERE
  deleted_at IS NULL`), not only by a pre-read. Creates use `ON CONFLICT`. Two
  concurrent `applySyncBatch` calls on one scope: the second waits, then finds
  the cursor advanced and fails with `conflict`, writing nothing. PGlite is
  single-connection, so these cases run on a real server in
  `tests/gateway/brain-store-postgres.test.ts`. Different scopes never block each
  other. Readers never take the lock.
- Lock contention: a writer that waits more than 5s gets `55P03`, which
  propagates; nothing was written. A statement over 15s gets `57014`; the
  transaction rolls back.
- Crash recovery: every multi-row write (source delete with its document
  tombstones, cursor advance with its batch, snapshot plus prune plus update,
  receipt open with the `interrupted` close of a predecessor) is one transaction,
  so a crash leaves either the old state or the new state. A sync process that
  dies after `openSyncReceipt` leaves one `running` row; the next
  `openSyncReceipt` for that source, or `deleteSource`, closes it as
  `interrupted` with `finished_at` set, so `running` never lingers on a live or a
  tombstoned source. Bootstrap is idempotent and lock-serialized, so a crash during first boot
  is repaired by the next boot. There is no file I/O, so no temp-file or rename
  concern. `destroy()` only destroys a Kysely the repository created from a
  `Dialect`; a shared instance is never closed here.
- Error propagation: all errors reach the caller. The repository has no `catch`
  that returns a fallback and no fire-and-forget promise. Postgres errors are not
  converted into `not_found` or any other `BrainStoreError`.
- Partial batch: validation failure of any item means nothing is written; a
  capacity breach or cursor conflict at any point rolls the whole batch back.
  Partial progress is never persisted.
- Shutdown: no timers, subscribers, or in-memory registries exist, so there is
  nothing to drain. The shared pool is closed by its owner.

