# Sol agent execution handoff

This is an implementation handoff, not a dispatch performed by the planning session. Read [plan.md](plan.md) and [tasks.md](tasks.md) first. Each packet has exact task IDs below. Use `gpt-5.6-sol`, high reasoning. Keep one coordinator and at most three concurrent workers. Never spawn new user-visible Codex tasks unless the user requests them.

## Assignment ledger

| Assignment | Task IDs | Owned responsibility |
| --- | --- | --- |
| S00 | T001–T005 | Baseline/provider boundary probes; contracts gate |
| S01 | T006–T010 | Platform mechanical extractions, in multiple small layers |
| S02 | T011–T013 | Gateway mechanical extractions |
| S03 | T014–T017 | Shared contracts and all package exports/imports |
| S04 | T018–T022 | Clerk projection/evidence/reconciliation |
| S05 | T023–T027 | Org/group/guest management |
| S06 | T028–T032 | Owner grant model/evaluator/migration |
| S07 | T033–T038 | Platform/gateway proofs and all revocation paths |
| S08 | T039–T042 | Discovery/admin inventory/denial fences |
| S09 | T043–T047 | Existing-session common Share UI |
| S10 | T048–T051 | File catalog and reads |
| S11 | T052–T055 | File writes/moves/fences |
| S12 | T056–T061 | App instances and real project adapters |
| S13 | T062–T067 | Service-only Matrix-backed text groups |
| S14 | T068–T071 | Sync grant migration |
| S15 | T072–T075 | Shared sync gateway |
| S16 | T076–T079 | Sync daemon/file CLI |
| S17 | T080–T083 | Typed runtime owner/routing |
| S18 | T084–T087 | Org provision/backup/recovery |
| S19 | T088–T092 | Org Stripe payer/account/entitlement |
| S20 | T093–T096 | Explicit resource ownership transfer |
| S21 | T097–T101 | Sponsored AI/credit ledger |
| S22 | T102–T107 | Admin/resource/billing/group Web/Electron surfaces |
| S23 | T108–T114 | Native Mobile and CLI parity |
| S24 | T115–T121 | Full integration/rollout evidence/site docs |

## Copyable assignment prompt

> Implement packet **Sxx**, tasks **Tnnn–Tmmm**, from `specs/124-organization-collaboration/tasks.md` using model `gpt-5.6-sol` with high reasoning. First read the constitution, this feature's spec/plan/research/data model/API contract and applicable directory instructions. Verify the exact prerequisite SHAs in your manual worktree before editing. Own only the packet's files/responsibility. You are not alone in the codebase: do not revert others' edits; accommodate compatible changes and report an ownership conflict before editing the same shared module. Write and run failing behavioral tests first, then implement. Use real Postgres for transaction/race/migration checks; a skipped DB test is not a pass. Do not invent prices, weaken membership freshness, expose direct Matrix room access, enable a capability whose gate failed, or implement later packets. Keep each PR within the repository size limits; split mechanical extraction from behavior. Give the coordinator registration/export patches rather than racing shared composition files. Return changed paths, red/green commands/results, prerequisite/head SHAs, migration/rollback evidence, risks and still-open task IDs. Do not merge, deploy or purchase/provision paid infrastructure without task authorization. Do not publish this currently local plan/branch without explicit publication authorization.

Replace the two bold placeholders with one ledger row. This template deliberately gives a bounded packet, not the whole feature. Reuse an existing idle Sol worker for another packet when its ownership and dependencies are clear.

## Coordinator responsibilities

1. Re-fetch main, compare source seams with the recorded baseline, and amend only tasks invalidated by new code. Do not rerun already-proven work merely because a checkbox was stale in another spec.
2. Create persistent manual worktrees from reviewed prerequisites with `codex/` branches. Use Graphite for stack creation/restacking/submission, as specified by `docs/dev/stacked-prs.md`; resolve missing authentication before stack operations.
3. Own `packages/contracts/src/index.ts`, package manifests/lockfile, `packages/platform/src/main.ts`, `platform-startup.ts`, gateway server/bootstrap registration and feature flags. Workers supply focused patches; the coordinator applies and validates these sequentially. Never use `globalThis` to avoid a wiring conflict.
4. Do not concurrently dispatch overlapping write sets. In particular S04/S05/S08/S17 share platform org seams; S10/S11/S12/S14/S20 share resource catalog and transition seams; S19/S21 share billing contracts. Parallel work is allowed only after prerequisite contracts are frozen and these files have an assigned owner.
5. At every join, inspect the actual diff, run the join's wiring/regression tests and verify prerequisites exist in the resulting branch. Graphite branches have one parent; integrate the reviewed prerequisites explicitly.
6. Record each task as complete only with its evidence. Provider price/consistency gates and unsupported direct Matrix clients remain visible; foundation schema merged behind flags does not equal a shipped product.
7. Before review: mechanical, trust-boundary and atomicity passes, required CI, current-head Greptile 5/5, then add `ready-for-ci`. Keep PR invariants and exact deferred scope current. Preserve unfinished worktrees; remove a completed one only after merged-head/clean/no-active-process verification.

## Completion receipt

For each packet add one entry to `implementation-log.md` with: assignment/task IDs; base/head SHAs; owned/changed files; observed RED tests; GREEN commands and outcomes; real Postgres and surface evidence; contract/migration changes; unavailable capabilities; next dependent packet; review/PR references where authorized. Include dependency signature checks, outbox/shutdown behavior and any skipped tests. No credentials, user identifiers or private incident data in public evidence.

## Stop conditions that are local to a capability

- Missing Clerk credentials/Synapse sandbox/real Postgres: implement and test unaffected local code, record the unrun live gate; never mark it passed.
- Clerk consistency probe cannot establish the external-removal bound: org-enabled rollout stays off pending a reviewed mechanism/product-bound decision. Do not compensate with a longer positive cache.
- Missing approved org prices/quotas: sandbox billing tests can finish; production checkout/spend stays unavailable. Do not invent a commercial plan.
- Service-only Matrix room cannot exclude direct tokens: managed group communication stays off; resource sharing need not wait for direct Matrix-client support.
- Org runtime has no authoritative entitlement resolver before S19: provision route returns unavailable; no synthetic personal subscription or free paid-machine allocation.
