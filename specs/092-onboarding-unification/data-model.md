# Data Model: Unified Onboarding State Machine (092)

All persistence is platform PostgreSQL via Kysely, added through the existing inline `migrate()` in `packages/platform/src/db.ts` (repo convention — no separate migrations directory). All timestamps are `timestamptz`, written server-side.

## Journey phase (derived, not stored)

```
account_required → plan_required → payment_settling → provisioning → first_run → ready
                        ↑                │   │              │
                        │  (open attempt │   │ (entitlement │ (timeout / provider
                        │   ages past    │   │  activates)  │  failure / token expiry)
                        │   window, or   │   ▼              ▼
                        └── expired/  ───┘  (paid attempt   provisioning_failed ──retry──→ provisioning
                            abandoned)       stays here,
                                             delayed:true past window)
```

- Exactly one phase per user per read (FR-001); derivation order in research.md R1.
- `payment_settling` is a **pre-activation** state gated on the entitlement being absent or status `incomplete` (R3). It distinguishes *confirmed payment* from an *unconfirmed open attempt*: a `paid` attempt (Stripe `checkout.session.completed` received, entitlement still propagating) sustains settling indefinitely and never re-shows the paywall (US3) — past the window it only sets `settling.delayed:true` with a `contact_support` action (FR-014). An `open` attempt sustains settling only *within* the window; past it with no confirmation it falls back to `plan_required` so an abandoned checkout does not trap the user. A **lapsed** entitlement (was active, now `canceled`/`ended`/`unpaid`/past grace) always wins over any stale attempt and routes to `plan_required`, so a churned subscriber is never trapped in settling. It leaves settling on first entitlement activation (→ `provisioning`), an unconfirmed `open` attempt aging past the window (→ `plan_required`), or `expired`/`abandoned` resolution (→ `plan_required`).
- `ready` carries a `readiness: ok | degraded` annotation (FR-025); annotation never regresses the phase.
- `provisioning` carries `progress` (stage + startedAt) only once a machine lifecycle record exists; in the pre-machine "start provisioning" sub-state (entitled, no machine yet, `nextAction.kind = start_provision`) `progress` is absent.
- `provisioning_failed` carries `retryable: boolean` (false once attempts ≥ cap, FR-008).
- Entitlement loss from any post-plan phase returns the user to `plan_required`; owner data untouched (FR-015).

## Changed table: `user_machines`

Existing (`db.ts:566-607`): `machine_id` PK, `clerk_user_id`, `handle`, `runtime_slot`, `status` (`provisioning|running|failed|recovering|deleted`), `provisioned_at`, `registration_token_hash`, `registration_token_expires_at`, `hetzner_server_id`, `deleted_at`, …

**New columns**

| Column | Type | Notes |
|--------|------|-------|
| `provisioning_stage` | text NULL | `creating_server \| booting \| registering \| finalizing`; set by provision/registration steps; exposed as journey `progress` |
| `failure_code` | text NULL | `registration_timeout \| provider_unavailable \| not_found \| boot_failed`; set on transition to `failed` |
| `attempt` | int NOT NULL DEFAULT 1 | Per-user attempt counter; copied+incremented when a retry retires a failed row |

**State transitions (enforced in `customer-vps.ts`, all inside transactions)**

| From | To | Trigger | Invariant |
|------|----|---------|-----------|
| — | `provisioning` | provision/retry | Insert + retire of prior `failed` row in ONE transaction; `SELECT ... FOR UPDATE` on user's rows (R12); unique `(clerk_user_id, runtime_slot) WHERE deleted_at IS NULL` holds at every instant |
| `provisioning` | `running` | `/vps/register` with valid, unexpired token | Registration for a retired/replaced/expired attempt is rejected (FR-010) |
| `provisioning`/`recovering` | `failed` | Reconciler: no server, server gone, or `registration_token_expires_at` passed (R2 gap fix) | Reconciler logs every correction (FR-030) |
| `failed` | retired (`deleted_at` set, status preserved) | User/CLI retry, or auto-retry while `attempt` ≤ cap | Provider server queued for deletion (FR-011) |
| `running` | `recovering` | `/vps/recover` | Old row retired + new attempt activated atomically; never two routable rows (FR-009) |
| any non-deleted | `deleted` | Account deletion / explicit destroy | In-flight provisioning cancelled, server reaped (edge case: account deletion mid-journey) |

## New table: `billing_checkout_attempts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `clerk_user_id` | text NOT NULL, indexed | |
| `stripe_session_id` | text NOT NULL UNIQUE | Idempotency key; webhook correlates by it |
| `status` | text NOT NULL | `open \| paid \| expired \| abandoned` |
| `created_at` | timestamptz NOT NULL | Settling window measured from here (default 10 min, env `BILLING_SETTLING_WINDOW_MS`) |
| `resolved_at` | timestamptz NULL | Set by webhook (`checkout.session.completed` → `paid`, `checkout.session.expired` → `expired`) |

- Written by `/billing/checkout` (status `open`) in the same flow that creates the Stripe session; `stripe_session_id` is the idempotency/correlation key the `checkout.session.*` webhook resolves by.
- Journey reads the newest row per user (R3): a `paid` row with entitlement not active ⇒ `payment_settling` indefinitely (never re-shows the paywall); an `open` row ⇒ `payment_settling` only within the window, then it no longer sustains settling and the user falls back to `plan_required`; `expired`/`abandoned` ⇒ `plan_required`. The window sets only the `delayed` annotation on a `paid` row.
- Rows older than 30 days swept by the existing reconciler interval (resource-cleanup policy); a still-`open` swept row becomes `abandoned`.

## New table: `onboarding_first_run`

| Column | Type | Notes |
|--------|------|-------|
| `clerk_user_id` | text PK | One record per user — survives machine replacement (FR-005) |
| `completed_at` | timestamptz NOT NULL | |
| `goal` | text NULL | `coding \| company_brain \| assistant` (spec 082 goal step) |
| `steps` | jsonb NOT NULL DEFAULT '{}' | Completed/skipped step map (bounded, Zod-validated ≤ 4 KB) |
| `source` | text NOT NULL | `gateway_ws \| shell_manual \| backfill` |

- Written by two paths with different conflict policies (R4): the gateway write-behind `POST /internal/first-run` (carries real `goal`/`steps`) upserts `ON CONFLICT (clerk_user_id) DO UPDATE` and is the only path that may replace a record; the off-read-path reconciler backfill for legacy users inserts `ON CONFLICT (clerk_user_id) DO NOTHING`, so a best-effort backfill can never clobber an authoritative gateway record in a race.
- The VPS-local `~/system/onboarding-complete.json` continues to be written as the owner-inspectable artifact but is derived (constitution I).

## New table: `onboarding_journey_events` (append-only telemetry)

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigserial PK | |
| `clerk_user_id` | text NOT NULL, indexed `(clerk_user_id, at)` | |
| `from_phase` | text NULL | NULL for first observation |
| `to_phase` | text NOT NULL | |
| `detail` | text NULL | e.g. `failure_code`, `confirmation_delayed` |
| `at` | timestamptz NOT NULL | |

- Written by the journey module when the computed phase differs from the latest event (write-behind; failure to write never fails the read — logged, not thrown).
- Source for SC-001/SC-009/SC-010 funnel metrics; mirrored to PostHog as `journey_phase_entered` (R13).
- Retention: rows older than 180 days swept by the reconciler.

## Validation rules (Zod, at route boundary)

- `/internal/first-run` body: `{ clerkUserId: string, handle: SAFE_SLUG, goal?: enum, steps?: bounded record, completedAt: ISO }`; `bodyLimit` 16 KB.
- `/api/journey/retry-provision` body: empty or `{ runtimeSlot?: SAFE_SLUG }`; `bodyLimit` 1 KB.
- `/billing/checkout` `returnPath`: must pass `resolveReturnPath` allowlist (R6) before being embedded in Stripe success/cancel URLs.
- Journey responses never include provider names, raw errors, internal hostnames, or machine IPs (error-policy pattern).
