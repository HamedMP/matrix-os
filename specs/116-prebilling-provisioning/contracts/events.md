# Event and Telemetry Contract

## Stripe Metadata Binding

Checkout creation writes the same opaque preparation-intent ID to:

- Checkout Session top-level metadata, for Checkout events.
- `subscription_data.metadata`, so the resulting Subscription carries it into subscription events.

Also retain the existing server-owned checkout-attempt, Clerk owner, region, and runtime-slot metadata required by current reconciliation. Metadata is a correlation hint, not authority. Signed event handlers must look up the local attempt and prove exact owner, slot, recognized Price/plan, session/subscription relationship, and immutable selection before promotion.

The browser success URL, Checkout Session `completed` state, invoice events, metadata alone, and provider readiness cannot authorize access. Only the existing signed subscription projection can do so.

## Lifecycle Events

Internal domain events are emitted after their database transaction commits. Consumers must tolerate duplicates and reordering.

| Event | Required bounded fields |
|---|---|
| `prebilling.intent.created` | correlation ID, rollout cohort, plan class, region class |
| `prebilling.admission.deferred` | reason code (`flag_off`, `not_eligible`, `account_limit`, `origin_limit`, `count_ceiling`) |
| `prebilling.job.started` | correlation ID, retry ordinal, snapshot-path boolean |
| `prebilling.machine.ready` | correlation ID, elapsed bucket |
| `prebilling.checkout.completed` | correlation ID, elapsed bucket |
| `prebilling.subscription.authorized` | correlation ID, projection event type, fallback-job boolean |
| `prebilling.cleanup.claimed` | correlation ID, age bucket, phase |
| `prebilling.cleanup.completed` | correlation ID, elapsed bucket, provider-reconciled boolean |
| `prebilling.cleanup.canceled` | correlation ID, cancellation reason (`authorized`, `newer_intent`, `checkout_payable`) |
| `prebilling.failure` | correlation ID, component, bounded error code, retryable boolean |

Never include raw provider errors, Stripe secrets, Checkout URLs, IPs, hostnames, provider machine IDs, Clerk user IDs, database messages, or filesystem paths in analytics events. Operational logs may use access-controlled correlation identifiers and exact internal diagnostics under existing redaction rules.

## Metrics

Low-cardinality counters:

- checkout attempts by preparation result and rollout cohort
- preparation jobs started/succeeded/failed/reconciled
- authorization promotions, cleanup cancellations, fallback jobs, and duplicate-prevention conflicts
- cleanup actions by terminal result and bounded failure code

Gauges:

- active unauthorized preparations
- cleanup backlog count and oldest actionable age
- payment-settling intents awaiting subscription projection
- entitled primary slots with neither a nondeleted machine nor an active provisioning job

Histograms:

- checkout-open to provider-start
- provider-start to physical-ready
- checkout-completed to subscription-projected
- subscription-authorized to runtime-ready
- provisioning/checkout overlap
- preparation-created to cleanup-complete

## Alerts and Rollout Stops

Page or automatically stop new admission when any of these breach their configured threshold:

- an authorized machine enters provider deletion or an authorization-vs-cleanup invariant fails
- active unauthorized count exceeds its hard ceiling
- duplicate active machine/intent constraint errors appear
- cleanup oldest age threatens the 35/45-minute objective
- payment-settling backlog grows beyond the signed-event delivery allowance
- entitled-without-machine-or-job is nonzero beyond reconciliation grace
- authorization-to-ready latency or provider failure rate regresses materially against the current postbilling cohort

Turning admission off must not stop subscription projection, normal entitlement provisioning, preparation reconciliation, or cleanup workers.
