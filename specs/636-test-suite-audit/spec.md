# Test suite effectiveness audit

Tracking: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit)

## Goal and scope

Identify tests that cannot detect product faults, missing complete user journeys,
and regression lessons from the newest 1,000 PRs. Preserve useful unit,
integration, contract, security, and static-invariant tests. Keep TDD and the
constitution's coverage requirements; coverage is not proof of effectiveness.

Source baseline: `be6cce1404bfd6db3392c535bca2e0def32ec577` (2026-10-25).
PR cohort: latest 1,000 by creation time, all states; separate merged fixes from
open proposals and closed work. Never assume a merged PR was deployed.

## Deliverables and execution

1. Reproducible census across all test names, languages, runner configurations,
   conditional execution, and historical runtime profiles. Every file has a row;
   automated screening does not count as a human/source or fault review.
2. Independent backend, surface, infrastructure, and PR-history reviews with
   explicit evidence depth, uncertainty, and outstanding work.
3. Journey matrix covering actor, trigger, observable outcome, persistence,
   failure/recovery, authority, affected surfaces, and actual test boundaries.
4. Delete only tests proven to test local replicas/mocks/literals or redundant
   assertions with equivalent retained protection. Record each removal and gaps.
5. One canonical testing-effectiveness guide, linked from AGENTS, constitution,
   quality gates, and the execution skill. Require real producer/consumer
   compatibility, regression red/green proof, meaningful assertions and CI cost.
6. Prioritized E2E scenarios and implementation ownership. Existing terminal
   paste fix #2936 / ENG-392 must be reused, not duplicated. New harness tests
   must prove the boundary that failed and run in an explicitly qualified lane.
7. Public developer documentation: deliver a separate `FinnaAI/matrix-os-site`
   documentation PR for developer testing guidance after internal policy review.
   Keep internal operator findings and raw audit evidence out of that public
   guide. This dependent deliverable remains open until that review completes.

## Acceptance checks

- Census has no silently omitted tracked test entrypoints; unknown runner
  ownership is visible, and actual collection/execution is reported separately.
- All 1,000 PRs have a metadata row and evidence depth. Detailed historical
  claims name an inspected patch/source; metadata classification is labelled.
- Every critical journey has observable acceptance criteria and a current
  coverage assessment. Missing runtime/device/provider access remains a gap.
- Deletions name the actual removed tests and explain why production faults
  could not affect them. No file is deleted from a heuristic score alone.
- Changed tests, audit tooling, and retained counterpart tests are validated.
  Unrun/full-suite failures and lack of live E2E qualification are explicit.
- Audit coverage and source/fault review coverage remain separate totals.

## Boundaries and risks

Read-only tooling must not execute repository test code, leak secrets, contact
customers, or run destructive cloud smoke tests. No new runtime persistence,
endpoint, or user interface is introduced. Large raw ledgers remain external
artifacts; small public-safe summaries and reproducible tools live in Git.

Request product/domain owner review of the journey matrix and engineering
review of deletion evidence. This recommendation adds no approval gate beyond
the existing PR workflow. No claim that all possible journeys are discoverable
from historical tests/PRs, or that static screening proves test effectiveness.
