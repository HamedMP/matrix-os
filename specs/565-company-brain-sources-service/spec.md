# Company Brain sources service

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551 to 560)  
**Owner:** gateway `brain` domain (`brain/sources/core/`)  
**Date:** 2026-10-02

## Outcome

A project owner can connect, list, pause, change, remove and sync every brain source kind from one place: GitHub,
Matrix notes, files and chats, Linear, Google Drive, Google Calendar and the Slack bridge, plus the project's git
source. Each sync is one bounded run with a receipt. A refused config never leaves a source behind, an account is
pinned when the source is connected, and each kind says whether it can be connected now.

## Scope

In scope: `brain/sources/core/` (kind registry, service, the seven `/sources` routes, the shared runner moved from
`connectors/`, the github, matrix and connector table bootstraps and the handler set), its tests and this spec. Out
of scope: per-kind handlers and adapters (specs 558 to 560), the `isConnected` and `accounts` lookups
(`sources/integration/`), the Slack capture reader, scheduled syncs, organization scopes, the app screen (spec 563).

## Model

- Kinds: `BRAIN_SOURCE_KINDS`. Git is registered by `POST /git-source`, here only listed, paused, removed and synced;
  other kinds connect through their handler (without one: `not_configured`; connecting is `source_kind_unsupported`).
- Identity: `handler.identify(project, config)` gives the `externalRef` and default label; the same identity is the
  same source (`created: false`, config unchanged). Caps per kind: `BRAIN_SOURCES_PER_KIND_MAX`.
- Accounts: GitHub (integration mode), Linear, Google Drive and Google Calendar read through one pinned account: a
  named label must be the owner's, with none named the only one is pinned, none is `source_not_connected` and
  several `source_config_invalid`. An update that names no account keeps the pinned one.
- Views: `BrainSourceView` (externalRef only for git and github, the redacted config, the newest receipt) and the
  kind, sync and receipts views. Git sync codes map to the nearest source code; the receipt keeps the git code.

## Routes

All under `/api/brain`, `:projectId` an id or slug, success 200 (201 for a created source).

| Method and path | Input | Answer |
| --- | --- | --- |
| `GET /projects/:projectId/sources` | none | sources oldest first (at most 50) and every kind's availability |
| `POST /projects/:projectId/sources` | `{ kind, config, label? }`, 16 KiB | `{ source, created }` |
| `GET /projects/:projectId/sources/options` | `kind`, `q` (256), `cursor` (512) | at most 100 options; empty for kinds without lookups; a kind that cannot be connected answers as connect does (409 `source_not_connected`, 400 `source_kind_unsupported`) |
| `PATCH /projects/:projectId/sources/:sourceId` | `{ expectedRevision, status?, config?, label? }`, 16 KiB | the source |
| `DELETE /projects/:projectId/sources/:sourceId` | `expectedRevision`, body at most 1 KiB and empty | the removed source (its derived search, graph and brief rows are dropped before the answer) |
| `POST /projects/:projectId/sources/:sourceId/sync` | empty body, 1 KiB | one run's sync view |
| `GET /projects/:projectId/sources/:sourceId/receipts` | `limit` 1 to 50, default 10 | the source and its receipts |

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| the seven `/sources` routes | gateway auth, then `requireRequestPrincipal` | the principal's own project through `BrainProjectResolver`; every store call carries `(owner_id, scope_id)` | fixed `{ error: { code, message } }` |
| kind handlers and the runner | server code | caller-resolved owner id and scope key | feature and sync codes |

- Input validation: `:projectId` against `BRAIN_PROJECT_REF_PATTERN`; source ids against `BRAIN_SOURCE_ID_PATTERN`
  (else "", checked after the project); `exactQuery`; strict zod bodies (kind pattern, label 1 to 300 characters
  without control characters, revision bounds, status); handlers parse configs; option output is bounded again.
- Error policy: clients see only codes from `BRAIN_API_ERRORS` and `BRAIN_FEATURE_ERRORS`. Not-found parity: a
  missing, foreign or malformed project is `project_not_found`; a missing, foreign, tombstoned, unknown-kind or
  malformed source is `source_not_found`. Unknown errors are logged by name and answer `brain_unavailable`.
- Credentials: none here. Configs never hold tokens; accounts stay in the integration layer; the GitHub handler reads
  `MATRIX_BRAIN_GITHUB_TOKEN` per run, only for the configured owner.

## Integration wiring

- Startup: `startBrainServices` (`api/start.ts`) runs `bootstrapBrainSourceTables(kysely)` in `BRAIN_BOOTSTRAP_ORDER`
  (a failed group leaves only its kinds off), then, in its per-feature guard, `createBrainSourcesService` with the
  repository, resolver, `runBrainSourceSync`, hooks, `createBrainGitSourceSync(project)` (the project service wrapped
  to emit `documents_changed`), `createBrainSourceHandlers(deps, readyGroups)`, accounts and limits, into
  `BrainServices.sources`. `startBrainSourcesService` does the same in one call.
- Routes: `createBrainApiRoutes` mounts `createBrainSourcesRoutes` in place of the 503 placeholder.
- Cross-package: none. Config injection: the integration caller and account lookups
  (`createBrainLateBoundIntegrations`, bound in `server.ts`; unbound, integration kinds read `not_configured`), the
  Notes reader, the chat repository, the home path and `homeOwnerIds` (only the gateway's owner reads its Notes and
  home) come from `startup/owner-database.ts`; no environment reads.

## Failure modes

- Timeouts: availability, account, adapter and option calls race a 10 s deadline (100 ms to 30 s when set); a passed
  deadline is `brain_unavailable` (`not_configured` in a list). The runner bounds a sync (20 pages, 20 s budget, 10 s
  per provider call; a started page finishes, 120 s at most). Store writes keep 5 s lock and 15 s statement deadlines.
- Concurrent access: one connect per kind and scope at a time per process; across processes a later create sees the
  earlier one and removes itself when over the cap. A create, update or reconnect saves the config in its source
  write's transaction; update and remove are compare-and-set on the revision. One sync per source per process;
  across processes the cursor compare-and-set decides.
- Crash recovery: a source and its config commit together; a crashed run's receipt is closed by the next run.
- Error propagation: a failed rollback is logged and the original error answers; a receipt that could not be closed
  answers `receipt: null`; a run that ended before a receipt is 409 `sync_in_progress`, 404 for a vanished source, a
  200 failed view for a paused one (git included), else 503. A git source not the project's is 409 `source_conflict`.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| sources read per scope; sources shown | 5 pages of 100; 50 | `service.ts` |
| options per answer; option id; option text; option cursor | 100; 256; 200; 512 characters | `service.ts` |
| account labels read | 51 | `registry.ts` |
| connect queue keys; running syncs | 64; 16 | `registry.ts`, `runner.ts` |
| request bodies | 16 KiB connect and update, 1 KiB sync and remove | `routes.ts` |
| receipts per answer | 50 | `routes.ts`, store |

No file is written. The queue drops a key when its last connect settles. Third-party data flow: none from this
folder; the handlers read their providers (specs 558 to 560).

## Invariants

- **Source of truth**: `brain_sources` and receipts in the core store, configs in each kind's table; this folder
  owns no table and writes documents only through the runner.
- **Lock/transaction scope**: each store write is one repository transaction under the core scope lock; config
  writes take the kind's own feature lock and run inside the source write's transaction (core lock, then the kind's
  lock); no transaction spans a provider call.
- **Acceptable orphan states**: config rows of removed sources until the scope is erased; earlier document revisions
  until the source is removed.
- **Auth source of truth**: the request principal resolved to the caller's own project scope.
- **Deferred scope**: listed below.

## Integration test checkpoint

- Unit and route tests: `pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (runner, registry, connect,
  pinning, races, update, remove, sync, options, every route with auth, not-found parity, validation, body limits).
- End to end: every kind with its real handler over fake providers (`brain-sources-kinds.test.ts`), one HTTP flow
  (`brain-sources-routes.test.ts`), source writes across two Postgres connections (`brain-store-postgres.test.ts`).
- Manual (dev Docker stack): Company Brain, Sources: connect Matrix files for `docs`, sync until `nextAction` is
  empty, check the receipt, pause, remove.

## Code review checklist

- Every catch checks the error or logs its name; no provider text, path or SQL reaches a client.
- Connect never leaves a live source for a refused config; the per-kind cap holds under concurrent connects.
- Update and remove carry the client's revision into the store write.
- Every route has `no-store`, the principal check, `exactQuery`, a strict schema and, when it mutates, `bodyLimit`.

## Delivery and evidence

- [ ] One PR (sources core, its tests and this spec), checks green, Invariants in the body.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`): connecting brain sources and what each kind reads.

## Deferred

Scheduled syncs; organization scopes; the Slack capture reader (until then `slack_bridge` reads `not_configured`);
option lookups for Linear teams, Drive folders and calendars; a handler method for the reconnect rules (in
`service.ts` today); a Postgres test of two gateways connecting one kind in the same millisecond.
