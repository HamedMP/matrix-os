# Company Brain Store

The durable store behind the Company Brain: what an organisation or a person published or synced into their brain,
with revisions, tombstones, sync cursors and sync receipts.

## Scope

- Owns nine `brain_*` tables (`brain_sources`, `brain_documents`, `brain_document_revisions`, `brain_document_refs`,
  `brain_sync_cursors`, `brain_sync_receipts`, and `brain_claims`, `brain_extraction_state`, `brain_extraction_runs`
  from `claims/database.ts`) and `BrainRepository`, their only reader and writer.
- Deferred: organization scopes and scheduled source sync. Never: authorization (the caller resolves the scope),
  `onboarding/company-brain-readiness.ts` (unrelated) and PR #2078's `company_brain_*` tables in `company-brain/`.
  Git adapter: `git/`; routes, `brain_why` and wiring: `why.ts`, `api/`; claim extraction: `claims/` (all below).
- Name clash: `company-brain/` exports `BrainSourceIdSchema`, `BrainCitation` and `BrainEvidenceProof` with other
  meanings; its `BrainSourceIdSchema` (`^[a-f0-9]{64}$`) is this store's `BrainDocumentIdSchema`, while this store's
  (`^src_[a-f0-9]{32}$`) names a connected source. Import from one folder per module, aliasing if both are needed.

## Source Of Truth

- Owner Postgres, tables prefixed `brain_`; every row carries `(owner_id, scope_id)`, which starts every primary key.
- Derived and bounded: the GIN full-text index, revision snapshots (10 per document id), receipts (50 per source) and
  claims (50 per document and extractor, 50,000 per scope).
- No in-memory registry, cache or file state; the git adapter and the claims job keep only capped in-process sets of
  running keys (`GIT_MAX_CONCURRENT_SYNCS`, `BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS`), cleared in `finally`.

## Public API

- `index.ts` exports `BrainRepository`, `bootstrapBrainDatabase`, `computeBrainContentHash`, the types and constants
  of `types.ts`, and the Zod schemas plus `parseBrainInput` of `schemas.ts`.
- `listDocumentRefs(scope, documentId)` returns a live document's refs (at most `BRAIN_DOCUMENT_REFS_MAX`, by kind then
  value); only `applySyncBatch` upserts write refs. Other domains never import the internals (`documents.ts`,
  `document-reads.ts`, `document-refs.ts`, `sources.ts`, `sync.ts`, `mappers.ts`, `schemas.ts`).

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

- Every write is one transaction with `lock_timeout = 5s` and `statement_timeout = 15s` that takes
  `pg_advisory_xact_lock` on the owner and `brain:<scopeId>`; capacity counts, CAS, cursor advance, receipt pruning and
  erase all run under it. Reads do not lock. The clock is read after the lock, so `updated_at`, `superseded_at`,
  `started_at` and `finished_at` are monotonic within a scope (the prunes and newest-first listings rely on it).
- Optimistic concurrency is in the write predicate (`revision = expected` on sources and documents, `cursor =
  expected` on cursors, `status = 'running'` on receipts); a miss is `conflict`. A sync batch and its cursor advance
  commit together, so the cursor never runs ahead of or behind its documents.
- A crashed run's `running` receipt is closed `interrupted` by the source's next `openSyncReceipt` or `deleteSource`.
  Snapshots record the owning `source_id`; `deleteSource` purges by it and by current ownership, so a removed
  source's content never survives in a document id another source revived.
- Refs index live synced documents: each `applySyncBatch` upsert carries its complete set (omitted: none), replaced in
  the batch transaction only when it differs; every tombstone path and `eraseScope` remove refs. Not snapshotted.
- No orphan states: every multi-row write is one transaction. Retained history, each bounded by count: tombstones,
  snapshots, receipts and extraction runs (50 per scope, plus up to 1,000 billed runs of the last 30 days). Claims of
  an older revision stay, stale, until re-extracted; a crashed `running` extraction blocks its scope until its
  5-minute lease expires. `eraseScope` removes everything of a scope except its billed runs of the last 30 days, which
  move to the owner's retired-runs scope id (counts and usage only) so the spend cap still counts them.
- Bootstrap is idempotent (`CREATE ... IF NOT EXISTS`) under a schema-wide advisory lock.

## Tests

`pnpm exec vitest run tests/gateway/brain-store*.test.ts` (PGlite; fixtures in `helpers/brain-store-helpers.ts`);
`brain-store-postgres.test.ts` needs `MATRIX_TEST_POSTGRES_URL` (concurrent bootstrap, `createSource`, batches).

## Git source adapter (`git/`)

Spec: `specs/552-company-brain-git-source/spec.md`. `git/index.ts` exports `syncGitSource`, `defaultGitRunner`,
`openGitRepository`, `deriveWebBase`, `parseWebBase`, `resolveGitWebBase` and `git/types.ts` (not re-exported by
`brain/index.ts`). It reads the default branch's history, read-only, and writes only through `BrainRepository`.

- One document per first-parent commit (a pull request document for a GitHub squash or merge of `#N` or a GitLab merge
  of `!N`) and one per spec file part (by default `specs/*/` `spec.md`, `plan.md`, `research.md`, `data-model.md`,
  `quickstart.md`, and top-level `specs/*.md`). Ids are sha256 of `["brain_git_v1", externalRef, kind, ...]`, never of
  content; changed paths, PR numbers and spec directories are refs. A spec file is written only in a window whose end
  holds its content at the run's tip, so a first sync or a rescan never rolls it back.
- Each `applySyncBatch` commits documents, refs and cursor together; only a window's final batch moves the cursor to
  its end, so a crash replays the window as no-ops. The cursor (`git/cursor.ts`) is the last applied first-parent sha,
  plus the run's tip when it stopped short, or a token naming the run holding the window. A cursor no longer on the
  way to the tip (force-push, collected object, read-ahead gone) triggers a bounded rescan from the root.
- The caller authorizes the scope and resolves `repoPath` and `homePath`; `openGitRepository` refuses anything whose
  realpath is not strictly inside `realpath(homePath)`, is not the top level, or whose git, common or alternates
  directories leave home or enter home's `.git`. One run per source per process; across processes the cursor CAS
  decides (`cursor_conflict`), and a window's first batch takes the cursor, so a competing run fails before it writes.
- Git runs through an injectable runner: execFile with an argv array, a fresh environment (absolute `PATH` entries,
  `GIT_ALLOW_PROTOCOL=none`), pinned `-c` overrides, a timeout and a maxBuffer. Local objects only; no network, no
  working tree, never `HEAD`.
- Errors are stable codes in `GitSyncResult`, also on the receipt once one is open (`invalid_options`,
  `sync_in_progress` and `source_*` come before it). `history_rewritten` and `documents_rejected` are info codes on
  successful runs. stderr and paths go to server logs only.
- Tests: `tests/gateway/brain-git-*.test.ts` (fixture repos built with git plumbing by `helpers/brain-git-fixture.ts`;
  shared `helpers/brain-git-harness.ts` and `helpers/brain-git-pure.ts`).

## Project API and brain_why (`why.ts`, `api/`)

Spec: `specs/553-company-brain-why/spec.md`.

- Scope recipe: a project of the request principal is `brainProjectScope(ownerId, projectId)`
  (`personal:project:<projectId>`); missing, foreign and malformed projects are the same `project_not_found`. One live
  git source per project scope; registering never runs git.
- `api/service.ts`: one bounded `syncGitSource` run per sync request (a failed run with a receipt is a 200), receipts
  and read-only `why`; `startBrainProjectService` bootstraps the store for `startBrainServices`. A lock or statement
  deadline defers the brain and any other core failure leaves it off (routes 503, no agent tool, logged by error name
  and SQLSTATE), so the brain never takes down owner startup (chats, canvas, messaging).
- `api/routes.ts` mounts `/api/brain/projects/:projectId/{git-source,sync,receipts,why,extract,claims}`;
  `api/agent-tools.ts` binds the no-JWT owner for `brain_why`. `why.ts` reads `listDocumentsByRef` (a bytewise range on
  the collation-"C" refs index, newest first, keyset cursor, count capped at 1,000).
- Tests: `brain-why.test.ts`, `brain-api-*.test.ts`, `brain-agent-tools.test.ts`, `brain-wiring.test.ts`,
  `tests/kernel/brain-why-tool.test.ts`.

## Claims (`claims/`)

Spec: `specs/554-company-brain-claims/spec.md`; `claims/types.ts` is the contract. Spans are UTF-16 units into the
stored body, and `body.slice(spanStart, spanEnd) === quote` is rechecked on every write.

- `applyDocumentExtraction` replaces one (document, extractor) set under the scope lock, fenced by the scope's running
  run (5-minute lease, then `interrupted`), and saves the run's cost so far on its row (never lowered); failed or
  skipped outcomes write state only. Claims of an older revision read as stale. `applyDelete`, `deleteSource` and
  `eraseScope` remove claims and state in their transactions. `rules.ts` (`rules/v2`) and `verify.ts` (every model
  output) feed `job.ts`; the Claude adapter is `claims/model/`.
- Rules versions: raise `BRAIN_RULES_VERSION` whenever `rules.ts` decides differently; every live document is then
  pending again (also while it holds another rules version's state, which clears an older gateway's late write). An
  applied rules outcome first removes the document's claims and state of every other rules version in its
  transaction (counted in `claimsRemoved`, so `claims_changed` fires); until then the older claims stay readable, and
  `listClaims` hides them once the current version has state for the document. Model claims are never touched. The
  claim id leaves out the extractor, so a claim read the same way keeps its id.
- One claim per quote span, by `BRAIN_CLAIM_KIND_PRECEDENCE` (commitment, decision, risk, invariant). Under a
  design-note sub-heading of a decisions section `rules.ts` keeps an item only when it has its own label or prefix or
  states a choice (chose, decided, instead of, rather than, must, never, will, a leading `Use` or `Do not`). Open
  decisions and questions are never claims. `brain/index.ts` does not re-export `claims/`.
- Tests: `pnpm exec vitest run tests/gateway/brain-claims-*.test.ts`.

## Model claims (`claims/model/`)

Spec: `specs/555-company-brain-model-claims/spec.md`; `claims/model/types.ts` is the contract and never imports the
SDK, so `job.ts` and `claims/index.ts` never load `@anthropic-ai/sdk`.

- Files: `prompt.ts` (the fixed `claims-v2` system prompt and the skip policy), `client.ts` (one
  `client.beta.messages.create` call per document on Claude Opus 5.5 with `fallbacks: "default"`, a cached system
  block and structured output; refusals, unusable output and SDK errors become outcomes and `BrainModelError` codes),
  `pricing.ts` (tokens and micro-USD per attempt) and `config.ts` (settings, credential, provider, imported only by
  `api/service.ts`, whose `startBrainProjectService` supplies it as `claimModels`; without it: 409).
- Credentials, read per request and never cached, logged or stored: the owner's `kernel.anthropicApiKey` in
  `system/config.json`, else a direct `ANTHROPIC_API_KEY` without `ANTHROPIC_BASE_URL`, else 409; OAuth tokens, proxy
  keys and Matrix-funded leases are refused. Only the owner's principals (`modelOwnerIds`) may use the key; others get
  409 and `modelSpend` null. Settings are `MATRIX_BRAIN_MODEL_*`; an invalid one disables the extractor.
- Spend cap (`claims/spend.ts`): per owner across all projects over 30 days, default 5 USD, summed from the owner's
  runs in every scope (a project erase moves them to `BRAIN_RETIRED_RUNS_SCOPE_ID`). One model run per owner at a time
  in a process. Each call is checked against its worst case (every retry and fallback hop billed); a run that cannot
  afford it stops `spend_cap_reached` (`raise_budget`). Each document's write saves the run's cost so far, and a call
  that timed out or was aborted after it was sent is charged at its worst case. Results carry `spend`, and
  `GET .../claims` the same window as `modelSpend` (null without valid model settings).
- Data leaving the gateway: per document its title and footer-stripped body, plus the fixed prompt and schema, to
  `api.anthropic.com` only (redirects refused), on an explicit model extract; never ids, refs, permalinks or git
  footers, and only `BRAIN_MODEL_PROVENANCES` (`git_pr`, `git_commit`, `git_spec`).
- Selection: newest first. Bodies over the byte cap, under 200 characters or only squash bullets and trailers are
  skipped without a call; a refusal is `model_refused`, unless its fallback could not run (`model_output_invalid`,
  retried). `verifyModelClaims` keeps an assignee or due date only when its quote states it.
- Errors: `model_auth_failed` (401-404) and `model_unavailable` (network, 408, 409, 429, 5xx, retried once) stop the
  run without document state; `model_rejected` (400, 413, 422) fails one document and stops; `model_timeout` fails the
  document, charged at its worst case. The caller's signal stops the run and aborts the call in flight. Usage, cache
  tokens included, is added before the outcome is read; prompts and responses are never stored.
- Tests: `brain-claims-model-*.test.ts` and `brain-claims-spend.test.ts` (its two-process part needs
  `MATRIX_TEST_POSTGRES_URL`) over a fake `fetch` (`helpers/brain-model-fetch.ts`); no network.

## Features and wiring

Feature folders read core tables with plain SELECTs through `repository.kysely` and never write, alter, index or
trigger them. Each owns tables with its own prefix (`BRAIN_TABLE_PREFIXES`), created by one idempotent bootstrap, and
takes its own scope lock, never `brain:<scopeId>`. `contracts.ts` (with `contracts/`) is the shared contract; each
folder's `DOMAIN.md` has the details.

- Search (`search/`, spec 556): full text over documents and claims; meaning search (OpenAI embeddings, pgvector or
  arrays) only when the owner opts in with `brain.embeddings` in `system/config.json` (never `tools.embeddings`), only
  for the owner's scopes (`embeddingOwnerIds`) and only for the git provenances unless the owner lists more (read again
  on every refresh and search); `/search`, `/search/refresh` (with its `embedding` spend); listener `search`.
- Graph (`graph/`, spec 557): entities, typed links, person aliases (merge, split, unmerge), merge suggestions,
  timelines and neighbourhoods; seven routes under `/timeline`, `/entities` and `/graph/refresh`; listener `graph`.
- Sources (`sources/`, specs 558 to 560 and 565): kind handlers for GitHub (`github/`, integration caller in
  `integration/`), Matrix notes, files and chats (`matrix/`; notes and files read the gateway's Notes and home for its
  owner principals only) and Linear, Google Drive, Google Calendar and the Slack bridge (`connectors/`); `core/` holds
  the `/sources` service and its seven routes, the kind registry, the shared runner `runBrainSourceSync` and the table
  bootstrap. The integration seams (`integration/late-bound.ts`) are bound once platform integrations exist; until
  then integration kinds read `not_configured`, and with no account of the service `not_connected`. The local
  transport finds the owner's platform user by the Settings connect flow's Clerk id rule
  (`integrations/principal-identity.ts`); both read raw, byte-capped and cancellable (`boundedProxy`, `/read-call`).
- Brief (`brief/`, spec 561): daily brief, conflicts and stale data; four routes; listener `brief` and the daily job.
- Background runs (`jobs/`, spec 566; `contracts/jobs.ts`): `brain_jobs` (no prefix) queues sync, extract, search and
  graph refresh and brief runs, deduped per (scope, kind, target), with leases, heartbeats, recovery, cancel and
  keep-going steps; `services.runs`, four `/jobs` routes (`POST` is 202), one worker per gateway for its owner (2 runs
  at once); codes `job_not_found`, `job_kind_unavailable` (also with the jobs off, so clients run the work directly),
  `jobs_full`. A paid run (model extract) is never queued again after a restart or a lost lease.
- Impact (`impact/`, spec 564): what a branch changes and what the brain knows about it (importers to depth 2,
  `dependentTotals` per depth); `/impact` and `/impact/comment`; no tables.
- Agent tools (`agent/`, spec 562): the owner-bound adapter behind the kernel's read-only `brain_search`,
  `brain_timeline`, `brain_claims`, `brain_brief`, `brain_conflicts` and `brain_impact` (also over HTTP in
  `packages/integrations-mcp/src/brain-tools.ts`). The dispatcher hands them and `brain_why` only to a run whose
  server-set `callerId` is an owner principal (the owner's shell, personal canonical Chat and `/api/message` runs);
  collaborators', shared or organization chats', channels' and background runs get none. The app is
  `shell/src/components/brain/` (spec 563).
- Wiring: `api/project-resolver.ts` (the one project lookup); `hooks.ts` (the change bus: per-scope queues capped at
  `BRAIN_HOOK_QUEUE_MAX_SCOPES`, coalesced, listeners after the request within `BRAIN_HOOK_LISTENER_BUDGET_MS`, drained
  with a deadline on close); `api/start.ts` (`startBrainServices`, whose header gives the start order, what a failed
  start leaves off, the jobs and the change events, emitted by the git sync and extraction runners so a failed run
  that saved is announced too; `stopBrainServices` stops the worker, the other jobs, then drains the hooks);
  `api/erase.ts` (`eraseBrainProject`: the core scope, every existing feature table's scope rows and `brain_jobs`;
  `createBrainProjectCleanup` erases whether the brain is on, off or deferred, and throws while the owner database is
  down, so the deletion is retried); `api/index-repair.ts` (a catch-up 30 s after start of every index in up to 200
  scopes with a source, as shutdown drops events, and the purge of a removed source's derived rows); and
  `api/feature-routes.ts` (every router under `/api/brain`, 503 while the brain or its feature is off). The gateway
  seams live in `server/brain-wiring.ts`; `server.ts` only calls them, mounts `/api/brain` and starts and stops jobs.
- Shared: `cite.ts` (the cite label rule and loader), `bounded.ts` (READ ONLY reads with a 10 s statement deadline; at
  most two brief builds and two refreshes of each index at once) and `api/feature-route-kit.ts` (route guard, error
  mapper, body limit).
- Tests: `brain-hooks`, `brain-start`, `brain-start-repair`, `brain-wiring` (composition, seams, exports, mounted
  `BRAIN_ROUTES`) and `brain-cite` under `tests/gateway/`, and `tests/integrations/read-call-brain-bounded.test.ts`.
