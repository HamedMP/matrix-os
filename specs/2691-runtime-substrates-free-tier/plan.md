# Implementation Plan: Runtime substrates and the hosted free tier

**Branch**: `spec/2691-runtime-substrates-free-tier` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)
**Baseline**: `origin/main` at the commit this branch was cut from.

## Summary

Introduce a substrate abstraction so one owner runtime can run on a Hetzner VPS (paid,
unchanged) or on a platform-operated container that sleeps when idle (free). Reuse the
existing gateway, managed Pi chat path, funded-AI ledger, object-store broker, and VPS
restore. Add what is missing: a substrate field and interface, a sandbox launcher that
does not need host systemd, a durable-home lifecycle for disposable compute, a free
entitlement, client handling of sleeping runtimes, and a container-to-VPS migration.

## What exists and what it means

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Routing targets a machine's public IPv4 | `packages/platform/src/profile-routing.ts:41` | Upstream resolution moves behind the substrate |
| No substrate field; Hetzner columns on the machine row | `packages/platform/src/db.ts:64` | Add `substrate`; Hetzner columns become nullable for containers |
| Provisioning depends on `HetznerClient` directly | `packages/platform/src/customer-vps-types.ts:139` | Wrap, do not rewrite, in Phase 1 |
| Every funded-AI row references `user_machines` and needs `running` plus `authorized` | `packages/platform/src/database/migrations/ai-funded.ts` | A container runtime is a `user_machines` row; no ledger re-key |
| Starter credit is granted only at VPS registration, for class `customer` | `packages/platform/src/customer-funded-starter-policy.ts:44` | Add a container registration path and a free policy |
| Gateway is one owner, one home, one database per process | `packages/gateway/src/server.ts:312`, `:765` | One container per owner; no multi-tenant gateway |
| Matrix AI chat needs the scope-runtime host | `packages/gateway/src/server.ts:1628` | Chat does not work in the current Docker image |
| Sandbox launch is behind an interface | `packages/scope-runtime/src/supervisor.ts:116` | Add a second launcher; do not fork scope-runtime |
| Database-per-owner on a shared cluster already exists | `packages/platform/src/orchestrator.ts:157` | Reuse the role and database creation pattern |
| Object access is brokered with an owner-prefix check | `packages/platform/src/internal-sync-routes.ts:105` | Containers hold no bucket credentials; add a byte quota |
| Home mirror skips `.git`, `dist`, `build`, `node_modules` | `packages/gateway/src/sync/home-mirror-ignore.ts:21` | Not sufficient as the only durable home; see Phase 2 |
| Home mirror pushes one manifest per changed file, pulls serially, and `stop()` has a 10 s deadline | `packages/gateway/src/sync/home-mirror.ts:542`, S4 | Cannot serve a medium or large home (S4); flush and hydrate are rebuilt in Stack B3 |
| Boot runs template setup and `git init` before the mirror pulls | `packages/kernel/src/boot.ts:40,332`, S4 | Template copy can win over owner files (reproduced; affects VPS restores); `git init` costs 2-92 s per hydrate |
| Gateway waits up to 4.25 s for a terminal runtime before listening | `packages/gateway/src/agent-session-manager.ts:353`, `server.ts:1756` | Must move off the listen path for the wake target |
| Kernel state is a live SQLite file in the home | `packages/gateway/src/dispatcher.ts:136` | Needs a consistent snapshot at flush; `VACUUM INTO` (S4) |
| VPS restore reads Postgres dumps at a fixed key | `distro/customer-vps/matrix-restore.sh:18` | It restores only Postgres; home files come back through the mirror's `initialPull`. A container that writes the same dump keys and manifest schema can be restored onto a VPS (S6 still to prove) |
| Clients require a handle and a running machine | `packages/platform/src/auth-routes.ts:242`, `apps/mobile/lib/journey.ts:58` | Journey and device sign-in must accept a container runtime |
| No free plan | `packages/platform/src/billing.ts:14` | Add an entitlement source and plan |

## Key design decisions

1. **A container runtime is a `user_machines` row.** It has a machine id, handle, slot,
   and token epoch, so routing, device sign-in, the funded ledger, sync prefixes, and
   client URLs keep working. The alternative, re-keying about a dozen funding tables to
   owner, is a larger and riskier change for no user-visible gain.
2. **One container per owner, not a shared gateway.** The gateway reads one home path in
   roughly 1,900 places. Tenant isolation comes from the substrate boundary.
3. **Durable truth is Postgres plus the object prefix. Local disk is a cache.** A
   provider volume may be used as an optimisation, never as the only copy.
4. **The same object layout as a VPS backup.** The container writes database dumps where
   `matrix-restore` already looks and files through the same sync manifest the VPS
   mirror reads, so upgrade is "restore onto a VPS", not a new migration engine. S4
   changes the file layout to packs plus blobs; that change lands in the shared mirror,
   so both substrates read it (data-model.md, Object layout).
5. **Capabilities are declared by the runtime.** Clients do not branch on plan or
   substrate. Vocabulary follows spec 639's proposed capability states.
6. **Provider is AWS Lambda MicroVMs**, chosen by measurement (Phase 0, research.md R4),
   behind the substrate interface. Cloud Run gen2 is the fallback.

## Phase 0: Spikes (throwaway code, findings recorded in `research.md`)

Each spike has a pass condition. A failed spike changes the plan before any stack opens.

| Spike | Question | Pass condition |
| --- | --- | --- |
| S1 Provider bake-off | Which provider meets the criteria below? | One provider meets every hard criterion |
| S2 Chat without host systemd | Can the gateway image run managed Pi chat with a non-systemd launcher? | Real funded chat turn with tool use completes; workload has no network and no gateway secrets |
| S3 App build in the sandbox | Can the agent build a Vite app with egress limited to the package registry? | Fresh app builds and loads through the bridged viewer. **Partial pass**: builds pass with five fixes; the bridged viewer and agent loop were not exercised (`spikes/s3-sandbox-build.md`) |
| S4 Hydrate and flush | How long do hydrate and flush take, and is the SQLite snapshot consistent? | Measured for small, medium, and large homes; snapshot opens cleanly after a kill. **Pass** (`spikes/s4-hydrate-flush.md`) |
| S5 Shared Postgres | Do gateway advisory locks and pools work behind a pooler with per-owner roles? | Full gateway boot and chat with pool size reduced; no session-lock breakage |
| S6 Restore onto a VPS | Does `matrix-restore` accept a container-written layout? | A test VPS boots with the container's data |

Provider criteria for S1. Hard: hardware-virtualized or equivalently strong isolation
per container; scale to zero with no idle compute charge; EU region; private addressing
from the platform; enforceable egress policy; API for create, start, stop, delete;
a non-root process can create user namespaces, that is the provider does not block
`unshare`, `clone`, `mount`, `umount2`, `pivot_root`, or `setns` (S2; verified by running
`bwrap --unshare-all` in the probe image). Soft: writable cgroup v2 delegation (memory, pids, cpu) for per-workload limits, without
which the agent workload has no real memory or CPU cap; a writable `/proc` for the
hardened sandbox variant;
cold start time, price per active hour, persistent volume option, image size limits.
Candidates to measure: Cloudflare Containers, Fly Machines, Cloud Run (the platform
already runs there), and self-operated microVMs on Hetzner as the fallback.

## Delivery stacks

One Linear ticket, sequential GitHub native stacks, each layer under 3,000 additions and
50 files. A later stack starts after the previous one merges.

### Stack A: Substrate model (platform, no behaviour change)

- A1 `substrate` column on `user_machines` (default `vps`), nullable Hetzner columns,
  `generation` column; contracts for `RuntimeSubstrate` and capability set.
- A2 `vps` substrate wrapping existing Hetzner provisioning, routing, and recovery.
- A3 Routing resolves the upstream through the substrate; paid regression suite.

Done when: paid controls pass unchanged and no code outside the `vps` substrate calls
`HetznerClient` for routing.

### Stack B: Container runtime profile (gateway, scope-runtime, image)

- B1 Runtime profile and capability projection in the gateway; shell reads it.
- B2 Non-systemd scope-runtime launcher behind the existing interface, with tests that
  the workload cannot reach the network, gateway env, or database.
- B3 Durable-home lifecycle: hydrate gate before ready, flush on stop, SQLite snapshot,
  container mirror profile that keeps built output and project history. After S4 this
  means: the template ordering fix (T010a, lands first and also fixes VPS restores);
  no boot-time `git init`; a boot-set archive written at every flush and readiness
  gated on it; lazy background fill with not-yet-local handling on file and app routes,
  agent turns gated on full fill; batched flush with one manifest and a barrier;
  manifest sharding or deltas; packs plus blobs with repack GC; `VACUUM INTO` for
  `matrix.db` and `matrix.db*` excluded from sync; a configurable 120 s final-flush
  deadline; stop order files, manifest, Postgres dump; a durable hydrated-manifest
  record; the 50,000-file cap. This is larger than one layer and is split across B3
  and a follow-on layer if it exceeds the size limit.
- B3b Build workload (S3): gateway-side build tool with fixed argv in the same sandbox,
  dedicated egress socket, pinned pnpm in the runtime node directory, per-owner store
  bind under quota, fixed build environment, timeout and free-space check.
- B4 Runtime image and entrypoint, with prebuilt JS (no tsx at boot) and the
  terminal-runtime retry moved off the listen path; one connection budget across all gateway pools (at
  most 5), timeouts from config, and fail-closed boot when the owner database rejects
  credentials (no fallback to file storage; `/health` reports database readiness).
- B5 Lifecycle routes: readiness, quiesce, flush, activity report.

Done when: a locally run container passes User Stories 2 and 3 against real Postgres and
an S3-compatible store.

### Stack C: Container substrate and free plan (platform)

- C1 Container substrate adapter for AWS Lambda MicroVMs: run from image, suspend,
  resume, terminate, and list, each with a timeout and typed error codes. A stopped
  runtime is a suspended unit while one exists and a fresh run otherwise; a unit is
  replaced before its 8 hour lifetime ends. The platform reaches the unit through its
  per-unit endpoint with a short-lived token it mints and never hands to clients. The
  gateway process starts after restore so that no two units share random state.
- C2 Lifecycle service: create, wake on request, idle stop, replace, reconcile orphans;
  generation fencing; single-flight starts.
- C3 Free entitlement and plan; invite gate; global capacity ceiling; busy responses.
- C4 Funded-AI policy and credential issuance for container runtimes; starter credit
  on container registration; storage quota in the object broker; database quotas.
- C5 Journey and device sign-in accept a container runtime.

Done when: User Stories 1, 3, 4, and 7 pass on a staging platform with Web Desktop.

### Stack D: Clients

- D1 Shared runtime-state model: waking, restoring, ready, busy, limit, failed.
- D2 Web Desktop and Web Canvas: free onboarding, states, capability gating.
- D3 Electron Desktop: sign-in and states.
- D4 Native Mobile and Web Mobile: journey gate and states.

Done when: User Story 6 passes with live evidence per surface.

### Stack E: Upgrade

- E1 Migration record and state machine: requested, quiescing, final-sync, provisioning,
  restoring, verifying, completed, abandoned.
- E2 Final sync and inventory; VPS provisioning with restore from the container layout.
- E3 Funded-AI balance transfer and substrate switch in one transaction; cleanup after
  verification.
- E4 Upgrade UI on each surface.

Done when: User Story 5 and SC-005 pass, including a failed and resumed migration.

### Stack F: Rollout

- F1 `AGENTS.md` and `docs/dev/vps-deployment.md` amendment (FR-017); operator runbook.
- F2 Site docs PR in `FinnaAI/matrix-os-site`.
- F3 Staged enablement: internal accounts, invite list, open signup after D4's condition.

## Test lanes per stack

| Stack | Required lane beyond unit tests |
| --- | --- |
| A | Platform integration against real Postgres: routing resolves a `vps` runtime exactly as before; paid regression set (sign-in, proxy to VPS, entitlement 402, boot page, recovery, resize, funded credential issuance) |
| B | Container integration: real image, real Postgres, S3-compatible store; chat turn with tool use, build, stop, destroy, restart; sandbox denial tests |
| C | Staging platform: two owners, start races, stale-generation denial, limit races, capacity busy, idle reaping |
| D | Per-surface end-to-end plus live evidence |
| E | Staging: full upgrade with inventory comparison; injected failure at each step and resume |

A lane that cannot run for a missing prerequisite fails; it does not skip.

## New and changed routes

| Route | Auth | Limits |
| --- | --- | --- |
| `POST /api/auth/provision-runtime` (existing, extended with free plan) | Clerk session | `bodyLimit`; one runtime per owner by unique constraint |
| `POST /internal/containers/:handle/lifecycle/activity` | Per-runtime HMAC token | `bodyLimit` 4 KiB; rate limited |
| `POST /internal/containers/:handle/lifecycle/flushed` | Per-runtime HMAC token, current generation | `bodyLimit` 4 KiB |
| Gateway `POST /internal/runtime/quiesce`, `/flush` | Platform verification token | `bodyLimit` 4 KiB; bounded duration |
| Gateway build egress socket (Unix socket in the build sandbox, not an HTTP route) | Reachable only from the build workload; the gateway adds the runtime token when forwarding | GET and HEAD of registry paths only; size cap; per-owner byte cap at the platform mirror |
| Platform registry mirror | Per-runtime HMAC token, current generation | GET and HEAD only; rate and byte caps; upstream `redirect: "error"`, 30 s timeout |
| Gateway `GET /api/runtime/capabilities` | Verified runtime actor | Bounded static projection |
| `POST /api/runtime/upgrade`, `GET /api/runtime/upgrade` | Clerk session, owner only | `bodyLimit`; idempotency key |
| `POST /internal/containers/:handle/register` | Per-runtime HMAC token, current generation | `bodyLimit` 4 KiB; idempotent |
| Invite administration | Platform operator auth | `bodyLimit`; validated identifiers |
| Stripe webhook (existing) starts a migration | Stripe signature | Idempotent on event id; non-2xx on failure |

Names are proposals; final naming is reconciled with the owning routers.

## Constitution check

| Principle | How this plan meets it |
| --- | --- |
| Data belongs to its owner | Database per owner; export, delete, and upgrade keep data portable |
| AI is the kernel | Same kernel and chat orchestrator on both substrates |
| Headless core, multi-shell | Capability projection is server-side; all five surfaces consume it |
| Defense in depth | Trust model and auth matrix in the spec; limits enforced outside the container |
| TDD | Each layer starts from a failing test at the real boundary; spikes are not merged |
| Worktree, PR, Greptile | Manual worktrees, native stacks, shared ticket, 5/5 before merge |
| Technology constraints | Kysely and Postgres only; no new store. The constitution already names container-per-user as an isolation model |

One governance change is required and is not an exception: FR-017 amends the
"VPS-native only" production rule.

## Risks

| Risk | Mitigation |
| --- | --- |
| No provider meets the isolation and launcher criteria | Fallback candidate in S1; decision before Stack B |
| Cold start too slow for a first-message experience | S4: ready after a boot-set archive (0.23-0.64 s hydrate), then lazy fill. Gateway boot alone missed 5 s on a loaded host; needs prebuilt JS, no `git init`, no terminal wait, and a 1 vCPU re-measure with the real image (T077) |
| Pack layout changes the manifest schema on paid VPSes too | The mirror is shared; T047d keeps legacy blob entries readable and is covered by the paid regression lane |
| Build fails on new native tools under the address-space limit (S3) | Fixed worker and arena caps; timeout and `needs_build`; pair with a cgroup memory limit wherever a provider allows one |
| Registry mirror becomes trusted for integrity hashes (S3) | TLS-only fixed upstream, redirects refused, metadata size cap, `minimumReleaseAge` |
| Free tier abuse (mining, spam, scraping) | Default-deny egress, hard caps, invite gate, global ceiling |
| Shared Postgres becomes a single point of failure for all free owners | Provider-managed backups; per-owner snapshots in the object store; paid tier unaffected |
| Divergence between VPS and container runtime behaviour | One codebase, profile composition, shared qualification suite run on both |
| Overlap with spec 639 | FR-016 and D7; agree contract ownership before Stack B1 |
| Machine-keyed funding rows complicate upgrade | E3 transfers balances and switches substrate atomically |

## Not in this plan

`tasks.md` is generated after Phase 0, because S1, S2, and S4 decide the shape of
Stacks B and C. `research.md` records spike results.
