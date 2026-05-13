# Tasks: VPS Browser Runtime

**Input**: Design documents from `/specs/074-vps-browser-runtime/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: Required by FR-038. Write failing tests before implementation.
**Organization**: Tasks are grouped by user story so each story can be implemented and tested as an independent increment after the shared foundation is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other [P] tasks in the same phase after prerequisites are met
- **[Story]**: User story label for story phases only
- Every task includes an exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare package, app, VPS, and test scaffolding for Browser implementation.

- [ ] T001 Update Browser package exports and dependency metadata in packages/mcp-browser/package.json
- [ ] T002 Add gateway Browser dependency metadata and scripts in packages/gateway/package.json
- [ ] T003 Update root workspace lockfile after dependency changes in pnpm-lock.yaml
- [ ] T004 [P] Create first-party Browser app scaffold in home/apps/browser/package.json, home/apps/browser/vite.config.ts, home/apps/browser/tsconfig.json, home/apps/browser/index.html, home/apps/browser/src/main.tsx, and home/apps/browser/src/App.tsx
- [ ] T005 [P] Create Browser app manifest in home/apps/browser/matrix.json
- [ ] T006 [P] Add shipped Browser icon asset in home/system/icons/browser.svg
- [ ] T007 [P] Create Browser service unit scaffold in distro/customer-vps/systemd/matrix-browser.service
- [ ] T008 [P] Create browser test directory placeholder in tests/browser/.gitkeep
- [ ] T009 [P] Create Browser E2E spec placeholder in shell/e2e/browser-app.spec.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core security, protocol, persistence, and runtime contracts that must exist before any user story work starts.

**Critical**: No user story work can begin until this phase is complete.

### Tests First

- [ ] T010 [P] Add URL policy tests for IPv4, IPv6, private ranges, Matrix hosts, redirects, DNS rebinding, and WebSocket URLs in tests/browser/url-policy.test.ts
- [ ] T011 [P] Add shared runtime, profile lock, focus lease, takeover, and action-queue tests in tests/browser/session-manager.test.ts
- [ ] T012 [P] Add standalone focus-lease stale-input tests in tests/browser/focus-lease.test.ts
- [ ] T013 [P] Add stream protocol validation tests for versioning, message caps, safe errors, and fallback frames in tests/browser/ws.test.ts
- [ ] T014 [P] Add WebRTC media-plane tests for server-offer/client-answer, relay-only ICE, TURN expiry, and fallback-frame policy in tests/browser/media-plane.test.ts
- [ ] T015 [P] Add TURN candidate filtering and short-lived credential tests in tests/browser/turn-policy.test.ts
- [ ] T016 [P] Add asymmetric handoff token verification tests in tests/browser/handoff-token.test.ts
- [ ] T017 [P] Add deterministic Chromium password-store launch tests in tests/browser/password-store.test.ts
- [ ] T018 [P] Add gateway Browser route auth, bodyLimit, Zod, safe-error, and owner-isolation tests in tests/browser/routes.test.ts
- [ ] T019 [P] Add Browser download staging, atomic publish, and cleanup tests in tests/browser/downloads.test.ts
- [ ] T020 [P] Add customer VPS Browser capability hardening tests in tests/customer-vps/browser-capability.test.ts

### Core Implementation

- [ ] T021 Implement Browser stream protocol Zod schemas and bounded message constants in packages/mcp-browser/src/stream-protocol.ts
- [ ] T022 Implement hardened URL, redirect, DNS binding, WebSocket, profile, artifact, and password-store guards in packages/mcp-browser/src/security.ts
- [ ] T023 Refactor shared Browser runtime, profile locks, same-device multiplexing, takeover, focus lease, idle timeout, and serialized action queue in packages/mcp-browser/src/session-manager.ts
- [ ] T024 Implement Browser runtime session/tab/download/control service in packages/mcp-browser/src/runtime-service.ts
- [ ] T025 Implement WebRTC media service, relay-only ICE filtering, TURN credential expiry handling, audio mute state, and fallback frame caps in packages/mcp-browser/src/media-service.ts
- [ ] T026 Update existing MCP Browser tool to use shared runtime service, URL guards, and permission-aware action serialization in packages/mcp-browser/src/browser-tool.ts
- [ ] T027 Add owner-scoped Browser database repository for profiles, sessions, tabs, streams, downloads, grants, and audit in packages/gateway/src/browser/repository.ts
- [ ] T028 Add owner filesystem profile, staging-download, completed-download, screenshot, thumbnail, crash-artifact, symlink-safe cleanup helpers in packages/gateway/src/browser/profile-store.ts
- [ ] T029 Add Browser gateway URL preflight, navigation binding, redirect revalidation, runtime revalidation, and safe error mapping in packages/gateway/src/browser/url-policy.ts
- [ ] T030 Add platform-signed Browser handoff token verifier using pinned public key/JWKS material in packages/gateway/src/handoff-token.ts
- [ ] T031 Add short-lived owner/session-bound TURN credential minting and relay-only policy helpers in packages/gateway/src/turn-credentials.ts
- [ ] T032 Add Browser orchestration service for capability checks, sessions, tabs, profile clearing, downloads, grants, audit, shutdown drains, and safe errors in packages/gateway/src/browser/service.ts
- [ ] T033 Add Browser REST routes with auth, bodyLimit, Zod boundary validation, and safe-error mapper in packages/gateway/src/browser/routes.ts
- [ ] T034 Add Browser WebSocket route with subprotocol token auth, protocol negotiation, focus messages, WebRTC signaling, stale eviction, and shutdown drain in packages/gateway/src/browser/ws.ts
- [ ] T035 Register Browser REST and WebSocket routes plus shutdown drains in packages/gateway/src/server.ts
- [ ] T036 Add Browser route auth allowlist and subprotocol validation integration in packages/gateway/src/auth.ts
- [ ] T037 Add Browser capability version and TURN/public-key environment plumbing in packages/platform/src/customer-vps-config.ts
- [ ] T038 Add Browser service provisioning, Chromium installation, password-store flag, TURN/JWKS env, and service enablement to distro/customer-vps/cloud-init.yaml
- [ ] T039 Harden matrix-browser.service with non-root user, NoNewPrivileges, PrivateTmp, restricted writes, resource limits, restart policy, and shutdown drain in distro/customer-vps/systemd/matrix-browser.service
- [ ] T040 Include Browser app, runtime artifacts, service unit, public key/JWKS metadata, and Chromium provisioning in scripts/build-host-bundle.sh

**Checkpoint**: Browser foundation ready. URL policy, shared runtime, auth, protocol, persistence, media, handoff, TURN, password-store, service hardening, and cleanup contracts have failing-then-passing tests.

---

## Phase 3: User Story 1 - Browse Inside Matrix Canvas (Priority: P1) MVP

**Goal**: User opens Browser in Matrix Canvas and interacts with a normal website rendered by the VPS-local Chromium runtime.
**Independent Test**: Open Browser in Canvas, navigate to a site that blocks iframe embedding, interact with it, close/reopen the Matrix window, and verify the same owner profile state remains available.

### Tests for User Story 1

- [ ] T041 [P] [US1] Add Browser Canvas app unit tests for toolbar, viewport states, focus, audio mute, and safe error states in tests/default-apps/browser-app.test.tsx
- [ ] T042 [P] [US1] Add gateway session create/resume contract tests for Canvas surface in tests/browser/routes.test.ts
- [ ] T043 [P] [US1] Add WebSocket Canvas stream contract tests for stream.hello, stream.ready, media.offer, surface.focused, input, and stale_focus in tests/browser/ws.test.ts
- [ ] T044 [P] [US1] Add Canvas E2E smoke for opening Browser, navigating, focusing, and reconnecting in shell/e2e/browser-app.spec.ts

### Implementation for User Story 1

- [ ] T045 [P] [US1] Implement shared Browser app protocol client in home/apps/browser/src/browser-protocol.ts
- [ ] T046 [P] [US1] Implement Browser session React hook with REST session create/resume, stream token handling, WebSocket reconnect, and safe error state in home/apps/browser/src/useBrowserSession.ts
- [ ] T047 [P] [US1] Implement Browser toolbar for URL entry, back, forward, refresh, tabs, audio mute, and status in home/apps/browser/src/BrowserToolbar.tsx
- [ ] T048 [P] [US1] Implement Browser WebRTC viewport, fallback frame rendering, resize, focus, pointer, wheel, keyboard, IME, paste, and disconnected states in home/apps/browser/src/BrowserViewport.tsx
- [ ] T049 [US1] Compose Canvas Browser app UX with empty, loading, browsing, blocked, unavailable, profile-locked, deferred-feature, and startup-failure states in home/apps/browser/src/App.tsx
- [ ] T050 [US1] Add Browser app styling consistent with Matrix app conventions in home/apps/browser/src/styles.css
- [ ] T051 [US1] Wire Browser app entry and runtime type in home/apps/browser/src/main.tsx
- [ ] T052 [US1] Ensure Browser manifest uses Vite runtime and shipped icon in home/apps/browser/matrix.json
- [ ] T053 [US1] Register Browser as a deterministic default app/icon in packages/gateway/src/apps.ts
- [ ] T054 [US1] Update default app/icon determinism tests for Browser in tests/gateway/apps.test.ts
- [ ] T055 [US1] Build Browser app through default app builder in scripts/build-default-apps.mjs

**Checkpoint**: User Story 1 is independently functional in Canvas.

---

## Phase 4: User Story 2 - Open A Browser Route Outside Canvas (Priority: P1)

**Goal**: User opens a URL-shaped Browser route and gets the same Browser session as a standalone surface without Canvas chrome.
**Independent Test**: Open `/browser/google.com`, authenticate, verify route resolves to the owner VPS Browser route, navigate, then open Canvas Browser and confirm both surfaces share the same owner profile/runtime.

### Tests for User Story 2

- [ ] T056 [P] [US2] Add shell standalone route tests for `/browser/[...target]` auth and target normalization in tests/shell/browser-route.test.tsx
- [ ] T057 [P] [US2] Add platform redirect-only handoff tests for owner VPS resolution and no proxying in tests/browser/handoff-token.test.ts
- [ ] T058 [P] [US2] Add standalone route E2E smoke for `/browser/google.com` and Canvas session sharing in shell/e2e/browser-app.spec.ts
- [ ] T059 [P] [US2] Add proxy route regression tests to ensure Browser standalone path is owner-hosted, not proxied as target-site content, in tests/shell/proxy-auth.test.ts

### Implementation for User Story 2

- [ ] T060 [US2] Add standalone Browser route page that hosts Browser app without Canvas chrome in shell/src/app/browser/[...target]/page.tsx
- [ ] T061 [US2] Add Browser standalone route helper for target extraction and owner-host app URL construction in shell/src/lib/proxy-routes.ts
- [ ] T062 [US2] Reuse standalone app opening behavior for Browser full-tab launches in shell/src/lib/open-app-tab.ts
- [ ] T063 [US2] Add platform `/browser/*` redirect-only route with Matrix auth, owner VPS lookup, asymmetric handoff signing, one-use nonce, and generic errors in packages/platform/src/main.ts
- [ ] T064 [US2] Add owner VPS Browser handoff verification and session bootstrap integration in packages/gateway/src/browser/routes.ts
- [ ] T065 [US2] Add platform Browser handoff config for public key/JWKS, token expiry, target binding, and owner host allowlist in packages/platform/src/customer-vps-config.ts
- [ ] T066 [US2] Add standalone Browser route docs to www/content/docs/browser.mdx

**Checkpoint**: User Story 2 is independently functional as an authenticated standalone Browser route.

---

## Phase 5: User Story 3 - Persist Owner Browser Profiles (Priority: P1)

**Goal**: Browser logins, cookies, site storage, downloads, session metadata, clearing, export, and audit remain scoped to the Matrix owner environment.
**Independent Test**: Sign in to a site, download a file, clear selected profile scopes, inspect owner export/recovery surfaces, and verify another owner cannot access the profile or downloads.

### Tests for User Story 3

- [ ] T067 [P] [US3] Add owner isolation repository tests for profiles, sessions, tabs, downloads, grants, and audit in tests/browser/routes.test.ts
- [ ] T068 [P] [US3] Add profile clear tests for cookies, IndexedDB, local/session storage, cache/service workers, site permissions, saved form data, saved passwords, history, and downloads in tests/browser/routes.test.ts
- [ ] T069 [P] [US3] Add download staging, atomic publish, failed-download cleanup, safe filename, and owner file-surface tests in tests/browser/downloads.test.ts
- [ ] T070 [P] [US3] Add audit retention, redaction, `session.taken_over`, and owner-visible cursor tests in tests/browser/routes.test.ts
- [ ] T071 [P] [US3] Add owner export/delete Browser data integration tests in tests/gateway/files-tree.test.ts

### Implementation for User Story 3

- [ ] T072 [US3] Add Browser owner Postgres schema and migration for profiles, sessions, tabs, streams, downloads, grants, audit, and unique live-session constraints in packages/gateway/src/browser/repository.ts
- [ ] T073 [US3] Implement transactional profile/session/tab/download/grant/audit repository methods with owner filters in packages/gateway/src/browser/repository.ts
- [ ] T074 [US3] Implement profile clear orchestration, active-session close, deterministic saved-password clearing, and per-scope safe errors in packages/gateway/src/browser/service.ts
- [ ] T075 [US3] Implement download staging, Chromium download hooks, atomic publish, Matrix files indexing, failed cleanup, and delete behavior in packages/gateway/src/browser/profile-store.ts
- [ ] T076 [US3] Implement audit event creation, redaction, cursor pagination, 180-day retention pruning, and `session.taken_over` event writing in packages/gateway/src/browser/repository.ts
- [ ] T077 [US3] Implement export/delete integration for Browser profiles, downloads, and metadata in packages/gateway/src/files-tree.ts
- [ ] T078 [US3] Add Browser profile/download settings and clear-data UI to home/apps/browser/src/App.tsx
- [ ] T079 [US3] Add Browser downloads list and file-open/delete UI to home/apps/browser/src/BrowserToolbar.tsx
- [ ] T080 [US3] Update Browser data ownership, clearing, downloads, audit, export, and recovery docs in www/content/docs/browser.mdx

**Checkpoint**: User Story 3 is independently functional for owner-scoped persistence, downloads, clearing, export, and audit.

---

## Phase 6: User Story 4 - Manage Browser Sessions Safely (Priority: P2)

**Goal**: User can create, switch, close, hibernate, recover, and take over browser sessions without exhausting the VPS or corrupting profile state.
**Independent Test**: Open tabs until limits are reached, leave session idle, reload/restart services, take over from a second device, and verify limits, idle cleanup, locks, recovery, and explicit notifications.

### Tests for User Story 4

- [ ] T081 [P] [US4] Add session limit, tab limit, stream limit, memory/disk limit, idle hibernation, and recoverable restart tests in tests/browser/session-manager.test.ts
- [ ] T082 [P] [US4] Add second-device takeover, `stream.taken_over`, lock release, and audit tests in tests/browser/focus-lease.test.ts
- [ ] T083 [P] [US4] Add stale stream eviction, failed broadcast eviction, shutdown drain, and recoverable session tests in tests/browser/ws.test.ts
- [ ] T084 [P] [US4] Add service hardening and restart behavior tests for matrix-browser.service in tests/customer-vps/browser-capability.test.ts

### Implementation for User Story 4

- [ ] T085 [US4] Implement owner caps for sessions, tabs, streams, memory, disk, downloads, and idle duration in packages/mcp-browser/src/runtime-service.ts
- [ ] T086 [US4] Implement idle hibernation, durable tab URL/order restore, recoverable session marking, and no transient-state preservation in packages/mcp-browser/src/runtime-service.ts
- [ ] T087 [US4] Implement second-device takeover prompt state, `stream.taken_over`, lock release, old-session recovery/close, and audit emission in packages/gateway/src/browser/service.ts
- [ ] T088 [US4] Implement stale stream sweeps, heartbeat timeout, failed-send eviction, and shutdown drains in packages/gateway/src/browser/ws.ts
- [ ] T089 [US4] Implement Browser runtime health and coarse capability endpoint in packages/gateway/src/browser/routes.ts
- [ ] T090 [US4] Add Browser UI states for limits, idle hibernation, recoverable sessions, profile locks, and takeover prompts in home/apps/browser/src/App.tsx
- [ ] T091 [US4] Update VPS service restart, health, and recovery behavior in distro/customer-vps/systemd/matrix-browser.service
- [ ] T092 [US4] Document session limits, hibernation reload behavior, recovery, and takeover in www/content/docs/browser.mdx

**Checkpoint**: User Story 4 is independently functional for resource-safe sessions and recovery.

---

## Phase 7: User Story 5 - Agent-Assisted Browser Use (Priority: P3)

**Goal**: User can ask Matrix agents to open, inspect, or control Browser only through explicit scoped grants and auditable actions.
**Independent Test**: Ask an agent to open a site, deny/grant inspection/control, verify grant scope/domain/expiry enforcement, and confirm credentials/unrelated tabs are not exposed.

### Tests for User Story 5

- [ ] T093 [P] [US5] Add Browser Permission Grant create/list/revoke/expiry/domain/scope tests in tests/browser/routes.test.ts
- [ ] T094 [P] [US5] Add agent access denial, read_dom, screenshot, navigate, download, and automate_input grant enforcement tests in tests/browser/routes.test.ts
- [ ] T095 [P] [US5] Add agent automate_input serialization without UI focus takeover tests in tests/browser/focus-lease.test.ts
- [ ] T096 [P] [US5] Add audit redaction tests for agent.access with no cookies, auth headers, credentials, screenshots, HTML, or raw paths in tests/browser/routes.test.ts

### Implementation for User Story 5

- [ ] T097 [US5] Implement Browser Permission Grant repository methods with domain-set validation, default expiry, revocation, and per-action lookup in packages/gateway/src/browser/repository.ts
- [ ] T098 [US5] Implement grant creation/list/revoke REST routes and safe errors in packages/gateway/src/browser/routes.ts
- [ ] T099 [US5] Implement agent Browser action authorization for read_dom, screenshot, download, navigate, and automate_input in packages/gateway/src/browser/service.ts
- [ ] T100 [US5] Route existing MCP Browser tool actions through Browser Permission Grants and action serialization in packages/mcp-browser/src/browser-tool.ts
- [ ] T101 [US5] Add permission request, grant, revoke, and active-grants UI to home/apps/browser/src/App.tsx
- [ ] T102 [US5] Emit `agent.access`, `permission.granted`, and `permission.revoked` audit events with redacted metadata in packages/gateway/src/browser/repository.ts
- [ ] T103 [US5] Document agent access boundaries, grant scopes, default expiry, revocation, and audit behavior in www/content/docs/browser.mdx

**Checkpoint**: User Story 5 is independently functional for explicit, auditable agent-assisted Browser use.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final docs, validation, review gates, and rollout checks across all stories.

- [ ] T104 [P] Add public Browser user docs covering ownership, Browser route behavior, persistence, downloads, clearing, limits, deferred features, audio, and agent access in www/content/docs/browser.mdx
- [ ] T105 [P] Add developer Browser architecture docs covering shared runtime, WebRTC/TURN, URL policy, handoff tokens, service hardening, and rollout in docs/dev/browser-runtime.md
- [ ] T106 [P] Update review checklist references for Browser auth, SSRF, WebRTC, TURN, handoff, bodyLimit, cleanup, and safe errors in docs/dev/review-pipeline.md
- [ ] T107 [P] Add Browser host-bundle rollout notes and env source map for TURN, JWKS/public key, Chromium, and service units in docs/dev/vps-deployment.md
- [ ] T108 Run default Browser app build and verify dist output in home/apps/browser/dist/index.html
- [ ] T109 Run focused Browser test suite with `bun run test -- tests/browser/url-policy.test.ts tests/browser/session-manager.test.ts tests/browser/focus-lease.test.ts tests/browser/media-plane.test.ts tests/browser/turn-policy.test.ts tests/browser/handoff-token.test.ts tests/browser/password-store.test.ts tests/browser/routes.test.ts tests/browser/ws.test.ts tests/browser/downloads.test.ts`
- [ ] T110 Run default app/icon test with `bun run test -- tests/gateway/apps.test.ts`
- [ ] T111 Run shell Browser E2E smoke and screenshot verification with `bun run test:e2e -- shell/e2e/browser-app.spec.ts`
- [ ] T112 Run customer VPS Browser capability tests with `bun run test -- tests/customer-vps/browser-capability.test.ts`
- [ ] T113 Run full pattern and type gates against package.json, tsconfig.json, and scripts/review/check-patterns.sh with `bun run check:patterns` and `bun run typecheck`
- [ ] T114 Run customer VPS host-bundle build and health smoke per quickstart in scripts/build-host-bundle.sh and specs/074-vps-browser-runtime/quickstart.md
- [ ] T115 Perform three-pass review against docs/dev/review-pipeline.md and record Browser invariants in specs/074-vps-browser-runtime/tasks.md for the pull request body

### Browser PR Invariants

- **Source of truth**: Browser metadata, sessions, tabs, downloads, permission grants, and audit records are canonical in owner-scoped Postgres tables; Chromium profile blobs, staged downloads, completed downloads, screenshots, and thumbnails live under owner filesystem paths resolved within Matrix home.
- **Lock/transaction scope**: profile/session metadata changes stay in repository transactions or single targeted updates; one live runtime per owner/profile is enforced by repository constraints plus the shared runtime lock, while UI/agent input is serialized through the action queue and focus lease.
- **Acceptable orphan states**: a staged download may remain if Chromium exits before publish; recurring symlink-safe cleanup and explicit failed-download cleanup remove stale staging files. Published downloads remain owner-addressable even if later Matrix file indexing is delayed.
- **Auth source of truth**: REST uses the Matrix request principal; Browser WebSockets use signed stream tokens carried by the `browser-stream.<token>` subprotocol; platform `/browser/*` is redirect-only and owner VPS handoff uses asymmetric tokens.
- **Deferred scope**: passkeys/WebAuthn, camera, microphone input, geolocation, clipboard-write, file picker, screen capture, cross-host file drag-in, and full WebRTC-only streaming without fallback remain out of scope for 074.
- **Review notes**: `bun run check:patterns` reports zero violations. Manual warnings were reviewed for Browser changes: Browser maps/sets are capped by session/download/stream limits or constant guard sets; mutating Browser routes use `bodyLimit`; URL/path inputs are Zod-validated and resolved within owner home; Browser external errors are mapped to coarse client-safe codes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Phase 1. Blocks all user stories.
- **Phase 3 US1**: Depends on Phase 2. MVP story.
- **Phase 4 US2**: Depends on Phase 2. Can run alongside US1 after foundation, but final validation should confirm Canvas/standalone sharing.
- **Phase 5 US3**: Depends on Phase 2. Can run alongside US1/US2 after foundation, but download/profile UI integrates with US1 app surfaces.
- **Phase 6 US4**: Depends on Phase 2 and benefits from US1 surface implementation for manual verification.
- **Phase 7 US5**: Depends on Phase 2 and repository/grant foundations; can run after or alongside US3 grant/audit work if file ownership is coordinated.
- **Phase 8 Polish**: Depends on completed target stories.

### User Story Dependencies

- **US1 Browse Inside Matrix Canvas (P1)**: MVP. No dependency on other stories after foundation.
- **US2 Standalone Browser Route (P1)**: No dependency on US1 for API behavior, but final user validation shares the same Browser app/runtime.
- **US3 Persist Owner Browser Profiles (P1)**: No dependency on US1/US2 for backend persistence; UI clearing/download surfaces integrate into Browser app.
- **US4 Manage Browser Sessions Safely (P2)**: Depends on shared runtime and stream foundations; user-facing prompts integrate into Browser app.
- **US5 Agent-Assisted Browser Use (P3)**: Depends on grant/audit foundations and shared action queue.

### Within Each User Story

- Tests must be written first and observed failing.
- Protocol/models before service orchestration.
- Service orchestration before REST/WS endpoints.
- Endpoints before UI integration.
- UI integration before E2E/manual smoke.

---

## Parallel Execution Examples

### User Story 1

```text
Task: "T041 Add Browser Canvas app unit tests in tests/default-apps/browser-app.test.tsx"
Task: "T042 Add gateway session create/resume contract tests in tests/browser/routes.test.ts"
Task: "T043 Add WebSocket Canvas stream contract tests in tests/browser/ws.test.ts"
Task: "T045 Implement shared Browser app protocol client in home/apps/browser/src/browser-protocol.ts"
Task: "T047 Implement Browser toolbar in home/apps/browser/src/BrowserToolbar.tsx"
Task: "T048 Implement Browser WebRTC viewport in home/apps/browser/src/BrowserViewport.tsx"
```

### User Story 2

```text
Task: "T056 Add shell standalone route tests in tests/shell/browser-route.test.tsx"
Task: "T057 Add platform redirect-only handoff tests in tests/browser/handoff-token.test.ts"
Task: "T060 Add standalone Browser route page in shell/src/app/browser/[...target]/page.tsx"
Task: "T063 Add platform /browser/* redirect-only route in packages/platform/src/main.ts"
```

### User Story 3

```text
Task: "T067 Add owner isolation repository tests in tests/browser/routes.test.ts"
Task: "T069 Add download staging tests in tests/browser/downloads.test.ts"
Task: "T072 Add Browser owner Postgres schema in packages/gateway/src/browser/repository.ts"
Task: "T075 Implement download staging in packages/gateway/src/browser/profile-store.ts"
```

### User Story 4

```text
Task: "T081 Add limit and hibernation tests in tests/browser/session-manager.test.ts"
Task: "T083 Add stale stream and shutdown drain tests in tests/browser/ws.test.ts"
Task: "T085 Implement owner caps in packages/mcp-browser/src/runtime-service.ts"
Task: "T088 Implement stale stream sweeps in packages/gateway/src/browser/ws.ts"
```

### User Story 5

```text
Task: "T093 Add Browser Permission Grant tests in tests/browser/routes.test.ts"
Task: "T095 Add agent automate_input serialization tests in tests/browser/focus-lease.test.ts"
Task: "T097 Implement grant repository methods in packages/gateway/src/browser/repository.ts"
Task: "T100 Route MCP Browser actions through grants in packages/mcp-browser/src/browser-tool.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 setup.
2. Complete Phase 2 foundation with failing-then-passing tests.
3. Complete Phase 3 User Story 1.
4. Validate Canvas Browser independently with unit, route, WebSocket, media, and E2E smoke tests.
5. Stop and demo before expanding to standalone routes, persistence controls, recovery, or agent access.

### Incremental Delivery

1. US1: Canvas Browser MVP.
2. US2: Standalone owner-hosted Browser route and platform redirect-only handoff.
3. US3: Owner-scoped persistence, downloads, clearing, export, and audit.
4. US4: Resource limits, hibernation, recovery, takeover, and hardening.
5. US5: Permissioned agent access and audit.

### Parallel Team Strategy

After Phase 2 foundation:
- Developer A: US1 Browser app UI and Canvas stream.
- Developer B: US2 standalone route and platform handoff.
- Developer C: US3 profile/download persistence.
- Developer D: US4 runtime safety and service hardening.
- Developer E: US5 grants and agent access.

Coordinate edits to shared files before parallel work: packages/gateway/src/browser/service.ts, packages/gateway/src/browser/repository.ts, packages/mcp-browser/src/session-manager.ts, packages/mcp-browser/src/runtime-service.ts, home/apps/browser/src/App.tsx.
