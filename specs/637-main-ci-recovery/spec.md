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
