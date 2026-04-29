# Feature Specification: Request Principal

**Feature Branch**: `072-request-principal`  
**Created**: 2026-04-28  
**Status**: Draft  
**Input**: User description: "Centralize Matrix OS gateway request principal resolution by lifting the existing sync-route fail-closed identity pattern into a shared gateway seam. Protected routes should consume a canonical principal, local-development fallback should remain explicit, and workspace owner scope should stop hardcoding a local user."

## Clarifications

### Session 2026-04-28

- Q: When no validated JWT is present, where may the explicit configured container identity be accepted as the request principal? → A: Any protected route in a trusted single-user/container gateway may use explicit configured identity; JWT wins when present.
- Q: What exact gate should define "open local-development mode" for allowing the `dev-default` principal? → A: Allow only when environment is local/development, auth is disabled, production is false, and no configured identity exists.
- Q: If a protected route reads the principal before auth middleware has populated request auth context, what should the shared accessor return? → A: Generic 500-style server misconfiguration error; log details server-side, expose no internals.
- Q: What validation rule should the canonical principal apply to `userId` before it can be used for owner scope or storage keys? → A: Require `^[A-Za-z0-9_-]{1,256}$` for all principal user ids.
- Q: During migration, what should happen when legacy route code still calls the old raw fallback resolver? → A: Allow documented legacy calls temporarily; warn/track them, and forbid new or touched protected routes from using them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resolve Principal Once (Priority: P1)

A maintainer can rely on one gateway request principal for protected routes instead of each route re-running identity fallback logic.

**Why this priority**: Owner-scoped Matrix data depends on consistent identity. If every route resolves identity independently, authorization behavior can drift.

**Independent Test**: Send authenticated and unauthenticated requests through representative protected routes and verify they all observe the same resolved principal or the same unauthorized response.

**Acceptance Scenarios**:

1. **Given** a request has a validated JWT with a user subject, **When** a protected route reads the request principal, **Then** the principal contains that user id and identifies JWT as the source.
2. **Given** a request has no validated JWT but the trusted single-user/container gateway has an explicit configured Matrix user identity, **When** a protected route reads the request principal, **Then** the principal contains that configured identity and identifies environment configuration as the source.
3. **Given** a protected request has no authenticated or configured identity, **When** the route attempts to read the request principal, **Then** the request fails closed with a safe unauthorized response.

---

### User Story 2 - Keep Development Fallback Explicit (Priority: P1)

A developer running Matrix OS in open local development can still use the development-only default identity, while production and auth-enabled environments refuse that fallback.

**Why this priority**: The current local-dev fallback is useful, but it must not silently shape production behavior or owner-scoped data access.

**Independent Test**: Exercise identity resolution with auth disabled in local development, with auth enabled, and with production mode enabled.

**Acceptance Scenarios**:

1. **Given** Matrix OS is running in local/development mode with auth disabled, production false, no auth token, and no configured container identity, **When** a route needs a principal, **Then** the system may return a default development principal with source `dev-default`.
2. **Given** sync auth is enabled, **When** a request has no valid user identity, **Then** default fallback is refused.
3. **Given** Matrix OS is running in production, **When** a request has no valid user identity, **Then** default fallback is refused.

---

### User Story 3 - Apply Principal To Workspace Ownership (Priority: P2)

A maintainer can use the request principal as the source of workspace owner scope instead of hardcoded local ownership.

**Why this priority**: Workspace orchestration cannot satisfy Data Belongs to Its Owner while workspace routes hardcode a local owner.

**Independent Test**: Start or list workspace sessions under a request principal and verify the owner id follows the resolved principal rather than a hardcoded value.

**Acceptance Scenarios**:

1. **Given** a protected workspace request has a resolved principal, **When** the workspace layer creates or lists user-scoped records, **Then** it uses the principal user id as the owner id.
2. **Given** the principal source changes between JWT and configured container identity, **When** workspace routes run, **Then** owner scope follows the principal source consistently.
3. **Given** no principal is available, **When** a workspace route needs owner scope, **Then** it returns unauthorized rather than creating records under a local placeholder.

---

### User Story 4 - Preserve Existing Sync Behavior (Priority: P2)

A maintainer can migrate sync and adjacent routes to the shared request principal seam without changing existing sync authorization behavior.

**Why this priority**: Sync routes already contain the correct fail-closed pattern. The feature should generalize that pattern, not regress it.

**Independent Test**: Run existing sync authorization tests and new shared-principal tests against the same unauthorized scenarios.

**Acceptance Scenarios**:

1. **Given** sync routes currently convert missing identity into unauthorized, **When** they use the shared principal seam, **Then** they still return unauthorized for missing identity.
2. **Given** sync routes receive a valid JWT subject, **When** they use the shared principal seam, **Then** namespace and ownership behavior is unchanged.
3. **Given** a non-sync protected route uses the shared principal seam, **When** missing identity occurs, **Then** it matches the sync route unauthorized behavior.

### Edge Cases

- A request has a validated JWT whose subject is empty, longer than 256 characters, or contains characters outside `^[A-Za-z0-9_-]{1,256}$`.
- A request has both a JWT subject and configured container identity; the JWT subject must win.
- A local-development request has no identity, auth is disabled, production is false, and no configured container identity exists; the default development identity must be visibly identified as development-only.
- A production or auth-enabled request has no identity; the request must fail closed.
- A route reads the principal before auth middleware has populated request auth context; the shared accessor must treat this as server misconfiguration, log details server-side, and return only a generic client-visible 500-style error.
- A WebSocket upgrade path needs the same principal behavior as an HTTP route after token validation.
- Legacy route code still calls the old resolver during migration; existing calls may remain only when documented and tracked, while new or touched protected routes must use the canonical principal accessor.
- Logging for fallback behavior must not leak secrets or raw tokens.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose a canonical request principal for protected gateway routes.
- **FR-002**: The request principal MUST include a stable user id and the source used to resolve it.
- **FR-003**: The request principal user id MUST match `^[A-Za-z0-9_-]{1,256}$` before it can be accepted for owner scope, database queries, storage keys, or rate-limit keys.
- **FR-004**: The request principal MUST prefer validated JWT subject over configured container identity.
- **FR-005**: Configured container identity MUST be available only as an explicit fallback after JWT identity is absent, MAY be accepted by any protected route running in a trusted single-user/container gateway, and MUST NOT be accepted otherwise.
- **FR-006**: The development default identity MUST be available only when the environment is local/development, auth is disabled, production is false, and no configured container identity exists.
- **FR-007**: Production and auth-enabled environments MUST refuse development default identity fallback.
- **FR-008**: Missing request identity on protected routes MUST produce a safe unauthorized response.
- **FR-009**: Sync routes MUST preserve their existing fail-closed missing-identity behavior after migration to the shared principal seam.
- **FR-010**: Workspace owner scope MUST be derived from the request principal for user-scoped workspace operations.
- **FR-011**: Routes that cannot yet migrate MUST have an explicit documented compatibility path, warning/tracking for remaining legacy resolver calls, and MUST NOT introduce new raw fallback resolver usage in new or touched protected routes.
- **FR-012**: Client-visible errors MUST remain generic and MUST NOT expose JWT claims, auth tokens, environment variables, or internal route details.
- **FR-013**: Tests MUST cover JWT identity, configured identity, development default identity, missing identity, malformed principal user ids, and workspace owner-scope behavior.
- **FR-014**: Reading the principal before auth middleware has populated request auth context MUST fail closed as a generic server misconfiguration error rather than unauthorized identity absence.

### Key Entities *(include if feature involves data)*

- **Request Principal**: The authenticated or explicitly allowed development identity attached to a gateway request.
- **Principal Source**: The reason a principal was accepted, such as validated JWT, configured container identity, or development default.
- **Owner Scope**: The user or organization ownership context used to scope Matrix OS data.
- **Protected Route**: A gateway route that requires a request principal before reading or mutating owner-scoped data.
- **Trusted Single-User/Container Gateway**: A gateway instance that deployment configuration identifies as serving exactly one Matrix OS owner and that provides an explicit configured user identity from trusted runtime configuration, never from request-controlled input.

### Assumptions

- Existing auth middleware remains responsible for validating bearer or query-token credentials and placing validated JWT claims on request context.
- Local-development fallback exists only to keep open local dev usable when no auth token or configured container identity is available.
- Initial scope covers user principals; organization principals can extend the same seam later.
- The first implementation slice may create minimal domain documentation or record that domain documentation is deferred.

### Security Architecture

| Surface | Operation | Auth Method | Public? | Authorization / Notes |
|---------|-----------|-------------|---------|-----------------------|
| Protected HTTP routes | Read or mutate owner-scoped gateway data | Validated bearer/session token, explicit trusted single-user/container identity, or explicit local-dev fallback | No | Missing principal fails closed with unauthorized response. |
| Protected WebSocket routes | Subscribe, attach, or mutate owner-scoped realtime state | Validated header/query-token path where browsers require it, explicit trusted single-user/container identity, or explicit local-dev fallback | No | Principal resolution occurs after token validation and before route behavior. |
| Sync routes | Manifest, presign, commit, conflict, sharing, subscription | Existing sync JWT/container identity policy | No | Existing fail-closed behavior must be preserved. |
| Workspace routes | Project, task, preview, session, review state | Shared request principal | No | Owner scope uses request principal rather than a hardcoded local owner. |

### Integration Wiring Requirements

- Auth middleware MUST continue to validate credentials before protected routes use the request principal.
- If no validated JWT is present, the shared principal seam MAY accept explicit configured container identity for any protected route only when the gateway is running as a trusted single-user/container gateway.
- The configured container identity trust gate MUST be derived from deployment/runtime configuration controlled by Matrix OS platform provisioning, not from request headers, route params, query params, cookies, or client-supplied bodies.
- The principal accessor MUST distinguish missing identity from missing auth middleware context so route wiring failures are surfaced as generic server misconfiguration errors.
- The shared principal seam MUST be available to sync routes, canvas routes, workspace routes, and other owner-scoped gateway modules.
- Workspace owner scope MUST derive from the same principal as sync and canvas owner scope.
- Route handlers SHOULD consume a principal accessor rather than reading JWT claims or environment fallback values directly.
- Compatibility wrappers and documented legacy resolver calls MUST be temporary, easy to find during migration, and covered by a test or pattern check that prevents new usage in new or touched protected routes.

### Failure Modes And Resource Management

- Missing or invalid principal on protected routes MUST fail closed.
- Fallback source selection MUST be deterministic and test-covered.
- Development fallback diagnostics MUST avoid mutable global warn-once state where possible.
- Principal resolution MUST not perform network calls or long-running work.
- Principal context MUST be request-scoped and MUST NOT use process-global or cross-package mutable state to represent the current user.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All migrated protected routes return the same unauthorized response for missing identity in auth-enabled and production environments.
- **SC-002**: Existing sync authorization tests continue to pass after migration to the shared principal seam.
- **SC-003**: Workspace owner scope uses the resolved user id in tests and no longer depends on a hardcoded local owner for covered operations.
- **SC-004**: New tests cover all accepted principal sources and all rejected missing-identity modes.
- **SC-005**: No new or touched protected gateway route introduced by this feature calls the legacy fallback resolver directly, and any remaining legacy calls are documented and tracked.
- **SC-006**: Review confirms no client-visible error exposes tokens, JWT payloads, environment variable values, stack traces, or internal route names.
