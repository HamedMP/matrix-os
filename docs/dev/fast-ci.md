# fast-ci: priority Linux CI for PRs

`fast-ci` runs a PR's heavy CI lanes on a dedicated Linux host instead of
GitHub-hosted runners. A typical full run takes about 13 minutes on Linux
against about 25 minutes hosted. This page is the engineer workflow; the
design lives in [spec 605](../../specs/605-priority-linux-ci/spec.md) and the
host internals in [`scripts/ci/runner/README.md`](../../scripts/ci/runner/README.md).

## Using it

1. Open the PR (same repository, not a draft).
2. Add `fast-ci` **first**.
3. Add `ready-for-ci` to start CI. This is the same label every PR uses;
   it is sticky, so later pushes rerun CI while it stays on.

Adding the labels the other way round still works, but CI that already
started hosted is not cancelled. Keep the order: `fast-ci`, then
`ready-for-ci`.

Only PRs with **both** labels run on Linux. Main CI runs on hosted runners
(`MATRIX_CI_DEDICATED_MAIN=false`), so main never holds the Linux host.

## One host, one job at a time

The host runs a single qualification at a time, first come first served,
with a 30-minute queue deadline. A job that waits longer fails with
`queue_timeout`.

- **Stacks:** add `fast-ci` only to the one or two layers you are about to
  merge. Labelling a whole stack queues every layer behind each other and most
  of them time out. Hosted runners run many jobs in parallel and are free for
  this public repository, so they are the better choice for stack-wide CI.
- **Push less often.** Every push to a `fast-ci` PR takes another slot.

## Reading the checks

| Check | What it means | Act on it? |
| --- | --- | --- |
| `CI Results` | The required aggregate. Green on the exact head means CI passed. | **Yes**: the only CI check that gates merging. |
| `Dedicated CI Results` | The Linux suite for this head (unit, typecheck, SDK compatibility, docs, production Web, general and Electron E2E). | Read it when Linux failed. |
| `CI Backend Decision` | Waits for and verifies the Linux result, then tells `CI Results` whether hosted lanes must run. | Read it when `CI Results` failed. |
| `Type Check`, `Unit Tests (${{ matrix.shard }}/4)`, `E2E Tests (${{ matrix.lane }})`, `Shell Production Build`, ... **Skipped** | The hosted copies of lanes that ran on Linux. GitHub only fills in matrix names for jobs that run, so skipped matrix jobs show the raw template. | No. |
| `Verified Dedicated Linux Qualification` **Skipped** | Only used in shadow mode. | No. |
| `CI Source Qualification` red or "not admitted" | An internal freshness gate, not a required check. It also turns red after a PR merges, by design. | No. |

The host is deliberately **not** a GitHub self-hosted runner, so it does not
appear under Settings → Actions → Runners. A reviewed controller on a hosted
runner leases it over SSH, and PR code runs in a disposable, credential-free
container. Self-hosted runners on a public repository would let any workflow
run code on the host.

## When Linux fails

- **A real failure** (a failing test or build): fix it and push.
  `Dedicated CI Results` links to the failing phase.
- **The host reported an infrastructure problem:** CI switches to the hosted
  lanes automatically. Nothing to do.
- **`queue_timeout`, or `CI Backend Decision` failing on a GitHub API error**
  (for example `API rate limit exceeded for installation`): there is no hosted
  fallback for PRs. Wait a few minutes, then re-run the failed jobs.
- **Removing `fast-ci` after Linux ran** makes the source gate demand a fresh
  hosted run of the same head. Prefer leaving the label on.

## Merging

Merge only when all of these hold for the PR's current head:

- the branch is up to date with `main` (the ruleset requires it);
- `CI Results` is green on that exact head;
- Greptile is `5/5` on that head, or on an earlier head that
  `node scripts/review/review-carryover.mjs check <pr>` accepts (see
  [Review Pipeline](review-pipeline.md#greptile-review-carry-over));
- no unresolved review threads.

Updating a branch with `main` creates a new head, so CI runs again. The review
usually carries over (exit `0`): base merges, restacks and retargets keep it,
new work does not. Merge one PR at a time with
`gh pr merge <n> --squash --match-head-commit <sha>`.

## Operators

Routing is controlled by repository variables: `MATRIX_CI_DEDICATED_ENABLED`
(PR routing), `MATRIX_CI_DEDICATED_SHADOW` (observation), and
`MATRIX_CI_DEDICATED_MAIN` (main Linux-first). Rollback is
`gh variable set MATRIX_CI_DEDICATED_ENABLED --repo HamedMP/matrix-os --body false`,
which sends every PR back to hosted runners.

The controller and the source qualification gates run their `scripts/ci/`
helpers from the reviewed pin `MATRIX_CI_CONTROLLER_SHA`. Workflow YAML, and
helpers that `ci.yml` runs from its own checkout, apply on merge; a change to a
pinned controller or gate helper takes effect only after an operator moves the
pin and the host's root policy to a green main commit that contains it.
