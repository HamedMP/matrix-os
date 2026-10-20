---
name: matrix-ship
description: Qualify, preview, diagnose CI, and ship Matrix OS pull requests using exact-source evidence and the existing Matrix development infrastructure. Use for Matrix engineering PR workflows, rather than deploying customer apps or operating the CI control plane.
license: MIT
metadata:
  author: Matrix OS
  short-description: Preview, qualify, and ship a Matrix OS PR
---

# Matrix shipping

Give engineers one entry point to the existing shipping workflow. Examples:

```text
Use $matrix-ship to check PR 2784 and tell me what blocks merging.
Use $matrix-ship to request a preview of my PR and suggest what to test.
Use $matrix-ship to diagnose the red Dedicated CI check on Main.
Use $matrix-ship to ship this PR once its required gates pass.
```

Follow the request through verification. Carry forward authorizations already
given in this conversation; do not ask again for routine authorized steps.
Checking status does not authorize adding deployment labels or merging. A request
to create a preview authorizes its normal documented workflow; a request to ship
authorizes a normal gated merge. Admin bypass, controller activation, routing
policy changes and production promotion need their own applicable authorization.
Never inherit another engineer's or another PR's bypass approval.

## Establish the source

Resolve the repository, PR or native stack, its owning manual worktree, current
head and target branch, and the relevant ENG ticket. Read the checkout's
`AGENTS.md` and constitution before implementation or merge. Use official
`gh stack` operations for dependencies. Preserve other engineers' worktrees.

Prefer Matrix/Fast CI for dependency installation, builds and full test workloads;
resolve the engineer's chosen computer/profile and verify hostname, working
directory and Git head there first. Keep local code editing slim. Never infer
that a command ran remotely just because a Matrix profile exists. For transport
and development setup, consult the checkout's `docs/dev/onboarding.md` and
`skills/matrix/dev-vps/SKILL.md` as needed. Use the existing isolated test launcher
and admission/resource limits; preserve gateway capacity and Main priority.

## Choose the requested operation

**Check or qualify.** Read [qualification.md](references/qualification.md).
Find the genuine current-head CI attempt and inspect its actual jobs, reviews
and unresolved threads. Report the qualified source and the remaining gate.
Keep full checks; run meaningful affected regressions locally on Matrix for
fixes, then preserve full PR qualification. Request Greptile once for each new
head when necessary, following the repository's review/carry-over rules. Mark a
draft ready only after its required review score is current. Do not label an
entire stack `fast-ci`: the shared Linux host has bounded admission.

**Request or inspect a preview.** Read the current checkout's
`docs/dev/preview-environments.md` and actual preview workflows before selecting
a label. Detect whether the unified `preview` workflow exists on deployed Main
and is enabled. Its presence on an unmerged branch is not activation. If it is
unavailable, explain the supported bundle/private-preview path; do not silently
substitute a different provisioning mode or claim that downloads exist.

For a requested available preview, use its existing label/CLI workflow and
follow the owned status comment. Bind the requested head, built version,
deployment and desktop artifacts to the same exact commit. Report web URL,
matching download URLs and platforms, state, expiry and queue position only
when the actual evidence supplies them. A label is a request, not deployment
success; a confirmed version is not necessarily installed. Verify the actual
running version. A new PR head invalidates older preview evidence.

Recommend affected surfaces from the actual diff and behavior: Web Desktop,
Web Canvas, Electron, platform, Web/Native Mobile and CLI as applicable. Give a
short test plan with concrete scenarios and expected outcomes. Distinguish
recommendations from executed checks and real captures. A web preview does not
qualify mobile or platform isolation. Apply the repository's surface evidence
gate; do not invent videos, successful flows or unavailable builds.

**Diagnose red CI.** Read [qualification.md](references/qualification.md).
Separate test failures, admission/transport/cleanup failures, source freshness,
and routing/attribution failures using the actual log and receipt. Make a focused
fix with a failing regression when code changes, preserve checks and failure
history, and verify recovery on the actual source. Retry a known transient
failure only after checking its cause and current ownership; after a repeated
same failure, diagnose rather than repeatedly rerunning or dispatching. Never
overwrite a check with synthetic success, relax assertions/deadlines, or modify
root leases/controller pins as a shortcut. Operator work follows the existing
host-first procedure in `docs/dev/fast-ci.md` and needs operator authorization.

**Ship.** Recheck the ticket, frozen head, complete real CI, current Greptile
score/carry-over, unresolved findings, peer approval and conflicts immediately
before merge. Merge a standalone PR with `--match-head-commit`; merge stacks
through the native stack tool. Never add `--admin` by default. After merge,
record the actual commit and verify its own Main CI and same-SHA release gate.
PR CI does not cover later Main changes. If a pinned helper changed, distinguish
merged from activated and follow its reviewed activation plan separately.
Verify that the preview's normal merge/close cleanup releases its resource;
report uncertain cleanup instead of deleting unrelated resources. Remove only
completed, clean, idle worktrees owned by this task when cleanup is requested.

## Engineer handoff

Return the PR and exact source, real qualification/review state, test plan or
executed evidence, preview/download links with their provenance, and one clear
next action or blocker. Update the existing ENG ticket and PR with material
results when authorized. Keep routine updates short. Do not report a speedup,
live rollout, slot capacity or merge readiness that the observed evidence does
not establish.
