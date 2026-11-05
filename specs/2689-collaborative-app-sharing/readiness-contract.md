# Collaborative app readiness contract

This companion records the technical meaning of the product label. It is a target contract for implementation planning, not a claim that current owner-built apps already qualify.

## Required pass conditions

| Gate | Observable proof |
| --- | --- |
| App identity | The exact registered manifest, built assets, and version are bound to the organization share. Reusing a slug after deletion does not revive an old share. |
| Participant identity | Matrix supplies the current authenticated actor to the app without sharing another person's session or credentials. |
| Owner-hosted storage | Owner and recipient read and write the same existing app records in the owner's database. No new data space or per-recipient record filter is created. |
| Entry access | Any current member may share an app they own with the organization. Once shared, every current member including guests receives full app use. Active share and current membership are checked on launch, assets, reads, writes, subscriptions, and reconnect. No admin approval, extra app permission, app role, member grant, acceptance step, or record filter exists in V1. |
| Data behavior | Reads, create, update, and delete survive reload; retries are idempotent; concurrent writes report a recoverable conflict or apply an intentional merge. Related writes are atomic. |
| Updates | A confirmed change reaches active organization members through a bounded signal, followed by an authoritative read. Stopping the share or losing membership ends subscriptions. |
| Lifecycle | Readiness is invalidated on incompatible app changes; an unavailable owner runtime produces a clear unavailable state and previously confirmed records return with the host. |
| Connected services | Existing Matrix provider and funding policies continue to apply. App sharing adds no second app permission prompt; provider behavior is outside this V1 collaborative-app contract. |

An app can declare intent in its manifest, but the collaborative label is awarded only after these gates pass against the running Matrix version and an exact app build. The later builder skill should teach this contract and provide a real two-account verification recipe.

## Existing seams and gaps to resolve

- The owner-built app guide uses the injected MatrixOS database bridge and Postgres-backed declared tables. That is the right app-facing starting point.
- The [app instance adapter](../../packages/gateway/src/collaboration/app-instance-adapter.ts) and [resource routes](../../packages/gateway/src/collaboration/resource-routes.ts) already have scope-bound operations, legacy Viewer/Editor checks, operation identifiers, revisions, and an asset route. V1 must expose full app use to every current member including guests, allow any current member to share an app they own, and add no admin approval, permission, role, or individual grant. The [project app adapter](../../packages/gateway/src/collaboration/project-app-adapter.ts) is existing infrastructure, not a required product relationship.
- The current [scoped app bridge](../../packages/gateway/src/collaboration/scoped-app-bridge.ts) queries the registered app schema and table without applying its scope-derived namespace as a row filter. That behavior aligns with the confirmed V1 goal of sharing all existing app records; the unused namespace must not be described as data isolation. The implementation must still limit access to the exact shared app and its declared tables.
- The ordinary [app viewer](../../shell/src/components/AppViewer.tsx) launches in the owner's bridge context. A recipient-facing launch must reach the same app data through the owner's host while retaining the recipient's own identity. A functioning asset route alone does not prove the app UI can run through it.
- The current [collaboration product spec](../124-organization-collaboration/spec.md) forbids new standalone app shares. The requester confirmed a direct app share with no project relationship. The implementation plan must reconcile that policy and its route tests.
- Current collaboration authority is owner-hosted, consistent with the confirmed V1 direction. The share flow must disclose that the app depends on the owner's runtime. Creator departure while sharing is deferred.

## Authorization and test boundary for planning

| Operation | Authentication | Required authority | Public |
| --- | --- | --- | --- |
| Check readiness | Owner Matrix session | Exact app owner | No |
| Create app share | Owner Matrix session | Exact app owner and current membership in selected organization; any org role including guest; no admin approval | No |
| Open app assets and data | Member Matrix session | Active share to the member's current organization | No |
| Write app data | Member Matrix session | Active share to the member's current organization | No |
| Subscribe to updates | Member Matrix session | Active share and current membership, rechecked through session life | No |
| Stop sharing | Owner Matrix session | Exact app owner and current share revision | No |

Route design uses bounded schemas for every parameter and payload, body limits for mutations including DELETE, per-actor rate limits, generic client errors, bounded results and subscriptions, and timeouts for external calls. Related share and app writes are transactional. Real Postgres tests cover owner, current member, guest, new member, departed member, outsider, wrong organization, stopped share, app replacement, retries, concurrent writers, and owner-host restart. Readiness validates the exact build capability contract without creating another identity. A live two-account journey must exercise the actual app bridge and rendered UI on each affected surface using normal authenticated Matrix sessions; current organization membership is the only recipient authorization gate.

The implementation deliverables include a separate public documentation PR in FinnaAI/matrix-os-site. The documentation should explain how builders prepare an app, that existing app data is shared, how access works, and what happens when the owner's host is unavailable.
