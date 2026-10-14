# Matrix AI Relay

## Scope

- Owns the shared Anthropic- and OpenAI-compatible request boundaries used for Matrix-funded AI.
- Verifies runtime-scoped relay credentials, enforces funded model/admission policy, and dispatches approved requests through a provider-neutral upstream seam. Cloudflare and operator-qualified AWS Bedrock routes are supported.
- Owns content-free operational telemetry for the relay.
- Does not own Chat persistence, owner provider credentials, product billing entitlements, or renderer state.
- Legacy instance messaging and SQLite usage/quota routes remain migration debt and are not the source of truth for funded access.

## Source Of Truth

- Funded relay availability and safety limits are validated process configuration.
- Cloudflare native-to-canonical model maps are exact and code-versioned. An optional strict Bedrock route binds one client ID to one canonical ID, inference profile, region, resource ceilings, and expiring reviewed price table. It cannot contain endpoints or credentials; remote/client values cannot expand either map.
- Runtime identity comes only from the platform's short-lived opaque credential check. Legacy indefinite handle-HMAC credentials are not verified locally and fail platform authorization. Caller identity headers are ignored.
- Matrix PostgreSQL/Kysely policy, owner-scoped upstream preference, monthly budgets, reservations, and credit ledger are authoritative. Cloudflare spend limits remain only a defense-in-depth fuse.
- Chat content remains in the owner runtime and is never persisted by this package.

## Public API

- `resolveFundedRelayConfig()` parses and fails closed on enabled relay configuration.
- `createFundedRelay()` registers bounded `/v1/messages`, `/v1/messages/count_tokens`, and `/v1/chat/completions` surfaces and exposes shutdown cleanup.
- `createBedrockFundedUpstream()` translates bounded OpenAI requests to AWS `ConverseStream`, translates events back to OpenAI SSE, and exposes content-free provenance.
- `mapFundedModel()` and the versioned integer-microusd estimator define the bounded model and pricing contract.
- Other modules under `src/` are internal unless exported deliberately.

## Auth And Trust Boundaries

- The customer runtime sends a short-lived platform-issued credential in the Anthropic SDK `x-api-key` field. The relay sends it only to the dedicated platform policy/reservation API over service authentication.
- Before reserving, the relay consumes the platform's short-lived HMAC-bound upstream selection. Platform authorization re-verifies and records that exact upstream; the relay rejects any mismatched authorization response and never infers owner eligibility.
- Platform-verified owner/runtime identity is HMAC-projected into exactly five primitive, content-free Cloudflare metadata fields. The relay does not trust `x-matrix-user`, forwarded headers, Cloudflare metadata/auth headers, target URLs, or model policy from the caller.
- Cloudflare is always the fixed official `gateway.ai.cloudflare.com/.../anthropic` endpoint. Redirects are rejected. Bedrock uses the AWS SDK default credential provider chain in the relay workload and the exact configured region/profile; callers cannot supply AWS credentials, endpoints, account IDs, or regions.
- The central Cloudflare gateway token is replaced server-side and never returned or forwarded from a customer runtime.
- Cloudflare payload collection is disabled and ZDR is requested on every funded call. Product policy must still account for the selected model's documented upstream retention behavior.
- Client errors are stable and generic. Server logs retain only coarse status/error classes.

## Concurrency And Recovery

- Global rate/concurrency admission happens before parsing, platform-verified per-runtime rate admission happens before token counting, and per-runtime generation concurrency is acquired only after Matrix credit is reserved.
- The runtime admission registry has an operator-configured hard cap. Expired inactive entries are evicted opportunistically when capacity is reached; shutdown clears the registry and denies new leases.
- Request bodies, nested JSON, model/tool/message counts, control responses, response streams, inbound request time, first-response time, total stream duration, and forwarded headers are bounded.
- Only explicit top-level Anthropic fields, client-defined tools, and operator-allowlisted beta identifiers are reconstructed for upstream forwarding; server tools, service-tier overrides, and unknown fields are rejected.
- Downstream cancellation propagates to the selected upstream request and async iterator, and admission leases remain held until the response stream completes or is cancelled.
- The relay is conversation-stateless. Restarting it can drop in-flight streams but cannot corrupt Chat state; the owner kernel handles retry/resume deliberately.
- Cloudflare token counting feeds a conservative, expiring integer-microusd estimate. Matrix reserves that worst case atomically, then the relay marks it in-flight immediately before generation.
- A complete valid response is priced with the reservation's versioned integer-microusd table and finalized exactly once through the idempotent platform API. Bedrock requires consistent exact token/cache metadata and persists content-free route provenance in the same settlement transaction. A verified pre-stream zero-usage rejection also carries the resolved route provenance; malformed, truncated, cancelled, timed-out, oversized, or otherwise ambiguous usage-mode responses keep their hold unresolved. The relay never releases after start or falls back to another provider.
- Failed finalizations enter a capped, expiring retry queue with bounded batches and a shutdown drain. Queue expiry/eviction falls back to the platform's conservative in-flight expiry cleanup rather than risking free upstream usage.

## Tests

- `tests/proxy/funded-relay.test.ts` covers fail-closed config, fixed upstream URL, runtime authentication, spoofed-header rejection, credential stripping, metadata privacy, logging/ZDR headers, model/path/body limits, concurrency/rate admission, redirects, bounded failure mapping, and secret-leak prevention.
- `tests/proxy/funded-bedrock-upstream.test.ts` and `tests/proxy/funded-relay-bedrock.test.ts` cover route/pricing validation, request and stream translation, tools, cancellation, readiness, policy ordering, exact settlement/provenance, provider failures, and no fallback.
- `tests/proxy/auth.test.ts` covers HMAC credential and admin-token comparison behavior.
- Proxy changes also run package TypeScript checks, repository pattern checks, and the applicable full test suite before PR readiness.
