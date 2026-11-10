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

- **Decision (2026-11-10, D1)**: AWS Lambda MicroVMs, region eu-west-1 or eu-central-1.
  Cloud Run gen2 is the fallback behind the same substrate interface.
- **Rationale**: it is the only candidate that met every hard criterion and woke in
  under 5 seconds on every trial (30 of 30; cold median 2.6 s, resume median 0.95 s).
  Cloud Run met the hard criteria and had a lower best-case wake, but 19 of 49 wakes
  took over 5 seconds, several about a minute, cause unknown. See
  `spikes/s1-measurements.md`.
- **Accepted costs**: list price about twice Cloud Run ($0.1328 against $0.079 per
  active hour); 8 hour maximum unit lifetime including suspended time; endpoint tokens
  last at most 60 minutes; units restored from one snapshot share random state, so the
  gateway process must start after restore, never inside the snapshot; no cgroup
  delegation, so the agent workload has rlimits only.
- **Alternatives considered**: Cloud Run gen2 (slow tail), Cloudflare Containers
  (HTTP-only egress, no direct Postgres), Fly Machines (egress rules are port-only),
  Fargate (slow start, user namespaces doubtful), self-run Firecracker (operations cost).
- **Note**: provider features and prices move quickly. The measurements used a 1.5 GB
  probe image, not the gateway image; repeat the wake measurement with the real image
  before rollout.


## Spike log

| Spike | Status | Result |
| --- | --- | --- |
| S1 Provider bake-off | Done 2026-11-10. Decision D1: AWS Lambda MicroVMs, Cloud Run gen2 as fallback | Fly Machines and Cloudflare Containers eliminated on egress. Measured: Lambda MicroVMs cold median 2.6 s, resume 0.95 s, 30 of 30 under 3.1 s; Cloud Run median 0.7 to 6.0 s with 19 of 49 wakes over 5 s. Both pass sandbox, egress, cross-tenant, and 15 minute WebSocket checks; neither delegates cgroups. See `spikes/s1-provider-desk-evaluation.md`, `spikes/s1-aws-desk-evaluation.md`, `spikes/s1-measurements.md` |
| S2 Chat without host systemd | Pass 2026-11-10. Real funded turns with tool use completed through the production container launcher on Workers AI GLM Flash (8 of 8 turns, 29 of 29 isolation probes); see `spikes/s2-funded-turn.md`. Not exercised: the AI Gateway hop, reservation and settlement, x86_64, cgroup limits | A bubblewrap launcher runs a Pi turn in a non-root, capability-free container and passes 21 of 21 isolation probes. It requires unprivileged user namespaces, which Docker's default seccomp blocks. Fallback without them is Landlock plus seccomp (19 of 21; Unix sockets must move). Per-workload memory, CPU, and task limits are lost without cgroup delegation. See `spikes/s2-chat-without-systemd.md` |
| S3 App build in the sandbox | Not run | |
| S4 Hydrate and flush | Not run | |
| S5 Shared Postgres | Partial pass 2026-11-10 (funded chat turn not exercised) | Boots and migrates on a non-superuser role with `CONNECTION LIMIT 5`; all advisory locks are transaction-scoped. Owner pool must drop from 10 to 3. No pooler: PgBouncer rejects connection-level timeout settings. Fencing needs password rotation plus session termination. `/health` stays ok after losing the database. See `spikes/s5-shared-postgres.md` |
| S6 Restore onto a VPS | Not run | |
