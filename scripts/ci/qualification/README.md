# Immutable Linux qualification

The protected controller supplies a current public PR merge SHA and its ordered
base/head parents. The root lease manager pins the approved image and harness,
checks admission after its host lock, and runs candidate code only as UID10001 in
a bounded disposable container. This directory contains immutable image tools;
source code never selects root commands, Docker resources, or evidence paths.

## Source preparation

Before application code runs, the host invokes:

```sh
python3 -I /opt/matrix-ci/qualification/manifest.py --prepare-public MERGE_SHA BASE_SHA HEAD_SHA
```

The preparer fetches only `HamedMP/matrix-os` into fresh
`/work/manifest-source`, with depth two and a 120-second total Git deadline. Git
plumbing verifies the merge, tree, and exactly two ordered parents; it reads
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

Focused tests use real Git/process/Python fixtures and complete synthetic evidence
without a host workload. A live ordinary PR and stack canary are still required
before label-only routing is enabled.

These checks detect ordinary source mutations and Git metadata hiding. They do
not certify arbitrary hostile test-report honesty or prove which transient bytes
a test executed between guards. Protected review/admission and sandbox isolation
remain the trust boundary; no source is restored or ignored to obtain a pass.
