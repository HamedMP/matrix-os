# Company Brain sources service

The `/sources` routes and service that connect, list, update, remove and sync a project's brain sources, the kind
registry, the shared sync runner and the start step for the source tables. Spec:
`specs/565-company-brain-sources-service/spec.md`; contract: `../../contracts/sources.ts`.

## Scope

- `registry.ts`, `service.ts`, `routes.ts` (the seven `/sources` entries of `BRAIN_ROUTES`), `views.ts`, `runner.ts`
  and `start.ts`. Owns no table: the handlers in `../github/`, `../matrix/` and `../connectors/` own their config
  tables and adapters. Git sources are only listed, paused, removed and synced (`gitSync`) here.

## Source of truth

`brain_sources` and receipts through `BrainRepository`, configs through each kind's handler; documents only through
the runner. In memory: a connect queue (64 keys) and the runner's running set (16), each entry gone when it settles.

## Public API

`index.ts`: service, routes, runner, registry, git sync, table bootstrap, handler set, start step, types, limits.

## Auth and trust boundaries

- Routes: `no-store`, the request principal, 503 while off, the project ref shape, `exactQuery`, strict zod bodies
  under `bodyLimit`; a path id failing `BRAIN_SOURCE_ID_PATTERN` reaches the service as "". Fixed error bodies.
- The project resolves first (`project_not_found`), then the source (`source_not_found`). Handlers parse configs and
  never get a request; configs hold no credentials.

## Concurrency and recovery

- Connect creates the source with its config in one transaction under the per-kind cap. The same identity answers
  the existing source; a missing config is saved compare-and-set on the revision, read again and retried when a
  rename or pause moved it (3 tries, then `source_conflict`).
- Update saves the config with the revision move; a config the cursor cannot follow reconnects (`replaceSource`).
- Sync is one bounded runner run. A paused source answers `source_inactive` before its config or account is read,
  and also when paused (or removed: `source_not_found`) while they are read.

## Tests

`pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (PGlite, scripted and real handlers; no network).
