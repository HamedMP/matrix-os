# Jev operator pricing review

## Problem and behavior

The immutable Jev input price was valid only through September 30, 2026. An unchanged price still became unavailable on October 1, blocking the Inbox workflow before upstream dispatch. Operators must be able to attest a new, bounded review of the same rate without rebuilding application source.

The reviewed rate remains `typesafe-jev-input-2026-09`: 42 nanoUSD per input token ($0.042 per million), zero output cost. Provider reference: https://developers.cloudflare.com/ai/models/typesafe/jev/. A changed rate requires a new reviewed code/pricing version; environment configuration cannot alter rate, billing provenance, or settlement arithmetic.

## Configuration authority

Only trusted Relay deployment configuration supplies this attestation; requests, prompts, recipes, and owner credentials cannot supply it.

| Environment setting | Required value |
| --- | --- |
| `MATRIX_JEV_PRICING_REVIEW_VERSION` | Exact immutable pricing version `typesafe-jev-input-2026-09` |
| `MATRIX_JEV_PRICING_REVIEWED_AT` | Explicit operator review timestamp, canonical UTC ISO with milliseconds |
| `MATRIX_JEV_PRICING_VALID_THROUGH` | Explicit inclusive expiry, canonical UTC ISO with milliseconds |

Provide all three settings together. The validity window must be positive and no longer than 90 days. Canonical timestamps round-trip exactly and cannot contain normalized invalid calendar dates, offsets, or whitespace. Partial, malformed, incompatible, or excessively long reviews reject configuration. Reviews dated in the future, expired reviews, and invalid request clocks fail closed before reservation or provider dispatch.

When all settings are absent, preserve the historical September snapshot for compatibility, including its expiry. Never extend it using process-start time or automatically set a new date. Operators must independently verify the official provider rate before renewal and schedule another review before the configured expiry. No permanent-valid pricing escape hatch exists.

## Runtime and accounting

The Relay resolves the configured review before Jev policy admission and snapshots its immutable rate/version and actual validity interval. The authenticated owner-funded readiness endpoint returns that snapshot's actual `priceValidThrough`, after paid-probe settlement and authorization revalidation. Probe readiness is denied if the review expires while the probe runs.

An already-started evaluation retains its admitted pricing snapshot for exact usage settlement even if the review expires in flight. The Relay rechecks that review after the awaited reservation start and before invoking upstream fetch. A successfully started reservation whose request is proven not dispatched is settled at exactly zero through the trusted internal Relay finalization mode `not_dispatched`; it is not an unknown-usage event. Existing unknown-usage/manual-reconciliation behavior remains for requests whose upstream fetch was invoked. Renewal does not change pricing provenance or authorize replay of uncertain Gmail operations.

No new endpoint or authentication mechanism is introduced; the authenticated internal finalization endpoint gains the narrowly scoped branch below. All existing owner, model, reservation, and account-binding checks remain. Sonnet/GLM price reviews and public checkout policy are outside this change.

## Cold-start readiness bounds

The owner-funded synthetic probe includes Relay startup, generation and exact settlement. Its outer caller must not reuse the five-second credential-issuance deadline. Jev has a bounded chain: Relay probe 20 seconds, Platform route 24 seconds, Gateway request 25 seconds, and Gateway observation 26 seconds. The scoped Inbox reader explicitly selects the Jev model so that it receives this budget. Funding-summary and credential issuance remain bounded at five seconds; ordinary-model readiness is unchanged.

Cancellation still aborts requests, revokes temporary probe credentials, and prevents publishing canceled observations into the ready cache. A timed-out preflight does not submit the agent prompt or authorize mailbox writes. Delayed and stalled dependencies must be tested with fake clocks; a successful warm probe alone does not establish cold-start acceptance.

## Validation and delivery

- October 1 with explicit reviewed configuration: paid synthetic probe completes, cost settles at 12 microUSD for 275 input tokens, immutable provenance remains, actual configured expiry is returned.
- Missing, future, and expired review: no authorization/reservation/upstream dispatch.
- Partial, malformed, mismatched-version, invalid-calendar, and greater-than-90-day reviews: fail closed.
- In-flight expiry: no false probe readiness; real evaluation settles its admitted price accurately.
- Retain existing request validation, accounting, timeout, body-limit, and settlement tests with deterministic clocks.
- Deploy the exact reviewed Relay build plus explicit operator attestation; run Main Computer/Electron Desktop and independently verify Gmail labels before claiming end-to-end acceptance.
- Companion public documentation: `FinnaAI/matrix-os-site` PR #146 describes Jev readiness and explicit operator review renewal; its 233 site tests pass.
- Preserve canonical preflight error codes/messages and retryability across Hermes execution, so readiness/setup failures are not mislabeled as a Hermes connection failure.

## Known no-dispatch finalization and rollout compatibility

`POST /internal/ai/funded/finalize` retains its service-token authentication and body limits. Its strict `not_dispatched` branch requires reservation ID, token ID, expected request ID, and the admitted Jev pricing version. It accepts no caller cost or provider model. The Platform checks the locked reservation is a Jev usage reservation and matches request/version/identity before using existing exact-zero settlement, credit release, and idempotent replay. No provider provenance is invented. Premature, mismatched, non-Jev, or conflicting replay requests fail closed. Unknown provider usage remains held for evidence-bound reconciliation.

The Relay uses this branch only after a matched Platform start response and before any upstream fetch invocation. It awaits bounded zero settlement and retries the identical attestation through the existing capped, TTL-bounded in-memory settlement queue on temporary control-plane failure. The queue is not durable: process interruption, expiry, or eviction can still require evidence-bound manual reconciliation of a remaining hold. Failure returns the definite `not-started` dispatch marker; it never executes another paid probe or Gmail operation. Requests already dispatched retain the original unknown-usage rules.

The Relay release workflow is manual (`workflow_dispatch` only), defaults to candidate-only no-traffic deployment, and requires explicit promotion; a main merge does not automatically deploy it concurrently with Platform. Operator ordering remains mandatory, not an automatic capability negotiation. Deploy the compatible Platform build **before** deploying a Relay that emits `not_dispatched`. Old Relay `exact`/`conservative` modes remain compatible with the new Platform; an old Platform rejects the new strict union branch. Do not roll back Platform to an incompatible version while new Relays or queued no-dispatch attestations remain active. No database migration is required: existing exact settlement persists zero cost, releases the full hold, and leaves resolved-provider fields null. Verify Platform acceptance and zero-cost idempotency on a synthetic reservation before enabling the new Relay.

Regression acceptance covers strict schema input, relay-only route auth, request/version/token mismatch, premature/non-Jev rejection, exact-zero balance and ledger release, identical settlement replay/retry, and unchanged ambiguous-usage holds. Tests use isolated disposable database fixtures and must execute rather than silently skip money-bearing assertions.
