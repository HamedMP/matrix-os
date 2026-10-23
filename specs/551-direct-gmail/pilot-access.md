# Isolated pilot access (ENG-355)

The pilot reuses existing Clerk identities. It does not create another Clerk instance or grant Google access. This app-wide boundary is independent of native Gmail eligibility, Google processing profiles/consent, and the stricter Google-data host controls.

## Operator configuration

- `MATRIX_PILOT_ACCESS_ENABLED`: absent or exact `false` preserves ordinary behavior; exact `true` enables the gate. Other values are invalid.
- `MATRIX_PILOT_ALLOWED_CLERK_IDS`: when enabled, a required comma-separated list of at most 100 Clerk user IDs, each at most 128 characters (`user_` plus ASCII letters/digits). Outer whitespace is trimmed; empty/malformed entries or input over 12,999 characters invalidate configuration. IDs are private deployment configuration, never email addresses or client assertions.
- The shared contracts loader returns an immutable `disabled`, `enabled`, or `invalid` snapshot. Invalid platform configuration, or an enabled platform without a Clerk verifier, refuses application construction. The shell refuses private requests with a generic 503 when invalid.

The platform still needs its existing supported Clerk server-verification configuration. No public-key-only startup switch or limited-authority Clerk secret mode is introduced. Assigning production Clerk server authority, configuring the existing Clerk instance's domains/redirects, and changing service ingress/IAM require separate operator review. This change performs none of those actions. Membership changes require replacement configuration/restart; previously issued Matrix tokens are checked against the new cohort on subsequent requests.

## Authentication matrix

| Surface / route | Pilot admission and existing authentication |
| --- | --- |
| Owner HTTP APIs, app-session exchange/provisioning, billing, integration management, account management | Host-independent early checks of cryptographically verified Clerk and Matrix sync-JWT actors; exact cohort membership plus all existing route guards. The consuming Clerk verifier checks membership again so a transient earlier verification failure cannot become approval on retry. |
| Browser shell and native Matrix sessions | Signed Clerk identity or Matrix session principal must be a member. `x-platform-user-id`, route cookies, email, and request body fields never prove membership. Signed platform shell forwarding additionally requires the existing runtime bearer plus HMAC actor proof. |
| `POST /auth/device/approve` | Verified cohort Clerk actor plus existing CSRF/code checks. |
| `POST /api/auth/device/code`, `POST /api/auth/device/token` | Existing bounded device-code capability protocol remains public. Token issuance independently checks the stored approved Clerk actor before minting; removed/nonmember approvals cannot obtain a token. |
| Owner WebSocket upgrade, including `/vm/:handle/ws...`, code host, and query-token paths | Existing signature/runtime access checks, then exact resolved actor membership before opening the upstream. Rejections are bodyless HTTP statuses with `Cache-Control: no-store`. Internal collaboration-control and Gemini service upgrades retain their independent machine authentication. |
| `GET /api/integrations/gmail/oauth/callback` | Exact method/path exception only. Existing one-use stored OAuth state binds the original owner; a browser session is not substituted. |
| `POST /api/integrations/gmail/pipedream/callback` | Exact method/path exception only. Existing attempt secret/provider verification remains mandatory. |
| `POST /api/integrations/webhook/connected` | Exact provider-signature callback remains independently authenticated. No webhook-prefix cohort bypass. |
| Native Mobile `/apps/:slug/*` | Initial GET/HEAD one-use `session` capability and subsequent per-slug HMAC cookie are verified by the actual gateway. Platform routes only to a DB-owned cohort runtime, forwards the original capability, and injects **no** platform bearer or actor proof. A route cookie alone is insufficient. App-cookie requests retain their existing app-scoped methods; no general owner API is exposed. |
| Explicit VM signed app-asset / native stream capabilities | Existing exact capability validators remain authoritative; anonymous capability targets must belong to a cohort owner. No inferred actor proof is minted. |
| Dedicated `/mcp` OAuth access tokens | Existing issuer/audience/scope/signature verifier checks the resulting Clerk actor against the same policy, independently of browser/sync-token verification. Discovery remains public. |
| Internal machine, relay and operator endpoints | Existing independent machine/relay/operator credentials and owner/machine binding remain required. The cohort list never supplies or replaces those credentials. No broad internal-path authentication bypass is added. |
| `GET /health`, sign-in/static prerequisites, existing public metadata | Health and exact capability dispatch remain available; the shell preserves only its explicit sign-in/static prerequisites. Public metadata never authenticates an owner. |

Nonmember responses are generic and uncached. Protocol exceptions do not authorize arbitrary callback suffixes or methods. Ordinary disabled behavior is preserved.

## Native Mobile wiring and regression

`apps/mobile/lib/storage.ts` resolves a hosted selected computer's launch URL to canonical `/apps/...`; `AppRuntimeFrame` does not supply a Clerk header. The authenticated app-session mint API remains cohort protected. Production host nginx (`scripts/install-server.sh`) routes `/apps/` directly to gateway port 4000, not Next.js, so no shell cohort exception is needed. The gateway consumes the one-use token and issues/verifies the per-slug cookie. Avoiding platform bearer injection is essential: its app-asset shortcut must not bypass that cookie verifier.

The composed regression uses real platform routing, gateway auth, app-runtime registrar, one-use store, HMAC cookie middleware and static dispatcher. It checks native mint/launch, replay, forged asset cookie, unsigned route-only cookie, no fabricated platform actor, and noncohort target refusal before upstream dispatch. Other focused tests use genuinely signed Clerk/Matrix/MCP tokens, HTTP/session/native issuance and WebSocket denial, permitted actors, default-disabled behavior and malformed configuration. These are source tests, not evidence of deployed sign-in or five-surface qualification.

## Entrypoint extraction plan and remaining qualification

New policy parsing and platform admission live in small dedicated modules. Existing large `main.ts`, session-routing and WebSocket entrypoints receive composition/admission calls only. Follow-up extraction should move the existing app-domain identity/capability routing block and native token mint composition into independently testable registrars without changing auth order, before adding another policy or protocol to these entrypoints.

Before opening pilot ingress: review the exact immutable image and configuration, existing Clerk authority/domains, negative nonmember access, the three intended accounts, actual OAuth callbacks, and each affected running surface. Gmail and processing approval remain separate gates; this document makes no audit/Google/CASA readiness claim. A separate private-site documentation PR must describe pilot availability and access behavior when the pilot is qualified; never publish the private allowlist.
