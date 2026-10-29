# Main CI recovery — 28 October 2026

Ticket: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit).
Baseline: `0e217b98fb3f20d38710ff0fa5c305ac3e70c67a` (#2950).

## Goal and scope

Restore the failed onboarding shortcut regression and qualify the exact published Codex 0.165.0 provider contracts. Keep existing product behavior, unknown-version rejection, installer pins, native editing defaults, and release gates. No merge, deployment, customer configuration changes, or paid inference is part of this repair.

## Failure map

| Check | Evidence and cause | Treatment |
| --- | --- | --- |
| [Unit Tests 3/4](https://github.com/HamedMP/matrix-os/actions/runs/40663530702/job/122732429950) | Only failed assertion: background shortcut listener called twice while setup visible; 9,513 assertions passed. The setup DOM commits before its passive effect installs the capture listener. | Register and remove keyboard isolation during the layout commit. Exercise the first observable DOM commit, active typing and completion cleanup. |
| [Codex Provider Contracts](https://github.com/HamedMP/matrix-os/actions/runs/40663530717) | Published latest is 0.165.0; both compatibility manifests stop at 0.164.0. The unknown-version guard correctly rejects it. | Retain and review exact official exec/app-server bytes and complete delta; admit only that exact release. See [qualification evidence](../532-codex-0157-contract-qualification/evidence/qualification-01650.md). |
| CI Results / CI Source Qualification / Same-SHA host release gate | Depend on failed same-source unit qualification. | Preserve gate behavior; do not bypass or rewrite historical results. |
| [Docker initial build](https://github.com/HamedMP/matrix-os/actions/runs/40663530863/job/122732374478) | Hermes installer download received HTTP 429 from raw.githubusercontent.com through existing bounded retries. | Same-source [replacement build](https://github.com/HamedMP/matrix-os/actions/runs/40666424820/job/122742138842) passed. Its smoke status is a push-coverage placeholder with scenario steps skipped; fresh-install and upgrade scenarios subsequently passed; the remaining queued/running scenarios are not acceptance. |
| [Dependabot security update](https://github.com/HamedMP/matrix-os/actions/runs/40663631833) | Group spans independent manifests; updater reports workspace-subdirectory updates unsupported, shell workspace brand missing, and deepmerge 4.3.1 has no available security fix. | Separate dependency/security maintenance. Existing source workspace contains brand and locked root install passes; do not replace workspace links or suppress the updater to force green. |

## Keyboard isolation contract

`GetStartedGate` must install its window capture listener in the same layout commit that displays the wizard, and remove it when the wizard is hidden or unmounted. Cmd/Ctrl/Alt events stop before background bubble handlers. Plain keys, Tab and Enter retain propagation. The listener does not prevent the native default action, preserving copy and paste. Shared component ownership covers Web Desktop, Web Canvas and Electron Desktop; a fixture alone does not qualify every full surface. Web Mobile/Native Mobile do not mount this wizard under spec 635.

Wrong: register the modal keyboard barrier in a passive `useEffect`, leaving committed UI briefly unprotected. Correct: `useLayoutEffect` installs/removes the barrier before the committed UI is observable. A deterministic MutationObserver test sends a modifier event at that boundary; a DOM query followed by an eventual assertion cannot prove there was no gap.

## Acceptance and review

- The first-commit regression fails on the previous implementation and passes after the fix; completion/unmount restores background shortcuts.
- Existing wizard journey assertions remain; native defaults are never cancelled.
- Exact Codex native artifacts and required semantic payloads pass the existing verifier; changed bytes and unknown versions remain rejected.
- Focused tests, type checking, pattern scan and new-head CI are reported separately. Full runtime surface evidence remains a review requirement if not available locally.
- Greptile and human review gates remain in place. No Main green claim before merge and same-source verification.

## Local evidence

- Deterministic DOM boundary controls: activation and teardown both fail when only the barrier is reverted to a passive effect; both pass with the layout effect. Existing gate/connect journeys pass (39 assertions).
- Chrome 156.0.8078.49 renders the real shared component through fixture ports: the first committed wizard suppresses modifier shortcuts, typed name persists, no event default is prevented, and skipping immediately restores the background shortcut. Reverting only the barrier to `useEffect` reproduces three leaked calls in that browser.
- The Chrome fixture has no real gateway, authentication, or native Electron presentation. It proves this shared component's event boundary, not independent Web Desktop/Web Canvas/Electron Desktop runtime acceptance. Full surface evidence remains required for merge review. Captures and raw logs are stored outside Git.

- Independent review found no actionable defects; its separate focused run passed 64 assertions. Root typecheck passed and pattern scan reported zero violations (five pre-existing warnings). Full suite and remote checks are tracked separately in the PR.

## Data, authority and rollback

No endpoints, credentials, database writes, or durable data changes. Keyboard ownership is component-local and cleaned up at layout teardown. Contract manifests and retained official fixture bytes are the compatibility source of truth. No acceptable persistent orphan states are introduced. Revert the fix commits to roll back. Public documentation does not change: this restores existing shortcut behavior and adds no user capability or setup step.

## Post-merge checkout recovery — 29 October 2026

### 1. Scope / trigger

PR #2960 merged as `76c16f3428cd336efd0d69d81343c5c8c3af8690`. Its [main CI](https://github.com/HamedMP/matrix-os/actions/runs/40733797588/attempts/1) failed before testing in `Detect CI-relevant changes`: three full-history fetch attempts each ended at precisely 30 seconds with `early EOF`. The timeout interrupts Git before it can finish its pack, and a fresh attempt cannot reuse an incomplete pack. The same failure had occurred on the PR before a successful rerun. Treating repeated checkout timeouts only as transient does not repair the undersized transfer path.

The predecessor #2961 failed the original onboarding assertion; this is a separate historical failure. Codex Provider Contracts and Docker Tests passed on the merged source. `CI Results`, `CI Source Qualification`, and the host-release same-SHA gate reflect the checkout failure. Keep release gates closed until source qualification succeeds.

### 2. Signatures

The `changes` job's inline `Checkout with bounded retry` shell is the bootstrap entrypoint: checkout-owned helpers cannot run until it succeeds. It accepts `SOURCE_SHA`, falling back to `GITHUB_SHA`, and uses the existing repository/server/token context. Subsequent classification remains `node scripts/ci/dedicated-changes.mjs`; main coverage remains `git merge-base --is-ancestor` and `git diff --name-only --no-renames` through existing helpers.

### 3. Contracts

Retain the complete commit and tree graph for successful-coverage frontier selection; omit unrelated blobs from the initial transfer and materialize only the `scripts/ci` bootstrap subtree. Fetch and lazy materialization must both stay inside the bounded, authenticated attempt. Never persist the token in local Git configuration. Checkout must detach at the exact requested SHA, never a moving branch tip. Each complete attempt has a 120-second deadline and five-second kill grace, with three attempts and five/ten-second backoff. The job budget is 12 minutes, including the existing 180-second classifier bound and setup/API/artifact margin. Timeout must signal the complete child process group so a fetch cannot survive into the next attempt.

### 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Valid source and available remote | Exact SHA materialized; complete ancestor/path classification remains possible. |
| Timeout or failed transport | Retry within the bound, then fail the job; no alternate source or success output. |
| Checkout fails before helpers exist | Skip helper-based receipt cleanup; retain the original checkout failure. |
| Receipt creation or upload fails after checkout | Run cleanup despite the later failure to remove a partial receipt. |
| Coverage frontier predates several failed runs | Compare cumulative paths against that successful ancestor; never use shallow-history absence as proof of safety. |

### 5. Good / base / bad cases

Good: the classifier reads all accumulated changed paths while historical large blobs and unrelated current artifacts stay unmaterialized. Base: main and PR classification retain the same source decisions. Bad: a stalled transport exhausts the attempts and fails closed. No tests, coverage decisions, or same-SHA release gates are disabled to obtain green checks.

### 6. Required tests

Execute the actual workflow shell against a real filter-enabled Git remote. Assert exact HEAD, complete history, older-frontier ancestry, cumulative changed paths, required bootstrap files and omitted unrelated blobs. Exercise bounded failure/retry and cleanup conditions. Exercise the actual PR classifier without rename similarity detection: `--no-renames` preserves changed add/delete paths without lazily downloading historical blobs. Prove a timed-out child process cannot survive the retry. Run existing main coverage and PR classifier contracts. Report a same-source rerun separately from validation of the repaired workflow on a new PR head.

### 7. Wrong versus correct

Wrong: repeatedly fetch every historical blob into an empty repository under a 30-second deadline, or switch main to shallow history and lose the successful-coverage frontier. Correct: keep the complete graph, reduce blob transfer/materialization, give each whole attempt a realistic finite budget, and preserve failure propagation.

This is internal CI transport repair. It introduces no customer capability or documentation flow, and no deployment or merge is authorized by this follow-up. The public site requires no content change.

### Repair verification

The six checkout regressions pass after failing controls on the previous workflow, the rename-detecting PR classifier, and the foreground-only timeout. Independent review passed 364 assertions across nine focused suites and found no remaining in-scope defects. Typecheck and pattern scan passed (zero violations, five existing warnings). Repository-wide shell lint independently reproduces the same 50 errors and 95 warnings on the previous PR head and is outside this CI transport diff.

A fresh actual GitHub checkout of main `76c16f3428cd336efd0d69d81343c5c8c3af8690` using the repaired shell completed on its first attempt in 3.229 seconds. It retained 2,750 commits, was nonshallow, stored 8.90 MiB of Git packs, and did not materialize the root package or unrelated current files. This is one local observation, not a hosted-run performance guarantee. The actual main classifier then selected successful ancestor `35952691dcd32bb91f8708c38bff128a0c41bb32`, with `bootstrap=false` and source/docs/parity coverage enabled. New-head hosted CI is a separate acceptance track.
