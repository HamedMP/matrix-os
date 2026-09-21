# DOMAIN: `identity` — auth, request principal, origin allowlist

Owns who-is-calling: JWT auth, the request-principal model every route
authenticates against, and the allowed-origin list. May import `_shared`
only. Every other domain consumes identity; none implement it.

## Contents

`auth.ts` · `auth-jwt.ts` · `request-principal.ts` · `allowed-origins.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W2): `allowed-origins.ts` placed here, not
  `_shared` — the allowlist is an auth boundary decision, and CORS policy
  must stay next to the auth code that enforces it.
