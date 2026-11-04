# Data Model: Organization-wide Project Access

## Canonical entities

### Shared project scope

Existing `collaboration_scopes` row where:

- `kind = project`
- `organization_id` identifies the one organization whose active members may work in the project
- `owner_id` identifies the immutable data/project owner
- `lifecycle` controls private, publishing, shared, archived, recovering, or deleted behavior
- `auth_epoch` / authority generations fence stale sessions and mutations
- `deleted_at` excludes deleted projects from normal reads

No role or access-mode column is added. For project scopes, `lifecycle = shared` and a non-null `organization_id` imply organization-full-access V1.

### Organization membership evidence

Authoritative, bounded evidence supplied by the existing organization precondition:

- `organizationId`
- `actorId`
- active/denied result
- `membershipEpoch` when available
- `expiresAt`, never beyond the existing 20-second contract bound

This evidence is checked for protected operations and is not persisted as a durable project grant.

### Project work access decision

Derived, not stored:

- `scopeId`
- `actorId`
- `organizationId`
- `accessMode = organization_full_access`
- contributor work actions for live shared projects
- archived/read-only actions for archived projects
- `isOwner`
- `evidenceExpiresAt`
- safe denial reason when unavailable

Owner-only administrative actions are not included in the contributor action set.

### Current owner AI route

Derived from Provider Settings V3 for the scope owner:

- `providerInstanceId`
- `accessSourceId`
- `modelId`
- readiness state
- settings revision/generation or equivalent freshness token

The route is valid only when the exact projected instance/source/model remains ready for that owner. It is not copied onto the project.

### Shared AI run binding

Persisted per admitted run for audit and safe resume:

- `runId`
- `scopeId`
- `chatId`
- `ownerId`
- `requestingActorId`
- exact `providerInstanceId`
- exact `accessSourceId`
- exact `modelId`
- owner credential/settings generation
- creation time and terminal state

The binding proves what the run used. It does not grant a later request access and does not act as project policy.

## Legacy entities retained during rollout

### Collaboration grants and activations

`collaboration_grants` and `collaboration_grant_activations` remain for:

- standalone resource share compatibility
- audit/rollback context for historical project shares

They are not read or written to authorize project scopes after cutover.

### Collaboration execution policies

`collaboration_execution_policies` and legacy policy fields remain temporarily for audit/rollback or non-project compatibility. They are not read or written by project share UI or project shared-AI admission.

## Relationships

```text
organization 1 ── * active members
      │
      └── 1 ── * shared project scopes
                         │
                         ├── 1 owner
                         ├── * inherited project resources
                         └── * shared AI run bindings

owner 1 ── 1 current Provider Settings active route
```

## State transitions

### Project

```text
private → publishing → shared → archived
   ↑           │          │          │
   └───────────┴──────────┴──────────┘ unshare/recovery paths
```

- Access begins only after publication reaches `shared`.
- Access ends when unshare/recovery advances authority state, not when legacy grants are modified.
- Archived retains membership-based visibility but narrows mutations.

### Membership

```text
inactive → active: next authorized request succeeds; project appears in inventory
active → inactive: new requests fail; active sessions/runs are fenced and drained
```

### Owner AI route

```text
ready route A → unavailable: new/queued dispatch fails closed; no fallback
ready route A → ready route B: later requests use B; A-bound active work is fenced per generation rules
```

## Invariants

1. A non-owner cannot gain project work access without current active membership in the project's organization.
2. A member cannot exercise owner-only administration through the contributor action set.
3. A project AI request never selects a route absent from the owner's current global Provider Settings projection.
4. Credentials and raw provider errors never cross the owner/runtime boundary.
5. Legacy project grants and policies cannot narrow or expand project access after cutover.
6. Standalone resource shares retain their existing grant semantics until explicitly migrated.
7. Revocation and unshare fail closed and fence stale authority.
