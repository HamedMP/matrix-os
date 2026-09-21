# Organization collaboration V1 — implementation and acceptance log

**Status:** provisional, 2026-09-21. This is a release ledger, not an approval to deploy or publish. Packet receipts under `evidence/` retain their own RED/GREEN details. S19's local source base is S18 gateway `801883466`; S19 code is `379f2b47b`. The integrated S18 platform cleanup has not yet been rebased under this branch, so current-head release acceptance is open.

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
| Relay and home authorization | S05 in-process two-home E2E, relay tests, S19 byte profile; S18 gateway signed route and fence tests | Two enrolled computers through production relay, payload-safe trace, forged/expired tickets on those hosts **unrun**. |
| One owner AI source and shared coding | S08 and S09 focused receipts; current branch's coverage attempt exposes stale S09 ancestry | Claude/Codex approved API-backed runs and subscription modes **unrun**; current-head S09 retest required. No provider mode is claimed live-supported. |
| Group Chat, explicit join, standalone resource shares | S04 real-Postgres cases plus S06/S09/S12/S15 receipts | Cross-account, cross-host Chat/file/app/terminal journeys **unrun**. |
| Git identity, share inventory and sandbox | S10 local Git/real-Postgres inventory receipt; S07 scope-runtime policy tests | Live forge push/PR under owner identity and root/systemd credential-escape probes **unrun**. |
| Run loss, cancel, approval and queue | S09 focused simulations and home cutover real-Postgres tests | Restart/supervisor/run-unit/control-partition on disposable hosts **unrun**. |
| Cutover and rollback | S18 gateway v14 real-Postgres 9/9 and its receipt | Final platform journal/transport ancestry and operator dry-run with old clients, offline homes, ambiguous handles and real backup **pending**. No legacy fallback may reopen. |
| Web Canvas, Web Desktop, Electron Desktop | S06/S20 captured surfaces and S15 shared UI/build evidence | Authenticated owner/member/outsider S15 parity journeys and final-head builds **unrun**. Native Mobile/CLI new organization controls remain the V1 limitation. |
| Scale and cost | S19 synthetic 40-request byte profile, 100-to-1 control coalescing, relay connection cap unit tests | Concurrent live Chat/PTY/file CPU, memory, network caps, platform egress byte rate and priced bandwidth cost **unrun**. No unit price is configured in this log. |
| Deferred peer, billing, granular, transfer and Matrix-room journeys | No V1 implementation claimed | **Not V1 release gates** per spec. |

## T095 authorization, atomicity and wiring review

- The platform relay uses exact direct route classes and opaque request/response streams; only actor/runtime/resource/method/path/byte/timing/outcome metadata is emitted. The S19 review found the streamed request byte undercount and falsely short length cap bypass and fixed both in `379f2b47b`. Actual production trace and cross-host admission remain unrun.
- Home cutover commands require the normal bearer plus a short-lived signed platform command, exact owner/runtime/scope/phase binding, body cap and bounded replay cache. Home inventory and activation use real-Postgres row locks and generation/fence checks. Platform journal integration and T090 removal must be reviewed on the final linear head.
- S04 tests cover fresh membership, exact grant capability, revocation and atomic operations on real Postgres. S09's current branch mismatch is an open wiring gate until the newer S09 code is in the release ancestry and its full suite is green.
- S07 static sandbox policy hides owner credentials and constrains `/workspace/project`; a root/systemd escape probe remains unrun. S10's broker never passes forge credentials into the sandbox in unit tests; a live owner credential/forge probe remains unrun.
- S15 shared UI components cover readiness and owner-runtime first Share in tests. Equivalent authenticated information, states and actions on Web Canvas, Web Desktop and Electron Desktop require the final interactive parity run. Existing S06/S20 screenshots do not prove S15 parity.

## Cutover and rollback runbook to execute after integration

1. Pin the reviewed full-stack source SHA, direct protocol, key IDs, runtime versions and approved owner/member/outsider fixtures. Capture DB and owner-data backups, their storage reference, retention and restore test. Inventory organization and person-to-person rows separately and disposition any latter explicitly.
2. Check every enrolled home and client supports direct protocol 2. If a home is offline, ambiguous, missing a signing key or has an unresolved Chat root, leave its collaboration unavailable and record recovery work.
3. Inventory exact scope/grant/invitation IDs, prior action ceilings and digest. Fence normal mutations; drain active shared runs with requester-attributed interruption and preserve queued requests. Do not proceed if the home reports any remaining active run.
4. Stage shadow grants idempotently and verify counts, source-ID digest, ceiling digest, current membership and resource bindings against the immutable backup. Keep the fence on any mismatch or interruption.
5. Activate the home direct generation and platform directory CAS only after verified evidence. Run old-client upgrade-required negatives and synthetic relayed Chat/PTY/file/app journeys before reopening collaboration. Remove the legacy proxy/WS authority path; do not retain a dual writer.
6. On failure, reconcile the journal and backup under the fence. Roll back only to a compatible direct-protocol build at the same generation, or disable collaboration. Never restore V1 ACL/proof or platform-side per-request policy fallback.

No operator step above was executed against a customer host in this provisional S19 run. T096 site documentation is drafted locally in `site-docs-draft.md` and awaits a separately authorized `FinnaAI/matrix-os-site/content/docs/` PR. Current-head CI, Greptile 5/5, full coverage, live acceptance and release approval remain open. No deployment, paid provisioning or external publication occurred.
