# Company Brain Store

The durable store behind the Company Brain: what an organisation or a person has published or synced into their brain,
with revisions, tombstones, sync cursors and sync receipts.

## Scope

- Owns the nine `brain_*` tables (`brain_sources`, `brain_documents`, `brain_document_revisions`,
  `brain_document_refs`, `brain_sync_cursors`, `brain_sync_receipts`, plus `brain_claims`, `brain_extraction_state`
  and `brain_extraction_runs` from `claims/database.ts`) and `BrainRepository`, the only reader and writer of those
  tables.
- Out of scope, deferred to later PRs in the stack: organization scopes and scheduled source sync. The git adapter
  lives in `git/`; the project routes, the `brain_why` agent tool and startup wiring live in `why.ts` and `api/`;
  claim extraction lives in `claims/`; each feature folder has its own `DOMAIN.md` (all below).
- Out of scope permanently: authorization (the caller resolves the scope), `onboarding/company-brain-readiness.ts` (an
  unrelated in-memory readiness service), and PR #2078's `company_brain_*` tables under `company-brain/`.
- Name clash to keep in mind: `company-brain/` exports `BrainSourceIdSchema`, `BrainCitation` and `BrainEvidenceProof`
  under the same names with opposite meanings. Its `BrainSourceIdSchema` (`^[a-f0-9]{64}$`) and `sourceId` fields
  correspond to this store's `document_id` / `BrainDocumentIdSchema`; this store's `BrainSourceIdSchema`
  (`^src_[a-f0-9]{32}$`) names a connected source and has no counterpart there. Import from one folder per module and
  alias on import if both are needed.

## Source Of Truth

- Owner Postgres, tables prefixed `brain_`. Every row carries `(owner_id, scope_id)` and every primary key starts with
  that pair.
- The GIN full-text index, the per-document revision snapshots and the claims are derived and bounded (10 snapshots
  per document id, 50 receipts per source, 50 claims per document and extractor, 50,000 claims per scope).
- The store keeps no in-memory registry, cache, or file state; the git adapter and the claims job keep only capped
  (`GIT_MAX_CONCURRENT_SYNCS`, `BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS`) in-process sets of running keys, cleared in
  `finally`.

## Public API

- `index.ts` exports `BrainRepository`, `bootstrapBrainDatabase`, `computeBrainContentHash`, every type and constant
  in `types.ts`, and the Zod schemas plus `parseBrainInput` from `schemas.ts`.
- `BrainRepository.listDocumentRefs(scope, documentId)` returns a live document's refs (at most
  `BRAIN_DOCUMENT_REFS_MAX`, ordered by kind then value); refs are written only through `applySyncBatch` upserts.
- The internals (`documents.ts`, `document-reads.ts`, `document-refs.ts`, `sources.ts`, `sync.ts`, `mappers.ts`,
  `schemas.ts`) are not imported by other domains; they are reached through the repository.

## Auth And Trust Boundaries

- The caller authorizes the `BrainScopeKey` (via `requireRequestPrincipal` or the collaboration authority) before
  calling the repository; the repository never authorizes and never takes a bare id without a scope key.
- A row outside the caller's `(owner_id, scope_id)` is invisible: reads return `null` or empty pages, writes throw
  `not_found`. Exceptions, which never say which part failed: `assertCurrent` throws `forbidden` when a proof does not
  match a live row; `applyDocumentExtraction` throws `conflict` for a run that is not the scope's running run and
  returns `applied: false` for an unseen document.
- Every input is parsed by a strict, bounded Zod schema before any SQL runs; SQL CHECK constraints mirror the same
  limits.
- Errors are `BrainStoreError` codes (`invalid`, `not_found`, `conflict`, `capacity`, `forbidden`) with one fixed
  message. Zod issues stay in the `cause`. Postgres errors propagate unchanged for the route layer to map to a generic
  503; they are never exposed to clients.

## Concurrency And Recovery

- Every write is one transaction that sets `lock_timeout = 5s` and `statement_timeout = 15s`, then takes
  `pg_advisory_xact_lock` keyed on the owner and `brain:<scopeId>`. Capacity counting, CAS, cursor advance, receipt
  pruning and erase all run under that lock. Reads do not lock.
- The repository clock is read only after the lock is held, so a writer that waited on the lock never commits an older
  timestamp than the writer that released it: `updated_at`, `superseded_at`, `started_at` and `finished_at` are
  monotonic within a scope, which the snapshot and receipt prunes and the newest-first listings rely on.
- Optimistic concurrency lives in the write predicate: `revision = expected` on sources and documents, `cursor =
  expected` on sync cursors, and `status = 'running'` on receipts. A miss is `conflict`.
- A sync batch and its cursor advance commit together, so the cursor can never run ahead of or behind the documents it
  describes.
- A `running` receipt left by a crashed run is closed as `interrupted` by the next `openSyncReceipt` for that source,
  or by `deleteSource` when the source is removed (nothing can open another receipt for a tombstoned source), so
  `running` never lingers.
- Revision snapshots record the `source_id` that owned the document when they were taken. `deleteSource` purges by
  that column as well as by current ownership, so a removed source's content does not survive in the history of a
  document id that another source later revived. Snapshots with another `source_id`, or none, survive a source delete
  only when their document id is not owned, live or tombstoned, by the deleted source.
- Refs (`brain_document_refs`) are an index over live synced documents. `applySyncBatch` is their only writer: each
  upsert carries its complete ref set (omitted means none), the stored set is compared first and replaced only when it
  differs, in the batch transaction. Every tombstone path (`applyDelete`, `deleteSource`) removes a document's refs
  and `eraseScope` deletes refs first, so only live documents have refs. Refs are not snapshotted into revisions.
- Orphan states: none across tables, because every multi-row write is one transaction. Tombstones, revision snapshots,
  receipts and extraction runs (50 per scope, plus at most 1,000 runs that cost anything in the last 30 days) are the
  retained history, each bounded by count; claims of an older revision stay, flagged stale, until re-extracted; claims
  and state of an older rules version stay, readable, until the current rules version writes that document; a crashed
  `running` extraction run blocks its scope until its 5-minute lease expires. `eraseScope` removes everything for a
  scope, except its billed extraction runs of the last 30 days, which move to the owner's retired-runs scope id
  (counts and usage only) so the owner's model spend cap still counts them; the next run that opens drops them once
  they leave the window.
- Bootstrap is idempotent (`CREATE ... IF NOT EXISTS`) under a schema-wide advisory lock, so concurrent gateway
  processes can start safely.

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

## Project API and brain_why (`why.ts`, `api/`)

Spec: `specs/553-company-brain-why/spec.md`.

- Scope recipe: a project of the request principal is `brainProjectScope(ownerId, projectId)`
  (`personal:project:<projectId>`); missing, foreign and malformed projects are the same `project_not_found`. One
  live git source per project scope; registration never runs git. Organization scopes wait for spec 124 work.
- `api/service.ts`: one bounded `syncGitSource` run per sync request (a failed run with a receipt is a 200), receipts,
  and read-only `why`; `startBrainProjectService` bootstraps the store (`startBrainServices` in `api/start.ts` calls
  it for `startup/owner-database.ts`). A lock or statement deadline defers the brain, and `startBrainServices` turns
  any other core failure (a missing privilege, a clashing older table) into the brain off too (routes 503, no agent
  tool, logged by error name and SQLSTATE), so the brain never takes down owner startup (chats, canvas, messaging).
- `api/routes.ts` mounts `/api/brain/projects/:projectId/{git-source,sync,receipts,why,extract,claims}`; `api/agent-tools.ts` binds
  the no-JWT owner for the kernel's read-only `brain_why` tool. `why.ts` reads `listDocumentsByRef` (a bytewise range
  on the collation-"C" refs index, newest first via `brain_documents_recent`, keyset cursor, count capped at 1,000).
- Tests: `tests/gateway/brain-why.test.ts`, `brain-api-*.test.ts`, `brain-agent-tools.test.ts`,
  `brain-wiring.test.ts`, `tests/kernel/brain-why-tool.test.ts`.

## Claims (`claims/`)

Spec: `specs/554-company-brain-claims/spec.md`; `claims/types.ts` is the contract. Spans are UTF-16 units into the
stored body, and `body.slice(spanStart, spanEnd) === quote` is rechecked on every write.

- `applyDocumentExtraction` replaces one (document, extractor) set under the scope lock, fenced by the scope's running
  run (5-minute lease, then `interrupted`); failed or skipped outcomes write state only. It also saves the run's
  cost so far (`runCostMicroUsd`, never lowered) on the run row. Claims of an older revision read as stale. `applyDelete`, `deleteSource` and `eraseScope` remove claims and state in their transactions.
- `rules.ts` (`BRAIN_RULES_EXTRACTOR_ID`, now `rules/v2`) and `verify.ts` (every model output) feed `job.ts`; the
  Claude adapter is in `claims/model/` (next section).
- Rules versions: `BRAIN_RULES_VERSION` in `types.ts` names the rules extractor `rules/v<N>`; raise it whenever
  `rules.ts` decides differently. State of another rules version never makes a document done, so every live document
  is pending again. Any applied rules outcome (done, failed or skipped) first removes the document's claims and state
  of every other rules version in the same transaction, counted in `removed` and `claimsRemoved` (so
  `claims_changed` fires), so a document never holds two rules generations and the scope cap never needs room for
  both. Until then the older claims stay readable. `listClaims` also hides another rules version's claims once the
  current version has state for the document, and a document that still has another rules version's state is
  pending, so a late write by an older gateway is cleared by the next rules run. Model claims and state are never
  touched. The claim id leaves out the extractor, so a claim the new version reads the same way keeps its id; only
  its row's `extractor` changes.
- One claim per quote: `finalizeBrainClaims` keeps one claim per quote span by `BRAIN_CLAIM_KIND_PRECEDENCE`
  (commitment, decision, risk, invariant), so a Deferred scope item that names later work is a commitment only.
  `rules.ts` keeps an item under a design-note sub-heading of a decisions section (`### Canvas Title Bars`) only
  when it has its own label or prefix or states a choice (chose, decided, instead of, rather than, must, never, will,
  a leading `Use` or `Do not`). Open decisions and questions are never claims: an `Open questions` heading,
  sub-heading, label line or bullet label opens nothing, even under Decisions or Invariants. `brain/index.ts` does not
  re-export `claims/`; `claims/store.ts` imports `documents.ts` as types only.
- Tests: `pnpm exec vitest run tests/gateway/brain-claims-*.test.ts`.

## Model claims (`claims/model/`)

Spec: `specs/555-company-brain-model-claims/spec.md`; `claims/model/types.ts` is the contract and does not import the
SDK, so `job.ts` and `claims/index.ts` never load `@anthropic-ai/sdk`.

- Files: `prompt.ts` (the fixed `claims-v2` system prompt: statements that name their subject, one claim of one kind
  per quote, fields only from the quote, a due date only as the quote writes it in `YYYY-MM-DD`; the user turn of
  title and footer-stripped body; the skip policy); `client.ts` (`createAnthropicBrainClaimModel`: one
  `client.beta.messages.create` call per document on Claude Opus 5.5 with `fallbacks: "default"`, a cached system
  block and structured output; refusals, unusable output and typed SDK errors become outcomes and `BrainModelError`
  codes); `pricing.ts` (`brainModelUsage`: tokens and micro-USD per attempt); `config.ts` (settings, the credential
  and `createBrainClaimModelProvider`).
- Wiring: `startBrainProjectService` supplies the provider as `claimModels`; without it `createBrainProjectService`
  answers `{"extractor":"model"}` with 409 `extractor_not_configured`. In the gateway only `api/service.ts` imports
  `config.ts`, and `claims/index.ts` re-exports `model/types.ts` alone.
- Credentials, read per request and never cached, logged or stored: the owner's `kernel.anthropicApiKey` in
  `system/config.json`, else a direct `ANTHROPIC_API_KEY` with no `ANTHROPIC_BASE_URL`, else 409. OAuth tokens, proxy
  keys and Matrix-funded leases are refused. Only the gateway owner's principals (`modelOwnerIds`, from
  `startBrainServices` `ownerIds`) may use the key; any other principal gets 409 and `modelSpend` null. Settings are `MATRIX_BRAIN_MODEL_*` (model id, effort, documents and cost
  per run, body byte cap, spend per 30 days); an invalid one disables the extractor and logs only its name.
- Spend cap (`claims/spend.ts`): model spend per owner, across all the owner's projects, over the last 30 days,
  default 5 USD, summed from the cost of the owner's runs in every scope (`readModelSpend`; the run prune keeps those
  runs while they are in the window, at most 1,000; a project erase moves them to `BRAIN_RETIRED_RUNS_SCOPE_ID`
  instead of deleting them). One model run per owner at a time in a process. Read once after a model run opens, then
  checked before each call against that call's worst case (every retry and fallback hop billed); a run that cannot
  afford the next call stops `spend_cap_reached` with `raise_budget`. Each document's write also saves the run's cost
  so far on its row (never lowered), so a run that crashes or is interrupted still counts. A call that timed out or
  was aborted after it was sent is charged at its worst case; only the call in flight when a run is lost goes
  uncounted. Model results
  carry `spend`, and `GET .../claims` carries the same window as `modelSpend` (null when the gateway has no valid
  model settings), so the app can show the budget before a run.
- Data leaving the gateway: per document its title and footer-stripped body, plus the fixed prompt and schema, to
  `api.anthropic.com` only (redirects refused), on an explicit model extract request; never ids, refs, permalinks or
  git footers. Only `BRAIN_MODEL_PROVENANCES` (`git_pr`, `git_commit`, `git_spec`) are listed for a model run, and the
  job skips any other provenance as `provenance_not_allowed` before a call; other sources in the scope never leave.
- Selection: model runs take pending documents newest first (rules stay oldest first). Bodies over the byte cap, under
  200 characters, or made only of squash bullets and trailers are skipped without a call (`document_too_large`,
  `body_too_short`, `commit_list_only`); a refusal is skipped `model_refused`, except one whose fallback could not run
  (`stop_details.recommended_model`), which is `model_output_invalid` and retried. `verifyModelClaims` keeps an
  assignee or due date only when its quote states it; kind and severity are the model's classification.
- Errors: `model_auth_failed` (401, 402, 403, 404; `configure_model`) and `model_unavailable` (network, 408, 409, 429,
  5xx, retried once unless asked to wait over 5 s; `retry_later`) stop the run with no document state;
  `model_rejected` (400, 413, 422) fails one document, then stops the run; `model_timeout` fails the document, is
  charged at its worst case and the run goes on within its budgets. The caller's signal (a background run's cancel,
  time cap or shutdown) stops the run before the next call and aborts the call in flight.
- Runs carry `cache_read_tokens` and `cache_write_tokens` (`ADD COLUMN IF NOT EXISTS` on older tables); usage is
  added before the outcome is read, so billed refusals count. Prompts and responses are never stored.
- Tests: `pnpm exec vitest run tests/gateway/brain-claims-model-*.test.ts tests/gateway/brain-claims-spend.test.ts`
  (the spend suite's two-process part needs `MATRIX_TEST_POSTGRES_URL`), over a fake `fetch`
  (`tests/gateway/helpers/brain-model-fetch.ts`) and a synthetic key; no network, never a client from `process.env`.

## Features and wiring

Every feature folder reads the core tables with plain SELECTs through `repository.kysely` and never writes, alters,
indexes or triggers them; core writes go through `BrainRepository`. Each owns tables with its own prefix
(`BRAIN_TABLE_PREFIXES`), created by one idempotent bootstrap, and takes its own scope lock, never `brain:<scopeId>`.
`contracts.ts` (with `contracts/`) is the shared contract; each folder's `DOMAIN.md` has the details.

- Search (`search/`, spec 556): full text over documents and claims, and meaning search (OpenAI embeddings, pgvector
  or arrays) only when the owner opts in with `brain.embeddings` in `system/config.json`, never through
  `tools.embeddings`, and only for the gateway owner's scopes (`embeddingOwnerIds`); only the git provenances are sent
  unless the owner lists more, and the list is read again for every refresh and search; `/search`, `/search/refresh`
  (whose answer carries the refresh's `embedding` spend while meaning search is on); hook listener `search`.
- Graph (`graph/`, spec 557): entities, typed links, person aliases (merge, split, and unmerge, the Undo of a manual
  merge), person merge suggestions (in the graph contract), timelines and neighbourhoods; seven routes under
  `/timeline`, `/entities` and `/graph/refresh`; hook listener `graph`.
- Sources (`sources/`, specs 558 to 560): kind handlers and adapters for GitHub (`github/`, with the integration
  caller in `integration/`), Matrix notes, files and chats (`matrix/`) and Linear, Google Drive, Google Calendar and
  the Slack bridge (`connectors/`); the `/sources` service, its seven routes, the kind registry and the shared runner
  `runBrainSourceSync` live in `core/` (spec 565), which also bootstraps the three source table groups at start. The
  integration seams (`integration/late-bound.ts`: caller, `configured`, `isConnected`, `accounts`) are bound by the
  gateway once platform integrations exist; with no transport bound the integration kinds read `not_configured`,
  and with a transport but no account of that service, `not_connected`. The local transport finds the owner's
  platform user by the Clerk id rule the Settings connect flow stores it under (`integrations/principal-identity.ts`:
  outside production the dev principal `default` is `MATRIX_CLERK_USER_ID`, else `MATRIX_HANDLE`).
  Both transports read the brain's actions raw, byte-capped and cancellable (`boundedProxy`; remotely the platform's
  `/read-call` does it).
- Brief (`brief/`, spec 561): daily brief, conflicts and stale data; four routes; hook listener `brief` (document
  tombstones and scope erase) and the daily brief job.
- Background runs (`jobs/`, spec 566; contract `contracts/jobs.ts`): `brain_jobs` (its own table, no
  `BRAIN_TABLE_PREFIXES` prefix), queued runs of sync, extract, search and graph refresh and brief with dedupe per
  (scope, kind, target), leases, heartbeats, expired-lease recovery, cancel (the worker of this gateway stops the run
  at once) and keep-going steps, a service (`services.runs`), four routes under `/jobs` (`POST` answers 202) and one
  worker per gateway for its owner (at most 2 runs at once by default); codes `job_not_found`,
  `job_kind_unavailable`, `jobs_full`. Steps pass the run's signal to extract and source sync; a paid run (model
  extract) is never queued again after a restart or a lost lease (`interrupted`); a refresh that cannot catch up
  (`stopReason`) stops its run. With only the jobs off, the routes answer `job_kind_unavailable` (`BRAIN_JOBS_OFF`)
  so clients run the work directly. A project erase clears the scope's `brain_jobs` rows when the table exists.
- Impact (`impact/`, spec 564): what a branch changes and what the brain knows about it, importers to depth 2 by
  default with `dependentTotals` per depth; `/impact` and `/impact/comment`; no tables.
- Agent tools (`agent/`, spec 562): the owner-bound adapter behind the kernel's read-only `brain_search`,
  `brain_timeline`, `brain_claims`, `brain_brief`, `brain_conflicts` and `brain_impact` tools; the same six tools are
  offered over HTTP by `packages/integrations-mcp/src/brain-tools.ts`. The app is `shell/src/components/brain/`
  (spec 563).
- Wiring: `api/project-resolver.ts` (the one project lookup every service uses), `hooks.ts` (the change bus:
  per-scope queues capped at `BRAIN_HOOK_QUEUE_MAX_SCOPES`, coalesced events, listeners after the request, each bounded
  by `BRAIN_HOOK_LISTENER_BUDGET_MS`, a drain with a deadline on close; `eraseBrainScope`), `api/start.ts`
  (`startBrainServices`: the core store through `startBrainProjectService`, whose failure of any kind leaves the whole
  brain off, then each feature bootstrap on its own in `BRAIN_BOOTSTRAP_ORDER`, so a failing feature (or source table
  group) is logged by error name and SQLSTATE and only that feature is off; the project service wrapped to emit
  `documents_changed` after a sync that wrote or deleted and `claims_changed` after an extraction that changed claims;
  `eraseProject`; the run service and the jobs: the run worker, the daily brief and the index catch-up;
  `stopBrainServices` stops the run worker first, then the other jobs, and drains the hooks before the owner database
  closes), `api/erase.ts` (`eraseBrainProject`: the core scope through
  `BrainRepository.eraseScope`, then the scope rows of every feature table that exists, whether or not that feature
  started, each under its own lock, and `brain_jobs` through its store; `createBrainProjectCleanup`, the project
  deletion step: the brain's `eraseProject` when it is on, the same erase straight on the owner database when the
  brain is off or deferred, and a throw, so the deletion is retried, when the owner database is configured but down),
  `api/index-repair.ts` (the one-shot index catch-up 30 s after start, which refreshes every index in up to 200
  scopes that have or had a source, because a change event emitted while the gateway shuts down is dropped and a
  graph sweep a shutdown cut short leaves entities no freshness counts; and the purge that drops a removed source's
  derived rows before `/sources` answers) and `api/feature-routes.ts`
  (`createBrainApiRoutes`, every router under `/api/brain`, each 503 while the brain or its feature is off). Every
  route takes a project id or slug. The gateway seams (owner principals, late-bound integrations, agent tools, project
  erase) live in `server/brain-wiring.ts`; `server.ts` only calls them, mounts `/api/brain`, starts the jobs and stops
  the brain (its extraction plan: `GATEWAY_ROUTE_GROUPS` in `server/route-inventory.ts`).
- Shared by the features: `cite.ts` (the one cite label rule and loader), `bounded.ts` (reads in a READ ONLY
  transaction with a 10 s statement deadline; at most two brief builds and two refreshes of each index at once) and
  `api/feature-route-kit.ts` (the route guard, error mapper and body limit of every feature router).
- Tests: `tests/gateway/brain-hooks.test.ts`, `brain-start.test.ts` (a run queued through the mounted routes and
  finished by the worker the services start; stop order), `brain-start-repair.test.ts` (not_configured without a
  transport, erase of features that did not start, removal purge, catch-up after a dropped event),
  `brain-wiring.test.ts` (composition, gateway seams, contract export names, every `BRAIN_ROUTES` entry answered by a
  mounted handler and every mounted route listed in `BRAIN_ROUTES`), `brain-cite.test.ts`, and
  `tests/integrations/read-call-brain-bounded.test.ts`.
