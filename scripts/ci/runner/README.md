# Priority Linux qualification

The dedicated host accepts authenticated leases from a reviewed main-branch
controller for opted-in PRs and exact main pushes. Routing remains disabled
until current-head review, required CI and live canaries pass. It does not register a GitHub runner or accept SHA-only SSH jobs.
Root installs the harness and approves immutable image/controller/harness pins;
PR source executes only as UID10001 in a disposable container.

## Installation and approval

Use a dedicated Ubuntu 24.04 x86-64 host with at least 32 logical CPUs and
120000000 KiB RAM. The approved job cap is 30 CPUs/112 GiB, with 64 GiB work,
8 GiB temporary and 1 GiB home tmpfs, 4096 processes and 2 GiB shared memory.
The filesystem is read-only, capabilities are dropped, and the private-egress
firewall/network must pass admission. No host mounts, Docker socket, host
network, SSH/GitHub/cloud credentials or registration tokens enter the job.

Operators upload only reviewed runner and qualification inputs. Image builds
use a bounded context containing the explicitly reviewed files under
`scripts/ci/runner/` and `scripts/ci/qualification/`; a deny-by-default
`.dockerignore` must exclude `.git`, `.env`, credentials, evidence and every
unlisted path. Never send an unfiltered checkout as Docker context.

```sh
bash scripts/ci/runner/bootstrap-host.sh
docker build --platform linux/amd64 \
  -f scripts/ci/runner/Dockerfile \
  --build-arg SOURCE_SHA=<reviewed-public-40-character-sha> \
  -t matrix-ci-benchmark:reviewed <reviewed-bounded-context>
bash scripts/ci/runner/install-dispatch.sh < dedicated-ci-ed25519.pub
```

Installation grants `matrixci` only root `lease.py run|cancel`, with no shell,
SCP, PTY or forwarding. It writes a root-owned `harness.sha256` manifest;
`/etc/matrix-ci/runner.json` must separately approve the exact manifest SHA256,
immutable image digest, reviewed controller SHA allowlist and enabled mode:
`repository`, `controllerShas`, `imageDigest`, `harnessDigest`, `modes`.
Only `HamedMP/matrix-os`, the main-ref `ci-dedicated.yml` controller, and the
literal qualification limits are accepted. Config and installed inputs must
be root-owned regular files with no foreign write permission or symlinks.
Missing or mismatched approval fails closed. Installation alone does not
activate dispatch or delegation.

The image pins Node 24.21.0, pnpm 10.33.4 and Bun 1.4.3 with download checksums.
Prepared dependencies/browsers are immutable and reused only for a matching
frozen lock; source caches remain disposable and outside every checkout.
PostgreSQL 16 runs nonroot on container loopback for isolated native fixtures.
Funded/root/Postgres service contracts and Node 20 compatibility remain hosted.

## Lease admission and cancellation

The fixed SSH commands are `lease-v1 run <32-lowercase-hex-lease>` and
`lease-v1 cancel <same-lease>`. A random 256-bit owner capability travels only
through bounded stdin JSONL. It is never an argument, log, result or child
input. The public request binds repository/source kind/head/base/ref and exact public
parents: a PR has two ordered parents with its head second; a main request
explicitly identifies the current pushed main commit and its one or two actual
parents. PR requests bind their PR number; main has no fabricated PR identity.
Both bind requesting and controller run IDs/attempts,
controller SHA/ref/workflow, approved image/harness, mode, suite and limits.
Canonical request identity is SHA256 of recursively key-sorted UTF8 JSON.

The host serializes leases under the shared `benchmark.lock`, with an
1800-second queue deadline. Main requests have priority, but at most two
consecutive admitted main workloads run before the oldest waiting PR. Requests
remain FIFO within each class; priority never preempts an active owner. The
controller cancels obsolete attempts only for their own source, preserving
unrelated PR work. After acquiring the lock, the
host rejects leftover disposable containers and sends a one-use random
challenge. The trusted controller revalidates current PR/run/config APIs
**after this lock**, then grants that exact challenge. No candidate container
exists before the grant. PRs require both `fast-ci` and current-head
`ready-for-ci`; `ci-linux` is no longer an admission label. When the global
routing switch is enabled, main pushes select private Linux by default without
PR labels. Stack-parent base branches are supported while the controller remains main. The live direct branch `baseSha` stays separate from the actual first parent. GitHub native cumulative merges are accepted only by the protected controller's bounded official stack-membership, adjacent predecessor/current-ref and tree-equivalence proof, revalidated at admission, grant, renewal and settlement. The host independently checks the signed actual public parent pair; it does not authorize stack membership.

Fresh challenges require authenticated renewal every 60 seconds and
expire after 120 seconds. The initial after-lock grant expires after 30 seconds.
Live branch identity is read from the exact branch endpoint, with matching
name/SHA and the existing source and lease deadlines. The Git refs endpoint
advertises a 300-second poll interval and is not used for these short checks.
API poll intervals above 60 seconds still fail closed; authenticated conditional
responses require the same authenticated URL and opaque entity tag (HTTP weak
If-None-Match comparison), and API errors never permit stale renewal.
Source/run drift detection is bounded at 60 seconds; final live API validation
remains mandatory before publishing green. Shadow mode permits a successful
completed requesting CI run; delegated mode requires it active until the receipt. Cancellation,
failure, newer attempts or source/config drift revoke admission. EOF and
signals follow the same owned cleanup path. Authenticated separate cancellation
can affect only its exact lease/capability/request digest, never a caller PID
or another PR. Duplicate leases/capabilities/attempt tuples retain replay
barriers. Registry caps are 32 pending/active and 256 completed with seven-day
retention; capacity exhaustion fails closed.

Root kills/removes the exact lease-labelled container and reaps its owned
process session before releasing admission. Execution is capped at 1800 seconds.
Unproved cleanup records a block; replacement CPU cannot start until an
operator verifies cleanup. A daemon failure is never reported as a pass.
SIGKILL or host failure preserves uncertain active registry entries. They require
operator recovery after all builds stop and owned CPU/container cleanup is
verified; recurring retention does not evict an uncertain active owner. The image
keepalive exits after 2100 seconds during ordinary failures. The independent
root cleanup timer removes disposable containers older than 2700 seconds on
a five-minute cadence, bounding crash-orphan CPU at 3000 seconds plus bounded
removal. Operators stop admission, verify no disposable containers or owned
processes remain, preserve failure evidence, then recover only the affected
lease records and cleanup block. Never clear uncertain state during a live build.

## Workload and evidence

An immutable-image preparer fetches only the fixed public repository and
requested source SHA as UID10001. It reads bounded Git objects as data and
verifies the exact ordered PR pair or the explicit main commit's one or two
public parents before candidate scripts run. Root retains a
validated inventory bounded at 2 MiB, including canonical JSON and its newline,
and injects its exact hashed bytes into the job. Every tracked file byte/mode
is independently checked against the trusted pre-workload inventory. Candidate
Git index flags or local ignore configuration cannot suppress source guards.
No host Git checkout, GitHub token or candidate script runs as root.

Qualification preserves 56 phases and 14 strict source guards: four independent
checkouts/installs/prerequisites, full unit with 16 workers, blocking native typecheck, sync
build/tests/publish, SDK compatibility, docs/source coverage, production Web,
pristine general E2E with two workers and native grid with one worker before Electron build, and all 14 required
Electron files in ten sequential invocations. Clipboard retains its separate
single-worker display. Browser/SDK/Python caches stay outside Git. The tracked
ops import directory becomes 0555 before unit tests after source bytes/modes
are checked, preserving isolated Python imports without generated bytecode.
No source restore, blanket ignore or assertion/time-limit weakening is used.

Ordinary lane failures remain fatal while other independent lanes finish.
Icons/production trace are measured when Web and its source guards passed,
even if another lane failed. Dynamic report inventories/counts, every phase,
every guard, four additional host-executed final source checks, icon
render/negative controls, exact source/image/harness and owned
cleanup must all pass before a root-created completed receipt is emitted.
The final source probes run after smoke against all four lanes; their root-owned
proofs cannot be supplied through candidate artifact archives. Raw candidate
output never enters the controller JSONL channel.

Evidence under `/var/lib/matrix-ci/results/lease.<id>/evidence` is fixed-name,
regular-only, exclusively written, bounded at 50 MiB/file and 150 MiB total;
execution logs are 20 MiB and smoke streams 1 MiB each. Treat reports as data.
Recurring cleanup protects active leases, rejects symlinks and retains bounded
completed evidence. Root-only `start-ephemeral.sh` remains available for manual
partial diagnostics; it cannot satisfy automatic qualification.

## Availability fallback and rollout

A recognized root pre-workload availability result may select complete hosted
execution only with authenticated source/run binding, `workloadStarted=false`,
proved owned cleanup and fresh live source/run validation. Queue capacity or
the 1800-second queue deadline, missing host capacity, unavailable approved image
and daemon availability have fixed classifications. A daemon failure with
unproved cleanup remains red. After wrapper allocation is attempted, Docker,
source, test and evidence failures cannot become availability fallback.

The separate controller transport exception is limited to a pinned-endpoint
connection refusal or timeout: exact recognized client diagnostics, exit 255,
no control bytes or grant, and at most 20 seconds, followed by fresh source/run
API validation. Generic SSH failures, authentication/host-key errors, banners,
disconnects after a grant and ambiguous transport remain red. Neither path can
restore a stale, cancelled, failed or incompletely cleaned-up qualification.

Fallback runs every required hosted lane, including lanes otherwise filtered
for a small change. The independent App verifies complete hosted coverage for
the exact source and requesting attempt before restoring the freshness gate.
Unknown failures never choose hosted recovery or adopt an older green run.

Keep rollout off until review, required CI and live canaries pass. Once enabled,
main and opted-in PRs use private Linux; forks, unsupported events and protected
platform/security lanes keep hosted coverage. `CI Results` aggregates the exact
current requesting attempt. Disabling routing requires fresh complete hosted
checks for previously admitted sources; flipping the switch alone does not
restore skipped coverage. A successful old receipt or
similarly named check cannot qualify another attempt. Public testing docs ship
in the companion site documentation PR.

## Metadata edits and bounded run history

Title/body edits keep a real `CI Results` job in the latest Actions suite.
That job verifies the newest genuine coverage run for the PR head, including
its recorded tested base/merge, workflow, attempt and Actions issuer. Main-only
advances retain that frozen coverage; non-main stack parents remain strictly current.
Metadata verifications cannot qualify each other. Missing, failed, cancelled,
pending or mismatched coverage fails closed; skipped workload jobs are never
coverage evidence. Base edits retain normal full CI, and drafts still publish
no required aggregate. No approval or required-check binding changes are needed.

Controller discovery streams inclusive creation-time windows so unrelated
traffic cannot bury evidence behind the former 300-run scan or GitHub's
1,000-result filtered-search ceiling. It retains runs sharing a boundary second
and compares all event streams before selecting the newest authenticated run.
Memory stays at one 100-run page per stream, with at most 100 API requests per
discovery. API errors, budget exhaustion and more than 1,000 runs in one second
fail closed; they never authorize an older green result. Privileged controllers
use this helper only after its reviewed commit is activated through the existing
idle-host pin procedure.

## Main-only advances

PR qualification targeting `main` binds the unchanged PR head to the immutable
merge actually tested. Every admission/grant/renewal/result check verifies its
ordered `[recordedMain, head]` parents and proves recorded main remains an ancestor
of live main. New main commits alone do not restart or revoke this work. Source
gate reconciliation discovers the newest genuine same-head requesting run and
keeps its recorded base/source; it cannot skip a newer pending/failed attempt or
pretend an old receipt covers the new main merge. Retargets, head changes,
removed admission, rewritten main history and non-main stack parents still fail
closed. Main-push source checks remain exact-current-main.

This helper behavior and GitHub's up-to-date setting ship together through the
[coordinated rollout](../../../specs/605-priority-linux-ci/stable-main-qualification.md).
Do not loosen the setting until the PR is reviewed/green, its reviewed merged
controller is activated, candidate consumers contain the change, and full live
canaries pass. Required CI, Greptile, peer approval, image/harness and routing
flags remain unchanged. Main integration CI catches interactions between
independently green PRs; stop further merges and repair/revert on failure.

## Controller configuration credentials

Repository Variables API reads require a GitHub App installation token with
`actions_variables: read`; `GITHUB_TOKEN` Actions permissions do not include this
access. The Matrix CI Qualification installation therefore needs Variables
read-only in addition to its existing Checks write grant.

Authenticated default-main jobs mint a separate token limited to the current
repository and Variables read. The protected gate token still requests only
Checks write. Only reviewed, pinned helpers see the App key; candidate code and
the isolated worker receive neither credential. Normal workflow/run/PR APIs
retain the Actions client. Live configuration reads still occur before grants
and renewals; denied reads fail closed. Configuration tokens are masked, checked
for repository/permission/expiry scope and revoked on job completion.

The pinned token action does not expose the Variables permission, so the helper
uses a short-lived Node-signed App JWT with the bundled GitHub Script client and
the installation-token endpoint. Token request errors are sanitized to avoid
logging authorization headers. No routing activation occurs in this repair.

Before rollout, advance `MATRIX_CI_CONTROLLER_SHA` to a reviewed main commit
containing `dedicated-config-token.mjs` and approve that same SHA in the host's
`controllerShas`. An older ancestor pin can pass ancestry checks while lacking
the new helper. Keep routing disabled until both pins and live tests agree.

Dispatch owns a configuration session that refreshes credentials five minutes
before their actual expiry, revoking the replaced token. Final settlement uses
its own fresh session. Both close in `finally`; API errors fail closed and never
reuse an expired token. This preserves the full queue and execution deadlines.
