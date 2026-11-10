# Data model: Runtime substrates and the hosted free tier

All tables are in the platform Postgres database, accessed through Kysely. Owner data
models are unchanged.

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
running/stopped -> migrating -> (row becomes substrate 'vps') 
```

Every transition is a compare-and-set on `(machine_id, status, generation)`.
`running` plus `activation_state = 'authorized'` is what the funded-AI authorization
already requires, so no funding code branches on substrate.

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
| `updated_at` | timestamptz, not null | |

## `runtime_migrations` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `migration_id` | text, primary key | |
| `clerk_user_id` | text, not null | One active migration per owner (partial unique index) |
| `source_machine_id` | text, not null, references `user_machines` | |
| `target_machine_id` | text, null | Set at provisioning |
| `state` | text, not null | `requested`, `quiescing`, `final_sync`, `provisioning`, `restoring`, `verifying`, `completed`, `abandoned` |
| `inventory` | jsonb, null | Row counts, file manifest digest, app list, balances |
| `idempotency_key` | text, not null, unique | Stripe event id or client key |
| `attempt`, `last_error_code` | integer, text | Error codes only, never raw messages |
| `deadline_at`, `created_at`, `updated_at` | timestamptz | |

## Funded-AI tables (unchanged schema)

A container runtime gets rows in `ai_funded_runtime_policies` and
`ai_funded_runtime_balances` keyed by its machine id. On upgrade, balance rows are
re-pointed to the target machine id in the same transaction that completes the
migration, under the per-owner funding advisory lock.

## Object layout (unchanged)

Container runtimes write the same keys as a VPS: `matrixos-sync/{ownerId}/files/...`,
`.../manifest.json`, and `.../system/db/snapshots/*.dump` with `system/db/latest`.
