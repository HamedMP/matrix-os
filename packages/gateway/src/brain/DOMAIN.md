# Company Brain Store

The durable store behind the Company Brain: what an organisation or a person published or synced into their brain,
with revisions, tombstones, sync cursors and sync receipts.

## Scope

- Owns nine `brain_*` tables (`brain_sources`, `brain_documents`, `brain_document_revisions`, `brain_document_refs`,
  `brain_sync_cursors`, `brain_sync_receipts`, and `brain_claims`, `brain_extraction_state`, `brain_extraction_runs`
  from `claims/database.ts`) and `BrainRepository`, their only reader and writer.
- Deferred: organization scopes and scheduled source sync. Never: authorization (the caller resolves the scope),
  `onboarding/company-brain-readiness.ts` (unrelated) and PR #2078's `company_brain_*` tables in `company-brain/`.
- Name clash: `company-brain/`'s `BrainSourceIdSchema` (`^[a-f0-9]{64}$`) is this store's `BrainDocumentIdSchema`, and
  its `BrainCitation` and `BrainEvidenceProof` mean other things. Import from one folder per module, aliasing if needed.

## Source Of Truth

- Owner Postgres, tables prefixed `brain_`; every row carries `(owner_id, scope_id)`, which starts every primary key.
- Derived and bounded: the GIN full-text index, revision snapshots (10 per document id), receipts (50 per source) and
  claims (50 per document and extractor, 50,000 per scope).
- No in-memory registry, cache or file state; the git adapter and the claims job keep only capped in-process sets of
  running keys (`GIT_MAX_CONCURRENT_SYNCS`, `BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS`), cleared in `finally`.

## Public API

- `index.ts` exports `BrainRepository`, `bootstrapBrainDatabase`, `computeBrainContentHash`, the types and constants
  of `types.ts`, and the Zod schemas plus `parseBrainInput` of `schemas.ts`; other domains never import the internals.
- `listDocumentRefs(scope, documentId)` returns a live document's refs (at most `BRAIN_DOCUMENT_REFS_MAX`); only
  `applySyncBatch` upserts write refs.

## Auth And Trust Boundaries

- The caller authorizes the `BrainScopeKey` (`requireRequestPrincipal` or the collaboration authority); the repository
  never authorizes and never takes a bare id without a scope key.
- A row outside the caller's `(owner_id, scope_id)` is invisible: reads return `null` or empty pages, writes throw
  `not_found`. Exceptions, which never say which part failed: `assertCurrent` throws `forbidden` for a proof that does
  not match a live row; `applyDocumentExtraction` throws `conflict` for a run that is not the scope's running run and
  returns `applied: false` for an unseen document.
- Every input passes a strict, bounded Zod schema before any SQL; SQL CHECK constraints mirror the limits.
- Errors are `BrainStoreError` codes (`invalid`, `not_found`, `conflict`, `capacity`, `forbidden`) with one fixed
  message, Zod issues in the `cause`. Postgres errors propagate unchanged; routes map them to a generic 503.

## Concurrency And Recovery

- Every write is one transaction (`lock_timeout = 5s`, `statement_timeout = 15s`) holding `pg_advisory_xact_lock` on
  the owner and `brain:<scopeId>`; capacity counts, CAS, cursor advance, receipt pruning and erase run under it, and
  the clock is read after the lock, so timestamps are monotonic within a scope. Reads do not lock.
- Optimistic concurrency is in the write predicate (`revision`, `cursor`, `status = 'running'`); a miss is `conflict`.
  A sync batch, its refs and its cursor advance commit together.
- A crashed run's `running` receipt is closed `interrupted` by the source's next `openSyncReceipt` or `deleteSource`,
  which purges snapshots by `source_id` and current ownership, so a removed source's content never survives.
- Retained history is bounded by count: tombstones, snapshots, receipts and extraction runs (50 per scope, plus up to
  1,000 billed runs of the last 30 days). `eraseScope` removes everything of a scope except those billed runs, which
  move to the owner's retired-runs scope id (counts and usage only) so the spend cap still counts them.
- Bootstrap is idempotent (`CREATE ... IF NOT EXISTS`) under a schema-wide advisory lock.

## Tests

`tests/gateway/brain-store*.test.ts` (PGlite); `brain-store-postgres.test.ts` needs `MATRIX_TEST_POSTGRES_URL`.

## Git source adapter (`git/`)

Spec 552. `git/index.ts` exports `syncGitSource`, `defaultGitRunner`, `openGitRepository`, the web-base helpers and
`git/types.ts`. It reads the default branch's history, read-only, and writes only through `BrainRepository`.

- One document per first-parent commit (or pull request) and per spec file part, with ids that are never of content.
  Only a window's final batch moves the cursor, so a crash replays it as no-ops; a force-push triggers a rescan.
- `openGitRepository` refuses anything not strictly inside `realpath(homePath)`; git runs via execFile with an argv
  array, a fresh environment (`GIT_ALLOW_PROTOCOL=none`), a timeout and a maxBuffer, never the network or `HEAD`.
  Errors are stable codes in `GitSyncResult`. Tests: `tests/gateway/brain-git-*.test.ts`.

## Project API and brain_why (`why.ts`, `api/`, spec 553)

- Scope recipe: a project of the request principal is `brainProjectScope(ownerId, projectId)`
  (`personal:project:<projectId>`); missing, foreign and malformed projects are the same `project_not_found`.
- `api/service.ts`: one bounded `syncGitSource` run per sync request (a failed run with a receipt is a 200), receipts
  and read-only `why`. A lock or statement deadline defers the brain and any other core failure leaves it off (routes
  503, no agent tool), so the brain never takes down owner startup.
- `api/routes.ts` mounts `/api/brain/projects/:projectId/{git-source,sync,receipts,why,extract,claims}`;
  `api/agent-tools.ts` binds `brain_why` to one owner; `why.ts` reads `listDocumentsByRef` newest first.
- Tests: `brain-why`, `brain-api-*` and `brain-agent-tools`, and `tests/kernel/brain-why-tool.test.ts`.

## Claims (`claims/`)

Spec 554; `claims/types.ts` is the contract. Spans are UTF-16 units into the stored body, and
`body.slice(spanStart, spanEnd) === quote` is rechecked on every write.

- `applyDocumentExtraction` replaces one (document, extractor) set under the scope lock, fenced by the scope's running
  run (5-minute lease, then `interrupted`), and saves the run's cost so far (never lowered). Claims of an older
  revision read as stale; `applyDelete`, `deleteSource` and `eraseScope` remove claims and state in their transactions.
- Rules versions: raise `BRAIN_RULES_VERSION` whenever `rules.ts` decides differently; every live document is then
  pending again, and an applied outcome first removes other rules versions' claims (so `claims_changed` fires). Model
  claims are never touched; the claim id leaves out the extractor.
- One claim per quote span, by `BRAIN_CLAIM_KIND_PRECEDENCE`; open questions are never claims. Tests: `brain-claims-*`.

## Model claims (`claims/model/`)

Spec 555; `claims/model/types.ts` is the contract and never imports the SDK, so `job.ts` and `claims/index.ts` never
load `@anthropic-ai/sdk`.

- `client.ts` makes one structured-output call per document; `config.ts` is imported only by `api/service.ts`, which
  supplies it as `claimModels` (without it: 409).
- Credentials, read per request and never cached, logged or stored: the owner's `kernel.anthropicApiKey` in
  `system/config.json`, else a direct `ANTHROPIC_API_KEY` without `ANTHROPIC_BASE_URL`, else 409; OAuth tokens, proxy
  keys and Matrix-funded leases are refused. Only the owner's principals (`modelOwnerIds`) may use the key.
- Spend cap (`claims/spend.ts`): per owner over 30 days across all scopes, default 5 USD; one model run per owner at a
  time in a process; each call is checked against its worst case and a run that cannot afford it stops
  `spend_cap_reached`. A call that timed out or was aborted after it was sent is charged at its worst case.
- Data leaving the gateway: per document its title and footer-stripped body, plus the fixed prompt and schema, to
  `api.anthropic.com` only (redirects refused), on an explicit model extract, only for `BRAIN_MODEL_PROVENANCES`.
- Prompts and responses are never stored. Tests: `brain-claims-model-*` and `brain-claims-spend` (fake `fetch`).

## Features and wiring

Feature folders read core tables with plain SELECTs through `repository.kysely` and never write, alter, index or
trigger them. Each owns tables with its own prefix (`BRAIN_TABLE_PREFIXES`), created by one idempotent bootstrap, and
takes its own scope lock, never `brain:<scopeId>`. `contracts.ts` (with `contracts/`) is the shared contract; each
folder's `DOMAIN.md` has the details.

- Search (`search/`, spec 556): full text; meaning search only on the owner's opt-in (`brain.embeddings`) and scopes.
- Graph (`graph/`, spec 557): entities, links, person aliases and timelines; listener `graph`.
- Sources (`sources/`, specs 558 to 560 and 565): kind handlers for GitHub (`github/`, `integration/`), Matrix notes,
  files and chats (`matrix/`; notes and files read the gateway's Notes and home for its owner principals only) and
  Linear, Google Drive, Google Calendar and the Slack bridge (`connectors/`); `core/` holds the `/sources` service and
  routes, the kind registry, the shared runner and the table bootstrap. The integration seams
  (`integration/late-bound.ts`) are bound once platform integrations exist; until then integration kinds read
  `not_configured`, and with no account of the service `not_connected`.
- Brief (`brief/`, spec 561): daily brief, conflicts and stale data; four routes; listener `brief` and the daily job.
- Background runs (`jobs/`, spec 566): `brain_jobs` queues sync, extract, refresh and brief runs, deduped per (scope,
  kind, target), with leases, heartbeats, recovery and cancel; four `/jobs` routes (`POST` is 202), one worker per
  gateway for its owner; `job_kind_unavailable` (also with the jobs off) makes clients run the work directly. A paid
  run (model extract) is never queued again after a restart or a lost lease.
- Impact (`impact/`, spec 564): what a branch changes and what the brain knows about it.
- Agent tools (`agent/`, spec 562): the adapter behind the kernel's read-only `brain_search`, `brain_timeline`,
  `brain_claims`, `brain_brief`, `brain_conflicts` and `brain_impact`. The dispatcher hands them and `brain_why`,
  bound to that caller, only to a run whose server-set `callerId` is an owner principal (the owner's shell, personal
  canonical Chat and `/api/message` runs); collaborators', shared or organization chats', channels' and background
  runs get none. The app is `packages/ui/src/brain/` (spec 563).
- Wiring: `api/project-resolver.ts` (the one project lookup); `hooks.ts` (the change bus: per-scope queues capped at
  `BRAIN_HOOK_QUEUE_MAX_SCOPES`, coalesced, drained with a deadline on close); `api/start.ts` (`startBrainServices`,
  whose header gives the start order, what a failed start leaves off, the jobs and the change events;
  `stopBrainServices` stops the worker, the other jobs, then drains the hooks); `api/erase.ts` (`eraseBrainProject`
  and `createBrainProjectCleanup`, which throws while the owner database is down, so the deletion is retried);
  `api/index-repair.ts` (the index catch-up after start and the purge of a removed source's derived rows); and
  `api/feature-routes.ts` (every router under `/api/brain`, 503 while the brain or its feature is off). The gateway
  seams live in `server/brain-wiring.ts`; `server.ts` only calls them.
- Tests: `brain-hooks`, `brain-start`, `brain-start-repair`, `brain-wiring` and `brain-cite` under `tests/gateway/`.
