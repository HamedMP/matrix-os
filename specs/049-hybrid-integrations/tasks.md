# Tasks: Platform Integrations (049)

**Input**: Design documents from `/specs/049-hybrid-integrations/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included (TDD is non-negotiable per project constitution)

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install dependencies, configure environment, prepare project structure

- [ ] T001 Install @pipedream/sdk dependency in gateway: `pnpm add @pipedream/sdk --filter @matrix-os/gateway`
- [ ] T002 [P] Ensure kysely and pg dependencies are available in gateway (verify in packages/gateway/package.json)
- [ ] T003 [P] Add Pipedream env vars (PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID, PIPEDREAM_ENVIRONMENT, PIPEDREAM_WEBHOOK_SECRET) and PLATFORM_DATABASE_URL to .env.example
- [ ] T004 [P] Create packages/gateway/src/integrations/ directory structure
- [ ] T005 Commit setup changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Platform DB, service registry, Pipedream wrapper, gateway routes, and server wiring. ALL user stories depend on this phase.

**CRITICAL**: No user story work can begin until this phase is complete.

### 2A: Platform Database

- [ ] T006 Write failing test for platform DB bootstrap in tests/integrations/platform-db.test.ts
- [ ] T007 Implement platform DB module with Kysely types, migration, CRUD in packages/gateway/src/platform-db.ts
- [ ] T008 Run tests to verify platform DB passes (5 tables: users, connected_services, user_apps, event_subscriptions, billing)
- [ ] T009 Commit platform DB schema and migrations

### 2B: Service Registry + Types

- [ ] T010 [P] Write failing test for service registry in tests/integrations/registry.test.ts
- [ ] T011 [P] Create integration types in packages/gateway/src/integrations/types.ts (ActionParam, ServiceAction, ServiceDefinition, ConnectRequest, CallRequest, ConnectResult, CallResult)
- [ ] T012 Implement service registry with 6 services (gmail, google_calendar, google_drive, github, slack, discord) in packages/gateway/src/integrations/registry.ts
- [ ] T013 Run tests to verify registry passes (6 services, getService, getAction, listServices)
- [ ] T014 Commit service registry

### 2C: Pipedream Connect SDK Wrapper

- [ ] T015 [P] Write failing test for Pipedream wrapper (mocked SDK) in tests/integrations/pipedream.test.ts
- [ ] T016 Implement Pipedream wrapper (createConnectToken, getOAuthUrl, callAction, revokeAccount) in packages/gateway/src/integrations/pipedream.ts
- [ ] T017 Run tests to verify Pipedream wrapper passes (token creation, OAuth URL, proxy call)
- [ ] T018 Commit Pipedream wrapper

### 2D: Gateway Integration Routes

- [ ] T019 Write failing test for all integration routes in tests/integrations/routes.test.ts
- [ ] T020 Implement integration routes (GET /available, GET /, POST /connect, POST /webhook/connected, POST /call, GET /:id/status, DELETE /:id, POST /:id/refresh) in packages/gateway/src/integrations/routes.ts
- [ ] T020a Add HMAC signature verification to POST /webhook/connected using PIPEDREAM_WEBHOOK_SECRET env var and constant-time comparison in packages/gateway/src/integrations/routes.ts
- [ ] T021 Run tests to verify routes pass (available list, connect flow, call proxy, disconnect, reject unknown service, webhook signature rejection)
- [ ] T022 Commit gateway routes

### 2E: Wire into Gateway Server

- [ ] T023 Import platform DB, Pipedream client, and integration routes in packages/gateway/src/server.ts
- [ ] T024 Initialize platform DB and mount routes in createGateway() (conditional on PIPEDREAM_CLIENT_ID + PLATFORM_DATABASE_URL)
- [ ] T025 Run all integration tests to verify server wiring doesn't break anything
- [ ] T026 Commit server wiring

**Checkpoint**: Foundation ready -- all API endpoints functional, database operational, Pipedream SDK connected. User story implementation can now begin.

---

## Phase 3: User Story 1 -- Connect via Settings UI (Priority: P1)

**Goal**: User opens Settings > Integrations, clicks Connect on a service, completes OAuth in popup, sees service appear in connected list.

**Independent Test**: Open settings page, verify 6 services shown. Click Connect, verify OAuth popup opens with correct Pipedream URL. Simulate webhook callback, verify service appears in connected list.

### Implementation for User Story 1

- [ ] T027 [US1] Create IntegrationsSection component with available services grid and Connect buttons in shell/src/components/settings/sections/IntegrationsSection.tsx
- [ ] T028 [US1] Implement OAuth popup flow: click Connect -> POST /connect -> window.open(url) -> poll for completion in shell/src/components/settings/sections/IntegrationsSection.tsx
- [ ] T029 [US1] Add error toast for failed/cancelled OAuth (acceptance scenario 2) in IntegrationsSection.tsx
- [ ] T030 [US1] Add Integrations tab to the settings panel (import IntegrationsSection, add tab entry) in shell/src/components/settings/SettingsPanel.tsx (or equivalent)
- [ ] T030a [US1] Add WebSocket listener in IntegrationsSection that updates connected services list in real-time when connections change (FR-007)
- [ ] T031 [US1] Commit Settings UI connect flow

**Checkpoint**: User can see available integrations and initiate OAuth connection through Settings UI.

---

## Phase 4: User Story 2 -- Connect via Conversation (Priority: P1)

**Goal**: User tells AI "connect my Google Calendar." Agent returns authorization link. After OAuth, agent confirms connection.

**Independent Test**: Call connect_service IPC tool with service="google_calendar", verify it returns an OAuth URL. Simulate webhook, verify connection recorded.

### Implementation for User Story 2

- [ ] T032 [P] [US2] Write failing test for IPC tools in tests/integrations/ipc-tools.test.ts
- [ ] T033 [US2] Implement connect_service IPC tool (calls POST /api/integrations/connect, returns OAuth URL) in packages/kernel/src/tools/integrations.ts
- [ ] T034 [US2] Implement call_service IPC tool (calls POST /api/integrations/call, returns API response) in packages/kernel/src/tools/integrations.ts
- [ ] T035 [US2] Add gatewayFetch helper with 10s AbortSignal.timeout in packages/kernel/src/tools/integrations.ts
- [ ] T036 [US2] Wire integration tools into IPC server: import and spread createIntegrationTools() in packages/kernel/src/ipc-server.ts
- [ ] T037 [US2] Add "mcp__matrix-os-ipc__connect_service" and "mcp__matrix-os-ipc__call_service" to IPC_TOOL_NAMES in packages/kernel/src/options.ts
- [ ] T038 [US2] Run IPC tool tests to verify pass
- [ ] T039 [US2] Commit IPC tools and wiring

**Checkpoint**: Agent can present OAuth URLs to users via conversation and use connected services.

---

## Phase 5: User Story 3 -- Use Connected Services (Priority: P1)

**Goal**: User with connected services asks AI to act: send email, check calendar, post to Slack. Agent calls services via call_service IPC tool.

**Independent Test**: Connect Gmail (via DB seed), call call_service with action="list_messages", verify Pipedream proxy called and response returned. Call with unconnected service, verify helpful error.

**Depends on**: US2 (call_service tool already implemented in T034)

### Implementation for User Story 3

- [ ] T040 [US3] Add input validation in POST /call route: verify service exists in registry, action exists for service, params validated with Zod in packages/gateway/src/integrations/routes.ts
- [ ] T041 [US3] Add ownership check in POST /call: verify authenticated user owns the connection being used in packages/gateway/src/integrations/routes.ts
- [ ] T042 [US3] Handle unconnected service gracefully: return descriptive error with connect link when service not connected in packages/gateway/src/integrations/routes.ts
- [ ] T043 [US3] Update last_used_at timestamp on successful call_service via platformDb.touchServiceUsage() in packages/gateway/src/integrations/routes.ts
- [ ] T043a [US3] Handle rate limiting (FR-012): detect 429 responses from Pipedream proxy, return retry-after info to user, log rate limit event in packages/gateway/src/integrations/routes.ts
- [ ] T043b [US3] Handle Pipedream unavailability: catch network/timeout errors in callAction, return user-friendly "integration service temporarily unavailable" message
- [ ] T044 [US3] Commit service call validation and usage tracking

**Checkpoint**: Agent can read emails, check calendar, post messages on behalf of users.

---

## Phase 6: User Story 4 -- Manage Connections (Priority: P2)

**Goal**: Users view and manage connections through settings UI or conversation. Disconnect services, handle multiple accounts per service.

**Independent Test**: With 3 connected services, verify Settings > Integrations lists all 3 with status indicators. Click Disconnect, verify service removed from DB and Pipedream credentials revoked. With 2 Gmail accounts, verify label disambiguation works.

### Implementation for User Story 4

- [ ] T045 [US4] Add connected services list with status indicators (green/yellow/red) and Disconnect button to IntegrationsSection in shell/src/components/settings/sections/IntegrationsSection.tsx
- [ ] T046 [US4] Implement handleDisconnect: call DELETE /api/integrations/:id, update local state in IntegrationsSection.tsx
- [ ] T047 [US4] Add Pipedream credential revocation in DELETE /:id route (best-effort, still remove from DB on failure) in packages/gateway/src/integrations/routes.ts
- [ ] T048 [US4] Support multiple accounts per service with label disambiguation: show all accounts grouped under service in Settings UI
- [ ] T049 [US4] Add GET /:id/status endpoint for connection health checks in packages/gateway/src/integrations/routes.ts
- [ ] T050 [US4] Commit connection management UI and routes

**Checkpoint**: Users can view all connections, disconnect services, and manage multiple accounts.

---

## Phase 7: User Story 5 -- Build Apps with Integrations (Priority: P2)

**Goal**: Users ask AI to build apps that use connected services (e.g., "summarize my unread emails every morning and post to Slack").

**Independent Test**: Agent uses call_service to fetch Gmail data and post to Slack in same conversation turn. user_apps table records the app with services_used=['gmail', 'slack'].

**Depends on**: US3 (call_service must work)

### Implementation for User Story 5

- [ ] T051 [US5] Add createUserApp, listUserApps, getUserApp CRUD operations to PlatformDb in packages/gateway/src/platform-db.ts
- [ ] T052 [US5] Add user_apps API endpoints (GET /api/apps, POST /api/apps) for tracking which apps use which integrations in packages/gateway/src/integrations/routes.ts (or new routes file)
- [ ] T053 [US5] Add integration manifest validation (integrations.required / integrations.optional validated against service registry) in packages/gateway/src/integrations/registry.ts
- [ ] T054 [US5] Commit app integration tracking

**Checkpoint**: Agent can build multi-service apps, and the platform tracks which services each app uses.

---

## Phase 8: User Story 6 -- Proactive Integration Actions (Priority: P3)

**Goal**: AI uses connected services proactively via cron/heartbeat. Token refresh handled automatically.

**Independent Test**: With Gmail connected and a scheduled check, verify cron triggers call_service to fetch unread emails. Verify POST /:id/refresh triggers Pipedream token refresh.

**Depends on**: US3 (call_service must work), existing cron/heartbeat infrastructure

### Implementation for User Story 6

- [ ] T055 [US6] Add POST /:id/refresh endpoint for forced token refresh via Pipedream in packages/gateway/src/integrations/routes.ts
- [ ] T056 [US6] Add token expiry notification: when Pipedream reports expired token, push reconnect link via WebSocket in packages/gateway/src/integrations/routes.ts
- [ ] T057 [US6] Reserve event_subscriptions operations (createSubscription, listSubscriptions) in PlatformDb -- schema already exists, CRUD for future use in packages/gateway/src/platform-db.ts
- [ ] T058 [US6] Commit proactive integration support

**Checkpoint**: Token refresh works, event subscriptions table ready for future streaming.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: E2E tests, Docker config, security hardening, documentation

- [ ] T059 [P] Write full E2E integration flow test (connect -> call -> disconnect) in tests/integrations/e2e-flow.test.ts
- [ ] T060 [P] Write multi-account E2E test (two Gmail accounts, label disambiguation) in tests/integrations/e2e-flow.test.ts
- [ ] T061 [P] Update docker-compose.dev.yml with platform Postgres config (verify shared instance or add separate service)
- [ ] T062 [P] Write settings UI component tests (render available services, connect flow, disconnect flow) in tests/integrations/settings-ui.test.ts
- [ ] T063 Run full integration test suite: `bun run vitest run tests/integrations/`
- [ ] T064 Security review: verify no wildcard CORS, all endpoints authenticated, webhook signature verified, no credential leakage, Zod validation on all inputs
- [ ] T065 Verify Pipedream SDK calls all have AbortSignal.timeout (10s API, 30s OAuth)
- [ ] T066 Update public docs at www/content/docs/ with integrations guide (connecting services, using call_service, available services)
- [ ] T067 Commit polish, E2E tests, and docs

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion -- BLOCKS all user stories
  - 2A (DB), 2B (Registry), 2C (Pipedream) can run in parallel
  - 2D (Routes) depends on 2A, 2B, 2C
  - 2E (Wiring) depends on 2D
- **US1 (Phase 3)**: Depends on Phase 2 -- Shell UI only
- **US2 (Phase 4)**: Depends on Phase 2 -- IPC tools
- **US3 (Phase 5)**: Depends on Phase 2 + US2 (call_service tool)
- **US4 (Phase 6)**: Depends on Phase 2 + US1 (Settings UI exists)
- **US5 (Phase 7)**: Depends on US3 (call_service works)
- **US6 (Phase 8)**: Depends on US3 (call_service works)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Independent after Foundational -- shell-only work
- **US2 (P1)**: Independent after Foundational -- kernel-only work
- **US3 (P1)**: Needs US2 for call_service tool
- **US4 (P2)**: Needs US1 for Settings UI base component
- **US5 (P2)**: Needs US3 for call_service functionality
- **US6 (P3)**: Needs US3 for call_service functionality

### Within Each User Story

- Tests written first (TDD -- non-negotiable)
- Models/schemas before services
- Services before endpoints
- Core implementation before UI wiring
- Commit after each logical group

### Parallel Opportunities

- T002, T003, T004 can run in parallel (Setup)
- T006-T009, T010-T014, T015-T018 can all run in parallel (Foundational 2A, 2B, 2C)
- US1 and US2 can run in parallel (shell vs. kernel, different packages)
- T059, T060, T061 can run in parallel (Polish)

---

## Parallel Example: Foundational Phase

```bash
# Launch DB, Registry, and Pipedream wrapper in parallel:
Agent A: T006-T009 (Platform DB in packages/gateway/src/platform-db.ts)
Agent B: T010-T014 (Registry in packages/gateway/src/integrations/registry.ts + types.ts)
Agent C: T015-T018 (Pipedream in packages/gateway/src/integrations/pipedream.ts)

# After all three complete:
Agent A: T019-T022 (Routes in packages/gateway/src/integrations/routes.ts)
Agent A: T023-T026 (Server wiring in packages/gateway/src/server.ts)
```

## Parallel Example: P1 User Stories

```bash
# After Foundational complete, US1 and US2 can run in parallel:
Agent A: T027-T031 (Shell Settings UI in shell/src/components/settings/)
Agent B: T032-T039 (IPC tools in packages/kernel/src/tools/)

# US3 starts after US2 completes:
Agent A or B: T040-T044 (Service call validation in packages/gateway/src/integrations/routes.ts)
```

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL -- blocks all stories)
3. Complete Phase 3: US1 (Settings UI connect flow)
4. Complete Phase 4: US2 (Conversational connect + call tools)
5. Complete Phase 5: US3 (Service call validation)
6. **STOP and VALIDATE**: Users can connect services (UI or conversation) and use them
7. Deploy/demo if ready -- this is the MVP

### Incremental Delivery

1. Setup + Foundational -> API operational, DB ready
2. US1 + US2 -> Users can connect services (both UI and conversation)
3. US3 -> Agent can use connected services
4. US4 -> Full connection management (disconnect, multi-account)
5. US5 -> Apps can use integrations
6. US6 -> Proactive/scheduled integration use
7. Each story adds value without breaking previous stories

### Key Files Summary

| File | Phase | Purpose |
|------|-------|---------|
| `packages/gateway/src/platform-db.ts` | 2A | Kysely DB + CRUD |
| `packages/gateway/src/integrations/types.ts` | 2B | Shared TypeScript types |
| `packages/gateway/src/integrations/registry.ts` | 2B | 6 service definitions |
| `packages/gateway/src/integrations/pipedream.ts` | 2C | Pipedream SDK wrapper |
| `packages/gateway/src/integrations/routes.ts` | 2D | Hono REST endpoints |
| `packages/gateway/src/server.ts` | 2E | Server wiring |
| `packages/kernel/src/tools/integrations.ts` | US2 | IPC tools |
| `packages/kernel/src/ipc-server.ts` | US2 | Tool registration |
| `packages/kernel/src/options.ts` | US2 | Tool name allowlist |
| `shell/src/components/settings/sections/IntegrationsSection.tsx` | US1 | Settings UI |

---

## Phase 10: Pipedream Actions API Integration

**Purpose**: Make `call_service` actually work by using Pipedream's Actions API (`client.actions.run()`) instead of the raw proxy. This is what makes the AI agent able to send emails, read calendars, post to Slack, etc.

**Depends on**: All Phase 1-9 work (complete). Requires Pipedream credentials configured.

**CRITICAL**: This is what makes integrations useful. Without this, `call_service` doesn't do anything.

### 10A: Actions API Methods

- [x] T068 [P] Write failing test for discoverActions and runAction in tests/integrations/actions.test.ts (mock sdk.actions.list and sdk.actions.run)
- [x] T069 Add discoverActions(appSlug) method to PipedreamConnectClient: calls sdk.actions.list({ app: slug }), returns array of { key, name, description }
- [x] T070 Add runAction({ externalUserId, componentKey, configuredProps }) method: calls sdk.actions.run(), returns { exports, ret }. Timeout: 30s (actions are slower than proxy)
- [x] T071 Run tests to verify actions methods pass
- [x] T072 Commit actions API methods

### 10B: Component Key Discovery

- [x] T073 [P] Write failing test for discoverComponentKeys in tests/integrations/registry.test.ts
- [x] T074 Add componentKey optional field to ServiceAction in packages/gateway/src/integrations/types.ts
- [x] T075 Implement discoverComponentKeys(pipedream) in registry.ts: iterates all services, calls discoverActions, matches "{app}-{action}" pattern, sets componentKey on matching actions
- [x] T076 Run tests to verify discovery passes
- [x] T077 Commit component key discovery

### 10C: Update POST /call to Use Actions API

- [x] T078 Write failing test: POST /call with discovered componentKey calls runAction instead of callAction proxy
- [x] T079 Update POST /call in routes.ts: look up componentKey from action definition, build configuredProps with { [appSlug]: { authProvisionId: pipedream_account_id } }, call pipedream.runAction(), return { data: ret, summary: exports.$summary }
- [x] T080 Handle missing componentKey gracefully: if action has no discovered key, fall back to callAction proxy
- [x] T081 Run tests to verify POST /call with actions API passes
- [x] T082 Commit routes update

### 10D: Startup Wiring + E2E

- [x] T083 Call discoverComponentKeys(pipedream) in server.ts after mounting routes (non-blocking, log success/failure)
- [x] T084 Add E2E test: connect -> discover -> call action -> verify response has summary and ret
- [x] T085 Run full test suite: `bun run vitest run tests/integrations/`
- [ ] T086 Commit and rebuild Docker for testing

### Parallel Opportunities

- T068 (action tests) and T073 (discovery tests) can run in parallel
- 10A and 10B are independent -- different files, can be done by separate agents
- 10C depends on both 10A and 10B
- 10D depends on 10C

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- TDD: write failing tests first, then implement (non-negotiable)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Pipedream SDK API may differ from plan -- verify actual types after install (see plan.md Task 3 note)
