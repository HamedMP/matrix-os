# Company Brain background runs

**Status:** Implementation target (runs layer of the brain stack; builds on specs 551 to 565)  
**Owner:** gateway `brain` domain (`brain/jobs/`)  
**Date:** 2026-10-02

## Outcome

A long sync, claim extraction, index refresh or brief no longer has to finish inside one HTTP request. The owner
queues a run, gets its id at once (202), and the gateway works through it in the background, one bounded step at a
time, until it is caught up, stops on an error code, is cancelled, or hits its time cap. A crashed gateway does not
lose runs: their leases expire and another claim picks them up.

## Scope

In scope: `brain/jobs/` (the `brain_jobs` table, the store, the worker, the service, the step adapters over the
existing services, the four routes), the contract part `contracts/jobs.ts` (kinds, statuses, views, the service
shape), the wiring listed under "Wiring" below, tests `tests/gateway/brain-jobs-*.test.ts`, this spec, and the public
documentation PR listed under "Public documentation" below.

Out of scope: a screen listing past runs and schedules that queue runs. The app's Sources screen already queues its
syncs and claim reading as runs and polls them (spec 563).

## Model

- Kinds: `sync` (optional `sourceId`; none means the project's git source), `extract` (`extractor` rules or model,
  default rules), `search_refresh`, `graph_refresh`, `brief` (`window` day or week, default day).
- Statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`. A run holds a slot `(scope, kind, target)` while
  queued or running; target is the source id (or `git`), the extractor, the window, or empty. Asking for a held slot
  returns the existing run with `deduped: true` (a unique partial index enforces it).
- Steps are injected: `BrainJobStep(context) -> { caughtUp, stopCode, summary }`. `createBrainJobSteps` builds them
  from the project service (sync, extract), the sources service, the search and graph indexes and the brief service;
  a kind whose service is off has no step and cannot be queued (`job_kind_unavailable`). A model extraction is
  paid, so its run does one pass and ends; the result's `caughtUp` says whether another run is needed. Steps pass the
  run's abort signal to the extract and source sync calls, so a cancel, the time cap or shutdown stops the model calls
  themselves (the call in flight is aborted). A refresh that cannot catch up (`stopReason`: `embedding_unavailable`,
  `vector_cap`, `graph_capacity`) stops the run with that code instead of being run again. Sync and
  extract summaries carry the pass's `status`, `errorCode` and `nextAction` (for example `connect_account` or
  `raise_budget`), so a client can say what to do about a failed run whose code is a source or extraction code. A
  search refresh with meaning search on adds that step's `embeddingTokens` and `embeddingCostMicroUsd`.
- One worker per gateway runs the runs of one owner (the gateway's owner, the same owner the daily brief builds
  for). A request of any other owner is `job_kind_unavailable`, since nothing would ever claim it; with no owner to
  run for, every kind is unavailable. The app then runs the work directly.
- Keep going: the worker runs a run's step again until `caughtUp`, or a `stopCode` (the run fails with it), or a step
  error (fails with the error's code, else `step_failed`). Busy codes (`sync_in_progress`, `extraction_in_progress`,
  `brain_unavailable`) mean another run holds the same lock (a rules and a model extract of one project, a git sync
  asked by default and by its source id, or a sync started over HTTP). They are tried again every `retryDelayMs`
  until the time cap and do not count as steps; a run that reaches the cap while waiting fails with the busy code.
  The first busy answer of a wait is saved in the summary as `waiting`, so a client can say the run is waiting.
  Caps: `jobWallClockMs` per claim (`time_limit`), `maxSteps` per run (`step_limit`).
- Each step is raced against the run's abort signal, so the time cap, a cancel and shutdown end the run at once even
  when the step ignores the signal. The step's service call then ends on its own budget, and the heartbeat timer
  stops renewing the lease once the run is aborted.
- Leases: a claim sets `lease_owner` and `lease_expires_at` (`leaseMs`) and adds one attempt; heartbeats every
  `heartbeatMs` and after every step renew it. Every worker write is fenced by `status = 'running' AND lease_owner =
  <worker>`, so a worker that lost its lease writes nothing. Each poll first recovers expired leases: queued again,
  or `failed` with `attempts_exhausted` after `maxAttempts` claims, or `cancelled` when a cancel was asked. A paid
  run (a model extract) is never queued again: it ends `failed` with `interrupted`, and the owner runs it again by
  choice, so one confirmed click never pays for a second pass.
- Concurrency: `concurrency` runs per gateway (default 2); claims use `FOR UPDATE SKIP LOCKED`, so two gateways never
  take the same run.
- Cancel: a queued run is cancelled at once; a running run gets `cancelRequested`, and the service tells this
  gateway's worker, which stops it at once. A run held by another gateway stops at its next heartbeat or step.
  Cancelling a finished run returns it unchanged.
- Shutdown: `stop()` aborts running steps and hands their runs back (queued, the claim not counted; `cancelled` when
  a cancel was asked; `failed` with `interrupted` for a paid run), waiting at most `stopWaitMs`. A claim still in
  flight when `stop()` runs is handed back the same way and its step never starts. Anything not handed back in time
  is recovered when its lease expires.
- Background runs off alone (`brain_jobs` failed to start while the brain is on): POST `.../jobs` answers 409
  `job_kind_unavailable`, the list is empty and a run id is `job_not_found`, so the app runs the work through the
  direct routes.
- Retention: at most 100 queued or running runs per owner (`jobs_full`); at most 50 finished runs per scope, older
  ones pruned on enqueue. The stored request is at most 1 KiB, the result summary at most 16 keys and 8 KiB.

## API

All under `/api/brain/projects/:projectId`, same guard as every brain route (principal, brain on, project ref shape),
`Cache-Control: private, no-store`, strict zod bodies under a 1 KiB `bodyLimit`, `exactQuery` for queries.

| Method | Path | Answer |
| --- | --- | --- |
| POST | `/jobs` | 202 `{ job, deduped }`; body is one strict shape per kind |
| GET | `/jobs?limit=` | 200 `{ jobs }`, newest first, limit 1 to 50 (default 20) |
| GET | `/jobs/:jobId` | 200 the run |
| POST | `/jobs/:jobId/cancel` | 200 the run; body empty or `{}` |

A run view is `{ jobId, projectId, kind, request, status, attempts, steps, cancelRequested, errorCode, result,
createdAt, startedAt, heartbeatAt, finishedAt, updatedAt }`. The lease owner never leaves the gateway.

Errors: the shared brain codes, plus `job_not_found` (404, also for a malformed job id or a run of another project),
`job_kind_unavailable` (409) and `jobs_full` (409), each with one fixed message.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| POST `/jobs`, GET `/jobs`, GET `/jobs/:jobId`, POST `/jobs/:jobId/cancel` | `authMiddleware`, `requireRequestPrincipal` through the feature route kit | the principal's own project through `BrainProjectResolver`; scope `personal:project:<id>`; a run of another project or owner is `job_not_found` | fixed bodies: shared brain codes plus the three job codes |
| Worker | server code, no request | the claimed row's `(owner_id, scope_id)` and project id; steps call the services as that owner | stored as a code, logged by name |

- Input validation: project ref pattern; job id `^job_[a-f0-9]{32}$`; one strict zod shape per kind under a 1 KiB
  `bodyLimit`; `exactQuery` for `limit` (1 to 50); the stored request is re-checked against 1 KiB by a SQL CHECK.
- Error policy: clients see `{ error: { code, message } }` with fixed text only. A step error is stored as its code
  when it matches `^[a-z][a-z0-9_]{0,63}$`, else `step_failed`; its message, paths and provider text are never stored
  or returned, only its error name is logged.
- Credentials: none. A run never stores or logs a token or key; a model extraction step uses the same per-request
  credential read as `POST /extract`.

## Failure modes

- Timeouts: every store write sets `lock_timeout = 5s` and `statement_timeout = 15s`; reads use the 10 s read
  deadline. A run stops at `jobWallClockMs` per claim (`time_limit`) and `maxSteps` (`step_limit`); a step that
  ignores its signal is left behind when the run's signal aborts.
- Lease expiry: a crashed or stopped gateway leaves `running` rows whose lease expires after `leaseMs`; the next poll
  of any gateway queues them again, fails them with `attempts_exhausted` after `maxAttempts`, cancels them when a
  cancel was asked, or fails a paid run with `interrupted`.
- Stop wait: `stop()` aborts running steps, hands their runs back as queued (cancelled, or `interrupted` when paid)
  and waits at most `stopWaitMs`; what is not handed back in time is recovered by lease expiry.
- Step error: the run fails with the step's code; busy codes wait and retry until the time cap instead.
- Concurrency: one active run per `(scope, kind, target)` by a unique partial index; claims use
  `FOR UPDATE SKIP LOCKED`; every worker write is fenced by `status = 'running' AND lease_owner = <worker>`.
- A run whose row was erased mid-step finds its lease gone and writes nothing.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| active runs per owner (queued or running) | 100 (`jobs_full`) | store, under the owner lock |
| finished runs kept per scope | 50, older pruned on enqueue | store |
| request / result summary | 1 KiB / 16 keys, 40-character keys, 200-character strings, 8 KiB | zod, SQL CHECK, `clipBrainJobSummary` |
| runs at once per gateway | 2 (ceiling 8) | worker |
| lease / heartbeat / poll / wall clock per claim | 60 s / 15 s / 5 s / 15 min (ceilings 10 min / 5 min / 5 min / 60 min) | worker |
| steps per run / claims per run | 500 / 3 (ceilings 5,000 / 10) | worker, SQL CHECK |
| list page | 1 to 50, default 20 | route, store |
| in memory | the running runs (at most `concurrency`), one poll timer, per run one abort controller, one heartbeat and one time-cap timer, all cleared when the run ends | worker |

## Invariants

- **Source of truth**: `brain_jobs` in owner Postgres; nothing about a run lives only in memory, so any gateway can
  pick up an expired run.
- **Lock/transaction scope**: enqueue and erase take `pg_advisory_xact_lock(hashtext(ownerId),
  hashtext('brain-jobs'))`; cancel is one statement fenced by status; every worker write is one statement fenced by
  the lease (`status = 'running' AND lease_owner = <worker>`), so a worker that lost its lease can never overwrite
  the run.
- **Acceptable orphan states**: a `running` row of a dead gateway until its lease expires; finished runs beyond the
  newest 50 per scope until the next enqueue prunes them; runs of an erased project never (the erase deletes them).
- **Auth source of truth**: the request principal resolved to its own project scope; the worker acts only as the
  owner stored on the row.
- **Deferred scope**: listed below.

## Wiring

- `startBrainServices` (`api/start.ts`) bootstraps `brain_jobs` last in `BRAIN_BOOTSTRAP_ORDER` (after brief); a
  failure leaves only runs off (`services.runs` null, the four routes 503 `brain_unavailable`).
- It builds `BrainJobStore`, `createBrainJobSteps` over the project service wrapped with change events (so a queued
  sync or extract emits `documents_changed` or `claims_changed` like a request does), the sources service, the
  search and graph indexes and the brief service, one `createBrainJobWorker` for the schedule owner (concurrency 2 by
  default, at most 8), and `createBrainJobsService({ store, resolver, kinds, wake, workerOwnerId })`. The service is
  `services.runs`; the worker is the first entry of `services.jobs`.
- `createBrainApiRoutes` mounts `createBrainJobsRoutes` under `/api/brain`; `BRAIN_ROUTES` lists the four `/jobs`
  routes (owner `jobs`, `POST .../jobs` answers 202, `BRAIN_ROUTE_ACCEPTED_PATHS`), and `job_not_found`,
  `job_kind_unavailable` and `jobs_full` are part of `BRAIN_FEATURE_ERRORS`.
- `server.ts` starts every entry of `services.jobs` after the server listens; `stopBrainServices` stops the worker
  first (it hands its runs back), then the other jobs, then drains the hooks, before the owner database closes.
- Project erase: `api/erase.ts` calls `store.eraseScope(scope)` when the table exists.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-jobs-*.test.ts` (PGlite and fakes; no network, no model calls).
`MATRIX_TEST_POSTGRES_URL=<disposable server>` also runs `brain-jobs-postgres.test.ts`: concurrent enqueue dedupe,
claims across connections and two workers running every run exactly once. `brain-start.test.ts` queues a run through
the mounted routes and the worker the services start, and checks the stop order. Manual (dev Docker stack):
`POST .../jobs {"kind":"sync"}` answers 202 with a queued run, `GET .../jobs/:jobId` moves to `running` then
`succeeded` with a summary, a second POST while it runs answers `deduped: true`, and restarting the gateway mid-run
hands the run back at once (queued again, or `interrupted` for a model extract); a killed gateway's run is queued
again after its lease expires.

## Code review checklist

Every worker write is fenced by the lease; every list, loop, timer and map is bounded and cleared; no `catch {`;
stored codes match the code pattern; bodies are strict zod under `bodyLimit`; no new dependency and no model call
outside the existing extract step.

## Public documentation

A separate PR in the private `FinnaAI/matrix-os-site` repository under `content/docs/` documents background runs for
users: queueing a sync, claim reading, refresh or brief as a run, following it to its end, cancelling it, what
`deduped` means, the time and step caps, and why an interrupted model extraction is never re-run on its own (run it
again by choice). It ships with the brain stack's app screens (spec 563), carries no customer data, hostnames or
credentials, and is a deliverable of this spec alongside the tests and the implementation.

## Deferred

A screen listing past runs, schedules that queue runs, runs of owners other than the gateway's owner, and
organization scopes.
