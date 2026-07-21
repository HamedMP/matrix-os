# Quickstart: Golden VPS Snapshot Validation

This guide is for local/fake-provider validation. It does not authorize production provider resources or customer deployment.

## 1. Install and verify the baseline

```bash
pnpm install --frozen-lockfile
bun run check:patterns
```

Record the pre-stack, full-repository baseline separately: 5 advisory pattern warnings,
14 existing full-test failures, and the two existing implicit-any typecheck failures
named in PR #1053. A green targeted golden-snapshot gate does not rewrite that broader
baseline. Any new failure, changed failure identity, or failure in a snapshot-targeted
suite fails this stack's gate; baseline entries are never silently reclassified.

Run the complete snapshot gate in one Vitest process with one worker. This is the preferred low-CPU validation path; it builds shared prerequisites once and avoids concurrent PGlite migration suites.

```bash
bun run test:golden-snapshots
```

The narrower commands below are for isolating a failure. Keep `--maxWorkers=1` when CPU pressure matters.

## 2. Run the lifecycle and provider contract tests

```bash
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism \
  tests/platform/golden-snapshot-repository.test.ts \
  tests/platform/golden-snapshot-selection.test.ts \
  tests/platform/golden-snapshot-service.test.ts \
  tests/platform/golden-snapshot-routes.test.ts
```

Expected: concurrent enqueue converges on one candidate/build; at most the configured
number of durable running builds are claimed; a candidate cannot become ready before
successful sanitation and validation evidence; ambiguous provider responses enter
reconciliation; retention never deletes leased/protected snapshots.

## 3. Run host sanitation contract tests

```bash
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism tests/platform/golden-snapshot-host-scripts.test.ts
```

Expected: tests cover every sanitation category in the approved spec, verify services
remain quiesced, overwrite and sync free blocks, scan the raw root device for callback
and synthetic canaries without secret-bearing command arguments, and reject forbidden
paths/patterns, owner data, container volumes, persisted cloud-init/user-data, host
keys, machine identity, credentials, and logs.

## 4. Run provisioning/fallback tests

```bash
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism \
  tests/platform/golden-snapshot-provisioning.test.ts \
  tests/platform/customer-vps.test.ts \
  tests/platform/customer-vps-cloud-init.test.ts \
  tests/platform/customer-vps-hetzner.test.ts \
  tests/platform/customer-vps-host-bundle.test.ts
```

These are the explicit customer-VPS suites exercised by the combined gate. Do not use
the broad `customer-vps*.test.ts` glob: it pulls unrelated fleet, telemetry, TLS, and
release suites into the snapshot feedback loop and needlessly increases CPU and DB
migration work.

Required scenarios:

1. exact ready snapshot selected and leased;
2. newest compatible older snapshot updates to exact target before registration;
3. newer snapshot rejected for older target;
4. missing/rejected/quarantined/incompatible image uses clean Ubuntu fallback;
5. lost create response adopts one exact-labeled server; if adoption is impossible,
   the possible server's credentials are revoked and it is proven powered off or
   network-isolated before a successor is authorized, with exact deletion durably
   queued afterward (queued deletion alone is insufficient);
6. two owners receive unique machine IDs, SSH host keys, credentials, and stores;
7. recovery preserves owner-backup semantics;
8. existing-fleet deploy ignores snapshot build failure.

## 5. Run workflow tests and review gates

```bash
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism tests/platform/host-bundle-snapshot-workflow.test.ts
bun run check:patterns
bun run typecheck
bun run test
git diff --check
```

The release test must prove main/tag publication enqueues idempotently, preview/channel-only changes do not duplicate images, and enqueue/build failure does not block publication or `/vps/deploy`.

## 6. Separately authorized disposable-provider spike

Do not run this step without explicit operator authorization for a disposable Hetzner project and cleanup budget.

The spike must create one builder, one snapshot, and two validation clones; measure Action/image readiness, verify cross-location/architecture/disk rejection behavior, simulate a lost response, confirm exact-label reconciliation, validate cloud-init freshness/unique identity, delete exact resources, and prove the project returns to its starting resource count. Record only synthetic IDs and coarse timings in public artifacts.

## 7. Rollout verification

Keep selection disabled until the disposable spike passes. Then enable synthetic builds, preview/test machines, and a bounded customer cohort in sequence. At every stage verify exact bundle registration, 60% median improvement, p95 at or below 90 seconds, zero forbidden-state findings, bounded snapshot count, and immediate clean-image fallback when the feature switch is disabled.
