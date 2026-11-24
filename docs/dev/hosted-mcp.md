# Hosted Matrix MCP rollout

This is the platform HTTP adapter stacked on CLI PR #1538. The CLI remains stdio; the plugin defaults to hosted HTTP in the stacked release. Do not release the HTTP-default plugin before enabling and smoke-testing the endpoint. No deployment or account settings are changed by adding this code.

## Configuration

Keep `MATRIX_MCP_ENABLED` unset/false until all checks below pass. Disabled or invalid configuration returns generic 503 for `/mcp` and protected-resource discovery without consulting a CLI profile.

| Variable | Requirement |
| --- | --- |
| `MATRIX_MCP_ENABLED` | `true` only after OAuth and client interoperability verification |
| `MATRIX_MCP_RESOURCE_URL` | Canonical HTTPS endpoint `https://app.matrix-os.com/mcp` (the UI default `DEFAULT_MATRIX_MCP_ENDPOINT`, the plugin URL and the Clerk MCP resource); path must be `/mcp` |
| `MATRIX_MCP_OAUTH_ISSUER` | Exact trusted OAuth JWT issuer, `https://clerk.matrix-os.com` in production (no trailing slash, query, fragment or credentials) |
| `MATRIX_MCP_OAUTH_JWKS_URL` | Trusted HTTPS public signing-key endpoint, `https://clerk.matrix-os.com/.well-known/jwks.json` in production; no redirects |
| `MATRIX_MCP_REQUIRED_SCOPES` | Optional space/comma-separated scopes every token must grant, max 16; unset means `matrix:computer`. Advertised as `scopes_supported` and in every `WWW-Authenticate` challenge. Invalid values disable the endpoint (503) |
| `PLATFORM_JWT_SECRET` | Existing platform runtime-token signing secret, at least 32 characters; never an MCP client credential |
| `NEXT_PUBLIC_MATRIX_APP_URL` | Trusted gateway routing origin; defaults to `https://app.matrix-os.com` |
| `MATRIX_MCP_ALLOWED_ORIGINS` | Optional comma-separated exact browser origins, max 20; no wildcard; native clients without Origin work without this |

HTTP loopback URLs are allowed for explicit local development only. These are operator-controlled URLs, never tool arguments. If a trusted configured hostname changes ownership/DNS, its operator must update configuration; no untrusted URL fetching or redirect-following is introduced.

## OAuth release gate

Set the six `MATRIX_MCP_*` values as GitHub environment variables for the selected platform deployment environment. The Cloud Run workflow reapplies them on each deployment, defaults enablement to false, and preserves comma-separated origins. Do not configure them only on a live Cloud Run revision: the next deployment replaces its environment.

Delegate browser login, PKCE S256, consent, client registration, refresh and revocation to Clerk. Production Clerk (`https://clerk.matrix-os.com`) advertises `/oauth/authorize`, `/oauth/token`, `/oauth/token_info`, PKCE and Client ID Metadata Documents (CIMD). Its `registration_endpoint` is null: Clerk deprecated Dynamic Client Registration, so do not depend on it. Register `https://app.matrix-os.com/mcp` under Clerk Agents -> MCP servers; that is what makes Clerk put the resource in `aud`.

The verifier (`packages/platform/src/mcp-auth.ts`) checks OAuth access-token JWTs locally with `jose`, with no network call per request:

- RS256 signature against the configured JWKS; exact issuer.
- Signed header `typ` is `at+jwt` or `application/at+jwt` (RFC 9068). This is what `@clerk/backend` uses to recognize Clerk OAuth JWTs, and it rejects session tokens (`typ: JWT`) and JWT-template tokens signed by the same instance keys. Clerk's `cat` header for session or M2M tokens is also rejected.
- `aud` is the canonical resource URL, or an array that contains it exactly. Prefix or host-only matches are rejected. Without the Clerk MCP resource registration, `aud` is absent and every token is rejected.
- Required `exp`, `iat`, `sub` (`user_...`) and `client_id`. `nbf`, `exp` and `iat` allow 5 seconds of clock skew, Clerk's default. `sid` is allowed, because Clerk OAuth access tokens record the authorizing session (see the `@clerk/backend` OAuth JWT fixture).
- `scope` (space-separated) or `scp` (array) grants every `MATRIX_MCP_REQUIRED_SCOPES` value. If both are present, they must agree. `matrix:computer` authorizes arbitrary command execution and broad file, terminal and chat access on currently accessible computers, so consent must say that. Clerk currently lists only built-in scopes, so add a `matrix:computer` custom scope in Clerk before enabling. Setting the variable to a built-in scope is an owner decision: any client the user consents to would then get computer access.
- Opaque Clerk tokens (`oat_...`) are rejected explicitly. Clerk issues JWTs by default. Accepting opaque tokens would need a per-request introspection call with the Clerk secret key, and is deferred.

`@clerk/backend` is not used for this check. The pinned 2.33.x version does not check OAuth `aud` at all, and newer versions do not check the issuer for OAuth JWTs and fetch keys through the Clerk Backend API with the secret key.

Each rejected credential logs one line, `[mcp] auth rejected: <reason> {shape}`, capped at 30 lines a minute per process. The reasons are `malformed`, `opaque_token`, `token_type`, `token_category`, `algorithm`, `signature`, `unknown_key`, `expired`, `not_yet_valid`, `issuer`, `audience`, `claims` and `scope`. The shape records token kind, enumerated `typ`/`alg`/`cat`, the `aud` type, whether `aud` includes the resource, the `sub` prefix class, and whether `client_id`, `sid`, `azp`, `scope` and `scp` are present. It records the issuer only when it is origin-shaped. It never contains the token or any subject, client, session or scope values. Use it to read what Clerk sends on the first real sign-in.

Do not weaken audience validation, reinterpret a Clerk session as OAuth, or substitute sync, ID or client-credentials tokens. The implementation tests use locally generated keys; no live Clerk token was validated in them.

Public discovery is `/.well-known/oauth-protected-resource/mcp` (root alias also available). It lists only the configured resource, issuer and required scopes. Every 401/403 on `/mcp` (including an unauthenticated GET or DELETE, which is challenged before method handling) carries `WWW-Authenticate: Bearer resource_metadata="https://app.matrix-os.com/.well-known/oauth-protected-resource/mcp", scope="<required scopes>"`. The authorization server owns its own metadata; Matrix does not proxy a token endpoint or forward incoming OAuth tokens to a computer.

JWT verification is local with a bounded five-minute signing-key cache. Revocation may not invalidate an issued JWT until expiry: use short-lived access tokens and test refresh/re-login. Membership/activation and the shared platform runtime billing decision are checked before issuing every computer credential. A denied entitlement returns the safe, non-retryable tool error `billing_required`; accessible previews retain the existing exemption. Cached signing keys are capped at 32 keys/64 KiB; remote refreshes time out after 10 seconds. Provider outages are 503, not a false bad-login diagnosis.

## Transport and execution

The pinned SDK 1.x supports its 2025 MCP revisions over stateless Streamable HTTP with JSON replies. It does not claim the July 2026 stateless-core protocol. Keep backward-compatible client negotiation; upgrading to SDK 2.x is separate from this adapter. GET/DELETE return authenticated 405; there is no legacy SSE endpoint or shared transport-session registry.

Each request creates a server with an explicitly authenticated principal. Computer inventory and runtime lookup use existing platform repositories; the gateway receives a separately minted computer-bound sync JWT lasting at most 60 seconds and never beyond incoming token expiry. It is not returned to the client. Existing gateway auth and billing enforcement remain in the path.

Per platform process: 600 authenticated admission attempts/minute, 120 requests/minute/owner, 32 authenticated executions in flight, four per owner, and a 2 MiB body cap. Missing/invalid credentials do not consume these budgets. Verification has a separate 32-in-flight cap, released when verification settles; ingress floods still require edge throttling. Rate keys expire after a minute with a 10,000-key cap. These are not fleet-wide limits. Captured HTTP commands default/max 45 seconds; downstream fetches have an explicit 50-second timeout and the overall deadline is 55 seconds. Configure the ingress/Cloud Run request timeout above that budget. Disconnect/deadline aborts downstream fetches; remote side effects may already have occurred. Inspect state rather than blindly retrying writes. Long jobs use persistent zellij terminals.

Computer discovery remains capped at 20 entries with `hasMore`. Explicit runtime selection prioritizes that slot in the bounded repository query, so a known accessible slot outside the initial discovery page is still usable.

## Validation

1. Merge CLI first; retarget this stack to main and require green CI and Greptile 5/5. Publish/deploy the matching gateway for stable tab IDs/cwd before terminal testing.
2. Deploy the platform with hosted MCP disabled. Configure the trusted OAuth issuer/resource/JWKS and client registration. Validate the token contract without printing or committing token contents.
3. Enable in a controlled environment. Check anonymous discovery and 401 challenge; reject session cookies, wrong audiences/scopes, expired tokens and untrusted browser origins.
4. In Codex: `codex mcp add matrix --url https://app.matrix-os.com/mcp`, then `codex mcp login matrix`. In Claude Code: `claude mcp add --transport http --scope user matrix https://app.matrix-os.com/mcp`, then `/mcp` browser authentication. Use the controlled endpoint URL instead when testing preproduction.
5. Choose a disposable Matrix computer, list inventory, run `run_command` with `command: ["pwd"]`, create/select a tab, send input, transfer a unique file with overwrite disabled, and inspect only authorized chats. Verify a second account cannot access the first account's computer. Do not deploy or mutate a customer's primary computer to test this adapter.
6. Exercise timeout, disconnect, revoked access and provider outage cases. Verify no OAuth token, internal credential, command, file contents or chat content appears in logs. The platform adds only coarse `[mcp]` failure classes, while existing HTTP metrics record status/latency.

Monitor `/mcp` 401/403/429/503/504 rates and latency during the rollout window, owned by the releasing engineer. A sustained 503/504 increase, cross-account result, or unintended credential exposure is a stop signal: set `MATRIX_MCP_ENABLED=false`, investigate, and do not release the HTTP-default plugin. User files, terminals and chats are not removed by disabling the adapter.

Official references: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Clerk OAuth](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
