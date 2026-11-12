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
  Cloud Run met the hard criteria and had a lower best-case wake, but its
  request-triggered median from zero was 5.8 s (18 valid trials) and 19 of 47 wakes
  took over 5 seconds or failed. The slow wakes are an 18 to 97 s delay before the
  instance starts; the cause is not established. See `spikes/s1-measurements.md`.
- **Accepted costs**: list price about twice Cloud Run ($0.159 against $0.079 per
  active hour at the default 1 vCPU and 2 GB baseline in eu-central-1 ARM; burst is
  billed only while used, up to about $0.64 per hour); 8 hour maximum unit lifetime including suspended time; endpoint tokens
  last at most 60 minutes; units restored from one snapshot share random state, so the
  gateway process must start after restore, never inside the snapshot; no cgroup
  delegation, so the agent workload has rlimits only.
- **Alternatives considered**: Cloud Run gen2 (slow tail), Cloudflare Containers
  (HTTP-only egress, no direct Postgres), Fly Machines (egress rules are port-only),
  Fargate (slow start, user namespaces doubtful), self-run Firecracker (operations cost).
- **Note**: provider features and prices move quickly. The measurements used a 1.5 GB
  probe image, not the gateway image; repeat the wake measurement with the real image
  before rollout.
- **Per-unit configuration (docs check 2026-11-12)**:
  - Lambda delivers `runHookPayload` only as the body of the `/run` lifecycle hook
    (`POST /aws/lambda-microvms/runtime/v1/run`, `{ microvmId, runHookPayload }`).
    Environment variables are fixed per image version. That is why the image needs a
    bootstrap that takes `/run` and starts the gateway, which fits the rule above that the
    gateway starts after restore.
  - Any endpoint traffic counts as activity for the provider's idle policy, and the policy
    has no "off" setting. The platform passes the maximum idle duration and turns
    auto-resume off, so the platform decides idleness (see `contracts/lifecycle.md`).
  - The docs give no timeout for any hook.
  - Source: AWS Lambda developer guide, "Running and using MicroVMs".


## Spike log

| Spike | Status | Result |
| --- | --- | --- |
| S1 Provider bake-off | Done 2026-11-10. Decision D1: AWS Lambda MicroVMs, Cloud Run gen2 as fallback | Fly Machines and Cloudflare Containers eliminated on egress. Measured: Lambda MicroVMs cold median 2.6 s, resume 0.95 s, 30 of 30 under 3.1 s; Cloud Run median 1.7 to 6.0 s (5.8 s request-triggered from zero) with 19 of 47 wakes over 5 s or failed. Both pass sandbox, egress, cross-tenant, and 15 minute WebSocket checks; neither delegates cgroups. See `spikes/s1-provider-desk-evaluation.md`, `spikes/s1-aws-desk-evaluation.md`, `spikes/s1-measurements.md` |
| S2 Chat without host systemd | Pass 2026-11-10. Real funded turns with tool use completed through the production container launcher on Workers AI GLM Flash (8 of 8 turns, 29 of 29 isolation probes); see `spikes/s2-funded-turn.md`. Not exercised: the AI Gateway hop, reservation and settlement, x86_64, cgroup limits | A bubblewrap launcher runs a Pi turn in a non-root, capability-free container and passes 21 of 21 isolation probes. It requires unprivileged user namespaces, which Docker's default seccomp blocks. Fallback without them is Landlock plus seccomp (19 of 21; Unix sockets must move). Per-workload memory, CPU, and task limits are lost without cgroup delegation. See `spikes/s2-chat-without-systemd.md` |
| S3 App build in the sandbox | Partial pass 2026-11-11. Not exercised: the agent loop, the bridged app viewer, a real MicroVM guest | A template app and a Tailwind v4 app install and build in the real sandbox; registry-only egress holds (12 of 12 probes in mirror and CONNECT mode). As shipped it fails: pnpm and Tailwind abort under the 4 GiB address-space limit without `PNPM_MAX_WORKERS=2` and `MALLOC_ARENA_MAX=2`, package scripts fail (no `/bin/sh`), a medium resolve fills the 256 MiB tmpfs and pnpm hangs, and there is no egress socket slot. Recommended: a separate build workload with fixed argv and a platform mirror-mode registry. See `spikes/s3-sandbox-build.md`; code on `spike/2691-s3` (`a4b303bfe`) |
| S4 Hydrate and flush | Pass 2026-11-11 (Mac run, then Linux rerun). Not measured on an idle 1 vCPU machine | `VACUUM INTO` restored 30 of 30 after SIGKILL; copying the file restored 0 to 2. Today's mirror cannot serve medium or large homes (medium hydrate 145-233 s at 20 ms; `stop()` lands 32-56 of 100 changes in its 10 s deadline). Packs plus blobs with one manifest per flush: large hydrate 18-19 s, full flush 21-25 s. Boot-set archive hydrates in 0.23-0.64 s. Gateway boot alone missed 5 s on a loaded Linux host (11 s warm on one CPU, 4.25 s of it a terminal-runtime retry). The template-over-owner-file ordering hazard reproduces and affects VPS restores. See `spikes/s4-hydrate-flush.md`; code on `spike/2691-s4` (`b63e185ec`) |
| S5 Shared Postgres | Partial pass 2026-11-10 (funded chat turn not exercised) | Boots and migrates on a non-superuser role with `CONNECTION LIMIT 5`; all advisory locks are transaction-scoped. Owner pool must drop from 10 to 3. No pooler: PgBouncer rejects connection-level timeout settings. Fencing needs password rotation plus session termination. `/health` stays ok after losing the database. See `spikes/s5-shared-postgres.md` |
| S6 Restore onto a VPS | Not run; needs a test VPS | S4 found by code reading that `matrix-restore.sh` restores only Postgres; home files come back through the gateway mirror's `initialPull`. S6 must therefore exercise the mirror pull with the pack layout, the `matrix.db` snapshot restore, and dump keys with seconds plus generation |
