# Validation ledger: collaboration preview pair

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418). Native stack base:
[spec PR #3022](https://github.com/HamedMP/matrix-os/pull/3022).
No cloud provisioning, production deployment or live collaboration acceptance
has been performed by this feature implementation yet.

## Planning/tooling phase

- Named fault: the branch-creation hook permits four-digit feature numbers, but
  downstream setup rejects them and ignores the persisted independent feature
  directory. Invalid metadata also silently falls back instead of rejecting it.
- Real boundary: production Bash setup/prerequisite scripts copied into disposable
  real Git repositories with committed fixture branches, actual metadata and paths.
- Red: nine intended assertion failures; legacy three-digit case passed. Initial
  sandbox subprocess denial and unborn fixture branches were corrected before
  accepting regression evidence.
- Green: `pnpm exec vitest run tests/scripts/speckit-feature-paths.test.ts` — one
  file,10passed. The actual feature setup and prerequisite entrypoints now resolve
  this spec from the independent implementation branch.
- Full `bun run typecheck` — exit0, all eight project/config entries passed.
- `bun run check:patterns` — exit0, zero violations/five pre-existing warnings.
- Spec Kit checks: six planning artifacts with no unresolved questions, actual
  relative links validated,42 tasks with sequential IDs/story/path syntax verified,
  requirements checklist16/16 and `git diff --check` clean.

## Remaining required qualification

Implementation tasks are tracked in [tasks.md](tasks.md). Pair transaction/race,
actual Electron process/native artifact, protected two-account cloud/model and
per-surface capture results must be recorded as they execute. Missing isolation,
fixture identities, funding or OS access is a blocker, never a passing or skipped
required assertion. New screenshots/recordings belong outside Git and are attached
or linked to the review record.

### Foundation implementation (T005–T009)

- Contract baseline:16 intended assertions failed;17 pass after implementation.
- Config baseline:8 intended assertions failed;9 pass after implementation.
- Provenance baseline:13 intended assertions failed;13 pass after implementation.
- Actual Platform startup migration:2 intended assertions failed;2 pass.
- Combined foundation:41/41 pass, no skips. Provider records use production-shaped
  fixtures; authenticated live provider adapters are still pending.
- Dedicated local PostgreSQL16: simultaneous independent backend connections and
  actual Platform migrations pass1/1. Test owns a random schema, cleans pools and
  schema, and required CI inventory includes it. No VPS or customer data touched.
- Greptile corrections: legacy SPECIFY_FEATURE override and dangling metadata
  symlink reproduced2 failing assertions, then12/12 real Git/Bash cases pass.
  Spec invitation discovery now explicitly permits acceptance before content access.
- No live pair, native desktop, funding or visual qualification is claimed.

### Atomic admission and lifecycle implementation

- New real PostgreSQL cases: **34/34 passed across7 files, zero skipped**, serial
  run with actual Platform migrations and independent connections. This includes
  both-member rollback, duplicate convergence, one fixture lease, existing owner
  quota, customer collision preservation, stale claims, stop replay/expiry, explicit
  reset and competing stop/update, exact provider/label inventory and creation fences.
- Named faults observed: two unshared-transaction assertions; two prepare dispatch
  assertions; two handle/quota assertions; ordinary dispatcher booted a pair job;
  queued customer machine could be reclassified; stop replay failed; two pagination
  completeness assertions. Each is green after its fix.
- Claim fence mutation: removing generation/revision/claim/expiry checks makes7
  assertions fail; restored code passes. This is mutation evidence for new lifecycle
  behavior, not a claim of an existing production regression.
- Provider cleanup tests use real HTTP response parsing and durable Postgres queue
  operations with synthetic provider responses. No paid provider request occurred.
  Pagination is checked through the provider metadata documented at
  https://docs.hetzner.cloud/reference/cloud; incomplete inventory cannot prove absence.
- Platform TypeScript passes; pattern scan has0 violations and5 existing warnings.
- Broad required Postgres qualification attempted56 files but failed in the first
  batch: Chat queue concurrent admission produced27 successes instead of32; navigation
  tests timed out and a controls worker exited. Host swap was exhausted. Only this
  task's failed runner/children were stopped; broad qualification remains incomplete.
- Broad ordinary provisioning attempt also hit fixture timeouts/worker exits. A
  serial memory-bounded assertion inventory verified all20 ordinary provisioning
  assertions across ten fresh processes; all11 ordinary Preview-slot assertions
  also pass across six fresh processes. This does not qualify the interrupted
  broad Postgres lane. No assertions or deadlines were weakened.
- The ordinary dispatcher deliberately leaves pair jobs queued until independently
  verified isolation wiring is added in the controller layer. No public pair routes
  or native launch entrypoints are activated by this layer.

### Lifecycle review correction

Greptile found a real pinned-update target overwrite. Three actual Postgres
assertions fail before correction: observing a third head overwrites the selected
target, returning to the old head misses its currency warning, and observing the
selected target incorrectly marks it outdated. Two further assertions reproduce
revision churn on identical observations and failure to clear rollback currency.
The fix preserves the staged candidate, changes only its currency during update,
and carries that currency into the completed generation.

All15 admission/update assertions pass after the lifecycle review correction; Platform TypeScript passes.

### Operator API and readiness implementation

- Actual Hono routes enforce constant-time operator credentials, a16KiB streaming
  body limit, strict requests, safe errors and prefix isolation. Actual Platform
  registration remains disabled by default and leaves ordinary routes unchanged.
- Read authorization is requester/current-maintainer or leased fixture owner/member;
  the outsider, an expired principal and the wrong identity domain are rejected.
  The principal verifier is an explicit production adapter contract; no fixture
  principal verifier is mounted in production.
- Readiness uses the actual Postgres ledger and generation/revision/claim fences.
  Host, identity, service and funding observations remain synthetic adapter boundaries
  in these tests. Reports use the actual readiness producer and expire its proof.
- Final service/reconciler/admission/update run: **30/30 passed across4 files**,
  zero skipped. The expiry-progress case first failed because cleanup was repeatedly
  re-stopped; skipping that transition for cleanup-pending pairs makes it pass.
- Queue promotion leases a canonical fixture and prepares both members in one
  transaction. A second-member failure rolls everything back; hard expiry survives
  queue wait. Controller receipts bind the real requester before admission.
- Platform TypeScript passes for this layer. No provider boot, identity mutation,
  grant, deployment, native launch or live visual acceptance is claimed.
- T015 production provider/identity/source/host adapters and maintenance activation
  remain in the dependent controller layer; this API is not an operational preview
  service until those bindings pass independent isolation checks.

Final HTTP/readers/readiness/reports/queue/provenance run: **64/64 passed across7 files**, zero skipped. Combined with the separate30-case run, all94 assertions in these two inventories passed. Required Postgres CI inventory now includes the six new database suites.

### API review corrections

Greptile identified waiting-pair starvation and loss of wrong-running-version
diagnosis. Four real Postgres assertions failed first: a full waiting batch blocked
an active pair, a waiting reservation had no backoff, hard expiry was hidden by a
future schedule, and a wrong running version lost its computer-specific source
stage. The fix prioritizes expired/cleanup/active work, applies a15s backoff to busy
queues and fresh readiness, and checks runningVersion at the source boundary.
Live claims are not repeatedly selected; expiry still invalidates an active claim.

The first verification run then exhausted the task-owned384MiB temporary database
filesystem. That is an environment failure, not a passing result or code regression.
Only the verified ENG-418 fixture was replaced; no other container/database changed.
The unchanged verification run is recorded separately below when complete.

Final API review verification: **30/30 passed across4 files**, zero skipped, on
fresh local Postgres; Platform TypeScript passes. All four new fault assertions
are included in that run. No assertion or timeout was relaxed.
