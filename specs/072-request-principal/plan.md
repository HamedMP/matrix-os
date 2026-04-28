# Implementation Plan: Request Principal

**Branch**: `072-request-principal` | **Date**: 2026-04-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/072-request-principal/spec.md`

## Summary

Centralize gateway request principal resolution so protected HTTP and WebSocket routes consume one canonical request-scoped principal. The implementation will lift the existing sync-route fail-closed identity pattern into a shared gateway module, validate principal user ids before owner-scope use, preserve explicit single-user/container and local-development fallbacks, and replace hardcoded workspace ownership with principal-derived ownership.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+  
**Primary Dependencies**: Hono gateway, Hono WebSocket support, Zod 4 via `zod/v4`, existing `jose` JWT validation, Vitest  
**Storage**: No new persistence; request principal is request-scoped. Existing consumers continue to use owner-controlled PostgreSQL/Kysely and sync R2/object storage through existing repositories.  
**Testing**: Vitest unit and gateway route integration tests under `tests/gateway/`  
**Target Platform**: Matrix OS gateway running in Linux/container deployments and local development  
**Project Type**: Backend gateway feature in `packages/gateway/`, with documentation artifacts in `specs/072-request-principal/`  
**Performance Goals**: Principal resolution is synchronous/local only and should add no network or database calls; p95 overhead should be effectively negligible relative to route handling.  
**Constraints**: Fail closed for missing/invalid principal, generic client-visible errors, no request-controlled trust gates, no process-global current-user state, no unbounded in-memory collections, no new persistence dependencies, user id regex `^[A-Za-z0-9_-]{1,256}$`  
**Scale/Scope**: Initial user-principal support for protected gateway HTTP and WebSocket routes, with sync/canvas/workspace as representative consumers; organization principals deferred to a later extension of the same seam.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| Data Belongs to Its Owner | Workspace and sync owner scope must come from the resolved owner identity, not hardcoded local placeholders. | PASS: principal-derived owner scope is the core requirement. |
| AI Is the Kernel | Do not change kernel SDK behavior or agent execution semantics. | PASS: gateway auth/ownership only. |
| Headless Core, Multi-Shell | Shared gateway behavior must work for HTTP and browser WebSocket shells. | PASS: plan covers HTTP, WS, sync, canvas, and workspace routes. |
| Quality Over Shortcuts | Avoid route-by-route fallback duplication; use one shared helper. | PASS: shared module with contracts and tests. |
| App Ecosystem | App sandbox and app-session cookie routes must not be weakened by bearer-principal changes. | PASS: app iframe/app-session exemptions remain separate. |
| Multi-Tenancy | Personal owner scope is implemented now; org principals must remain an explicit future extension. | PASS: user principal only, org deferred in spec. |
| Defense in Depth | Auth matrix, input validation, fail-closed behavior, generic errors, and integration wiring must be explicit. | PASS: spec and contracts define all auth sources, validation, and error mapping. |
| Test-Driven Development | Failing tests must precede implementation, covering accepted and rejected principal paths. | PASS: route/unit test plan is explicit. |
| Documentation-Driven Development | Public docs updates must be an explicit deliverable where user-visible behavior or deployment config changes. | PASS: tasks must include docs update or documented deferral for gateway auth/deployment identity. |

**Initial Gate Result**: PASS. No constitution violations require justification.

## Project Structure

### Documentation (this feature)

```text
specs/072-request-principal/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── protected-route-behavior.md
│   └── request-principal.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/gateway/src/
├── auth.ts                         # auth middleware, JWT claim context, auth-ready marker
├── request-principal.ts            # new canonical principal resolver/accessor
├── sync/routes.ts                  # consume shared principal accessor through route deps
├── canvas/routes.ts                # consume shared principal accessor through route deps
├── workspace-routes.ts             # derive owner scope from injected/accessed principal
└── server.ts                       # wire principal deps into protected routes and WS upgrades

tests/gateway/
├── request-principal.test.ts       # unit matrix for source precedence, validation, errors
├── sync/user-id-from-jwt.test.ts   # migrated/extended sync identity behavior
├── canvas-routes.test.ts           # unauthorized and misconfigured accessor mapping
└── workspace-routes.test.ts        # owner scope follows resolved principal

www/content/docs/                  # public docs update or explicit deferral note in tasks
```

**Structure Decision**: Use the existing gateway package and test layout. Add one shared gateway module for request principal resolution, then migrate representative protected routes through dependency injection/accessor wiring.

## Phase 0: Research

See [research.md](./research.md).

Key decisions:

- Use a request-scoped `RequestPrincipal` module instead of expanding `getUserIdFromContext`.
- Source precedence is validated JWT `sub`, then trusted configured container identity, then development default.
- Auth middleware sets an auth-context-ready marker so missing middleware wiring is distinguishable from missing identity.
- `MATRIX_USER_ID` is the canonical configured container user id for new principal resolution; any `MATRIX_HANDLE` compatibility remains documented legacy migration scope.
- Principal resolution performs no network, database, filesystem, or long-running work.

## Phase 1: Design And Contracts

See:

- [data-model.md](./data-model.md)
- [contracts/request-principal.md](./contracts/request-principal.md)
- [contracts/protected-route-behavior.md](./contracts/protected-route-behavior.md)
- [quickstart.md](./quickstart.md)

## Post-Design Constitution Check

| Principle | Result |
|-----------|--------|
| Data Belongs to Its Owner | PASS: data model makes owner scope derive from validated principal user id. |
| Defense in Depth | PASS: contracts define auth matrix, validation, generic errors, request-controlled trust rejection, and WS behavior. |
| TDD | PASS: quickstart and design require red tests for all accepted/rejected sources before implementation. |
| Resource Management | PASS: no new long-lived maps, pools, files, timers, or external calls. |
| Documentation | PASS: implementation tasks must update public docs or record a scoped deferral. |

**Final Gate Result**: PASS. No unresolved clarification items remain.

## Complexity Tracking

No constitution violations or extra architectural complexity require justification.
