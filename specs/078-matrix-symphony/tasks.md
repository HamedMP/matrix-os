# Tasks: Matrix Symphony

**Input**: Design documents from `specs/078-matrix-symphony/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Tests**: Required by constitution and FR-021. Write failing tests before implementation.
**Goal**: One Matrix-native Symphony app and runner for Matrix owners and authorized teammates.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the consolidated Matrix-native Symphony module and remove product dependence on the external runner path.

- [ ] T001 Create consolidated `packages/gateway/src/symphony/` module exports in `packages/gateway/src/symphony/index.ts`
- [ ] T002 Move shared schemas and response contracts into `packages/gateway/src/symphony/contracts.ts`
- [ ] T003 [P] Add Matrix-native Symphony exports in `packages/gateway/src/index.ts`
- [ ] T004 [P] Update `home/apps/symphony/matrix.json` permissions/metadata for the Matrix-native runner surface

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core storage, credential, auth, and event infrastructure that blocks every user story.

- [ ] T005 [P] Write credential isolation tests in `tests/gateway/symphony-credential-store.test.ts`
- [ ] T006 [P] Write repository transaction/recovery tests in `tests/gateway/symphony-repository.test.ts`
- [ ] T007 [P] Write SSE/status hub cap and shutdown tests in `tests/gateway/symphony-status-hub.test.ts`
- [ ] T008 Implement server-side Linear credential store with atomic owner-only writes in `packages/gateway/src/symphony/credential-store.ts`
- [ ] T009 Implement owner-scoped repository with transactional config/rule/run/operator-event writes in `packages/gateway/src/symphony/repository.ts`
- [ ] T010 Implement bounded SSE/status hub with stale subscriber eviction in `packages/gateway/src/symphony/status-hub.ts`
- [ ] T011 Implement operator authorization helpers in `packages/gateway/src/symphony/auth.ts`
- [ ] T012 Wire consolidated Matrix Symphony dependencies in `packages/gateway/src/server.ts`

**Checkpoint**: Foundation ready. User story work can start after tests fail then pass.

---

## Phase 3: User Story 1 - Connect Linear Securely (Priority: P1) MVP

**Goal**: Owner can add or use a server-side Linear credential, configure eligibility rules including assignees, preview tickets, and never expose secrets to browser state.

**Independent Test**: From no Symphony config, save a Linear credential and rule set, reload config, preview tickets, and verify responses contain no token/raw provider details.

### Tests for User Story 1

- [ ] T013 [P] [US1] Write route tests for credential/config secret redaction in `tests/gateway/symphony-routes.test.ts`
- [ ] T014 [P] [US1] Write Linear assignee/team/project/label filtering tests in `tests/gateway/symphony-linear-source.test.ts`
- [ ] T015 [P] [US1] Write app setup/dashboard tests for credential setup and ticket preview in `tests/default-apps/symphony-app.test.tsx`

### Implementation for User Story 1

- [ ] T016 [US1] Implement Linear source adapter with assignee filtering and bounded preview in `packages/gateway/src/symphony/linear-source.ts`
- [ ] T017 [US1] Implement `GET/POST /api/symphony/config` and Linear credential endpoints with `bodyLimit` and credential/rule-change audit events in `packages/gateway/src/symphony/routes.ts`
- [ ] T018 [US1] Replace setup-heavy Symphony UI with credential/rule setup and preview flow in `home/apps/symphony/src/App.tsx`
- [ ] T019 [US1] Update first-party app styling for dashboard-first setup in `home/apps/symphony/src/index.css`
- [ ] T020 [US1] Remove browser-visible external runner path/bin/workflow setup as a normal flow from `home/apps/symphony/src/App.tsx`

**Checkpoint**: User Story 1 works independently and does not expose secrets.

---

## Phase 4: User Story 2 - Run Assigned Tickets Inside Matrix (Priority: P1)

**Goal**: Symphony polls eligible Linear tickets, creates/reuses deterministic Matrix worktrees, starts one coding-agent session per claim, and reconciles stale or ineligible runs.

**Independent Test**: Seed an eligible ticket and verify one worktree/session claim is created; a second claim is rejected/reused; restart recovery reconciles stale claims.

### Tests for User Story 2

- [ ] T021 [P] [US2] Write duplicate claim and concurrency tests in `tests/gateway/symphony-orchestrator.test.ts`
- [ ] T022 [P] [US2] Write workflow prompt composition tests in `tests/gateway/symphony-workflow.test.ts`
- [ ] T023 [P] [US2] Write restart recovery tests in `tests/gateway/symphony-restart-recovery.test.ts`

### Implementation for User Story 2

- [ ] T024 [US2] Implement workflow contract loader and prompt composer in `packages/gateway/src/symphony/prompt.ts`
- [ ] T025 [US2] Implement Matrix-native orchestrator poll/claim/retry/reconcile logic in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T026 [US2] Integrate worktree/session dependency adapters in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T027 [US2] Implement start/stop/retry run actions with generic errors and operator events in `packages/gateway/src/symphony/routes.ts`
- [ ] T028 [US2] Consolidate or remove legacy external-runner behavior in `packages/gateway/src/symphony-runner.ts` and `packages/gateway/src/symphony-routes.ts`
- [ ] T029 [US2] Update server shutdown to drain Symphony orchestrator/status hub in `packages/gateway/src/server.ts`

**Checkpoint**: P1 backend can dispatch Matrix-owned ticket work safely.

---

## Phase 5: User Story 3 - Operate Agents From A Simple Dashboard (Priority: P2)

**Goal**: Authorized operators can see queue/running/attention/handoff states and perform stop/retry/open actions without raw GraphQL or shell commands.

**Independent Test**: Seed runs in all dashboard groups and verify display, action behavior, and unauthorized users receive no run details.

### Tests for User Story 3

- [ ] T030 [P] [US3] Write sanitized run list/action route tests in `tests/gateway/symphony-routes.test.ts`
- [ ] T031 [P] [US3] Write dashboard grouping/action tests in `tests/default-apps/symphony-app.test.tsx`
- [ ] T032 [P] [US3] Write unauthorized operator denial tests in `tests/gateway/symphony-routes.test.ts`

### Implementation for User Story 3

- [ ] T033 [US3] Implement `GET /api/symphony/status`, `GET /api/symphony/runs`, and `GET /api/symphony/events` in `packages/gateway/src/symphony/routes.ts`
- [ ] T034 [US3] Implement dashboard queue/running/attention/handoff groups in `home/apps/symphony/src/App.tsx`
- [ ] T035 [US3] Implement start/stop orchestrator, stop/retry run, open workspace, and open external ticket actions in `home/apps/symphony/src/App.tsx`
- [ ] T036 [US3] Ensure client store/state is serializable and selectors avoid fresh object allocations in `home/apps/symphony/src/App.tsx`

**Checkpoint**: Operator dashboard is the default product surface.

---

## Phase 6: User Story 4 - Preserve Workflow Policy In The Repo (Priority: P3)

**Goal**: Workflow policy remains in repository-owned `WORKFLOW.md` while Matrix stores runtime rules and credentials separately.

**Independent Test**: Configure a project workflow file, dispatch a ticket, and verify prompt includes workflow plus ticket context while secrets remain server-side.

### Tests for User Story 4

- [ ] T037 [P] [US4] Write workflow path validation tests in `tests/gateway/symphony-workflow.test.ts`
- [ ] T038 [P] [US4] Write prompt-with-ticket-context tests in `tests/gateway/symphony-orchestrator.test.ts`

### Implementation for User Story 4

- [ ] T039 [US4] Validate workflow paths inside selected Matrix project in `packages/gateway/src/symphony/prompt.ts`
- [ ] T040 [US4] Apply workflow reload behavior for future dispatches in `packages/gateway/src/symphony/orchestrator.ts`

**Checkpoint**: Repo workflow policy is preserved without leaking runtime credentials.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation gates, and PR readiness.

- [ ] T041 [P] Update public Symphony docs in `www/content/docs/symphony.mdx`
- [ ] T042 [P] Update developer Symphony docs in `docs/dev/symphony.md`
- [ ] T043 [P] Update tests for default app packaging/icons in `tests/gateway/apps.test.ts`
- [ ] T044 Run focused tests from `specs/078-matrix-symphony/quickstart.md`
- [ ] T045 Run `bun run typecheck` from repo root `/home/deploy/matrix-os.worktrees/078-matrix-symphony`
- [ ] T046 Run `bun run check:patterns` from repo root `/home/deploy/matrix-os.worktrees/078-matrix-symphony`
- [ ] T047 Run `bun run test` from repo root `/home/deploy/matrix-os.worktrees/078-matrix-symphony`
- [ ] T048 Review changed files with `docs/dev/review-pipeline.md` trust-boundary and atomicity passes
- [ ] T049 Commit implementation with Conventional Commit messages
- [ ] T050 Push `078-matrix-symphony` and open PR with backend invariants
- [ ] T051 Inspect and fix all actionable PR review comments

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all stories.
- **User Stories 1 and 2 (P1)**: Depend on Foundation. US1 credential/config can progress before US2 dispatch, but US2 needs US1 credential/rule contracts.
- **User Story 3 (P2)**: Depends on run/status contracts from US2.
- **User Story 4 (P3)**: Depends on orchestrator prompt dispatch from US2.
- **Polish**: Depends on completed implementation.

### User Story Dependencies

- **US1**: Required for secure setup and preview MVP.
- **US2**: Required for Matrix-native runner MVP; depends on US1 contracts.
- **US3**: Builds on US2 run state, but can test seeded run data independently.
- **US4**: Builds on US2 prompt dispatch, but workflow validation is independently testable.

### Parallel Opportunities

- T003 and T004 can run after T001/T002.
- T005, T006, and T007 can be written in parallel.
- T013, T014, and T015 can be written in parallel.
- T021, T022, and T023 can be written in parallel.
- T030, T031, and T032 can be written in parallel.
- Docs T041 and T042 can be updated in parallel after behavior is stable.

## Implementation Strategy

1. Complete setup and foundation.
2. Deliver P1 as two slices: secure Linear setup, then Matrix-native dispatch.
3. Replace the app’s external-runner setup with the operator dashboard.
4. Preserve `WORKFLOW.md` as the repo-owned policy contract.
5. Run focused tests, then full repo gates, then PR/review cleanup.
