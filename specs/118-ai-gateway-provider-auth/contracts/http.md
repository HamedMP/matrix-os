# HTTP Contract: Provider Accounts and Funded AI

All route schemas use `zod/v4`. Every mutating route uses Hono `bodyLimit` before body parsing. URL/query parameters are validated at the route boundary. Client errors use stable provider-neutral codes and bounded copy; raw upstream errors are logged only through redacted structured logging.

## Auth Matrix

| Method | Route | Surface | Authentication | Body limit | Purpose |
|---|---|---|---|---:|---|
| `GET` | `/api/ai/providers` | owner gateway | Existing authenticated owner/session path | n/a | Canonical provider/account/harness/model snapshot |
| `POST` | `/api/ai/providers/:vendor/probe` | owner gateway | Authenticated owner; vendor path allowlist | 4 KiB | Refresh one provider account's readiness |
| `POST` | `/api/ai/providers/:vendor/api-key` | owner gateway | Authenticated owner; CSRF/origin protections | 16 KiB | Validate and store an owner API key |
| `DELETE` | `/api/ai/providers/:vendor/api-key` | owner gateway | Authenticated owner; CSRF/origin protections | 1 KiB | Remove the owner API key |
| `POST` | `/api/ai/connections` | owner gateway | Authenticated owner; CSRF/origin protections | 4 KiB | Create Anthropic/OpenRouter connection attempt |
| `GET` | `/api/ai/connections/:attemptId` | owner gateway | Authenticated owner; attempt owner match | n/a | Poll safe connection state |
| `DELETE` | `/api/ai/connections/:attemptId` | owner gateway | Authenticated owner; attempt owner match | 1 KiB | Cancel an attempt and clear secrets |
| `GET` | `/api/ai/connections/openrouter/callback` | owner gateway | OAuth `state` + authenticated owner/session correlation | n/a | Validate callback and exchange code |
| `POST` | `/v1/messages` | central relay | Exact relay service token/HMAC audience and scope | 2 MiB initial cap | Anthropic-compatible funded request |
| `POST` | `/v1/messages/count_tokens` | central relay | Same relay service credential | 256 KiB | Optional funded token-count endpoint |
| `GET` | `/health/ready` | central relay | Platform/internal health auth; never public detail | n/a | Coarse readiness |
| `POST` | `/internal/containers/:handle/ai/funding-summary` | platform internal | Exact per-handle platform HMAC; owner/machine/runtime derived from the running machine record | 1 KiB | Identity-free authoritative Matrix credit and monthly-budget summary |
| `POST` | `/billing/ai-credit/checkout` | platform | Authenticated Clerk owner; active machine/runtime derived server-side | 16 KiB | Create hosted Stripe Checkout for one server-owned add-on package |
| `POST` | `/billing/webhooks/stripe` | platform | Stripe signature over the exact raw body | 1 MiB | Verify paid add-on completion and atomically record receipt + ledger grant |

The exact prefix can be adapted to existing `/api/settings` compatibility routes. Compatibility routes must call the same service and return the canonical state; they cannot maintain a second provider truth.

The funding-summary request body and query are both strict-empty schemas. Its
response contains only `contractVersion` plus reconciled microusd funding
totals. It never returns owner ID, machine ID, runtime slot, credential, ledger
entries, source references, or database/provider errors. The owner gateway uses
the provisioned per-handle platform HMAC, a bounded response reader, an explicit
timeout, and `redirect: "error"`; failure projects usage as unavailable instead
of falling back to local estimates.

## Funded AI add-on Checkout

The checkout request is a strict object containing only `packageId`
(`usd_5`, `usd_10`, or `usd_25`), a bounded runtime slot, and a UUID
`requestId`. The platform maps the package to configured Stripe Price and exact
USD/microusd amounts. The strict schema rejects extra fields: any client-supplied owner,
machine, Price, currency, or amount makes the request invalid. The Checkout
create uses a fixed-length idempotency key derived from owner, machine, and
request UUID. Browser retries reuse the same UUID.

Only a signed `checkout.session.completed` event can grant credit. Validation
requires `mode=payment`, `status=complete`, `payment_status=paid`, `currency=usd`,
the exact configured `amount_total`, and exact server-written kind, owner,
machine, runtime, package, Price, request, and microusd metadata. The platform
inserts the Stripe event receipt and `addon:<checkout-session-id>` ledger entry
in one Kysely transaction. Mismatch, expiry, or unpaid state rolls back and
returns non-2xx so Stripe can retry; duplicate valid delivery is a 2xx no-op.

## `GET /api/ai/providers`

Response:

```json
{
  "revision": 7,
  "refreshedAt": "2026-08-29T12:00:00.000Z",
  "accessSources": [
    {
      "id": "matrix_included",
      "displayName": "Matrix AI",
      "fundingKind": "matrix_included",
      "vendor": "anthropic",
      "state": "ready",
      "accountLabel": "Included",
      "action": "none",
      "eligibleModelIds": ["claude-sonnet-5"]
    }
  ],
  "accounts": [
    {
      "id": "owner_anthropic",
      "vendor": "anthropic",
      "authMethod": null,
      "state": "setup_required",
      "accountLabel": null,
      "checkedAt": null,
      "action": "connect"
    }
  ],
  "drivers": [],
  "instances": [],
  "models": [],
  "active": {
    "providerInstanceId": "kernel-matrix-included",
    "accessSourceId": "matrix_included",
    "modelId": "claude-sonnet-5"
  }
}
```

Rules:

- arrays are capped and deterministically ordered;
- no credential presence flag may be translated directly to `ready` without verification provenance;
- `refreshedAt` plus per-item `checkedAt` lets shells represent stale state;
- Chat and Settings consume this response or the same service result.

## `POST /api/ai/providers/:vendor/api-key`

Request:

```json
{
  "apiKey": "secret value",
  "baseRevision": 7
}
```

Validation:

- vendor is a fixed enum initially containing `anthropic` and `openrouter`;
- key is trimmed, non-empty, maximum 12 KiB, and checked by vendor-specific format only as an early error;
- `baseRevision` is a non-negative safe integer;
- a real provider probe uses a 10-second timeout, no redirects, and the provider's fixed server URL;
- save occurs only after the probe succeeds; secret write is atomic and mode `0600`;
- log fields contain only vendor class, result class, latency, and request ID.

Success is `200` with the updated provider projection. Revision conflict is `409` with `PROVIDER_STATE_CHANGED`. Invalid credentials are `400` with `CREDENTIAL_REJECTED`. Provider timeout/unavailability is `503` with `PROVIDER_UNAVAILABLE`; it must not claim the credential is invalid.

## `POST /api/ai/connections`

Request discriminated union:

```ts
const CreateConnectionSchema = z.discriminatedUnion("vendor", [
  z.object({ vendor: z.literal("openrouter"), returnTo: SafeReturnTargetSchema }),
  z.object({ vendor: z.literal("anthropic"), returnTo: SafeReturnTargetSchema }),
]);
```

`returnTo` is a bounded Matrix-relative route or opaque draft restoration token. It is never an arbitrary redirect URL.

OpenRouter response:

```json
{
  "attemptId": "uuid",
  "method": "oauth_pkce",
  "status": "pending",
  "authorizationUrl": "https://openrouter.ai/auth?...",
  "expiresAt": "2026-08-29T12:10:00.000Z"
}
```

Anthropic response is either:

- a provider-supported authorization URL and polling attempt; or
- `{ "method": "provider_cli", "terminalLaunch": { "path": "__terminal__", "action": "anthropic-login" } }`.

The server never returns OAuth verifier, provider token, CLI stdout containing secrets, or filesystem paths.

## OpenRouter callback

1. Validate query byte/count limits before parsing.
2. Require `code` and `state` bounded strings.
3. Hash `state`, look up one unexpired owner-bound attempt, and compare constant-time.
4. Conditionally mark the attempt `exchanging`; duplicate callbacks return the existing safe result.
5. Exchange the code against OpenRouter's fixed token endpoint with `AbortSignal.timeout(10_000)` and `redirect: "error"`.
6. Validate the response schema and size, store the token atomically, clear verifier/code material, then perform a bounded readiness probe.
7. Return a Matrix-owned completion page that signals the opener and closes; no provider token is placed in URL, HTML, or analytics.

## Safe error envelope

```json
{
  "error": {
    "code": "PROVIDER_UNAVAILABLE",
    "message": "AI access is temporarily unavailable. Try again.",
    "retryable": true,
    "requestId": "uuid"
  }
}
```

Allowed public codes are capped and mapped centrally: `INVALID_REQUEST`, `AUTH_REQUIRED`, `ACCESS_DISABLED`, `MODEL_UNAVAILABLE`, `CREDENTIAL_REJECTED`, `CONNECTION_EXPIRED`, `PROVIDER_STATE_CHANGED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, and `INTERNAL_ERROR`. Provider names may appear in explicit account setup UI, but raw provider/network/database error text never does.

## Compatibility and versioning

- Add `contractVersion: 3` to the agent/provider snapshot.
- Existing `GET /api/settings/agent` adapts from the canonical service during the UI migration.
- Existing API-key write routes delegate to `ProviderCredentialStore`; remove them only after all shipped clients use the new route.
- Persisted `authKind: platform` reads as access source `matrix_included`; it is not projected as an authenticated owner Anthropic account.
