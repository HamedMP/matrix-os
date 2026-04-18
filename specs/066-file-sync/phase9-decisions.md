# Phase 9 Open Questions -- Decisions

Recorded before implementing T076 per the task brief.

## 1. Gateway URL source

**Decision**: `GET /api/me` on the platform after successful login.

The platform stores `clerkUserId -> handle -> container` in its SQLite db. After token exchange the CLI calls `GET /api/me` (Bearer JWT) to retrieve `{handle, gatewayUrl}` and persists it to `~/.matrixos/config.json`. Embedding `gatewayUrl` in the JWT would lock a token to one gateway -- users may have multiple gateways (laptop dev, cloud production), and rotating gateway URLs would force token revocation.

The JWT still carries `gateway_url` as a hint for the issuer's intended target, but the client treats `/api/me` as authoritative.

## 2. JWT key strategy

**Decision**: HS256 with shared secret `PLATFORM_JWT_SECRET` for Phase 9. Design `validateSyncJwt` to accept either an HS256 secret or an RS256 public key so the swap is config-only.

In dev, both platform and gateway read the same `PLATFORM_JWT_SECRET` env var. In prod the platform issues with HS256 today; a follow-up replaces the env var with an RS256 keypair (`PLATFORM_JWT_PRIVATE_KEY` on platform, `PLATFORM_JWT_PUBLIC_KEY` on gateway).

## 3. Token revocation

**Decision**: No explicit revocation in Phase 9.

Tokens carry a 30-day expiry. If a Clerk session is revoked, the next `matrixos login` issues a new token; old tokens age out within 30 days. A future "force logout all devices" flow can drop a `token_blocklist` table indexed by `jti` if needed -- not now.

## 4. CSRF on `/auth/device/approve`

**Decision**: Double-submit cookie. The `GET /auth/device` page sets a `device_csrf` cookie (random 32-byte hex, `HttpOnly=false; SameSite=Strict; Secure` in prod) and renders a hidden `<input name="csrf">` with the same value. `POST /auth/device/approve` rejects unless the cookie value matches the form field.

This avoids relying on Clerk's internals (which may change) and keeps the approval form independent from the SignIn widget. Request must also carry a valid Clerk session (existing `clerkAuth.verify`).
