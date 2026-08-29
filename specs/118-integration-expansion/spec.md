# Managed integrations and Custom MCP expansion

## Outcome

Matrix preserves the existing seven integrations and adds Google Docs, Notion,
Figma, PostHog, Jira, Stripe, and Granola. The ordinary providers use
Pipedream; Granola is a curated OAuth Streamable HTTP preset. Personal Custom
MCP is platform brokered and available in Canvas and desktop settings.

The live provider-account release gate and evidence live in
`SDK-VERIFICATION.md`. Missing credentials in the implementation checkout are
recorded as a blocker rather than replaced with inferred component keys.

## Trust boundaries

| Boundary | Secret-bearing | Enforcement |
| --- | --- | --- |
| Platform Postgres | AES-256-GCM credential envelopes | dedicated required key; random nonce; owner + server AAD |
| Platform broker | decrypted credential in request memory | owner checks, revision checks, limits, OAuth rotation/revocation |
| Customer VPS | no MCP/provider credential | atomic `~/system/mcp-servers.json` projection |
| Kernel | no upstream credential | generic list/describe/call tools; external-content wrapper; approvals |
| Apps | no Custom MCP access in v1 | no `window.MatrixOS.service()` or manifest bridge |

Effective permission is `platform.enabled ∩ local.enabled` at an identical
revision. Missing, stale, disabled, or mismatched state fails closed.

## Lifecycle and failure behavior

- Create: validate URL → create `pending` database row → atomically project →
  activate. Pending rows expire after 24 hours.
- Discover: initialize current Streamable HTTP, cap catalog/schema sizes, and
  persist every discovered tool disabled with `always_ask`.
- Enable: requires at least one selected tool and optimistic revision match.
- Remove: disable platform row first → remove projection → revoke OAuth →
  delete. Revocation/projection failure leaves `action_required` visible.
- Calls: revalidate URL and DNS, pin the validated address, reject redirects,
  apply 30-second timeout/64 KB request/1 MB response bounds, and wrap output
  as untrusted content.
- Session clients use capped TTL/LRU reuse; stale/failing clients are isolated,
  and shutdown sends best-effort MCP session DELETE drains.

## Authentication matrix

| Mode | Stored platform-side | Notes |
| --- | --- | --- |
| none | nothing | HTTPS only |
| OAuth | access/rotating refresh token and discovered metadata | discovery, PKCE S256, expiring one-time state, resource audience binding |
| bearer | encrypted token | emits only `Authorization: Bearer` |
| api_key | encrypted token | emits only compile-time `X-API-Key` name |

Custom header names are never user controlled. Managed direct APIs may define
compile-time static headers such as Notion's API version.

## Resource limits

- 20 personal servers per owner; curated presets do not consume this quota
- 100 tools per server; 32 KB per input schema
- 64 KB mutation and upstream request bodies; 1 MB upstream response
- 10 seconds for OAuth/discovery; 30 seconds for tool calls
- 60 owner mutations per minute and bounded route rate-state memory

## Runtime wiring

Public `/api/mcp-servers` routes are Clerk-session owned. Customer gateways
proxy kernel calls to `/internal/containers/:handle/mcp-servers` using the
exact customer-host credential; platform resolution binds the same handle and
Clerk user. Projection writes go in the opposite direction to an internal VPS
route authenticated by that exact credential and expected owner ID.

The primary kernel can use enabled servers. A custom subagent call is denied
unless its YAML `mcp` frontmatter names the server ID or name. No upstream
server is injected into Agent SDK `mcpServers`.
