# Data Model: Request Principal

This feature adds request-scoped domain values only. It does not add database tables, files, long-lived caches, or durable state.

## RequestPrincipal

Represents the canonical owner identity accepted for a protected gateway request.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `userId` | string | yes | Must match `^[A-Za-z0-9_-]{1,256}$` before owner-scope, database, storage-key, or rate-limit use. |
| `source` | `jwt` \| `configured-container` \| `dev-default` | yes | Must reflect the accepted source after precedence resolution. |

### Source Precedence

1. `jwt`: validated JWT claims exist on the Hono context and `sub` passes `userId` validation.
2. `configured-container`: no accepted JWT principal exists, gateway is a trusted single-user/container gateway, and trusted runtime configuration provides a valid configured user id.
3. `dev-default`: no accepted JWT or configured identity exists, environment is local/development, auth is disabled, production is false, and the configured development user id passes validation.

### Rejected States

- JWT claims exist but `sub` is empty, longer than 256 characters, or contains characters outside the safe user id regex.
- No auth-context-ready marker exists for a route that requests a principal.
- Configured container identity is requested from request-controlled input.
- `dev-default` is requested while auth is enabled or production is true.

## PrincipalSource

Explains why a principal was accepted.

| Value | Meaning |
|-------|---------|
| `jwt` | Identity came from validated JWT claims placed on request context by auth middleware. |
| `configured-container` | Identity came from trusted Matrix OS runtime/deployment configuration for a single-owner gateway. |
| `dev-default` | Identity came from explicit open local-development fallback. |

## TrustedSingleUserContainerGateway

Describes an allowed deployment mode for configured identity fallback.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `configuredUserId` | string | yes | Trusted runtime value, expected from `MATRIX_USER_ID`; must pass principal user id validation. |
| `isTrustedSingleUserGateway` | boolean | yes | Derived from deployment/runtime configuration controlled by Matrix OS platform provisioning, not request input. |

### Notes

- `MATRIX_USER_ID` is the canonical configured identity for new principal resolution.
- Existing `MATRIX_HANDLE` fallback is legacy compatibility and must remain documented/tracked until migrated or removed.

## OwnerScope

Represents the owner context passed to workspace, canvas, sync, or other owner-scoped services.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `type` | `user` | yes | Initial scope supports user principals only. |
| `id` | string | yes | Must equal `RequestPrincipal.userId`. |

### Relationship

`OwnerScope.id` is derived from `RequestPrincipal.userId`; it must not be hardcoded to `local`, `default`, or a route-specific placeholder in protected route behavior.

## Error States

| State | Meaning | Client Mapping |
|-------|---------|----------------|
| Missing principal | Auth context ran but no allowed identity source resolved. | Generic 401 unauthorized. |
| Invalid principal | A candidate identity failed user id validation. | Generic 401 unauthorized for auth absence/invalid identity; server logs details without secrets. |
| Auth context missing | A protected route requested principal before auth middleware populated readiness context. | Generic 500-style server misconfiguration error. |
