# Cloud Run Cutover Runbook

This note records the operating procedure for moving the Matrix OS platform
control plane from the legacy local Docker stack to managed Cloud Run and Neon.

Do not use this public repository to publish real customer handles, account
names, exact live fleet counts, private backup paths, hashes, revision names,
tunnel exposure state, benchmark snapshots, or current incident status. Keep
raw evidence in private operator notes.

## Scope

In scope:

- Platform control-plane API and auth routes on the public app/API/code domains.
- Host-bundle release metadata and VPS fleet deploy/read APIs.
- Managed PostHog/Neo proxy routing.
- Local Docker platform, proxy, auth-shell, and platform Postgres shutdown
  canaries.

Out of scope:

- Owner-controlled customer VPS Postgres databases. Those stay on each customer
  VPS by design.
- Matrix bridge spike containers and observability containers.
- Deleting old Docker volumes. Keep rollback data until the cutover has aged
  safely.

## Source Of Truth

After cutover, the platform control-plane database source of truth is Neon via
the production platform database secret in GCP Secret Manager.

Operator verification should confirm privately that:

- Cloud Run is serving the platform in cloud runtime mode.
- The platform database URL resolves from Secret Manager, not local Docker
  Postgres.
- Neon contains the expected release, billing, machine, integration, and channel
  metadata.
- Local Docker Postgres is treated as rollback/archive data only.

Do not run another blind local-Postgres-to-Neon migration after this point.
Local data may be stale and can overwrite newer Neon state.

## User Inventory

Clerk is the identity source of truth for the full auth user population.

The platform `users` table is a control-plane projection used by platform-owned
integration and provisioning flows. It should not be treated as the canonical
customer inventory. Use:

- `user_machines` for VPS/runtime inventory.
- `billing_customers` and entitlement tables for billing state.
- Clerk for the full auth user population.

When publishing docs publicly, describe table semantics without listing real
handles, emails, or exact live counts.

## Backup

Before stopping local Postgres, create a private custom-format dump and record
its checksum in a private operator system, not in this repository.

Example shape:

```bash
mkdir -p "$PRIVATE_BACKUP_DIR"
docker exec <local-postgres-container> \
  pg_dump -U <user> -d <database> --format=custom --no-owner --no-acl \
  > "$PRIVATE_BACKUP_DIR/platform-postgres.dump"
sha256sum "$PRIVATE_BACKUP_DIR/platform-postgres.dump"
```

Keep the dump and checksum private. Do not publish local paths or hashes in the
open-source repo.

## Cloudflare Routing

Production platform domains should route through the managed edge path, not the
legacy local platform containers.

Public documentation may describe the routing classes:

- app/API/code domains route through the edge router to Cloud Run.
- Neo/PostHog proxy traffic routes through the Neo worker.
- Legacy wildcard or local tunnel paths should fail closed unless explicitly
  supported.

Do not publish a live route inventory that reveals current tunnel exposure or
temporary incident state.

## Local Container Shutdown

After private backups and managed-service smokes pass, stop the legacy local
platform containers and then stop local platform Postgres.

Keep local volumes until rollback is no longer needed. Do not delete rollback
data during the cutover window.

## Smoke Checks

Run smokes privately after each phase:

- public app/API/code health endpoints
- auth and sign-up page rendering
- host-bundle release metadata
- authenticated fleet release API
- Neo health/static/service-worker endpoints
- expected fail-closed behavior for unsupported wildcard hosts

Do not publish exact live response counts, customer fleet counts, customer
handles, or authenticated API payloads.

## Benchmarking

Use a small smoke benchmark for operator confidence, not as a public performance
claim. Keep raw latency/RPS output in private operator notes unless it has been
aggregated and approved for public release.

## Staging And Grafana

Staging and observability surfaces must not remain publicly exposed without an
access layer.

Recommended plan:

1. Decide whether each non-production surface is still needed.
2. If not needed, close it and remove stale tunnel entries in a PR.
3. If staging is needed, move it to a separate dev/staging path with its own
   database secret and deployment lifecycle.
4. If Grafana or equivalent observability is needed, put it behind Cloudflare
   Access, VPN-only access, or another explicit access layer before exposing it.
5. After all non-platform routes are either closed or moved, stop the legacy
   tunnel.

Do not publish whether a sensitive internal surface is currently reachable.

## Rollback

If Cloud Run or Neon has a critical production failure, rollback is:

1. Start the archived local Postgres and platform services.
2. Move production routing away from the managed edge path.
3. Verify health privately.
4. Compare row freshness before restoring any local dump into Neon.

Rollback commands and current service names belong in private operator notes, not
public documentation.
