# App sharing recovery qualification

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os).

## Goal

An organization member can recover an uncertain save without duplicating it or
being told that a rejected save succeeded. Closing a transport ends its ability
to start requests. Owner data and current membership remain authoritative.

## Reproduced faults and corrections

- A malformed mutation acknowledgement from the direct client was treated as a
  definite failure. Keep the original request ID and payload for safe replay,
  just as for an interrupted response. Queries still reject malformed replies.
- A denied queued mutation was forgotten if another mutation remained uncertain
  across retries. Retain the definite failure until recovery finishes; surface
  it even if a later replay succeeds.
- Repeated Retry clicks could consume a denial in an older callback and report
  success in the latest callback. Share one in-flight recovery result. Access
  ending takes precedence over a recoverable conflict in either failure order.
- A closed transport could start new launches, reads, mutations, retries, and
  subscriptions. Reject them locally and make close idempotent. Closing does
  not cancel or roll back a mutation already sent to the owner.

No endpoints, auth rules, database schema, or app roles change. Existing strict
schemas, bounded pending queues, owner revision CAS/idempotency, and direct
client timeouts remain in force. The shared TypeScript transport serves Web
Canvas, Web Desktop, and Web Mobile. Electron has a separate main-process embed
path and needs independent qualification. Native Mobile remains unqualified for
V1; its N/A requires reviewer approval.

## Acceptance

| Scenario | Observable result | Verification |
| --- | --- | --- |
| Owner commits but member receives invalid JSON | Retry carries the identical request ID/payload and returns the saved receipt, with one logical commit | Transport fault injection; live member save/replay |
| First queued save is denied; second needs two retries | Second save reconciles; recovery still reports the first denial | Transport regression |
| Member clicks Retry twice during a delayed replay | One replay per original ID; both callers receive the same failure; denial wins over conflict | Concurrent transport regression |
| Closed transport receives delayed callbacks | No new outbound launch/read/write/retry/subscription; close runs once | Lifecycle regression |
| Different platform worker serves HTML/module | Same valid launch and exact build recover from Postgres | Independent real-Postgres worker suite |
| Owner/member read, write, reload, conflict and revoke | Same confirmed records; stale writer rejected; ended membership fails closed | Owner-home suites plus live two-account journey |

Product, collaboration, and runtime owner review is recommended. The regression
tests establish transport behavior; synthetic responses are not live acceptance.

## Live release checklist

1. Record exact deployed platform revision, owner host bundle, and client build.
   PR #3330 is merged; merge alone does not prove its routing table is deployed.
2. Use a disposable tracker and two real accounts in the same test organization.
   Seed 20 owner records. Open the app's Share action, run readiness, select the
   test organization, and confirm sharing. Do not use private customer records.
3. On the member account, open the launcher, find the app with its people badge,
   and verify all 20 rows. Create, edit, and delete test rows from both accounts;
   verify updates and reload on both. Do not look under Chat's Shared with me.
4. Exercise different platform workers, lazy modules, concurrent edits, lost
   acknowledgements, owner offline/recovery, membership removal, and stop-share.
   Retain unsaved input and owner records. Never retry by creating a new mutation.
5. Repeat applicable journeys on Web Canvas, Web Desktop, Electron Desktop, and
   Web Mobile. Record each surface separately with screenshots and recording.
6. Attach evidence outside git, link it in the PR and Slack #tech, and link the
   Slack permalink back. Missing second-account/runtime access blocks release
   qualification; automated pass counts do not replace it.

Public documentation: update the existing companion
[site PR #357](https://github.com/FinnaAI/matrix-os-site/pull/357) in
`FinnaAI/matrix-os-site/content/docs/` after live recovery behavior is qualified.

## Rollout and monitoring

Publish the reviewed host bundle for web clients and release the reviewed
Electron build for its applicable shared package consumers. Verify the platform
routing migration independently. Use a scoped disposable test runtime before
any wider rollout. Monitor `[shared-app] request unavailable` and failed
collaboration app action/replay requests during the owner/member acceptance run.
Healthy behavior is one logical mutation per request ID and a truthful recovery
outcome. Any duplicate write, false success, or access after revocation blocks
rollout and requires rollback of the affected build. No owner data cleanup or
schema rollback is part of this transport-only change.
