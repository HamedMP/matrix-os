# Research: Prebilling Provisioning

## Decision 1: Begin preparation only after Stripe creates an open Checkout Session

**Decision**: Keep compute, region, billing interval, acquisition, and agent selection ahead of checkout. When `POST /billing/checkout` successfully creates and durably finalizes an open Stripe Checkout Session, atomically enqueue one owner-bound preparation intent and durable provisioning job, then return the existing checkout URL. Do not call the provider merely because a user highlighted a compute card or opened the billing UI.

**Rationale**: At that point Matrix has every immutable provisioning input and a server-owned payable session, while checkout time can overlap the build. Stripe Checkout Sessions support an explicit expiration from 30 minutes to 24 hours; V1 uses a 30-minute policy window plus one minute of API transport/clock-skew headroom so Stripe does not reject a request that arrives just under its minimum. The unpaid-preparation lease and payment window share that authority ([Stripe Checkout Session create reference](https://docs.stripe.com/api/checkout/sessions/create)).

## Decision 2: Add a dedicated preparation intent instead of a billing bypass flag

**Decision**: Add `prebilling_provisioning_intents` as the control-plane source of truth linking one checkout attempt, one owner/runtime slot, one machine, and one bounded lease. Add an explicit `activation_state` to `user_machines` and an explicit `authorization_basis` to `provisioning_jobs`. Extend checkout selection equality to include server type and agent choices. Do not add `skipBilling`, reuse preview authorization, or weaken the normal `customerVpsService.provision()` entitlement contract.

**Rationale**: Billing state, provider progress, and access authorization move independently. A dedicated intent provides an auditable state machine and a revision fence without overloading `billing_checkout_attempts.status` or `user_machines.status`. Existing unique active-slot indexes and provisioning-job leases remain useful.

## Decision 3: Reuse the durable provisioning job with a narrow second authorization basis

**Decision**: Refactor the common machine/job creation path so entitled provisioning uses `authorization_basis=billing_entitlement` and prebilling preparation uses `authorization_basis=prebilling_intent`. Before every provider create or retry, the worker must re-resolve the selected basis and fail closed if the intent is no longer open, owner/slot/config matching, unexpired, and feature-enabled for continuation.

**Rationale**: `provisioning_jobs` already supplies durable queueing, leases, retry budgets, exact provider-create action reconciliation, snapshot selection, and restart recovery. Duplicating a second provider worker would recreate the hardest failure modes and drift from golden-snapshot activation.

## Decision 4: Preserve the signed subscription projection as the only access grant

**Decision**: Include only the opaque preparation-intent ID in both Checkout Session metadata and `subscription_data.metadata`. The existing signed `customer.subscription.created`/`updated` projection validates that ID against the local checkout, Clerk user, runtime slot, plan/Price, and selections, then transactionally marks the intent and machine authorized. `checkout.session.completed`, the browser return, invoices, local readiness, and the preparation worker never grant access.

**Rationale**: Stripe documents that `subscription_data.metadata` is copied to the created Subscription and therefore appears on subscription events, while top-level Checkout metadata appears on Checkout Session events ([Stripe metadata documentation](https://docs.stripe.com/metadata)). This preserves the current exact-slot entitlement authority and makes event reordering safe.

## Decision 5: Keep prebilling machines owner-bound but unreachable

**Decision**: Create the machine as provisioning class `customer` with `activation_state=awaiting_billing`. It is permanently bound to the initiating Clerk user and may boot/register, but routing, app-session exchange, customer inventory selection, recovery, resize, resume, terminal, and other owner access paths require both normal billing authorization and `activation_state=authorized`. Operator inventory may show a coarse prebilling state.

**Rationale**: Owner binding lets the exact computer survive authorization and prevents cross-owner reuse. A second activation fence provides defense in depth beyond the existing entitlement checks while keeping old code rollback-safe: older code still blocks the machine through the established billing gate.

## Decision 6: Reclaim only after authoritative checkout expiry

**Decision**: Set the Stripe session and local preparation lease to the 30-minute policy window plus one minute of safety headroom. The cleanup reconciler may claim cleanup only when the local lease is due, a bounded Stripe retrieval or processed webhook proves the session `expired`, no effective slot entitlement exists, the intent revision is unchanged, and no newer active intent exists. A completed session without a subscription remains `payment_settling`, triggers alerts, and is never auto-deleted as abandonment. Use a dedicated durable `prebilling_cleanup_actions` worker with claim leases and cancellation fencing, modeled on `billing_runtime_actions`; it expires/reconciles Checkout before handing the exact provider ID to deletion and does not mark cleanup complete until provider absence is confirmed.

**Rationale**: A browser cancel is not authoritative, webhook delivery can lag, and a local timer alone can race a just-completed checkout. Stripe manages Checkout Session status and expiration; requiring `expired` distinguishes abandonment from delayed subscription projection.

## Decision 7: Keep the HTTP surface stable and extend journey annotations

**Decision**: Do not add a public preparation endpoint. Extend the existing strict `POST /billing/checkout` body usage so the shell sends the already-supported `developerTools` field, and let the route orchestrate preparation through a registration-time dependency. Preserve the `{ url }` success response. Extend `GET /api/journey` with an optional coarse `preparation` annotation and a `resume_checkout` next action for an open session. Keep `/api/auth/provision-runtime` entitlement-only for legacy paid-without-machine recovery.

**Rationale**: Checkout is the user action that authorizes preparation, so a second client mutation would reintroduce the missing-click problem. A stable checkout response avoids breaking mobile/device clients; the journey remains the server-owned resumption surface.

## Decision 8: Use a feature flag, strict capacity controls, and continuation-safe rollback

**Decision**: Add an off-by-default primary-onboarding feature flag, deterministic rollout percentage/allowlist, and one database-enforced global active-count ceiling across all offered machine sizes. Serialize admission with the existing PostgreSQL advisory lock and admit only while `activeCount < maxActive`. Apply per-account creation limits in Postgres and trusted network-origin limits at the edge rather than trusting forwarded headers in application code. Turning the flag off stops new intents but keeps workers reconciling, authorizing, or cleaning existing intents to terminal states.

**Rationale**: Prebilling work has real cost before card authorization. A kill switch that also stops cleanup would leak resources, while application parsing of untrusted forwarding headers would violate the constitution.

## Decision 9: Authorization repairs paid-without-machine state server-side

**Decision**: In the same signed subscription-projection workflow that authorizes a valid preparation, guarantee that an entitled primary slot has either the bound live machine or one durable normal provisioning job. If prebilling preparation never enqueued, failed before a usable machine existed, or was authoritatively cleaned, enqueue the existing entitlement-backed provisioning path without requiring another browser click.

**Rationale**: Preparation is an optimization, while a signed subscription is a durable customer entitlement. This closes the historical gap where checkout succeeded but the browser never issued `/api/auth/provision-runtime`.

## Decision 10: Deliver as one monitored implementation PR plus a separate public-docs PR

**Decision**: At the requester's explicit delivery direction, keep the flag-off persistence/worker foundation, checkout/authorization integration, and shell/journey/observability work as reviewable phase commits in one monitored PR. Keep the PR under the repository's hard size boundary; stop and split before publication if it would exceed 3,000 additions or 50 files. Publish the user-facing flow change separately in `FinnaAI/matrix-os-site` after the implementation contract is stable.

**Rationale**: The requester explicitly asked for one PR and for every commit and the PR to use the Nima-Naderi GitHub identity. Phase commits keep trust boundaries auditable while the feature flag prevents partial exposure.
