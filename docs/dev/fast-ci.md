# fast-ci: priority Linux CI for PRs

`fast-ci` runs a PR's heavy CI lanes on a dedicated Linux host instead of
GitHub-hosted runners. Linux execution benchmarks are promising, but queueing and qualification
failures must be included before claiming an end-to-end speedup. This page is
the engineer workflow; the
design lives in [spec 605](../../specs/605-priority-linux-ci/spec.md) and the
host internals in [`scripts/ci/runner/README.md`](../../scripts/ci/runner/README.md).

## Using it

1. Open the PR as a **draft** (same repository).
2. Add `fast-ci` and `ready-for-ci` while the PR is a draft; adding both together
   is supported. Linux admission still requires both labels; ordinary PRs need none.
3. Mark the PR ready for review. That starts CI, and later pushes rerun it.

A PR opened ready, or marked ready before both labels are on, starts hosted
CI first; that run is not cancelled when the labels arrive. To change routing
after CI starts or finishes, return the PR to draft, set both admission labels,
and mark it ready again. Unrelated labels never start normal PR CI.
Adding both labels together to an already-ready PR can still supersede its
label-triggered controllers; configure them while still a draft.

Only open, non-draft, same-repository PRs with **both** labels run on Linux,
and only when the change runs CI lanes at all: a docs-only change (only
`docs/`, `specs/` or Markdown files) never gets `Dedicated CI Results`. Main CI
runs on hosted runners (`MATRIX_CI_DEDICATED_MAIN=false`), so main never holds
the Linux host.

## One host, one job at a time

The host runs a single qualification at a time, first come first served,
with a 30-minute queue deadline. A job that waits longer fails with
`queue_timeout`.

- **Stacks:** add `fast-ci` only to the one or two layers you are about to
  merge. Labelling a whole stack queues every layer behind each other and most
  of them time out. Hosted runners run many jobs in parallel and are free for
  this public repository, so they are the better choice for stack-wide CI.
- **Push less often.** A push cancels your PR's in-flight Linux run and
  starts over at the back of the queue, losing its place and progress.

## Reading the checks

| Check | What it means | Act on it? |
| --- | --- | --- |
| `CI Results` | The required aggregate. Green on the exact head means CI passed. | **Yes**: the only CI check that gates merging. |
| `Dedicated CI Results` | The Linux suite for this head (unit, typecheck, SDK compatibility, docs, production Web, general and Electron E2E). | Read it when Linux failed. |
| `CI Backend Decision` | Waits for and verifies the Linux result, then tells `CI Results` whether hosted lanes must run. | Read it when `CI Results` failed. |
| `Type Check`, `Unit Tests (${{ matrix.shard }}/4)`, `E2E Tests (${{ matrix.lane }})`, `Shell Production Build`, ... **Skipped** | The hosted copies of lanes that ran on Linux. GitHub only fills in matrix names for jobs that run, so skipped matrix jobs show the raw template. | No. |
| `Verified Dedicated Linux Qualification` **Skipped** | Not used by the current routing; `CI Backend Decision` does that verification. | No. |
| `CI Source Qualification` pending, red or "not admitted" | An internal freshness gate. Pending means exact-source coverage is queued, running, or being dispatched; it never grants qualification. The `main` ruleset does not currently require it (spec 605 intends to), so today it never blocks a merge. It also turns red after a PR merges, by design. | No, unless the ruleset starts requiring it. |

The host is deliberately **not** a GitHub self-hosted runner, so it does not
appear under Settings → Actions → Runners. A reviewed controller on a hosted
runner leases it over SSH, and PR code runs in a disposable, credential-free
container. Self-hosted runners on a public repository would let any workflow
run code on the host.

## When Linux fails

- **A real failure** (a failing test or build): fix it and push.
  `Dedicated CI Results` links to the failing phase.
- **A verified infrastructure failure** (including waiting past the queue
  deadline, `queue_timeout`): the host signs it as an infrastructure problem and
  CI switches to the hosted lanes automatically. Nothing to do. Other host or
  SSH failures without a trusted receipt (for example the host dropping after
  the lease started) stay red: inspect `CI Backend Decision`, then re-run the
  failed jobs once the underlying problem is fixed.
- **`CI Backend Decision` failing on a GitHub API error** (for example
  `API rate limit exceeded for installation`): there is no hosted fallback for
  PRs in this case. Wait a few minutes, then re-run the failed jobs.
- **Removing either label after Linux ran** makes the source gate dispatch a
  hosted replacement run of the same head by itself. Nothing to do, and it does
  not block merging.

## Merging

The coordinated main-freshness rollout is described in
[the policy and rollout plan](../../specs/605-priority-linux-ci/stable-main-qualification.md).
Until its reviewed helpers are active and the GitHub setting is changed, the
existing up-to-date requirement still applies. To finish a PR during this
transition, reserve its next merge slot: avoid other main merges from its final
branch update until its green CI, peer approval and merge.

After that coordinated cutover, merge only when all of these hold for the PR's current head:

- `CI Results` is green on that exact head;
- Greptile is `5/5` on that head, or on an earlier head that
  `node scripts/review/review-carryover.mjs check <pr>` accepts (see
  [Review Pipeline](review-pipeline.md#greptile-review-carry-over));
- no unresolved review threads;
- one approving review from someone other than the author;
- GitHub reports no merge conflicts.

A main advance alone then requires no branch push or repeat approval. CI keeps
the immutable main revision and merge it actually tested; it does not claim
coverage of subsequent main changes. New commits to the PR still rerun CI and
dismiss approvals. Non-main stack parents retain strict freshness.

Two independently green changes can interact badly after merging. Keep full
main CI; if it fails, stop further merges and repair or revert the integration.

Updating a branch with `main` creates a new head, so CI runs again. The
Greptile review usually carries over (exit `0`): base merges, restacks and
retargets keep it, new work does not. A new head still dismisses GitHub approval. Merge a standalone PR with
`gh pr merge <n> --squash --match-head-commit <sha>`, one PR at a time. Stack
layers merge through the native stack merge in
[Stacked PRs](stacked-prs.md), never a `gh pr merge` loop.

## Operators

Routing is controlled by repository variables: `MATRIX_CI_DEDICATED_ENABLED`
(PR routing), `MATRIX_CI_DEDICATED_SHADOW` (observation), and
`MATRIX_CI_DEDICATED_MAIN` (main Linux-first). Rollback is
`gh variable set MATRIX_CI_DEDICATED_ENABLED --repo HamedMP/matrix-os --body false`.
That routes new CI runs to hosted runners. PRs that already ran on Linux keep
their skipped hosted lanes until the source gate's next reconcile dispatches a
hosted replacement run for each; rollback is complete only once those
replacement runs are green.

When a change takes effect depends on where it runs:

- `ci.yml` is a `pull_request` workflow, so a PR that edits it, or the helpers
  `ci.yml` loads from its own checkout, changes that PR's own CI run.
- `ci-dedicated.yml` runs from `main`, so its edits apply once merged.
- The controller and the source qualification gates load their `scripts/ci/`
  helpers from the pin `MATRIX_CI_CONTROLLER_SHA`. A change there takes effect
  only after an operator moves the pin and the host's root policy. By
  procedure the target is a green `main` commit containing the change; the
  controller itself only checks that the pin is on `main`.

## Measuring Linux against hosted CI

Compare the exact merge SHA, ordered parents and frozen lockfile, not unrelated
successful PRs. Record the controller/harness/image pins, suite inventories,
requesting/controller run IDs and attempts, and every failure or retry. Linux
qualification covers heavy lanes; the independent hosted security, PostgreSQL
and Node 20 lanes still contribute to the final CI result.

Report admission/runner queue, setup, workload execution and time to successful
`CI Results` separately. Use the immutable Linux receipt's `queueSeconds` and
`wallSeconds`, not the controller job duration as test runtime. For hosted CI,
use individual job timestamps and report the critical path rather than summing
parallel jobs. Metadata-only and superseded skips are not full qualifications.
A passed Linux workload with failed orchestration is a failed end-to-end sample.
A single same-source pair cannot establish median/tail latency or throughput.

Pagination and pending-state repairs are pinned controller helpers. Merge alone
does not activate them: after reviewed green main, approve that controller on
the host and advance `MATRIX_CI_CONTROLLER_SHA` using the existing operator
procedure. No routing flag or approval-rule change is needed. The independent
host-retention repair in PR #2592 retains its own review and CI gates.
