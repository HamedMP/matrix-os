# Immutable Linux qualification

The protected controller supplies a current public PR merge SHA and its exact
ordered parents, or an explicitly identified current main push and its actual
one or two public parents. The root lease manager pins the approved image and harness,
checks admission after its host lock, and runs candidate code only as UID10001 in
a bounded disposable container. This directory contains immutable image tools;
source code never selects root commands, Docker resources, or evidence paths.

## Source preparation

Before application code runs, the host invokes:

```sh
python3 -I /opt/matrix-ci/qualification/manifest.py --prepare-public MERGE_SHA ACTUAL_FIRST_PARENT HEAD_SHA
```

For a main push, the host uses the separate source-kind-aware entrypoint:

```sh
python3 -I /opt/matrix-ci/qualification/manifest.py --prepare-public-main MAIN_SHA ACTUAL_PARENTS_JSON
```

`ACTUAL_PARENTS_JSON` is one quoted compact JSON array containing the main
commit's exact one or two parent SHAs, rather than a comma-separated shell list.

The live direct branch base may differ from a native stack's actual first parent.
Only the protected controller authorizes native membership and tree equivalence;
the immutable preparer verifies the signed public commit and actual parents.
A non-equivalent generated tree requires rebase/fresh source and fails closed.

The preparer fetches only `HamedMP/matrix-os` into fresh
`/work/manifest-source`, with depth two and a 120-second total Git deadline. Git
plumbing verifies the merge, tree, and the exact ordered parents for the declared source kind; it reads
bounded tracked configuration, lockfile, tests, icon imports and Python imports.
The version-two manifest also retains every tracked blob path, Git mode, blob
digest and byte size, limited to 30,000 paths, 50 MiB per file and 512 MiB total.
It executes no candidate configuration, imports, lifecycle scripts or hooks.
Unsupported literal test scopes, truncated inventories, unsafe paths, changed
required Electron scope and unpinned runtime versions fail closed. Git pack files
remain subject to container tmpfs limits; output limits apply to pipes.

`manifest_bytes(inventory)` returns compact sorted-key UTF-8 JSON plus one
newline, at most 2 MiB. The host calls `check_manifest(inventory, request)`, retains
its independently prepared dictionary, hashes those exact bytes, and injects
`/work/qualification-input.json`. The optional public API adapter is diagnostic;
the workload does not require unauthenticated API inventory requests.

## Workload

```sh
/opt/matrix-ci/qualification/benchmark.sh MERGE_SHA /work/qualification-input.json MANIFEST_SHA256
```

Four fresh independent Git clones and object stores isolate unit, mechanical,
Web and E2E outputs. Every clone verifies the pinned source. Frozen installs,
shared prerequisite builds and explicit brand builds are measured; caches,
browsers, native PostgreSQL and the SDK compatibility installation remain
outside source checkouts.

Checkout timing includes prepared-cache selection and copy before application
code runs. The immutable helper revalidates the trusted manifest digest and
source lockfile, then compares its SHA256 with the root-owned image preparation
pin. An exact match copies only image package content/index into a disposable
run-private store; frozen installs still run in all four clones with package
imports copied into independent node_modules. Image files are never written.
The helper reads bounded readonly pnpm10 metadata, verifies browsers.json against
its SHA512 content digest, and requires each pinned Chromium, headless-shell and
FFmpeg revision for Ubuntu24.04 x64 to have an installation marker. Only then do
both measured browser setup phases use the readonly image browser directory.
Missing or mismatched cache data uses normal frozen installs/browser downloads;
copy failures fail setup. No SDK build cache or timing improvement is assumed.

The reviewed contract is 55 measured phases and 14 source guards: full unit tests
with 16 workers and JSON/docs/source coverage proofs; blocking native typechecks;
sync build, tests and publish checks; real SDK compatibility; production Web
build; general E2E with two workers and native grid with one worker before
Electron build; 13 required Electron files in nine sequential invocations,
including a dedicated one-worker clipboard invocation. Each lane is awaited and
its failure is retained. Native PostgreSQL starts inside the container and drains
after all lanes. Source integrity independently streams actual tracked bytes, executable modes
and symlink targets against that immutable full inventory through ancestor-safe
reads. It compares index entries to the inventory and rejects assume-unchanged,
skip-worktree, local exclusions and global ignore overrides. It also rejects
staged, tracked or unignored changes
before/after lanes, including before Electron build and release checks. Only the
reviewed unit Python-import directory is leased read-only, using exact tracked
hashes/modes; no ignore rules or application assertions are changed.

Pattern, React Doctor, funded PostgreSQL, privileged host checks and additional
hosted compatibility lanes remain required by the hosted CI aggregator. This
qualification does not certify them.

## Independent evidence and smoke

The host calls `web_phase_ready(result_dir, inventory)` and runs actual production
icon/SVG/trace smoke with a 60-second deadline when Web is ready, even if another
lane failed. Both negative controls must reject. The host owns trace copying,
smoke timing, queue/execution timestamps, image/source identities and final exit
records. After workload and smoke completion, the host executes the immutable source
probe independently for each of the four lane roots. Each invocation revalidates
the manifest digest and streams actual source again; its stdout is stored
exclusively in host-owned evidence, outside the candidate artifact collection.
Candidate reports alone cannot establish these final probes or host cleanup.

After collection and container removal, `validate(result_dir, inventory,
request)` accepts exactly `contract.ARTIFACTS`: regular files only, 50 MiB per file
and 150 MiB total. It verifies all phases/guards and four independent host source proofs, complete
dynamic unit/general
file inventories, all required Electron files, assertion statuses/counts,
coverage identity, exact source/lock/image/harness provenance, dynamic icons and
independently counted trace events. Failed or incomplete evidence cannot qualify.
The host adds verified `containerGone` to the compact authenticated receipt.

GitHub may normalize an Actions source check's requested controller link to its
own check URL. That exact same-repository check URL is an evidence index only:
the verifier independently discovers the newest authenticated controller, then
requires its completed successful job and immutable artifact to bind the exact
controller ID/attempt, requester ID/attempt, source, lease and receipt digest.
A source check or normalized URL alone never establishes qualification.

Focused tests use real Git/process/Python fixtures and complete synthetic evidence
without a host workload. A live ordinary PR and stack canary are still required
before routing is enabled. PRs require `fast-ci` plus current-head `ready-for-ci`;
main pushes select the private backend by default only when the global switch
is enabled. The switch remains disabled during validation.

These checks detect ordinary source mutations and Git metadata hiding. They do
not certify arbitrary hostile test-report honesty or prove which transient bytes
a test executed between guards. Protected review/admission and sandbox isolation
remain the trust boundary; no source is restored or ignored to obtain a pass.

## Queue and hosted recovery

One full workload owns the host at a time. Main priority permits at most two
consecutive admitted main workloads before the oldest waiting PR, without
preempting active work. FIFO order is retained within each class and queue wait
is measured separately, with an 1800-second bound.

Complete hosted recovery requires a recognized authenticated pre-workload
availability result, proved owned cleanup and fresh exact-source/run checks.
The narrow no-grant transport exception accepts only known pinned-endpoint
timeout/refusal before any control bytes, within 20 seconds, followed by fresh
API validation. Unknown or mid-run errors, authentication failures, failed tests
or evidence, stale source, cancellation and uncertain cleanup remain red.
Every required hosted lane and the independent App coverage inventory must pass
for the same source and requesting attempt. A manual diagnostic result or an
older green run cannot satisfy this recovery.
