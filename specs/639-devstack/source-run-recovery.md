# Retained hosted source runs

[ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack),
existing DevStack native stack #3204, publisher layer #3368.

The agent chooses a run UUID and a random recovery key before uploading source.
An explicitly recoverable submission is admitted into the existing Postgres run
store before a detached, bounded publisher job starts. Its result retains the
publisher's exact content revision, real test exit code and bounded log. A CLI
process can exit after admission and another process can retrieve that run.

## Authority and protocol

| Entry | Authority | Behavior |
| --- | --- | --- |
| POST `/devstack/cli/source` without run headers | Existing short-lived exact-worktree grant | Existing synchronous path; HTTP disconnect cancels the test |
| Same POST with `x-devstack-run-id` and `x-devstack-run-key` | Same grant, live membership/registry, valid UUID and 256-bit key | Durable admission, then 202; disconnect does not cancel an accepted job |
| GET `/devstack/cli/source/:runId` | Current grant for the same six-field source/target binding, current membership/registry and original recovery key | Retained status/receipt only; never republishes source |

The trusted approval host remains separate and denies these API paths and all
WebSockets. Polling advertises recovery only when a Postgres store is wired.
Expired grants require another normal browser approval. A new approval cannot
use a different owner, runtime, worktree, handle, container or source fingerprint
to retrieve a prior run, even with its key. Keys and grants never appear in URLs,
normal output, publisher IPC, uploaded source or retained result logs.

## Storage and lifecycle

Extend `devstack_runs` with a source kind, private binding digest and optional
validated source receipt. The existing admission transaction supplies UUID
idempotency, a 256-record/24-hour retention bound and per-worktree exclusion.
The admitted Git base stays distinct from the receipt's content revision.
Conflicting content under the same run ID is rejected. A replay returns the old
record and never executes again; an ingress restart never relaunches an uncertain
publication. Expired execution leases read as interrupted.

At most four detached jobs exist in an ingress process, including pending
admissions. Each has a 120-second deadline; shutdown aborts and drains them before
the owning database closes. Live authorization checks still fence staging,
publication and result return. Failure to persist completion leaves an uncertain
run until lease expiry; it must not trigger a fresh publication. Admission or
result reads never accept caller-supplied commands, paths or endpoints.
An accepted job retains its original bounded approval authority in memory.
Rotating the CLI bearer for the same binding does not cancel that job or extend
its original expiry. Old bearers cannot upload again. Membership/registration
revocation and the original expiry still stop the job at its live checkpoints.
The old operator result routes refuse source-kind records so they cannot bypass
these binding checks.

CLI recovery metadata is transport state: a private, exclusive file containing
origin, checkout fingerprint, target IDs, run UUID, key and creation time. It
contains no uploaded delta, Clerk token or grant. Bound retention/count and
symlink-safe cleanup apply. `matrix devstack result --hosted --run-id <uuid>`
loads it from the same checkout context, obtains current approval and reads the
result. Sync prints the UUID before network submission and reports that same UUID
on uncertain transport failure. Explicit ingress admission rejections (including
capacity/rate limits) report that no upload was accepted and advise a new sync;
5xx, unknown responses and incomplete accepted responses retain the original-run
recovery command. It never retries a source POST automatically.

## Verification and activation

Use real disposable Postgres, the production hosted-access factory and Unix
publisher. Disconnect after admission, finish a failing test and recover its
matching revision/log from a new ingress/store connection and CLI process. Check
same-ID concurrency executes once; reject changed content, wrong keys, changed
six-field bindings, stale membership/registry, oversized input and restart replay.
Retain the synchronous HTTP-cancellation and real Docker isolation regressions.

Keep startup composition small: source-run lifecycle belongs in its dedicated
module and hosted-access factory; the large startup entrypoint only wires and
drains it. No Main/Fast CI/Stage 2/serving Preview or live schema change is part
of implementation. HEL1 activation still needs access, concrete configuration
and rollback approval, followed by real Main Chat/browser HMR acceptance. Extend
the existing site-documentation deliverable after live qualification.

Activation includes the generation-two additive run-store migration on the
isolated candidate database. Rollback disables the candidate opt-in and drains
jobs; retain added columns and receipts for inspection instead of deleting
records or reversing the schema while a process may still use it. The migration
runner lets an older binary skip an already newer schema generation.
