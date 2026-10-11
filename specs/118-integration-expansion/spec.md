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
- OAuth connect: discover protected-resource and authorization-server metadata;
  use an explicitly configured client ID when present, otherwise register a
  public DCR client; bind a dynamically issued ID to its authorization-server
  issuer and persist it only inside the encrypted owner credential.
- Discover: initialize current Streamable HTTP, cap catalog/schema sizes, and
  persist every discovered tool disabled with `always_ask`.
- Managed preset catalog: for authenticated owners, intersect stable actions
  with the connection's persisted discovered tools before advertising them;
  discovery or projection failures expose no invocable actions.
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
| OAuth | access/rotating refresh token, issuer-bound dynamic client ID, and discovered metadata | discovery, public-client DCR or configured fallback, PKCE S256, expiring one-time state, resource audience binding |
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

## PostHog API-key project discovery (ENG-260)

This extends the original advertised `posthog/list_projects` read action; it
does not change `posthog_oauth` or the separately deferred PostHog work in
ENG-147 / PR #2215. Existing integration account selection and authentication
remain authoritative. The executor passes the selected owner's Pipedream
external-user ID and exact connected-account ID to one provider proxy read.
No API key is read by the adapter, returned to a caller or copied to a runtime.

- Empty or omitted params remain valid. The default region is **US**; an EU
  connection must explicitly request `region: "eu"`. Allowed private API
  origins are only `https://us.posthog.com` and `https://eu.posthog.com`.
  Arbitrary host, URL and header overrides, self-hosted instances and
  automatic cross-region retries are excluded.
- Without `organizationId`, use the source-confirmed `GET /api/projects/`
  entry point. PostHog applies its current organization and API-key access
  restrictions. With a UUID normalized to lowercase, use the documented
  `GET /api/organizations/:organization_id/projects/` and reject returned
  projects from another organization. Neither path creates or modifies data.
- `limit` is an integer from 1 to 100 (default 25); `offset` is an integer
  from 0 to 1,000,000 (default 0). Read exactly one page with the existing
  Pipedream proxy's 10-second abort deadline and zero retries.
- Validate the page and project metadata before returning it. Return only
  `id`, `name`, `organization`, optional page `count` and numeric
  `nextOffset` (or null). Never return project `api_token`, configuration,
  raw pagination URLs or arbitrary upstream fields. Compute a continuation
  offset locally as `offset + limit` for a non-null continuation, matching
  PostHog's LimitOffsetPagination; never follow upstream `next`/`previous`
  URLs. Malformed,
  oversized, cross-organization and non-progressing pages fail closed.
- Existing authenticated `/api/integrations/read-call` and general action
  paths continue to enforce owner/account selection, body limits, read risk
  and safe errors. This adds no public endpoint, grant, credential store,
  scope request or database write. Failed reads do not update usage metadata.
- The registry's GET descriptor and provider helper share the same strict
  target/query builder. Existing development verification can therefore bind
  the read without an invented Pipedream component key. Runtime execution
  always passes through the field-projecting helper, including when a
  discovered component key is also present.

Fixture contracts must reproduce the previous HTTP 501 before implementation
and cover parameter bounds, owner/account propagation, EU/US targets, secret
projection, pagination and safe provider failures. They do not establish a
successful actual account read, deployed broker behavior, model continuation
or Electron Desktop / Web Desktop / Web Canvas acceptance. Those live gates
remain required and pending. Public documentation is a separate
`FinnaAI/matrix-os-site` PR deliverable, coordinated with ENG-260.
