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
