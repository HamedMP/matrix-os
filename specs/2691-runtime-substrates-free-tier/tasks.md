# Tasks: Runtime substrates and the hosted free tier

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Rules for every task**: TDD (failing test first, at the real boundary), manual
worktree, one GitHub native stack per plan stack, shared Linear ticket, under 3,000
additions and 50 files per PR. `[P]` means it can run in parallel with its neighbours.
Stack letters refer to plan.md.

**Numbering**: tasks added after S3 and S4 (2026-11-12) use a letter suffix on the task
they follow (for example T047a), so existing IDs stay stable. A ticked implementation
task means implemented on a local branch, not merged.

## Phase 1: Setup

- [ ] T001 Create the shared ENG Linear ticket and link spec.md and plan.md from it
- [ ] T002 Open the spec PR from `spec/2691-runtime-substrates-free-tier` with the ticket link
- [ ] T003 Agree capability contract ownership with the ENG-423 owner and record it in `specs/2691-runtime-substrates-free-tier/research.md` (R9)

## Phase 2: Foundational

### Spikes (throwaway code, never merged; results in research.md)

- [x] T004 [P] S1 provider bake-off against the hard criteria in plan.md; record versions, dates, timings, and price in `specs/2691-runtime-substrates-free-tier/research.md`
- [x] T005 [P] S2 run managed Pi chat in the root `Dockerfile` image with a non-systemd `ScopeRuntimeLauncher`; record whether user namespaces are required
- [ ] T006 [P] S5 boot the gateway against a per-owner role on a shared Postgres with pool size 5, with and without a pooler; list any session-scoped advisory locks
- [x] T007 S3 build a Vite app from the sandbox with registry-only egress (depends on T005). Run 2026-11-11: partial pass; see `spikes/s3-sandbox-build.md`, branch `spike/2691-s3`
- [x] T008 S4 measure hydrate and flush for small, medium, and large homes and verify the `system/matrix.db` snapshot after a kill (depends on T005). Run 2026-11-11: pass; see `spikes/s4-hydrate-flush.md`, branch `spike/2691-s4`
- [ ] T009 S6 restore a container-written object layout onto a test VPS with `distro/customer-vps/matrix-restore.sh` (depends on T008). Needs a test VPS. Must cover the mirror pull with the pack layout and the `matrix.db` snapshot, since `matrix-restore.sh` restores only Postgres
- [x] T010 Record provider decision D1 and revise plan.md Stacks B and C if any spike failed

### Early fix (affects VPS restores today; ships as its own standalone PR)

- [ ] T010a Fix the template-over-owner-file ordering hazard reproduced in S4: on a fresh disk, `ensureHome`/`syncTemplate` in `packages/kernel/src/boot.ts` must not write over any path present in the accepted manifest (hydrate the boot set first, or skip such paths), and `system/soul.md` joins `USER_OWNED_TEMPLATE_FILES`. Regression test from the spike's `ordering-hazard.test.ts` (real `ensureHome` and `createHomeMirror`, both "home absent" and "home empty") in `tests/gateway/sync/template-ordering-hazard.test.ts`; it must fail on today's code. Run the paid regression lane, because VPS restores take the same path

### Stack A: substrate model (no behaviour change; serves US7)

- [ ] T011 [US7] Write failing migration tests for `substrate`, `generation`, `substrate_ref`, `private_address`, `last_activity_at`, `started_at`, the substrate check constraint, and backfill in `tests/platform/user-machines-substrate-migration.test.ts`
- [ ] T012 [US7] Add the columns, constraints, and partial unique index in `packages/platform/src/database/migrations/user-machines.ts` and the `UserMachinesTable` type in `packages/platform/src/db.ts`
- [ ] T013 [P] [US7] Write failing schema tests in `tests/contracts/runtime-substrate.test.ts`, then add `SubstrateKindSchema`, `RuntimeStateSchema`, `RuntimeCapabilitiesV1Schema`, and capability ids in `packages/contracts/src/runtime-substrate.ts`
- [ ] T014 [US7] Map the new columns in `packages/platform/src/database/user-machine-records.ts` with tests in `tests/platform/user-machine-records-substrate.test.ts`
- [ ] T015 [US7] Write failing tests for the `RuntimeSubstrate` interface and `SubstrateRegistry` (unregistered kind returns a typed unavailable result) in `tests/platform/substrate-registry.test.ts`, then implement `packages/platform/src/substrates/types.ts` and `packages/platform/src/substrates/registry.ts`
- [ ] T016 [US7] Write characterization tests pinning today's `buildCustomerVpsProxyUrl` behaviour (running, recovering with old server, not routable) in `tests/platform/vps-substrate.test.ts`, then implement `packages/platform/src/substrates/vps-substrate.ts` delegating to `packages/platform/src/profile-routing.ts`
- [ ] T017 [US7] Construct the registry in `packages/platform/src/platform-startup.ts` and inject it into `createSessionRoutingMiddleware`
- [ ] T018 [US7] Route upstream resolution through the registry in `packages/platform/src/session-routing-middleware.ts` (explicit `/vm/<handle>` and session paths), with paid regression tests in `tests/platform/session-routing-substrate.test.ts`
- [ ] T019 [US7] Add the paid regression lane (sign-in, proxy, entitlement 402, boot page, recovery, resize, funded credential issuance) against real Postgres in `tests/platform/integration/paid-vps-regression.test.ts`

**Checkpoint A**: typecheck, pattern scan, unit tests, and the paid regression lane pass; no client-visible change.

## Phase 3: User Story 1 - Start free and chat (P1)

**Independent test**: quickstart.md section 1.

### Stack B: container runtime (gateway, scope-runtime, image)

- [ ] T020 [US1] Failing tests for runtime profile validation (unknown profile fails startup; profile yields an immutable capability set) in `tests/gateway/runtime-profile.test.ts`, then implement `packages/gateway/src/runtime-profile/profile.ts` and `capabilities.ts`
- [ ] T021 [US1] Add `GET /api/runtime/capabilities` in `packages/gateway/src/server/runtime-capabilities-routes.ts` with route tests in `tests/gateway/runtime-capabilities-routes.test.ts`
- [ ] T022 [US1] Failing denial tests (no network, no gateway env, no database URL, caps enforced, bounded lifetime) in `tests/scope-runtime/container-launcher.test.ts`, then implement the non-systemd launcher in `packages/scope-runtime/src/container-launcher.ts`
- [ ] T023 [US1] Select the launcher by dependency injection at startup in `packages/gateway/src/startup/scope-runtime-host.ts`, with a wiring test in `tests/gateway/scope-runtime-host-profile.test.ts`
- [ ] T024 [US1] Make gateway pool size and statement timeout configurable in `packages/gateway/src/app-db.ts` with tests in `tests/gateway/app-db-pool-config.test.ts`
- [ ] T025 [US1] Add the container entrypoint and image target in `distro/container-runtime/entrypoint.sh` and `Dockerfile.runtime`, with a boot smoke test in `tests/e2e/container-runtime-boot.test.ts`
- [ ] T025a [US1] Ship prebuilt JS in the runtime image (no tsx transpile at boot) and record boot to `/health` in the T025 smoke test
- [ ] T025b [US1] Move terminal-runtime reconciliation off the gateway listen path: the startup retry (250, 1,000, 3,000 ms) in `packages/gateway/src/agent-session-manager.ts`, reached from `registerWorkspaceLifecycle` before `serve()` in `packages/gateway/src/server.ts`, runs after listen or not at all on a profile without a terminal. Test that listen does not wait when no terminal runtime socket answers, in `tests/gateway/terminal-reconcile-off-listen.test.ts`

### Stack C: container substrate and free plan (platform)

- [x] T026 [US1] Failing tests then implementation for the AWS Lambda MicroVMs provider adapter in `packages/platform/src/substrates/container-provider.ts` (every call with `AbortSignal.timeout(10_000)`, typed error codes)
- [x] T027 [US1] Failing tests for per-owner database and role creation, password rotation by generation, and identifier validation in `tests/platform/container-owner-database.test.ts`, then implement `packages/platform/src/substrates/container-owner-database.ts` and the `container_owner_databases` migration
- [x] T028 [US1] Failing race tests (20 concurrent starts create one container; stale generation rejected) in `tests/platform/container-lifecycle.test.ts`, then implement `packages/platform/src/substrates/container-lifecycle-service.ts` with compare-and-set transitions
- [x] T029 [US1] Implement `packages/platform/src/substrates/container-substrate.ts` (`resolveUpstream`, `ensureRunning`, `stop`, `destroyCompute`, `listCompute`) and register it in `packages/platform/src/platform-startup.ts` only when configuration is complete
- [x] T030 [US1] Add `matrix_free` and entitlement source `free` in `packages/platform/src/billing.ts` and `packages/contracts/src/billing-catalog.ts`, with access-decision tests in `tests/platform/billing-free-entitlement.test.ts`
- [x] T031 [US1] Add the `free_tier_invites` migration, repository, and operator routes in `packages/platform/src/free-tier/invites.ts` with tests in `tests/platform/free-tier-invites.test.ts`
- [x] T032 [US1] Extend `POST /api/auth/provision-runtime` for the free plan (invite check, capacity ceiling, one runtime per owner) in `packages/platform/src/auth-routes.ts` with tests in `tests/platform/provision-free-runtime.test.ts`
- [x] T033 [US1] Add `POST /internal/containers/:handle/register` in `packages/platform/src/substrates/container-internal-routes.ts` with epoch and generation tests in `tests/platform/container-register-route.test.ts`
- [x] T034 [US1] Initialize funded-AI policy, balance, and once-per-owner starter credit on container registration in `packages/platform/src/customer-funded-starter-policy.ts`, and allow credential issuance for class `free` in `packages/platform/src/ai-funded-policy-repository.ts`, with tests in `tests/platform/ai-funded-container-runtime.test.ts`
- [x] T035 [US1] Accept a container runtime in device sign-in (`packages/platform/src/auth-routes.ts`) and in journey phases (`packages/platform/src/journey.ts`), returning `RuntimeState`, with tests in `tests/platform/journey-container-runtime.test.ts`
- [x] T036 [US1] Wake on authenticated owner request only in `packages/platform/src/session-routing-middleware.ts`, with tests that collaborators and unauthenticated requests never start compute in `tests/platform/session-routing-wake.test.ts`

### Stack D (web first)

- [ ] T037 [US1] Shared runtime-state model and hook in `shell/src/lib/runtime-state.ts` with tests in `tests/shell/runtime-state.test.ts`
- [ ] T038 [US1] Free plan choice and waitlist state in the pre-VPS shell (`shell/src/components/BillingGate.tsx` and `shell/src/app/runtime/page.tsx`) using `@matrix-os/brand`
- [ ] T039 [US1] Waking, restoring, busy, and failed states through `ShellNotificationStack` and the Chat composer (draft preserved, sent once) in `shell/src/components/ChatApp.tsx`
- [ ] T040 [US1] Capability gating from `GET /api/runtime/capabilities` for the launcher and Settings in `shell/src/lib/runtime-capabilities.ts`, wired in both `shell/src/components/Desktop.tsx` and `shell/src/components/canvas/CanvasWindow.tsx`

**Checkpoint US1**: quickstart.md section 1 passes on Web Desktop and Web Canvas with live evidence.

## Phase 4: User Story 2 - Build and preview an app (P1)

**Independent test**: quickstart.md section 2.

- [ ] T041 [US2] Brokered build tool for the managed Pi worker with registry-proxy egress in `packages/gateway/src/chat/managed-pi-build-tool.ts`, with tests in `tests/gateway/managed-pi-build-tool.test.ts`. Amended after S3: it launches a separate build workload in the same container sandbox with fixed argv only (frozen `pnpm install`, then `node node_modules/vite/bin/vite.js build`); no shell for the chat worker; no package scripts; fixed environment `npm_config_registry`, `PNPM_MAX_WORKERS=2`, `MALLOC_ARENA_MAX=2`, `CI=1`, `npm_config_ignore_scripts=true`, `npm_config_update_notifier=false`; a wall-clock timeout and a free-space check before and during each install and build, both ending in `needs_build` with a safe error (T043). Tests include a full-disk case that must not hang
- [ ] T041a [US2] Dedicated egress socket for the build workload (for example `/run/matrix-egress/registry.sock`) in the container sandbox command, separate from the broker socket; the gateway forwards it to the platform mirror and adds the runtime token. Denial tests inside the sandbox: direct TCP, DNS, metadata endpoint, loopback, other hosts, and publish all fail
- [ ] T041b [US2] Ship a version-pinned pnpm in the runtime node directory (`/opt/matrix/runtime/node`) in `Dockerfile.runtime`; the build tool ignores the app's `packageManager` field
- [ ] T041c [US2] Per-owner pnpm store and metadata cache on its own writable bind at `/workspace/.pnpm-store`, outside the flushed home, under a disk quota (placement per D9), with a test that the mount-source validation still passes after install
- [ ] T041d [US2] Ship a lockfile with `home/apps/_template-vite`, or have the build tool resolve on first install and use frozen installs after; test that a fresh template app installs with `--frozen-lockfile`
- [ ] T042 [US2] Platform registry proxy with per-owner rate and byte caps in `packages/platform/src/free-tier/registry-proxy.ts`, with tests in `tests/platform/registry-proxy.test.ts`. Amended after S3: mirror (pull-through) mode only; GET and HEAD of metadata and `/<name>/-/<file>.tgz` only; upstream over TLS to a fixed origin with `redirect: "error"` and a 30 s timeout; no client headers forwarded; metadata size cap; tarball URLs rewritten to the mirror; `minimumReleaseAge` and a denylist. Include a test that an IPv4-mapped `::ffff:0:0/96` block rule does not refuse plain IPv4 addresses
- [ ] T043 [US2] Failed builds keep the previous `dist` and report `needs_build` with a safe error in `packages/gateway/src/app-runtime/dispatcher.ts`, with tests in `tests/gateway/app-dispatcher-failed-build.test.ts`
- [ ] T044 [US2] Container integration test: chat builds an app, record saved, source changed, rebuilt, in `tests/e2e/container-app-build.test.ts`

## Phase 5: User Story 3 - Leave and come back (P1)

**Independent test**: quickstart.md section 3.

- [ ] T045 [US3] Container mirror profile that keeps built output and packs project history in `packages/gateway/src/sync/home-mirror-ignore.ts`, with tests in `tests/gateway/home-mirror-container-profile.test.ts`
- [ ] T045a [US3] Container profile skips boot-time `git init && git add . && git commit` in `packages/kernel/src/boot.ts` (`ensureHome`); test that a hydrated home without `.git` boots without running git. History persistence follows D8
- [ ] T046 [US3] Hydrate gate: `GET /internal/runtime/ready` is 200 only after initial pull and database check, never on an empty home when a manifest exists, in `packages/gateway/src/runtime-profile/ready.ts`, with tests in `tests/gateway/runtime-ready-gate.test.ts`. Amended after S4: "initial pull" means the boot-set archive matching the accepted manifest (T046a), not the full home; the mirror's `start()` must not run a full rescan push before ready
- [ ] T046a [US3] Boot-set archive written as one object at every flush (owner-owned system config, `agents/custom`, owner app manifests, owner icons, the `VACUUM INTO` copy of `matrix.db`), and restored before `ensureHome` and before the gateway opens `matrix.db`, in `packages/gateway/src/runtime-profile/boot-set.ts`, with tests in `tests/gateway/runtime-boot-set.test.ts`
- [ ] T047 [US3] Consistent snapshot of `system/matrix.db` and owner database dump to the VPS backup layout in `packages/gateway/src/runtime-profile/flush.ts`, with tests in `tests/gateway/runtime-flush.test.ts`. Amended after S4: the snapshot is `VACUUM INTO` from a separate read-only connection; `system/matrix.db*` is excluded from file sync; dump keys use seconds plus generation, not minutes
- [ ] T047a [US3] Final flush in a fixed order (files, then manifest commit, then owner Postgres dump) with a deadline from configuration (default 120 s, 3 attempts) replacing the hard-coded 10 s in the mirror `stop()`; a test fails if the dump is taken before the manifest commit
- [ ] T047b [US3] Batched flush: a stat walk on the 30 s timer, one manifest generation per flush, and a flush barrier ("every change seen before T is in an accepted manifest") used by the timer, the final flush, and the upgrade drain, in `packages/gateway/src/sync/`; replaces the per-file manifest commit for the container profile
- [ ] T047c [US3] Shard the manifest or write deltas so a one-file flush does not upload the whole manifest (16 MB for the S4 large home); keep the 32 MiB manifest cap meaningful
- [ ] T047d [US3] Packs layout: files of 256 KiB or less in about 16 MiB ustar packs, larger files as blobs; `ManifestEntrySchema` gains `{ packKey, offset, size }` and legacy blob entries stay readable; `initialPull` reads packs with parallel ranged GETs and no per-file `state.json` rewrite; a recurring repack and GC reclaims superseded bytes. Runs on both substrates, so the paid regression lane must pass
- [ ] T047e [US3] Lazy background fill after ready: listings and stats from the manifest, fetch on miss for `GET /files/*`, mutations refused on not-yet-local paths, apps and icons not marked missing or `needs_build` while their files are in flight, filled files marked as written so the watcher does not push them back, and agent turns held until the fill completes; with tests per route group listed in `spikes/s4-hydrate-flush.md`
- [ ] T047f [US3] Record the hydrated manifest version and sha256 in owner Postgres (not in local `.matrix-home-mirror/state.json`), used by needs-recovery and crash-window reporting
- [ ] T047g [US3] Bulk hydrate through presigned URLs or a batch presign from the object broker instead of proxying every byte, in `packages/platform/src/internal-sync-routes.ts`, keeping the owner-prefix check
- [ ] T048 [US3] `quiesce`, `resume`, and `flush` routes with atomic refusal of new runs in `packages/gateway/src/server/runtime-lifecycle-routes.ts`, with race tests in `tests/gateway/runtime-quiesce.test.ts`
- [ ] T049 [US3] `ActivityTracker` (bounded, TTL) and `IdleReaper` (hard maximum session, quiesce then flush then stop) in `packages/platform/src/substrates/idle-reaper.ts`, with tests in `tests/platform/idle-reaper.test.ts`
- [ ] T050 [US3] `flushed` and `activity` internal routes and the needs-recovery path in `packages/platform/src/substrates/container-internal-routes.ts`, with tests in `tests/platform/container-flushed-route.test.ts`
- [ ] T051 [US3] `OrphanReconciler` deleting compute with no current-generation record, never databases or prefixes, in `packages/platform/src/substrates/orphan-reconciler.ts`, with tests in `tests/platform/orphan-reconciler.test.ts`
- [ ] T052 [US3] Interrupted-run labelling after a crash start in `packages/gateway/src/chat/orchestrator.ts` recovery path, with tests in `tests/gateway/chat-interrupted-after-crash.test.ts`
- [ ] T053 [US3] Staging lane: 10 stop and start cycles, 3 deletions, 1 crash in `tests/e2e/container-persistence.test.ts`

## Phase 6: User Story 4 - Hit a limit (P1)

**Independent test**: quickstart.md sections 4 and 5.

- [ ] T054 [US4] Per-owner byte quota enforced in the same statement that authorizes a write in `packages/platform/src/internal-sync-routes.ts`, with the `runtime_storage_usage` migration and race tests in `tests/platform/sync-storage-quota.test.ts`
- [ ] T054a [US4] Home file-count limit (default 50,000, FR-022) enforced with the byte quota; the write fails visibly and read, export, and delete still work
- [ ] T055 [US4] Database size and connection limits per owner role in `packages/platform/src/substrates/container-owner-database.ts`, with tests in `tests/platform/container-database-limits.test.ts`
- [ ] T056 [US4] Free runtime policy (model allowlist, monthly budget) in `packages/platform/src/free-tier/funded-policy.ts`, with boundary race tests in `tests/platform/free-funded-policy.test.ts`
- [ ] T057 [US4] Global ceilings (running, total, daily funded spend) and busy responses in `packages/platform/src/free-tier/capacity.ts`, with tests in `tests/platform/free-tier-capacity.test.ts`
- [ ] T058 [US4] Read, export, and delete stay available when a limit is reached: gateway export route in `packages/gateway/src/server/system-operator-routes.ts` (replacing the 501), with tests in `tests/gateway/owner-export.test.ts`
- [ ] T059 [US4] `limit_reached` state and upgrade or own-account prompt in `shell/src/components/ChatApp.tsx` and Settings billing
- [ ] T060 [US4] Two-owner isolation lane (database, object keys, private address, metadata endpoint, cross-handle token) in `tests/e2e/container-isolation.test.ts`

## Phase 7: User Story 5 - Upgrade to a VPS (P1)

**Independent test**: quickstart.md section 6.

- [ ] T061 [US5] `runtime_migrations` migration and repository with compare-and-set transitions in `packages/platform/src/migrations-runtime/repository.ts`, with tests in `tests/platform/runtime-migration-repository.test.ts`
- [ ] T062 [US5] `MigrationRunner` state machine, each step idempotent and resumable, in `packages/platform/src/migrations-runtime/runner.ts`, with failure-injection tests per state in `tests/platform/runtime-migration-runner.test.ts`
- [ ] T063 [US5] Final sync and inventory (row counts, manifest digest, app list, balances) in `packages/platform/src/migrations-runtime/inventory.ts`
- [ ] T064 [US5] Provision the VPS through the existing customer provisioning path with restore from the container layout in `packages/platform/src/migrations-runtime/provision-target.ts`
- [ ] T065 [US5] Balance transfer and substrate switch in one transaction under the per-owner funding lock in `packages/platform/src/migrations-runtime/complete.ts`, with tests that no second starter grant occurs in `tests/platform/runtime-migration-complete.test.ts`
- [ ] T066 [US5] Start a migration from the verified Stripe webhook in `packages/platform/src/billing/` webhook handler (idempotent on event id, non-2xx on failure), and add `GET` and `POST /api/runtime/upgrade`
- [ ] T067 [US5] Upgrade progress, failure, and abandon UI in `shell/src/components/BillingGate.tsx` and Settings billing
- [ ] T068 [US5] Staging lane: three owners, one failed and resumed, one abandoned, in `tests/e2e/container-upgrade.test.ts`

## Phase 8: User Story 6 - Same experience on every client (P2)

**Independent test**: quickstart.md section 8.

- [ ] T069 [P] [US6] Electron Desktop sign-in and runtime states in `desktop/src/main/auth/device-auth.ts` and `desktop/src/renderer/src/stores/connection.ts`
- [ ] T070 [P] [US6] Native Mobile journey gate and runtime states in `apps/mobile/lib/journey.ts` and `apps/mobile/lib/canonical-chat-session-context.tsx`
- [ ] T071 [P] [US6] Web Mobile parity with Native Mobile in the shell mobile launcher
- [ ] T072 [US6] Capability gating and upgrade UI on Electron Desktop and Native Mobile from shared derivations
- [ ] T073 [US6] Live screenshots and recordings per surface attached to the PRs and shared in Slack `#tech`

## Phase 9: Polish and rollout

- [ ] T074 Amend the VPS-native rule in `AGENTS.md` and `docs/dev/vps-deployment.md` (FR-017) and add an operator runbook in `docs/dev/container-runtime.md`
- [ ] T075 Site docs PR in `FinnaAI/matrix-os-site` under `content/docs/`
- [ ] T076 Paid controls during failure injection (quickstart.md section 7)
- [ ] T077 Cold-start and wake report: 20 trials each (SC-003) and cost per active free owner (SC-007). Includes gateway boot on an idle 1 vCPU guest with the real image, which S4 could not measure
- [ ] T078 Staged enablement: internal accounts, invite list, then open signup when D4's condition holds

## Dependencies

- T004 to T010 gate Stacks B and C. Stack A (T011 to T019) has no spike dependency and starts now.
- T010a has no dependency and lands before T046a, because the boot-set restore must not race template setup.
- T046a needs T047 (snapshot) and T047b (one manifest per flush). T047e needs T046a. T047d and T047c can land in either order after T047b.
- T041a to T041d before T044. T041 needs T041a and T042.
- US1 needs Stack A. US2, US3, and US4 need US1. US5 needs US3 (flush layout). US6 needs US1 on web.
- Inside Stack A: T011, T012, then T014; T013 in parallel; T015, T016, then T017, T018, T019.

## Parallel examples

- T004, T005, T006 together.
- T013 alongside T011 and T012.
- T069, T070, T071 together once T035 and T037 are merged.

## Implementation strategy

MVP is Stack A plus US1 on Web Desktop behind the invite gate. US3 and US4 must land
before any external invite is sent: persistence and limits are launch preconditions, not
follow-ups.
