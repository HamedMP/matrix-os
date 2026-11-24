# Metal maintenance worker

Free metal VMs (spec 2691, ENG-520) depend on three platform background passes:

- **Sleeper**: suspends idle VMs (`MATRIX_FREE_TIER_SLEEP_ENABLED`).
- **Reaper** (`reconcileStale`): fails builds whose guest never registered and queues their teardown.
- **Drainer**: destroys queued VM teardowns on the hosts.

They run only in a process with background workers enabled. Cloud Run web replicas (preview and production) run with workers off, so these passes need a dedicated worker. Without it, free VMs never sleep and failed builds are never reaped.

## Worker role

`PLATFORM_ROLE=worker` runs the same platform image as a worker:

- background workers are on;
- HTTP serves only `GET /health`, and every other path returns 404;
- every WebSocket upgrade is refused with 404.

`PLATFORM_WORKER_SCOPE` narrows a worker:
- `all` (the default) runs every background worker;
- `metal` runs only the sleeper, reaper and drainer. It is preview-only: a revision without `PLATFORM_PREVIEW=true` fails startup with it. The preview worker uses `metal`, so PR code never runs the other reconcilers against the shared preview database.

`PLATFORM_ROLE=web` is the default. Web replicas keep workers off on Cloud Run unless `PLATFORM_BACKGROUND_WORKERS_ENABLED=true`, which is the legacy production worker.

## Overlap safety

Each metal pass runs only while its transaction holds a Postgres advisory lock (`substrates/metal-singleton.ts`):

- `METAL_MAINTENANCE_LOCK_KEY` covers the reaper and drainer;
- `METAL_SLEEPER_LOCK_KEY` covers the sleeper.

A second worker instance, for example during a deploy overlap, skips the pass instead of running it twice. The lock is transaction-scoped, so a crashed worker releases it. The passes' own writes are guarded statements on other connections.

Known limits:
- The lock transaction stays idle in transaction for the whole pass and pins one pool connection.
- A hung pass holds the lock until the instance restarts (Cloud Run runs one worker instance).
- If the server or a pooler enforces `idle_in_transaction_session_timeout`, or the connection drops mid-pass, the lock is released while the pass continues, and an overlapping instance could run the same pass. Every pass write is a guarded, idempotent statement, so such an overlap is safe but wasted.

## Deployment

- **Preview** (`.github/workflows/preview-platform.yml`): when the deployed PR revision has both `METAL_HOSTS_ENABLED` and `MATRIX_FREE_TIER_SLEEP_ENABLED`, the step "Deploy preview metal maintenance worker" renders a worker for that PR, `${CLOUD_RUN_PREVIEW_SERVICE}-worker-pr<n>`:
  - built from that exact revision (image digest, env, secrets), using `scripts/render-platform-worker-service.mjs --role-worker --metal-scope`;
  - internal ingress, min and max 1 instance, CPU always allocated, never public.
  - A redeploy without metal or the sleeper deletes that PR's worker, and so does closing the PR. gcloud listing errors fail the step rather than leaking a worker.
  - The renderer allows the relaxed contract and the metal scope only for a revision with `PLATFORM_PREVIEW=true`.
- **Production** (`.github/workflows/platform-cloud-run.yml`): the existing dedicated worker (`<service>-worker`) switches to `PLATFORM_ROLE=worker` (all scope) only when the repository variable `PLATFORM_WORKER_ROLE_ENABLED` is `true`. The verify step checks that the deployed role matches the variable. Until then, production is unchanged. Metal also needs the metal env on the production web revision, which the worker copies.

## Placement thresholds

`METAL_POOL_MAX_DATA_PERCENT` (default 85) and `METAL_POOL_MAX_METADATA_PERCENT` (default 80) set the thin-pool usage above which placement skips a host. They match hostd's own refusal.
