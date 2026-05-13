# Tasks: Matrix Messaging Bridge

**Input**: Design documents from `/specs/077-matrix-messaging-bridge/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/rest-api.md`, `quickstart.md`
**Tests**: Required by the Matrix OS TDD constitution and by spec FR-021/SC-010/SC-011.
**Gate Rule**: Product implementation tasks depend on Phase 2. Phase 2 proves the homeserver, E2EE, Hermes mode, storage/resource floor, and duplicate-adapter gates before user-facing implementation proceeds.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other tasks in the same phase when dependencies are satisfied.
- **[US#]**: User story label for story phases only.
- Every task includes an exact file path.

## Phase 1: Setup

**Purpose**: Create the feature skeleton, test locations, and spike documentation surfaces.

- [X] T001 Create gateway messages module directory with placeholder README in `packages/gateway/src/messages/README.md`
- [X] T002 Create gateway messages test directories with placeholder README in `tests/gateway/messages/README.md`
- [X] T003 Create deploy test directory for customer-VPS messaging validation in `tests/deploy/customer-vps/README.md`
- [X] T004 Create first-party Messages app scaffold manifest in `home/apps/messages/matrix.json`
- [X] T005 Create first-party Messages app source placeholder in `home/apps/messages/src/main.tsx`
- [X] T006 Create shell messages component directory placeholder in `shell/src/components/messages/README.md`
- [X] T007 Create spike result ledger template in `specs/077-matrix-messaging-bridge/spike-results.md`
- [X] T008 Create messaging docs placeholder in `docs/platform/dev/messaging-bridge.md`

---

## Phase 2: Foundational Gates

**Purpose**: Resolve blocking architecture and safety gates before any user story implementation. No user story work may start until T009-T030 are complete.

- [X] T009 [P] Write failing homeserver spike harness for Conduit appservice registration in `tests/deploy/customer-vps/matrix-messaging-conduit-spike.test.ts`
- [X] T010 [P] Write failing homeserver spike harness for Synapse appservice registration in `tests/deploy/customer-vps/matrix-messaging-synapse-spike.test.ts`
- [X] T011 [P] Write failing Telegram bridge spike test covering inbound/outbound text and restart recovery in `tests/deploy/customer-vps/telegram-bridge-spike.test.ts`
- [X] T012 [P] Write failing WhatsApp bridge spike test covering pairing, inbound/outbound text, and restart recovery in `tests/deploy/customer-vps/whatsapp-bridge-spike.test.ts`
- [X] T013 [P] Write failing media/backfill spike test with capped latest-100 import in `tests/deploy/customer-vps/messaging-media-backfill-spike.test.ts`
- [X] T014 [P] Write failing E2EE posture spike test that blocks Hermes delivery without proven key-sharing semantics in `tests/deploy/customer-vps/messaging-e2ee-spike.test.ts`
- [X] T015 [P] Write failing backup/restore spike test for homeserver DB, bridge DBs, mappings, and WhatsApp relink boundary in `tests/deploy/customer-vps/messaging-restore-spike.test.ts`
- [X] T016 [P] Write failing duplicate-adapter reconciliation test in `tests/gateway/messages/duplicate-adapter-policy.test.ts`
- [X] T017 [P] Write failing resource-floor validation test in `tests/deploy/customer-vps/messaging-resource-floor.test.ts`
- [X] T018 Implement reusable spike fixture helpers for homeserver candidates in `tests/deploy/customer-vps/helpers/matrix-homeserver-fixtures.ts`
- [X] T019 Implement reusable spike fixture helpers for Telegram and WhatsApp bridge lifecycle in `tests/deploy/customer-vps/helpers/matrix-bridge-fixtures.ts`
- [X] T020 Implement resource-floor detector helper for messaging-enabled VPSes in `tests/deploy/customer-vps/helpers/messaging-resource-floor.ts`

**Live spike checkpoint 2026-05-13**: isolated Synapse, Postgres,
mautrix-telegram, mautrix-whatsapp, and Element Web are running on localhost-only
ports from `/mnt/HC_Volume_104683898/matrix-messaging-spike`. Synapse
appservice registration and bridge boot/restart liveness are proven. T021-T025
remain open because the final gate still needs real Telegram API credentials,
WhatsApp QR pairing, inbound/outbound message loops, media/backfill,
backup/restore, and E2EE posture proof.

- [ ] T021 Record Conduit vs Synapse vs split-homeserver spike outcome in `specs/077-matrix-messaging-bridge/spike-results.md`
- [ ] T022 Record selected Hermes participation mode and E2EE posture in `specs/077-matrix-messaging-bridge/spike-results.md`
- [ ] T023 Record storage map, numeric caps, and customer-VPS floor in `specs/077-matrix-messaging-bridge/spike-results.md`
- [ ] T024 Record duplicate-adapter reconciliation decision in `specs/077-matrix-messaging-bridge/spike-results.md`
- [ ] T025 Record Conduit-to-Synapse migration or split-homeserver decision in `specs/077-matrix-messaging-bridge/spike-results.md`
- [ ] T026 Define shared Zod schema conventions for message ids, room ids, network slugs, cursors, and safe error codes in `packages/gateway/src/messages/schemas.ts`
- [ ] T027 Define safe error mapper and redaction helpers for messaging routes in `packages/gateway/src/messages/errors.ts`
- [ ] T028 Define constants for setup TTL, queue caps, media caps, health timeout, RPO/RTO, and idempotency retention in `packages/gateway/src/messages/constants.ts`
- [ ] T029 Define owner-scoped repository interfaces for all messaging entities in `packages/gateway/src/messages/repository.ts`
- [ ] T030 Wire empty `/api/messages` route registration with dependency injection in `packages/gateway/src/messages/routes.ts`

**Checkpoint**: Gate decisions are recorded and foundational contracts/constants exist. User story implementation may begin.

---

## Phase 3: User Story 1 - Connect WhatsApp And Telegram To Matrix (Priority: P1) MVP

**Goal**: A user connects Telegram and WhatsApp, sees bridged Matrix conversations, and can send/receive text through Matrix OS.

**Independent Test**: Connect Telegram, receive a Telegram message, see the Matrix conversation, send a Matrix reply, then repeat the same lifecycle for WhatsApp.

### Tests for User Story 1

- [ ] T031 [P] [US1] Write contract tests for `GET /api/messages/networks` and `GET /api/messages/accounts` in `tests/gateway/messages/accounts-routes.test.ts`
- [ ] T032 [P] [US1] Write contract tests for `POST /api/messages/accounts/setup` and setup completion in `tests/gateway/messages/setup-routes.test.ts`
- [ ] T033 [P] [US1] Write contract tests for account disconnect retention behavior in `tests/gateway/messages/disconnect-routes.test.ts`
- [ ] T034 [P] [US1] Write repository tests for ConnectedAccount, SetupSession, MatrixConversation, and ConversationMapping in `tests/gateway/messages/repository.test.ts`
- [ ] T035 [P] [US1] Write Messages app setup flow test for Telegram and WhatsApp cards in `tests/shell/messages/messages-app-setup.test.tsx`
- [ ] T036 [P] [US1] Write end-to-end bridge loop test using spike fixtures in `tests/deploy/customer-vps/matrix-messaging-first-loop.test.ts`

### Implementation for User Story 1

- [ ] T037 [P] [US1] Implement MessagingNetwork, ConnectedAccount, SetupSession, MatrixConversation, and ConversationMapping schemas in `packages/gateway/src/messages/schemas.ts`
- [ ] T038 [US1] Implement repository methods for accounts, setup sessions, conversations, and mappings in `packages/gateway/src/messages/repository.ts`
- [ ] T039 [US1] Implement setup-session TTL creation, completion, expiration, and cleanup helpers in `packages/gateway/src/messages/setup-sessions.ts`
- [ ] T040 [US1] Implement bridge account orchestration interface for Telegram and WhatsApp setup states in `packages/gateway/src/messages/bridge-accounts.ts`
- [ ] T041 [US1] Implement `GET /api/messages/networks` and `GET /api/messages/accounts` in `packages/gateway/src/messages/routes.ts`
- [ ] T042 [US1] Implement `POST /api/messages/accounts/setup` and `POST /api/messages/accounts/setup/:setupId/complete` in `packages/gateway/src/messages/routes.ts`
- [ ] T043 [US1] Implement `DELETE /api/messages/accounts/:accountId` with retention choices in `packages/gateway/src/messages/routes.ts`
- [ ] T044 [US1] Implement `GET /api/messages/conversations` read path with pagination and permission summary placeholders in `packages/gateway/src/messages/routes.ts`
- [ ] T045 [US1] Wire `/api/messages` into gateway startup with registration-time dependencies in `packages/gateway/src/server.ts`
- [ ] T046 [US1] Implement Messages app network/account setup UI in `home/apps/messages/src/main.tsx`
- [ ] T047 [US1] Add Messages app manifest icon reference and shipped icon asset in `home/apps/messages/matrix.json` and `home/system/icons/messages.svg`
- [ ] T048 [US1] Register Messages as a first-party default app in `home/apps/messages/matrix.json`
- [ ] T049 [US1] Build default app output for Messages and update app asset validation expectations in `tests/gateway/apps.test.ts`

**Checkpoint**: Telegram and WhatsApp account setup, status, conversation listing, disconnect, and first text loop work without granting Hermes access.

---

## Phase 4: User Story 2 - Grant Room-Level AI Access (Priority: P1)

**Goal**: A user grants/revokes Hermes read, reply, mention-only, and automation access per room. Hermes only sees permitted content and revocation cancels queued/running work.

**Independent Test**: Grant Hermes access to one conversation and deny another; send messages in both; verify Hermes receives only the allowed room and revocation stops new delivery within 10 seconds.

### Tests for User Story 2

- [ ] T050 [P] [US2] Write permission route contract tests for revision conflicts and default-deny rooms in `tests/gateway/messages/permissions-routes.test.ts`
- [ ] T051 [P] [US2] Write permission registry tests for read, reply, automation, and mention-only checks in `tests/gateway/messages/permission-registry.test.ts`
- [ ] T052 [P] [US2] Write appservice event ingestion tests for Matrix `event_id` dedupe and safe event validation in `tests/gateway/messages/appservice-events.test.ts`
- [ ] T053 [P] [US2] Write Hermes delivery tests for internal capability token scoping and 60-second expiry in `tests/gateway/messages/hermes-delivery.test.ts`
- [ ] T054 [P] [US2] Write revocation abort tests for queued/running HermesWorkItem and unsent OutgoingReply rows in `tests/gateway/messages/revocation-abort.test.ts`
- [ ] T055 [P] [US2] Write draft route tests for list, approve, cancel, and final reply permission recheck in `tests/gateway/messages/drafts-routes.test.ts`
- [ ] T056 [P] [US2] Write Messages permissions UI test for room-level toggles and pending drafts in `tests/shell/messages/messages-permissions.test.tsx`

### Implementation for User Story 2

- [ ] T057 [P] [US2] Implement HermesPermission, BridgeEventCursor, OutgoingReply, and HermesWorkItem schemas in `packages/gateway/src/messages/schemas.ts`
- [ ] T058 [US2] Implement transactional permission update, audit append, and work cancellation methods in `packages/gateway/src/messages/repository.ts`
- [ ] T059 [US2] Implement permission registry with last-point read/reply/automation checks in `packages/gateway/src/messages/permission-registry.ts`
- [ ] T060 [US2] Implement trusted appservice event ingestion with Matrix `event_id` idempotency in `packages/gateway/src/messages/appservice-events.ts`
- [ ] T061 [US2] Implement Hermes event-consumer delivery mode with abort signals in `packages/gateway/src/messages/hermes-delivery.ts`
- [ ] T062 [US2] Implement internal Hermes reply capability token issuer/verifier in `packages/gateway/src/messages/hermes-capability.ts`
- [ ] T063 [US2] Implement `PATCH /api/messages/conversations/:roomId/permissions` in `packages/gateway/src/messages/routes.ts`
- [ ] T064 [US2] Implement `POST /api/messages/appservice/:network/events` in `packages/gateway/src/messages/routes.ts`
- [ ] T065 [US2] Implement `POST /api/messages/conversations/:roomId/reply` with final permission recheck and `clientTxnId` idempotency in `packages/gateway/src/messages/routes.ts`
- [ ] T066 [US2] Implement `GET /api/messages/drafts`, approve, and cancel routes in `packages/gateway/src/messages/routes.ts`
- [ ] T067 [US2] Implement room permission and drafts UI in `home/apps/messages/src/main.tsx`
- [ ] T068 [US2] Add safe audit summaries for permission and AI reply events in `packages/gateway/src/messages/audit.ts`

**Checkpoint**: Hermes access is room-scoped, default-deny, revocable within 10 seconds for queued/unsent work, and reply sends are protected by final permission checks.

---

## Phase 5: User Story 3 - Automate From Allowed Conversations (Priority: P2)

**Goal**: A user creates automations that react only to permitted conversations and can create Matrix OS actions or draft replies with audit trails.

**Independent Test**: Grant automation access to one conversation, create a deadline-to-task rule, send a matching message, and verify a task is created with a visible audit event.

### Tests for User Story 3

- [ ] T069 [P] [US3] Write AutomationRule schema tests for bounded discriminated action payloads in `tests/gateway/messages/automation-schemas.test.ts`
- [ ] T070 [P] [US3] Write automation evaluator tests for automation permission gating in `tests/gateway/messages/automation-evaluator.test.ts`
- [ ] T071 [P] [US3] Write automation route contract tests for create, pause, list, and delete in `tests/gateway/messages/automation-routes.test.ts`
- [ ] T072 [P] [US3] Write integration test for deadline-to-task rule through `/api/bridge/query` in `tests/gateway/messages/automation-task-action.test.ts`
- [ ] T073 [P] [US3] Write Messages automation UI test in `tests/shell/messages/messages-automation.test.tsx`

### Implementation for User Story 3

- [ ] T074 [P] [US3] Implement AutomationRule schemas and bounded action discriminated union in `packages/gateway/src/messages/schemas.ts`
- [ ] T075 [US3] Implement AutomationRule repository methods and audit append in `packages/gateway/src/messages/repository.ts`
- [ ] T076 [US3] Implement automation evaluator with nonblocking queue and permission checks in `packages/gateway/src/messages/automation-evaluator.ts`
- [ ] T077 [US3] Implement task-creation action through scoped bridge API client in `packages/gateway/src/messages/automation-actions.ts`
- [ ] T078 [US3] Implement automation rule create, list, pause, and delete routes in `packages/gateway/src/messages/routes.ts`
- [ ] T079 [US3] Integrate automation evaluator with appservice event ingestion after owner display storage in `packages/gateway/src/messages/appservice-events.ts`
- [ ] T080 [US3] Implement automation settings UI and audit trail display in `home/apps/messages/src/main.tsx`

**Checkpoint**: Automation observes only rooms with automation access and creates audited Matrix OS actions without blocking message sync.

---

## Phase 6: User Story 4 - Operate A Private Messaging Backbone (Priority: P2)

**Goal**: Operators can provision, monitor, recover, backup, restore, and upgrade the private messaging backbone on the user's VPS.

**Independent Test**: Provision a fresh VPS, connect a bridge, restart services, restore from backup, and verify accounts, mappings, permissions, health, and latest 100 messages recover within the documented boundary.

### Tests for User Story 4

- [ ] T081 [P] [US4] Write health route contract tests for coarse statuses and safe error redaction in `tests/gateway/messages/health-routes.test.ts`
- [ ] T082 [P] [US4] Write recovery route tests for recheck, restart_bridge, and relink actions in `tests/gateway/messages/recovery-routes.test.ts`
- [ ] T083 [P] [US4] Write customer-VPS systemd unit validation tests for selected homeserver and bridge services in `tests/deploy/customer-vps/messaging-systemd.test.ts`
- [ ] T084 [P] [US4] Write backup/restore integration test for RPO/RTO and WhatsApp relink status in `tests/deploy/customer-vps/messaging-backup-restore.test.ts`
- [ ] T085 [P] [US4] Write platform provisioning test for messaging resource floor gating in `tests/platform/messaging-provisioning.test.ts`

### Implementation for User Story 4

- [ ] T086 [US4] Implement coarse bridge and homeserver health service in `packages/gateway/src/messages/bridge-health.ts`
- [ ] T087 [US4] Implement `GET /api/messages/health` and `POST /api/messages/recovery/:accountId` in `packages/gateway/src/messages/routes.ts`
- [ ] T088 [US4] Implement customer-VPS messaging resource-floor checks in `packages/platform/src/customer-vps-routes.ts`
- [ ] T089 [US4] Update Matrix homeserver provisioning hooks for selected split/migration decision in `packages/platform/src/matrix-provisioning.ts`
- [ ] T090 [US4] Add selected homeserver systemd unit in `distro/customer-vps/systemd/matrix-homeserver.service`
- [ ] T091 [US4] Add Telegram bridge systemd unit in `distro/customer-vps/systemd/matrix-bridge-telegram.service`
- [ ] T092 [US4] Add WhatsApp bridge systemd unit in `distro/customer-vps/systemd/matrix-bridge-whatsapp.service`
- [ ] T093 [US4] Add messaging health helper script in `distro/customer-vps/host-bin/matrix-messaging-health`
- [ ] T094 [US4] Add messaging backup helper script covering homeserver, bridge DBs, mappings, and permissions in `distro/customer-vps/host-bin/matrix-messaging-backup`
- [ ] T095 [US4] Add messaging restore helper script with WhatsApp relink detection in `distro/customer-vps/host-bin/matrix-messaging-restore`
- [ ] T096 [US4] Document production operations, RPO/RTO, relink behavior, and resource floor in `docs/platform/dev/messaging-bridge.md`

**Checkpoint**: Private messaging backbone is provisionable, observable, recoverable, and bounded by documented owner-controlled backup/restore behavior.

---

## Phase 7: Polish & Cross-Cutting

**Purpose**: Security hardening, docs, validation, and readiness for review after desired stories are complete.

- [ ] T097 [P] Add user-facing Messages and privacy docs in `www/content/docs/messages.mdx`
- [ ] T098 [P] Add developer docs for message permissions and bridge architecture in `docs/platform/dev/messaging-bridge.md`
- [ ] T099 [P] Add quickstart validation notes and commands to `specs/077-matrix-messaging-bridge/quickstart.md`
- [ ] T100 [P] Add changelog entry for the messaging bridge feature in `specs/077-matrix-messaging-bridge/changelog.md`
- [ ] T101 Run default app build with `scripts/build-default-apps.mjs` and update generated Messages dist artifacts in `home/apps/messages/dist/index.html`
- [ ] T102 Run focused messaging tests documented in `tests/gateway/messages/README.md`
- [ ] T103 Run full pre-PR gates defined in `package.json`
- [ ] T104 Perform three-pass review against `docs/dev/review-pipeline.md` and record findings in `specs/077-matrix-messaging-bridge/review.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: no dependencies.
- **Phase 2 Foundational Gates**: depends on Phase 1 and blocks every user story.
- **Phase 3 US1**: depends on Phase 2.
- **Phase 4 US2**: depends on Phase 2 and can start after the shared repository/schema parts of US1 are stable; full end-to-end validation uses US1 bridged conversations.
- **Phase 5 US3**: depends on Phase 4 permission registry and appservice ingestion.
- **Phase 6 US4**: depends on Phase 2 and can run partly in parallel with US1/US2 after the homeserver decision is recorded.
- **Phase 7 Polish**: depends on whichever stories are included in the review scope.

### User Story Dependencies

- **US1 Connect WhatsApp And Telegram To Matrix**: MVP story after Phase 2.
- **US2 Grant Room-Level AI Access**: depends on Phase 2 and uses US1 conversations for full integration validation.
- **US3 Automate From Allowed Conversations**: depends on US2 permission and event-ingestion paths.
- **US4 Operate A Private Messaging Backbone**: depends on Phase 2; operational slices can progress in parallel with US1/US2 once the selected homeserver is known.

### Parallel Opportunities

- T009-T017 spike tests can be written in parallel.
- T018-T020 fixture/helper work can proceed in parallel after spike test interfaces are known.
- T031-T036 US1 tests can be written in parallel.
- T050-T056 US2 tests can be written in parallel.
- T069-T073 US3 tests can be written in parallel.
- T081-T085 US4 tests can be written in parallel.
- T090-T095 systemd/helper scripts can be implemented in parallel once the homeserver decision is recorded.

---

## Parallel Example: User Story 1

```text
Task: T031 Contract test for networks/accounts routes in tests/gateway/messages/accounts-routes.test.ts
Task: T032 Contract test for setup routes in tests/gateway/messages/setup-routes.test.ts
Task: T034 Repository tests in tests/gateway/messages/repository.test.ts
Task: T035 Messages setup UI test in tests/shell/messages/messages-app-setup.test.tsx
```

## Parallel Example: User Story 2

```text
Task: T051 Permission registry tests in tests/gateway/messages/permission-registry.test.ts
Task: T052 Appservice event ingestion tests in tests/gateway/messages/appservice-events.test.ts
Task: T053 Hermes delivery tests in tests/gateway/messages/hermes-delivery.test.ts
Task: T055 Draft route tests in tests/gateway/messages/drafts-routes.test.ts
```

## Parallel Example: User Story 4

```text
Task: T083 Systemd validation tests in tests/deploy/customer-vps/messaging-systemd.test.ts
Task: T084 Backup/restore tests in tests/deploy/customer-vps/messaging-backup-restore.test.ts
Task: T085 Platform resource-floor tests in tests/platform/messaging-provisioning.test.ts
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 setup.
2. Complete Phase 2 gates and record the selected homeserver, E2EE posture, Hermes mode, resource floor, and duplicate-adapter policy.
3. Complete Phase 3 US1.
4. Stop and validate Telegram and WhatsApp setup plus first bridged message loop before granting Hermes access.

### Incremental Delivery

1. US1: Matrix-backed Telegram/WhatsApp conversation surface with no Hermes visibility.
2. US2: Room-level Hermes read/reply/mention permissions and drafts.
3. US3: Automations from permitted conversations.
4. US4: Production VPS operations, health, backup, restore, and recovery.

### Review Boundary

Do not request review while still pushing commits. For backend PRs, include invariants for source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, and deferred scope.
