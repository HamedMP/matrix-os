# Company Brain sources service

The `/sources` routes and service that connect, list, update, remove and sync a project's brain sources, the kind
registry, the shared sync runner and the start step for the source tables. Spec:
`specs/565-company-brain-sources-service/spec.md`; contract: `../../contracts/sources.ts`.

## Scope

- `registry.ts`: one handler per kind, account services and pinning, the call deadline, the connect queue. Then
  `service.ts`, `routes.ts` (the seven `/sources` entries of `BRAIN_ROUTES`), `views.ts` (client and git sync views),
  `runner.ts` and `start.ts` (github, matrix and connector table bootstraps, the handler set, the start step).
- Owns no table: the handlers in `../github/`, `../matrix/` and `../connectors/` own their config tables and
  adapters. Git sources keep their own routes and are only listed, paused, removed and synced (`gitSync`) here.
- Out of scope: scheduled syncs, organization scopes, the `isConnected` and `accounts` lookups, the Slack reader.

## Source of truth

- `brain_sources` through `BrainRepository` (create, update, replace, delete, list, get, receipts) and each kind's
  config table through its handler. Documents are written only by the runner's `applySyncBatch`.
- In memory: per service a connect queue of at most 64 keys (dropped when their work settles); in the runner a set
  of at most 16 running sources (cleared in `finally`). Nothing else is kept between calls.

## Public API

`index.ts`: `runBrainSourceSync`, `createBrainSourcesService` (the contract deps plus an optional `callTimeoutMs`),
`createBrainSourcesRoutes`, `createBrainSourceKindRegistry`, `createBrainGitSourceSync`, `gitSyncToSourceView`,
`bootstrapBrainSourceTables`, `createBrainSourceHandlers`, `startBrainSourcesService`, their types and limits.
`../connectors/index.ts` re-exports `runBrainSourceSync`.

## Auth and trust boundaries

- Routes: `Cache-Control: private, no-store`, the request principal, 503 while the service is off, the project ref
  shape, then `exactQuery` and strict zod bodies under `bodyLimit` (16 KiB connect and update, 1 KiB sync and
  remove). Errors are `{ error: { code, message } }` with fixed text from the feature route kit.
- The project resolves first: a missing, foreign, archived or malformed project is `project_not_found`; a missing,
  foreign, tombstoned, unknown-kind or malformed source is `source_not_found`. Handlers never get a request.
- Handlers parse configs (`source_config_invalid`); configs hold no credentials. A config view is the handler's
  redacted `viewConfig`; `externalRef` is shown only for git and github.

## Concurrency and recovery

- Connect: availability, `parseConfig`, account pinning, `identify`, `checkConfig` (for example the GitHub repository
  conflict, so no row is created), then under the connect queue the per-kind cap check and `createSource` with
  `saveConfig` in its transaction: no request sees the source without its config, and a refused config leaves none.
  The same identity answers the existing source unchanged (`created: false`); a missing or refused stored config is
  saved compare-and-set on the revision read with the source, so a config another request saved since stands.
  `createSource` resolves the project again under the scope lock, so a project deleted meanwhile gets no source.
- Across processes the cap is settled after the create: a source not among the oldest `BRAIN_SOURCES_PER_KIND_MAX`
  of its kind by (createdAt, sourceId) removes itself (`source_conflict`). Two creates in the same millisecond in
  two processes can both stay; the queue rules this out within one process.
- Update saves the config in the transaction that moves the revision (compare-and-set; the core scope lock, then the
  kind's lock), so a failed save changes nothing and a client that reads the new revision reads the new config. A
  config that changes the identity is refused. One that turns calendar event bodies off, or changes a GitHub
  source's `since` or `include` (its cursor was read under the old ones), removes and connects the source again in
  one transaction with the new config (`replaceSource`); the successor keeps the old createdAt (its cap place).
- Remove is `deleteSource` with the client's revision, then `purgeRemoved` (from `api/start.ts`) drops the tombstoned
  documents' search, graph and brief rows (batches of 500, at most 5,000, under 15 s) before the answer; when it
  cannot finish (or is not given), the removal is announced as `documents_changed` with null ids. Reconnects too.
- Options answer like connect for a kind that cannot be connected, never an empty list that reads as "none".
- Sync is one bounded run of the runner (`BRAIN_SOURCE_SYNC_DEFAULT_LIMITS` or the given limits). A crash leaves at
  most a running receipt, closed by the next run. A paused source answers the runner's failed view
  (`source_inactive`, no receipt) before its config or account is read.
- A git source syncs through `gitSync` (its id and the caller's signal), which runs the project's oldest live git
  source; another one a registration race left is `source_conflict`, also when the race lands as the run starts. A
  paused git source answers the failed view without running, also when paused or removed as the run starts.

## Tests

`pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (PGlite store, scripted handlers, the real handlers
over fake integrations, readers and a temporary home; no network).
