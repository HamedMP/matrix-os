# 070: VPS-per-User Architecture

## Overview

Replace container-per-user-on-shared-host with **one Hetzner VPS per user**. Each user's compute, storage, and Postgres live on their own machine. Durable state mirrors to R2. The control plane stops being a workload host and becomes purely a provisioner + router.

This is the architecture Matrix OS has been pointing at since the "personal cloud computer" framing: a coding agent that can run arbitrary repos, Docker stacks, databases, and preview servers needs a real VM boundary, not a shared Docker host. Container-per-user always had a docker-in-docker problem; VPS-per-user makes it disappear.

**Phase 1 scope (this spec):** provision + backup + recovery. No sleep, no idle deletion, no warm pools. Each provisioned VPS stays up. R2 backup exists so a destroyed/corrupted VPS can be reconstructed.

**Out of scope (future specs):** idle suspend → R2 → delete cycle, warm pool, per-user Hetzner Volume for DB, geographic distribution.

## Relationship to Other Specs

- **Supersedes 055 (deployment-scaling).** The old direction was multi-node-with-containers + control plane. This spec replaces it with VPS-per-user.
- **Depends on 066 (file-sync).** R2 manifest format, presigned URL flow, sync daemon all carry over. This spec extends 066's R2 layout with `system/` prefixes for DB snapshots and VPS metadata.
- **Compatible with 067 (cli-signup).** CLI device-code flow lands users in their VPS the same way it lands them in a container today.

## Goals

- One Hetzner VPS per user, in a dedicated Hetzner project ("matrix-os-customers"), separate from the control-plane VPS.
- Provision on first real use (lazy), not at signup.
- Postgres runs inside the user's VPS as a container. One DB per user.
- R2 holds the canonical recoverable state: home + projects + DB snapshots + VPS metadata.
- VPS destroyed or unreachable → reprovision from R2 with one command, deterministic.
- Existing `matrixos-*` containers on the control-plane VPS keep running. New users go to VPS. No forced migration in phase 1.

## Non-Goals

- Sleep / suspend / idle deletion. Out of scope; addressed in a follow-up spec once provision + backup is stable.
- Migrating existing container-based users in this phase. They stay on the current host until their first opt-in or eventual scheduled move.
- Live migration between VPSes. Recovery means reprovision-from-backup, not move-in-place.
- Per-region routing or multi-DC. Single Hetzner DC (same as control plane) for phase 1.
- Direct user SSH to the VPS. Access goes through the platform shell. SSH for support is a separate access path.

## Architecture

### Topology

```
Cloudflare DNS
   {handle}.matrix-os.com -> tunnel -> control-plane VPS

Control-plane VPS (this box, Hetzner project "matrix-os-infra")
   platform:9000      orchestrator, provisioner, router
   proxy:8080         shared API proxy
   conduit:6167       Matrix homeserver
   cloudflared        tunnel
   postgres           machine + container registry via Kysely
   (legacy)           existing matrixos-* containers keep running

Customer VPSes (Hetzner project "matrix-os-customers", one per user)
   matrix-os-host services (gateway, shell, agent runtime) -- systemd
   docker engine                                            -- host
   postgres:16          container, one DB for this user     -- docker
   user app containers                                      -- docker
   sync-agent           pulls/pushes R2                     -- systemd
   db-backup            pg_dump on schedule + on demand     -- systemd timer

Cloudflare R2 (existing matrixos-sync bucket, extended layout)
   {userId}/manifest.json
   {userId}/files/...                          (per spec 066)
   {userId}/system/db/snapshots/<ts>.dump      (NEW)
   {userId}/system/db/latest                   (NEW, pointer to newest snapshot key)
   {userId}/system/vps-meta.json               (NEW)
```

### Why services-on-host instead of Matrix-in-a-container

On the user's own VPS, the gateway and shell run as systemd services on the host, not inside another container. User workloads use Docker normally (no nesting). This is the whole point of the VPS-per-user move: stop fighting Docker-in-Docker.

The control-plane VPS keeps its current Docker-Compose layout (platform, proxy, conduit, cloudflared) — that's not user-facing compute, it's the operator's own stack.

### Why Postgres on the user's VPS

- Per-user DB host re-introduces multi-tenancy and shared-fate, defeating the model.
- Recovery is uniform: one R2 prefix per user, one restore path.
- Phase 1 has no sleep, so "DB outlives VPS" is not yet a requirement. When it becomes one, the next step is a Hetzner Volume attached to the user's VPS — still per-user, just on persistent block storage. Not a centralized DB host.
- `pg_dump` is the backup unit. Suitable until per-user DBs exceed ~5 GB compressed, at which point we revisit (WAL archiving, or volume-attached persistence).

## R2 Layout

Extends spec 066's `matrixos-sync/{userId}/` layout.

```
matrixos-sync/{userId}/
  manifest.json                    # 066: file manifest (home + projects)
  files/...                        # 066: content-addressed file objects
  system/
    vps-meta.json                  # provision metadata, image version, last seen
    db/
      snapshots/2026-04-26T1200Z.dump
      snapshots/2026-04-26T1800Z.dump
      ...
      latest                       # tiny file containing the newest snapshot key
```

`system/vps-meta.json`:

```json
{
  "version": 1,
  "userId": "user_2x...",
  "hetznerServerId": 12345678,
  "imageVersion": "matrix-os-host-2026.04.26-1",
  "provisionedAt": "2026-04-26T10:00:00Z",
  "lastSyncAt":   "2026-04-26T18:05:00Z",
  "publicIPv4":   "1.2.3.4"
}
```

Retention for DB snapshots in phase 1: keep last 24 hourly + last 14 daily. Cleanup is a job on the user's VPS, not control plane.

## Components

### 1. VPS image (cloud-init for phase 1)

Provisioning model: **cloud-init from a base Ubuntu 24.04 image**, not a Hetzner snapshot. Reasons:

- Reproducible from text. Snapshot drift is invisible; cloud-init drift is in git.
- ~60s slower to boot than a snapshot, irrelevant for phase 1 (no sleep, provision is one-time per user).
- When boot latency starts mattering, we bake the cloud-init output into a snapshot — a mechanical conversion, not a redesign.

The cloud-init recipe lives at `distro/customer-vps/cloud-init.yaml`. It:

1. Creates `matrix` system user.
2. Installs Docker engine + compose plugin (apt, official repo).
3. Pulls the matrix-os-host bundle (a tarball published to R2 by CI, not a Docker image — the host services aren't containerized).
4. Installs systemd units: `matrix-gateway.service`, `matrix-shell.service`, `matrix-sync-agent.service`, `matrix-db-backup.timer`.
5. Pulls `postgres:16` and starts it via a small compose file (`/opt/matrix/postgres-compose.yml`) with a named volume.
6. On first boot, calls back to control plane (`POST /vps/register`) with its public IP, server ID, image version. Control plane updates `userMachines` row to `running`.
7. If `system/db/latest` exists in R2, sync-agent restores DB before gateway starts (gateway start is gated on `matrix-restore-complete` flag file).

Image version is a date-stamped tag (`2026.04.26-1`). Bumping it requires reprovisioning to apply, which is fine in phase 1 — there are few VPSes and reprovision is the recovery path anyway.

### 2. Provisioner (control plane)

New module: `packages/platform/src/customer-vps.ts`. Talks to the Hetzner Cloud API.

API surface (internal, behind `PLATFORM_SECRET`):

- `POST /vps/provision` `{ clerkUserId }` — creates Hetzner VPS, writes `userMachines` row in `provisioning`, returns `{ machineId, status: "provisioning" }`. Idempotent on `clerkUserId`.
- `POST /vps/register` `{ machineId, publicIPv4, imageVersion }` — called by the VPS itself on first boot. Flips status to `running`, writes `vps-meta.json` to R2.
- `POST /vps/recover` `{ clerkUserId }` — destroys the existing VPS (if any), creates a new one with the same cloud-init, sync-agent restores from R2 on boot.
- `GET /vps/:machineId/status` — returns row + last-seen timestamp.
- `DELETE /vps/:machineId` — Hetzner API delete + soft-delete in registry. **Phase 1: admin-only, never automatic.**

Hetzner config:
- Server type: `cpx22` (small shared-vCPU shape, currently orderable in fsn1/nbg1). Bigger types (cpx31/41) on request.
- Location: `nbg1` (same DC as control plane).
- SSH keys: a single `matrix-ops` key uploaded to the customer project for support access. No per-user keys in phase 1.
- Image: `ubuntu-24.04`.
- `user_data`: rendered `cloud-init.yaml` with the user's `clerkUserId` and a one-time registration token interpolated.
- Firewall (Hetzner-managed): inbound 22 from ops IPs, 443 from Cloudflare IP ranges, deny everything else. No public Postgres.

### 3. Routing

Phase 1: **control-plane reverse proxy**, not per-user cloudflared tunnels.

```
app.matrix-os.com / code.matrix-os.com
  -> Cloudflare
  -> control-plane cloudflared tunnel
  -> platform:9000 session router
  -> reverse_proxy to userMachines.publicIPv4:443
```

The platform session router resolves the authenticated Clerk user to a `userMachines` row. If that row is `running`, `app.matrix-os.com` and `code.matrix-os.com` requests route to that user's VPS; otherwise the router falls back to the existing container path. New users: only the VPS branch ever fires.

Cloud coding uses one shared public hostname: `https://code.matrix-os.com/?folder=/home/matrixos/home`. The control plane authenticates the user, strips Clerk/code-server cookies before forwarding, attaches platform proof headers to the customer VPS gateway, and pins a short-lived `matrix_code_session` cookie so code-server static assets and websocket reconnects can stay on the correct VPS without per-user DNS.

TLS between control plane and customer VPS: customer VPS has a cert acceptable to the control-plane HTTPS client for the central routed hostnames, issued during provisioning. Alternative for phase 1 if public CA issuance is slow on first boot: control plane → customer VPS over a Hetzner private network with a self-signed cert + pinned fingerprint stored in `userMachines`. Decision deferred to implementation, defaulting to HTTPS with hostname verification.

Per-user cloudflared tunnels (each VPS gets its own tunnel ID, DNS CNAME points directly) are the upgrade path when control-plane bandwidth becomes a concern. Not now.

### 4. Sync agent (customer VPS)

Reuses the spec 066 sync engine. Runs as `matrix-sync-agent.service`. Two responsibilities:

- **Files**: bidirectional sync of `~/home` and `~/projects` against `{userId}/manifest.json`, exactly per 066.
- **System state**: pushes `system/vps-meta.json` heartbeat every 5 min, updates `lastSyncAt`. DB backup goes through `matrix-db-backup.timer` (separate unit) but writes into the same R2 prefix.

On boot, sync agent runs a **restore-or-fresh** decision:
1. Fetch `system/vps-meta.json`. If absent: fresh user, mark complete, signal gateway to start.
2. If present, check `system/db/latest`. If absent: file-only user, sync files, signal gateway.
3. If both present: stop postgres if running, download latest snapshot, `pg_restore`, write `/var/run/matrix-restore-complete`, signal gateway.

Gateway systemd unit has `ConditionPathExists=/var/run/matrix-restore-complete` so it cannot serve traffic mid-restore.

### 5. DB backup (customer VPS)

`matrix-db-backup.timer` runs every hour:

```
pg_dump --format=custom --file=/var/lib/matrix/db/snapshots/<ts>.dump matrix
matrixctl r2 put system/db/snapshots/<ts>.dump
matrixctl r2 put system/db/latest <ts>.dump
```

`matrixctl` is a small binary on the host (Go or shell + AWS CLI compatible — R2 is S3-compatible).

On-demand backup endpoint on the gateway: `POST /system/backup` triggers the same script and waits for upload completion. Useful before risky operations.

### 6. Schema changes (control plane)

New table managed by Kysely/PostgreSQL migrations in `packages/platform/src/db.ts`:

```ts
await db.schema.createTable('user_machines')
  .addColumn('machine_id', 'text', (col) => col.primaryKey())
  .addColumn('clerk_user_id', 'text', (col) => col.notNull().unique())
  .addColumn('handle', 'text', (col) => col.notNull())
  .addColumn('hetzner_server_id', 'integer')
  .addColumn('public_ipv4', 'text')
  .addColumn('public_ipv6', 'text')
  .addColumn('status', 'text', (col) => col.notNull())
  .addColumn('image_version', 'text')
  .addColumn('provisioned_at', 'text', (col) => col.notNull())
  .addColumn('last_seen_at', 'text')
  .addColumn('deleted_at', 'text')
  .execute();
```

`containers` table is **kept** for legacy users. No changes. Routing chooses between `userMachines` and `containers` based on which row exists for the user.

## Lifecycles

### First provision (new user)

1. User signs in (Clerk). Server creates Clerk record. **No VPS yet.**
2. User opens shell or runs first CLI command. Gateway hits `POST /vps/provision`.
3. Provisioner creates Hetzner server, writes `userMachines` row in `provisioning`. Responds with `{ status: "provisioning", eta: "~60s" }` to the client. Client renders a "your machine is being prepared" UI.
4. Cloud-init runs on the new VPS (~60–90s).
5. Sync agent on the VPS finds no `vps-meta.json` (fresh user), signals gateway.
6. Gateway starts, calls `POST /vps/register`. Control plane flips status to `running`, writes `vps-meta.json` to R2.
7. Client polls `GET /vps/:machineId/status` (or receives a WebSocket notification) and routes the user in.

### Steady-state operation

- User's gateway/shell run on their VPS. Control plane proxies traffic.
- Sync agent runs continuously (file sync per 066).
- DB backup timer fires every hour.
- Heartbeat updates `lastSeenAt` every 5 min on the control plane.

### Recovery (VPS unreachable or destroyed)

Manually triggered in phase 1 — no auto-detect-and-reprovision.

```
matrixctl recover {handle}
  -> POST /vps/recover
```

Sequence:
1. Control plane verifies user has a `system/db/latest` in R2 (refuse otherwise unless `--allow-empty`).
2. Provisioner deletes the old Hetzner server (if it exists). `userMachines.status -> recovering`.
3. New server created with same cloud-init. Same `clerkUserId`, new `machineId`.
4. On first boot, sync agent finds existing `vps-meta.json` and `system/db/latest` → restore path.
5. Gateway starts, calls `/vps/register`, status flips to `running`.

Recovery time target: ~3 minutes for a fresh-ish user (small DB, modest project tree). Document this. If it grows, that's the signal to introduce Hetzner Volumes.

### Update (new image version)

Phase 1: no in-place update of running VPSes. To roll out a host-services bump, run `matrixctl recover {handle}` per user during a maintenance window. Cloud-init pulls the new bundle automatically.

Once we have ~10+ customer VPSes this becomes painful and we add an in-place update path (separate spec). For now, recover-as-update is acceptable because we have ~0 customer VPSes today.

## Phasing

**Phase 1.0 — provisioner + image (no R2 yet)**
- Hetzner customer project + API token in control-plane env.
- `userMachines` table + Kysely/PostgreSQL migration.
- `customer-vps.ts` provisioner module + `/vps/*` routes (admin-only behind `PLATFORM_SECRET`).
- `distro/customer-vps/cloud-init.yaml` that installs Docker + Postgres + a placeholder gateway.
- Manual test: `curl -X POST localhost:9000/vps/provision -d '{"clerkUserId":"test"}'` creates a real VPS, comes up, registers, status flips to `running`. Tear down by hand.

**Phase 1.1 — host services + routing**
- Bundle the gateway + shell into a tarball published to R2 by CI on each main merge.
- Cloud-init pulls and installs as systemd units.
- Subdomain router branch in `profile-routing.ts`.
- TLS via Let's Encrypt on first boot.
- End-to-end test: provisioned VPS responds at `{handle}.matrix-os.com`.

**Phase 1.2 — R2 sync + DB backup**
- Sync agent systemd unit, restore-or-fresh boot logic.
- `matrix-db-backup.timer` + `matrixctl` shim.
- `system/vps-meta.json` heartbeat.
- `POST /system/backup` endpoint.

**Phase 1.3 — recovery**
- `matrixctl recover` admin command.
- Restore path verified end-to-end: provision, write data, simulate destruction, recover, verify data.
- Document RTO (recovery time) and what's restored vs not.

**Phase 1.4 — first real customer**
- One opt-in user moves to a VPS. Existing users untouched.
- Watch for a week. Iterate.

After phase 1 stabilizes, phase 2 (separate spec) covers idle suspend, R2-then-delete, warm pool, and migration of existing container users.

## Open Questions

- **Cloudflare per-VPS hostnames vs LE on the VPS.** Issuing LE on first boot adds 5–15s. Alternative: Cloudflare Origin Certificates (15-year, free, no boot dependency) issued by control plane and injected via cloud-init. Probably the right answer, defer until phase 1.1.
- **Hetzner project quota.** Default per-project server limit is ~10. File a quota raise to ~100 before phase 1.4. Note ceiling in `userMachines` provisioner so we degrade gracefully.
- **Cost ceiling.** cpx22 is the default small shape. Re-evaluate the monthly ceiling at 50 active users before broad rollout.
- **Backup verification.** A snapshot we can't restore is worse than no snapshot. Add an automated nightly job on a throwaway VPS that picks a random user, restores their DB, runs sanity SQL, reports OK/FAIL. Probably phase 1.3.
- **Support SSH access.** Single `matrix-ops` key shared across all VPSes is operationally simple but a blast-radius issue. Consider per-VPS short-lived certs (Hetzner Cloud SSH or a small CA) before phase 2.
- **Existing container migration.** Out of scope for this spec, but: do we eventually move users, deprecate the old path on a date, or grandfather forever? Decide before phase 2 begins.

## Risks

- **R2 sync correctness is load-bearing.** Phase 1 doesn't delete anything, so the worst case here is "data not yet uploaded when VPS dies." Mitigated by hourly DB backups + continuous file sync. Become much more dangerous in phase 2 when delete-after-sync is real.
- **Cloud-init drift.** A `apt-get install` step that installed v1.2 last month silently installs v1.3 today. Pin every package version in `cloud-init.yaml`. Any unpinned version is a future "works on my machine" incident.
- **Provisioner failure mid-create.** A row in `provisioning` with no Hetzner server (or vice versa). Reconciliation job: every 5 min, walk `provisioning`+`recovering` rows older than 10 min, ask Hetzner what state the server is in, reconcile or mark `failed`.
- **TLS hostname mismatch.** `{handle}.matrix-os.com` cert + control-plane proxy + customer VPS public IP — three places hostname can be wrong. Add an end-to-end smoke test that hits the public URL on every provision.
