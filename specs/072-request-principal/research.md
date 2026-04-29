# Research: Request Principal

## Decision: Add a shared request-principal module in `packages/gateway/src/request-principal.ts`

**Rationale**: Current identity resolution lives in `auth.ts` as `getUserIdFromContext`, and routes inject or call it directly. A dedicated module can expose a canonical `RequestPrincipal` type, validation, source precedence, and typed errors without making every route understand fallback rules.

**Alternatives considered**:

- Keep extending `getUserIdFromContext`: rejected because it returns only a string and cannot carry source, auth-context readiness, or typed error distinctions.
- Add principal logic separately inside sync/canvas/workspace routes: rejected because it repeats the drift-prone pattern the feature is meant to remove.

## Decision: Auth middleware marks request auth context readiness

**Rationale**: The spec distinguishes "missing identity" from "route read principal before auth middleware ran." A request-scoped context marker lets the principal accessor return unauthorized for missing identity but a generic server misconfiguration error when route wiring is wrong.

**Alternatives considered**:

- Treat both cases as 401 unauthorized: rejected because it hides integration failures.
- Throw raw errors from route helpers: rejected because error mapping would fragment across routes and risk leaking internals.

## Decision: Principal source precedence is JWT, configured container identity, then dev default

**Rationale**: Validated JWT is the strongest per-request identity and must win over deployment fallback. Configured container identity keeps trusted single-user/container deployments working without requiring per-route logic. `dev-default` is last and only available under the four-condition local-development gate.

**Alternatives considered**:

- Prefer configured container identity over JWT: rejected because it would ignore authenticated per-request identity.
- Allow `dev-default` whenever auth is disabled: rejected because it can mask missing configured identity outside true local development.

## Decision: Canonical configured identity for new resolution is `MATRIX_USER_ID`

**Rationale**: The platform orchestrator already injects `MATRIX_USER_ID` as the Clerk user id for provisioned containers, and production home-mirror comments require it to avoid handle-based drift. New protected route migration should use `MATRIX_USER_ID` as the trusted configured container identity. Existing `MATRIX_HANDLE` fallback remains legacy compatibility to be documented and tracked during migration.

**Alternatives considered**:

- Treat `MATRIX_HANDLE` as equal to `MATRIX_USER_ID`: rejected for new routes because handles are not the same stable owner identifier as Clerk user ids.
- Add a new deployment flag before using configured identity: rejected for this slice because `MATRIX_USER_ID` already provides explicit trusted runtime identity and avoids introducing another configuration axis.

## Decision: Validate every principal user id with `^[A-Za-z0-9_-]{1,256}$`

**Rationale**: This matches the existing sync object-key guard and accepts Clerk-style ids while rejecting path separators, whitespace, empty strings, and oversized values before they reach owner scope, SQL predicates, storage keys, or rate-limit keys.

**Alternatives considered**:

- Accept any non-empty string: rejected because downstream storage and key-building code should not absorb principal validation risk.
- Validate only configured identities but trust JWT `sub`: rejected because signature validity does not prove the subject is safe for this system's sinks.

## Decision: Preserve generic client errors and log details server-side

**Rationale**: Missing identity maps to unauthorized, auth middleware miswiring maps to generic server misconfiguration, and malformed principal values must not reveal JWT claims, tokens, env values, stack traces, or route internals.

**Alternatives considered**:

- Return detailed error codes for each principal failure: rejected because it increases client-visible auth surface and may reveal deployment configuration.

## Decision: No network, database, filesystem, timers, or shared mutable current-user state

**Rationale**: Principal resolution should be deterministic, cheap, and request-scoped. It should read only Hono context and trusted process configuration, then return a value or typed error.

**Alternatives considered**:

- Confirm configured identity against platform DB on each request: rejected because it adds latency, availability coupling, and failure modes outside the current spec.
