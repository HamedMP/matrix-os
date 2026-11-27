# Full qualification under ten minutes; lightweight Matrix development

Status: measured investigation and proposed implementation sequence, 2026-10-18.
Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).
Extends [603](../603-ci-fast-hetzner/plan.md), [604](../604-ci-linux-native/spec.md),
[605](../605-priority-linux-ci/spec.md), and [630](../630-ci-check-attribution/plan.md).

## Decision

Optimize two distinct paths: a small, bounded development loop inside the owner's
Matrix project, and complete source-bound qualification on isolated validation
capacity. A developer should not need a running Web Desktop stack, Electron
Desktop build, coverage run, or complete unit suite in every worktree to edit a
function. Full merge qualification still executes all currently required checks.

First expose existing phase timings, reduce the measured test/fixture cost, then
adjust capacity using measured concurrent performance. Avoid another controller
or a replacement CI platform. This PR implements no scheduling, fixture,
qualification, runtime, resource-limit, or deployment changes.

## Measured baseline

Inspection source: `101fbd5f48613db404b6deede191975971f9cd73`.
[Machine-readable measurements](evidence/profile-2026-10-18.json).

| Measurement | Result | Limit |
|---|---|---|
| Complete current-main dedicated qualification | 293 s queue + 729 s workload | One full sample; workload includes preparation, validation, evidence and cleanup |
| Dedicated scope | 55 phases, 14 source guards, four independent host source checks; 2,832 unit files, 30,568 passed / 321 existing skips | Keep exact inventories and existing skip predicates; this is not coverage instrumentation |
| Hosted unit profiles | 2,832 unique files; 6,520 cumulative file-seconds | Overlapping suite intervals, not CPU time or job elapsed time |
| Gateway + platform share | 4,805 / 6,520 file-seconds, approximately 74% | Different runner/backend from the dedicated sample |
| Top 100 files | Approximately 47% of cumulative file time | Top ten account for only approximately 10%; fixing one outlier will not suffice |
| Local two-worker sample | 303 assertions passed in 50.69 s; peak aggregate RSS 5,881 MiB | Five files; direct Vitest invocation after prerequisites; not a full local suite |
| Same routing suite, one worker, fallback | 135/135 passed; 22.03 / 21.94 s; 2,036 / 2,333 MiB client RSS | Two diagnostic samples on an active Mac |
| Same routing suite, native database | 135/135 passed; 16.64 / 19.61 s; 923 / 913 MiB client RSS | PostgreSQL 17.10 locally, 16 in CI; server memory excluded; no Linux speedup claim |
| Web Desktop source development | First page HTTP 200 in 27.38 s; server process tree peaked at 4,977 MiB | Test auth bypass; one page; stopped at 55 s; no gateway/proxy; short warm-build probe overlapped startup |
| Warm test prerequisites | 4.33 s / 880 MiB aggregate RSS | Incremental build with existing output; not a cold-build comparison |
| Frozen offline dependency installation | 56.2 s, zero downloads | Existing global pnpm content store; full workspace link operation |

Sources: [hosted CI 39143979035](https://github.com/HamedMP/matrix-os/actions/runs/39143979035)
at source `2328c6c05fee0858faf457220095a5af4742a537`, and
[dedicated qualification 39146595799](https://github.com/HamedMP/matrix-os/actions/runs/39146595799)
for [main CI 39146593437](https://github.com/HamedMP/matrix-os/actions/runs/39146593437).
The hosted JSON artifacts' hashes are recorded with the evidence. Only the
dedicated receipt is the authenticated qualification result; local measurements
are diagnostic. Sources, backends and hardware differ, so these are not A/B
speed comparisons. Per-test JSON durations include fixture work inside a case.
Hosted reports contain 30,565 passes/324 skips versus the dedicated receipt's
30,568 passes/321 skips, with 30,889 collected cases in each. Do not treat those
backend-dependent outcomes as identity parity; comparison work must explain
the specific differing case statuses and preserve their existing predicates.

### Concrete bottlenecks

- **Queueing:** the measured queue alone consumes almost half the target. The
  host admits one full qualification at a time. At 729 seconds service time its
  theoretical ceiling is about 4.9 qualifications/hour before other overhead.
- **Database-heavy fixtures:** hosted units do not set the native fixture URL;
  native-capable helpers fall back to PGlite. A static import scan found 81
  native-platform-helper consumers representing 1,164 hosted file-seconds.
  That sum includes all test work and is not recoverable time. Dedicated
  qualification already starts native PostgreSQL; enabling it again there is
  not an optimization. Remaining PGlite migration/timer/concurrency contracts
  must retain their intended semantics.
- **Mixed test responsibilities:** `customer-vps-runtime-loader.test.ts` builds
  the gateway inside a unit test: 58.1 s hosted / 22.8 s in the local sample.
  Broad DB hooks also run around pure cases, e.g. path validation in
  `customer-vps.test.ts` and redirect helpers in `proxy-routing.test.ts`.
- **Sequential preparation:** four checkouts each install and build prerequisites
  before the four independent lanes start. Keep independent writable outputs
  and source guards; measure preparation before changing its concurrency.
- **E2E serialization/contention:** general, grid, Electron build and nine Electron
  invocations share a serial lane. Existing evidence in spec 604 also reports a
  Web production build much slower under qualification than alone. More workers
  can make this worse; prove isolation and resource budgets before parallelizing.
- **Orchestration volume:** 200 dedicated-workflow runs over 46 minutes included
  121 `workflow_run` events and 120 titles explicitly recording `execution=false`.
  These include legitimate routing; this is a volume observation, not proof of
  wasted workload execution. The complete main controller logged 156 API
  requests, including 101 conditional hits and 55 charged-200 responses.
- **Missing published diagnostics:** `qualification/validate.py` computes
  `phasesSeconds`; `QualificationHost.receipt()` excludes it, and Actions uploads
  only the compact receipt. Current hosted artifacts cannot establish which
  internal lane owns the 729-second critical path. Obtain retained host timings
  or publish bounded authenticated diagnostics before choosing that optimization.

### Local and Matrix readiness

The inspected Mac has 48 GiB RAM/12 logical CPUs, about 7.8 GiB disk available,
and 18.4 GiB swap already occupied. This is a snapshot, not attribution to Matrix
or evidence of active swapping. Seventy-five registered worktrees exist on disk,
including this investigation; their count does not imply they are all active.
No existing worktree was deleted or reconfigured.

This chat's ambient tools are Node 22.22.3/Bun 1.2.18; profiling explicitly used
the available Node 24.13.1 and pnpm 10.33.4. The development Matrix host reports
8 CPUs/about 15.2 GiB RAM, about 10.2 GiB free at sampling, and Node 26.10.0.
Read-only execution works in its existing project, but that selected directory
has no `package.json` or Vitest installation. It is not a verified Matrix source
checkout. No remote dependency install, full test, deployment, or VM creation
was attempted.

The repository already enables pnpm's global virtual store. The new root
`node_modules` link tree measured 2 MiB, excluding shared-store, package-local,
source and build bytes. Do not add shared writable `node_modules` across source
trees: links may resolve workspace code from the wrong tree. Worktree runtime,
fixture, bundler and browser memory remain separate costs.

## Definition and budget

The target is **p95 <= 600 seconds from an eligible qualification request to
successful required `CI Results`**, including queue, setup, all selected required
hosted checks, dedicated work, attestation and cleanup. Existing reused evidence
must satisfy its exact source/input equivalence rules. Report review-ready to
merge separately: Greptile, peer approval, new commits and integration changes
can add time and cannot be honestly included in a guaranteed ten-minute CI SLO.

| Critical-path budget | Seconds |
|---|---:|
| Admission and queue | 45 |
| Source preparation/install/prerequisites | 60 |
| Longest required validation lane | 390 |
| Evidence, source guards and owned cleanup | 45 |
| Final aggregate propagation | 30 |
| Reserve | 30 |
| Total | 600 |

These are proposed budgets, not achieved durations. Required hosted lanes run
alongside dedicated work and must also finish within the budget. Cold dependency
changes are measured separately but count against the same target; if they
cannot meet it, report the miss rather than quietly excluding them.

## Implementation sequence

### PR 1: publish the critical path and resource costs

Reuse retained `timing-*.tsv`, JSON reports and the host's validated phase map.
Publish a bounded, sanitized diagnostic artifact bound to the request/source,
image/harness and immutable qualification receipt. Diagnostics grant no coverage;
preserve strict qualification parsers and introduce a versioned diagnostic schema
with omission/tampering/wrong-source contracts. Include phase timestamps rather
than only durations where overlap matters, peak cgroup memory, CPU throttling,
tmpfs/disk bytes, and per-file/hook/transform time. Keep raw private paths out.

Add frozen inventory summaries and exact assertion identities/statuses, not just
counts, for comparison runs. Validate a missing/duplicate file or new skip cannot
be hidden by another file's extra assertions. Keep existing skip predicates.
Instrument native/PGlite fixture startup, clone, migration validation, body and
teardown with bounded test-only diagnostics. No production instrumentation needed.

Done: three complete same-source diagnostics identify the actual slowest lane
and memory headroom. This is the prerequisite to claiming phase-specific savings.

### PR 2: remove unnecessary fixture and build work

Prioritize the measured top 100 files. Separate pure cases from DB-owning hooks
without deleting, rewriting or mocking away their assertions. Migrate only
qualified DB-only consumers to existing native fixtures; preserve fresh-schema,
real-clock, multi-connection, migration and failure-recovery contracts. Retain
per-case data/schema/sequence isolation and verified teardown. Extend existing
helper isolation tests first; compare unchanged bodies under both backends.

Measure native fixture services in hosted unit shards, since those currently
use the fallback; include database startup and runner resource costs. Dedicated
already uses that path. Preserve dedicated and hosted qualification parity.

Keep the production gateway loader smoke and real build. Schedule artifact/build
contracts explicitly with independent output directories and all existing source
proofs. Any lane relocation requires reviewed inventory/validator updates and
the same assertions before aggregate success, never after merge. Do not share
live DBs, disable file isolation or weaken test/compiler timeouts.

Done: equivalent assertion identities/statuses and cleanup proofs, measured
runtime/memory reduction, then full unchanged qualification on the final image.

### PR 3: optimize the measured critical lane within fixed resources

Use the existing duration sequencer; compare 8/12/16 unit workers and a small
number of independent unit partitions within the same aggregate CPU/RAM cap.
Splitting may add module initialization and DB templates. Record total resource
cost and slowest-lane time, not just a faster shard. Reserve CPU for production
Web and Electron compilation; compare with unconstrained overlap.

Benchmark parallel per-checkout preparation against sequential preparation.
Retain frozen installs, separate writable outputs, all postinstall/prerequisite
source checks and immutable cache provenance. Consider copy-on-write prepared
bytes only after a lock/toolchain/source audit; do not reuse unverified output.

Only parallelize Electron groups after proving independent display, clipboard,
ports, output and source state. Preserve pristine-source ordering, required flags,
single-worker clipboard behavior and before-release guards. Keep the full suite.

Done: complete workload plus attestation fits its 495-second budget under the
declared hardware cap. If no configuration fits, report the measured floor and
the precise hardware or test-structure change required; do not lower coverage.

### PR 4: reduce queue and controller delay

Build on the existing source/attempt owner and protected-origin checks. Depend
on active [PR #2707](https://github.com/HamedMP/matrix-os/pull/2707) for isolated
requester handoffs; do not duplicate it. Retention/cap handling in
[PR #2592](https://github.com/HamedMP/matrix-os/pull/2592) remains separate.

Coalesce redundant events for one source/request/attempt before allocating
workload capacity. Filter proven no-op events using trusted metadata without
executing PR code. Preserve retry identity, current-controller fencing and
ambiguous-dispatch suppression. Read-only conditional polling is already present;
reduce duplicate controllers before tuning another polling loop.

Size isolated execution slots from measured arrival rate and service time.
One 12-minute slot cannot meet a 45-second queue budget at normal multi-PR load.
Benchmark two simultaneous independently bounded slots on appropriately sized
capacity; do not put two 30-CPU/112-GiB jobs on the existing single-slot host.
Keep main fairness, cancellation, authenticated fallback and fail-closed cleanup.
Queue overload is a recorded SLO miss; changing its deadline is not a speedup.

Done: representative concurrent PR/main traffic meets the queue budget without
stale-source success, orphan workloads, credential leakage or worse tail latency.

### PR 5: make Matrix development resource-bounded

Bootstrap a real repository/worktree in the existing Matrix project using pinned
Node/Bun/pnpm and the frozen lockfile. Fail preflight on missing prerequisites,
insufficient disk, unsupported tool versions or unsafe runtime context. Keep
source development separate from the installed OS and owner production data.

Provide two developer commands (names to finalize during implementation):

- `test:focus`: explicit files or a dependency-aware suggested list, small worker
  count, package prerequisites only when their inputs changed, explicit result
  source/patch identity. No running gateway/proxy/Web Desktop required for units.
  Unknown dependencies broaden the suggestion; focused success is never merge
  qualification. Accept uncommitted source for feedback only, not a CI receipt.
- `qualify`: submit a committed exact source to the existing protected validation
  service and stream its logs/status/evidence. Full qualification executes on
  isolated validation capacity, not inside an unbounded interactive terminal or
  the owner's primary OS service process. Reuse the result only when current
  provenance/input rules prove it applies; fresh commits invalidate it.

Enforce one machine-wide CPU/RAM budget across worktrees/agents. The existing
two-workers-per-Vitest-process default does not bound two workers in each of
several concurrent processes. Start with one focused test slot per development
machine; choose slot memory from profiling plus OS/agent headroom. Queue or
offload additional work. Set a measured default after Linux native-fixture tests;
the local 5.7-GiB sample cannot justify a 2-GiB hard cap for the unchanged batch.

Keep idle source worktrees without bundlers/watchers. Start an affected renderer
or gateway only when needed, with leased unique ports, isolated fixtures and
per-worktree output. Stop idle runtimes via bounded leases while preserving files
and terminal recovery. Reuse immutable dependency bytes, never another worktree's
writable build outputs. Full production-like acceptance still uses preview VPS
host bundles; development containers are not customer deployment artifacts.

Done: demonstrate three simultaneous editable worktrees, bounded focused tests,
one on-demand preview, and full remote qualification while the Matrix OS UI and
active Chat remain responsive. Record p95 command feedback, machine memory,
throttling and cleanup. No OOM or swap-driven throughput collapse is acceptable.

The proposed adapter adds no public route in this plan. Before endpoint work,
specify the auth matrix and owner/project authorization, bounded source/artifact
inputs, tenant isolation, rate/queue limits, timeouts, cancellation and shutdown
drains. Developer credentials cannot become qualification authority; candidate
code receives no controller/host/production credentials. Reuse Kysely/Postgres
for any durable job state and existing authenticated Matrix transports.

## Acceptance and rollout

1. Record RED then GREEN contracts for each implementation PR. Preserve every
   existing selected check, test identity/assertion/status, skip predicate,
   compiler/project scope, production-build flag, source guard and cleanup proof.
   Preserve coverage requirements and native PostgreSQL race/root gates.
2. Run exact-source baseline/candidate comparisons with identical lock/toolchain,
   image, worker/resource budgets and fixture settings. Include cold and warm
   preparation, failures, cancellations and infrastructure fallback. Do not
   infer speedup from the Mac diagnostic or compare unrelated green PRs.
3. Shadow before changing routing/required checks. Qualify at least 30 complete
   representative requests across at least three days, including concurrent
   PR/main traffic and changed-lock cold paths; publish raw observations and
   observed p50/p95. This is an initial acceptance sample, not a strong tail
   guarantee. Add continued monitoring and a longer baseline before increasing
   traffic. Require p95 <= 600 s including queue and all required aggregate work.
4. Test missing/wrong/stale evidence, controller supersession, genuine failing
   assertions, mid-run disconnect, cancellation, capacity exhaustion and cleanup
   failure. Every case preserves a red/nonqualified outcome when appropriate.
5. Require current-head Greptile 5/5, peer approval and current required CI. Keep
   full main integration checks; independent green PRs do not prove their merge.
   Reuse proven existing review carryover; never synthesize success to save time.
6. Deliver a separate `FinnaAI/matrix-os-site` documentation PR updating testing,
   Matrix development, resource budgets, qualification and troubleshooting under
   `content/docs/`. Reconcile the existing handbook PR #224 before duplicating it.
   Recommend review by the CI/runtime owner; no production rollout is authorized
   by this plan. No new paid machine or fleet change is made by this investigation.

## Investigation validation and limits

Local probes used explicit file filters after shared prerequisites: 303 cases
passed, plus four unchanged 135-case routing runs. The Web Desktop diagnostic
returned HTTP 200 and its owned server was stopped at the measurement deadline.
The disposable database was stopped/deleted; the owned Next cache was removed
and its generated tracked declaration change restored. No other worktree,
application process, Matrix runtime or deployment was changed.

The full local unit/coverage/SDK/live-provider suite and full local application
bundle were deliberately not launched on the disk-constrained, already-swapped
Mac. The complete source-bound CI run supplies the full-suite baseline. Dedicated
per-phase timings, peak cgroup memory and controlled Linux before/after results
remain unknown; PR 1 resolves that gap before promising a ten-minute result.
