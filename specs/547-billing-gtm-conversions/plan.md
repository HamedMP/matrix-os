# Stripe checkout and first-payment measurement

Owner: Hamed. Scope: hosted Matrix web checkout, landing consent, and acquisition measurement.

Tracking: [ENG-159 — launch activation and paid-cohort measurement](https://linear.app/matrix-os/issue/ENG-159/implement-and-reconcile-the-launch-activation-and-paid-cohort). This change supplies consented Stripe acquisition events; the broader dashboard remains outside this PR.

Google configuration: reuse landing container `GTM-5D8ZT4HF` and Google tag Matrix (`AW-18486552087` / `GT-5MCTD42L`). The Matrix OS Website & App stream (`G-JJS1LJGEBS`) is connected as another destination. Send billing events through a GA4 event tag; do not install a second base Google tag.

## Contract

- Keep `billing=success` / `checkout=success`; add Stripe's literal session-ID token to every subscription success URL, including configured overrides and device/runtime return paths.
- Verify the session server-side before displaying final `currency`, `plan`, `interval`, `amount`, `transaction_id` and `trial` URL fields or pushing an event. Query values never authorize access or establish payment.
- `trial_started` represents a completed, explicitly trialing subscription with zero collected payment. `purchase` requires positive settled payment. GA4 item value excludes tax; URL amount and `amount_paid` include tax. Use final discounted Stripe totals and customer presentment currency, with proportional localized tax allocation when Stripe only provides the converted total.
- The first positive subscription invoice sends a GA4 purchase with `trial_converted=true` when the subscription started as a trial. Exclude prorations, zero invoices, renewals and unsupported partial/mixed payments from acquisition tracking. The first-paid marker is per subscription, so additional computers are separate acquisitions.

## Auth matrix

| Route | Authentication | Input / result |
| --- | --- | --- |
| GET `/billing/tracking.js` | Public, hosted only | Validated configured GTM ID; no secrets or customer data. |
| GET `/billing/checkout-result` | Existing Clerk/platform browser session | Bounded `cs_…` ID; Stripe `client_reference_id` must equal the signed-in owner; no-store response. |
| POST `/billing/webhooks/stripe` | Stripe signature + existing account-deletion guard | Existing 1 MiB limit; positive invoice and server-written metadata required for measurement. |

## Wiring and failure behavior

Extract the existing webhook handler from the oversized billing composer before adding the invoice hook. The Stripe adapter performs bounded tracking reads. Every hosted shell and platform return page loads one same-origin tracking asset. Defaults for Google consent precede GTM initialization; self-hosted documents skip the asset.

The landing page mirrors its existing explicit consent choice into an expiring secure parent-domain cookie. At checkout, accepted consent and an existing GA client cookie yield an attribution snapshot. Persist the snapshot per checkout attempt so ambiguous Stripe retries cannot change idempotent request metadata. No emails, names or payment credentials enter the tracking payload.

A dedicated additive migration scope creates owner-bound attribution snapshots and a first-paid acquisition outbox. Enqueue inside the billing webhook transaction. Unique subscription and invoice constraints handle event replays and invoice renewals; a conditional lease update admits one sender across processes. Network calls happen outside transactions. Deliver during the invoice request (important on request-throttled Cloud Run) and periodically while the platform is active; return retryable webhook errors for failed immediate delivery. A crash after Google accepts but before local acknowledgement can resend the same transaction ID; GA4 purchase deduplication is the final boundary.

Browser receipts are capped at 128. Remove the Stripe session token after resolution so refreshes do not resend when storage is unavailable. Preserve existing return/device parameters. Expire outbox payloads after 72 hours; clear identity payloads after delivery while retaining subscription acquisition tombstones. Expire checkout snapshots after seven days. Account deletion erases both owner-bound tables. Shut down the delivery timer and await its active batch before DB teardown.

## Completion evidence

- Focused unit/integration tests: owner checks, forged query values, paid/trial/failed checkout, discounts/tax/presentment, repeat refresh, blocked storage, first trial charge without the browser, duplicate webhook, renewal, concurrent delivery and failed-delivery retry.
- Repository type checks, pattern scan, React audit and hosted production shell build.
- Website consent tests and responsive billing documentation render.
- Separate site PR updates public deployment/billing docs and shared consent. App PR requires the pre-VPS platform/app-shell deployment plus customer VPS shell rollout; site PR requires landing deployment.
- Configure the Matrix GA4 web stream and private Measurement Protocol secret; validate with GTM Preview and GA4 DebugView. GA4/Ads publication and Git push require their respective authorization gates.
