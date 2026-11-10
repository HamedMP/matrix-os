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
| Kernel state is a live SQLite file in the home | `packages/gateway/src/dispatcher.ts:136` | Needs a consistent snapshot at flush |
| VPS restore reads a fixed object layout | `distro/customer-vps/matrix-restore.sh:18` | A container that writes the same layout can be restored onto a VPS |
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
4. **The same object layout as a VPS backup.** The container writes database snapshots
   and files where `matrix-restore` already looks, so upgrade is "restore onto a VPS",
   not a new migration engine.
5. **Capabilities are declared by the runtime.** Clients do not branch on plan or
   substrate. Vocabulary follows spec 639's proposed capability states.
6. **Provider is chosen by measurement** (Phase 0), behind the substrate interface.

## Phase 0: Spikes (throwaway code, findings recorded in `research.md`)

Each spike has a pass condition. A failed spike changes the plan before any stack opens.

| Spike | Question | Pass condition |
| --- | --- | --- |
| S1 Provider bake-off | Which provider meets the criteria below? | One provider meets every hard criterion |
| S2 Chat without host systemd | Can the gateway image run managed Pi chat with a non-systemd launcher? | Real funded chat turn with tool use completes; workload has no network and no gateway secrets |
| S3 App build in the sandbox | Can the agent build a Vite app with egress limited to the package registry? | Fresh app builds and loads through the bridged viewer |
| S4 Hydrate and flush | How long do hydrate and flush take, and is the SQLite snapshot consistent? | Measured for small, medium, and large homes; snapshot opens cleanly after a kill |
| S5 Shared Postgres | Do gateway advisory locks and pools work behind a pooler with per-owner roles? | Full gateway boot and chat with pool size reduced; no session-lock breakage |
| S6 Restore onto a VPS | Does `matrix-restore` accept a container-written layout? | A test VPS boots with the container's data |

Provider criteria for S1. Hard: hardware-virtualized or equivalently strong isolation
per container; scale to zero with no idle compute charge; EU region; private addressing
from the platform; enforceable egress policy; API for create, start, stop, delete;
supports whatever S2's launcher needs (for example unprivileged user namespaces). Soft:
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
  container mirror profile that keeps built output and project history.
- B4 Runtime image and entrypoint; pool sizing and timeouts from config.
- B5 Lifecycle routes: readiness, quiesce, flush, activity report.

Done when: a locally run container passes User Stories 2 and 3 against real Postgres and
an S3-compatible store.

### Stack C: Container substrate and free plan (platform)

- C1 Container substrate adapter for the provider chosen in S1.
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

## New and changed routes

| Route | Auth | Limits |
| --- | --- | --- |
| `POST /api/auth/provision-runtime` (existing, extended with free plan) | Clerk session | `bodyLimit`; one runtime per owner by unique constraint |
| `POST /internal/containers/:handle/lifecycle/activity` | Per-runtime HMAC token | `bodyLimit` 4 KiB; rate limited |
| `POST /internal/containers/:handle/lifecycle/flushed` | Per-runtime HMAC token, current generation | `bodyLimit` 4 KiB |
| Gateway `POST /internal/runtime/quiesce`, `/flush` | Platform verification token | `bodyLimit` 4 KiB; bounded duration |
| Gateway `GET /api/runtime/capabilities` | Verified runtime actor | Bounded static projection |
| `POST /api/runtime/upgrade`, `GET /api/runtime/upgrade` | Clerk session, owner only | `bodyLimit`; idempotency key |

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
| Cold start too slow for a first-message experience | Measure in S4; hydrate lazily by directory; consider a provider volume as cache |
| Free tier abuse (mining, spam, scraping) | Default-deny egress, hard caps, invite gate, global ceiling |
| Shared Postgres becomes a single point of failure for all free owners | Provider-managed backups; per-owner snapshots in the object store; paid tier unaffected |
| Divergence between VPS and container runtime behaviour | One codebase, profile composition, shared qualification suite run on both |
| Overlap with spec 639 | FR-016 and D7; agree contract ownership before Stack B1 |
| Machine-keyed funding rows complicate upgrade | E3 transfers balances and switches substrate atomically |

## Not in this plan

`tasks.md` is generated after Phase 0, because S1, S2, and S4 decide the shape of
Stacks B and C. `research.md` records spike results.
