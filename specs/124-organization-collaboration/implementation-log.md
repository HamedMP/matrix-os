# Organization collaboration V1 — implementation and acceptance log

**Status:** provisional, 2026-09-21. This is a release ledger, not an approval to deploy or publish. Packet receipts under `evidence/` retain their own RED/GREEN details. The tracked S19 branch remains based on S18 gateway `801883466`; its five unique commits through `7f5224082` replayed without conflict in a disposable worktree above corrected integrated probe `d05ef36b8` (replay head `8ffb7d86b`). The tracked branch has not been restacked, and current-head release acceptance remains open.

## Corrected ancestry reconciliation, 2026-09-21

The disposable replay changes seven files, **+352/−12** against `d05ef36b8`. `pnpm exec vitest run tests/platform/collaboration-relay.test.ts tests/platform/collaboration-acceptance-profile.test.ts --maxWorkers=2` passed **13/13** there. This proves Git application and focused local relay behavior; the full final-head matrix is a separate gate. The corrected parent includes the later S09 JSONB retry fix, S18 signed cutover transport and rollback recovery, direct owner-route authorization, local two-home route proof, the browser relay runtime-header correction, existing 525 CLI direct compatibility, and direct-only gateway startup configuration. Each packet receipt records its own environment and limits; none is a deployed two-computer result.

| Newly assembled evidence | Observed local result and remaining gate |
| --- | --- |
| T095 rollback and authority | S18 T095 cutover audit passed **17/17 on real Postgres**, including blocked compatible-direct rollback recovery. **Qualified 2026-09-23:** that run predates two P1 concurrency defects found on #1860 and fixed in `13c4ca234` (`cutover.ts` `resume()` clearing a recovery disable, `block()` reporting a zero-row fence as success). The suite was green while both were present, so it evidences the non-concurrent paths only; recovery under a racing security control is uncovered. See `evidence/S19-acceptance-matrix.md`. Post-cutover authority tests deny revived legacy roles. Installed-home version proof, backup restore, and live rollback remain **unrun**. |
| T092 relay boundary | Two distinct Hono owner apps on isolated real-Postgres schemas passed **1/1**: wrong-home, forged, expired, wrong-generation and V1 direct tickets fail at the owner; relayed payload bytes and metadata are checked. Physical two-computer TLS, host network partitions and production tracing remain **unrun**. |
| Browser and existing CLI continuity | Browser relay/session focused suites passed **21/21** in-process. Existing CLI v2 compatibility passed **16/16** root tests and **9/9** sync-client tests, preserving its 525 Chat/terminal commands. New S17 CLI controls remain deferred; packaged CLI against enrolled homes and interactive Web Canvas/Web Desktop/Electron Desktop parity remain **unrun**. |
| Direct-only gateway startup | Gateway focused suites passed **59/59** on PGlite after removing production V1 proof-key environment dependence. Old environment keys are ignored by the production loader. Installed-home startup with live control keys and full V1 route retirement remain **unrun**. |

T090 platform route retirement and the production shared-terminal bridge are not in the replayed `d05ef36b8` parent. Their replacement and negative tests must be integrated before any claim that direct protocol is the only serving path. The prior S19 coverage failures below occurred on the old branch ancestry; corrected ancestry includes the S09 fix, but **no full kernel/gateway coverage percentage on this replay is claimed**.

## Pinned local inputs

| Input | Value on this S19 branch |
| --- | --- |
| Direct protocol | 2, `packages/contracts/src/collaboration-direct.ts` |
| Scope runtime profile | `scope-runtime-chat-v1` |
| Claude harness | 2.1.240 |
| Codex harness | 0.154.0 |
| Claude Agent SDK | 0.3.240 |
| Database | protected shared real Postgres test service; credentials, address and customer identifiers omitted |
| Provider/Clerk/hosts | No approved live provider, Clerk sandbox, or disposable enrolled two-computer fixture was supplied to this S19 run |

## Executable acceptance on the provisional head

| Gate | Exact command / observation | Result and limit |
| --- | --- | --- |
| Quickstart org gate, contracts, membership, grants, share inventory, home cutover | `source /tmp/matrix-os-124-postgres.env && pnpm exec vitest run tests/gateway/collaboration-org-precondition.test.ts tests/platform/collaboration-org-precondition.test.ts tests/contracts/collaboration-direct.test.ts tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-execution.test.ts tests/platform/organization-authority-postgres.test.ts tests/gateway/collaboration-capabilities-postgres.test.ts tests/gateway/project-share-inventory-postgres.test.ts tests/gateway/collaboration-cutover-postgres.test.ts --maxWorkers=2` | **9 files, 112/112 passed, 103.17 s** on real Postgres. This excludes platform S18 journal because it is not yet in this branch's ancestry. |
| T094 streamed accounting RED | `pnpm exec vitest run tests/platform/collaboration-relay.test.ts -t 'counts streamed request bytes' --maxWorkers=2` before fix | **1 failed, 9 skipped:** metadata reported `requestBytes: 0`, expected 20. A falsely short declared length also bypassed the actual-stream cap. |
| T094 relay and synthetic profile GREEN | `pnpm exec vitest run tests/platform/collaboration-acceptance-profile.test.ts tests/platform/collaboration-relay.test.ts --maxWorkers=2` | **12/12 passed.** Forty concurrent in-process requests: 40 directory lookups, 10 scope-read metadata events / 1,280 response bytes, 89,600 relayed request bytes, 716,800 relayed response bytes. One hundred concurrent identical membership checks produced one platform control request. These are synthetic byte counts, not host throughput or vendor cost. |
| Bounded kernel/gateway coverage attempt | `source /tmp/matrix-os-124-postgres.env && PATH=/home/nima/.bun/bin:$PATH bun run test:coverage -- tests/kernel tests/gateway/collaboration-org-precondition.test.ts tests/gateway/shared-coding-execution.test.ts tests/gateway/collaboration-cutover-postgres.test.ts --maxWorkers=2 --coverage.reporter=text-summary` | **Exit 1:** 628 passed, 2 failed, 8 skipped across 46 files; no usable coverage summary. On this branch's stale S09 ancestry, the S09 migration assertion expects v11 to be the final version despite v12–v14, and retry fails inserting Postgres JSON. The retry test passes **1/1** on clean S09 head `80b4144d9`, whose later `cedf4bba2` commit serializes JSONB correctly. V8 also attempted to parse Markdown and declarations under the original broad globs. These are recorded failures, not skipped passes. |
| Coverage parser smoke after config correction | `pnpm exec vitest run tests/kernel/agent-sdk-upgrade.test.ts tests/platform/collaboration-relay.test.ts --coverage --coverage.reporter=text-summary --maxWorkers=2` | **17/17 tests passed; process exit 1 on configured thresholds.** V8 parsed code without the prior Markdown/declaration errors. Partial-sample coverage: statements 0.31% (307/97,108), branches 0.21% (157/72,522), functions 0.24% (44/18,134), lines 0.33% (283/85,115); global targets remain 99/95/99/99. This sample is not package coverage. |
| Full static checks | `PATH=/home/nima/.bun/bin:$PATH bun run typecheck`; `bun run check:patterns`; `git diff --check` | Typecheck exit 0; patterns 0 violations / five existing warnings; whitespace clean. |

The full kernel and gateway `vitest --coverage` gate must run on the final integrated head. This provisional attempt does not establish the constitution's 99–100% coverage target. The S09 failures require corrected ancestry and a fresh current-head run; an old green packet receipt cannot erase them.

## Quickstart journey matrix

| Journey | Automated evidence available on this branch | Release status |
| --- | --- | --- |
| Organization-only gate and membership | Real-Postgres 112-test matrix above; S03/S04/S20 receipts | Live outsider and Clerk removal/partition timing **unrun**. |
| Relay and home authorization | S05 in-process two-home E2E, S19 byte profile; S18 T092 local two-Hono-owner real-Postgres negative proof | Two enrolled computers through production relay, payload-safe live trace, and forged/expired tickets on those hosts **unrun**. |
| One owner AI source and shared coding | S08 and S09 focused receipts; the corrected replay carries the later S09 JSONB retry fix absent from the old coverage attempt | Claude/Codex approved API-backed runs and subscription modes **unrun**; final-head S09 retest required. No provider mode is claimed live-supported. |
| Group Chat, explicit join, standalone resource shares | S04 real-Postgres cases plus S06/S09/S12/S15 receipts | Cross-account, cross-host Chat/file/app/terminal journeys **unrun**. |
| Git identity, share inventory and sandbox | S10 local Git/real-Postgres inventory receipt; S07 scope-runtime policy tests | Live forge push/PR under owner identity and root/systemd credential-escape probes **unrun**. |
| Run loss, cancel, approval and queue | S09 focused simulations and home cutover real-Postgres tests | Restart/supervisor/run-unit/control-partition on disposable hosts **unrun**. |
| Cutover and rollback | S18 gateway v14 real-Postgres 9/9, signed platform/home integration and T095 rollback recovery 17/17 on real Postgres, **with the 2026-09-23 qualification above: green against code carrying two since-fixed P1 cutover races** | Final combined-head journal/transport rerun and operator dry-run with old clients, offline homes, ambiguous handles and real backup **pending**. No legacy fallback may reopen. |
| Web Canvas, Web Desktop, Electron Desktop | S06/S20 captured surfaces, S15 shared UI/build evidence, and browser relay/session 21/21 in-process | Authenticated owner/member/outsider parity journeys and final-head builds **unrun**. Native Mobile and new CLI organization controls remain the V1 limitation; existing 525 CLI Chat/terminal have local v2 compatibility tests, not live proof. |
| Scale and cost | S19 synthetic 40-request byte profile, 100-to-1 control coalescing, relay connection cap unit tests | Concurrent live Chat/PTY/file CPU, memory, network caps, platform egress byte rate and priced bandwidth cost **unrun**. No unit price is configured in this log. |
| Deferred peer, billing, granular, transfer and Matrix-room journeys | No V1 implementation claimed | **Not V1 release gates** per spec. |

## T095 authorization, atomicity and wiring review

- The platform relay uses exact direct route classes and opaque request/response streams; only actor/runtime/resource/method/path/byte/timing/outcome metadata is emitted. The S19 review found the streamed request byte undercount and falsely short length cap bypass and fixed both in `379f2b47b`. T092's two-Hono-owner test checked exact relayed payload bytes and metadata against real-Postgres fixtures. Actual production trace and physical cross-host admission remain unrun.
- Home cutover commands require the normal bearer plus a short-lived signed platform command, exact owner/runtime/scope/phase binding, body cap and bounded replay cache. Home inventory and activation use real-Postgres row locks and generation/fence checks. The T095 audit fixed compatible-direct rollback recovery on real Postgres. Platform journal integration and T090 removal must be reviewed on the final linear head.
- S04 tests cover fresh membership, exact grant capability, revocation and atomic operations on real Postgres. The tracked S19 branch still has stale S09 ancestry, while the disposable corrected replay includes its later retry fix. A final-head full S09 suite and coverage run remain gates.
- S07 static sandbox policy hides owner credentials and constrains `/workspace/project`; a root/systemd escape probe remains unrun. S10's broker never passes forge credentials into the sandbox in unit tests; a live owner credential/forge probe remains unrun.
- S15 shared UI components cover readiness and owner-runtime first Share in tests. Equivalent authenticated information, states and actions on Web Canvas, Web Desktop and Electron Desktop require the final interactive parity run. Existing S06/S20 screenshots do not prove S15 parity.

## Process finding: `tasks.md` is not a progress record

Recorded 2026-09-24. `specs/124-organization-collaboration/tasks.md` contains **103 unchecked boxes
and zero checked**, measured on `origin/main`, against roughly 44 evidence receipts and ten merged
pull requests. The boxes were written once and never re-derived.

**The receipts are the progress record; `tasks.md` cannot be read as one.**

The failure direction is worth naming because it is the inverse of the one this release has spent
its effort on. A green row that never ran invents progress. 103 unchecked boxes tell a cold reader
the release did nothing, which is exactly as wrong, just inverted. Both are documents that stopped
tracking the thing they describe, and both mislead a reader deciding what is left to do — one into
shipping, the other into redoing finished work. This same error appeared inside this release's own
evidence, where row 24 briefly claimed two production builds had not run when they had.

The general shape is distinct from the boundary-blind class and from the retirement-inventory gap:
**a claim that was true when written and was never re-derived after the thing it describes changed.**
It applies to task checkboxes, to acceptance rows, to PR-body surface matrices, and to any citation
carried forward rather than re-measured. The fix is not to write more carefully but to re-derive at
the point of use: state what was measured, against which tree, and when.

## Process finding: the atomicity rule is written down and is not reaching the code

Recorded 2026-09-23. This is a process finding about how this release was reviewed, not a defect
report. It is stated at full strength deliberately.

**Five instances of pre-read-plus-unpredicated-write were found in this release.** `CLAUDE.md`
already forbids exactly this, by name, under **Atomicity**: "Optimistic concurrency must be enforced
in the write statement. Pre-reading a revision inside a transaction is not enough under READ
COMMITTED; include `WHERE revision = :baseRevision` on the `UPDATE` or take a row lock." The rule is
not ambiguous, is not new, and is in the file every agent on this release reads at session start.

**The two most serious instances were found last, by an automated reviewer, on a rebased head.**
Greptile found both `cutover.ts` defects on #1860 *after* those layers had been through review rounds
and been called clean. They are also the only two where the racing writer was a security control
rather than ordinary data: a recovery disable silently cleared, and a fence reporting success while
matching zero rows. The more dangerous instances were the later-found ones, not the earlier ones, so
this is not a case of review quality improving as the release settled.

**Why the existing gates could not have caught it.** `bun run check:patterns` has eight checks —
bare/empty catch, `fetch()` without `AbortSignal.timeout`, missing `bodyLimit`, unbounded in-memory
structures, sync file I/O in handlers, path operations on external input, external headers and
identifiers, and the legacy request principal resolver. **None of them covers atomicity.** So the
mechanical sweep that `CLAUDE.md` names as review pass 1 cannot see a violation of the rule
`CLAUDE.md` states first under Mandatory Code Patterns. The only enforcement is a reviewer noticing,
and across this release reviewers did not notice five times.

Nor can the test suites close it: an unchecked `.execute()` is invisible to any test that asserts end
state, because the failure mode is the absence of an effect. Catching it needs assertions on
affected-row counts under interleaved writers.

**The gap is enforcement, not documentation.** Restating the rule would change nothing. The
candidates are a scanner check for `.execute()` whose result is discarded on an `updateTable`/
`deleteFrom` chain, and one for an `UPDATE` whose `WHERE` carries no predicate from a value read
earlier in the same function. Both are heuristics and both would be noisy; that is still a different
category of cost from five missed instances, two of them security controls, in one release. Filing
and scoping that check is outside spec 124 and is recorded here so it is not lost with this release.

## Cutover and rollback runbook to execute after integration

1. Pin the reviewed full-stack source SHA, direct protocol, key IDs, runtime versions and approved owner/member/outsider fixtures. Capture DB and owner-data backups, their storage reference, retention and restore test. Inventory organization and person-to-person rows separately and disposition any latter explicitly.
2. Check every enrolled home and client supports direct protocol 2. If a home is offline, ambiguous, missing a signing key or has an unresolved Chat root, leave its collaboration unavailable and record recovery work.
3. Inventory exact scope/grant/invitation IDs, prior action ceilings and digest. Fence normal mutations; drain active shared runs with requester-attributed interruption and preserve queued requests. Do not proceed if the home reports any remaining active run.
4. Stage shadow grants idempotently and verify counts, source-ID digest, ceiling digest, current membership and resource bindings against the immutable backup. Keep the fence on any mismatch or interruption.
5. Activate the home direct generation and platform directory CAS only after verified evidence. Run old-client upgrade-required negatives and synthetic relayed Chat/PTY/file/app journeys before reopening collaboration. Remove the legacy proxy/WS authority path; do not retain a dual writer.
6. On failure, reconcile the journal and backup under the fence. Roll back only to a compatible direct-protocol build at the same generation, or disable collaboration. Never restore V1 ACL/proof or platform-side per-request policy fallback.

No operator step above was executed against a customer host in this provisional S19 run. T096 site documentation is drafted locally in `site-docs-draft.md` and awaits a separately authorized `FinnaAI/matrix-os-site/content/docs/` PR. Current-head CI, Greptile 5/5, full coverage, live acceptance and release approval remain open. No deployment, paid provisioning or external publication occurred.
