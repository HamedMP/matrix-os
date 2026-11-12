# Data Model: Collaborative App Sharing

PostgreSQL through Kysely remains authoritative for collaboration metadata and app records. The platform stores routing/discovery metadata only; it never stores the app record set.

## Ownership boundary

App code, qualified builds, and records remain solely owned by the creator. Sharing delegates revocable full app use to every current member of one organization, including guests, without transferring ownership, creating a second permission system, or moving records into organization storage. Any current organization member may share an app they own. UI must disclose this. Creator departure while sharing remains deferred.

## Existing entities reused

### `collaboration_resource_catalog`

- `id`: immutable catalog UUID used by scopes/readiness.
- `owner_id`: creator whose runtime/registry are authoritative.
- `project_id`: `NULL` for direct app sharing.
- `kind`: `app`.
- `path`: slug for routing/display, never sole identity.
- `incarnation`: registration identity; changes after delete/recreate.
- `revision`: optimistic concurrency revision.
- `deleted_at`: tombstone excluded from normal access.

A catalog row alone is not collaboration readiness.

### `collaboration_scopes` as the organization app share

For a direct app share:

- `owner_type = personal`, `owner_id = creator`;
- exactly one `organization_id`;
- `kind = app`, `resource_id = catalog UUID`;
- `parent_scope_id = NULL`; no project relation;
- `membership_mode = direct` for schema compatibility, without recipient member rows;
- lifecycle/revision/auth epoch and owner runtime identity remain the routing/revocation fence.

At most one non-deleted direct app scope exists for a catalog identity. Every current member, including a guest, derives full functionality from the active scope. An owner `collaboration_members` row may remain only for generic ownership invariants; recipients do not receive member/grant/activation/permission rows.

### Owner app records

The registered app's declared PostgreSQL schema/tables remain the one record set. The collaboration scope is not a row filter or second schema. Only declared tables may be accessed, and related writes use one transaction.

### Existing operation/event/audit/outbox records

- `collaboration_operations`: idempotency key, payload hash, expected revision, replayable bounded result, admitted auth epoch, expiry.
- `collaboration_events`: content-free scope/app/build/revision signal with ordered sequence.
- `collaboration_audit`: share, stop, rebind, readiness, and mutation outcomes using safe reason codes.
- Directory outbox/platform projection: scope/org/owner-runtime/app/build/lifecycle metadata only, using a `current_membership` access model rather than activation.

## New entities

### `collaboration_app_readiness`

Persisted exact-build certificate.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID | Primary key. |
| `owner_id` | text | Exact creator. |
| `catalog_id` | UUID | Live app catalog identity. |
| `registration_incarnation` | text | Must match catalog at check and use. |
| `app_id` | text | Bounded slug for display/diagnostics. |
| `manifest_version` | text | Bounded declared version. |
| `build_id` | 64-char hex | Digest of incarnation, manifest, schema, assets, bridge contract, runtime ABI. |
| `manifest_digest` | 64-char hex | Canonical manifest digest. |
| `schema_digest` | 64-char hex | Canonical declared-schema digest. |
| `asset_digest` | 64-char hex | Immutable built-asset tree digest. |
| `bridge_contract_version` | text | Shared bridge ABI. |
| `runtime_abi` | text | Compatibility ABI, not process generation. |
| `artifact_ref` | text | Owner-local immutable snapshot reference; never exposed. |
| `status` | enum | `checking`, `ready`, `blocked`, `stale`, `failed`. |
| `gate_results` | JSONB | Bounded closed gate codes/outcomes; no raw internal errors. |
| `verified_at` | timestamp nullable | Present only after successful production-path proof. |
| `invalidated_at` | timestamp nullable | Build/contract drift time. |
| `invalidation_reason` | enum nullable | Safe drift/deletion code. |
| `verifier_version` | text | Exact recipe version. |
| `revision` | bigint | Positive CAS revision. |
| `created_at`, `updated_at` | timestamp | Audit timestamps. |

Constraints:

- Unique `(catalog_id, build_id, verifier_version)`.
- `ready` requires verified time, all required pass results, and no invalidation.
- Non-ready rows cannot authorize share/launch.
- Artifact retention is reference-counted; cleanup is bounded, recurring, and symlink-safe.

### `collaboration_app_bindings`

Exact build bound to one app scope.

| Field | Type | Rules |
| --- | --- | --- |
| `scope_id` | UUID | PK/FK to app collaboration scope. |
| `catalog_id` | UUID | Exact catalog resource. |
| `registration_incarnation` | text | Prevents same-slug inheritance. |
| `readiness_id` | UUID | Certificate used for share/rebind. |
| `build_id` | 64-char hex | Immutable build served. |
| `data_revision` | bigint | Global V1 app mutation revision; advances on changed data writes. |
| `state` | enum | `active`, `needs_recheck`, `stopped`. |
| `revision` | bigint | Share lifecycle CAS revision; data writes do not advance it, so an owner can stop sharing after a member write. |
| timestamps | timestamp | Create/update/stop history. |

Constraints:

- One active binding per catalog ID.
- Active requires a shared scope and ready certificate for the same catalog/incarnation/build.
- Catalog/incarnation never change in place.
- Rebind CASes binding/scope and bumps auth epoch atomically.
- Stop changes scope/binding atomically and never deletes app rows.

### Shared app launch session

Ephemeral bounded state:

- opaque launch ID;
- scope/app/build identity;
- actor and organization;
- owner runtime identity/generation;
- admitted auth/membership epochs and expiry;
- created/expiry/last-touched timestamps.

It has short expiry, bounded per-actor/scope/runtime capacity, TTL/LRU eviction, and full reauthorization on renewal. The current platform session remains required on every facade request. Membership loss, stop, rebind, replacement, or readiness invalidation revokes it.

### Safe participant context

Ephemeral `{ actorId, displayName, organizationId, scopeId, shareRevision, buildId }`. It contains no membership assertion, proof key, owner cookie, provider token, path, or funding credential.

## Relationships

```text
owner app registration
  └─ collaboration_resource_catalog
       ├─ collaboration_app_readiness (many exact builds/checks)
       └─ collaboration_scopes kind=app (zero or one active org share)
            └─ collaboration_app_bindings (one exact build)
                 ├─ collaboration_operations
                 ├─ collaboration_events
                 ├─ collaboration_audit
                 ├─ platform directory metadata
                 └─ owner app schema/tables (one existing record set)
```

## State transitions

### Readiness

```text
checking → ready | blocked | failed
ready → stale | blocked
stale | blocked | failed → checking → ready | blocked | failed
```

Old certificates remain immutable evidence. A new check never edits app records.

### Share/binding

```text
no share → shared/active
shared/active → needs_recheck
needs_recheck → shared/active   (successful exact-build CAS rebind)
shared/active | needs_recheck → stopped
host offline: shared/active remains active; availability is observational
```

### Mutation

```text
unsaved → submitted → confirmed
submitted → uncertain → confirmed | retryable failure
submitted → conflict
```

Uncertain retries reuse the same request ID/payload. Conflict never replaces local input.

## Transaction boundaries

1. **Create share**: lock catalog/readiness; idempotently create/select scope; insert binding and owner invariant; append operation/audit/event/outbox.
2. **Stop**: CAS scope/binding; stop lifecycle; bump auth epoch; append operation/audit/event/outbox. Revoke sessions after commit.
3. **Rebind**: lock scope/binding/catalog/new certificate; CAS build; bump auth epoch; append audit/event/outbox.
4. **Mutate data**: verify live scope/binding/membership inside transaction; CAS `data_revision`; mutate declared table; persist receipt/audit/event atomically.
5. **Read data**: verify active scope/exact binding/fresh membership, then query bounded declared owner tables.

The owner rebind command supplies one stable request ID plus
`expectedShareRevision`, `expectedBindingRevision`, `expectedResourceRevision`,
`expectedReadinessRevision`, `expectedPreviousBuildId`, the new `readinessId`,
and the new exact `buildId`. Its response is the updated
`CollaborativeAppShare` projection with the new build, share revision, binding
revision, and unchanged owner/organization identity. Exact request replays
return that same projection; stale predicates return a conflict and preserve
the prior `needs_recheck` binding.

## Deferred model changes

- Creator departure/ownership transfer or durable organization hosting.
- One owner database shared with multiple organizations.
- Per-record ACLs, Viewer/Editor roles, direct grants, or per-record revisions.
- Public links, external non-member guests, Gallery install, arbitrary servers, and Native Mobile runtime parity.
