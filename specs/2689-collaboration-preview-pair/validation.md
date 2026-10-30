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
