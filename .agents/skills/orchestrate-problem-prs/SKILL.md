---
name: orchestrate-problem-prs
description: Decompose a structured or unstructured problem report into independently scoped workstreams, assign one subagent per accepted problem for read-only root-cause analysis, gate isolated draft PR implementation on evidence and a written plan, and shepherd every PR through worktree-pr-monitor. Use when a requester asks Codex to investigate and fix multiple reported problems in coordinated separate PRs without merging them.
---

# Orchestrate Problem PRs

Coordinate an evidence-first, multi-PR workflow. Determine the number of
workstreams from the report; never encode or assume a fixed worker count.

Read [references/worker-contracts.md](references/worker-contracts.md) before
assigning workers. Use its contracts verbatim enough that every worker returns
comparable evidence and PR comments.

## Preconditions

- Re-read the repository instructions and constitution.
- Confirm the requester authorized a multi-agent, manual-worktree PR workflow.
- Confirm the repository, base branch, source change or incident context, and
  completion gate.
- Fetch the remote base once and record its exact commit SHA. Use that pinned
  SHA for every initial investigation and worktree unless the requester says
  otherwise.
- Inspect the primary checkout and preserve unrelated work. Never implement in
  the primary checkout.
- Confirm GitHub CLI authentication, the `ready-for-ci` label, and available
  agent capacity before starting mutations.

## Coordinator Invariants

- Keep one coordinator active until every workstream is complete or blocked.
- Let `N` equal the number of independently scoped problems supported by the
  supplied report. Spawn one distinct problem owner for each accepted problem.
- Determine capacity before every batch. Read the platform's declared
  concurrency limit and use its agent-status/list operation to count every
  active agent, including the coordinator. Compute available platform slots as
  `total slots - active agents`. If the requester supplied a lower maximum
  worker concurrency, compute its remaining allowance as `worker cap - active
  problem workers`; otherwise use the queued-problem count as that allowance.
  Spawn at most the smallest of the available slots, remaining allowance, and
  queued problems, then recompute after workers finish. If the platform exposes
  no limit, ask the requester instead of guessing.
- Queue remaining workers without reusing an owner for a different problem.
- Do not use Agent-tool worktree isolation. Use persistent manual Git
  worktrees only.
- Give each worker exactly one problem, the raw relevant evidence, the pinned
  base SHA, and repository instructions. Do not leak another worker's proposed
  root cause or intended fix into the investigation prompt.
- Keep investigation read-only. No edits, branches, worktrees, commits, pushes,
  PRs, labels, or comments are permitted during that phase.
- Do not merge. The terminal state is a set of review-ready PRs for the
  requester.

## Phase 1: Decompose the Report

1. Read the entire report before assigning work.
2. Extract candidate problems from headings, symptoms, reproduction details,
   logs, screenshots, and narrative context.
3. Separate independently diagnosable failures from multiple symptoms of one
   failure. Record dependencies and suspected overlap without treating those
   suspicions as conclusions.
4. Give each accepted problem a stable ID, concise title, observed behavior,
   expected behavior, evidence pointers, and explicit exclusions.
5. Ask the requester only when ambiguous boundaries would materially change
   the number or ownership of PRs. Otherwise proceed with the best supported
   decomposition.

## Phase 2: Investigate Read-Only

Spawn problem owners in capacity-bounded batches using the investigation
contract. A worker must return:

- reproduction or a deterministic execution-path trace;
- exact relevant files, symbols, and line references;
- the first incorrect state transition, assumption, or boundary violation;
- how the source change introduced or exposed the behavior;
- alternatives considered and evidence that rules them out;
- affected scope, remaining unknowns, and a confidence rating; and
- a focused regression-test design that fails before the fix.

Reject symptom restatements as root causes. If confidence is not supported by
evidence, keep that workstream read-only and report it as blocked.

## Phase 3: Reconcile PR Boundaries

Compare completed dossiers before allowing any mutation.

- Preserve one PR per independent root cause by default.
- If multiple reports resolve to the same root cause, or fixes substantially
  overlap, pause and propose a consolidated ownership boundary to the
  requester.
- If fixes depend on one another, record their order. Use stacked PRs only when
  repository instructions require them and the required stack tooling is
  available.
- Reserve unique semantic branch names, worktree paths, and PR titles.
- Create or register manual worktrees sequentially to avoid contention in
  shared Git metadata, then hand each exact path to its owner.

## Phase 4: Bootstrap Draft PRs

Authorize only the bootstrap phase for each accepted dossier.

1. Add the focused failing regression test first and demonstrate the expected
   failure. Do not change production code yet.
2. Commit the test as a scoped Conventional Commit and push the assigned
   branch.
3. Open a draft PR with the repository-required body sections.
4. Post two separate comments using the reference templates:
   `Root-cause analysis` followed by `Resolution plan`.
5. Return the PR URL, commit SHA, failing-test command and output summary, and
   comment URLs to the coordinator.

If a meaningful regression test cannot bootstrap the PR, stop and obtain the
coordinator's explicit approval for another in-scope approach. Never add junk
files solely to manufacture a diff.

## Phase 5: Unlock Implementation

Verify the draft PR, failing test, root-cause comment, and plan comment. Check
the plan against repository security, concurrency, resource-management,
failure-mode, frontend, and documentation requirements.

Only then send a new, explicit implementation task to the same problem owner.
The worker must follow Red -> Green -> Refactor, commit working increments, and
remain within its assigned worktree and PR.

## Phase 6: Validate and Monitor

Require focused tests and all applicable repository gates. React changes also
require React Doctor and current screenshot evidence. Record every skipped gate
with its exact reason.

After implementation and local validation, tell the owner to mark its draft PR
ready for review and verify that it is no longer a draft. The same problem
owner is personally responsible for invoking and completing
`$worktree-pr-monitor` for its single assigned PR. The owner must:

1. resolve current-head review feedback until Greptile reports `5/5`;
2. add `ready-for-ci` only at the point required by that skill;
3. wait for the label-triggered current-head CI to pass; and
4. return the PR URL, worktree, branch, SHA, checks, Greptile rating, and risks.

Do not accept stale reviews or checks from an earlier commit.

## Final Handoff

Return one aggregate table containing problem ID, owner, root cause, PR URL,
branch, current SHA, CI result, Greptile rating, dependency order, and residual
risk. Present PRs for requester review only when every non-blocked workstream is
ready. List blocked workstreams separately with the exact evidence or authority
needed to continue.
