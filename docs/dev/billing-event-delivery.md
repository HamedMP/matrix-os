# Billing event delivery

Stripe remains the billing source of truth. PostHog events describe billing changes; they are not an authorization or revenue ledger.

The signed webhook route records Stripe event IDs with `ON CONFLICT DO NOTHING` in the same transaction as billing changes. Repeated deliveries of an already committed event do not publish telemetry again. A bounded request-local telemetry queue publishes only after commit, preventing rolled-back transactions from leaking lifecycle notifications. Subscription-scoped transaction advisory locks serialize status comparisons, including concurrent first inserts and invoice projections. No PostHog calls occur inside that transaction.

Each published webhook event includes a SHA-256 `delivery_key` derived from the Stripe event ID and the Matrix event name. Raw Stripe object IDs remain excluded. Destinations can use the key to recognize retries. This does not equate separate Stripe event IDs or eliminate a destination's ambiguous network-response window.

`matrix_billing_subscription_updated` remains an analytics snapshot on each applied update. Its `subscription_status_changed` flag distinguishes transitions from metadata updates. `previous_subscription_status` is absent on first observation. Status `active` is not proof that an invoice was paid. Consumers must not label it as payment received or drive a paid welcome email from it.

## Destination contract

- Contact upserts: `$identify` and `$set`; preserve subscription preferences and match stable Matrix user IDs.
- Signup welcome: `matrix_user_signed_up`, one enrollment per contact. The signup emitter must supply a usable email before event forwarding; do not rely on a later identify event arriving first.
- Computer ready: `matrix_vps_registered`, one onboarding enrollment per contact; repeated registrations should update state without another welcome email.
- Paid welcome: `matrix_billing_invoice_paid` with `amount_paid_minor > 0`, one enrollment per contact. Do not also enroll from checkout completion, active status, or trial conversion.
- Billing state notifications: require `subscription_status_changed = true`. For legacy events lacking the flag, use explicit legacy handling instead of treating missing as false or inferring a transition.
- Payment problems: choose one canonical invoice-failure trigger; do not enroll from both past-due state and trial-payment failure.
- Inactivity: use a maintained last-active timestamp and recheck current activity immediately before sending. Missing activity data must not be treated as inactivity.

Loops event requests support an `Idempotency-Key` header (up to 100 characters, deduplication for 24 hours). Repeated keys return HTTP 409 and should be handled as an already accepted event. One-time Loops enrollment is an additional guard for onboarding/paid-welcome workflows. It is not suitable for recurring invoices or repeated payment failures.

## Delivery limits

Telemetry remains best effort after commit. Process termination between commit and capture can lose an analytics notification; a durable transactional outbox would be needed for guaranteed eventual delivery. Do not replay historical lifecycle events into email workflows to repair contact coverage; use contact-only upserts/imports with workflow triggers disabled. An idempotency key alone cannot promise exactly-once delivery to Discord.

## Validation

`tests/platform/billing-telemetry-delivery.test.ts` exercises rollback followed by retry, committed duplicate delivery, unchanged state, actual transition, stale event suppression, and opaque delivery identifiers against the existing Postgres test harness. Billing route tests retain price and privacy assertions with the additional delivery metadata.

References: [Loops event API](https://loops.so/docs/api-reference/send-event), [Loops workflow triggers](https://loops.so/docs/workflows/triggers).
