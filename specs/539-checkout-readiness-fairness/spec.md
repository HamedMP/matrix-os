# ENG-39: Bounded checkout model readiness

## Problem and scope

The AI credit checkout preflight probes the fixed generic model catalog
sequentially under one 12-second deadline. A first model failing at 10 seconds
leaves only two seconds for a second model that is independently healthy after
four seconds. This existing false negative prevents an eligible checkout.

The repair concerns the platform preflight and its HTTP request lifetime.
Provider Settings, Chat routing, payment amounts and funded model policy remain
owned by their existing implementations. The current session excludes public
site changes; this specification records the internal behavior and validation.

## Required behavior

- Probe only the owner's allowed members of the fixed two-model generic catalog
  concurrently, under the same total request deadline.
- Each fresh ready candidate re-reads exact owner/computer funding and policy.
  Accept the first candidate whose original global/runtime revisions, model
  authorization and evidence freshness remain valid after its final read. An
  early candidate expiring during its read must not discard a fresh alternative.
- Reject unavailable, expired, future-dated or invalid model evidence. If all
  candidates fail, the total deadline expires or the HTTP request aborts, reject
  checkout and cancel this caller's outstanding work.
- Preserve the probe service's atomic operator budget, coalescing, cache,
  waiter limits and per-model timeout. Cancelled and failed admitted probes stay
  counted; another caller's coalesced probe stays alive.
- Preserve the four-pending-funding-read cap. Cancellation does not pretend a
  pending database operation finished; its slot remains until settlement.
- At most one initial and two candidate funding reads occur per checkout.
- Parallel cold reads can admit up to two operator probes instead of one. No
  retry, quota reset, additional credit, policy relaxation or owner inference
  reservation is introduced.

## Wiring and file extraction

Extract the existing `/ai-credit/checkout` handler from the 1,086-line billing
composition file into `billing/ai-credit-checkout-route.ts` before adding request
cancellation. Registration retains bodyLimit, auth resolution and dependencies;
the focused handler passes `c.req.raw.signal` to the preflight. Package selection,
immutable idempotency claims, Stripe inputs and error normalization stay there.

Check cancellation before claiming and before starting Stripe. A claim already
persisted when cancellation arrives remains recoverable through its existing
request ID. Cancellation does not claim to roll back a Stripe request already
started or erase its claim.

## Auth and API contract

| Route | Authentication and authorization | Mutation |
| --- | --- | --- |
| `POST /billing/ai-credit/checkout` | Existing Clerk owner auth; server-resolved active authorized owner computer; fresh funded policy/ledger and exact revisions | Existing immutable checkout claim and Stripe session |

No new endpoint or client field is added. JSON/body bounds, package/request-ID
validation, server-owned prices and coarse existing response errors are retained.
Readiness probing does not debit the owner's ledger or grant credit.

## Validation

Use real checkout, native probe service and repository with the existing local
Postgres-compatible fixture; simulate Relay and Stripe transport only. Preserve
Red/Green evidence for model starvation, HTTP cancellation and model evidence
expiring during the final funding read, including a still-fresh alternative.
Regressions cover unavailable models,
total timeout, policy revocation, cached health, independent coalesced callers
and atomic budget exhaustion. Existing billing tests verify auth, price/package
validation, claims, payment errors and reuse. Run typecheck, pattern checks and
exact-head CI/Greptile before landing. Live payment or fleet deployment is outside
this repair's authorization.
