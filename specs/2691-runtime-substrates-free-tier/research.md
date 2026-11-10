# Research: Runtime substrates and the hosted free tier

Decisions marked **Decided** rest on code read at the baseline commit. Decisions marked
**Pending spike** are gates: the named spike must pass before the dependent stack opens.

## R1. How a free runtime is represented

- **Decision (Decided)**: a container runtime is a `user_machines` row with
  `substrate = 'container'`.
- **Rationale**: handle, runtime slot, and token epoch already live there. Every
  funded-AI table references `user_machines(machine_id)`
  (`packages/platform/src/database/migrations/ai-funded.ts`), device sign-in requires a
  handle (`packages/platform/src/auth-routes.ts:242`), and clients address runtimes as
  `/vm/<handle>`.
- **Alternatives**: a separate `hosted_runtimes` table (forks routing, sign-in, and
  funding); re-keying funding tables to owner (about a dozen tables, no user benefit).

## R2. Tenancy model

- **Decision (Decided)**: one container per owner running the existing gateway.
- **Rationale**: the gateway resolves a single home path and a single database at
  startup (`packages/gateway/src/server.ts:312`, `:765`); the request principal
  identifies the actor, not the home. Database-per-owner on a shared cluster is already
  implemented (`packages/platform/src/orchestrator.ts:157`).
- **Alternatives**: multi-tenant gateway (rewrite); platform-side chat-only service
  (second chat implementation, cannot build apps).

## R3. Sandbox without host systemd

- **Decision (Pending spike S2)**: add a second `ScopeRuntimeLauncher`
  (`packages/scope-runtime/src/supervisor.ts:116`) that launches workers without
  `systemd-run`. First candidate is bubblewrap, already installed in the runtime image
  and used by coding-agent launches.
- **Rationale**: managed Pi chat is only registered when the scope-runtime host is
  available (`packages/gateway/src/server.ts:1628`), and the current launcher needs host
  systemd and a root supervisor.
- **Must hold**: no network namespace access, no gateway environment, no database URL,
  memory, CPU, and task caps, bounded lifetime. If the provider forbids unprivileged user
  namespaces, the fallback is running systemd as the container init, which constrains S1.
- **Alternatives**: rely on the container boundary alone (the agent would hold gateway
  secrets); run the worker in-process (no isolation between agent code and gateway).

## R4. Container provider

- **Decision (Pending spike S1)**: chosen by measurement against the criteria in plan.md.
- **Candidates**: Cloudflare Containers, Fly Machines, Cloud Run, self-operated
  microVMs on Hetzner.
- **Note**: provider features and prices move quickly. Record the versions and dates
  measured; do not rely on recalled product behaviour.

## R5. Durable home for disposable compute

- **Decision (Decided, timing pending S4)**: Postgres and the owner object prefix are
  the source of truth. The runtime hydrates before ready, flushes on a timer and at stop.
- **Rationale**: the existing mirror already does initial pull and push
  (`packages/gateway/src/sync/home-mirror.ts`), keyed by owner prefix and brokered by the
  platform. It skips `.git`, `dist`, `build`, and `node_modules`
  (`packages/gateway/src/sync/home-mirror-ignore.ts:21`), so the container profile adds
  built output and packs project history.
- **Alternatives**: provider volume as the only copy (ties data to one provider and
  breaks the upgrade path); network filesystem (latency, cost, provider-specific).

## R6. Shared Postgres

- **Decision (S5, 2026-11-10)**: database and role per owner on one managed cluster,
  direct connections, no pooler. The role has `CONNECTION LIMIT 5`; the gateway's
  owner pool drops from 10 to 3 so that all pools together stay within 5.
- **Rationale**: every advisory lock in the gateway is transaction-scoped. PgBouncer in
  transaction mode refuses the three pools that pass timeouts as connection settings,
  weakens fencing, and its server connections consume the role limit.
- **Consequences**: database and role names are opaque because other owners can list
  them. Postgres has no size cap, so the platform measures `pg_database_size` and
  fences. Fencing is password rotation plus terminating the role's sessions. The
  gateway must fail closed when its database credentials are rejected, and readiness
  must check the database. The legacy orchestrator's provisioning is not reused.
- **Open**: a cluster with `max_connections = 100` serves about 19 concurrently active
  owners at 5 each; cluster sizing or a pooler is revisited with the provider choice.
  A full funded chat turn was not exercised in the spike.

## R7. Upgrade path

- **Decision (Decided, verification pending S6)**: the container writes database
  snapshots and files in the layout `matrix-restore` reads
  (`distro/customer-vps/matrix-restore.sh:18`), so upgrade provisions a VPS that restores
  from it.
- **Rationale**: reuses the tested recovery path instead of a second migration engine.
- **Known gap**: funded balances are per machine; the upgrade transfers them under the
  per-owner funding lock.

## R8. Idle detection authority

- **Decision (Decided)**: the platform decides from traffic it proxies and reservations
  it tracks. Container-reported activity is advisory.
- **Rationale**: the container is untrusted and would otherwise keep itself alive.

## R9. Capability vocabulary

- **Decision (Decided)**: states are `available`, `disabled-by-policy`, `unsupported`,
  `setup-required`, `temporarily-unavailable`, matching the contract proposed in spec 639.
- **Rationale**: one capability system for hosted containers and on-prem.

## R10. Free plan representation

- **Decision (Decided)**: new plan slug `matrix_free` and entitlement source `free`
  alongside `stripe` and `override` (`packages/platform/src/billing.ts:11`), with
  `max_runtime_slots = 1` and substrate restricted to `container`.
- **Alternatives**: reuse the legacy `users.plan = 'free'` column (nothing gates on it).

## Spike log

| Spike | Status | Result |
| --- | --- | --- |
| S1 Provider bake-off | Desk evaluation done 2026-11-10; measurement pending owner approval | Fly Machines eliminated (egress rules are port-only). Shortlist: Cloud Run gen2 first, Cloudflare Containers second, Hetzner microVMs as fallback. Unverified from docs: cold start, unprivileged user namespaces. See `spikes/s1-provider-desk-evaluation.md` |
| S2 Chat without host systemd | Partial pass 2026-11-10 (funded turn not run: local keys out of quota; tool use passed with a scripted model) | A bubblewrap launcher runs a Pi turn in a non-root, capability-free container and passes 21 of 21 isolation probes. It requires unprivileged user namespaces, which Docker's default seccomp blocks. Fallback without them is Landlock plus seccomp (19 of 21; Unix sockets must move). Per-workload memory, CPU, and task limits are lost without cgroup delegation. See `spikes/s2-chat-without-systemd.md` |
| S3 App build in the sandbox | Not run | |
| S4 Hydrate and flush | Not run | |
| S5 Shared Postgres | Partial pass 2026-11-10 (funded chat turn not exercised) | Boots and migrates on a non-superuser role with `CONNECTION LIMIT 5`; all advisory locks are transaction-scoped. Owner pool must drop from 10 to 3. No pooler: PgBouncer rejects connection-level timeout settings. Fencing needs password rotation plus session termination. `/health` stays ok after losing the database. See `spikes/s5-shared-postgres.md` |
| S6 Restore onto a VPS | Not run | |
