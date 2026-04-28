# Contract: Request Principal Accessor

This is an internal gateway TypeScript contract. It is not a public HTTP API.

## Types

```ts
export type PrincipalSource = "jwt" | "configured-container" | "dev-default";

export interface RequestPrincipal {
  userId: string;
  source: PrincipalSource;
}

export interface PrincipalRuntimeConfig {
  configuredUserId?: string;
  isTrustedSingleUserGateway: boolean;
  authEnabled: boolean;
  isProduction: boolean;
  isLocalDevelopment: boolean;
  devDefaultUserId: string;
}
```

## Required Behavior

- `userId` must match `^[A-Za-z0-9_-]{1,256}$` before returning a principal.
- Validated JWT `sub` from Hono context wins over every fallback.
- Configured identity is accepted only when no valid JWT principal exists and runtime configuration identifies the gateway as trusted single-user/container.
- `dev-default` is accepted only when local/development is true, auth is disabled, production is false, and no configured identity exists.
- The accessor must not read user identity from request headers, route params, query params, cookies, or request bodies.
- The accessor must not perform network calls, database queries, filesystem I/O, or long-running work.
- The accessor must distinguish:
  - missing identity after auth context is ready
  - missing auth context readiness marker
  - malformed candidate principal user id

## Suggested API Shape

```ts
export function getOptionalRequestPrincipal(c: Context, config?: Partial<PrincipalRuntimeConfig>): RequestPrincipal | null;

export function requireRequestPrincipal(c: Context, config?: Partial<PrincipalRuntimeConfig>): RequestPrincipal;

export function ownerScopeFromPrincipal(principal: RequestPrincipal): { type: "user"; id: string };
```

## Error Contract

| Error | Trigger | Route Mapping |
|-------|---------|---------------|
| `MissingRequestPrincipalError` | Auth context is ready, but no accepted source exists. | 401 `{ "error": "Unauthorized" }` |
| `InvalidRequestPrincipalError` | Candidate identity fails user id validation. | 401 `{ "error": "Unauthorized" }` |
| `RequestPrincipalMisconfiguredError` | Protected route calls accessor before auth context is ready. | 500 generic gateway error |

Routes may log typed error names and coarse source labels. Routes must not log raw tokens, full JWT payloads, request-controlled identity strings, stack traces to clients, or env variable values.
