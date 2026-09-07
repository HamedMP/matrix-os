# Data Model: Collaboration and Session Sharing

**Related:** [spec](spec.md), [plan](plan.md), [API](contracts/collaboration-api.md).
**Status:** Proposed additive design. No tables or data are created by this planning PR.

## Storage ownership

Owner-runtime PostgreSQL/Kysely holds grants, invitation state, shared content, queue, audit, and authority transitions. Platform Postgres holds opaque locators, per-recipient discovery entries, rollout policy, and short-lived connection tickets; it is not the grant authority. File bytes remain owner-controlled under the authoritative scope root. Identity/config remains files. No SQLite, additional ORM, or centralized transcript store is introduced.

Use UUIDs for new scope/operation/invitation IDs. Existing resource IDs keep canonical resource contracts. Database revisions, event sequences and epochs are BIGINT internally and decimal strings at boundaries. Times are UTC timestamps. Principal IDs are verified canonical user identifiers, bounded to 128 characters; labels are bounded safe display projections and never authorization inputs.

## Owner-runtime tables

### collaboration_scopes

| Field | Rule |
| --- | --- |
| id | UUID primary key, stable through resource relocation |
| owner_type / owner_id | Explicit ownership scope; first implementation uses personal owner; no implicit org admission |
| kind / resource_id | `chat`, `terminal`, `project`; unique live binding within owner; resource ID resolved server-side |
| parent_scope_id | Optional project parent; FK restricted to active project scope; no cycles or multiple parents |
| membership_mode | `direct` or `inherited`; inherited requires project parent, direct requires no parent |
| lifecycle | `private`, `preparing`, `shared`, `archived`, `deleting`, `deleted`, `recovering` |
| revision / auth_epoch | Monotonic; membership, authority, and lifecycle changes increment epoch |
| authority_runtime_id / authority_generation | Runtime locator and fenced generation; changes only at a journaled cutover |
| execution_generation / eligibility | Proven scope execution profile generation or unavailable; never derived from cwd |
| created_at / updated_at / deleted_at | Soft deletion excluded from normal reads; protected owner recovery paths are explicit |

A direct Chat scope may exist inside a private project without granting project access. Once the project is shared, child scopes use its sole membership authority. Unique-scope creation uses ON CONFLICT and selects the existing logical scope; retries do not create independent grants.

### collaboration_members

| Field | Rule |
| --- | --- |
| scope_id / actor_id | Composite primary key; rows only on direct-authority scopes |
| role | owner/editor/viewer, constrained |
| status | pending/accepted/revoked/expired; pending row is also the invitation reservation |
| invitation_id | Unique opaque invitation identity, not a public bearer capability |
| invited_by / accepted_at / expires_at | Verified inviter, explicit acceptance, bounded expiry |
| revision / joined_at / updated_at | Conditional role changes and preserved original join history |

The owner has exactly one accepted owner row in the initial model. Transfer cannot remove the final owner before the successor is committed. Owner+pending+accepted slots cannot exceed eight; lock the scope row before counting/upserting. A renewal of a revoked/expired invitation uses a new invitation ID, so accepting an old link cannot reactivate access. Target account is immutable for that invitation.

For inherited children, resolve the project member row inside the authorizing operation. Do not copy memberships into child grant tables. Existing `chat_members` may remain a compatibility projection maintained from the common authority, but shared authorization must never consult it as an independent fallback. Private Chats retain existing owner semantics.

### collaboration_operations

PK `(scope_id, actor_id, client_request_id, operation_kind)`; fields payload_hash, status, result_ref, expected_revision, accepted_auth_epoch, created_at, expires_at. Payload mismatch on key replay returns conflict. Reserve/commit with the actual mutation. Request IDs are not globally unique across users. Retain replay metadata seven days; this is not the resource history retention.

### collaboration_events and collaboration_audit

Events: scope_id, strictly increasing scope_seq, unique event_id, resource_kind/id, revision, authority_generation, event_type, bounded content-free invalidation payload, created_at. Commit with the affected resource/membership change. Events delivered at least once; recipients deduplicate by event_id/sequence. A project event stream can reference children only after inherited scope resolution.

Audit: scope_id, actor_id, action, outcome, timestamp, revision, bounded reason code. No message text, terminal bytes, credentials, paths or raw errors. Ninety-day initial retention, included only in owner-authorized scope export as appropriate. Deletion retains only the content-free tombstone needed by existing idempotency policy.

### collaboration_directory_outbox

Unique event_id, scope_id, recipient actor IDs, authority runtime/generation, kind, invitation/member discovery state, retry_after, attempts, created_at. Contains no transcript/title/file names/terminal replay. The worker updates platform metadata idempotently using its registered runtime credential and cannot assign another owner's runtime. Retry has capped exponential backoff and bounded batches. If platform is unavailable, local authority remains correct; discovery catches up later.

### collaboration_transitions

id, scope_id, source/destination authority and generations, requested_by, inventory_revision/hash, intended_membership_hash, status, source_fence_epoch, staged_manifest_ref, publication_marker, retry/error_code, timestamps.

States: `prepared -> staging -> fenced -> committing -> active`; failures before publication enter `failed` or `recovering` with source still authoritative. After publication, recovery completes the destination activation/cleanup, never revives the source as writable. Stage manifests and backups are referenced until explicit retention cleanup permits deletion.

Inventory includes every owned file/document, Chat, app/data scope, layout node and terminal incarnation, plus external references identified separately. A change before final confirmation invalidates the confirmed inventory. A post-confirmation writer fence prevents source divergence during final synchronization. Unsupported owned content blocks the transition; there is no exclusion array.

### collaboration_resource_bindings and execution profiles

Bindings map stable scope/resource identities to authoritative root/app-data namespace/session incarnation. Paths are derived from owner-controlled registry data and validated; clients never submit absolute execution roots. Each binding has revision, authority_generation, readiness and optional inherited project scope.

Execution profile: scope_id, profile_version, execution_generation, supervisor_handle, kind, supported_adapter_id, status, last_verified_at. No secrets. A missing or outdated profile disables shared execution but does not erase history. Each run/session has an isolated process namespace and identity/incarnation; project-shared files can be mounted without making sibling process control available. Only the trusted supervisor can resolve its fixed handle to host paths.

## Extend canonical Chat rather than create another store

| Existing record | Additive changes |
| --- | --- |
| chat_messages | `actor_id` nullable for historical unknowns; `purpose = discussion / ai_request / assistant / system`; immutable actor/type; existing content and sequence retained |
| chat_turns / chat_runs | Original requesting_actor_id, collaboration scope and execution generation, attempt lineage; retain existing one-active-run partial unique index |
| chat_queued_turns | requesting_actor_id, immutable accepted_seq, payload hash, scope epoch and distinct terminal rejection reason; preserve existing queue repository and adapt shared-only ordering |
| chat_user_state | Continue `(chat_id, principal_id)`; authorize actor and avoid owner projection overwriting another member's read/pin/mute state |
| chat_run_adapter_state | Scope/execution generation and context provenance; no reuse of private state just because project root matches |
| chat_members | Derived compatibility projection for shared records; no parallel grant authority |

Discussion creation atomically inserts message, actor-scoped operation replay metadata and scope outbox. It creates no Turn or Run. Human history remains chronological even when AI requests wait. Request accepted_seq determines AI order; do not use message timestamps as a concurrency primitive.

Shared queue states: `queued -> claimed -> running -> completed / failed / cancelled / interrupted`, with not-executed `unauthorized` or `unavailable` reasons where needed. The exact canonical schema may represent request, turn and attempt separately; views must preserve these distinctions. At most 32 queued entries and one executing run per Chat. Known non-delivery may retry an accepted command idempotently; uncertain external effects require reconciliation instead of a new implicit attempt.

Queued request admission locks effective scope then Chat row, validates actor and policy, enforces cap, allocates accepted_seq, stores replay hash and message, and commits outbox. Dispatcher rechecks original actor, epoch, and capability before claim/execution. Personal queue ordering/steering behavior remains personal; shared queues do not expose reorder or steer operations outside the accepted spec.

### chat_collaboration_commands

id, scope_id, chat_id, request_id/run_id, actor_id, kind (`approval`, `cancel`, `retry`), payload_hash, expected_state_revision, authorized_epoch, state, result_ref, timestamps. Unique action decision per pending approval and actor-request operation idempotency. Transaction claims the decision and records attribution/outbox; adapter calls occur outside locks. An owner-only approval must not be satisfiable by an editor through a legacy route.

Private composer drafts remain local to each actor/client, keyed by runtime+scope+Chat+actor, including discussion/AI mode. Reuse bounded existing draft storage and clear on account changes. Never include drafts in shared messages, events, directory metadata or shared exports. This does not introduce cross-device draft synchronization.

## Terminal control and persistence

Reuse existing stable session metadata, replay, registry and lease machinery behind a scope-runtime adapter. Add scope_id, creator_actor_id, session_incarnation, execution_generation and required shared-control mode. A renamed or recreated session with the same display name is not the same incarnation.

For the current single-authoritative-gateway topology, active control remains a bounded in-memory lease keyed by scope+session+incarnation with holder actor/connection, epoch and expiry. Scope membership remains durable Postgres truth. Gate every action on current authorization and the lease epoch. Serialize transfer/revoke/input in a per-scope bounded coordinator; authorization changes invalidate the coordinator before acknowledging success. Reconnect creates a new connection binding and must reacquire control. Restart invalidates old leases; it does not replay buffered input or terminate durable processes. Do not persist a second conflicting lease authority in Postgres. Any multi-gateway topology must first replace the coordinator with one shared fenced authority and prove split-replica tests.

A lease authorizes input, never changes role or grants file/app APIs. Editor stop applies only to terminals with their creator_actor_id. Project membership can grant terminal creation; standalone session membership cannot.

## Platform tables

| Table | Key fields and limits |
| --- | --- |
| collaboration_directory | scope UUID PK, runtime ID, owner ID, kind, authority_generation, metadata_revision; registered runtime-only writes; no content |
| collaboration_user_index | actor+scope PK, invitation_id/status projection, locator generation; expired/revoked entries removed by outbox/reconcile; never authorization |
| collaboration_rollout_policy | milestone ID PK, revision, mode off/internal/enabled/read_only, bounded cohort of up to 1,000 immutable user IDs, changed_by/at; server-managed |
| collaboration_connection_tickets | SHA-256 opaque-token hash PK, actor/scope, connection purpose, policy revision, expiry <=30s, consumed_at; one-use claim; capped 20 outstanding per actor, minute cleanup |

Platform routing proof is short-lived transport authentication, not a durable grant. Shared item ownership and current membership remain owner-runtime facts even if the directory is delayed or tampered with.

## Migration and recovery rules

1. Introduce versioned additive tables/columns/constraints with focused migration tests. `CREATE TABLE IF NOT EXISTS` alone does not evolve existing schemas.
2. Backfill known canonical actor provenance; historical imports with unknown authors get a generic unknown-author label, not fabricated owner attribution.
3. Scope conversion locks the existing resource and fences active/queued private execution. M1 refuses conversion while active work cannot settle safely.
4. Project transition locks involved scopes in stable ID order and reconciles direct grants at the single publication point. Never silently promote old item-only recipients to project members.
5. Owner file writes and app/Chat/Terminal changes honor the generation fence. Filesystem/DB work is a journaled saga with an authority commit point, not a claimed cross-filesystem transaction.
6. Deletes filter already-deleted rows, cascade only owned scope state, publish after commit and preserve unrelated participant data. Ended grants cannot be revived by replaying old accept/confirm operations.
7. Rollback is capability disable or a verified compatible binary. Keep schema/history, invalidate stale proofs/epochs, and retain owner export/recovery. Binary downgrade to old owner-only code must be blocked for shared resources.
