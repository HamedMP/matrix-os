# Research: VPS-per-User Architecture

## Decision: Use cloud-init from Ubuntu 24.04 for phase 1

**Rationale**: Cloud-init keeps the VPS image reproducible as text in git and avoids invisible snapshot drift. The spec accepts one-time lazy provisioning, so the extra boot time compared with a baked snapshot is not phase 1 critical.

**Alternatives considered**:
- Hetzner snapshot image: faster boot, but hidden drift and harder reviewability.
- Full image build with mkosi/Packer now: stronger reproducibility, but unnecessary before the bootstrap contract stabilizes.

## Decision: Control plane owns provisioning state in SQLite `user_machines`

**Rationale**: Platform already owns container provisioning, Clerk identity, profile routing, and internal sync integration. A Drizzle-managed SQLite table matches existing control-plane registry patterns and keeps the customer-VPS registry separate from user app data.

**Alternatives considered**:
- Store machine metadata only in R2: recoverable, but poor for routing and status queries.
- Store in Postgres/Kysely: app/social data store is not the control-plane source of truth for machine lifecycle.

## Decision: Hetzner API integration uses a small typed client over `fetch()`

**Rationale**: The feature only needs create, get, delete, firewall/network metadata, and optional SSH-key lookup. Native `fetch()` with strict schemas, explicit timeouts, and generic error mapping avoids adding a dependency before the API surface is broad.

**Alternatives considered**:
- Third-party Hetzner SDK: reduces boilerplate but adds dependency surface and may hide timeout/error behavior.
- Shelling out to `hcloud`: harder to validate, harder to mock in tests, and introduces CLI installation assumptions.

## Decision: Registration uses one-time provision tokens

**Rationale**: `/vps/register` is called by a newly booted VPS before it can have durable local identity. A one-time token generated during provisioning, embedded in cloud-init, hashed in the control-plane row, and consumed on first registration gives a narrow bootstrap credential. Constant-time comparison is mandatory.

**Alternatives considered**:
- Trust Hetzner server ID only: server IDs are not secret.
- Reuse `PLATFORM_SECRET` on every VPS: unacceptable blast radius if one customer host is compromised.

## Decision: Default phase 1 routing is control-plane reverse proxy to customer VPS HTTPS

**Rationale**: This preserves the existing Cloudflare tunnel while moving user resolution into the control-plane session router. `app.matrix-os.com` and the shared `code.matrix-os.com` hostname authenticate centrally, resolve Clerk identity to a running `userMachines` row, and forward to that user's VPS HTTPS gateway. It keeps per-user cloudflared tunnels and per-user code DNS out of phase 1 while customer count is low.

**Alternatives considered**:
- Per-user cloudflared tunnels: better bandwidth scaling later, but more moving parts and tunnel credential lifecycle.
- Direct DNS A/AAAA records to VPSes: simpler data path, but exposes more DNS automation and certificate issuance concerns immediately.
- Per-user code subdomains: no longer used; a single `code.matrix-os.com` entrypoint avoids DNS churn and lets the platform choose the correct VPS from the authenticated session.

## Decision: Use Cloudflare Origin Certificates for phase 1.1 if Let's Encrypt boot issuance is unreliable

**Rationale**: The spec defaults to Let's Encrypt but flags the boot dependency. The implementation should start with LE if it is easy to automate and smoke-test; if first-boot flakiness appears, switch to control-plane-issued Cloudflare Origin Certificates injected by cloud-init. Either path keeps TLS between control plane and customer VPS.

**Alternatives considered**:
- Self-signed certificate with pinned fingerprint: avoids public CA dependency but adds fingerprint storage, rotation, and more custom verification code.
- Plain HTTP over private network: rejected for phase 1 unless a private-network TLS plan is also in place.

## Decision: Customer Postgres remains a container with a Docker named volume

**Rationale**: The user's own VPS removes Docker-in-Docker, so Postgres as a container is straightforward and keeps install/update behavior predictable. Phase 1 backup/recovery uses `pg_dump` to R2; volume durability across VPS destruction is a future phase.

**Alternatives considered**:
- Host-installed Postgres: fewer containers, but more host package/version management.
- Central Postgres host: violates the per-user isolation model.
- Hetzner Volume now: better persistence, but out of scope until sleep/delete and larger DBs require it.

## Decision: DB snapshots use custom-format `pg_dump` compressed to R2

**Rationale**: Per-user DBs are expected to be small in phase 1. A scheduled `pg_dump` plus `latest` pointer is simple to restore, easy to inspect operationally, and compatible with the recovery target.

**Alternatives considered**:
- WAL archiving: stronger point-in-time recovery but more operational complexity.
- Filesystem/block snapshots: faster for large DBs, but require volume/snapshot orchestration not needed for first users.

## Decision: Retention is enforced on the customer VPS

**Rationale**: Backup creation and pruning are local host responsibilities; the control plane should not become a background worker for every user's snapshots. The retention policy is capped: last 24 hourly plus last 14 daily.

**Alternatives considered**:
- Control-plane R2 cleanup job: centralizes operations but creates more cross-user blast radius and scheduling state.
- R2 lifecycle rules only: useful later, but cannot express the exact "24 hourly + 14 daily" policy without careful object tagging.

## Decision: Manual recovery only in phase 1

**Rationale**: Automatic unreachable detection and reprovisioning can destroy evidence or amplify transient network failures. Phase 1 keeps recovery operator-triggered through `matrixctl recover`/`POST /vps/recover`, while reconciliation only repairs provisioning drift.

**Alternatives considered**:
- Auto-recover after heartbeat timeout: deferred until backup verification and false-positive behavior are proven.
- Never delete old VPS during recovery: safer for forensics, but phase 1 recovery semantics are "replace from R2"; implementation can preserve logs before delete if needed.

## Decision: Nightly backup verification is planned for phase 1.3

**Rationale**: R2 backups are load-bearing. A snapshot that cannot restore is worse than a missing snapshot. The phase 1.3 task set should include an operator-only verification job that restores a randomly selected recent snapshot on a throwaway host or disposable local Postgres container and runs sanity SQL.

**Alternatives considered**:
- Trust upload success: insufficient for recoverability.
- Verify every hourly snapshot immediately: stronger, but too costly before scale and not needed for first users.

## Decision: Defer existing container migration

**Rationale**: Existing users remain on a known path. The routing branch can prefer `user_machines.running` when present and otherwise fall back to `containers`, letting first users opt in without forcing migrations or adding data-copy risk.

**Alternatives considered**:
- Bulk migrate all users now: too much blast radius.
- Grandfather containers forever: operationally expensive; should be decided in a later migration/sunset spec.
