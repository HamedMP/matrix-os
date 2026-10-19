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
uses Linux first when `MATRIX_CI_DEDICATED_MAIN=true`; otherwise it uses
hosted runners. Full hosted fallback still requires verified coverage.

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
| `CI Source Qualification` pending, red or "not admitted" | An internal freshness gate. Pending means exact-source coverage is queued, running, or being dispatched; it never grants qualification. The `main` ruleset does not currently require it (spec 605 intends to), so today it never blocks a merge. A red result needs investigation; it does not change the Actions-owned aggregate. | Inspect its failure evidence. |

Scheduled source reconciliation qualifies main before PR maintenance. It then
rotates through batches of at most eight open PRs, with a shared ceiling of 256
API calls and four minutes per invocation. Deferred PRs retain their existing
checks; deferral never grants qualification or turns missing coverage into
success. PR-specific events still reconcile their scope immediately. The
schedule is a trigger cadence, not a guaranteed refresh deadline.

Manual full-scope reconciliation also requires an authenticated main workflow;
its workflow-definition head may differ from the separately reviewed checkout pin.
Requester dispatch reserves its API slot before recording the attempt; known
pre-call deferral can retry, while ambiguous marker or dispatch outcomes retain
duplicate suppression. Only an explicit rejected dispatch permits an immediate retry.

A controller superseded by a later reviewed pin on main stops before writing
checks or dispatching work. Invalid configuration and unauthenticated replacement
pins still fail closed. An operator pin change requires the rollout steps below.

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

An older base revision shown in PR metadata alone does not require a branch
update: CI verifies the actual main parent of GitHub's generated merge. Existing
tested sources retain their exact parent pair and provenance checks. A real
merge conflict still needs resolution, and CI failures still need repair.

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

Before activating a new pin, verify the host is idle and update its existing
trusted-controller policy first, preserving the old entries and other limits.
Drain obsolete reconciliation-only writers before changing the repository pin;
preserve legitimate Linux work and unknown runs. After activation, let a genuine
scheduled or completed-main-CI controller verify exact-source coverage. Do not
clear checks by writing success, deleting failures, or rerunning workloads whose
existing authenticated coverage still applies.

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

### Completion races and release gates

GitHub can report a workflow as successful before every job has its final
status and conclusion. The host-bundle same-SHA gate retries empty inventories
and pending job results within its existing 90-minute deadline. A terminal
failed, cancelled, timed-out or neutral required job still blocks publication.
Only the explicitly nonblocking shadow verifier is excluded.

Full hosted main recovery can finish while a delayed dedicated lease is still
running. After authenticating the exact requester, attempt, source and newest
controller, a successful completed requester revokes redundant delegated work.
Its controller settles neutral without a receipt or qualification credit.
Failed requesters and failed Linux workloads remain failures; shadow work keeps
its existing policy. This helper change needs the reviewed controller-pin
activation described above, after merge and green-main verification.

The 19 October regressions and validation are recorded in
[completion recovery](../../specs/630-ci-check-attribution/completion-recovery.md).

Pagination and pending-state repairs are pinned controller helpers. Merge alone
does not activate them: after reviewed green main, approve that controller on
the host and advance `MATRIX_CI_CONTROLLER_SHA` using the existing operator
procedure. No routing flag or approval-rule change is needed. The independent
host-retention repair in PR #2592 retains its own review and CI gates.

### Normalized Actions check identity

GitHub can normalize a controller-created `Dedicated CI Results` URL to
`/runs/<check-id>` and attach the check to an existing Actions suite for the
source commit. Its suite ID can therefore differ from the creating controller's
workflow suite. New evidence records `controllerRunId`; the waiter binds that
index to the independently authenticated current controller and attempt. Older
evidence still requires matching suite identity. A pending index never qualifies
coverage: completion still requires that exact controller's immutable artifact,
source/request tuple, reviewed execution inputs, complete phases and cleanup
proof. A contradictory run ID is rejected even when its URL or suite matches.

## Isolating auxiliary checks from Main

GitHub attaches `workflow_dispatch` checks to the dispatched ref's commit, even
when a later checkout tests a different PR. A branch alias at Main's existing
SHA therefore does not isolate those checks.

Auxiliary execution uses `ci-execution/<controller-sha>`. Its commit is a
distinct, empty child of the reviewed controller: exactly one parent, the
controller SHA, and exactly the same tree. The execution commit changes no
source files. Protect these refs against creation, updates and deletion by
untrusted writers; only the existing operator creates them from reviewed Main.
Retain refs while historical receipts or active runs depend on them.

The execution ref/SHA, workflow path and workflow SHA are authenticated before
loading privileged helpers or admitting credentials. The reviewed controller
must remain on Main. New admission and grant checks also require the current
reviewed configuration. `controllerRef=refs/heads/main` in the host request
continues to identify the approved **source authority**, not the actual
execution ref. Isolated indexes record the actual execution origin separately;
the versioned artifact envelope binds that origin to the unchanged host receipt.
Consumers verify both against GitHub metadata. Historical Main receipts retain
their existing schema and validation.

With `MATRIX_CI_ISOLATED_EXECUTION=true`, Main handles routing for auxiliary
requests; their actual tests, previews and maintenance execute on the isolated
commit. A successful routing job proves only that routing succeeded. It never
replaces source-bound PR checks, complete hosted coverage, or an authenticated
Linux receipt. Genuine Main push CI and its Linux qualification still execute
against Main and can make Main red when Main itself fails.

Preview origin checks use the existing protected variable snapshot supplied to
the job. They do not acquire an additional Variables-read credential. Immutable
ref protection, exact tree/parent proof and fresh PR-head checks remain required;
operators drain legacy jobs during rollout. CI grants retain their independent
live configuration checks.

### Initial staged activation

1. Merge only after current-head Greptile 5/5 and genuine complete PR CI. Leave
   the isolation flag false/unset while the new Main commit completes genuine
   Main qualification through the existing route.
2. Protect `ci-execution/*`, create its tree-identical execution commit, and
   read back the exact parent, tree and ref. Add only that exact protected branch
   to the existing CI environment's allowed deployment branches when required.
3. Follow the host-first controller procedure: genuine Main coverage, idle
   host, preserved policy backup, one reviewed controller append, and exact
   readback. Keep the approved image, harness, existing routing flags and Main
   review/CI protections unchanged.
4. Drain only proven legacy auxiliary writers before advancing the repository
   pin. Preserve real qualification workloads, unknown work and immutable failure
   evidence. Pause auxiliary trigger admission during the pin/flag transition if
   needed to prevent a new legacy invocation racing that drain; Main CI remains
   enabled. Enable `MATRIX_CI_ISOLATED_EXECUTION` last, then restore admission.
   False/unset is the explicit temporary compatibility path, not the completed
   isolation state.
5. Verify real PR refresh, qualification and preview runs execute at the
   isolated SHA and retain their actual outcomes. Check all pages of check runs
   and commit statuses on the actual latest Main commit. Main's own successful
   CI run alone is insufficient to call the commit green.

Do not replace failures with synthetic passing checks, hide failing tests with
`continue-on-error`, or delete diagnostic history to produce a green badge.

### Explicit isolated CI handoff

An isolated PR refresh explicitly dispatches its own Linux qualification from
a separate protected execution backend job on every attempt. It authenticates its actual run,
attempt, workflow, protected execution origin and current PR source first.
Main routing remains routing-only; the isolated self-handoff never suppresses
its real workloads. Hosted-only refreshes retain their full hosted path.
Qualification does not depend on delivery of a recursive `workflow_run` event.
Authenticated terminal events provide deduplicated reconciliation when an explicit
completion handoff is missing; scheduled recovery covers runs without such an event.

After the selected workloads settle, a separate completion job dispatches
reconciliation before the required aggregate. The aggregate rejects a failed
or cancelled handoff and requires completion proof for the current attempt. A
failed-only retry may retain an older successful backend job. GitHub can clone
that job’s API record into the new attempt, so its protected output records
ownership. A retained provider decision schedules lanes only; completion then
requests fresh Linux qualification and verifies its immutable current-attempt
receipt before reconciling. Infrastructure unavailability is not full coverage
for that retained job; use a full rerun to select hosted recovery. Current-attempt
hosted recovery still requires its verified infrastructure receipt and all
required hosted workloads. An aggregate-only
retry without fresh completion fails with explicit rerun guidance.

Reconciliation waits at most three minutes for the real
requester to become terminal, before receiving App credentials; its actual
success, failure or cancellation remains authoritative. The qualification
controller never waits for completion of its requesting CI, avoiding a cycle.
Dispatch transport ambiguity is not automatically retried.

If SSH closes while an authenticated renewal is pending, the client drains a
buffered completion without writing to the closed stream. This never grants an
initial lock after closure or relaxes renewal deadlines: success still requires
the complete receipt, final unconditional source checks, exit zero and no trailing data.

Controller history searches start ten minutes before the independently
authenticated requester's creation time. Pagination retains that lower bound,
along with existing request and same-second caps. Missing or malformed requester
timestamps fail closed. An empty bounded search is missing evidence, never a
passing qualification.

For subsequent pin upgrades, keep isolation enabled. Fully qualify the new Main
commit, reuse the existing execution protection, create a new exact-tree child,
and add only its exact environment branch while preserving existing policies.
Pause and drain auxiliary work, approve the new controller on the idle host,
advance the pin last, and resume. Retain older execution refs and receipts.
