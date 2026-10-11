# Priority Linux qualification

The dedicated host accepts authenticated leases from a reviewed main-branch
controller. It does not register a GitHub runner or accept SHA-only SSH jobs.
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
input. The public request binds repository/PR/head/base/ref/exact ordered
`[base,head]` merge parents, requesting and controller run IDs/attempts,
controller SHA/ref/workflow, approved image/harness, mode, suite and limits.
Canonical request identity is SHA256 of recursively key-sorted UTF8 JSON.

The controller owns the global FIFO queue and separately cancels obsolete
attempts for each PR. Host admission preserves FIFO leases and a shared
`benchmark.lock`, each with a 1800-second wait. After acquiring the lock, the
host rejects leftover disposable containers and sends a one-use random
challenge. The trusted controller revalidates current PR/run/config APIs
**after this lock**, then grants that exact challenge. No candidate container
exists before the grant. Both `ci-linux` and `ready-for-ci` are required;
stack-parent base branches are supported while the controller remains main.

Fresh challenges require authenticated renewal every 60 seconds and
expire after 120 seconds. The initial after-lock grant expires after 30 seconds.
API poll intervals above 60 seconds fail closed; authenticated conditional
responses require valid cached proof, and API errors never permit stale renewal.
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
requested merge SHA as UID10001. It reads bounded Git objects as data and
verifies the exact two parents before candidate scripts run. Root retains a
validated inventory bounded at 2 MiB, including canonical JSON and its newline,
and injects its exact hashed bytes into the job. Every tracked file byte/mode
is independently checked against the trusted pre-workload inventory. Candidate
Git index flags or local ignore configuration cannot suppress source guards.
No host Git checkout, GitHub token or candidate script runs as root.

Qualification preserves 55 phases and 14 strict source guards: four independent
checkouts/installs/prerequisites, full unit with 16 workers, blocking native typecheck, sync
build/tests/publish, SDK compatibility, docs/source coverage, production Web,
pristine general E2E with two workers and native grid with one worker before Electron build, and all 13 required
Electron files in nine sequential invocations. Clipboard retains its separate
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

Keep rollout off until review and live canaries pass. Main/fork/protected lanes
remain hosted, and `CI Results` aggregates the exact current requesting attempt.
Disabling opt-in routing restores hosted execution. A successful old receipt or
similarly named check cannot qualify another attempt. Public testing docs ship
in the companion site documentation PR.
