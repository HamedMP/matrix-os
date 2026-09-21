# S09 receipt — shared Codex and Claude execution (T045–T049)

**Packet:** S09. **Date:** 2026-09-21. **Base:** `124/s07-terminal` at `eb6a4b4c7`. **Head before this receipt:** `cedf4bba2` on `124/s09`. **Status:** T045–T048 implemented and locally verified; T049 live provider probes unrun pending approved credentials and costs.

## Layer and ownership

One Graphite layer, 23 files and +1,463/−69 before this receipt, under the 3,000-addition / 50-file limit. Commits: `b989b52b4` failing T045 suite; `c4fd0f594` run loss and actor controls; `6307f9c51` scoped Codex/Claude dispatch; `880e3a592` failing-first inherited Chat, grant, and submit-policy tests; `cedf4bba2` authority, policy and retry fix. The scope is `packages/gateway/src/chat/{collaboration-commands,queue-repository,repository,orchestrator,shared-execution-coordinator}.ts`, `packages/gateway/src/collaboration/{authority,chat-execution-adapter,shared-ai-runtime,shared-chat-authority,shared-{codex,claude}-adapter,shared-run-loss,run-account-binding,scope-runtime-chat-adapter,wiring,database,database-migrations}.ts`, the execution contracts, and focused gateway tests. S10 owns `chat/execution-root.ts`; S09 did not edit it. S12 owns standalone Chat read/discussion and terminal routes; S09 owns the existing `/chat/requests*` and `/chat/approvals*` routes.

## RED → GREEN

| Behavior | RED observed | GREEN observed |
| --- | --- | --- |
| T045–T047 canonical queue, Codex/Claude adapters and home loss | `b989b52b4` committed the failing suite before implementation; baseline details are in that commit. After the inherited GREEN handoff commit `6307f9c51`, the focused PGlite run showed 19 passed, 1 real-Postgres case skipped. | `tests/gateway/shared-coding-execution.test.ts`: 23 passed, 1 skipped on PGlite; 24 passed, 0 skipped on real Postgres, including concurrent claim. |
| T048 project-inherited Chat controls and S04 grant-only standalone Chat | Both new cases failed with `TypeError: repository.setSharedAuthorizer is not a function` before the authority seam. | Both cases passed on PGlite and, after the final grant recheck, 2/2 passed on real Postgres. The standalone case proves a revoked grant is rejected even when `auth_epoch` has not advanced. |
| T048 effective owner-only submit policy | Member request resolved to an accepted queued turn instead of rejecting before queue insertion. | Owner-only member submission rejects with `forbidden`; the canonical queue stays empty. Policy resolution uses the S08 execution scope, including standalone Chat. |
| T048 retry on real Postgres | 23 passed, 1 failed: `invalid input syntax for type json` in the retry INSERT at `collaboration-commands.ts:204`; PGlite had hidden the JSONB binding issue. | Raw JSONB values are normalized with `jsonb(parseJson(...))`; the focused real-Postgres retry passed, then the full suite passed 24/24. |

Additional regression checks: `collaboration-routes.test.ts`, `collaboration-chat-queue.test.ts`, `collaboration-chat-controls.test.ts` together passed 58 with 6 existing gated skips; `shared-ai-runtime.test.ts` and `collaboration-wiring.test.ts` passed 28/28. Full `bun run typecheck` exited 0. `bun run check:patterns` reported 0 violations and 5 existing warnings outside this diff. No React files changed, so `react-doctor` was not applicable. The full unit matrix is a CI gate when this layer reaches `main`; it was not run locally.

## Runtime and release evidence

- **Database:** the dedicated `matrixos_test_124` PostgreSQL test database ran migration registration through version 11 and the real claim race. The schema change is additive (`collaboration_run_interruptions`, `collaboration_run_decisions`). PGlite ran the same suite without the race case. No down migration or destructive rollback was exercised; S18 owns the coordinated cutover and rollback journal.
- **Authorization:** the home authority checks current Clerk organization evidence and preset/legacy membership before admission. The queue and control transaction locks the Chat scope and inherited project scope, then rechecks their epochs and current member/grant state. A temporarily unavailable membership projection preserves queued work; a confirmed departed actor becomes unauthorized. Requester/owner cancel and approval decisions, requester-only retry, and the deciding actor are recorded in owner Postgres.
- **Host/provider:** mocked scope-runtime clients prove both pinned adapters pass the project root in the S07 sandbox manifest and reject an unsandboxed execution root, resume state and non-text parts where unsupported. Runtime crash, run-unit exit, control partition and gateway restart classify and attribute interrupted runs. These are local contract tests, not live Codex or Claude API evidence.
- **Surfaces:** backend contracts and routes were verified. Web Canvas, Web Desktop and Electron Desktop presentation parity belongs to S15 and S19. Native Mobile and CLI are V1 limitations per the spec.
- **Unrun modes:** T049 live Codex/Claude API-backed runs, native subscription/delegated funding modes, approved two-computer host probe, and real VPS sandbox escape probes remain unrun without owner-approved fixtures. No provider capability is claimed from those absent probes.

## Invariants

- **Source of truth:** owner-controlled Postgres holds canonical Chat queue/runs, execution policy, grants, run bindings, interruptions and decisions. Clerk membership evidence is read through the current home authority. No owner-private provider state is copied into a shared session.
- **Lock/transaction scope:** enqueue, claim, retry, cancel and approval mutate canonical Chat and collaboration records inside one transaction. External membership preflight occurs before the transaction; its decision is fenced by scope locks, epochs, and a current member/grant recheck. Provider calls happen after the DB reservation, outside its lock.
- **Acceptable orphan states:** unavailable membership evidence leaves queued work preserved for later re-admission. Confirmed lost runs become interrupted with first reason retained. Failed provider dispatch does not grant wider access or replay a decision. No temporary file is introduced.
- **Auth source of truth:** the home `CollaborationAuthority` is authoritative for project-inherited and standalone Chat scopes. Run control additionally checks the requester/owner relation on the canonical request under lock. Effective AI submit mode follows the S08 policy, with missing policy owner-only for members.
- **Deferred scope:** live provider-mode claims await T049; S10 owns Git and share-time Chat-root inventory; S12 owns standalone read/discussion/terminal adapters; S15 owns three-surface UI; S18 owns release cutover. Reattachment to a surviving run unit is deferred by the spec.

## Gates

- T049 remains open until the owner approves test credentials and cost. A failed required live mode blocks release acceptance in S19; this receipt does not mark it passed.
- S04's `acceptGrant`, `declineGrant`, and `endActorGrants` paths do not currently advance `auth_epoch` when changing grant/activation rows. S09's transaction-local recheck closes the queue/control race, but S04 should correct its broader epoch and stream-invalidation behavior in its review-fix layer.

## S07 sandbox integration — 2026-09-21

Base for this local follow-up: `124/s09` @ `f90627de4`. RED test commit: `5209f7abf`. GREEN fix commit: `bcdddcfb8`.

- The S07 scope-runtime client now rejects `chat_ai` creation without a sandbox manifest. S09 builds one from the claimed Run's canonical project/worktree reference through `ChatExecutionRootResolver`, checks its stored fingerprint, and mounts only a resolved child of the owner's `projects` or `worktrees` root. Actor, scope handle, host path and root fingerprint are supplied to runtime creation. A second adapter check refuses absent or mismatched provider execution roots before creating a runtime.
- A shared Chat with no canonical execution root, stale provenance, unsupported sandbox capability, or a root outside the managed project/worktree trees is marked unavailable before external execution. There is no fallback to the owner's home directory. A standalone Chat needing AI execution therefore requires an approved managed project/worktree root; this remains a release acceptance consideration.
- RED: three focused cases failed before the fix: the manifest builder was absent and an unrooted shared Chat reached runtime creation. GREEN: `shared-coding-execution.test.ts` and `shared-ai-runtime.test.ts` passed 44 tests locally with one real-Postgres-only skip; `shared-coding-execution.test.ts` passed 25/25 on real Postgres including the concurrent claim race. `bun run typecheck` passed and `bun run check:patterns` found 0 violations (5 existing warnings).
- This follow-up changes no database schema or migration. T049 live Codex/Claude probes and host sandbox probes remain unrun; no live provider or systemd result is claimed.
