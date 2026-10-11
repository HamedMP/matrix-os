# ENG-258: isolate funded model observations

Issue: https://linear.app/matrix-os/issue/ENG-258/fixai-retain-healthy-glm-results-when-sibling-probes-time-out

## Reproduction and base

The authenticated Platform route uses one `Promise.all` and one deadline for GLM/Sonnet observations. One failed or stalled sibling discards an already successful observation and returns 503. Four route regressions reproduce this on Main `5cd133d` and independently on frozen ENG-205 head `6e61efe3dbe13a95219ac28e0cf9cc62c6aa0d16`.

This small PR stacks on the latter to preserve its reviewed isolated phase binding, cache-only mode, current funding recheck, and default-off activation contract. The original ENG-205 branch is unchanged. The publication coordinator must realign this new PR to the actual published Main and rerun exact-source checks before acceptance.

## Design and invariants

- Extract model-observation aggregation into `ai-funded-route-observations.ts`; do not add another workflow to the route composition file.
- Each model has an independent error/deadline and cancellation controller. Retain settled observations with their original timestamps; failed peers supply no readiness.
- Reserve 1.5 seconds of the existing route budget for the mandatory fresh policy/ledger read. Do not extend the outer timeout or increase probe budgets.
- If all eligible observations fail, return the existing generic unavailable response. Request cancellation still cancels the entire observation. Fulfilled negative health produces an empty receipt.
- Source of truth: current owner/machine/slot binding, effective policy and ledger plus fresh model-specific health. Cache is health evidence, never authorization or paid execution admission.
- Auth/lock scope: existing authenticated endpoint/body limits and repository guards remain unchanged; no new writes, transaction scope, persisted rows or orphan states.
- Cache-only phase handling uses the same selector and cannot fall back to a paid probe. No new defaults, credentials, permissions, credits or resource provisioning.

## Validation and delivery

1. RED/GREEN authenticated route with real isolated PGlite runtime binding and deterministic summary/probe deadlines: GLM/Sonnet partial error and timeout, policy change, exhausted budget, stale health, all stalled and cancellation.
2. Existing cache-only, receipt lifetime, cold-start, probe-budget and Gateway readiness suites; Platform typecheck.
3. Public docs deliverable in `FinnaAI/matrix-os-site/content/docs/`, coordinated with ENG-257: narrow companion [site PR #232](https://github.com/FinnaAI/matrix-os-site/pull/232) covers local-observation and sibling-isolation recovery, complementing existing [#219](https://github.com/FinnaAI/matrix-os-site/pull/219) without changing its frozen head. The companion is prepared and validated, not published.
4. Deferred exact-source publication, Preview VPS and Electron Desktop/Web Desktop/Web Canvas acceptance. PGlite and mocked inference are not real Postgres/provider, user Main or paid settlement acceptance. Greptile, CI and merge remain in the sole publication queue.

Review regression: a delayed final funding read starts at 10.5 seconds and completes at 11.5 seconds within the original 12-second budget. Changing the reserve to 1 millisecond makes this assertion fail; restoring production behavior passes all 10 sibling-isolation cases.
