# Contract: Journey API (092)

## GET /api/journey

**Auth**: Clerk session cookie (web/mobile) OR `Authorization: Bearer <sync JWT>` (CLI/native) — identical dual scheme to `/api/me`. 401 if neither resolves.

**Response 200** (`application/json`):

```jsonc
{
  "phase": "plan_required",            // account_required | plan_required | payment_settling |
                                       // provisioning | provisioning_failed | first_run | ready
  "detail": "Choose a plan to create your Matrix computer.",  // human-readable, generic, no provider/internal info
  "nextAction": {
    "kind": "open_plans",              // open_plans | wait | start_provision | retry_provision |
                                       // contact_support | begin_first_run | open_shell | none
    "url": "https://app.matrix-os.com/?plans=1"   // present when kind is a navigation; origin from origins.ts
  },
  "progress": {                        // present ONLY when phase = provisioning
    "stage": "booting",                // creating_server | booting | registering | finalizing
    "startedAt": "2026-06-11T10:00:00Z"
  },
  "failure": {                         // present ONLY when phase = provisioning_failed
    "retryable": true,                 // false once attempt cap reached
    "attempt": 2
  },
  "readiness": {                       // present ONLY when phase = ready
    "status": "ok",                    // ok | degraded
    "failing": ["terminal.ready"]      // gate ids only; details live in the existing readiness endpoint
  },
  "settling": {                        // present ONLY when phase = payment_settling
    "since": "2026-06-11T10:00:00Z",
    "delayed": false                   // true once past the settling window (FR-014 escalation UI)
  }
}
```

**Errors**: 401 unauthenticated; 503 `{ "error": "journey_unavailable" }` when derivation dependencies (DB) are down — clients render "can't reach Matrix", never guess a phase (edge case in spec). No other shapes; no raw errors.

**Caching**: `Cache-Control: no-store`. Clients poll 2–5 s in active phases (`payment_settling`, `provisioning`), stop in terminal phases.

## POST /api/journey/retry-provision

**Auth**: same as GET /api/journey. **Body**: `{}` or `{ "runtimeSlot": "primary" }` (Zod, `bodyLimit` 1 KB).

**Behavior**: Converges (FR-028): if a live attempt exists, returns it (200, `{ "status": "in_progress" }`) without creating another. If latest machine is `failed` and retryable, retires it and starts a new attempt in one transaction (200, `{ "status": "started" }`). 402 `{ "error": "billing_required" }` if entitlement missing. 409 `{ "error": "retry_exhausted" }` past attempt cap. 429 on per-user rate limit.

## POST /internal/first-run  (gateway → platform)

**Auth**: `Authorization: Bearer <UPGRADE_TOKEN>` + `x-matrix-handle` — existing internal scheme, constant-time compare. Not reachable through the public proxy path.

**Body** (Zod, `bodyLimit` 16 KB):

```jsonc
{
  "clerkUserId": "user_abc",
  "handle": "alice",
  "completedAt": "2026-06-11T10:05:00Z",
  "goal": "coding",                    // optional: coding | company_brain | assistant
  "steps": { "api_key": "skipped" },   // optional, bounded
  "source": "gateway_ws"               // gateway_ws | shell_manual
}
```

**Behavior**: Upsert `onboarding_first_run` (`ON CONFLICT DO UPDATE`); idempotent. 204 on success; 401 bad token; 422 invalid body. Handle/user mismatch with platform records → 422 (logged server-side, generic to caller).

## Changed: POST /billing/checkout

Adds: insert `billing_checkout_attempts` (status `open`) with the Stripe session id, in the same request that creates the session; `returnPath` validated via `resolveReturnPath` allowlist before embedding in success/cancel URLs. Response shape unchanged.

## Changed: POST /vps/register

Adds rejection (410 `{ "error": "attempt_retired" }`) when the presented registration token belongs to a machine row that is retired, replaced, or expired — a stale VPS cannot resurrect a dead attempt (FR-010).

## Invariants (for PR bodies, constitution X)

- **Source of truth**: journey phase is derived on read from `billing_entitlements`, `billing_checkout_attempts`, `user_machines`, `onboarding_first_run`; `onboarding_journey_events` is non-authoritative telemetry; the VPS-local completion file is a derived artifact.
- **Lock/transaction scope**: retire-failed + insert-new-attempt is one transaction with `FOR UPDATE` on the user's machine rows; Hetzner create happens before, provider deletion after (queued, retried) — network calls never inside the transaction.
- **Acceptable orphan states**: a Hetzner server may briefly outlive its retired DB row (queued deletion, FR-011 reaper); an `open` checkout attempt may outlive an abandoned checkout (swept after 30 days); a journey event write may be lost (telemetry only).
- **Auth source of truth**: Clerk session / sync JWT for public routes; `UPGRADE_TOKEN` for the internal route; registration tokens for `/vps/register`. No header-derived trust.
- **Deferred scope**: SSE push for journey updates; spec 067 in-terminal signup; mobile in-app purchase; non-launch-critical readiness gates; marketing-copy origin literals.
