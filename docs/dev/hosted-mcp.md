# Hosted Matrix MCP rollout

This is the platform HTTP adapter stacked on CLI PR #1538. The CLI remains stdio; the plugin defaults to hosted HTTP in the stacked release. Do not release the HTTP-default plugin before enabling and smoke-testing the endpoint. No deployment or account settings are changed by adding this code.

## Configuration

Keep `MATRIX_MCP_ENABLED` unset/false until all checks below pass. Disabled or invalid configuration returns generic 503 for `/mcp` and protected-resource discovery without consulting a CLI profile.

| Variable | Requirement |
| --- | --- |
| `MATRIX_MCP_ENABLED` | `true` only after OAuth and client interoperability verification |
| `MATRIX_MCP_RESOURCE_URL` | Canonical HTTPS endpoint, normally `https://api.matrix-os.com/mcp`; path must be `/mcp` |
| `MATRIX_MCP_OAUTH_ISSUER` | Exact trusted OAuth JWT issuer (no query/fragment/credentials) |
| `MATRIX_MCP_OAUTH_JWKS_URL` | Trusted HTTPS public signing-key endpoint; no redirects |
| `PLATFORM_JWT_SECRET` | Existing platform runtime-token signing secret, at least 32 characters; never an MCP client credential |
| `NEXT_PUBLIC_MATRIX_APP_URL` | Trusted gateway routing origin; defaults to `https://app.matrix-os.com` |
| `MATRIX_MCP_ALLOWED_ORIGINS` | Optional comma-separated exact browser origins, max 20; no wildcard; native clients without Origin work without this |

HTTP loopback URLs are allowed for explicit local development only. These are operator-controlled URLs, never tool arguments. If a trusted configured hostname changes ownership/DNS, its operator must update configuration; no untrusted URL fetching or redirect-following is introduced.

## OAuth release gate

Set the five `MATRIX_MCP_*` values as GitHub environment variables for the selected platform deployment environment. The Cloud Run workflow reapplies them on each deployment, defaults enablement to false, and preserves comma-separated origins. Do not configure them only on a live Cloud Run revision: the next deployment replaces its environment.

Delegate browser login, PKCE S256, consent, client registration, refresh and revocation to the configured authorization server. Clerk is intended, but its ordinary session authentication is **not** sufficient, and merely enabling Clerk OAuth does not prove token compatibility. Do not enable this endpoint until a real issued access token passes all checks:

- RS256 signature against configured JWKS; exact issuer.
- `aud` is exactly the canonical MCP resource URL, not a client ID or general app audience. The provider must honor the resource indicator in authorization and token requests.
- Required integer `exp` and `iat`, unexpired, no future `iat`.
- `sub` is the authentic Matrix account's `user_...` identifier, and `client_id` identifies the authorizing client. No session `sid` claim.
- `scope` contains `matrix:computer`, or `scp` is an equivalent array. If both exist, they must agree. This scope authorizes arbitrary command execution and broad file/terminal/chat access on currently accessible computers; consent must say that explicitly.
- The issuer advertises usable authorization/token endpoints and PKCE. Review client registration: prefer reviewed CIMD clients where supported; enable DCR only deliberately for clients that require it, with consent enforced. Alternatively pre-register compatible clients.

Use a dedicated MCP access-token configuration. Do not weaken audience validation, reinterpret a Clerk session as OAuth, or substitute opaque, sync, ID, or client-credentials tokens if an issuer cannot provide this contract. Select/configure a compatible authorization server before rollout instead. No live token or provider-dashboard validation was performed in the implementation tests.

Public discovery is `/.well-known/oauth-protected-resource/mcp` (root alias also available). It lists only the configured resource, issuer and scope. Authentication failures include the canonical `WWW-Authenticate` discovery URL. The authorization server owns its own metadata; Matrix does not proxy a token endpoint or forward incoming OAuth tokens to a computer.

JWT verification is local with a bounded five-minute signing-key cache. Revocation may not invalidate an issued JWT until expiry: use short-lived access tokens and test refresh/re-login. Membership/activation and gateway billing are still checked at execution time. Cached signing keys are capped at 32 keys/64 KiB; remote refreshes time out after 10 seconds. Provider outages are 503, not a false bad-login diagnosis.

## Transport and execution

The pinned SDK 1.x supports its 2025 MCP revisions over stateless Streamable HTTP with JSON replies. It does not claim the July 2026 stateless-core protocol. Keep backward-compatible client negotiation; upgrading to SDK 2.x is separate from this adapter. GET/DELETE return authenticated 405; there is no legacy SSE endpoint or shared transport-session registry.

Each request creates a server with an explicitly authenticated principal. Computer inventory and runtime lookup use existing platform repositories; the gateway receives a separately minted computer-bound sync JWT lasting at most 60 seconds and never beyond incoming token expiry. It is not returned to the client. Existing gateway auth and billing enforcement remain in the path.

Per platform process: 600 admission attempts/minute, 120 requests/minute/owner, 32 in-flight requests total, four per owner, and a 2 MiB body cap. Rate keys expire after a minute with a 10,000-key cap. These are not fleet-wide limits: add edge throttling as appropriate. Captured HTTP commands default/max 45 seconds; the overall deadline is 55 seconds. Configure the ingress/Cloud Run request timeout above that budget. Disconnect/deadline aborts downstream fetches; remote side effects may already have occurred. Inspect state rather than blindly retrying writes. Long jobs use persistent zellij terminals.

## Validation

1. Merge CLI first; retarget this stack to main and require green CI and Greptile 5/5. Publish/deploy the matching gateway for stable tab IDs/cwd before terminal testing.
2. Deploy the platform with hosted MCP disabled. Configure the trusted OAuth issuer/resource/JWKS and client registration. Validate the token contract without printing or committing token contents.
3. Enable in a controlled environment. Check anonymous discovery and 401 challenge; reject session cookies, wrong audiences/scopes, expired tokens and untrusted browser origins.
4. In Codex: `codex mcp add matrix --url https://api.matrix-os.com/mcp`, then `codex mcp login matrix`. In Claude Code: `claude mcp add --transport http --scope user matrix https://api.matrix-os.com/mcp`, then `/mcp` browser authentication. Use the controlled endpoint URL instead when testing preproduction.
5. Choose a disposable Matrix computer, list inventory, run `run_command` with `command: ["pwd"]`, create/select a tab, send input, transfer a unique file with overwrite disabled, and inspect only authorized chats. Verify a second account cannot access the first account's computer. Do not deploy or mutate a customer's primary computer to test this adapter.
6. Exercise timeout, disconnect, revoked access and provider outage cases. Verify no OAuth token, internal credential, command, file contents or chat content appears in logs. The platform adds only coarse `[mcp]` failure classes, while existing HTTP metrics record status/latency.

Monitor `/mcp` 401/403/429/503/504 rates and latency during the rollout window, owned by the releasing engineer. A sustained 503/504 increase, cross-account result, or unintended credential exposure is a stop signal: set `MATRIX_MCP_ENABLED=false`, investigate, and do not release the HTTP-default plugin. User files, terminals and chats are not removed by disabling the adapter.

Official references: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Clerk OAuth](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
