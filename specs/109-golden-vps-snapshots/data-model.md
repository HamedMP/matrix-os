# Data Model: Golden VPS Snapshots

Platform PostgreSQL is authoritative. Provider resources are projections reconciled by immutable IDs and labels. All timestamps are UTC ISO strings to match existing platform tables; UUIDs are application-generated.

## GoldenSnapshot

One canonical snapshot candidate per immutable bundle digest and compatibility key.

| Field | Type | Rules |
|---|---|---|
| `snapshot_id` | UUID text | Primary key |
| `bundle_version` | text | FK to `host_bundle_releases.version`; bounded 128 |
| `bundle_sha256` | 64-char hex | Copied immutable provenance; must match release row |
| `source_git_commit` | text | 7-64 chars |
| `compatibility_key` | 64-char hex | Hash of normalized compatibility fields |
| `provider` | text | V1 `hetzner`; bounded enum |
| `architecture` | text | V1 `x86`; bounded enum |
| `region` | text | Bounded provider location/region policy key |
| `base_image` | text | Approved provider system-image ID/name |
| `base_generation` | text | Revocable OS generation |
| `boot_mode` | text | V1 `bios`; bounded enum |
| `activation_abi` | text | Release-declared updater/activation compatibility |
| `minimum_disk_gb` | integer | Positive and bounded |
| `test_mode` | boolean | Required, defaults false; true candidates are never production-selectable and use a shorter configured TTL |
| `state` | text | `candidate`, `building`, `sanitizing`, `validating`, `ready`, `failed`, `quarantined`, `retiring`, `deleted` |
| `provider_image_id` | bigint nullable | Exact snapshot image ID; unique when present |
| `provider_image_status` | text nullable | Bounded provider projection, never used alone for eligibility |
| `image_disk_gb` | numeric nullable | Verified provider value |
| `image_architecture` | text nullable | Verified provider value |
| `validation_summary` | JSONB nullable | Bounded coarse booleans/hashes/timestamps; no raw secrets/logs |
| `failure_code` | text nullable | Allowlisted bounded code |
| `ready_at`, `quarantined_at`, `retiring_at`, `deleted_at` | text nullable | Lifecycle evidence |
| `created_at`, `updated_at` | text | Required |
| `revision` | integer | Optimistic state transitions include `WHERE revision = base` |

Snapshot ordering does not duplicate a `build_time` column. The immutable artifact
ordering value is `host_bundle_releases.build_time`, reached through
`GoldenSnapshot.bundle_version -> host_bundle_releases.version`; selection joins that
authoritative release row for both the source and target. First registration fixes the
release `build_time`, and a conflicting re-registration is rejected rather than
rewriting it.

Constraints/indexes:

- Unique `(bundle_sha256, compatibility_key, test_mode)` provides idempotent creation without allowing an operator test candidate to satisfy a production request.
- Unique partial `provider_image_id WHERE provider_image_id IS NOT NULL`.
- Selection index on `(state, compatibility_key, ready_at)` with `state = 'ready'`.
- State check constraint and positive disk/revision checks.

## GoldenSnapshotRevokedBaseGeneration

Durable deny marker for an unsafe base-system generation. The marker is authoritative
even when no snapshot row currently exists, so later release reconciliation cannot
recreate a selectable candidate from the revoked generation.

| Field | Type | Rules |
|---|---|---|
| `base_generation` | text | Primary key; bounded compatibility identifier |
| `reason` | text | Allowlisted bounded code |
| `revoked_at` | text | Required immutable first-revocation timestamp |
| `updated_at` | text | Required; changes only for an explicit operator reason update |

Generation revocation inserts this row with `ON CONFLICT` before any snapshot batch is
processed. Candidate enqueue, readiness, and generation revocation all take the same
transaction-scoped advisory lock derived from `base_generation` before checking or
inserting the marker. This serializes the readiness write against revocation under
PostgreSQL READ COMMITTED; checking the marker without that shared lock is insufficient.
Candidate enqueue and readiness then check the marker in their existing transaction and
fail closed. A bounded worker then quarantines active snapshots and
terminates their builds in deterministic pages; the marker makes partial progress safe
and immediately blocks new selection. V1 has no un-revoke mutation: recovery requires
moving configuration to a new approved `base_generation`.

## GoldenSnapshotAuditEvent

Immutable, bounded operational evidence for lifecycle and destructive operator actions.

| Field | Type | Rules |
|---|---|---|
| `event_id` | UUID text | Primary key |
| `snapshot_id` | UUID text nullable | Related snapshot when known |
| `build_id` | UUID text nullable | Related build when known |
| `cleanup_id` | UUID text nullable | Related cleanup when known |
| `event_type` | text | Allowlisted bounded lifecycle event |
| `actor_type` | text | `release`, `worker`, or `operator` |
| `actor_id_hash` | 64-char hex nullable | One-way attribution; never a bearer secret |
| `from_state`, `to_state` | text nullable | Bounded coarse states |
| `reason` | text nullable | Allowlisted coarse reason only |
| `created_at` | text | Immutable event time |

The lifecycle mutation and its event insertion share one transaction. Event payloads
never contain provider errors, credentials, owner identifiers, or evidence blobs.
Retention deletes only events older than the configured incident/audit window in
bounded immutable-key pages; the default is 90 days and each sweep is capped at 100.

## GoldenSnapshotBuild

Durable resumable orchestration for a snapshot candidate. One row is reused across bounded retries.

| Field | Type | Rules |
|---|---|---|
| `build_id` | UUID text | Primary key |
| `snapshot_id` | UUID text | Unique FK to snapshot |
| `phase` | text | `requested`, `builder_create`, `builder_boot`, `sanitizing`, `snapshot_create`, `snapshot_wait`, `validation_create`, `validation_boot`, `cleanup`, `completed`, `failed`, `reconciling` |
| `status` | text | `queued`, `running`, `completed`, `failed` |
| `attempts` | integer | Bounded by config |
| `available_at`, `claimed_at`, `lease_expires_at` | text nullable | Conditional worker lease |
| `callback_phase` | text nullable | Exact expected synthetic callback |
| `callback_token_hash` | text nullable | SHA-256 only; cleared after phase |
| `callback_expires_at` | text nullable | Phase deadline sized for the complete external boot/install workflow; independent of the shorter reclaimable worker lease |
| `provider_builder_id` | bigint nullable | Exact ephemeral server |
| `provider_builder_action_id` | bigint nullable | Persisted create Action before builder readiness polling |
| `provider_snapshot_action_id` | bigint nullable | Persisted before polling |
| `provider_validation_id` | bigint nullable | Exact ephemeral validation clone |
| `provider_validation_action_id` | bigint nullable | Persisted before polling |
| `validation_clone_ordinal` | integer | `1` or `2`; identifies the independent validation clone currently being reconciled |
| `builder_machine_id_sha256` | 64-char hex nullable | Persisted from the sanitized builder callback before capture; compared with every validation clone after worker restart |
| `builder_ssh_host_key_sha256` | 64-char hex nullable | Persisted from the sanitized builder callback before capture; compared with every validation clone after worker restart |
| `first_validation_machine_id_sha256` | 64-char hex nullable | Persisted after clone 1; compared with clone 2 and the builder before readiness |
| `first_validation_ssh_host_key_sha256` | 64-char hex nullable | Persisted after clone 1; compared with clone 2 and the builder before readiness |
| `pending_operation` | text nullable | Bounded ambiguity/reconciliation key |
| `last_error_code` | text nullable | Allowlisted coarse code |
| `created_at`, `updated_at` | text | Required lifecycle timestamps |
| `completed_at` | text nullable | Set only when the build becomes terminal |

Claiming is a single conditional `UPDATE ... WHERE lease expired/status queued AND attempts < max RETURNING`. Network calls are outside the claim transaction. Phase advancement includes current phase/lease ownership in the write predicate.

## GoldenSnapshotCallbackReceipt

Every accepted callback has a durable replay receipt; later phases never overwrite an
earlier receipt.

| Field | Type | Rules |
|---|---|---|
| `build_id`, `event_id` | UUID text | Composite primary key; FK to build |
| `callback_phase` | text | Exact phase accepted for this event |
| `payload_sha256` | 64-char hex | Canonical digest of the strict payload |
| `outcome` | JSONB | Bounded coarse response only; no provider details or evidence blobs |
| `created_at`, `expires_at` | text | Required; expiry uses the bounded callback replay-retention window |

The receipt insertion and phase transition commit atomically. `INSERT ... ON CONFLICT`
on `(build_id, event_id)` makes a same-event same-payload retry return the stored outcome
without mutation, while payload drift fails closed. Bounded pruning removes only expired
receipts in immutable-key pages after the replay window.

## GoldenSnapshotLease

Protects a selected ready snapshot while a provision/recovery clone is being created.

| Field | Type | Rules |
|---|---|---|
| `lease_id` | UUID text | Primary key |
| `snapshot_id` | UUID text | FK to snapshot |
| `machine_id` | UUID text | Stable intended replacement identity; unique active association. It is deliberately not an FK because recovery leases this new identity before the replacement is adopted into `user_machines`; the same UUID becomes the row identity at adoption, so no lease-key rotation occurs. |
| `purpose` | text | `provision` or `recover` |
| `target_bundle_version` | text | Exact requested release |
| `created_at`, `expires_at` | text | Required bounded lifetime |
| `released_at` | text nullable | Null while the lease protects an in-flight clone |

Selection and insertion occur in one transaction. Retention treats every unreleased lease as protected, including an expired lease whose provider create result is still ambiguous. Expiry makes a lease eligible for reconciliation, not retirement. A stale lease is released only after the associated provisioning job is terminal or provider reconciliation proves no clone operation remains; creation first releases a provably stale lease in the same transaction before relying on the unique active-machine constraint.

## GoldenSnapshotCreateIntent

Durably fences each snapshot-backed provider create against snapshot revocation,
base-generation revocation, and rollout disablement.

| Field | Type | Rules |
|---|---|---|
| `intent_id` | UUID text | Primary key |
| `snapshot_id`, `lease_id` | UUID text | FKs to the selected snapshot and active lease |
| `machine_id` | UUID text | Intended provisioning or recovery replacement identity |
| `purpose` | text | `provision` or `recover` |
| `rollout_generation` | bigint | Monotonic rollout configuration generation observed at creation |
| `state` | text | `pending`, `accepted`, `denied`, `activated`, or `cleaned` |
| `provider_create_action_id` | bigint nullable | Exact accepted provider action when known |
| `created_at`, `updated_at`, `completed_at` | text | Bounded lifecycle timestamps |

Intent creation takes the same compatibility/snapshot advisory lock as rollout changes
and revocation and fails closed if the snapshot, base generation, or rollout generation
is no longer eligible. Disabling rollout or revoking the snapshot/generation marks every
uncompleted intent denied in that same transaction. External provider calls remain
outside all locks. Immediately before create and after every accepted or ambiguous
response, provisioning/recovery re-checks the durable intent; denied work cannot activate
or route and is isolated and exactly cleaned up. `activated` intents are retained only
for the bounded operational audit window.

For recovery, the selected lease uses the intended replacement UUID. Before any
provider create, `claimUserMachineRecovery` durably moves the existing owner/runtime
row to `recovering`, adopts that same intended UUID, and stores the sealed old-server,
activation, and registration intent. A crash before that claim has no provider side
effect and reconciliation releases the lease; a crash after it can resolve the lease
through the durable recovering row and exact replacement labels.

The recovering `user_machines` row is itself the V1 durable recovery work record;
there is no separate unlinked in-memory recovery job. Its intended replacement
`machine_id` is the stable join key used by the active snapshot lease and exact
provider labels. The claim transaction persists these recovery-only fields before
the first provider call:

- `recovery_old_server_id`: the predecessor provider server that remains authoritative
  until replacement adoption and is then retired through durable cleanup
- `recovery_encrypted_payload`: bounded AES-GCM-sealed replacement registration token,
  database credential, and activation input; cleared after successful registration or
  terminal compensation
- `recovery_create_action_id`: the replacement provider create Action persisted before
  polling, or null until a create response supplies one

Together, `status = 'recovering'`, the replacement `machine_id`, and these fields are
the durable recovery-job link. Reconciliation queries recovering rows directly, opens
the sealed payload only inside the authorized worker, adopts or cleans the exact
labeled replacement, and never needs to infer the predecessor from provider state.

## GoldenSnapshotCleanup

Exact-resource cleanup queue for snapshot domain resources.

| Field | Type | Rules |
|---|---|---|
| `cleanup_id` | UUID text | Primary key |
| `snapshot_id` | UUID text nullable | Owning lifecycle row |
| `build_id` | UUID text nullable | Owning build attempt |
| `resource_type` | text | `builder_server`, `validation_server`, or `snapshot_image` |
| `provider_resource_id` | bigint | Exact positive ID |
| `provenance_key` | text | Exact expected immutable label tuple/hash |
| `reason` | text | Allowlisted bounded code |
| `status` | text | `queued`, `running`, `completed`, `failed`, `quarantined` |
| `attempts`, `next_attempt_at`, `lease_expires_at` | bounded | Retry/worker lease |
| `last_error_code` | text nullable | Coarse code only |
| `created_at` | text | Required enqueue timestamp |
| `completed_at` | text nullable | Terminal reconciliation timestamp |

A partial unique index on `(resource_type, provider_resource_id) WHERE completed_at IS NULL`
prevents duplicate unresolved cleanup work, including rows whose bounded automatic retry
budget is exhausted. Operator recovery requeues that same durable row; only confirmed
completion permits a later cleanup row for the provider resource. Before deletion,
reconciliation GETs the exact resource and verifies the provenance label tuple. A
mismatch leaves the provider resource untouched, moves
the cleanup row to explicit `quarantined` status with the bounded
`provenance_mismatch` code, and keeps or moves the owning snapshot to `quarantined`
for operator review. Automatic retries select neither terminal `failed` nor
`quarantined` cleanup rows.

There is intentionally no provider delete-Action column. The provider adapter treats DELETE acceptance as non-terminal and cleanup reaches `completed` only after bounded exact-ID GET reconciliation returns not found. This single GET-until-absent rule also covers providers or resource types that do not expose a durable delete Action.

Customer/recovery clone cleanup remains in the existing authoritative
`provider_deletion_queue`, keyed by `machine_id` plus exact provider server ID. Before
fallback it records the selected snapshot and immutable machine/snapshot label tuple in
the provisioning job/recovery provenance, then verifies that tuple before deletion or
adoption. A mismatch is quarantined and never deletes the provider resource. Keeping
customer clones in this established queue preserves existing machine cleanup and
authorization boundaries instead of duplicating them in snapshot-domain cleanup.

## Provisioning job additions

The existing `provisioning_jobs` row gains:

- `target_bundle_version`, `target_bundle_sha256`
- `image_source`: `unresolved`, `snapshot`, `clean_image`
- `snapshot_id`, `snapshot_lease_id`
- `activation_step`: `selecting`, `creating`, `created`, `activating`, `registered`, `cleanup_pending`, `fallback_pending`
- `provider_create_action_id`
- `fallback_reason` (coarse allowlisted code)

These fields make retries/resume explicit. Existing encrypted registration/Postgres payload handling remains unchanged.

## Running-machine provenance additions

The retained `user_machines` row gains nullable fields that become required whenever a
snapshot-backed provision or recovery is durably adopted:

- `source_snapshot_id`
- `source_base_generation`
- `target_bundle_version`
- `target_bundle_sha256`
- `recovery_old_server_id`, `recovery_encrypted_payload`, and
  `recovery_create_action_id` while `status = 'recovering'`; these are cleared after
  adoption/compensation and are not exposed through inventory responses

The registration/adoption transaction copies these values from the selected snapshot
and provisioning or recovery target before releasing the snapshot lease. Clean-image
machines keep `source_snapshot_id` and `source_base_generation` null but still persist
the exact target bundle provenance. These retained fields are the bounded inventory
source for base-generation or snapshot revocation after provisioning jobs are pruned;
provider image IDs and raw provider metadata are not copied onto customer rows.

## State-transition invariants

- Only `ready` snapshots are selectable.
- `ready` requires provider image ID, exact provenance, terminal successful image Action, `available` image status, matching architecture/disk constraints, and successful validation evidence.
- `quarantined`, `retiring`, and `deleted` are never selectable.
- A provider image may not be associated with two snapshot rows.
- A target can use exact or older source provenance only; SQL joins source and target
  `host_bundle_releases.build_time` through their version keys, and application policy
  revalidates. Registration `created_at` and snapshot `created_at` are never ordering
  inputs.
- Release/compatibility revocation is a conditional write that immediately removes selection eligibility.
- A durable revoked-base-generation marker is checked by enqueue and readiness; snapshot
  quarantine/build cleanup proceeds in bounded deterministic batches after the marker commits.
- Retirement first changes authoritative state, then queues provider deletion in the same transaction.
- Provider deletion completion conditionally advances `retiring -> deleted`; an absent provider image is idempotent success only after exact-ID verification.
