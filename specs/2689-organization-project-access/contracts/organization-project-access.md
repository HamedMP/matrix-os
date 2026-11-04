# Contract: Organization-wide Project Access

This document defines the intended public behavior. Exact Zod names may be refined during TDD, but the fields and authorization semantics are normative.

## Project access presentation

Owner and member clients receive a role-free projection:

```ts
type OrganizationProjectAccess = {
  scopeId: string;
  organization: {
    id: string;
    name?: string;
  };
  owner: CollaborationParticipant;
  lifecycle: "private" | "publishing" | "shared" | "archived" | "recovering";
  accessMode: "organization_full_access";
  canAdministerShare: boolean;
};
```

The contract does not contain:

- Editor/Viewer or contributor/viewer selection
- individual people/grants/activations
- general-access presets
- AI source or model selection
- provider-terms acknowledgment
- member submit mode

`canAdministerShare` is true only for the owner after fresh organization verification. It is presentation data, not sufficient authorization for a mutation.

## Effective project work access

For `shared` project scopes:

```ts
type ProjectWorkAccess = {
  scopeId: string;
  actorId: string;
  organizationId: string;
  accessMode: "organization_full_access";
  actions: CollaborationCapabilityAction[];
  isOwner: boolean;
  evidenceExpiresAt: string;
};
```

An active organization member receives the complete contributor work actions. An archived project receives the existing read-only lifecycle narrowing. Denied responses carry no actions and one safe reason.

Owner-only administrative actions are intentionally absent from `CollaborationCapabilityAction` and are checked by dedicated owner authorization:

- share/unshare project
- delete whole project
- change Provider Settings or billing
- add/remove organization members

## HTTP behavior

### Share project

Existing project confirmation/transition endpoints remain owner-only and validated. Confirmation attaches the selected organization and publishes the whole project. It does not create a serving grant or AI policy.

### Read project access

The project access endpoint returns `OrganizationProjectAccess`. It may list organization identity and owner identity, but not provider credentials or hidden billing/provider details.

### Project grant/preset routes

Requests to create, patch, revoke, accept, or decline a grant for a `project` scope return a safe conflict/unsupported response. The same routes may continue for standalone resource scopes during compatibility rollout.

### Project execution-policy routes

`GET/PUT /api/collaboration/scopes/:scopeId/execution-policy` and `/options` are not part of the project contract. Project requests return a safe unsupported/not-found response, and the project UI never calls them. Non-project compatibility is handled separately if still required.

Every mutating route keeps Hono `bodyLimit`, Zod boundary validation, typed errors, no-store responses, and generic client messages.

## Shared AI resolution

At request admission and dispatch:

1. Verify live project scope and current organization membership.
2. Read the scope owner's Provider Settings V3 snapshot.
3. Require non-null `active.providerInstanceId`, `active.accessSourceId`, and `active.modelId`.
4. Verify the exact tuple is ready and belongs to the owner.
5. Persist/bind that exact tuple to the run.
6. Resolve credentials only inside the owner/runtime broker.

If any step fails, return/queue the existing safe unavailable or unauthorized outcome. Do not:

- use a previous project policy
- use a different ready provider/model
- expose raw provider failure details
- expose credentials to the collaborator

## Compatibility

- Existing shared projects cut over automatically based on scope organization/lifecycle.
- Historical project grants, activations, and execution policies are ignored.
- Existing standalone resource shares keep current grant contracts.
- Private projects remain private.
- External references remain outside a project share unless independently shared.

## Event and realtime behavior

- Membership removal and unshare advance existing authority/fence state and drain affected sessions.
- Organization membership addition makes the project discoverable without an acceptance event.
- REST mutations affecting realtime project documents continue to notify subscribers after commit.
- Per-subscriber send failures remain isolated and dead subscribers are evicted.
