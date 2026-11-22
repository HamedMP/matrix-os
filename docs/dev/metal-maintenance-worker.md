# Metal maintenance worker

Free metal VMs (spec 2691, ENG-520) depend on three platform background passes:

- **Sleeper**: suspends idle VMs (`MATRIX_FREE_TIER_SLEEP_ENABLED`).
- **Reaper** (`reconcileStale`): fails builds whose guest never registered and queues their teardown.
- **Drainer**: destroys queued VM teardowns on the hosts.

They run only in a process with background workers enabled. Cloud Run web replicas (preview and production) run with workers off, so these passes need a dedicated worker. Without it, free VMs never sleep and failed builds are never reaped.

## Worker role

`PLATFORM_ROLE=worker` runs the same platform image as a worker:

- every background worker is on (`shouldEnablePlatformBackgroundWorkers`);
- HTTP serves only `GET /health`, and every other path returns 404.

`PLATFORM_ROLE=web` is the default. Web replicas keep workers off on Cloud Run unless `PLATFORM_BACKGROUND_WORKERS_ENABLED=true`, which is the legacy production worker.

## Overlap safety

Each metal pass runs only while its transaction holds a Postgres advisory lock (`substrates/metal-singleton.ts`):

- `METAL_MAINTENANCE_LOCK_KEY` covers the reaper and drainer;
- `METAL_SLEEPER_LOCK_KEY` covers the sleeper.

A second worker instance, for example during a deploy overlap, skips the pass instead of running it twice. The lock is transaction-scoped, so a crashed worker releases it. The passes' own writes are guarded statements on other connections.

## Deployment

- **Preview** (`.github/workflows/preview-platform.yml`): when the deployed PR revision has `METAL_HOSTS_ENABLED`, the step "Deploy preview metal maintenance worker" renders `${CLOUD_RUN_PREVIEW_SERVICE}-worker`, i.e. `matrix-platform-preview-worker`:
  - built from that exact revision (image digest, env, secrets), using `scripts/render-platform-worker-service.mjs --role-worker`;
  - internal ingress, min and max 1 instance, CPU always allocated, never public;
  - labelled `matrix-preview-pr=<n>`.
  - Closing that PR deletes the worker.
- **Production** (`.github/workflows/platform-cloud-run.yml`): the existing dedicated worker (`<service>-worker`) switches to `PLATFORM_ROLE=worker` only when the repository variable `PLATFORM_WORKER_ROLE_ENABLED` is `true`. Until then, production is unchanged. Metal also needs the metal env on the production web revision, which the worker copies.

## Placement thresholds

`METAL_POOL_MAX_DATA_PERCENT` (default 85) and `METAL_POOL_MAX_METADATA_PERCENT` (default 80) set the thin-pool usage above which placement skips a host. They match hostd's own refusal.
