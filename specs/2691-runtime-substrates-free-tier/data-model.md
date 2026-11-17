# Data model: Runtime substrates and the hosted free tier

All tables are in the platform Postgres database, accessed through Kysely. Owner data
models are unchanged, except the sync manifest record and the object layout described at
the end of this file.

## `user_machines` (changed)

| Column | Type | Notes |
| --- | --- | --- |
| `substrate` | text, not null, default `'vps'` | `vps` or `container`; check constraint |
| `generation` | integer, not null, default 1 | Bumped whenever compute is replaced |
| `substrate_ref` | text, null | Provider's identifier for the current container |
| `private_address` | text, null | Platform-reachable address of the current generation |
| `last_activity_at` | timestamptz, null | Owner activity observed by the platform |
| `started_at` | timestamptz, null | Start of the current session |

Existing rows backfill to `substrate = 'vps'`, `generation = 1`. `hetzner_server_id`,
`public_ipv4`, `server_type`, and `location` are already nullable and stay null for
containers. `runtime_token_epoch` is bumped together with `generation`.

Constraint: `substrate = 'container'` implies `provisioning_class = 'free'`. Constraint:
at most one non-deleted container runtime per `clerk_user_id` (partial unique index).

### Status values

`vps` keeps its existing values. `container` uses:

```text
provisioning -> stopped -> starting -> running -> quiescing -> stopped
                              |            |           |
                              v            v           v
                         failed_start   needs_recovery (flush failed)
running/stopped -> migrating -> (switch to a staged vps row: D10, below)
```

Every transition is a compare-and-set on `(machine_id, status, generation)`.
`running` plus `activation_state = 'authorized'` is what the funded-AI authorization
already requires, so no funding code branches on substrate.

### Upgrade and the machine row (D10, decided 2026-11-15)

**Decision**: the VPS is built on its own `user_machines` row, staged beside the
container row and kept outside the active-row unique indexes until the switch. The
container stays usable until the target is verified; rollback drops the target. Stack E
(T061 to T068) is unbuilt, so the mechanism below is a design direction; names marked
*proposed* do not exist in the code.

**Constraints, as the code stands:**

- A free runtime is one row with `runtime_slot = 'primary'`, `substrate = 'container'`,
  and `provisioning_class = 'free'`.
- Among non-deleted rows, `(clerk_user_id, runtime_slot)` and `(handle, runtime_slot)`
  are unique (`idx_user_machines_clerk_slot_active`, `idx_user_machines_handle_slot_active`,
  both `WHERE deleted_at IS NULL`), and an owner has at most one container row.
- `substrate = 'container'` requires `provisioning_class = 'free'`.
- The customer provisioning path (`findExistingProvisioningMachine` in
  `packages/platform/src/customer-vps-support.ts`, used by
  `customer-vps-provision.ts`) finds the owner's active row for the requested slot and,
  unless it has failed, answers with that row. Called unchanged for the `primary` slot, it
  returns the container row and provisions nothing.
- Owner objects sit under `matrixos-sync/{ownerId}` for the `primary` slot
  (`buildSyncStoragePrefix`), keyed by owner and slot, not machine id. Any other slot maps
  to a different prefix.
- Funded-AI rows are keyed by machine id.

**Staging.** The target row is inserted when the migration reaches `provisioning`, and
its id is recorded in `runtime_migrations.target_machine_id`. While staged it must not
collide with the source in either slot index. Two ways to get there, to be chosen in T061:

- *Proposed*: a staging slot value reserved for upgrades (for example `upgrade`). It
  needs no index change, and the handle stays the owner's, since the handle index is per
  slot. The target VPS must still restore from and write to the `primary` prefix, so the
  staged row's sync scope is pinned to `primary` rather than derived from its slot.
- *Proposed*: a staging status, with both slot indexes rebuilt to exclude it. The target
  keeps `primary` and the prefix needs no special case, but the change touches two
  indexes every paid row depends on.

Either way, the target is provisioned through the customer path with an explicit target
(so it does not answer with the container row), and it carries `provisioning_class =
'customer'`, `substrate = 'vps'` from insertion. Session routing, `/vm/<handle>`, journey,
device sign-in, the reaper, the orphan reconciler, and the paid fleet jobs must ignore a
staged row; until the switch, the owner resolves only to the container.

**Switch** (one transaction, after verification, under the per-owner funding lock): soft-
delete the container row (`deleted_at`), take the target out of staging into `primary`
active state, re-point funded-AI rows to the target machine id, and mark the migration
`completed`. The soft-delete happens first in the transaction, so the slot indexes see at
most one active `primary` row at every statement. Compute and the owner database are
deleted after commit (User Story 5, scenario 3).

**Read-only window.** From the start of the final sync (T063) until the switch commits or
the migration rolls back, the container accepts no writes: they are refused, never queued.
So the VPS restores exactly the state the final sync captured, and no write accepted
during restore or verification can be left behind (User Story 5, scenario 1).

**Rollback** (abandon or deadline): delete the staged target row and its VPS through the
existing deletion path, and return the container to writable. The container row is not
changed before the switch apart from its `migrating` status, so the source stays
routable and its data stays in place.

## `billing_entitlements` (changed)

`source` gains the value `free`; plan slug gains `matrix_free`. A free entitlement has
`max_runtime_slots = 1`. Access decisions treat it as active with the container
substrate only.

## `free_tier_invites` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `clerk_user_id` | text, primary key | |
| `invited_by` | text, not null | Operator identity |
| `created_at` | timestamptz, not null | |
| `consumed_at` | timestamptz, null | Set when the runtime is created |

## `container_owner_databases` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `clerk_user_id` | text, primary key | |
| `database_name` | text, not null, unique | Opaque generated identifier; never the handle or user id |
| `role_name` | text, not null, unique | Opaque generated identifier |
| `connection_limit` | integer, not null, default 5 | Applied to the role and the database |
| `size_limit_bytes` | bigint, not null | Enforced by the platform, not Postgres |
| `size_measured_at` | timestamptz, null | |
| `state` | text, not null | `active`, `fenced`, `deleting` |
| `password_epoch` | integer, not null | Equals the runtime generation that last rotated it; rotation also terminates the role's sessions |
| `size_bytes` | bigint, null | Last measured |
| `created_at`, `deleted_at` | timestamptz | |

The password itself is not stored; it is derived or held in the provider secret store.

## `runtime_storage_usage` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `clerk_user_id` | text, primary key | |
| `object_bytes` | bigint, not null | Maintained by the object broker in the same statement that authorizes a write |
| `object_count` | integer, not null | Files counted against the 50,000 limit |
| `updated_at` | timestamptz, not null | |

## `runtime_storage_objects` (new)

Per-key ledger, so overwrites and deletes adjust usage exactly. Primary key
`(clerk_user_id, object_key)`; cascades from `runtime_storage_usage`.

| Column | Type | Notes |
| --- | --- | --- |
| `bytes` | bigint, not null | Bytes held for the key |
| `counts_as_file` | boolean, not null | |
| `reservation_id` | uuid, not null | |
| `pending_until` | timestamptz, null | An authorized write the broker has not seen land, so an abandoned upload can be reconciled |
| `signed_until` | timestamptz, null | When the last signed upload URL for the key expires (about 16 min). While it is outstanding, a delete or smaller overwrite keeps the largest signed size held; the quota frees only after expiry |

## `runtime_migrations` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `migration_id` | text, primary key | |
| `clerk_user_id` | text, not null | One active migration per owner (partial unique index) |
| `source_machine_id` | text, not null, references `user_machines` | |
| `target_machine_id` | text, null | The staged VPS row (D10); set when the target is inserted at `provisioning` |
| `state` | text, not null | `requested`, `quiescing`, `final_sync`, `provisioning`, `restoring`, `verifying`, `completed`, `abandoned` |
| `inventory` | jsonb, null | Row counts, file manifest digest, app list, balances |
| `idempotency_key` | text, not null, unique | Stripe event id or client key |
| `attempt`, `last_error_code` | integer, text | Error codes only, never raw messages |
| `deadline_at`, `created_at`, `updated_at` | timestamptz | |

## Funded-AI tables (unchanged schema)

A container runtime gets rows in `ai_funded_runtime_policies` and
`ai_funded_runtime_balances` keyed by its machine id. On upgrade (D10), balance rows are
re-pointed to the target machine id in the same transaction that completes the
migration, under the per-owner funding advisory lock.

## Object layout

Corrected after S4. The earlier text said files live at `.../files/<path>`; current
writes do not. Keys sit under the owner's sync prefix, `matrixos-sync/{ownerId}` for the
primary runtime slot (`buildSyncStoragePrefix` in `packages/contracts/src/sync.ts`).

### Today (both substrates)

| Key | Content |
| --- | --- |
| `objects/sha256/<hex>` | One content-addressed blob per file |
| `staging/<uuid>` | Upload staging; hashed, then copied to `objects/` |
| `manifests/<version>-<sha256>.json` | One manifest generation |
| `files/<path>` | Legacy per-path keys; still readable, not written |
| `system/db/snapshots/*.dump`, `system/db/latest` | Owner Postgres dumps written by `matrix-db-backup.sh` |

The pointer to the accepted manifest is not an object. It is
`sync_manifests.accepted_manifest_key` in **owner Postgres**. A Postgres dump therefore
carries the manifest pointer, and it must be taken after the final manifest commit.

`matrix-restore.sh` restores only the Postgres dump. Home files come back through the
gateway mirror's `initialPull`.

### Added by this work (container profile first; the manifest schema change reaches both)

| Key or field | Content |
| --- | --- |
| `packs/<id>` | A plain ustar archive of about 16 MiB holding files of 256 KiB or less. `tar -x` can read it for break-glass recovery. Larger files stay in `objects/sha256/<hex>` |
| Manifest pack entry | `ManifestEntrySchema` gains `{ packKey, offset, size }` next to the existing hash and size, so a file can be read from a pack by range |
| `boot/<version>-<sha256>.tar` | The boot-set object: one archive written at every flush with owner-owned config (`system/*.json`, `soul.md`, `user.md`, `identity.md` and similar), `agents/custom`, owner app manifests, owner icons, and the `VACUUM INTO` copy of `system/matrix.db`. Template files come from the image |
| Manifest version reference to its boot set | So readiness can check that the boot set matches the accepted manifest |
| Dump key names | Seconds plus generation, replacing minute resolution (`%Y-%m-%dT%H%MZ`), which lets a stop and a quick restart overwrite one key |

Key names for packs and the boot set are proposals. Superseded bytes in packs need
repacking and garbage collection. The manifest for a large home is about 16 MB, so it is
sharded or written as deltas (plan.md, T047c); the sharded shape is not designed yet.

`system/matrix.db`, `-wal`, and `-shm` are excluded from file sync. Only the `VACUUM INTO`
copy inside the boot set is stored.

### Hydrated-manifest record

Needs-recovery and crash-window reporting need to know which manifest a runtime last
hydrated. Today that lives in local `.matrix-home-mirror/state.json`, which dies with the
container. The container profile records the hydrated manifest version and sha256 in
owner Postgres next to the accepted pointer. Exact column names are left to T047f.
