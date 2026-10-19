# Unified PR previews (ENG-325, child of ENG-240)

A same-repository PR labeled `preview` enters a durable queue. Up to 16 shared
review runtimes may be reserved at once, including existing shared preview
machines. One bot comment per PR shows exact head, author, build/deploy status,
web URL, matching desktop artifacts and their expiry, runtime expiry, and the
other active/waiting PRs and authors. New heads invalidate prior readiness.
Merge/close/removing the label cancels owned jobs and deletes the disposable
runtime before releasing its slot. Every existing test/signing/stability gate
remains; preview readiness is never a replacement for CI Results.

Source authority is a reviewed Main controller on a protected tree-identical
execution ref. PR code never executes in the metadata scheduler. GitHub
Deployments store immutable source-bound reservations; the existing platform
Postgres remains authoritative for actual machines. One serialized scheduler
reconciles fleet, reservations and GitHub jobs before admission. Ambiguous
dispatch/deletion holds capacity rather than double-dispatching/reusing it.

| Boundary | Authority |
|---|---|
| Label/event | GitHub metadata, same repository, fresh PR state/head |
| Scheduler and desktop workflow | reviewed controller/execution origin proof |
| Queue reservation | bot-owned Deployment, exact PR/head/controller and TTL |
| Physical cleanup proof | operator bearer; bounded owner/PR scope; read-only provider proof |
| Fleet read/delete | existing operator bearer; preview classification and slot checked |
| Build/deploy | existing scoped preview workflow and signed desktop workflow |
| Review links | authenticated exact run/attempt/artifact and installed version |

All API calls are bounded; pagination has fail-closed caps. No production
channel promotion, customer-runtime cleanup, or arbitrary external download URL.
TTL remains 72 hours. Queued PRs do not allocate paid machines. Desktop packages
reuse existing signing/notarization and protected Windows restrictions. A new
side-by-side Preview app and native connect UI remain follow-up work: the
comment explains how to install a branch build and select its preview computer.

Platform-changing PRs receive an explicit platform-preview limitation; existing
shared platform staging is not claimed to provide concurrent isolated testing.
Web Canvas/Web Desktop/Electron Desktop/Web Mobile/Native Mobile have no app UI
changes here: this is GitHub orchestration and packaging. Real source-bound
preview evidence is required before activation claims.

## Implementation units (test first)

- U1 (orchestrator): scripts/ci/preview-review*.mjs, preview-review.yml,
  preview-vps.yml, execution-origin.mjs, platform default cap and focused tests.
  Test saturated/fair queue, stale heads, invalid origin/forks, ambiguous dispatch,
  cancellation/close, deletion failure, physical capacity and truthful report.
- U2 (desktop worker): desktop-build.yml, preview-desktop.yml and dedicated tests.
  Add explicit immutable source-ref input without changing existing callers or
  checks; dispatch-only verified wrapper validates reservation before signing.
- U3 (docs worker): docs/dev/unified-pr-preview.md and separate site documentation
  worktree/PR. Explain label, queue, status/expiry, desktop testing, cleanup,
  activation and current platform/native limitations. No app UI changes.

Files do not overlap across units. Shared-directory workers do not stage,
commit or run project tests; orchestrator runs integrated checks and commits.
CI/runtime maintainers should review admission, cancellation and signing scope.

## Completion

Focused behavior/workflow tests, required CI and current-head Greptile 5/5;
source-bound runtime and desktop canary plus merge cleanup before activation.
Advance the reviewed controller pin only after merged Main qualification using
the existing host-first policy. No pin/production activation from this branch.
Public engineer instructions ship as a separate FinnaAI/matrix-os-site PR.

## Large workflow extraction plan

`preview-vps.yml` already exceeds 1,000 lines. New behavior lives in focused
preview-review modules and the separate scheduler/desktop workflows; additions
to the old workflow are bounded source/lease guards only. Extract the existing
provision/deploy shell into a versioned trusted helper with characterization
tests before adding further deploy behavior. Keep its current assertions and
105-minute provisioning/install budget during that extraction.

## Cleanup proof and bounds

The existing operator-authenticated `GET /vps/:machineId/status` adds optional
`previewDeletionConfirmed` only for tombstoned shared preview machines, based
on actual provider absence. The operator-authenticated
`GET /vps/preview-cleanup?owner=<id>&pr=<N>` validates bounded scope and scans
all durable preview identities including tombstones, pending creates and deletion
retries. Only coarse confirmation is returned; missing proof holds capacity. Deploy this platform addition
before enabling the queue. The service composition change delegates to a focused
helper; extract its existing lifecycle methods before adding further behavior.

Source proof reads share one bounded per-reconciliation snapshot. Active comments
refresh each pass; waiting comments rotate within a 24-comment budget, with event
PRs prioritized. Inactive queue metadata is retained seven days, then incrementally
pruned; incomplete inventory holds admission and preserves known cleanup. Legacy
unreserved dispatches drain before queue admission. Adopted runtime expiry never
extends the existing 72-hour reaper deadline. Expiry removes the request label.
