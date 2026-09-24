# S18 / T095 focused cutover authorization audit

**Date:** 2026-09-21. **Base:** corrected S18 probe `3163f8892`. **Branch:** `124/s18-t095-rollback-recovery`. **RED test commit:** `c6bd07a52`. **Test addendum:** `2debbcbac`. **GREEN fix commit:** `7b9c335c5`. Local layer only; no push, PR, merge or deployment.

## Material finding and fix

An active direct cutover could enter a permanent platform block after a transient failure of compatible rollback. `packages/platform/src/collaboration/cutover.ts` recorded `resume_phase='verified'` when the owner home was offline, returned a mismatched generation, or lost its rollback response. The old `resume()` retried `activateDirectory()`, which CASes directory generation from source to target. The directory was already at target, so retry could not succeed; `cutoverTicketAdmission()` remained false. This was an availability and recoverability release blocker, without a demonstrated privilege escalation.

Recovery now recognizes only the four compatible-rollback failure reasons with a directory already at the exact target generation. It rechecks the installed compatible-direct build, resolves the exact enrolled home, retries the idempotent home rollback command, verifies target generation, and atomically restores `active` plus `rollback_mode='compatible_direct'` only while the same blocked reason and target directory binding still hold. Missing proof, absent home, wrong generation or a concurrent disable leaves the journal blocked. It never repeats pre-activation import or source→target directory CAS. No schema change or legacy ACL restoration was needed.

## Focused audit evidence

| Boundary | File and observed enforcement |
| --- | --- |
| Cutover operator ingress | `packages/gateway/src/collaboration/cutover-route.ts:57-111` validates bounded signed command, exact method/path/scope/phase/owner/runtime, fresh control keys, 30-second lifetime and nonce; `packages/gateway/src/server.ts:1275` places it beneath gateway bearer middleware. `packages/platform/src/collaboration/cutover-home-transport.ts:83-121` sends the matching signed command with bounded response, timeout and no redirects. |
| Rollback proof | `packages/platform/src/collaboration/compatible-build.ts:61-95` binds a fresh authenticated system-info read to the enrolled machine and published release metadata; `cutover.ts:140-159,318-353` requires it again for recovery and preserves target generation. This audit used local fixtures only; no installed-host proof was run. |
| Legacy-role disposition and journal race | `packages/gateway/src/collaboration/cutover.ts:364-411` imports exact shadow ceilings, retires accepted legacy roles and advances scope generation in one transaction; `packages/gateway/src/collaboration/authority.ts:90-103` denies retired legacy roles as a secondary allow path. `packages/platform/src/collaboration/repository.ts:74-96` fences directory events against an open journal. `cutover.ts:376-399` CASes directory generation and journal activation together. |
| Direct session and relay | `packages/gateway/src/collaboration/direct-sessions.ts:100-112,337-371` verifies the signed ticket and owner scope/generation before admission; `packages/platform/src/collaboration/relay.ts:143-212` forwards opaque HTTP bytes, records metadata fields only, and does not call an authorization evaluator. The separate T092 receipt covers local two-home negative tests. |

## RED → GREEN

| Gate | Observed result |
| --- | --- |
| RED `set -a; source /tmp/matrix-os-124-postgres.env; set +a; pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2 -t 'reconciles an active compatible rollback'` | 1 failed on real Postgres: `resumePhase` was `verified` instead of the test's expected recoverable state; the old implementation would then retry an impossible directory CAS. |
| Intermediate schema check | A proposed new `resume_phase='active'` failed the real Postgres `collaboration_cutover_journal_resume_phase_check`. The final fix uses the existing `verified` state and an exact target-generation/reason guard. |
| Focused GREEN, same `-t` command | 1/1 passed on real Postgres, 2.06 s total. |
| Full focused GREEN, same command without `-t` | 17/17 passed on real Postgres, 7.32 s total. This includes offline→resume and lost-acknowledgement→fresh-proof→idempotent retry. |
| Static gates | `pnpm --filter @matrix-os/platform exec tsc --noEmit -p tsconfig.typecheck.json`: exit 0. `/home/nima/.bun/bin/bun run check:patterns`: 0 violations, 5 existing warnings. `git diff --check`: exit 0. |

**Remaining gates:** This is a focused T095 review of cutover/direct/relay boundaries, not the full T095 auth, sandbox, Git, execution and UI parity audit. Live installed-host rollback proof, actual cutover/restore and final combined ancestry checks remain unrun here. The T090 CLI direct replacement and legacy-route retirement are separate release gates.
