# Local DevStack Acceptance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent changes and superpowers:executing-plans for the coupled runtime qualification. Steps use checkbox syntax for tracking.

**Goal:** Deliver a reproducible local engineer/agent development loop with multiple real Matrix worktrees, authenticated previews, native managed execution and evidence-backed capability reporting.

**Architecture:** Preserve the accepted local pilot as a regression baseline. Compose current main with the existing watcher/import/identity fixes in a separate worktree. Reuse staging-slot ownership/lifecycle and runtime-slot routing, one-way Mutagen source projection, native OrbStack Linux execution, and explicit shared baseline services; do not build a scheduler or dashboard.

**Tech Stack:** Node 24+, pnpm 10.33.4, TypeScript, tsx, Docker on OrbStack, OrbStack Linux machines, systemd, Mutagen, PostgreSQL/Kysely, Nginx.

**Spec:** [DevStack specification PR #3023](https://github.com/HamedMP/matrix-os/pull/3023), `specs/639-devstack/spec.md` in the existing spec worktree. Tracking: ENG-432.

## Global Constraints

- Only local OrbStack; preserve the existing Main and Dev Computer.
- No Trellis task creation, cloud provisioning, cloud deployment, merge or external message.
- Preserve the cumulative $10 authorization, previous spending and original expiry; no automatic top-up or per-worktree duplicate grants.
- Real auth, strict TLS, distinct runtime identity, owner state and permissions; no auth bypass.
- Support configurable N; qualify at least three actual worktrees, without claiming three is a product limit.
- Source, lockfile, native architecture, actual capabilities and deferred gates are visible in receipts.
- Retained repository changes use manual worktrees, TDD and PRs. Public documentation is a separate FinnaAI/matrix-os-site PR.

## Review Focus

1. Switching a worktree must not switch another tab's API/WS traffic or mutate a peer's state.
2. Failed sync/build/start must not execute a partial revision or stop the previous healthy revision.
3. Development chunks must not receive production immutable cache headers.
4. Cleanup must verify exact resource ownership and retain stopped data; no broad process/container deletion.
5. Replaying bootstrap must not refill funds, import personal credentials or extend expiry.

## Tasks

### Task 1: Explicit development origins and runtime asset caching

**Files:**
- Create `shell/dev-origins.mjs` and focused Node tests under `tests/scripts/`.
- Modify `shell/next.config.ts` to consume the helper.
- Modify `packages/platform/src/session-routing-proxy.ts` and its focused tests.

**Interfaces:** Export `resolveAllowedDevOrigins(raw?: string): string[]`; preserve the four existing hostnames and append exact hostname-only entries from comma-separated `MATRIX_ALLOWED_DEV_ORIGINS`. Reject wildcards, schemes, ports, paths, whitespace inside entries, invalid DNS labels and more than 32 additional entries. Empty/unset returns existing defaults; duplicates collapse. No production broadening.

- [ ] Write and run failing tests for a scoped hostname, duplicates, empty input and rejected wildcard/URL/port/invalid/oversized input.
- [ ] Implement the helper and wire the Next configuration.
- [ ] Preserve upstream `no-store`/`no-cache` on `/_next/static/` in `applyAppDomainRuntimeAssetCacheHeaders`, while still forbidding CDN caching and varying on Cookie/Accept-Encoding. Production immutable upstream assets retain existing behavior; icon and Vite policies stay covered.
- [ ] Run focused regressions and type checks appropriate to the changed files. Commit only these files and report commands/results.

### Task 2: Owned local worktree operations

**Files:** Extend `scripts/staging-slot.sh` through a separate local adapter in `scripts/devstack/`; add focused lifecycle/sync tests and `docs/dev/devstack.md`.

**Interfaces:** Explicit private instance manifests identify authoritative worktree, applied revision, local Docker/OrbStack resources, preview, source synchronization and log/test execution. Operations: preflight/start/status/exec/logs/test/preview/stop/resume. Read-only status never invokes paid readiness. Stop preserves data; reset is explicit. Reuse existing command/process helpers and staging claim semantics rather than creating a scheduler.

- [ ] Pin current source/dependency baselines and inspect native supervisor/broker ownership requirements.
- [ ] Write failing tests for foreign resource rejection, duplicate claim, capacity, failed-start cleanup, stop/resume and instance-scoped feedback.
- [ ] Implement the local adapter and isolated one-way source transport; generated credentials and outputs stay outside the source projection.
- [ ] Prove ordinary dirty edits reach the intended Shell/Gateway/Kernel/Platform/Relay, with bounded logs/test exit status and applied-source evidence.

### Task 3: Real local capability and concurrency acceptance

**Files:** Private redacted acceptance matrix/receipts; retained regressions beside the owning code.

- [ ] Repeat identity initialization without replacing state or refilling credits.
- [ ] Qualify three actual worktrees with explicit selective baseline reuse, independent HOME/database/runtime identity, preview/API/WS routing and stale-source rejection.
- [ ] Change one instance, cause and recover a failed build, interrupt synchronization, stop/resume it, and verify peers remain unchanged. Measure warm feedback latency and memory.
- [ ] Verify genuine Web login/refresh, managed Chat/tool execution, Terminal, one consented integration read, persistence and bounded funded settlement. Reuse prior exact-version receipts only where the version and wiring remain identical.
- [ ] Exercise negative auth/owner/cross-instance cases. Do not promote local ARM evidence to Linux/x64 VPS, Electron or shared Linux acceptance.
- [ ] Repair discovered blockers with focused regressions and PRs; record blocked external capabilities precisely.

### Task 4: Reviewable delivery and handoff

- [ ] Review the exact implementation diff and run relevant local checks.
- [ ] Publish linked implementation PR(s) with source/transaction/auth/orphan/deferred-scope invariants and acceptance evidence. Keep unmerged prerequisite fixes visible.
- [ ] Update ENG-432 with actual local capability status.
- [ ] Open a separate public-safe site documentation PR describing only supported commands and boundaries.
- [ ] Leave usable worktrees running or stopped with data preserved, and provide the engineer's daily edit/test/switch workflow.
