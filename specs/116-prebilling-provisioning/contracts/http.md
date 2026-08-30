# HTTP Contract: Prebilling Onboarding

## Auth Matrix

| Route | Mutation | Authentication / verification | Public | Prebilling behavior |
|---|---:|---|---:|---|
| `POST /billing/checkout` | Yes | Valid Clerk application session; owner derived from verified identity | No | Existing checkout mutation also creates/resumes eligible preparation |
| `POST /billing/webhooks/stripe` | Yes | Stripe signature over bounded raw body using timing-safe library verification | Internet-reachable webhook only | Signed events update checkout/subscription state and may authorize or fence cleanup |
| `GET /api/journey` | No | Existing Clerk or signed sync-session authentication | No | Adds coarse preparation/resume state |
| `POST /api/auth/provision-runtime` | Yes | Existing authenticated session plus effective exact-slot entitlement | No | Contract remains entitlement-only; used for legacy/fallback recovery |
| Runtime session route(s) | Yes | Existing authenticated session plus effective exact-slot entitlement and machine activation | No | Rejects `awaiting_billing` machines |
| Explicit `/vm/:handle` routing | No | Existing authenticated owner/session checks plus exact-slot entitlement and activation | No | Rejects `awaiting_billing` machines |
| Runtime HTTP/API forwarding | Varies | Existing route authentication plus exact-slot entitlement and activation | No | Rejects `awaiting_billing` machines |
| Runtime WebSocket and terminal upgrade routes | Yes | Existing browser-compatible query-token/session auth plus exact-slot entitlement and activation | No | Rejects `awaiting_billing` machines before upgrade |
| Recovery, resume, and resize routes | Yes | Existing owner/operator auth plus lifecycle policy; customer actions also require entitlement and activation | No | Customer cannot operate an unauthorized prepared machine |

There is no public `preprovision`, worker, cleanup, or activation endpoint. Background services are injected and validated when routes/workers are registered.

## `POST /billing/checkout`

The route and successful response remain backward compatible.

### Request

```json
{
  "plan": "pro",
  "interval": "monthly",
  "region": "eu-central",
  "serverType": "cpx32",
  "developerTools": ["claude-code", "codex"],
  "runtimeSlot": "primary",
  "returnPath": "/onboarding"
}
```

Boundary rules:

- Apply Hono `bodyLimit` before parsing; target maximum is 16 KiB.
- Parse with a strict Zod 4 schema. Reject unknown keys, invalid slugs, excessive tool count, duplicates, unsupported tools, invalid plan/interval/server/region combinations, non-primary V1 slots, and unsafe return paths.
- Derive acquisition and owner identity from trusted server context; never accept a Clerk user ID, provider ID, preparation ID, or activation state from the client.
- Canonicalize `developerTools` as a deduplicated sorted list before equality checks and persistence.
- Every Stripe call has a bounded timeout and an idempotency key derived from the durable checkout attempt.

### Success

```json
{
  "url": "https://checkout.stripe.com/..."
}
```

The URL is the existing Stripe-hosted destination. The client receives no preparation-intent, provider, machine, or network identifier.

Identical retries return the existing payable destination. A conflicting selection while a payable checkout exists returns a generic conflict telling the user to resume or wait for the existing checkout to expire.

Preparation is an optimization, not a prerequisite for selling an authorized subscription. If rollout eligibility, global capacity, trusted-origin rate limits, or provider admission denies preparation, Matrix creates no provider resource, emits the internal reason, and safely continues checkout. After signed subscription authorization, the server enqueues normal entitlement-backed provisioning without another browser mutation.

### Errors

| Status | Stable client meaning |
|---:|---|
| `400` | Invalid checkout selection |
| `401` | Authentication required |
| `409` | A different payable checkout is already active |
| `429` | Account request rate exceeded; retry later |
| `503` | Checkout is temporarily unavailable |

Responses contain allowlisted short messages only. Stripe/provider/database/path/network details are logged server-side with correlation IDs and bounded fields.

## `GET /api/journey`

Existing phases and fields remain compatible. For an eligible owner with an active preparation, add:

```json
{
  "phase": "plan_required",
  "nextAction": "resume_checkout",
  "preparation": {
    "state": "ready_waiting_for_billing",
    "stage": "finalizing",
    "startedAt": "2026-08-24T12:00:00.000Z"
  }
}
```

Allowed client states are `preparing`, `ready_waiting_for_billing`, `payment_settling`, `authorized_provisioning`, `failed`, and `cleanup_pending`. Allowed stages are coarse and provider-neutral. Do not return provider IDs, IPs, machine IDs, intent IDs, internal errors, health status codes, or lease internals.

`resume_checkout` returns or links through the existing server-owned checkout resumption path only for the authenticated owner and an open, unexpired attempt. A browser return never changes authorization.

## Shell Contract

- Reorder the new-primary journey to compute/region, developer tools, explicit “Continue to secure checkout,” preparation during checkout, signed billing confirmation, then ready/runtime.
- Copy must say preparation starts when checkout opens and access starts only after billing authorization.
- The billing component must submit `developerTools` and `serverType`; it must not separately call a preparation endpoint.
- Agent authentication remains after runtime readiness. Precheckout selection only chooses optional tools to install asynchronously on first boot.
- Canvas is the first manual validation surface; Desktop compatibility remains required.

## External-Call Safety

- Stripe API and provider API calls use explicit abort timeouts; webhook verification occurs before JSON interpretation.
- Provider selection values come only from server-side plan/region mappings.
- Ambiguous Stripe creation is reconciled before a replacement attempt; ambiguous provider creation/deletion uses exact deterministic labels/IDs and reconciliation before retry.
- User-controlled forwarded headers are never used for security or admission. Network-origin controls live at a trusted edge; if that trust boundary is unavailable, the feature launches with account/global limits only rather than a spoofable application check.
