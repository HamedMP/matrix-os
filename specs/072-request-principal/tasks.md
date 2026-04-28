# Tasks: Request Principal

**Input**: Design documents from `specs/072-request-principal/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`
**Tests**: Required by spec FR-013 and the Matrix OS TDD constitution.
**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and has no dependency on incomplete tasks.
- **[Story]**: User story label for story phases only.
- Every task includes an exact repository-relative file path.

## Phase 1: Setup

**Purpose**: Capture migration/documentation targets before code changes.

- [X] T001 [P] Document current canonical and legacy principal call sites in `specs/072-request-principal/legacy-principal-callers.md`
- [X] T002 [P] Record the public documentation update target for configured container identity in `specs/072-request-principal/docs-update-note.md`

---

## Phase 2: Foundational

**Purpose**: Establish shared contracts and guardrails that block all user stories.

- [X] T003 [P] Add failing compile/runtime contract tests for `RequestPrincipal`, `PrincipalSource`, principal errors, and `ownerScopeFromPrincipal` in `tests/gateway/request-principal.test.ts`
- [X] T004 Create `packages/gateway/src/request-principal.ts` with exported request principal types, typed errors, safe user id regex, and `ownerScopeFromPrincipal`
- [X] T005 Add auth-context readiness constants and request context setters/getters in `packages/gateway/src/auth.ts`
- [X] T006 Export the request principal module from `packages/gateway/src/index.ts`

**Checkpoint**: Shared types and auth-context readiness contract exist; user story work can proceed.

---

## Phase 3: User Story 1 - Resolve Principal Once (Priority: P1) MVP

**Goal**: Protected routes consume one canonical request principal and observe consistent identity or fail-closed behavior.

**Independent Test**: Authenticated, configured-identity, malformed-userId, missing-identity, and missing-auth-context requests all resolve or fail through the shared accessor consistently.

### Tests for User Story 1

- [X] T007 [US1] Add failing source-precedence and fail-closed tests for JWT, configured container identity, malformed user id, missing identity, and missing auth-context readiness in `tests/gateway/request-principal.test.ts`
- [X] T008 [P] [US1] Add failing protected HTTP route mapping tests for unauthorized versus server-misconfiguration principal failures in `tests/gateway/canvas-routes.test.ts`

### Implementation for User Story 1

- [X] T009 [US1] Implement `getOptionalRequestPrincipal`, `requireRequestPrincipal`, source precedence, user id validation, and typed error throwing in `packages/gateway/src/request-principal.ts`
- [X] T010 [US1] Set the auth-context readiness marker on every non-exempt path through `authMiddleware` in `packages/gateway/src/auth.ts`
- [X] T011 [US1] Add canonical principal-to-HTTP error mapping helpers for 401 and generic 500-style responses in `packages/gateway/src/request-principal.ts`
- [X] T012 [US1] Update `createCanvasRoutes` authentication failure handling to preserve generic 401 and generic 500 behavior when its injected identity accessor fails in `packages/gateway/src/canvas/routes.ts`
- [X] T013 [US1] Wire canvas route `getUserId` through `requireRequestPrincipal` in `packages/gateway/src/server.ts`
- [X] T014 [US1] Run focused US1 tests for `tests/gateway/request-principal.test.ts` and `tests/gateway/canvas-routes.test.ts`

**Checkpoint**: User Story 1 is independently functional and is the MVP.

---

## Phase 4: User Story 2 - Keep Development Fallback Explicit (Priority: P1)

**Goal**: Open local development can still use `dev-default`, while production and auth-enabled environments refuse it.

**Independent Test**: Identity resolution accepts `dev-default` only when local/development is true, auth is disabled, production is false, and no configured identity exists.

### Tests for User Story 2

- [X] T015 [US2] Add failing local-development fallback matrix tests for the four-condition `dev-default` gate in `tests/gateway/request-principal.test.ts`
- [X] T016 [P] [US2] Add failing legacy sync helper compatibility tests for auth-enabled and production fallback refusal in `tests/gateway/sync/user-id-from-jwt.test.ts`

### Implementation for User Story 2

- [X] T017 [US2] Implement runtime config derivation for auth-enabled, production, local/development, configured identity, and `dev-default` fallback in `packages/gateway/src/request-principal.ts`
- [X] T018 [US2] Update legacy `getUserIdFromContext` compatibility behavior to delegate to the canonical principal resolver where safe in `packages/gateway/src/auth.ts`
- [X] T019 [US2] Remove mutable warn-once fallback state or replace it with deterministic coarse diagnostics in `packages/gateway/src/auth.ts`
- [X] T020 [US2] Run focused US2 tests for `tests/gateway/request-principal.test.ts` and `tests/gateway/sync/user-id-from-jwt.test.ts`

**Checkpoint**: Development fallback behavior is explicit, bounded, and independently testable.

---

## Phase 5: User Story 3 - Apply Principal To Workspace Ownership (Priority: P2)

**Goal**: Workspace owner scope uses the request principal instead of hardcoded local ownership.

**Independent Test**: Workspace project/session operations create or list user-scoped records under the resolved principal user id and return unauthorized when no principal exists.

### Tests for User Story 3

- [X] T021 [US3] Add failing project creation owner-scope tests using JWT and configured-container principals in `tests/gateway/workspace-routes.test.ts`
- [X] T022 [US3] Add failing agent session owner-id and missing-principal unauthorized tests in `tests/gateway/workspace-routes.test.ts`

### Implementation for User Story 3

- [X] T023 [US3] Add an injected principal or owner-scope dependency to `createWorkspaceRoutes` options in `packages/gateway/src/workspace-routes.ts`
- [X] T024 [US3] Replace hardcoded `ownerScopeFromContext()` local ownership with principal-derived owner scope in `packages/gateway/src/workspace-routes.ts`
- [X] T025 [US3] Wire workspace route owner-scope dependency through `requireRequestPrincipal` in `packages/gateway/src/server.ts`
- [X] T026 [US3] Run focused US3 tests for `tests/gateway/workspace-routes.test.ts`

**Checkpoint**: Workspace owner scope follows the request principal without depending on sync migration.

---

## Phase 6: User Story 4 - Preserve Existing Sync Behavior (Priority: P2)

**Goal**: Sync and adjacent WebSocket paths use the shared principal seam without changing fail-closed authorization semantics.

**Independent Test**: Existing sync authorization tests pass, JWT subjects continue to key sync namespaces, and missing identity still returns unauthorized.

### Tests for User Story 4

- [X] T027 [US4] Add failing sync route tests for canonical principal source `jwt`, source `configured-container`, malformed user id rejection, and missing identity in `tests/gateway/sync/user-id-from-jwt.test.ts`
- [X] T028 [P] [US4] Add failing WebSocket upgrade principal tests for sync/canvas missing identity and missing auth-context handling in `tests/gateway/auth.test.ts`

### Implementation for User Story 4

- [X] T029 [US4] Update `SyncRouteDeps.getUserId` wiring to consume `requireRequestPrincipal` in `packages/gateway/src/server.ts`
- [X] T030 [US4] Update `/ws` sync peer lifecycle identity capture to consume `requireRequestPrincipal` and preserve generic close/error behavior in `packages/gateway/src/server.ts`
- [X] T031 [US4] Update `createCanvasRoutes` WebSocket upgrade identity capture to consume canonical principal mapping in `packages/gateway/src/server.ts`
- [X] T032 [US4] Document any remaining legacy resolver compatibility calls and their removal criteria in `specs/072-request-principal/legacy-principal-callers.md`
- [X] T033 [US4] Run focused US4 tests for `tests/gateway/sync/user-id-from-jwt.test.ts` and `tests/gateway/auth.test.ts`

**Checkpoint**: Sync behavior is preserved while representative HTTP and WebSocket protected paths share the principal seam.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story hardening, docs, and pre-PR verification.

- [X] T034 [P] Add or update a pattern/check test that flags new direct legacy fallback resolver use in new or touched protected routes in `scripts/review/check-patterns.sh`
- [X] T035 [P] Update public deployment/auth documentation for configured container identity and local-development fallback in `www/content/docs/deployment/vps-per-user.mdx`
- [X] T036 [P] Update developer architecture documentation for the request principal seam in `www/content/docs/developer/architecture.mdx`
- [X] T037 Run full focused gateway tests listed in `specs/072-request-principal/quickstart.md`
- [X] T038 Run repository pre-PR checks from `AGENTS.md`: `bun run typecheck`, `bun run check:patterns`, and `bun run test`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational and is the MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational; can run after or alongside US1 once shared resolver contract exists.
- **User Story 3 (Phase 5)**: Depends on Foundational; can run after US1 accessor behavior exists.
- **User Story 4 (Phase 6)**: Depends on Foundational; safest after US1 and US2 because it preserves sync behavior while replacing legacy fallback paths.
- **Polish (Phase 7)**: Depends on all selected user stories.

### User Story Dependencies

- **US1 Resolve Principal Once**: No dependency on other stories after Foundational; recommended MVP.
- **US2 Keep Development Fallback Explicit**: Uses the resolver from US1 but can be validated with unit tests independently.
- **US3 Apply Principal To Workspace Ownership**: Uses the resolver from US1; independent of sync migration.
- **US4 Preserve Existing Sync Behavior**: Uses the resolver and fallback rules from US1/US2; validates migrated sync behavior.

### Parallel Opportunities

- T001 and T002 can run in parallel.
- T003 can run while T004-T006 are prepared, but implementation must wait for the failing test expectation.
- T008 can run in parallel with T007 because it touches `tests/gateway/canvas-routes.test.ts`.
- T016 can run in parallel with T015 because it touches `tests/gateway/sync/user-id-from-jwt.test.ts`.
- T028 can run in parallel with T027 because it touches `tests/gateway/auth.test.ts`.
- T034, T035, and T036 can run in parallel after story implementation is complete.

---

## Parallel Example: User Story 1

```text
Task: "T007 [US1] Add failing source-precedence and fail-closed tests in tests/gateway/request-principal.test.ts"
Task: "T008 [P] [US1] Add failing protected HTTP route mapping tests in tests/gateway/canvas-routes.test.ts"
```

## Parallel Example: User Story 2

```text
Task: "T015 [US2] Add failing local-development fallback matrix tests in tests/gateway/request-principal.test.ts"
Task: "T016 [P] [US2] Add failing legacy sync helper compatibility tests in tests/gateway/sync/user-id-from-jwt.test.ts"
```

## Parallel Example: User Story 4

```text
Task: "T027 [US4] Add failing sync route tests in tests/gateway/sync/user-id-from-jwt.test.ts"
Task: "T028 [P] [US4] Add failing WebSocket upgrade principal tests in tests/gateway/auth.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 only.
3. Validate `tests/gateway/request-principal.test.ts` and `tests/gateway/canvas-routes.test.ts`.
4. Stop and review the shared accessor contract before migrating workspace or sync.

### Incremental Delivery

1. US1 centralizes identity resolution and route error mapping.
2. US2 locks down local-development fallback behavior.
3. US3 removes hardcoded workspace ownership.
4. US4 migrates sync and WebSocket behavior while preserving existing authorization semantics.
5. Polish runs documentation, pattern checks, typecheck, pattern scan, and full tests.

### TDD Rule

For every story phase, complete the story's test tasks first and confirm they fail before implementing the corresponding source changes.
