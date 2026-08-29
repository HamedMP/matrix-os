# Matrix AI Relay

## Scope

- Owns the shared, Anthropic-compatible request boundary used for Matrix-funded AI.
- Verifies runtime-scoped relay credentials, enforces funded model/admission policy, and forwards approved requests to Cloudflare AI Gateway.
- Owns content-free operational telemetry for the relay.
- Does not own Chat persistence, owner provider credentials, product billing entitlements, or renderer state.
- Legacy instance messaging and SQLite usage/quota routes remain migration debt and are not the source of truth for funded access.

## Source Of Truth

- Funded relay availability and safety limits are validated process configuration.
- The enabled model list is an explicit operator allowlist. Remote/client model values cannot expand it.
- Runtime identity is derived from a verified `sk-matrix-funded-<handle>.<hmac>` credential with a funded-only HMAC audience. Legacy `sk-proxy-*` credentials cannot invoke the funded relay. Caller identity headers are ignored.
- Cloudflare spend limits are a defense-in-depth fuse. Future per-owner balances and add-on credits belong to platform PostgreSQL through Kysely.
- Chat content remains in the owner runtime and is never persisted by this package.

## Public API

- `resolveFundedRelayConfig()` parses and fails closed on enabled relay configuration.
- `createFundedRelay()` registers the bounded `/v1/messages` and `/v1/messages/count_tokens` surface and exposes shutdown cleanup.
- `buildFundedProxyApiKey()` / `parseFundedProxyApiKey()` provide the funded runtime HMAC credential contract. The legacy proxy credential helpers remain isolated from this audience.
- Other modules under `src/` are internal unless exported deliberately.

## Auth And Trust Boundaries

- The customer runtime sends its funded-audience HMAC credential in the Anthropic SDK `x-api-key` field. Raw provider and legacy proxy API keys bypass the funded route and remain subject to their existing owner/legacy handler until that migration is complete.
- The relay derives an opaque Cloudflare `runtime_id` with HMAC and does not trust `x-matrix-user`, forwarded headers, Cloudflare metadata headers, provider authorization, target URLs, or model policy from the caller.
- Cloudflare is always the fixed official `gateway.ai.cloudflare.com/.../anthropic` endpoint. Redirects are rejected.
- The central Cloudflare gateway token is replaced server-side and never returned or forwarded from a customer runtime.
- Cloudflare payload collection is disabled and ZDR is requested on every funded call. Product policy must still account for the selected model's documented upstream retention behavior.
- Client errors are stable and generic. Server logs retain only coarse status/error classes.

## Concurrency And Recovery

- Global and per-runtime concurrency plus per-minute admission limits are enforced before upstream dispatch. The default global minute budget leaves headroom below Cloudflare Unified Billing's documented gateway limit.
- The runtime admission registry has an operator-configured hard cap. Expired inactive entries are evicted opportunistically when capacity is reached; shutdown clears the registry and denies new leases.
- Admission happens immediately after funded credential verification and before body parsing. Request bodies, nested JSON, model/tool/message counts, response bytes, inbound request time, first-response time, total stream duration, and forwarded headers are bounded.
- Only explicit top-level Anthropic fields, client-defined tools, and operator-allowlisted beta identifiers are reconstructed for upstream forwarding; server tools, service-tier overrides, and unknown fields are rejected.
- Downstream cancellation propagates to the Cloudflare request, and admission leases remain held until the response stream completes or is cancelled.
- The relay is conversation-stateless. Restarting it can drop in-flight streams but cannot corrupt Chat state; the owner kernel handles retry/resume deliberately.
- Cloudflare spend limits are eventually consistent and are not an atomic balance. Future metering reserves Matrix credit transactionally before dispatch and reconciles final usage afterward.

## Tests

- `tests/proxy/funded-relay.test.ts` covers fail-closed config, fixed upstream URL, runtime authentication, spoofed-header rejection, credential stripping, metadata privacy, logging/ZDR headers, model/path/body limits, concurrency/rate admission, redirects, bounded failure mapping, and secret-leak prevention.
- `tests/proxy/auth.test.ts` covers HMAC credential and admin-token comparison behavior.
- Proxy changes also run package TypeScript checks, repository pattern checks, and the applicable full test suite before PR readiness.
