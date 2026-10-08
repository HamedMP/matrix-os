# Company Brain sources service

The `/sources` routes and service that connect, list, update, remove and sync a project's brain sources, the kind
registry, the shared sync runner and the start step for the source tables. Spec:
`specs/565-company-brain-sources-service/spec.md`; contract: `../../contracts/sources.ts`.

## Scope

- `registry.ts`: one handler per connectable kind, the integration service each account kind reads through, account
  pinning, the call deadline and the in-process connect queue. `service.ts`: `createBrainSourcesService`.
  `routes.ts`: `createBrainSourcesRoutes` (the seven `/sources` entries of `BRAIN_ROUTES`). `views.ts`: client views
  and the git sync mapped onto the sources sync view. `runner.ts`: `runBrainSourceSync`. `start.ts`: the table
  bootstraps (github, matrix, connectors), the handler set and `startBrainSourcesService`.
- Owns no table. The kind handlers in `../github/`, `../matrix/` and `../connectors/` own their config tables and
  adapters; git sources keep their own routes (`/git-source`, `/sync`) and are only listed, paused, removed and
  synced (through `gitSync`) here.
- Out of scope: scheduled syncs, organization scopes, the `isConnected` and `accounts` lookups (given as
  dependencies) and the Slack capture reader.

## Source of truth

- `brain_sources` (through `BrainRepository`: `createSource`, `updateSource`, `deleteSource`, `listSources`,
  `getSource`, receipts) and each kind's config table (through its handler). Documents are written only by the
  runner's `applySyncBatch`.
- In memory: per service, a connect queue of at most 64 keys (dropped when their work settles); in the runner, a set
  of at most 16 running sources (cleared in `finally`). Nothing else is kept between calls.

## Public API

`index.ts`: `runBrainSourceSync`, `createBrainSourcesService` (the contract deps plus an optional `callTimeoutMs`),
`createBrainSourcesRoutes`, `createBrainSourceKindRegistry`, `createBrainGitSourceSync`,
`gitSyncToSourceView`, `bootstrapBrainSourceTables`, `createBrainSourceHandlers`, `startBrainSourcesService` and
their types and limits. `../connectors/index.ts` re-exports `runBrainSourceSync`.

## Auth and trust boundaries

- Routes: `Cache-Control: private, no-store`, the request principal, then 503 while the service is off, then the
  project ref shape, then `exactQuery` and strict zod bodies under `bodyLimit` (16 KiB connect and update, 1 KiB
  sync and remove). Errors are `{ error: { code, message } }` with fixed text from the feature route kit.
- The service resolves the caller's project before anything else: a missing, foreign, archived or malformed project
  is `project_not_found`; a missing, foreign (other scope), tombstoned, unknown-kind or malformed source is
  `source_not_found`. Handlers get an owner id and a scope key, never a request.
- Configs are parsed by the kind handler (`source_config_invalid`); credentials are never part of a config. A config
  view is the handler's redacted `viewConfig`; `externalRef` is shown only for git and github.

## Concurrency and recovery

- Connect: availability, `parseConfig`, account pinning, `identify`, `checkConfig` (when the handler has one, for
  example the GitHub repository conflict, so no row is created), then under the connect queue the per-kind cap
  check, `createSource` and `saveConfig`. A new source that `saveConfig` or
  the cap refuses is removed again (`deleteSource`), so a refused config leaves no live source. `createSource` is
  idempotent on the identity: the same identity answers the existing source unchanged (`created: false`).
- Across processes the cap is settled after the create: a source that is not among the oldest
  `BRAIN_SOURCES_PER_KIND_MAX` of its kind by (createdAt, sourceId) removes itself (`source_conflict`). Two creates in
  the same millisecond in two processes can both stay; the queue rules this out within one process.
- Update moves the source revision (compare-and-set) and saves the new config in one transaction: `updateSource`
  runs the handler's `saveConfig` inside it (the core scope lock, then the kind's own lock), so a refused or failed
  save leaves label, status, revision and config as they were, and a client that reads the new revision always reads
  the new config. A config that changes the identity is refused. One that turns calendar event bodies off (purging
  stored revisions), or changes a GitHub source's `since` or `include` (its cursor was read under the old ones),
  removes the source and connects it again, so the next sync reads from the start.
- Remove is `deleteSource` with the client's revision, then `purgeRemoved` (given by `api/start.ts`): the search,
  graph and brief listeners drop the derived rows of the documents that removal tombstoned (in batches of 500, at most
  5,000, under 15 s) before the answer, so the removed source's people and text are gone at once. When that cannot
  finish (or no purge is given), the removal is announced as `documents_changed` with null ids instead. The calendar
  event-bodies reconnect removes the same way.
- Options answer like connect for a kind that cannot be connected (`source_not_connected` or
  `source_kind_unsupported`), never an empty list that reads as "nothing to pick".
- Sync is one bounded run of the runner (pages, budget and provider timeout from `BRAIN_SOURCE_SYNC_DEFAULT_LIMITS`
  or the given limits). A crash leaves at most a running receipt, closed as interrupted by the next run. A paused
  source answers the runner's failed view (`source_inactive`, no receipt) before its config or account is read, so a
  disconnected account or a lost config never turns that answer into an error.
- A git source syncs through `gitSync`, which runs the project's git source (its oldest live one). Only that source is
  synced here: another one a registration race left is `source_conflict`, never synced under the wrong id. A paused
  git source answers the runner's failed view (`source_inactive`, no receipt) without running, also when it is paused
  or removed while the run starts.

## Tests

`pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (PGlite store, scripted handlers, the real handlers
over fake integrations, readers and a temporary home; no network).
