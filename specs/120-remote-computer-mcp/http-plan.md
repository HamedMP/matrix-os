---
status: implemented
---
# Hosted Streamable HTTP MCP

Stack on `codex/remote-computer-mcp` (#1538); leave the CLI PR unchanged.

## Decisions

Expose `https://api.matrix-os.com/mcp` on the platform, with the existing 15-tool implementation and request-scoped owner context. No filesystem CLI credentials, client-selected gateway URLs, shared authentication state, or local command execution. Existing gateway authorization/billing remains authoritative. Keep stdio available as an explicit alternative.

Use a configured OAuth authorization server for browser login, PKCE, consent, client registration, refresh and revocation. Clerk is the intended deployment provider, but rollout requires proving resource-bound access tokens: issuer, audience equal to the MCP URL, expiry, OAuth client ID, and `matrix:computer` scope. Never fall back to session cookies, sync JWTs, client-ID audiences, or opaque tokens. Operators must verify provider capability before enablement; no account setting or production deployment is changed by this PR.

HTTP uses the existing SDK's stateless Streamable HTTP binding, JSON responses and its supported 2025 protocol revisions. Do not advertise July 2026 protocol support without an SDK migration and interop tests. No legacy HTTP+SSE endpoint. HTTP captured commands default to and cap at 45 seconds; long jobs use persistent terminals. A 55-second request deadline and disconnect cancellation bound upstream fetches; cancellation is not proof that a remote side effect was rolled back.

## Auth matrix

| Route | Authentication | Boundary |
| --- | --- | --- |
| GET /.well-known/oauth-protected-resource[/mcp] | Public | Static operator-configured resource and issuer; no request-host inference |
| POST /mcp | OAuth bearer only | Verify JWT issuer, audience, expiration, client ID and scope before tools; owner/billing lookup per computer call |
| GET/DELETE /mcp | OAuth bearer only | 405; no persistent transport sessions |
| OPTIONS /mcp | Public | Explicit origin allowlist, bounded CORS methods/headers |

## Implementation units

- U1 (test-first): `packages/platform/src/mcp-auth.ts`, `tests/platform/mcp-auth.test.ts`. JWT verification with jose and bounded trusted JWKS retrieval. Signed-token tests for valid/expired/wrong issuer/wrong audience/session-shaped/missing-scope inputs. No token logging. Export typed principal and typed safe auth errors.
- U2 (test-first): `packages/platform/src/mcp-runtime-context.ts`, `tests/platform/mcp-runtime-context.test.ts`; reuse computer projection/repository and accessible-running lookup, issue a short-lived computer-scoped sync token only internally. Tests for tenant separation, billing denial, absent/offline computer, safe origin/slot routing and expiry attenuation.
- U3 (test-first): `packages/platform/src/mcp-routes.ts`, `packages/platform/src/mcp-registration.ts`, `tests/platform/mcp-routes.test.ts`; shared sync-client export with explicit context; mount before session routing. Real SDK HTTP-client/Hono round trip, tool parity, malformed requests/body cap/CORS/auth/rate/concurrency limits/deadline/cleanup. Update platform dependencies, lockfile, runtime artifact copying and change filters.
- U4: HTTP-first plugin configuration and public docs in a stacked `FinnaAI/matrix-os-site` PR; retain stdio instructions. Verify Codex/Claude commands against official docs. Explain scopes, arbitrary remote execution consent, token expiry/re-login, limits, deployment prerequisites and smoke test. Plugin contract tests.

## Verification and release

Local verification: signed OAuth through the real platform entrypoint and SDK HTTP client; focused auth/runtime/transport/plugin/deployment/routing/billing regressions; platform and CLI typechecks; CLI MCP regression suite; plugin/skill validators; site contract suite and all three modified pages rendered at 375/768/1440 viewport widths without document overflow. A bounded independent security pass found no blocking findings. Full multi-persona review was not completed; CI/Greptile remain merge gates. Live provider-token and Codex/Claude browser-login checks remain release gates, not claimed test results.

Run focused MCP, platform, plugin and CLI regressions and typechecks, pattern scan and independent security review. Both PRs need Greptile 5/5 before merge. Merge CLI first, then retarget hosted PR to main. Do not deploy automatically. Before enablement, verify provider metadata/PKCE/resource audience/scope and browser OAuth in Codex and Claude against a disposable computer on the matching gateway version. Monitor generic MCP failure/rate-limit logs without commands, tokens, file contents or chat content. Roll back by disabling MATRIX_MCP_ENABLED. Cloud Run timeout must exceed the 55-second request budget. No customer VPS deployment or user-data migration is required by the platform-only HTTP adapter.
