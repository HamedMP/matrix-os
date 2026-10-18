# CI check attribution

[ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks) · [PR #2702](https://github.com/HamedMP/matrix-os/pull/2702)

PR refresh and preview failures must belong to their execution commit. Main must retain genuine complete coverage and truthful failures for its own source.

## Design

- Execute auxiliary work on `ci-execution/<controller-sha>`: a protected, distinct commit with the reviewed Main controller as sole parent and exactly its tree.
- Authenticate actual ref, SHA, workflow definition, repository, requester and attempt before privileged helpers or credentials. Keep host lease requests unchanged; bind actual execution origin in a versioned receipt envelope.
- Main bridges route only. Routing and metadata success cannot qualify candidate coverage. Skip genuine fork execution requests without weakening base-workflow authentication.
- Await asynchronous history authentication; newer requesting attempts supersede older coverage. Preserve historical receipt schemas and current-source revalidation.
- Keep Main push CI and qualification on Main. Repair action-contract assertions and the bounded preview startup race without hiding real errors.

## Validation and rollout

1. Preserve failing regression evidence, then pass full remote CI and current-head Greptile 5/5.
2. Merge and qualify the actual Main commit through complete hosted or immutable Linux evidence.
3. Protect the exact execution ref and environment access; pause auxiliary admissions and drain proven legacy writers, preserving actual workloads.
4. Append only the reviewed host controller, advance the pin, enable isolation last, and resume admission. Preserve Main protections, runner image and harness.
5. Verify real isolated refresh/qualification/preview outcomes and the complete Main check/status rollup. Never fabricate passes or delete diagnostic history.

Internal CI infrastructure has no product UI surface. Operator documentation: [fast CI](../../docs/dev/fast-ci.md#isolating-auxiliary-checks-from-main). Public product docs remain unchanged.

## Explicit CI handoff follow-up

[PR #2707](https://github.com/HamedMP/matrix-os/pull/2707) makes isolated CI
explicitly enqueue qualification on every protected backend attempt and terminal
reconciliation, with the actual
requester authenticated before dispatch or App credentials. A separate late
handoff job avoids waiting for CI inside its qualification controller; failed
handoffs and stale-attempt completion fail the aggregate. Failed-only retries
that retain a successful backend require a newly verified immutable qualification
receipt; proved infrastructure unavailability cannot replace that coverage.
Completion polling has one absolute three-minute
deadline across nested API reads. Controller history retains a lower time bound
derived from the authenticated requester, including across cursor pages.
Authenticated terminal events provide deduplicated reconciliation if explicit
completion is missing; scheduled recovery handles absent events. Buffered SSH
completion may drain after authenticated renewal without writing to a closed
stream; full receipt, deadline, exit-zero and final source checks remain mandatory.

Acceptance: remote tests first; current-head Greptile 5/5 and full CI; genuine
new Main qualification; protected exact-tree child activation; automatic CI
canary with immutable evidence and complete Main rollup. Existing protection,
old refs, receipts, runner limits and the enabled isolation flag are retained.
Stakeholder review of this internal CI behavior is suggested through the PR;
no separate approval gate or product documentation change is introduced.

The existing CI workflow exceeds the composition-size target. A follow-up should
extract duplicated protected-origin proof and aggregate outcome logic into shared
reviewed helpers, retaining the actual workflow graph tests and permission guards.
This repair keeps the existing job identities and limits that refactor’s scope.
