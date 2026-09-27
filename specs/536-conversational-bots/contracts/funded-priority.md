# Funded AI Request Class and Priority Claims

Platform and gateway contract (research R10; technical design "Owner Funded-Admission Authority"). Schemas are in `packages/contracts/src/funded-ai.ts`.

## Credential issuance

`POST /internal/containers/:handle/ai/funded-credential?runtimeSlot=<slot>` (existing route, runtime bearer). The body changes from the strict empty object to:

```json
{ "requestClass": "interactive" | "background" }
```

- An empty body `{}` is still accepted during rollout and maps to `interactive`, so gateways that have not upgraded keep working. It is removed after every VPS runs a class-aware gateway.
- The class is stored in `ai_runtime_credentials.request_class` and cannot be changed afterwards.
- The issuance cooldown is keyed per `(machine_id, runtime_slot, request_class)`.
- The response adds an optional top-level `"requestClass"` only when the request named a class. Legacy gateways parse the response strictly, so a response to `{}` must stay unchanged.

## Authorization (relay → platform `POST /internal/ai/funded/authorize`)

The request is unchanged. The class is read from the stored credential; a caller-supplied class is never trusted.

**Claim identity.** The relay mints a new request ID for every HTTP attempt, and interactive leases rotate. A claim is therefore keyed to the requesting runtime's interactive slot, `(owner_id, machine_id, runtime_slot)`, taken from the stored credential, not to a request ID or token. Any later interactive attempt from that runtime consumes the claim, including a retry with a new request ID or after lease rotation.

Inside the existing transaction and owner advisory lock:

1. Idempotent replay check (unchanged).
2. Load live claims for the owner: `expires_at > now()`, ordered by `created_at`.
3. Conflict test, unchanged: usage-mode conflicts with any active reservation, and other modes conflict with an active usage-mode reservation.
4. Class rules:
   - `background` and any live claim that would conflict with this request exists: reject with `rate_limited` and reason `priority_hold`.
   - `interactive` and a conflicting active reservation exists: upsert the claim for this runtime slot. On conflict, keep the existing `created_at` and `expires_at`, so a claim is never extended or moved back in line. Reject with `rate_limited` and reason `slot_busy`.
   - `interactive`, no conflicting reservation, but an older live claim exists from a different runtime slot: reject with `rate_limited` and reason `priority_queue`.
   - Otherwise reserve as today, and delete this runtime slot's claim in the same transaction.
5. At 16 live claims, an owner's new interactive claim is rejected with `rate_limited` and reason `priority_full`, and no claim is written.

**Commit-safe rejection.** `authorize` rejects by throwing inside its transaction, which would roll back a claim written on the same path. Rejections that carry a claim write (`slot_busy`) or depend on claims (`priority_hold`, `priority_queue`) therefore return a typed outcome from the transaction callback, `{ outcome: "rejected", code: "rate_limited", reason }`. The transaction commits, and the route maps the outcome to the existing 429 `SafeError` after commit. Every other rejection path keeps throwing.

**Relay.** Per-attempt request IDs are unchanged. On a platform 429 carrying an allowlisted `reason`, the relay adds the response header `x-matrix-funded-reason: <reason>` (`packages/proxy/src/funded-relay.ts`). The gateway uses the header only for waiting state, and retries an interactive 429 through its local queue whether or not the header is present.

The error body keeps the existing `SafeError` shape, with the optional allowlisted `reason` field.

## Cleanup

The existing reservation cleanup worker deletes claims whose `expires_at < now()` in batches of at most 500. There is no other writer.

## Gateway

- `funded-ai-credential-manager.ts` caches one lease per class.
- `getCredential({ requestClass })` and `buildKernelCredentialLaunch(..., { requestClass })` require the class; no default.
- The local owner queue sits in front of the broker inference actions and the canonical adapters. It orders requests (interactive first, FIFO within a class) and retries interactive 429s with backoff: 250 ms, doubling, capped at 2 seconds. The platform claim for the runtime's interactive slot survives these retries.
- Wait bounds are 2 minutes for interactive and 10 minutes for background requests, after which the request ends with a truthful blocked state.
- Caller classes:

| Caller | Class |
|---|---|
| Dispatcher chat and WebSocket, voice, channels | interactive |
| Canonical Claude chat adapter | interactive |
| App AI bridge | interactive |
| Heartbeat, batch provisioning, heal | background |
| Jev inbox evaluation | background |
| Pi and OpenCode harness credentials | interactive when attached to a foreground Chat turn; otherwise background |
| Collaboration broker | class of the requesting turn |
| Bot runs | background, except a turn that directly answers a waiting person's message in the bot's direct chat (interactive) |
