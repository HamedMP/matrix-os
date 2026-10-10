# CI speed and dedicated Linux runner

Goal: benchmark all existing required validation on a dedicated 16-vCPU/64-GB Linux host; target <5 minutes for typical PRs without silently dropping tests. Measure cold/warm execution and queue separately. Do not change release guarantees or main coverage-frontier semantics.

## U1: Workflow parallelism and cache
Goal: remove unnecessary scheduling dependencies, avoid repeat prerequisite builds, improve caches, retain required checks and docs-only behavior.
Files: `.github/workflows/ci.yml`, `package.json`, `tests/platform/ci-workflows.test.ts`, new focused `tests/scripts/ci-fast-workflow.test.ts`, `.github/workflows/README.md`.
Approach: test first; preserve main FIFO/frontier but cancel obsolete PR runs. Run unit independently of sync-client, E2E independently of unit, shell build independently of typecheck where safe. Preserve prerequisite package builds inside jobs. Build shared prerequisites once per E2E/funded job, use direct Vitest for later steps. Add lockfile/platform/toolchain keyed Next and Playwright caches. Emit unit JSON per shard for profiling; upload even on failure. Core runner routing opt-in via MATRIX_CI_RUNNER_ENABLED repository variable; fork PRs always hosted. Keep service-container/root-fixture jobs hosted initially. Do not require human approval or add deployment secrets.
Patterns: `tests/platform/ci-workflows.test.ts`, CI Results existing fail-closed gate.
Test scenarios: required jobs retained; no unit/E2E gate chain; stale PR cancellation but main queue preserved; frozen lockfile; build before direct test calls; fork routing; cache keys include toolchain/lock; profiling output per shard.
Verification: focused workflow contracts and existing ci-workflows tests pass.

## U2: Profiling and balanced shards
Goal: deterministic duration-balanced unit shards with bounded configurable workers, all collected tests assigned exactly once.
Files: `scripts/ci/test-sequencer.ts`, `scripts/ci/test-profile.mjs`, `scripts/ci/test-durations.json`, `vitest.config.ts`, new `tests/scripts/ci-test-profile.test.ts` and `tests/scripts/ci-test-sequencer.test.ts`.
Approach: test first. Custom Vitest sequencer uses checked-in optional historical file durations with deterministic longest-first placement; unknown tests get safe median cost; no omission of new tests. Bounded CI-only worker override `MATRIX_TEST_WORKERS` 1..16 (default remains 2). Profiling CLI ingests Vitest JSON and emits public-safe relative-path durations plus summaries, validates bounds/input and writes atomically. Do not add dependencies. Worker obtains Vitest installed API types locally before custom sequencer. Keep local default behavior where no shard argument. Root will provide actual profile output from GitHub logs/server.
Patterns: existing `scripts/ci/*.mjs`, Vitest config.
Test scenarios: unique complete assignment, imbalance improvement, unknown/new files included, deterministic ties, invalid paths/durations, config worker range, shuffled input stability.
Verification: focused tests pass and a real sharded Vitest run collects assigned files.

## U3: Disposable runner infrastructure
Goal: reusable setup for short-lived isolated runner containers on dedicated Hetzner Linux host, plus repeatable benchmark commands.
Files: `scripts/ci/runner/Dockerfile`, `scripts/ci/runner/README.md`, `scripts/ci/runner/start-ephemeral.sh`, `scripts/ci/runner/bootstrap-host.sh`, new focused `tests/scripts/ci-runner-isolation.test.ts`.
Approach: preinstalled Node24/pnpm10.33.4/Bun/git/ripgrep/browser deps; non-root ephemeral runner containers with no Docker socket, no host credential mounts, no privileged mode or host networking; fixed CPU/memory caps and explicit cleanup. Registration tokens supplied via stdin, never CLI/logs; runner registration only grants job credential, operator GitHub/Hetzner tokens stay local. Job labels matrix-ci-linux plus linux/x64; service-container and root fixture jobs remain hosted. Bound concurrency to machine resources; no container reuse across jobs. Only current reviewed workflow/job configurations should be admitted; document public-repo risk and opt-in rollout. Include safe host firewall/SSH baseline. Pin downloads/version/digests where available and validate checksums. No production credentials.
Patterns: repo shell scripts and docs public-safe boundaries.
Test scenarios: no docker socket/privileged/network host, cap/cleanup semantics, secrets stdin, ephemeral registration and non-root, checksum verification, tools exact versions.
Verification: shell syntax checks, focused contracts; root will actually build/run image and benchmark via SSH.

## Completion
Merge independent units into orchestrator branch; run tests. Provision one CCX43 dedicated host with existing authorized SSH key in EU, record cost privately. Benchmark baseline vs optimized at same source SHA, cold/warm, summarize bottlenecks/failures honestly. Open PR with source-of-truth, transaction/lock scope, orphan states, auth, deferred scope. Greptile 5/5 is required before merge; add ready-for-ci at 5/5. Internal CI work has no customer-facing site change; public developer docs live in repository, with site docs follow-up only if a developer-facing capability needs it.
