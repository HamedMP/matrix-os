# Bound funded readiness through slow successful inference

[ENG-205](https://linear.app/matrix-os/issue/ENG-205/matrix-ai-is-unavailable)

## Outcome

A successful GLM Flash generation can take 21.4 seconds while the upstream readiness probe currently aborts at eight seconds. Give that probe 25 seconds and retain ordered, bounded outer deadlines (Relay 27s, Platform 29s, gateway request/observation 30/31s, renderer 32s). Requests outside those bounds remain unavailable. Do not retry, extend policy freshness, alter prices, grant credit or infer readiness from local configuration.

## Existing authentication and wiring

No endpoint or auth change. Relay `/ready` requires the existing control credential; runtime funding/readiness requires the owner runtime token and epoch; gateway Settings/Chat reads keep their existing auth. Shared `FUNDED_AI_READINESS_TIMEOUTS` drives each existing boundary. Credential/funding request deadlines, Jev budgets, paid generation bounds, admission and exact settlement remain unchanged.

## Acceptance and rollout

- Regression: a valid response at 21.4s stays pending past 8s and succeeds once; a stalled request aborts at 25s.
- Gateway shared observations terminate at 31s; a later read can recover and a late response cannot restore revoked readiness.
- Canonical V3 and Settings share the original 31s native observation deadline; explicit shorter caller budgets and queue time still count. Native discovery stays capped at 6.5s, Hermes renewal at 6.5s and Pi/OpenCode renewal at 1s within that deadline. Fresh metadata receives only its existing five-second lifetime; cancellation, revoked credentials and late completions never restore expired proof.
- Shared PostgreSQL probe leases cover the Relay deadline plus three bounded1.5s DB phases (31.5s total), so a second replica cannot repeat a still-running slow paid probe. Cache namespace includes timeout/lease configuration; historical short-budget receipts are not reused. Caller deadlines/cancellation and policy reads remain independent.
- Existing expired/future/missing policy and funding, stale receipts and renderer cancellation checks continue passing.
- Release together through reviewed Relay, Platform, runtime and Electron artifacts. Older clients retain a 15s deadline until updated; warm cached reads may succeed but do not establish cold-read compatibility.
- UI behavior uses shared contracts for Web Canvas, Web Desktop, Electron Desktop and applicable mobile surfaces. No layout or copy changes. Capture live slow-read validation on a reviewed test runtime before production rollout.
- Documentation deliverable: separate PR in `FinnaAI/matrix-os-site` describing bounded refresh behavior if public guidance needs updating.

Suggest affected users review slow-refresh behavior before rollout; wait if they make this an approval gate. Settings mount-time snapshot refresh and additional models are deferred to their own changes. Production deployment is not a diagnostic shortcut.
