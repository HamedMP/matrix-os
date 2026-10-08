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

In scope: `brain/sources/core/` (kind registry, service, the seven `/sources` routes, the shared runner moved here
from `connectors/`, the start step that bootstraps the github, matrix and connector tables and builds every kind
handler), tests `tests/gateway/brain-sources-*.test.ts` and this spec.

Out of scope: the per-kind handlers and adapters (specs 558 to 560), the `isConnected` and `accounts` lookups (given
as dependencies; `sources/integration/`), the Slack capture reader, scheduled syncs, organization scopes and the app
screen (spec 563).

## Model

- Kinds: `BRAIN_SOURCE_KINDS`. Every kind except git is connected here through its handler; a git source is
  registered by `POST /git-source` and here only listed, paused, removed and synced (through `gitSync`).
- Registry: one handler per connectable kind; a kind without a handler (its tables failed, or its dependency is
  missing) reads `not_configured` and connecting it is `source_kind_unsupported`.
- Identity: `handler.identify(project, config)` gives the source's `externalRef` and default label. The same
  identity connects to the same source (`created: false`, config unchanged). Caps per kind: `BRAIN_SOURCES_PER_KIND_MAX`.
- Accounts: GitHub (integration mode), Linear, Google Drive and Google Calendar read through one account of the
  owner. At connect a named label must be one of the owner's accounts; with none named the only account is pinned;
  none is `source_not_connected`, several is `source_config_invalid` (the client names one). An update that names
  no account keeps the pinned one.
- Views: `BrainSourceView` (externalRef only for git and github, the handler's redacted config, the newest receipt),
  `BrainSourceKindView`, `BrainSourceSyncView`, `BrainSourceReceiptsView`. Git sync codes outside the source
  vocabulary map to the nearest source code (for example `not_a_repository` is `config_invalid`); the receipt keeps
  the git code.

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

- Input validation: `:projectId` against `BRAIN_PROJECT_REF_PATTERN`; source ids are checked by the service after
  the project (ids over 64 characters never reach it); `exactQuery` refuses unknown and repeated keys; strict zod
  bodies (kind pattern, label 1 to 300 characters without control characters, revision 1 to the store maximum,
  status `active` or `paused`); configs are parsed by the kind handler; option output is bounded again here.
- Error policy: clients see only codes from `BRAIN_API_ERRORS` and `BRAIN_FEATURE_ERRORS`. Not-found parity: a
  missing, foreign or malformed project is `project_not_found`; a missing, foreign, tombstoned, unknown-kind or
  malformed source is `source_not_found`. Unknown errors are logged by name and answer `brain_unavailable`.
- Credentials: none here. Configs never hold tokens; accounts stay in the integration layer;
  `MATRIX_BRAIN_GITHUB_TOKEN` is read by the GitHub handler per run and only for the configured owner.

## Integration wiring

- Startup: `startBrainServices` (`api/start.ts`) runs `bootstrapBrainSourceTables(kysely)` in
  `BRAIN_BOOTSTRAP_ORDER` (the three bootstraps one by one; a failed group leaves only its kinds off), then, inside
  its per-feature guard, `createBrainSourcesService({ repository, resolver, runner: runBrainSourceSync, hooks,
  gitSync: createBrainGitSourceSync(project), handlers: createBrainSourceHandlers({ kysely, integrations,
  isConnected, accounts, homePath, notes, chats, githubTokenOwnerIds }, readyGroups), accounts, limits })`; the
  service goes into `BrainServices.sources`. `project` is the project service wrapped to emit `documents_changed`,
  so a git sync through `/sources` announces its changes too. `startBrainSourcesService` does the same in one call.
- Routes: `createBrainApiRoutes` mounts `createBrainSourcesRoutes({ service: services?.sources ?? null,
  getPrincipal })` in place of the 503 placeholder.
- Cross-package: none; the kernel and the MCP server do not call `/sources`. Config injection: the integration
  caller and the account lookups (`createBrainLateBoundIntegrations`, bound in `server.ts` once platform
  integrations exist; until then, and when the bind found no transport, `configured()` is false: calls answer
  unavailable and the integration kinds read `not_configured`, never `not_connected`), the Notes reader, the chat
  repository and the home path come from `startup/owner-database.ts`; nothing is read from the environment here.

## Failure modes

- Timeouts: availability, account lookups, adapter creation and option lookups each race a 10 s deadline (100 ms
  to 30 s when set); a passed deadline is `brain_unavailable` (availability in a list reads `not_configured`). A sync
  run is bounded by the runner (20 pages, 20 s budget, 10 s per provider call by default; a started page always
  finishes, 120 s at most). Store writes keep their 5 s lock and 15 s statement deadlines.
- Concurrent access: connects of one kind in one scope run one at a time per process; across processes a later
  create sees the earlier one and removes itself when over the cap. Update and remove are compare-and-set on the
  source revision; an update saves its config in the same transaction (a reconnect also removes the source and
  creates its successor there), so a client that reads the new revision reads the new config and a failed save
  changes nothing. One sync per source per process (runner guard); across processes the cursor compare-and-set
  decides.
- Crash recovery: a crash between `createSource` and `saveConfig` leaves a source without a config: its sync is
  `source_config_invalid` and connecting the same identity again stores the config. A crashed run's receipt is closed
  as interrupted by the next run.
- Error propagation: a failed rollback is logged and the original error answers; a receipt that could not be closed
  answers the run with `receipt: null`; a run that ended before a receipt is 409 `sync_in_progress`, 404 for a source
  that vanished, a 200 failed view for a paused source (git included) and 503 otherwise. A git source other than the
  project's (a registration race left two) is 409 `source_conflict`.

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
  writes take the kind's own feature lock, and an update's config write runs inside the source update's transaction
  (core lock, then the kind's lock); no transaction spans a provider call.
- **Acceptable orphan states**: a source without a config after a crash mid-connect (repaired by connecting again);
  config rows of removed sources until the scope is erased; earlier document revisions until the source is removed.
- **Auth source of truth**: the request principal resolved to the caller's own project scope.
- **Deferred scope**: listed below.

## Integration test checkpoint

- Unit and route tests: `pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (runner, registry, connect,
  pinning, cap races, update, remove, sync mapping, options, every route with auth, not-found parity, validation and
  body limits).
- End to end: every kind connects, syncs through the runner, lists and is removed with its real handler over fake
  providers (`brain-sources-kinds.test.ts`); one HTTP flow over the real service (`brain-sources-routes.test.ts`).
- Manual (dev Docker stack): open Company Brain, Sources, connect Matrix files for `docs`, sync until `nextAction`
  is empty, check the receipt, pause, remove.

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
option lookups for Linear teams, Drive folders and calendars; a handler method for the reconnect rules (calendar
event bodies turned off, GitHub `since` or `include` changed), which live in `service.ts` today; a Postgres test of two gateways connecting one kind in the same
millisecond.
