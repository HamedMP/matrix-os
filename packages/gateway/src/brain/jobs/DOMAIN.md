# Company Brain Background Runs

Queued, leased, resumable runs of the brain's bounded work (sync, extract, search and graph refresh, brief). Spec:
`specs/566-company-brain-background-runs/spec.md`.

## Scope

- Owns `brain_jobs` and everything under `jobs/`. Never reads or writes another brain table; the work itself is done
  by injected steps over the existing services (`steps.ts`).
- The kinds, statuses, views and the service shape are the shared contract `../contracts/jobs.ts`; `types.ts`
  re-exports them and adds the request schema (checked against the contract when typechecked), limits and steps.
- Wiring (spec 566 Wiring): `api/start.ts` bootstraps `brain_jobs` last, builds the service (`services.runs`) and one
  worker for the gateway's owner (the first entry of `services.jobs`, started by `server.ts` after the server
  listens and stopped first by `stopBrainServices`); `api/feature-routes.ts` mounts the routes; `api/erase.ts` calls
  `BrainJobStore.eraseScope` whenever `brain_jobs` exists.
- Out of scope: schedules that queue runs, and runs of owners other than the worker's (the service answers
  `job_kind_unavailable` for them, so clients run the work directly).

## Source Of Truth

- Owner Postgres, `brain_jobs`, primary key `(owner_id, scope_id, job_id)`. One queued or running run per
  `(owner_id, scope_id, kind, target)` (unique partial index `brain_jobs_active_slot`; enqueue inserts with
  `ON CONFLICT DO NOTHING` on it and then reads the existing run).
- Bounded: 100 active runs per owner, 50 finished runs per scope (pruned on enqueue), request at most 1 KiB, result
  summary at most 16 keys and 8 KiB as stored (`clipBrainJobSummary` counts the jsonb text's bytes and leaves out
  an entry that would pass them), attempts and steps capped by the worker ceilings (SQL CHECKs mirror them).
- In memory: only the worker's running runs (at most `concurrency`), one poll timer, and per run one abort
  controller, one heartbeat timer and one time-cap timer, all cleared when the run ends.

## Public API

- `index.ts`: `bootstrapBrainJobsDatabase`, `BrainJobStore`, `createBrainJobWorker`, `createBrainJobsService`,
  `createBrainJobsRoutes`, `createBrainJobSteps`, and the types and limits in `types.ts`.

## Auth And Trust Boundaries

- Routes use the shared guard in `api/feature-route-kit.ts` (principal, brain on, project ref shape); the service
  resolves the project through the shared resolver, so a run of another project or owner is `job_not_found`.
- Bodies are strict zod shapes per kind under a 1 KiB `bodyLimit`; job ids must match `^job_[a-f0-9]{32}$`.
- Clients see fixed messages only (the job codes are in the shared `BRAIN_FEATURE_ERRORS`). Step errors are stored
  as a code (`^[a-z][a-z0-9_]{0,63}$`, else `step_failed`) and logged by error name; no message, path or provider
  text is stored. Sync and extract summaries keep the pass's status, error code and next action word only; a search
  refresh with meaning search on adds that step's `embeddingTokens` and `embeddingCostMicroUsd`.

## Concurrency And Recovery

- Enqueue and erase take `pg_advisory_xact_lock(hashtext(ownerId), hashtext('brain-jobs'))`; worker writes are
  fenced by their claim instead (`status = 'running' AND lease_owner = <worker> AND attempts = <the claim's
  attempts>`), so a run whose lease was recovered writes nothing even after the same worker claimed the job again,
  and that worker stops the old run before it starts the new one. Claims use `FOR UPDATE SKIP LOCKED`.
- `heartbeatMs` is at most a third of `leaseMs` (a longer setting is shortened), so a healthy run's lease never
  expires between two heartbeats.
- Every write sets `lock_timeout = 5s` and `statement_timeout = 15s`; reads use `withBrainRead`.
- Expired leases are recovered on every poll: queued again, `attempts_exhausted` after `maxAttempts`, or cancelled
  when a cancel was asked. Shutdown hands running runs back as queued without counting the claim (cancelled when a
  cancel was asked), and also a run whose claim was in flight when stop() ran; that run's step never starts. A paid
  run (`kind = 'extract' AND target = 'model'`) is never queued again by either path: it ends `failed` with
  `interrupted`, so one confirmed model run never pays for a second pass.
- Steps are raced against the run's abort signal: the time cap, a cancel or shutdown ends the run at once even when
  the step ignores the signal; the extract and source sync steps also pass the signal on, so a model run makes no
  call after it and aborts the call in flight. The heartbeat timer stops renewing the lease once the run is aborted.
- Cancel of a running run records `cancel_requested`, then the service tells this gateway's worker
  (`BrainJobWorker.cancel`), which aborts the run at once; a run on another gateway stops at its next heartbeat. A
  run reads the flag (a heartbeat) before its first step, so a cancel that lands between its claim and its launch,
  when the worker has no run to abort yet, still ends it before any work. A recorded cancel always wins: finish,
  release and recovery all end the run `cancelled`, even when its last step had completed.
- A refresh step whose result has a `stopReason` (`embedding_unavailable`, `vector_cap`, `graph_capacity`) and is
  not caught up stops the run with that code, so a refresh that cannot progress is never run again 500 times.
- Busy answers (another run holds the same sync or extraction lock) are tried again every `retryDelayMs` until the
  time cap and are not steps; the run then fails with the busy code. The first busy answer of a wait is saved in the
  summary as `waiting` (with a heartbeat that also sees a cancel), so a client can say the run waits.
- With `brain_jobs` off and the brain on, the routes serve `BRAIN_JOBS_OFF` (POST is `job_kind_unavailable`, the list
  is empty, a run id is `job_not_found`), so clients fall back to the direct routes.
- A run whose row was erased mid-step finds its lease gone and writes nothing.

## Tests

`pnpm exec vitest run tests/gateway/brain-jobs-*.test.ts`; with `MATRIX_TEST_POSTGRES_URL` set,
`brain-jobs-postgres.test.ts` proves dedupe and claims across real connections. PGlite is one connection, so the
worker suite runs its database calls one at a time.
