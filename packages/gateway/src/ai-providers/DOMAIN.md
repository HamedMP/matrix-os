# AI Provider State Domain

This directory owns the secret-free provider snapshot consumed by Chat and Settings. It keeps execution drivers, owner accounts, funding/access sources, provider instances, readiness, and model policy separate.

- `ProviderCredentialStore` adapts owner-controlled runtime files and the inherited Matrix credential without returning secret material. File presence is `unknown` until a bounded health probe verifies it.
- `AiProviderService` is the sole snapshot composer. Explicit owner selection never silently falls back to Matrix-funded access.
- `ProviderHealthCache` has a fixed cap, TTL/LRU eviction, a recurring sweep, and an explicit shutdown drain owned by the gateway.
- `model-catalog.ts` is a bounded bundled policy. Remote catalogs, executable driver definitions, arbitrary URLs, and owner mutations are not accepted here.
- `GET /api/ai/providers` is read-only and runs behind the gateway's authenticated API boundary. Route failures expose only a generic message.

Provider connect/disconnect mutations, funded-relay activation, remote catalog refresh, metering, and add-on purchases are intentionally deferred to later delivery phases.
