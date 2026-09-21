# S18 platform cutover journal receipt — T088/T089/T102 subset

**Branch:** `124/s18-platform-journal` (local child of `124/s18-cutover` at `4ddb94a27`). **RED:** `77ab28b8f`. **GREEN:** `13abcceb6`. This receipt records the platform journal and ticket fence only; the gateway home cutover and release activation are separate S18 work.

## Changed files

- `packages/platform/src/collaboration/cutover.ts`: durable per-scope phase coordinator, immutable inventory/count and ceiling checks, blocked resume, generation activation, compatible-direct or disabled rollback, and explicit person-to-person disposition.
- `packages/platform/src/collaboration/database.ts`: additive `collaboration_cutover_journal` and `collaboration_cutover_dispositions` tables in the locked platform migration transaction.
- `packages/platform/src/collaboration/repository.ts`: directory-event guard inside the scope row-lock transaction; stale pre-cutover generations cannot reopen activated authority.
- `packages/platform/src/collaboration/ticket-issuer.ts` and `direct-wiring.ts`: direct ticket admission checks the journal and activated generation before signing; journal/query failure denies issuance.
- `tests/platform/collaboration-cutover-postgres.test.ts`: real-Postgres journal, failure, rollback, disposition, directory-event, and ticket regressions.

## RED and GREEN

- RED on real PostgreSQL: the first committed test run had **8 failures and 1 pass** because the journal implementation was absent. The later targeted ticket test, `-t 'rejects a new direct ticket after disabled rollback'`, failed because a valid signed ticket was issued after disabled rollback. An intermediate run had **8 passes and 1 failure** while the directory-event freeze guard was absent.
- GREEN on real PostgreSQL: `source /tmp/matrix-os-124-postgres.env && PATH=/home/nima/.bun/bin:$PATH pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2 --reporter=dot` → **1 file, 10/10 tests passed** (4.84 s). The environment file is local and excluded from Git; no connection details are recorded here.
- Focused ticket regression: `PATH=/home/nima/.bun/bin:$PATH pnpm exec vitest run tests/platform/collaboration-tickets.test.ts tests/platform/collaboration-direct-routes.test.ts --maxWorkers=2 --reporter=dot` → **1 discovered file, 16 passed, 1 skipped** (37.49 s). The second requested filename does not exist in this worktree.
- `pnpm exec tsc --noEmit -p packages/platform/tsconfig.json` → exit 0. `bun run check:patterns` → 0 violations, 5 existing warnings. `git diff --check` → clean.

## Migration and rollback

The platform migration adds journal/disposition tables without changing existing collaboration rows. A journal records `pending → inventoried → fenced → drained → staged → verified → active`, or `blocked` with a resume phase. Platform directory generation and user-index locator generation advance in one transaction after home activation; a failed compare-and-swap leaves the journal blocked. Compatible rollback retains the active direct generation and never reopens the legacy ACL. Disabled rollback blocks platform ticket issuance first and then asks the home to fence sessions. A failed home disable remains blocked for reconciliation.

The test uses an injected fake home against a real Postgres platform database. It covers idempotent import; ambiguous/offline owner resolution; exact source counts, IDs, and ceiling digest; failed freeze; interrupted directory-generation compare-and-swap; compatible/disabled rollback; and explicit disposition of legacy person-to-person rows, including ended index rows. It does not claim a whole-home data backup: `backupInventoryRef` is a durable authorization-inventory reference.

## Open integration and release gates

- The gateway home cutover result is flat while the platform journal uses grouped counts. T090 composition must adapt counts, IDs/ceiling/fence digests, backup-inventory reference, and the canonical run-interruption callback. Both sides use the same scope/owner/organization/runtime, source/target generation, and idempotency key. No cross-package live call is wired or claimed here.
- Journal-less scopes remain eligible for direct tickets so new direct-created scopes can work. The coordinated T090 release path must distinguish those from any preexisting scope that has not been inventoried and cut over.
- The local disposition test uses opaque notice, backup, and home-receipt references. Real customer notice, home disposition, inventory totals, and the S18 real-host cutover journal remain **unrun**. No provider, UI, Electron, or live-host probe was run for this platform-only child.
- Home disable failure blocks new platform tickets, but the gateway must prove existing-session fences and reconciliation. No deployment, publication, or legacy proxy fallback was exercised.
