# Collaborative app readiness contract

This companion records the technical meaning of the product label. It is a target contract for implementation planning, not a claim that current owner-built apps already qualify.

## Required pass conditions

| Gate | Observable proof |
| --- | --- |
| App identity | The exact registered manifest, built assets, and version are bound to the instance. Reusing a slug after deletion does not revive a grant. |
| Participant identity | Matrix supplies the current authenticated actor and effective role to the app without sharing another person's session or credentials. |
| Shared storage | Owner and recipient read and write one instance-specific data space. It is disjoint from personal data and every other instance, including another organization using the same app. |
| Authority | Current organization membership and the app grant are checked on launch, assets, reads, writes, subscriptions, and reconnect. Viewer writes fail at the service boundary. |
| Data behavior | Reads, create, update, and delete survive reload; retries are idempotent; concurrent writes report a recoverable conflict or apply an intentional merge. Related writes are atomic. |
| Updates | A confirmed change reaches active authorized viewers through a bounded signal, followed by an authoritative read. Revocation ends subscriptions. |
| Lifecycle | Readiness is invalidated on incompatible app changes; the instance survives creator departure under organization stewardship; export and retirement are available to an authorized steward. |
| Capabilities | Provider integrations and AI actions require separate explicit authority and funding. App sharing never inherits the creator's personal connections. |

An app can declare intent in its manifest, but the collaborative label is awarded only after these gates pass against the running Matrix version and an exact app build. The later builder skill should teach this contract and provide a real two-account verification recipe.

## Existing seams and gaps to resolve

- The owner-built app guide uses the injected MatrixOS database bridge and Postgres-backed declared tables. That is the right app-facing starting point.
- The [app instance adapter](../../packages/gateway/src/collaboration/app-instance-adapter.ts) and [resource routes](../../packages/gateway/src/collaboration/resource-routes.ts) already have scope-bound operations, Viewer/Editor checks, operation identifiers, revisions, and an asset route. The [project app adapter](../../packages/gateway/src/collaboration/project-app-adapter.ts) derives a namespace from the scope and app.
- The current [scoped app bridge](../../packages/gateway/src/collaboration/scoped-app-bridge.ts) constructs SQL against the registered app schema and table but does not include the scope-derived namespace in its table choice or row predicate. A namespace in the bridge request alone does not prove row isolation. The implementation must add a real isolation boundary and prove it with two organizations, a personal instance, and adversarial read/write attempts before any app is labeled ready.
- The ordinary [app viewer](../../shell/src/components/AppViewer.tsx) launches in a personal bridge context. A recipient-facing shared launch must inject a distinct, authorized bridge so owner and recipient reach the same instance. A functioning asset route alone does not prove the app UI can run through it.
- The current [collaboration product spec](../124-organization-collaboration/spec.md) forbids new standalone app shares. This proposal explicitly revisits that decision for eligible collaborative apps; the implementation plan must reconcile the policy and its route tests.
- Current collaboration authority is owner-hosted, whereas the proposed instance is organization-owned. Planning must choose and verify a durable organization data location or explicit transfer before creator departure can be claimed to work.

## Authorization and test boundary for planning

| Operation | Authentication | Required authority | Public |
| --- | --- | --- | --- |
| Check readiness | Owner Matrix session | Exact app owner | No |
| Create app instance/share | Owner Matrix session | App owner and current organization membership | No |
| Open app assets and data | Participant Matrix session | Current membership and effective grant for exact instance | No |
| Write app data | Participant Matrix session | Current membership and Editor grant | No |
| Subscribe to updates | Participant Matrix session | Current membership and grant, rechecked through session life | No |
| Change or revoke grants | Share-manager Matrix session | Exact instance manager and current scope revision | No |
| Export or retire data | Steward Matrix session | Organization stewardship authority for exact instance | No |

Before implementation, route design must add bounded schemas for every parameter and payload, body limits for mutations including DELETE, generic client errors, bounded results and subscriptions, and timeouts for any external calls. Grant and instance writes that form one action must be transactional. Real Postgres tests must cover owner, Editor, Viewer, revoked member, wrong organization, app replacement, retries, concurrent writers, and owner departure. A live two-account journey must exercise the actual app bridge and rendered UI on each affected surface.

The implementation deliverables include a separate public documentation PR in FinnaAI/matrix-os-site. The documentation should explain how builders prepare an app, what data is shared, how roles work, and how an organization recovers or retires an instance.
