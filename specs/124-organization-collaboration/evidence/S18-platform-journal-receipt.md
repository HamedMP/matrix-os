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

- The gateway home cutover result is flat while the platform journal uses grouped counts. The adapter and signed T090 transport below now map counts, IDs/ceiling/fence digests and backup-inventory reference; the gateway route injects the canonical drain callback locally. Both sides bind the same scope/owner/organization/runtime, source/target generation and idempotency key. A live-host call is still unrun.
- Journal-less scopes remain eligible for direct tickets so new direct-created scopes can work. The coordinated T090 release path must distinguish those from any preexisting scope that has not been inventoried and cut over.
- The local disposition test uses opaque notice, backup, and home-receipt references. Real customer notice, home disposition, inventory totals, and the S18 real-host cutover journal remain **unrun**. No provider, UI, Electron, or live-host probe was run for this platform-only child.
- Home disable failure blocks new platform tickets, but the gateway must prove existing-session fences and reconciliation. No deployment, publication, or legacy proxy fallback was exercised.

## Flat home adapter follow-up

**RED:** `75677dfa6` adds two real-Postgres adapter cases and requires explicit compatible-direct rollback proof. `source /tmp/matrix-os-124-postgres.env && PATH=/home/nima/.bun/bin:$PATH pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2 --reporter=dot` failed at module load: `Cannot find module '../../packages/platform/src/collaboration/cutover-home-adapter.js'`; 1 failed suite, no tests collected.

**GREEN:** `c20486b44` adds `packages/platform/src/collaboration/cutover-home-adapter.ts`. The same real-Postgres command returned **1 file, 12/12 passed** (5.74 s). `pnpm exec tsc --noEmit -p packages/platform/tsconfig.json` exited 0; `bun run check:patterns` returned 0 violations and 5 existing warnings; `git diff --check` clean.

The adapter checks scope, organization and phase, maps `legacyCount + grantCount` to the frozen grant total, preserves IDs/ceiling/fence digests, and passes a scoped `drainRuns` callback to gateway `drain`. The platform now requires `{ compatibleDirectBuild: true }` before a compatible rollback and sends the original source generation in rollback/disable requests, matching the gateway's immutable idempotency key. The first adapter test verifies a journal progression against a fake flat gateway port while platform state is real Postgres. W3's concrete gateway helper is `drainActiveSharedRunsForCutover({ db, scopeId, ownerId, orchestrator })`: it uses canonical `cancelSharedRun` with no invented loss reason, then rereads active runs; gateway `drain` independently rejects a false zero. The combined test below verifies that local composition; a live home cutover remains unrun.

## Authenticated platform-to-home transport follow-up

**RED:** `c7eaf8e70` added a real-Postgres platform journey against an in-process Hono route that checks the bearer token and Ed25519 command signature, plus offline/mismatched-home cases. The suite failed at import because `cutover-home-transport.js` did not exist (1 failed suite, no collected tests). `138753f8b` pinned production bootstrap composition; `pnpm exec vitest run tests/platform/collaboration-bootstrap.test.ts --maxWorkers=2 --reporter=dot` returned 1 failed/3 passed because the configured runtime had no `cutover` coordinator. A read-only review of W3's gateway route found that its strict command schema requires a UUID nonce; `749945c4a` pinned this requirement, and the focused real-Postgres journey failed with `blocked` instead of `active` while the platform used a base64url nonce.

**GREEN:** `98b95c2cf` composes the coordinator in platform bootstrap and adds `cutover-home-transport.ts`. The exact command `source /tmp/matrix-os-124-postgres.env && PATH=/home/nima/.bun/bin:$PATH pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2 --reporter=dot` returned **1 file, 14/14 passed** (6.77 s). The bootstrap command above returned **4/4 passed** (5.79 s). `pnpm exec tsc --noEmit -p packages/platform/tsconfig.json` exited 0; `bun run check:patterns` returned 0 violations and 5 existing warnings; `git diff --check` clean.

The platform resolves the exact running enrolled machine by runtime UUID and owner, derives its per-machine bearer, signs each phase command with the active direct Ed25519 key under `matrix-collaboration-cutover-v1`, and sends it through the configured VPS dispatcher. HTTP redirects are rejected, requests have a 10-second timeout, and JSON responses are bounded to 32 KiB and strictly parsed. Missing keys, offline machines, transport errors, and altered scope/organization/phase responses block the journal. W3's gateway route uses the same path, command shape, domain, and response shape; it verifies normal gateway bearer auth plus fresh control-stream platform keys, binds owner/runtime/path/phase, rejects replay, and injects the canonical scoped drain callback locally. JavaScript callbacks never cross HTTP.

The first platform journey test uses a Hono route fixture that verifies the bearer and signature while platform journal state lives in real Postgres. It does **not** instantiate W3's real gateway route or owner database; the combined test below closes that local integration gate. A live host cutover remains **unrun**. Legacy proxy/WS paths have not been retired.

## Actual gateway route integration follow-up

**RED:** `0067501e9` adds `tests/platform/collaboration-cutover-fullstack-postgres.test.ts`. On the isolated platform branch, `source /tmp/matrix-os-124-postgres.env && PATH=/home/nima/.bun/bin:$PATH pnpm exec vitest run tests/platform/collaboration-cutover-fullstack-postgres.test.ts --maxWorkers=2 --reporter=dot` failed at import: `Cannot find module '../../packages/gateway/src/collaboration/cutover.js'` (1 failed suite, no tests collected). That gateway packet is a separate branch by design.

**GREEN in disposable combined worktree:** `124/s18-cutover-integration` @ `22acfa126` started at clean W3 gateway receipt head `801883466` and replayed three platform S18 prerequisites plus the platform journal/transport commits, without modifying either packet branch. The same exact real-Postgres command returned **1 file, 2/2 passed** (9.13 s). `pnpm exec tsc --noEmit -p packages/platform/tsconfig.json` and `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json` both exited 0; `bun run check:patterns` returned 0 violations and 5 existing warnings.

The combined test uses separate real-Postgres schemas for platform and owner home, the actual `createCollaborationCutoverRoutes` handler beneath gateway `authMiddleware`, the platform HTTP signer, gateway journal, and `drainActiveSharedRunsForCutover`. It verifies `inventory → freeze → drain → stage → verify → activate`, generation 2 in both databases, the editor's original ceiling after shadow import, and no advancement with a wrong bearer or stale control. Hono dispatches the actual route in process; no public network, disposable enrolled VPS, live provider, or customer home was used. The remaining S18 acceptance gate is a real-host cutover journal and rollback drill after the coordinated branches are stacked. Legacy proxy/WS paths remain in place.
