# Tasks: VPS-per-User Architecture

**Input**: Design documents from `/specs/070-vps-per-user/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Included and ordered first within each story because the Matrix OS constitution and quickstart require TDD.

**Organization**: Tasks are grouped by independently testable implementation increments derived from the feature's phase plan.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and has no dependency on incomplete tasks
- **[Story]**: User-story increment mapped to the phase-1 delivery plan
- Every task includes exact repository file paths

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the file layout and configuration surfaces needed by all VPS-per-user work.

- [X] T001 Create customer VPS artifact directories in `distro/customer-vps/`, `distro/customer-vps/systemd/`, and `tests/platform/`
- [X] T002 [P] Add customer VPS environment/config module skeleton in `packages/platform/src/customer-vps-config.ts`
- [X] T003 [P] Add Hetzner/R2 test fixture scaffolding in `tests/platform/customer-vps-fixtures.ts`
- [X] T004 [P] Add deployment docs page placeholder in `www/content/docs/deployment/vps-per-user.mdx`
- [X] T005 [P] Add deployment docs navigation entry for `www/content/docs/deployment/vps-per-user.mdx` in `www/content/docs/meta.json`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema, validation, clients, auth, and host templates that must exist before any story can be implemented.

**CRITICAL**: No user-story implementation can begin until this phase is complete.

- [X] T006 Add `user_machines` Kysely/PostgreSQL table, indexes, and inferred types in `packages/platform/src/db.ts`
- [X] T007 Add `user_machines` PostgreSQL bootstrap migration in `packages/platform/src/db.ts`
- [X] T008 Add UserMachine CRUD helpers and transaction helpers in `packages/platform/src/db.ts`
- [X] T009 [P] Define VPS request/response/status Zod schemas in `packages/platform/src/customer-vps-schema.ts`
- [X] T010 [P] Define generic provider error mapping and failure-code enums in `packages/platform/src/customer-vps-errors.ts`
- [X] T011 [P] Implement fixed Hetzner/R2/server-type config loading with safe defaults in `packages/platform/src/customer-vps-config.ts`
- [X] T012 [P] Implement constant-time bearer and registration-token helpers in `packages/platform/src/customer-vps-auth.ts`
- [X] T013 [P] Implement typed Hetzner API client with `fetch()` timeouts in `packages/platform/src/customer-vps-hetzner.ts`
- [X] T014 [P] Implement scoped R2 system-state helper for `vps-meta.json` and `system/db/latest` in `packages/platform/src/customer-vps-r2.ts`
- [X] T015 [P] Create cloud-init renderer contract in `packages/platform/src/customer-vps-cloud-init.ts`
- [X] T016 [P] Create initial cloud-init template in `distro/customer-vps/cloud-init.yaml`
- [X] T017 [P] Create initial Postgres compose template in `distro/customer-vps/postgres-compose.yml`
- [X] T018 [P] Create initial customer host systemd unit files in `distro/customer-vps/systemd/`

**Checkpoint**: Shared database, validation, provider clients, auth, and template surfaces are ready.

---

## Phase 3: User Story 1 - Provision And Register Customer VPS (Priority: P1) MVP

**Goal**: An authenticated internal request can lazily create or return a user's VPS; first boot can register the host and mark it running.

**Independent Test**: With mocked Hetzner and R2 clients, `POST /vps/provision` returns `202`, is idempotent by `clerkUserId`, `POST /vps/register` consumes the one-time token, and `GET /vps/:machineId/status` reports `running`.

### Tests for User Story 1

> Write these tests first and verify they fail before implementation.

- [X] T019 [P] [US1] Add provisioning idempotency and failure-state tests in `tests/platform/customer-vps.test.ts`
- [X] T020 [P] [US1] Add `/vps/provision`, `/vps/register`, `/vps/:machineId/status`, and `DELETE /vps/:machineId` route contract tests in `tests/platform/customer-vps-routes.test.ts`
- [X] T021 [P] [US1] Add auth, body-limit, and validation rejection tests for VPS routes in `tests/platform/customer-vps-routes.test.ts`
- [X] T022 [P] [US1] Add cloud-init render tests for required variables and secret redaction in `tests/platform/customer-vps-cloud-init.test.ts`

### Implementation for User Story 1

- [X] T023 [US1] Implement one-time registration token generation, hashing, expiry, and clearing in `packages/platform/src/customer-vps-auth.ts`
- [X] T024 [US1] Implement cloud-init rendering with no secret logging in `packages/platform/src/customer-vps-cloud-init.ts`
- [X] T025 [US1] Implement provision/register/status/delete orchestration in `packages/platform/src/customer-vps.ts`
- [X] T026 [US1] Implement `/vps/*` Hono routes with `bodyLimit({ maxSize: 4096 })` in `packages/platform/src/customer-vps-routes.ts`
- [X] T027 [US1] Mount `/vps/*` routes and verify dependencies at registration time in `packages/platform/src/main.ts`
- [X] T028 [US1] Add provisioning reconciliation for stale `provisioning` rows with bounded batches in `packages/platform/src/customer-vps.ts`
- [X] T029 [US1] Add operator-safe generic logging for provider and database failures in `packages/platform/src/customer-vps.ts`
- [X] T030 [US1] Run focused US1 tests from `quickstart.md` against `tests/platform/customer-vps.test.ts`, `tests/platform/customer-vps-routes.test.ts`, and `tests/platform/customer-vps-cloud-init.test.ts`

**Checkpoint**: User Story 1 is independently functional and testable as the MVP.

---

## Phase 4: User Story 2 - Host Services And VPS-First Routing (Priority: P2)

**Goal**: A registered customer VPS installs Matrix OS host services and profile routing prefers running VPS machines while preserving legacy container fallback.

**Independent Test**: A mocked running `userMachines` row routes `{handle}.matrix-os.com` to the VPS HTTPS endpoint; a user without a running row still routes to the legacy container path.

### Tests for User Story 2

- [X] T031 [P] [US2] Add VPS-first routing and legacy fallback tests in `tests/platform/profile-routing-vps.test.ts`
- [X] T032 [P] [US2] Add customer host unit ordering tests in `tests/platform/customer-vps-cloud-init.test.ts`

### Implementation for User Story 2

- [X] T033 [US2] Add running-VPS lookup helper by handle and Clerk user ID in `packages/platform/src/db.ts`
- [X] T034 [US2] Implement VPS endpoint resolution before container routing in `packages/platform/src/profile-routing.ts`
- [X] T035 [US2] Integrate VPS routing branch into subdomain proxy handling in `packages/platform/src/main.ts`
- [X] T036 [P] [US2] Implement `matrix-gateway.service` for customer VPS hosts in `distro/customer-vps/systemd/matrix-gateway.service`
- [X] T037 [P] [US2] Implement `matrix-shell.service` for customer VPS hosts in `distro/customer-vps/systemd/matrix-shell.service`
- [X] T038 [P] [US2] Implement `matrix-sync-agent.service` shell point for customer VPS hosts in `distro/customer-vps/systemd/matrix-sync-agent.service`
- [X] T039 [US2] Update `distro/customer-vps/cloud-init.yaml` to install host bundle, Postgres compose, and systemd units
- [X] T040 [US2] Run routing tests from `quickstart.md` against `tests/platform/profile-routing-vps.test.ts`

**Checkpoint**: User Story 2 routes running customer VPSes without breaking legacy containers.

---

## Phase 5: User Story 3 - R2 Sync, Heartbeat, And DB Backups (Priority: P3)

**Goal**: The customer VPS maintains R2 heartbeat metadata, restores or starts fresh before serving, and uploads hourly Postgres backups with retention.

**Independent Test**: Host scripts with mocked R2 commands upload `vps-meta.json`, write `system/db/latest` only after snapshot upload succeeds, prune within retention bounds, and gate gateway start until restore/fresh completion.

### Tests for User Story 3

- [X] T041 [P] [US3] Add R2 metadata and latest-pointer validation tests in `tests/platform/customer-vps.test.ts`
- [X] T042 [P] [US3] Add backup retention and prune-safety tests in `tests/platform/customer-vps-cloud-init.test.ts`
- [X] T043 [P] [US3] Add restore-or-fresh boot-gate tests in `tests/platform/customer-vps-cloud-init.test.ts`

### Implementation for User Story 3

- [X] T044 [US3] Implement R2 `vps-meta.json` write and heartbeat update helpers in `packages/platform/src/customer-vps-r2.ts`
- [X] T045 [US3] Update `/vps/register` to write R2 metadata after the transaction in `packages/platform/src/customer-vps.ts`
- [X] T046 [P] [US3] Implement `matrixctl` R2 put/get/prune helpers with sanitized logs in `distro/customer-vps/matrixctl`
- [X] T047 [P] [US3] Implement Postgres backup script with upload-before-latest semantics in `distro/customer-vps/matrix-db-backup.sh`
- [X] T048 [P] [US3] Implement restore-or-fresh script and restore-complete flag handling in `distro/customer-vps/matrix-restore.sh`
- [X] T049 [P] [US3] Implement backup service and timer units in `distro/customer-vps/systemd/matrix-db-backup.service` and `distro/customer-vps/systemd/matrix-db-backup.timer`
- [X] T050 [US3] Update `distro/customer-vps/cloud-init.yaml` to install `matrixctl`, backup scripts, restore script, and timer units with restrictive file modes
- [X] T051 [US3] Add gateway `/system/backup` trigger integration point or explicit deferred stub in `packages/gateway/src/server.ts`
- [X] T052 [US3] Run backup and restore-focused tests from `quickstart.md` against `tests/platform/customer-vps-cloud-init.test.ts`

**Checkpoint**: User Story 3 creates recoverable R2 system state and DB snapshots.

---

## Phase 6: User Story 4 - Manual Recovery From R2 (Priority: P4)

**Goal**: An operator can manually replace a failed VPS from R2 state, refusing missing DB snapshots unless explicitly allowed for empty users.

**Independent Test**: With mocked Hetzner and R2 clients, `POST /vps/recover` refuses missing `system/db/latest` by default, creates a replacement server with a new `machineId`, and the replacement registers as `running` after restore.

### Tests for User Story 4

- [X] T053 [P] [US4] Add recovery state-transition and R2 preflight tests in `tests/platform/customer-vps.test.ts`
- [X] T054 [P] [US4] Add `/vps/recover` route contract and auth tests in `tests/platform/customer-vps-routes.test.ts`
- [X] T055 [P] [US4] Add opt-in real-Hetzner recovery smoke test gated by env flag in `tests/platform/customer-vps-real-hetzner.test.ts`

### Implementation for User Story 4

- [X] T056 [US4] Implement recovery orchestration with durable `recovering` state in `packages/platform/src/customer-vps.ts`
- [X] T057 [US4] Implement R2 `system/db/latest` preflight and `allowEmpty` behavior in `packages/platform/src/customer-vps-r2.ts`
- [X] T058 [US4] Add `/vps/recover` route behavior and generic error responses in `packages/platform/src/customer-vps-routes.ts`
- [X] T059 [P] [US4] Add admin `matrixctl recover` wrapper documentation or script in `distro/customer-vps/matrixctl`
- [X] T060 [US4] Extend reconciliation to handle stale `recovering` rows in `packages/platform/src/customer-vps.ts`
- [X] T061 [US4] Run recovery tests from `quickstart.md` against `tests/platform/customer-vps.test.ts` and `tests/platform/customer-vps-routes.test.ts`

**Checkpoint**: User Story 4 provides deterministic manual recovery from R2.

---

## Phase 7: User Story 5 - First Customer Rollout (Priority: P5)

**Goal**: One opt-in customer can run on a customer VPS with documented cost, quota, backup, recovery, and rollback expectations.

**Independent Test**: Operator docs and quickstart steps let a maintainer provision, observe, back up, recover, and explicitly delete a test VPS without affecting legacy containers.

### Tests for User Story 5

- [X] T062 [P] [US5] Add first-customer rollout checklist assertions to `tests/platform/customer-vps.test.ts`
- [X] T063 [P] [US5] Add public docs smoke check for deployment page links in `www/content/docs/deployment/vps-per-user.mdx`

### Implementation for User Story 5

- [X] T064 [US5] Document phase 1 scope, non-goals, quota ceiling, and cost model in `www/content/docs/deployment/vps-per-user.mdx`
- [X] T065 [US5] Document backup retention, restored/not-restored state, and manual recovery procedure in `www/content/docs/deployment/vps-per-user.mdx`
- [X] T066 [US5] Document rollback and legacy-container fallback behavior in `www/content/docs/deployment/vps-per-user.mdx`
- [X] T067 [US5] Add first-customer operator runbook and observation checklist in `specs/070-vps-per-user/quickstart.md`
- [ ] T068 [US5] Run documented manual smoke commands from `specs/070-vps-per-user/quickstart.md` against a non-production test user

**Checkpoint**: User Story 5 is ready for one opt-in customer rollout.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, review sweeps, and final validation across all stories.

- [X] T069 [P] Verify every new external `fetch()` has `AbortSignal.timeout()` in `packages/platform/src/customer-vps-hetzner.ts` and `packages/platform/src/customer-vps-r2.ts`
- [X] T070 [P] Verify all new mutating Hono routes use `bodyLimit({ maxSize: 4096 })` in `packages/platform/src/customer-vps-routes.ts`
- [X] T071 [P] Verify no client response exposes provider, filesystem, database, R2 key, signed URL, or raw Zod issue details in `packages/platform/src/customer-vps-routes.ts`
- [X] T072 [P] Verify bounded reconciliation and no unbounded Map/Set usage in `packages/platform/src/customer-vps.ts`
- [X] T073 [P] Verify customer host scripts avoid credential leakage and use restrictive file modes in `distro/customer-vps/matrixctl`, `distro/customer-vps/matrix-db-backup.sh`, and `distro/customer-vps/matrix-restore.sh`
- [ ] T074 Run `bun run typecheck` for the repository from `package.json`
- [ ] T075 Run `bun run check:patterns` for the repository from `package.json`
- [ ] T076 Run `bun run test` for the repository from `package.json`
- [X] T077 Update implementation notes and any changed manual verification steps in `specs/070-vps-per-user/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories.
- **US1 Provision And Register (Phase 3)**: Depends on Foundational; MVP.
- **US2 Host Services And Routing (Phase 4)**: Depends on Foundational and benefits from US1 status semantics.
- **US3 R2 Sync And Backups (Phase 5)**: Depends on US1 registration metadata and US2 host layout.
- **US4 Manual Recovery (Phase 6)**: Depends on US1 provisioning and US3 R2 backup metadata.
- **US5 First Customer Rollout (Phase 7)**: Depends on US1-US4.
- **Polish (Phase 8)**: Depends on all implemented stories.

### User Story Dependencies

- **US1 (P1)**: Start after Foundational; no dependency on other stories.
- **US2 (P2)**: Start after Foundational; can proceed in parallel with parts of US1 if database helpers and schemas are stable, but final routing validation requires US1 statuses.
- **US3 (P3)**: Start after US1 cloud-init and host layout are stable.
- **US4 (P4)**: Start after US3 backup/latest-pointer behavior exists.
- **US5 (P5)**: Start after recovery behavior is validated.

### Within Each User Story

- Tests must be written first and observed failing.
- Schema and model helpers before services.
- Services before routes.
- Host scripts before systemd integration.
- Route integration before quickstart/manual smoke validation.

---

## Parallel Opportunities

- Setup tasks T002-T005 can run in parallel.
- Foundational tasks T009-T018 can run in parallel after T006-T008 are agreed.
- US1 tests T019-T022 can run in parallel.
- US2 host unit tasks T036-T038 can run in parallel with routing work after T031-T032 exist.
- US3 scripts T046-T049 can run in parallel because they touch separate files.
- US4 tests T053-T055 can run in parallel.
- Polish verification tasks T069-T073 can run in parallel.

---

## Parallel Example: User Story 1

```bash
Task: "T019 [P] [US1] Add provisioning idempotency and failure-state tests in tests/platform/customer-vps.test.ts"
Task: "T020 [P] [US1] Add /vps route contract tests in tests/platform/customer-vps-routes.test.ts"
Task: "T021 [P] [US1] Add auth, body-limit, and validation rejection tests in tests/platform/customer-vps-routes.test.ts"
Task: "T022 [P] [US1] Add cloud-init render tests in tests/platform/customer-vps-cloud-init.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T031 [P] [US2] Add VPS-first routing and legacy fallback tests in tests/platform/profile-routing-vps.test.ts"
Task: "T036 [P] [US2] Implement matrix-gateway.service in distro/customer-vps/systemd/matrix-gateway.service"
Task: "T037 [P] [US2] Implement matrix-shell.service in distro/customer-vps/systemd/matrix-shell.service"
Task: "T038 [P] [US2] Implement matrix-sync-agent.service in distro/customer-vps/systemd/matrix-sync-agent.service"
```

## Parallel Example: User Story 3

```bash
Task: "T046 [P] [US3] Implement matrixctl in distro/customer-vps/matrixctl"
Task: "T047 [P] [US3] Implement matrix-db-backup.sh in distro/customer-vps/matrix-db-backup.sh"
Task: "T048 [P] [US3] Implement matrix-restore.sh in distro/customer-vps/matrix-restore.sh"
Task: "T049 [P] [US3] Implement backup units in distro/customer-vps/systemd/"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 and Phase 2.
2. Complete US1 tests and implementation.
3. Validate mocked provision/register/status/delete flows.
4. Stop and demo the MVP before adding routing, backups, or recovery.

### Incremental Delivery

1. US1: provision/register/status/delete with mocked providers.
2. US2: host installation and routing branch with legacy fallback intact.
3. US3: R2 heartbeat, restore/fresh gate, and DB backups.
4. US4: manual recovery from R2.
5. US5: one opt-in customer rollout documentation and smoke.

### Review Strategy

1. Run `bun run check:patterns` and fix hard-rule violations.
2. Do a trust-boundary sweep for `/vps/*`, R2 keys, Hetzner API calls, shell scripts, and routing.
3. Do an atomicity/failure-mode sweep for DB transactions, remote calls outside transactions, orphan states, and recovery rollback behavior.

## Notes

- Keep existing container users on the legacy path throughout phase 1.
- Do not add sleep, warm pools, automatic idle deletion, geographic routing, or existing-user migration in this task set.
- Do not run real Hetzner smoke tests without the explicit opt-in environment flag described in `quickstart.md`.
