# Feature Specification: Card-Required Seven-Day Runtime Trial

**Feature Branch**: `codex/mat-362-card-required-trial`  
**Created**: 2026-08-19  
**Status**: In review
**Linear**: MAT-362

## Summary

Matrix offers one Stripe-native subscription trial for an account's first primary hosted computer. The product default is three days; operators may set `MATRIX_CARD_TRIAL_DAYS` to an integer from 1 through 30 for a controlled rollout. Stripe Checkout collects a card before Matrix provisions the VPS, charges $0 at trial creation, and automatically attempts the selected Starter, Builder, or Max price when Stripe's authoritative `trial_end` arrives. Checkout redirects never grant access; signed Stripe subscription and invoice webhooks project the entitlement used by provisioning and routing.

This specification supersedes the "no trials" requirements in `specs/084-stripe-runtime-plans/spec.md`. It also narrows that specification's dynamic-payment-method rule: trial Checkout is card-only and always collects a payment method, while paid and additional-computer Checkout continues to use Stripe's configured dynamic methods.

## Goals

- Offer the trial once per Matrix account, only for `runtime_slot=primary`, on every public runtime plan.
- Persist the server-decided trial duration on the durable Checkout attempt so provider retries use identical parameters.
- Treat Stripe subscription and invoice events as the only normal entitlement source of truth.
- Gate access immediately after the first failed post-trial charge and power off, but never delete, the VPS 24 hours later.
- Cancel a pending poweroff or automatically resume a stopped VPS when payment recovers.
- Preserve the existing three-day grace period for failures after a trial has converted and for established paid subscriptions.
- Explain the exact price, interval, trial end date, first-charge date, cancellation deadline, and card requirement before Checkout and throughout the trial.

## Non-Goals

- No-card trials, promotion-code trials, usage trials, trial extensions, or trials for additional computers.
- Inactivity hibernation, VPS deletion, disk deletion, or owner-data retention changes.
- Card fingerprint or email-alias fraud detection. Eligibility is scoped to the authenticated Matrix account.
- Changing the existing safe plan-resize policy.

## Source Of Truth And Invariants

- Clerk user ID is the account identity source of truth.
- Stripe is the payment, trial deadline, subscription, and invoice source of truth.
- Platform Postgres is the webhook-projected entitlement and durable runtime-action source of truth.
- A success/cancel redirect, browser query parameter, or client timer never grants or revokes access.
- The trial begins at Stripe's `trial_start`; a slow or failed VPS provision does not extend it.
- Canceling during the trial retains access until Stripe ends the trial. An unpaid end gates access and schedules suspension.
- Poweroff retains the machine row, provider server, disk, backups, home files, and owner Postgres data.
- Promotion codes remain independent invoice discounts and never implement trial duration.
- `MATRIX_CARD_TRIAL_DAYS` is the server-side offer source of truth, defaults to `3`, and fails startup/deployment validation outside `1..30`. Stripe's persisted `trial_end` remains authoritative after subscription creation.

## Eligibility And Checkout

Trial eligibility is serialized on a per-Clerk-account ledger row and evaluated with the Checkout attempt claim. An account is eligible only when all conditions hold:

1. `MATRIX_CARD_TRIALS_ENABLED=true`.
2. The requested slot is `primary`.
3. No historical Stripe subscription exists for the Clerk account.
4. The account has no consumed-trial timestamp.

The ledger reserves the trial against the active Checkout attempt. Duplicate or ambiguous Stripe requests reuse that attempt's persisted `trial_period_days`, even if the configured duration later changes. An expired/abandoned attempt releases the reservation for a fresh Checkout because no Stripe subscription was created. A verified `checkout.session.completed` event consumes the reservation immediately, and a verified `customer.subscription.created` event with `status=trialing` idempotently confirms consumption. Disabling the rollout flag or changing the duration affects only new offers and does not alter existing subscriptions or actions.

Eligible Checkout sessions use:

```ts
{
  mode: 'subscription',
  payment_method_types: ['card'],
  payment_method_collection: 'always',
  subscription_data: {
    trial_period_days: configuredTrialDays,
    trial_settings: {
      end_behavior: { missing_payment_method: 'cancel' },
    },
  },
}
```

Paid first purchases that are ineligible and all additional-computer purchases omit those trial/card-only overrides and begin billing immediately.

## Webhook Projection And Access

The signed webhook endpoint idempotently handles:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `invoice.paid`
- `invoice.payment_failed`

Subscription events project `trial_start` and `trial_end`. A conversion invoice must reference the stored subscription, use `billing_reason=subscription_cycle`, and be created at or after the stored trial deadline. The zero-value trial-creation invoice is not a conversion.

| Projected state | Runtime access | Machine action |
|---|---|---|
| `trialing`, before failure/end | Allowed | None |
| First post-trial invoice failed | Gated immediately | Queue `suspend` for +24 hours |
| Trial ended unpaid/canceled | Gated immediately | Queue `suspend` for +24 hours |
| Trial cancellation reversed before end | Allowed | Cancel the queued early-cancellation suspend |
| Payment recovered before action claim | Allowed | Cancel queued suspend |
| Payment recovered during/after suspend | Allowed | Queue immediate `resume` |
| Converted/established renewal failure | Existing three-day grace | Existing policy |

Duplicate and out-of-order events cannot clear a recorded conversion or regress a newer subscription projection. An invoice event older than the latest subscription event is accepted only when its outcome agrees with the newer subscription status (for example, a paid conversion invoice followed by `active`); a stale paid invoice cannot reopen a newer terminal subscription.

## Durable Runtime Actions

`billing_runtime_actions` stores idempotent `suspend` and `resume` jobs with one active job per machine/action, an execution deadline, claim lease, bounded attempt count, exponential retry schedule, and allowlisted generic failure code. The webhook transaction only writes projection/action state. Hetzner and runtime health calls run asynchronously in the platform reconciliation worker.

If billing reverses while a provider action is already running, the webhook records a durable cancellation request and queues the opposite action. The running action remains the per-machine fence until it returns or its bounded lease expires; only then can the compensating action be claimed. Provider operations receive the durable-action guard and recheck it before mutation boundaries, while status/health polling is interruptible. If cancellation lands in the final unavoidable interval around an external provider call, finalization detects it and gives the compensation reserved, bounded priority in the same worker pass even when the initial batch was full. This prevents suspend and resume provider mutations from running concurrently while guaranteeing convergence to the newest webhook-projected billing state after a worker crash or payment/shutdown race.

Machine transitions are guarded in their update statements:

```text
running -> suspending -> suspended
suspended -> resuming -> running
```

Suspension requests graceful provider shutdown and falls back to forced poweroff when graceful shutdown fails or does not settle. Resume powers on, waits for provider `running`, then waits for the public runtime `/health` endpoint before marking the machine `running`. A lease-expired action is reclaimable; repeated execution reconciles current provider/machine state before issuing another mutation.

## API And Authentication Matrix

| Route | Method | Auth source | Input validation | Public? |
|---|---|---|---|---|
| `/billing/status` | GET | Verified Clerk session | Bounded Zod runtime-slot query | No |
| `/billing/checkout` | POST | Verified Clerk session | Hono body limit + strict Zod selection | No |
| `/billing/portal` | POST | Verified Clerk session | Hono body limit + strict Zod return path | No |
| `/billing/webhooks/stripe` | POST | Stripe signature over bounded raw body | Stripe event parser plus allowlisted object projection | Provider-only |

`GET /billing/status` returns `trialOffer: { eligible, durationDays }` and trial start/end/conversion/failure timestamps in the entitlement. Server errors remain generic; provider names, identifiers, secrets, and raw error bodies are logged only on the server. Every Stripe, Hetzner, and runtime health request has a bounded timeout. The runtime health target uses the already validated provider-assigned public IPv4 and rejects redirects.

## Product Experience

Before Checkout, eligible users see "Start your {duration}-day free trial", "Card required", "$0 today", the exact selected price/interval beginning after the configured duration, the exact first-charge date, and "Cancel before this date to avoid being charged". The CTA is "Start {duration}-day trial". While an open or creating Checkout attempt reserves a trial, billing status and copy use that attempt's persisted duration even if operator configuration changes. An active non-trial Checkout, ineligible account, or additional-computer flow keeps immediate-payment language.

During a trial, the shared shell shows a persistent notice with days remaining, upcoming price/date, and a Customer Portal link. It becomes prominent during the final three days. Trial lifecycle telemetry is PII-free and covers started, reminder due, converted, payment failed, VPS suspended, and VPS resumed.

Stripe Dashboard production configuration must enable Stripe's trial-ending email and subscribe the production endpoint to `customer.subscription.trial_will_end` in addition to the existing subscription, invoice, and Checkout events.

## Verification

- Unit/integration tests cover eligibility serialization, Checkout parameters, retry persistence, trial projection, conversion recognition, zero-value invoice rejection, duplicate/out-of-order webhooks, immediate access gating, established grace, suspension cancellation, recovery resume, action leases/retries, provider-call idempotency, graceful-shutdown fallback, and payment/action races.
- Shell tests cover eligible, ineligible, active, expiring, failed, recovered, and additional-computer states.
- Stripe test mode and Test Clocks exercise successful and declined conversion through the configured trial duration; the canonical product test remains three days.
- Run targeted billing/VPS/UI tests, full tests and coverage, production shell build, and Canvas-first browser validation.
- Public pricing and billing documentation ships in a separate `matrix-os-site` PR (MAT-446).
