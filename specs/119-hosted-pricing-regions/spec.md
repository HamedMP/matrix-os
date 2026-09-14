# Hosted Pricing and Regional Machine Catalog

**Status**: Implemented
**Date**: 2026-08-30

## Product contract

Matrix sells three monthly hosted-computer plans. The public prices are Starter
`$20`, Builder `$100`, and Max `$200`. Every plan is eligible for the existing
once-per-account, card-required three-day trial for the primary computer. New
annual Checkout sessions are not offered; existing monthly and annual Stripe
subscriptions remain valid through legacy Price-ID recognition.

The internal provisioning catalog resolves each plan/region pair to an exact
machine shape:

| Region | Starter | Builder | Max |
|---|---|---|---|
| Germany (`fsn1`, `nbg1`) | CPX22 · 2 CPU · 4 GB RAM · 80 GB disk | CPX42 · 8 CPU · 16 GB RAM · 320 GB disk | CPX52 · 12 CPU · 24 GB RAM · 480 GB disk |
| United States (`ash`, `hil`) | CPX21 · 3 CPU · 4 GB RAM · 80 GB disk | CPX31 · 4 CPU · 8 GB RAM · 160 GB disk | CPX41 · 8 CPU · 16 GB RAM · 240 GB disk |

Disk values are storage capacity, not memory. Provider and machine identifiers
in this table are an internal implementation contract and must not appear in
customer-facing billing responses, settings, or copy. The shared contracts catalog is
the source of truth for plan prices, regions, machine mappings, and closest
region selection. Platform entitlements, Checkout validation, provisioning,
the web shell, and the native desktop shell derive from that catalog.

## User experience

The hosted-computer configurator presents controls in this order:

1. computer power;
2. agents/developer tools to provision;
3. a compact, collapsed server-location disclosure.

The browser's IANA timezone selects the closest available location before the
user interacts. The fallback is Falkenstein when timezone detection is missing
or fails. Opening the location disclosure shows both Germany and US choices.
Changing the plan or region immediately updates the displayed customer-facing
capacity and location; it never exposes the provider SKU. Checkout copy shows monthly pricing only and explains the
three-day card-required trial when the account is eligible.

Active billing settings show the subscribed plan, the exact provider-neutral
location of the selected runtime (for example, Ashburn, Virginia), and the
recurring rate attached to that subscription. The rate comes from the Stripe
Price snapshot, including legacy Prices, rather than the current marketing
catalog. If the snapshot cannot be read, the UI shows the billing interval and
does not infer an amount.

## Billing and provisioning invariants

- Checkout accepts `monthly` only and rejects unknown plans, locations, and
  plan/server mismatches at the route boundary.
- The server recomputes the machine from the selected plan and region. A
  client-provided server type is only an assertion and must match.
- The durable Checkout attempt stores plan, interval, region, exact server
  type, selected agents, and trial duration. A paid/settling attempt is the
  provisioning source of truth; a later browser payload cannot replace it.
- Stripe subscription/webhook projections remain the entitlement source of
  truth. A Checkout redirect does not grant access.
- The Stripe Price attached to the subscription is the recurring-rate source
  of truth. Signed webhooks snapshot its minor-unit amount, currency, interval,
  interval count, and quantity. Existing rows are lazily reconciled through a
  bounded Stripe Price read and a Price-ID compare-and-set update.
- Stripe Invoice fields are the payment source of truth. `amount_due` and
  `amount_paid` are tracked separately from recurring Price data so taxes,
  credits, promotions, and failed collections are not reported as catalog
  revenue.
- Actual runtime placement and server type come from the persisted machine.
  Public status projects only the catalog-mapped location. Server-side product
  telemetry may include the provider and server type, but the browser contract
  never does.
- Current Stripe Price IDs override legacy catalog entries. Legacy entries
  exist only to project already-created subscriptions and cannot initiate a
  new Checkout.
- Stripe Checkout uses dynamic payment-method configuration for immediate
  purchases. Trial Checkout always collects a payment method under the
  existing card-required trial contract.
- Automatic tax remains enabled, and production rollout requires verified
  Stripe tax registrations.

## Security architecture

| Route | Authentication | Input boundary | Error policy |
|---|---|---|---|
| `POST /billing/checkout` | Clerk session | bounded body; strict Zod plan, monthly interval, region, server assertion, runtime slot, and agent schemas | generic 4xx/5xx; provider details server-only |
| `GET /billing/status` | Clerk session | strict optional runtime-slot query | provider-neutral placement and nullable authoritative recurring rate; generic failures |
| `POST /api/auth/provision-runtime` | verified Clerk token | bounded body; strict runtime, location, server, and agent schemas; paid attempt overrides browser choices | generic provisioning errors |
| `POST /billing/webhooks/stripe` | Stripe signature | bounded raw body plus allowlisted event projection | non-2xx on failure so Stripe retries |

All external Stripe and provisioning calls retain bounded timeouts. No new
in-memory registries or file I/O are introduced. Existing atomic
Checkout-attempt and trial-ledger transactions remain in force. Price backfill
performs the external read outside a transaction, then fences the database
update by both subscription ID and the expected Price ID.

## Failure and rollout behavior

- Missing current monthly Price IDs fails Checkout closed.
- Missing or temporarily unavailable legacy Price data leaves the displayed
  amount empty while preserving access and retrying on a later status read.
- Malformed or oversized legacy Price JSON fails configuration parsing closed.
- Unknown browser timezones use the deterministic Falkenstein fallback.
- An interrupted deployment leaves existing subscriptions recognizable as
  long as old Price IDs were loaded into the legacy catalog before rotation.
- Deploy the platform/app-shell service for the pre-VPS experience. A customer
  host-bundle release does not update the no-VPS billing surface.

## Verification

Tests cover catalog completeness, closest-region defaults, all EU/US machine
mappings, monthly-only Checkout, mismatch rejection, legacy Price recognition,
Stripe parameters, authoritative post-payment provisioning, selector order,
collapsed location disclosure, and native-shell parity. Frontend changes also
require React Doctor and current screenshot evidence under the repository's
review gates.
