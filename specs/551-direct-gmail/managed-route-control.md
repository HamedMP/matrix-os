# Managed route control resolver

ENG-355; depends on [the descriptor foundation](managed-route-descriptor.md). This unit adds a local configuration resolver, not provider approval, live account verification, a qualified lease or Google-data inference enforcement. No platform caller, VPS host, deployment environment or real operator review is configured here. Default managed Anthropic still returns unavailable until an explicit billing/account-state adapter is implemented and qualified.

## Contract and auth matrix

| Surface | Authentication | Result and bounds |
| --- | --- | --- |
| `POST /internal/google-managed-route/resolve` | Exact `Authorization: Bearer <AI_RELAY_CONTROL_TOKEN>`, compared in constant time before body access | Strict `{api,canonicalModelId}` only; current private `{descriptor,digest}` or generic refusal; 4 KiB body, 64 KiB response, no cache |
| Other methods or suffix routes under `/internal/google-managed-route/` | Same control authority | Generic method/route refusal; no descriptor |
| Public health/readiness | Existing health/control rules | Existing coarse responses; no credential identity or descriptor |
| Disabled control configuration | No new surface | Legacy funded service behavior and absence of this endpoint |

The accepted API/model pairs are the current managed Workers OpenAI-completions catalog and the existing canonical Anthropic Sonnet model. The latter is a recognized request that returns unavailable; no implicit Cloudflare BYOK/Unified Billing selection is treated as proof. Unknown APIs/models and extra owner, route, approval, evidence or credential fields are rejected. Owner sessions, funded runtime credentials, machine bearer keys, model headers and forwarded identity flags cannot authenticate this control endpoint. Only the service-owned control bearer is consulted; request Host/forwarded fields never select the advertised relay URL.

This fixed internal protocol requires `application/json`, exact integer `Content-Length` from 1 through 4096, no transfer encoding and no query parameters. Chunked and lengthless uploads are unsupported. Authentication precedes all body validation. Hono body limiting and an independent streamed byte/chunk limit reject oversized or lying lengths. Reads have a five-second deadline combined with request and shutdown cancellation; rejected readers are cancelled. Each instance admits at most eight readers and sixty authenticated body-reading operations per minute. These are bounded process bulkheads, not global quotas or account approval caches. Every response is generic on failure and `Cache-Control: no-store`; no CORS permission is added.

## Startup and configuration identity

`requireFundedRelayServiceConfig()` recognizes two optional operator values: `MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL` and `MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS`. Both absent leaves the feature absent. Partial, malformed, oversized or duplicate API/model records fail startup with a fixed error. Reviews are bounded to sixteen entries and 256 KiB of JSON, parsed with the strict private review schema. Empty reviews permit only authenticated unavailable responses. Missing, expired or nonmatching records are never filled from defaults.

The relay URL is explicit trusted deployment configuration, not request-derived authority. When control is configured, startup makes one private nested immutable dispatch snapshot. Arrays and nested records are cloned and frozen; beta membership uses a frozen read-only facade over a private copied set, because freezing a native Set alone does not prevent mutations. Actual relay dispatch, readiness and this resolver receive that same configuration snapshot. Operator review records are separately projected, copied and frozen. No response exposes the upstream raw token or the service control secret.

Configuration rotation requires a replacement service instance. Its new actual upstream key/account/gateway must still match the explicit review. A stale review returns unavailable. Account settings, billing mode, provider retention and onward processing still require separate operator evidence and revalidation; this endpoint cannot inspect those remote facts. The referenced evidence window is checked on every resolution. The resolver does not consume credits, probe a provider, issue a lease or make an external request.

## Lifecycle and remaining composition

Shutdown closes admission, aborts current body reads and waits for their bounded handlers to drain. Per-request deadline timers are cleared in every outcome. The capped reader set is cleared by settled handlers; no per-owner or per-machine registry is added. Restart discards only process admission counters, not authority records or owner content.

The next unit must add an authenticated platform client, qualified lease persistence and digest binding, then compare that binding against current actual dispatch immediately before sends/retries and releases. Legacy issuance/class fallback and locally supplied gateway relay URLs cannot qualify Google-bearing requests. Private descriptors must stay out of model-visible results and public readiness responses. This resolver alone does not close those integration seams.
