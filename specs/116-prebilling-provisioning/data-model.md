# Data Model: Prebilling Provisioning

## Modeling Rules

- Checkout state, physical machine state, and access authorization are independent axes.
- Every new column is additive and rollback-safe. Existing machines default to `authorized`; the feature flag remains off until all readers understand the new state.
- All control-plane persistence stays in platform PostgreSQL through Kysely.
- Customer machines are owner-bound from creation. An abandoned machine is destroyed, never reassigned.
- State transitions use revision-checked writes or row locks inside transactions; no read-then-write concurrency decisions occur across transaction boundaries.

## `prebilling_provisioning_intents`

Durable source of truth for the reversible work Matrix performs while one primary-computer Checkout Session is payable.

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | `text` | UUID primary key, generated before the Stripe create call so it can be placed in metadata |
| `checkout_attempt_id` | `text` | Unique foreign key to `billing_checkout_attempts` |
| `clerk_user_id` | `text` | Authenticated owner; never accepted from the request body |
| `runtime_slot` | `text` | V1 requires `primary` |
| `plan_slug` | `text` | Validated immutable selection snapshot |
| `billing_interval` | `text` | Validated immutable selection snapshot |
| `server_type` | `text` | Validated provider-neutral compute shape |
| `region_slug` | `text` | Validated region |
| `developer_tools` | `jsonb` | Canonical sorted array of supported tool IDs, size-capped before persistence |
| `state` | `text` | State machine below |
| `revision` | `integer` | Starts at 1; every transition increments it |
| `machine_id` | `text nullable` | Unique foreign key to `user_machines` once allocated |
| `stripe_session_expires_at` | `timestamptz nullable` | Exact server-returned Checkout expiry |
| `lease_expires_at` | `timestamptz nullable` | Never later than the Stripe expiry for V1 |
| `reserved_hourly_cost_micros` | `bigint` | Legacy compatibility field; retained without migration and written as 0; not part of the provisioning domain or admission decision |
| `ready_at` | `timestamptz nullable` | Physical readiness timestamp; does not grant access |
| `authorized_at` | `timestamptz nullable` | Signed subscription-projection promotion timestamp |
| `cleaned_at` | `timestamptz nullable` | Set only after provider absence and local secret cleanup are confirmed |
| `last_error_code` | `text nullable` | Bounded internal code, never a raw provider error |
| `created_at`, `updated_at` | `timestamptz` | Audit timestamps |

Indexes and constraints:

- Unique active intent for `(clerk_user_id, runtime_slot)` where state is nonterminal.
- Unique `checkout_attempt_id` and unique non-null `machine_id`.
- Check constraints for V1 `runtime_slot='primary'`, the nonnegative legacy reservation field, and recognized states.
- GIN is not needed for `developer_tools`; selection comparison uses the canonical serialized array.

Intent states:

```text
awaiting_checkout
    -> preparing                 Stripe session finalized open; job is durable
    -> preparation_deferred      checkout remains valid; no provider capacity admitted
    -> checkout_failed           no provider work was admitted

preparing
    -> ready_waiting_for_billing physical readiness only
    -> payment_settling          checkout completed; subscription projection pending
    -> preparation_failed        provider path exhausted; checkout remains valid
    -> cleanup_pending           Stripe authoritatively expired and no entitlement
    -> authorized                signed subscription projection matched

ready_waiting_for_billing
    -> payment_settling | cleanup_pending | authorized

payment_settling
    -> authorized
    -> preparation_failed        only for physical failure; never abandonment cleanup

preparation_failed
    -> authorized                entitlement creates/uses normal provisioning fallback
    -> cleanup_pending           only after authoritative Stripe expiry and no entitlement

preparation_deferred
    -> authorized                entitlement creates one normal provisioning job
    -> cleaned                   Stripe expired; no provider resource existed

cleanup_pending
    -> authorized                cancellation fence wins before irreversible deletion
    -> cleaned                   provider absence and secret cleanup confirmed
```

`checkout_failed`, `authorized`, and `cleaned` are terminal for preparation admission. Authorization can still reconcile a historically `cleaned` intent by creating a normal entitlement-backed job; it never resurrects or reassigns the deleted machine.

## Changes to Existing Tables

### `billing_checkout_attempts`

Add:

- `prebilling_intent_id text nullable unique`
- `stripe_session_expires_at timestamptz nullable`

Correct selection equality so an existing payable attempt is reusable only when all of these match: plan, interval, runtime slot, server type, region, canonical developer-tools list, acquisition context, and validated return path. This closes the current gap where developer tools and server type are not compared.

The existing attempt lifecycle remains `creating -> open -> paid|expired|failed`. Checkout status never grants machine access.

### `billing_subscriptions`

Add nullable `prebilling_intent_id` for an auditable exact binding. It is populated only after signed event processing validates Stripe metadata against the local checkout attempt, Clerk owner, runtime slot, and recognized Price.

### `user_machines`

Add:

- `activation_state text not null default 'authorized'`
- `prebilling_intent_id text nullable unique`
- `activation_authorized_at timestamptz nullable`

Recognized activation states are `awaiting_billing` and `authorized`. Existing `status` continues to represent physical lifecycle (`provisioning`, `running`, and existing failure/deletion states). A prebilling machine may be physically `running` while still inaccessible.

### `provisioning_jobs`

Add:

- `authorization_basis text not null default 'billing_entitlement'`
- `prebilling_intent_id text nullable`

Recognized bases are `billing_entitlement` and `prebilling_intent`. Before each provider-create attempt or retry, the worker resolves the basis again. The prebilling basis is valid only for the exact owner, primary slot, selections, nonterminal intent revision, and unexpired payable Checkout Session.

## `prebilling_cleanup_actions`

Durable, leased, cancelable cleanup state machine. It is separate from the general provider-deletion queue because prebilling deletion requires a billing recheck and an intent revision fence at the irreversible boundary.

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | `text` | UUID primary key |
| `intent_id` | `text` | Foreign key to preparation intent |
| `machine_id` | `text nullable` | Exact local machine identity |
| `expected_intent_revision` | `integer` | Stale-work fence |
| `provider_machine_id` | `text nullable` | Exact provider identity after reconciliation |
| `phase` | `text` | `expire_checkout`, `reconcile_checkout`, `recheck_authorization`, `delete_provider`, `reconcile_delete`, `delete_local_secrets`, `finalize` |
| `status` | `text` | `queued`, `running`, `retryable`, `completed`, `canceled`, `failed` |
| `attempt_count` | `integer` | Bounded retry counter |
| `execute_after` | `timestamptz` | Backoff scheduling |
| `lease_owner`, `lease_expires_at` | nullable | Durable worker claim |
| `cancel_requested_at` | `timestamptz nullable` | Set by authorization before promotion |
| `last_error_code` | `text nullable` | Bounded diagnostic code |
| `created_at`, `updated_at`, `completed_at` | timestamps | Audit timestamps |

Only one unresolved cleanup action may exist per intent. A worker must renew or release its lease; abandoned claims become retryable. `completed` means the provider reports the exact machine absent and platform-owned transient secrets/credentials have been deleted.

## Global capacity admission

Global admission must not use an in-memory counter or an unlocked aggregate query. The admission transaction takes the PostgreSQL advisory transaction lock for the global prebilling capacity domain, counts active unpaid preparation states, and admits only when `activeCount < maxActive`. Machine size and the legacy reservation column do not participate. Paid intents bypass unpaid admission capacity while preserving their owner/slot fences and idempotent machine/job creation.

## Atomic Operations

### Checkout claim before Stripe

1. Authenticate the Clerk session and derive `clerk_user_id` server-side.
2. Validate the complete request with Zod and canonicalize developer-tool IDs.
3. In one transaction, lock the owner/slot scope, reuse or reject any payable attempt, and insert a `creating` checkout attempt plus `awaiting_checkout` intent with a generated opaque ID. This records identity but does not yet reserve provider capacity.
4. Call Stripe outside the transaction with a bounded timeout and the checkout-attempt ID as idempotency key. Put the preparation-intent ID in both metadata scopes.
5. On definite failure, transactionally mark both records failed. On ambiguity, reconcile Stripe by idempotency/attempt identity before deciding.

### Checkout finalization and job admission

In one transaction, enforce `checkout_attempt.status='creating'` and `intent.state='awaiting_checkout'` in the update predicates, record the open Stripe session and exact expiry, and take the global capacity advisory lock. If admitted, write the legacy reservation field as zero, create the `awaiting_billing` machine plus `prebilling_intent` job through the shared creation path, and transition the intent to `preparing`. If rollout or capacity denies admission, transition to `preparation_deferred` with a zero legacy reservation and no machine/job; the cohort still receives the safe Checkout Session and signed authorization later guarantees normal provisioning.

### Signed subscription promotion

In one transaction, upsert the authoritative subscription projection, lock the owner/slot and intent, validate exact metadata and selection linkage, cancel unresolved cleanup, transition the machine activation state and intent to `authorized`, keep the legacy reservation field at zero, and ensure the slot has either the bound nondeleted machine or one entitlement-backed provisioning job. Event replays are idempotent.

### Cleanup claim and deletion fence

Claim work with `FOR UPDATE SKIP LOCKED` or an equivalent revision-checked lease update. Immediately before `delete_provider`, start a transaction that locks the intent, cleanup action, exact machine, current subscription projection, and newer owner/slot intents in a documented order. Advance to deletion only when Stripe is authoritatively expired, no effective entitlement exists, `expected_intent_revision` still matches, no cancellation is requested, and no newer intent exists. Commit the phase transition before the external call; reconcile ambiguous deletion until absence is confirmed.

## Data Retention and Ownership

- Provider instances, generated host credentials, routing registrations, and temporary bootstrap secrets for abandoned preparations are deleted during cleanup.
- Customer home data is never reused or inspected. If boot created owner data, it is destroyed with that owner's abandoned machine.
- Checkout, subscription, and security audit history retains only identifiers and bounded state required for accounting, fraud prevention, and incident reconstruction; raw provider errors and secrets are excluded.
- Terminal records may be minimized or pseudonymized under the existing retention policy, but ownership must never be reassigned.
