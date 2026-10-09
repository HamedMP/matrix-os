# Company Brain sources service

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551 to 560)  
**Owner:** gateway `brain` domain (`brain/sources/core/`)  
**Date:** 2026-10-02

## Outcome

A project owner can connect, list, pause, change, remove and sync every brain source kind (and the project's git
source) from one place. Each sync is one bounded run with a receipt. A refused config never leaves a source behind,
an account is pinned when the source is connected, and each kind says whether it can be connected now.

## Scope

In scope: `brain/sources/core/` (registry, service, the seven `/sources` routes, the shared runner, table bootstraps,
handler set), its tests and this spec. Out of scope: per-kind handlers (specs 558 to 560), the account lookups, the
Slack capture reader, scheduled syncs, organization scopes, the app screen (spec 563).

## Model

- Kinds: `BRAIN_SOURCE_KINDS`; git is registered by `POST /git-source`, others connect through their handler. The
  same `handler.identify` result is the same source (`created: false`); caps: `BRAIN_SOURCES_PER_KIND_MAX`.
- Accounts: GitHub (integration mode), Linear, Google Drive and Google Calendar pin one owner account (none is
  `source_not_connected`, several unnamed `source_config_invalid`); an update that names none keeps it.
- Views: `BrainSourceView` (externalRef only for git and github, redacted config, newest receipt) and the kind, sync
  and receipts views; git sync codes map to the nearest source code.

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

- Input validation: `:projectId` against `BRAIN_PROJECT_REF_PATTERN`; `:sourceId` against `BRAIN_SOURCE_ID_PATTERN`
  on every route (else "", so source_not_found after the project check); `exactQuery`; strict zod bodies (kind
  pattern, label 1 to 300 characters without control characters, revision bounds, status); handlers parse configs.
- Error policy: only `BRAIN_API_ERRORS` and `BRAIN_FEATURE_ERRORS` codes; a missing, foreign or malformed project or
  source answers the same not-found code; unknown errors are logged by name and answer `brain_unavailable`.
- Credentials: none here; configs hold no tokens and the GitHub handler reads `MATRIX_BRAIN_GITHUB_TOKEN` per run.

## Integration wiring

- Startup: `startBrainServices` runs `bootstrapBrainSourceTables` (a failed group leaves only its kinds off), then
  `createBrainSourcesService`; `createBrainApiRoutes` mounts `createBrainSourcesRoutes` in place of the placeholder.
- Cross-package: none. Config injection: the late-bound integration and account lookups (unbound: integration kinds
  read `not_configured`), the Notes reader, chat repository and home path; no environment reads.

## Failure modes

- Timeouts: availability, account, adapter and option calls race a 10 s deadline (100 ms to 30 s when set); a passed
  deadline is `brain_unavailable` (`not_configured` in a list). The runner bounds a sync (20 pages, 20 s budget, 10 s
  per provider call; a started page finishes, 120 s at most). Store writes keep 5 s lock and 15 s statement deadlines.
- Concurrent access: one connect per kind and scope per process; across processes a create over the cap removes
  itself. Configs are saved in their source write's transaction; update, remove and a connect's repair of a missing
  config are compare-and-set on the revision (the repair rereads it after a rename or pause: 3 tries, then
  `source_conflict`). One sync per source per process; across processes the cursor compare-and-set decides.
- Crash recovery: a source and its config commit together; a crashed run's receipt is closed by the next run.
- Error propagation: a failed rollback is logged and the original error answers; a run that ended before a receipt
  is 409 `sync_in_progress`, 404 for a vanished source, a 200 failed view for a paused one (also one paused while
  its account was read), else 503. A git source not the project's is 409 `source_conflict`.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| sources read per scope; shown; config repair tries | 5 pages of 100; 50; 3 | `service.ts` |
| options per answer; option id, text, cursor | 100; 256, 200, 512 characters | `service.ts` |
| account labels; connect queue keys; running syncs | 51; 64; 16 | `registry.ts`, `runner.ts` |
| bodies; receipts per answer | 16 KiB connect and update, 1 KiB sync and remove; 50 | `routes.ts`, store |

No file is written; the queue drops a key when its connects settle. Third-party data flow: none from here.

## Invariants

- **Source of truth**: `brain_sources` and receipts, configs in each kind's table; documents only via the runner.
- **Lock/transaction scope**: one repository transaction per store write (core scope lock, then the kind's lock for
  its config write); no transaction spans a provider call.
- **Acceptable orphan states**: config rows of removed sources until the scope is erased.
- **Auth source of truth**: the request principal resolved to the caller's own project scope. **Deferred**: below.

## Integration test checkpoint

- `pnpm exec vitest run tests/gateway/brain-sources-*.test.ts` (every kind end to end) and `brain-store-postgres`.
- Manual (dev Docker stack): connect Matrix files for `docs`, sync until `nextAction` is empty, pause, remove.

## Code review checklist

- Every catch checks the error or logs its name; connect never leaves a live source without its config.
- Every route has `no-store`, the principal check, `exactQuery`, a strict schema and, when it mutates, `bodyLimit`.

## Delivery and evidence

- [ ] One PR (sources core, its tests and this spec), checks green, Invariants in the body.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`): connecting brain sources and what each kind reads.

## Deferred

Scheduled syncs; organization scopes; the Slack capture reader; option lookups for Linear teams, Drive folders and
calendars; a handler method for the reconnect rules; a Postgres test of two same-millisecond connects.
