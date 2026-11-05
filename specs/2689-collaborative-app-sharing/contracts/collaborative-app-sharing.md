# Collaborative App Sharing Contracts

This contract defines the additive V1 interfaces. Concrete schemas live in `@matrix-os/contracts` and use strict bounded Zod 4 definitions. Existing direct-session signing, owner-runtime relay, app-resource routes, and event transport remain the underlying protocol.

## Contract principles

1. The exact app registration and build are explicit in every readiness, share, launch, data, and event response.
2. The server authorizes `active share + current organization membership` at every boundary. Any current member may share an app they own, and every current member including a guest receives full app use. UI discovery and a launch ID are never authority.
3. Recipients have full declared app functionality. No admin approval, app permission system, app role, invitation, acceptance, grant activation, or record filter appears in V1 contracts.
4. Owner and recipient use the creator's existing app schema through one collaboration-aware mutation coordinator.
5. Client errors are closed safe codes and copy. Provider names, raw errors, database details, owner paths, tokens, and membership assertions never cross the boundary.
6. Mutations have body limits, per-action schemas, stable request IDs, payload hashes, and revision predicates.

## Core wire types

```ts
type CollaborativeAppBuildRef = {
  appId: string;
  catalogId: string;
  registrationIncarnation: string;
  manifestVersion: string;
  buildId: string;
  bridgeContractVersion: string;
};

type CollaborativeAppReadiness = {
  readinessId: string;
  build: CollaborativeAppBuildRef;
  status: "checking" | "ready" | "blocked" | "stale" | "failed";
  revision: string;
  checks: Array<{
    code:
      | "declaration" | "exact_build" | "owner_postgres" | "recipient_launch"
      | "participant_identity" | "two_principal_round_trip" | "idempotent_retry"
      | "conflict_write" | "change_signal" | "provider_safety" | "cleanup";
    status: "passed" | "blocked" | "failed";
    action?: string;
  }>;
  verifiedAt?: string;
  invalidatedAt?: string;
};

type CollaborativeAppShare = {
  scopeId: string;
  organizationId: string;
  owner: { actorId: string; displayName: string };
  build: CollaborativeAppBuildRef;
  readinessId: string;
  state: "active" | "needs_recheck" | "stopped";
  shareRevision: string;
  dataRevision: string;
  createdAt: string;
  updatedAt: string;
};

type AppLaunchTarget =
  | { kind: "owner"; slug: string; registrationIncarnation?: string }
  | {
      kind: "shared";
      scopeId: string;
      organizationId: string;
      appId: string;
      catalogId: string;
      buildId: string;
      name: string;
      iconUrl?: string;
      owner: { actorId: string; displayName: string };
      shareRevision: string;
    };

type SharedAppParticipant = {
  actorId: string;
  displayName: string;
  organizationId: string;
  scopeId: string;
  shareRevision: string;
  buildId: string;
};
```

Shared windows/tabs deduplicate by `scopeId + catalogId + buildId`, never by slug. Participant context is display/attribution context only. Readiness responses never include probe credentials, records, owner paths, SQL/provider errors, or raw app output.

## Owner readiness and share routes

### `GET /api/collaboration/apps/:appId/readiness`

- Authentication: owner Matrix session.
- Authority: exact registered app owner.
- Result: `CollaborativeAppReadiness | null` for the current exact build.
- Cache: `private, no-store`.

### `POST /api/collaboration/apps/:appId/readiness/check`

Request:

```ts
{
  clientRequestId: string;
  expectedRegistrationIncarnation: string;
  organizationId: string;
}
```

- Authentication: owner Matrix session.
- Authority: exact app owner and current organization membership.
- Body limit: collaboration JSON limit before buffering.
- Behavior: capture the immutable build and invoke the bounded two-principal production-path verifier. Until the second-principal source and authorization lifecycle are approved, persist a safe blocked result and never issue a ready certificate. Once configured, clean all tagged probe data after verification.
- Idempotency: same request ID and payload replays the readiness result.
- Result: `202` while checking or `200` for a completed replay.

### `GET /api/collaboration/apps/:appId/share`

- Authentication: owner Matrix session.
- Authority: exact app owner.
- Result: active/needs-recheck share for the exact registration, or `null`.

### `POST /api/collaboration/apps/:appId/share/preflight`

Request:

```ts
{
  organizationId: string;
  expectedReadinessRevision: string;
  expectedBuildId: string;
}
```

Successful response:

```ts
{
  eligible: true;
  catalogId: string;
  resourceRevision: string;
  readinessId: string;
  buildId: string;
  confirmationToken: string;
  existingShare?: CollaborativeAppShare;
}
```

Blocked responses use `eligible: false` with a bounded reason: `not_ready`, `readiness_stale`, `organization_mismatch`, `already_shared`, or `unavailable`. The short-lived signed confirmation binds owner, organization, catalog, incarnation, readiness, build, and revisions.

### `POST /api/collaboration/apps/:appId/share`

Request:

```ts
{
  organizationId: string;
  clientRequestId: string;
  expectedResourceRevision: string;
  expectedReadinessRevision: string;
  readinessId: string;
  buildId: string;
  confirmationToken: string;
}
```

- Authentication: owner Matrix session.
- Authority: app owner and current member of the selected organization; no organization-admin approval is required.
- Transaction: scope, exact-build binding, owner invariant row, operation, audit, event, and directory outbox commit together.
- Result: `201 CollaborativeAppShare`, or `200` for an exact replay.
- No project, role, invite, member, record-filter, or acceptance field is accepted.

### `DELETE /api/collaboration/apps/:appId/share`

Request body (DELETE still receives the mutating body limit):

```ts
{
  clientRequestId: string;
  expectedShareRevision: string;
  expectedBindingRevision: string;
}
```

- Authentication: owner Matrix session.
- Authority: exact app owner and active binding.
- Transaction: CAS stop, auth-epoch bump, operation, audit, event, and directory outbox commit together.
- After commit: revoke scope launch/direct sessions and close subscriptions.
- Result: stopped projection. Owner app records are untouched.

## Recipient discovery and launch routes

### `GET /api/collaboration/shared-apps?cursor=&limit=`

- Authentication: platform Matrix session.
- Authority: current membership in each returned organization.
- Response: bounded cursor page of active app share metadata.
- New current members, including guests, appear without an activation, permission, or per-user row.
- Departed members, wrong-organization users, outsiders, stopped shares, and stale/unready builds are omitted.

The existing `Shared with me` aggregate may include this projection, but an app item is always typed as `app`; it never falls through to Chat/project rendering.

### `POST /api/collaboration/shared-apps/:scopeId/launch`

Request:

```ts
{ clientRequestId: string; expectedShareRevision: string; expectedBuildId: string }
```

- Authentication: platform Matrix session.
- Authority: active share, current organization membership, exact ready build, reachable owner runtime.
- Behavior: obtain a proof-key-bound owner direct session and create a short-lived same-origin launch facade.
- Response:

```ts
{
  target: AppLaunchTarget & { kind: "shared" };
  launchId: string;
  entryUrl: string;
  expiresAt: string;
}
```

The entry URL is same-origin and path-bound; it contains no bearer credential. A launch ID is not sufficient without the current platform session.

### `GET /api/collaboration/shared-apps/:scopeId/runtime/:launchId/:assetPath{.*}`

- Authentication: current platform session on every request.
- Authority: launch actor, active exact share, current membership, matching auth epoch/build, and live owner runtime.
- Upstream: signed owner direct session; no browser-visible owner credential.
- Response: immutable build bytes only, private/no-store bootstrap, strict content type, `nosniff`, bounded stream, lease/watchdog, and cancellation on revocation or overrun.
- Asset paths are normalized and confined to the immutable build root; redirects are rejected.

The bootstrap injects only safe participant context and a parent-mediated restricted data bridge. Database calls do not originate as unsigned iframe subresource requests.

## Owner-hosted app resource routes

The existing signed direct-session routes remain the owner-runtime interface:

- `GET /api/collaboration/scopes/:scopeId/apps/:appId`
- `POST /api/collaboration/scopes/:scopeId/apps/:appId/view`
- `GET /api/collaboration/scopes/:scopeId/apps/:appId/assets/:assetPath`
- `POST /api/collaboration/scopes/:scopeId/apps/:appId/actions`
- `GET|WS /api/collaboration/scopes/:scopeId/events`

Required behavior:

- Verify active binding, registration incarnation, ready build, share auth epoch, and current membership on every operation.
- Serve assets from the immutable qualified build, not mutable live `dist` bytes.
- Map all current members to full app read/write functionality; legacy/project Viewer/Editor behavior stays separate.
- Route owner mutations for an actively shared app through the same coordinator.
- Reauthorize subscription open, resume, broadcast, and reconnect.
- Bound reads by declared tables, filter/order/page schemas, and result bytes. The scope namespace is not a row filter.

Mutation request and response:

```ts
type AppActionRequest = {
  clientRequestId: string;
  expectedRevision: string;
  action: DeclaredAppMutationAction;
};

type AppActionResponse = {
  result: JsonValue;
  revision: string;
  replayed: boolean;
};
```

The app mutation, data-revision predicate, receipt, audit, and event are one transaction. A stale revision returns `409 conflict` plus bounded authoritative revision metadata. An unknown transport outcome retries with the same request ID and payload.

Change signal:

```ts
type AppChangeSignal = {
  type: "resource.app.changed" | "share.access_ended" | "share.needs_recheck" | "refresh_required";
  eventId: string;
  scopeSequence: string;
  scopeId: string;
  appId: string;
  buildId: string;
  revision: string;
  occurredAt: string;
};
```

Clients deduplicate by event/sequence and perform an authoritative read. Events carry no app record payload.

## Authorization matrix

| Operation | Authentication | Required authority | Public |
| --- | --- | --- | --- |
| Read readiness | Owner Matrix session | Exact app owner | No |
| Run readiness | Owner Matrix session | Exact app owner + current selected-organization membership | No |
| Share preflight/create | Owner Matrix session | Exact app owner + current membership + current ready build | No |
| Read/stop share | Owner Matrix session | Exact app owner + current revisions for stop | No |
| Discover shared app | Platform Matrix session | Current membership in share organization | No |
| Create/renew launch | Platform session + owner direct-session exchange | Active exact share + current membership + ready build | No |
| Load bootstrap/assets | Platform session; owner relay signs upstream | Launch actor + active share + current membership + exact build | No |
| Read app data | Signed owner-runtime direct session | Active share + current membership + declared table | No |
| Write app data | Signed owner-runtime direct session | Active share + current membership + current data revision | No |
| Subscribe/resume/reconnect | Signed direct WebSocket/session | Active share + current membership, continuously rechecked | No |
| Use creator providers/AI | Existing provider/funding authority only | Never implied by app sharing | No |

## Safe errors

Only bounded codes cross the client boundary:

- `invalid_request` — malformed/bounds/schema failure;
- `not_found` — ordinary access denial without resource disclosure;
- `conflict` — revision, idempotency-payload, or exact-build conflict;
- `host_offline` — retryable creator-runtime unavailability;
- `access_ended` — stopped share or ended membership;
- `needs_recheck` — exact build is no longer ready;
- `unavailable` — generic server dependency or verifier failure;
- `rate_limited` — bounded capacity reached.

Unknown, long, provider/path/database-looking messages are replaced by safe copy. Detailed errors stay in redacted server logs.

## Limits and cleanup

- Every mutating route, including DELETE, uses Hono `bodyLimit` before buffering.
- All path/query/body values use strict Zod schemas at the route boundary.
- Read pages, readiness results, operation results, directory pages, event replay, asset sizes, streams, launch sessions, and in-memory registries have explicit caps.
- Platform/owner-runtime calls use `AbortSignal.timeout`, reject redirects, and target trusted configured origins.
- Launch/session/event registries have TTL/LRU or stale sweeps, dead-sender eviction, and shutdown drains.
- Immutable build cleanup is recurring, reference-aware, and symlink-safe.

## Compatibility

- Existing project sharing and legacy standalone links keep current grant/role behavior.
- Only newly created ready app scopes use current-membership full access.
- Older clients render an app entry as “client update required”; they do not treat it as Chat/project or fall back to a local same-slug app.
- Native Mobile may list “Open on web” but is not qualified to run V1 shared apps.
