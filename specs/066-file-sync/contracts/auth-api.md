# API Contracts: OAuth 2.0 Device Authorization Grant (RFC 8628)

These endpoints live on the **platform** service (default port 9000),
NOT the per-user gateway. They issue sync JWTs that any user gateway
trusts via shared secret (HS256) or platform public key (RS256).

All mutating endpoints have `bodyLimit({ maxSize: 4096 })` and
`100 req/min` per IP rate limiting.

Base path: `/`

---

## POST /api/auth/device/code

Start a device-authorization grant. The CLI calls this, prints the
`userCode` to the terminal, and opens `verificationUri` in a browser.

**Auth**: Public (no Authorization header required).

**Request body**:
```typescript
{
  clientId: string  // arbitrary identifier, e.g. "matrixos-cli". Max 256 chars.
}
```

**Response 200**:
```typescript
{
  deviceCode: string,        // 32-byte base64url; the CLI keeps this private
  userCode: string,          // "BCDF-GHJK" (8 chars from RFC 8628 alphabet)
  verificationUri: string,   // "https://platform.matrix-os.com/auth/device?user_code=BCDF-GHJK"
  expiresIn: number,         // seconds until both codes expire (default 900)
  interval: number,          // minimum seconds between polls (default 5)
}
```

**Response 400** `{error: "invalid_request"}`: missing or malformed JSON.
**Response 400** `{error: "invalid_client"}`: clientId missing or too long.
**Response 413** `Payload Too Large`: body exceeds 4096 bytes.
**Response 429** `{error: "too_many_requests"}`: rate limit exceeded.

---

## POST /api/auth/device/token

Poll for the access token. The CLI calls this every `interval` seconds
until it gets 200 (approved), 410 (expired), or a hard error.

**Auth**: Public (no Authorization header required).

**Request body**:
```typescript
{
  deviceCode: string,
  clientId: string  // optional; not validated server-side in Phase 9
}
```

**Response 200** (approved):
```typescript
{
  accessToken: string,    // signed sync JWT (HS256/RS256)
  expiresAt: number,      // epoch ms
  userId: string,         // Clerk userId, e.g. "user_2abcDEF"
  handle: string          // "alice"
}
```

**Response 428** `{error: "authorization_pending"}`: user hasn't approved yet.
The CLI MUST keep polling at the original `interval`.

**Response 429** `{error: "slow_down"}`: polled too fast (under the
`interval`). The CLI MUST add 5 seconds to its interval and continue.

**Response 410** `{error: "expired_token"}`: the device_code has expired.
The CLI MUST stop polling and request a new code.

**Response 400** `{error: "invalid_request"}`: missing/malformed deviceCode.

The JWT carries:
```typescript
{
  sub: string,          // Clerk userId
  handle: string,       // matches the gateway's MATRIX_HANDLE
  gateway_url: string,  // hint -- /api/me is authoritative
  iat: number,          // epoch seconds
  exp: number,          // epoch seconds (default iat + 24 hours)
  iss: "matrix-os-platform"
}
```

---

## GET /auth/device

Renders an HTML page that lets a Clerk-authenticated user confirm a pairing.

**Query**:
- `user_code` (required): the dashed user code from `/api/auth/device/code`.

**Response 200**: `text/html`. Sets a `device_csrf` cookie:
```
Set-Cookie: device_csrf=<32-hex>; Path=/auth/device; Max-Age=900;
            HttpOnly; SameSite=Strict[; Secure]
```

The page embeds:
- The Clerk SignIn widget if no session exists, OR
- A `<form method="POST" action="/auth/device/approve">` with hidden
  `userCode` and `csrf` inputs once a session is present.

**Response 400**: `user_code` query param missing.

---

## POST /auth/device/approve

Marks the device pairing as approved. Intended for the form on
`/auth/device` -- not for direct CLI use.

**Auth**: Clerk Bearer token (header) OR `__session` cookie.

**Request**: `application/x-www-form-urlencoded`
```
userCode=BCDF-GHJK&csrf=<value>
```

**CSRF check**: the `csrf` form value MUST equal the `device_csrf` cookie
set by `GET /auth/device`. Constant-time compared.

**Response 200**: `text/html` with "Login successful, return to your terminal".
The CLI's next poll on `/api/auth/device/token` will return 200 with a JWT.

**Response 401** `{error: "unauthorized"}`: no Clerk session present or invalid.
**Response 403** `{error: "csrf_mismatch"}`: CSRF cookie/form mismatch.
**Response 400** `{error: "invalid_request"}`: malformed body.
**Response 404** `{error: "invalid_user_code"}`: unknown user_code.
**Response 410** `{error: "expired_token"}`: user_code expired before approval.

---

## GET /api/me

Returns the authenticated user's handle and gateway URL. The CLI calls
this after successful login to discover where its daemon should connect.

**Auth**: Sync JWT in `Authorization: Bearer <jwt>` (issued by
`/api/auth/device/token`).

**Response 200**:
```typescript
{
  userId: string,    // Clerk userId
  handle: string,    // "alice"
  gatewayUrl: string // "https://alice.matrix-os.com" or per GATEWAY_URL_TEMPLATE in dev
}
```

**Response 401** `{error: "unauthorized"}`: missing/invalid/expired JWT.
**Response 404** `{error: "unknown_handle"}`: JWT is valid but the
container record has been deleted.

---

## Gateway-side validation

Per-user gateways validate sync JWTs via:

```typescript
import { validateSyncJwt } from "@matrix-os/gateway/auth-jwt";

const claims = await validateSyncJwt(token, {
  secret: process.env.PLATFORM_JWT_SECRET,         // dev (HS256)
  // publicKey: ... ,                              // prod (RS256)
  expectedHandle: process.env.MATRIX_HANDLE,       // cross-tenant defense
  clockTolerance: 30,                              // seconds
});
```

A JWT issued for `@alice` is rejected by `@bob`'s gateway because
`payload.handle !== expectedHandle`.

The gateway's `authMiddleware` accepts both sync JWTs AND the legacy
`MATRIX_AUTH_TOKEN` shared secret in the same Authorization header.
Tokens that look like a JWT (3 base64url segments) go through
`validateSyncJwt`; everything else goes through the legacy timing-safe
compare. This lets service-to-service callers keep using the shared
secret while user CLI/Mac app traffic moves to JWTs.

## Token lifecycle

- **Issue**: `/api/auth/device/token` after Clerk-authenticated approval.
- **Expiry**: 24 hours from issue (default).
- **Refresh**: Not in Phase 9. The CLI runs `matrixos login` again to mint
  a fresh JWT.
- **Revocation**: No explicit revocation endpoint. Revoking the user's
  Clerk session prevents further logins; existing JWTs age out within
  24 hours.
