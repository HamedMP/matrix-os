# Implementation Plan: VPS-per-User Architecture

**Branch**: `070-vps-per-user` | **Date**: 2026-04-26 | **Spec**: `specs/070-vps-per-user/spec.md`
**Input**: Feature specification from `/specs/070-vps-per-user/spec.md`

## Summary

Replace new-user container provisioning on the control-plane VPS with one Hetzner customer VPS per user. The control plane becomes an authenticated provisioner and router; customer workloads, the Matrix OS host services, Docker, and a single-user Postgres instance run on the user's own VPS. Cloudflare R2 remains the recoverable source for home/project files, DB snapshots, and VPS metadata. Existing container users remain on the legacy path during phase 1.

Phase 1 delivers lazy provisioning, host installation through cloud-init, reverse-proxy routing, hourly DB backups, R2 heartbeat metadata, manual recovery, and a first-customer opt-in path. Sleep, warm pools, automatic idle deletion, geographic routing, and existing-user migration are explicitly deferred.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules; Bash/cloud-init YAML for customer VPS bootstrap; systemd unit files for host services.
**Primary Dependencies**: Hono (platform routes), Drizzle ORM with SQLite (control-plane registry), Zod 4 (`zod/v4`) for request validation, Hetzner Cloud API via `fetch()` with `AbortSignal.timeout(10_000)`, Cloudflare R2 through the existing S3-compatible sync infrastructure, Docker Engine + Compose plugin on customer VPSes, Postgres 16 container per user, systemd timers.
**Storage**: Control-plane SQLite `user_machines` table; Cloudflare R2 `matrixos-sync/{userId}/system/...`; customer VPS Docker named volume for Postgres; user files under the spec 066 home/projects sync paths.
**Testing**: Vitest unit/contract/integration tests first; platform route tests with mocked Hetzner/R2 clients; cloud-init render tests; recovery integration test behind a real-Hetzner flag; standard pre-PR `bun run typecheck`, `bun run check:patterns`, `bun run test`.
**Target Platform**: Control-plane Hetzner VPS running platform/proxy/cloudflared; customer Ubuntu 24.04 Hetzner VPSes in `nbg1`.
**Project Type**: Monorepo infrastructure feature spanning `packages/platform/`, `distro/customer-vps/`, `distro/systemd/`, optional sync/gateway host bundle packaging, and `tests/platform/`.
**Performance Goals**: Provision request returns idempotently in <2s after Hetzner create is accepted; fresh VPS reaches `running` in ~60-90s; manual recovery target ~3 minutes for small DB/project tree; heartbeat every 5 minutes; hourly DB backups with last 24 hourly + last 14 daily retained.
**Constraints**: No shared workload host for new users; no public Postgres; no user SSH path in phase 1; no network calls inside DB transactions; all mutating endpoints use Hono `bodyLimit`; all external calls use explicit timeouts; R2 restores must complete before gateway serves traffic; legacy containers remain untouched.
**Scale/Scope**: Phase 1 supports approximately 0-10 opt-in customer VPSes and documents quota/cost ceilings before expanding beyond 50 active users. Hetzner project quota raise to ~100 servers is required before first broader rollout.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Assessment |
|-----------|--------|------------|
| I. Data Belongs to Its Owner | PASS | Personal files, projects, app DB, DB snapshots, and VPS metadata are scoped to one user and recoverable from `matrixos-sync/{userId}/`. No new centralized app-data store is introduced. |
| II. AI Is the Kernel | N/A | Infrastructure provisioning feature. Kernel/runtime services are installed on each user VPS but kernel behavior is not changed. |
| III. Headless Core, Multi-Shell | PASS | Provisioning and recovery are headless platform capabilities. Shell, CLI, and future channel shells reach the same per-user host through routing. |
| IV. Self-Healing and Self-Expanding | PASS | Recovery is deterministic from R2, restore gates gateway startup, provisioning reconciliation marks partial failures, and update uses recover-as-update in phase 1. |
| V. Quality Over Shortcuts | PASS | Uses a real VM boundary, systemd services, explicit contracts, and recovery testing instead of expanding Docker-in-Docker complexity. |
| VI. App Ecosystem | PASS | User app containers run inside the owner's VPS Docker engine. Existing app packaging and permissions remain unchanged. |
| VII. Multi-Tenancy | PASS | Stronger personal tenant isolation: one VPS and one Postgres per user. Legacy container tenants remain separated on their existing path until a later migration spec. |
| VIII. Defense in Depth | PASS | Auth matrix, body limits, Zod schemas, constant-time token checks, generic client errors, bounded reconciliation, R2 cleanup, firewall restrictions, and end-to-end wiring tests are required. |
| IX. TDD | PASS | Plan requires failing tests before platform routes, schema transitions, cloud-init rendering, backup pruning, routing branch, and recovery path implementation. |

**Gate result**: PASS - no constitution violations. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/070-vps-per-user/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── vps-api.md
│   ├── customer-host.md
│   └── r2-system-layout.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/platform/src/
├── customer-vps.ts              # NEW: Hetzner provision/recover/delete orchestration
├── customer-vps-routes.ts       # NEW: /vps/* internal/admin Hono routes
├── customer-vps-schema.ts       # NEW: Zod request/response schemas and status enum
├── schema.ts                    # MODIFIED: userMachines table
├── db.ts                        # MODIFIED: migration/bootstrap wiring for userMachines
├── main.ts                      # MODIFIED: mount /vps routes and route deps
└── profile-routing.ts           # MODIFIED: running VPS branch before legacy containers

distro/customer-vps/
├── cloud-init.yaml              # NEW: rendered template for Ubuntu 24.04 bootstrap
├── postgres-compose.yml         # NEW: single-user postgres:16 compose file
├── matrix-db-backup.sh          # NEW: pg_dump + R2 upload + retention pruning
├── matrix-restore.sh            # NEW: restore-or-fresh boot gate
├── matrixctl                    # NEW: host shim for R2 put/get/prune and backup trigger
└── systemd/
    ├── matrix-gateway.service
    ├── matrix-shell.service
    ├── matrix-sync-agent.service
    ├── matrix-restore.service
    ├── matrix-db-backup.service
    └── matrix-db-backup.timer

tests/platform/
├── customer-vps.test.ts         # NEW: idempotency, status transitions, failure handling
├── customer-vps-routes.test.ts  # NEW: auth matrix, body limits, validation
├── customer-vps-cloud-init.test.ts # NEW: render inputs, token injection, no secret leakage
└── profile-routing-vps.test.ts  # NEW: VPS-first routing and legacy fallback

www/content/docs/
└── deployment/vps-per-user.mdx  # NEW or MODIFIED: public operator docs after implementation
```

**Structure Decision**: Keep all control-plane orchestration in `packages/platform/`, because platform already owns Clerk identity, provisioning, routing, and internal sync routes. Customer host assets live under `distro/customer-vps/` because they are deployment artifacts, not runtime platform code. Tests stay in `tests/platform/` with focused unit/contract coverage plus an opt-in real-Hetzner smoke suite.

## Complexity Tracking

No constitution violations to justify.

## Auth Matrix

| Endpoint / Interface | Method | Auth | Public? | Notes |
|----------------------|--------|------|---------|-------|
| `/vps/provision` | POST | `PLATFORM_SECRET` admin/internal bearer | No | Lazy first-use provisioning; idempotent by `clerkUserId`. |
| `/vps/register` | POST | One-time registration token, constant-time compare | No | Called from customer VPS first boot; flips machine to `running`. |
| `/vps/recover` | POST | `PLATFORM_SECRET` admin bearer | No | Manual phase 1 recovery; verifies R2 backup unless `allowEmpty`. |
| `/vps/:machineId/status` | GET | `PLATFORM_SECRET` admin/internal bearer | No | Returns generic machine status and timestamps. |
| `/vps/:machineId` | DELETE | `PLATFORM_SECRET` admin bearer | No | Admin-only explicit deletion; no automatic deletion in phase 1. |
| `matrix-db-backup.timer` | systemd | Local `matrix` user + R2 scoped credentials | No | Hourly backup on customer VPS. |
| R2 `system/*` objects | S3-compatible | Scoped R2 credentials/presigned platform access | No | Prefix limited to `matrixos-sync/{userId}/system/*`. |

## Security Architecture

1. **Route auth**: `/vps/*` routes fail closed when `PLATFORM_SECRET` is missing. Admin/internal requests use bearer auth with constant-time comparison. Registration uses one-time token generated by provisioner and embedded in cloud-init only for that machine.
2. **Input validation**: Zod 4 schemas validate `clerkUserId`, `handle`, `machineId`, IPv4/IPv6, `imageVersion`, and `allowEmpty`. No request-controlled URL, path, server type, or location is accepted in phase 1.
3. **Body limits**: Every mutating `/vps/*` route uses `bodyLimit({ maxSize: 4096 })`.
4. **External timeouts**: Hetzner, R2, Cloudflare, and customer VPS callback verification calls use `AbortSignal.timeout(10_000)` for APIs and `AbortSignal.timeout(30_000)` for downloads.
5. **No raw errors**: Provider errors, filesystem paths, R2 keys, and token details are logged server-side and mapped to generic client errors.
6. **Atomicity**: Multi-step DB updates use transactions. Network calls are outside transactions; durable rows encode acceptable orphan states and reconciliation fixes drift.
7. **Resource limits**: Provisioning reconciliation scans capped batches of stale rows. Registration-token cache, if in memory, must have TTL and max-size eviction; preferred storage is hashed token metadata in SQLite.
8. **Network boundary**: Hetzner firewall allows 22 only from ops IPs and 443 from Cloudflare/control-plane paths. Postgres is container-local and never public.

## Implementation Phases

| Phase | Scope | Exit Criteria |
|-------|-------|---------------|
| 1.0 | Provisioner + registry + placeholder image | `POST /vps/provision` creates one real Hetzner VPS, `/vps/register` marks it running, status is queryable, manual delete works. |
| 1.1 | Host services + routing | Cloud-init installs matrix host bundle and systemd units; `profile-routing.ts` proxies running users to VPS HTTPS and falls back to legacy containers. |
| 1.2 | R2 sync + DB backup | Sync agent restores/fresh-starts, hourly DB backup uploads snapshots/latest pointer, heartbeat writes `vps-meta.json`, `/system/backup` triggers on-demand backup. |
| 1.3 | Recovery | `POST /vps/recover` destroys/recreates, restore gate blocks gateway until DB/files restored, integration test verifies data survives destruction. |
| 1.4 | First real customer | One opt-in user runs on VPS for a week; docs include RTO, restored/not-restored list, costs, and rollback procedure. |

## Constitution Check: Post-Design

| Principle | Status | Design Evidence |
|-----------|--------|-----------------|
| I. Data Belongs to Its Owner | PASS | `data-model.md` keeps personal state in per-user VPS/R2 prefix, with exportable DB snapshots and no shared customer DB. |
| II. AI Is the Kernel | N/A | Host bundle carries existing kernel without changing kernel APIs. |
| III. Headless Core, Multi-Shell | PASS | Contracts expose headless platform APIs and host services; shell/CLI are consumers only. |
| IV. Self-Healing and Self-Expanding | PASS | Recovery state machine, reconciliation, backup verification, and restore gate are explicit artifacts. |
| V. Quality Over Shortcuts | PASS | Real systemd/VM contracts, no Docker-in-Docker workaround, no direct user SSH shortcut. |
| VI. App Ecosystem | PASS | App containers run on the user's Docker host with current app model unchanged. |
| VII. Multi-Tenancy | PASS | Per-user compute/DB boundary strengthens tenant isolation; org/migration scope is deferred deliberately. |
| VIII. Defense in Depth | PASS | Contracts include auth matrix, validation schemas, timeout policy, resource limits, firewall assumptions, and generic error behavior. |
| IX. TDD | PASS | Quickstart and contracts name required tests before implementation tasks. |

**Gate result**: PASS - ready for `/speckit.tasks`.
