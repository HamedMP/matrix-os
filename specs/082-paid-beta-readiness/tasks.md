# Tasks: Paid Beta Readiness

**Input**: Design documents from `specs/082-paid-beta-readiness/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/onboarding-readiness.md](./contracts/onboarding-readiness.md), [quickstart.md](./quickstart.md)

**Tests**: Required. Matrix OS constitution makes TDD non-negotiable, and the spec explicitly requires golden-path, Hermes always-on continuity, Finna-inspired admin/control UX, and visual QA checks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other tasks in the same phase because it touches different files or test fixtures.
- **[Story]**: User story label from `spec.md`.
- Every task includes an exact file path.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish shared contracts, brand tokens, and test fixtures before implementation.

- [X] T001 Add activation onboarding contract exports in `packages/gateway/src/onboarding/activation-contracts.ts`
- [X] T002 [P] Add Matrix website PR #162 brand tokens and motion constants in `shell/src/lib/onboarding-brand.ts`
- [X] T003 [P] Add shared e2e onboarding fixture helpers in `tests/e2e/helpers/onboarding.ts`
- [X] T004 [P] Add gateway launch readiness fixture helpers in `tests/helpers/activation-readiness.ts`
- [X] T005 [P] Add public docs placeholder for onboarding launch scope in `www/content/docs/onboarding-launch-readiness.mdx`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared owner-scoped readiness infrastructure that blocks all user stories.

**CRITICAL**: No user story work should start until this phase is complete.

### Tests First

- [X] T006 [P] Write failing contract tests for readiness schema validation in `tests/gateway/activation-readiness-routes.test.ts`
- [X] T007 [P] Write failing unit tests for readiness gate derivation in `tests/gateway/onboarding-activation.test.ts`
- [X] T008 [P] Write failing tests for safe client error mapping in `tests/gateway/onboarding-activation.test.ts`

### Implementation

- [X] T009 Implement owner-scoped readiness entity schemas in `packages/gateway/src/onboarding/activation-contracts.ts`
- [X] T010 Implement readiness repository interface and in-memory test adapter in `packages/gateway/src/onboarding/readiness-repository.ts`
- [X] T011 Implement readiness gate derivation service in `packages/gateway/src/onboarding/readiness-service.ts`
- [X] T012 Implement safe onboarding error mapper in `packages/gateway/src/onboarding/activation-errors.ts`
- [X] T013 Add owner-authenticated readiness routes in `packages/gateway/src/onboarding/readiness-routes.ts`
- [X] T014 Wire readiness routes in `packages/gateway/src/server.ts`
- [X] T015 Add bounded readiness status cache with eviction in `packages/gateway/src/onboarding/readiness-cache.ts`

**Checkpoint**: Gateway can return safe owner-scoped readiness status and reject invalid requests.

---

## Phase 3: User Story 1 - Complete Guided Onboarding To A Useful Workspace (Priority: P1) MVP

**Goal**: A new user gets a premium, educational, goal-based onboarding experience that reaches a beautiful ready/degraded state.

**Independent Test**: New user completes onboarding, sees Matrix capabilities explained, chooses a goal, and reaches a ready/degraded checklist without manual SSH or hidden commands.

### Tests First

- [ ] T016 [P] [US1] Write failing shell tests for goal-based onboarding state in `tests/gateway/onboarding-activation.test.ts`
- [ ] T017 [P] [US1] Write failing Playwright golden-path onboarding test in `tests/e2e/onboarding-activation.spec.ts`
- [ ] T018 [P] [US1] Write failing visual QA test for desktop, mobile, reduced-motion, and missing media in `tests/e2e/onboarding-visual.spec.ts`

### Implementation

- [ ] T019 [US1] Extend onboarding WebSocket message schemas for goal selection and readiness updates in `packages/gateway/src/onboarding/types.ts`
- [ ] T020 [US1] Persist selected onboarding goals and step progress in `packages/gateway/src/onboarding/readiness-service.ts`
- [ ] T021 [US1] Extend `useOnboarding` to handle goal/readiness/visual-system messages in `shell/src/hooks/useOnboarding.ts`
- [ ] T022 [P] [US1] Create branded onboarding shell frame in `shell/src/components/onboarding/BrandFrame.tsx`
- [ ] T023 [P] [US1] Create Matrix capability education panel in `shell/src/components/onboarding/CapabilityIntro.tsx`
- [ ] T024 [P] [US1] Create goal selector component in `shell/src/components/onboarding/GoalSelector.tsx`
- [ ] T025 [P] [US1] Create readiness checklist component in `shell/src/components/onboarding/ReadinessChecklist.tsx`
- [ ] T026 [US1] Refactor `OnboardingScreen` to use the branded frame, capability intro, goal selector, and checklist in `shell/src/components/OnboardingScreen.tsx`
- [ ] T027 [US1] Add responsive and reduced-motion styles for activation onboarding in `shell/src/app/globals.css`
- [ ] T028 [US1] Add polished fallback for missing onboarding media in `shell/src/components/onboarding/BrandFrame.tsx`
- [ ] T029 [US1] Update onboarding completion semantics to allow ready/degraded completion in `packages/gateway/src/onboarding/ws-handler.ts`

**Checkpoint**: US1 is independently demoable and visually reviewable.

---

## Phase 4: User Story 2 - Run The Core Coding Loop In Matrix (Priority: P1)

**Goal**: A coding-focused user connects GitHub/project context, starts a Symphony coding task, monitors it, uses terminal context, and receives a handoff without duplicate runs.

**Independent Test**: Connect a project, start one coding task, observe Symphony status and terminal context, and receive a completed/failed/needs-input/handoff result.

### Tests First

- [ ] T030 [P] [US2] Write failing tests for GitHub/project setup gates in `tests/gateway/activation-readiness-routes.test.ts`
- [ ] T031 [P] [US2] Write failing duplicate-run prevention test in `tests/gateway/symphony-workflow.test.ts`
- [ ] T032 [P] [US2] Write failing e2e coding setup path test in `tests/e2e/onboarding-activation.spec.ts`

### Implementation

- [ ] T033 [US2] Add coding setup gate derivation for GitHub, project, issue source, Symphony, and terminal in `packages/gateway/src/onboarding/readiness-service.ts`
- [ ] T034 [US2] Add coding setup option aggregation from Symphony and project manager in `packages/gateway/src/onboarding/coding-setup.ts`
- [ ] T035 [US2] Add duplicate coding task guard using Symphony run state in `packages/gateway/src/symphony/orchestrator.ts`
- [ ] T036 [US2] Extend Symphony route responses with safe active-agents and handoff status in `packages/gateway/src/symphony/routes.ts`
- [ ] T037 [P] [US2] Create coding setup connector component in `shell/src/components/onboarding/CodingSetupPanel.tsx`
- [ ] T038 [P] [US2] Create coding handoff summary component in `shell/src/components/onboarding/CodingHandoffSummary.tsx`
- [ ] T039 [US2] Wire coding setup panel into onboarding goal flow in `shell/src/components/OnboardingScreen.tsx`
- [ ] T040 [US2] Add terminal context launch action for coding setup in `shell/src/lib/app-launch.ts`

**Checkpoint**: US2 can pass without assistant/company-brain/support workflows.

---

## Phase 5: User Story 3 - Connect Agent Credentials While Keeping Hermes Always On (Priority: P1)

**Goal**: Claude, Codex, and Hermes states are visible and honest; Hermes remains the Matrix system agent with or without Claude/Codex; later credential upgrades do not reprovision the workspace.

**Independent Test**: Start with no Claude/Codex, complete onboarding with Hermes active, then connect Claude or Codex, see readiness upgrade, and verify Hermes still completes a supported app-building or assistant task.

### Tests First

- [ ] T041 [P] [US3] Write failing credential status route tests in `tests/gateway/agent-credential-status.test.ts`
- [ ] T042 [P] [US3] Write failing no-Claude Hermes golden-path e2e test in `tests/e2e/onboarding-activation.spec.ts`
- [ ] T043 [P] [US3] Write failing credential upgrade and connected-Hermes continuity tests in `tests/gateway/onboarding-activation.test.ts`

### Implementation

- [ ] T044 [US3] Implement agent credential status service in `packages/gateway/src/onboarding/agent-credential-status.ts`
- [ ] T045 [US3] Add agent credential status and verify routes in `packages/gateway/src/onboarding/agent-credential-routes.ts`
- [ ] T046 [US3] Wire agent credential routes in `packages/gateway/src/server.ts`
- [ ] T047 [US3] Add Hermes system-agent continuity gate and additive active-agent routing explanation in `packages/gateway/src/onboarding/readiness-service.ts`
- [ ] T048 [P] [US3] Create agent credential panel in `shell/src/components/onboarding/AgentCredentialPanel.tsx`
- [ ] T049 [US3] Add agent credential hook in `shell/src/hooks/useAgentCredentialStatus.ts`
- [ ] T050 [US3] Wire agent panel into onboarding and coding run status in `shell/src/components/OnboardingScreen.tsx`
- [ ] T051 [US3] Add safe Claude/Codex/Hermes display copy in `shell/src/components/onboarding/AgentCredentialPanel.tsx`

**Checkpoint**: No-Claude onboarding is useful, and connecting Claude/Codex does not disable Hermes.

---

## Phase 6: User Story 4 - Make Integrations Usable By Agents Through Skills (Priority: P1)

**Goal**: Agents can use approved integration capabilities for GitHub, calendar, email, messaging, and work updates with safe summaries.

**Independent Test**: Connect or mock one capability, approve Hermes, perform one calendar/email/summary action, and verify safe action audit.

### Tests First

- [ ] T052 [P] [US4] Write failing integration capability approval tests in `tests/gateway/integrations-routes.test.ts`
- [ ] T053 [P] [US4] Write failing safe action audit tests in `tests/gateway/onboarding-activation.test.ts`
- [ ] T054 [P] [US4] Write failing assistant integration e2e path in `tests/e2e/onboarding-activation.spec.ts`

### Implementation

- [ ] T055 [US4] Implement integration capability service in `packages/gateway/src/onboarding/integration-capabilities.ts`
- [ ] T056 [US4] Add capability approval routes in `packages/gateway/src/onboarding/integration-capability-routes.ts`
- [ ] T057 [US4] Wire capability routes in `packages/gateway/src/server.ts`
- [ ] T058 [US4] Implement safe agent action audit summaries in `packages/gateway/src/onboarding/agent-action-audit.ts`
- [ ] T059 [US4] Connect capability status to existing integrations registry in `packages/gateway/src/integrations/registry.ts`
- [ ] T060 [P] [US4] Create assistant integration setup panel in `shell/src/components/onboarding/AssistantSetupPanel.tsx`
- [ ] T061 [US4] Add integration capabilities hook in `shell/src/hooks/useIntegrationCapabilities.ts`
- [ ] T062 [US4] Wire assistant setup panel into onboarding goal flow in `shell/src/components/OnboardingScreen.tsx`

**Checkpoint**: US4 works with mocked or connected capabilities and safe summaries.

---

## Phase 7: Cross-Story Admin Control Surface (P1)

**Goal**: Users and operators can manage model/provider setup, agent credentials, integrations, settings, automations, activity, and readiness remediation in one beautiful Matrix-native surface inspired by Finna Cloud patterns.

**Independent Test**: Open Matrix settings/admin control, inspect provider cards for Hermes/Claude/Codex and integrations, resume an interrupted setup wizard, save/reload a setting, and verify automations/activity/readiness summaries are visible without a separate runbook.

### Tests First

- [ ] T063 [P] [ADMIN] Write failing admin control contract tests in `tests/gateway/admin-control-routes.test.ts`
- [ ] T064 [P] [ADMIN] Write failing admin control surface state tests in `tests/gateway/onboarding-activation.test.ts`
- [ ] T065 [P] [ADMIN] Write failing admin control e2e visual path in `tests/e2e/onboarding-activation.spec.ts`

### Implementation

- [ ] T066 [ADMIN] Implement admin control surface summaries in `packages/gateway/src/onboarding/admin-control-service.ts`
- [ ] T067 [ADMIN] Add admin control routes for provider cards, setup sessions, settings, automations, activity, and readiness in `packages/gateway/src/onboarding/admin-control-routes.ts`
- [ ] T068 [ADMIN] Wire admin control routes in `packages/gateway/src/server.ts`
- [ ] T069 [P] [ADMIN] Create Finna-inspired provider/model cards in `shell/src/components/onboarding/AdminControlPanel.tsx`
- [ ] T070 [P] [ADMIN] Create setup wizard resume/reconnect states in `shell/src/components/onboarding/AdminSetupWizard.tsx`
- [ ] T071 [ADMIN] Wire admin control panel into onboarding and settings entry points in `shell/src/components/OnboardingScreen.tsx`

**Checkpoint**: Admin/control setup is inspectable, resumable, and visually aligned with Matrix branding.

---

## Phase 8: User Story 5 - Use Matrix As The Company Brain (Priority: P2)

**Goal**: Users can capture, retrieve, and reuse company context with owner/teammate access scope.

**Independent Test**: Add representative context, ask Matrix for a related answer/draft, and verify source context is linked or named.

### Tests First

- [ ] T072 [P] [US5] Write failing company context access tests in `tests/gateway/company-brain-readiness.test.ts`
- [ ] T073 [P] [US5] Write failing company-brain onboarding e2e path in `tests/e2e/onboarding-activation.spec.ts`

### Implementation

- [ ] T074 [US5] Implement company context readiness service in `packages/gateway/src/onboarding/company-brain-readiness.ts`
- [ ] T075 [US5] Add company-brain setup routes in `packages/gateway/src/onboarding/company-brain-routes.ts`
- [ ] T076 [US5] Wire company-brain routes in `packages/gateway/src/server.ts`
- [ ] T077 [P] [US5] Create company-brain onboarding panel in `shell/src/components/onboarding/CompanyBrainPanel.tsx`
- [ ] T078 [US5] Wire company-brain panel into onboarding goal flow in `shell/src/components/OnboardingScreen.tsx`
- [ ] T079 [US5] Add source-link display and stale/contradictory context copy in `shell/src/components/onboarding/CompanyBrainPanel.tsx`

**Checkpoint**: US5 can run after foundation without support/growth publishing.

---

## Phase 9: User Story 6 - Operate Growth And Support Workflows (Priority: P2)

**Goal**: Matrix drafts support, acquisition, social, and follow-up actions with uncertainty highlighting and explicit approval before external send/publish.

**Independent Test**: Ask Matrix to draft one support or social response, inspect uncertainty flags, approve/reject, and verify audit summary.

### Tests First

- [ ] T080 [P] [US6] Write failing draft action approval tests in `tests/gateway/support-growth-readiness.test.ts`
- [ ] T081 [P] [US6] Write failing support/growth e2e path in `tests/e2e/onboarding-activation.spec.ts`

### Implementation

- [ ] T082 [US6] Implement draft action readiness and approval service in `packages/gateway/src/onboarding/draft-action-readiness.ts`
- [ ] T083 [US6] Add draft action routes in `packages/gateway/src/onboarding/draft-action-routes.ts`
- [ ] T084 [US6] Wire draft action routes in `packages/gateway/src/server.ts`
- [ ] T085 [P] [US6] Create support/growth onboarding panel in `shell/src/components/onboarding/SupportGrowthPanel.tsx`
- [ ] T086 [US6] Wire support/growth panel into onboarding goal flow in `shell/src/components/OnboardingScreen.tsx`
- [ ] T087 [US6] Add uncertainty and sensitive-claim display states in `shell/src/components/onboarding/SupportGrowthPanel.tsx`

**Checkpoint**: US6 drafts remain review-first and safe.

---

## Phase 10: User Story 7 - Gate Paid Beta On Operational Readiness (Priority: P3)

**Goal**: Operators can see whether paid beta can launch and which gates fail for fresh/existing workspaces.

**Independent Test**: Run operator readiness report, force a gate failure, and verify pass/fail/blocked status with owner and remediation.

### Tests First

- [ ] T088 [P] [US7] Write failing operator readiness route tests in `tests/platform/launch-readiness.test.ts`
- [ ] T089 [P] [US7] Write failing entitlement preservation tests in `tests/platform/launch-entitlement.test.ts`

### Implementation

- [ ] T090 [US7] Implement platform launch readiness aggregator in `packages/platform/src/launch-readiness.ts`
- [ ] T091 [US7] Add operator readiness route in `packages/platform/src/launch-readiness-routes.ts`
- [ ] T092 [US7] Wire operator readiness route in `packages/platform/src/main.ts`
- [ ] T093 [US7] Add entitlement gate behavior without owner-data deletion in `packages/platform/src/profile-routing.ts`
- [ ] T094 [US7] Add operator remediation summaries for failed gates in `packages/platform/src/launch-readiness.ts`

**Checkpoint**: Paid beta cannot be marked launch-ready while release-critical gates fail.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, visual evidence, review hygiene, and release validation.

- [ ] T095 [P] Update public onboarding launch docs in `www/content/docs/onboarding-launch-readiness.mdx`
- [ ] T096 [P] Update developer review notes for launch gates in `docs/dev/review-pipeline.md`
- [ ] T097 Run and record `bun run typecheck` result in `specs/082-paid-beta-readiness/quickstart.md`
- [ ] T098 Run and record `bun run check:patterns` result in `specs/082-paid-beta-readiness/quickstart.md`
- [ ] T099 Run and record `bun run test` result in `specs/082-paid-beta-readiness/quickstart.md`
- [ ] T100 Run and record onboarding e2e/visual QA results in `specs/082-paid-beta-readiness/quickstart.md`
- [ ] T101 Review changed backend routes against `docs/dev/review-pipeline.md` and add PR invariants in `specs/082-paid-beta-readiness/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundation**: Depends on Phase 1. Blocks all user stories.
- **US1, US2, US3, US4 (P1)**: Depend on Phase 2. US1 should land first for MVP UX; US2/US3/US4 may proceed in parallel after shared contracts are stable.
- **Admin control surface (P1)**: Depends on Phase 2 and benefits from US3/US4 status services.
- **US5 and US6 (P2)**: Depend on Phase 2 and benefit from US4 action audit/capability services.
- **US7 (P3)**: Depends on readiness gates from US1-US6 and admin control surface readiness.
- **Polish**: Depends on the user stories included in the release slice.

### User Story Dependencies

- **US1**: No story dependencies after foundation.
- **US2**: Depends on foundation; integrates with US3 active-agents display when available.
- **US3**: Depends on foundation; informs US2 and US4 routing.
- **US4**: Depends on foundation and optionally US3 for agent display.
- **Admin control surface**: Depends on foundation; integrates US3 credential status, US4 capabilities, settings, automations, activity, and readiness.
- **US5**: Depends on foundation; can reuse US4 action audit but remains testable independently.
- **US6**: Depends on foundation and approval/audit patterns from US4.
- **US7**: Depends on all release-critical gates it reports.

### Parallel Opportunities

- T002-T005 can run in parallel after T001 is understood.
- T006-T008 can run in parallel before T009.
- Component creation tasks within US1 can run in parallel: T022-T025.
- US2, US3, and US4 can be staffed in parallel after Phase 2, with route names coordinated through `activation-contracts.ts`.
- US5 and US6 can run in parallel after Phase 2 if they do not both edit `OnboardingScreen.tsx` at the same time.
- Polish docs and validation records can run in parallel with final QA after all release-critical stories are implemented.

---

## Parallel Example: User Story 1

```bash
Task: "Write failing Playwright golden-path onboarding test in tests/e2e/onboarding-activation.spec.ts"
Task: "Write failing visual QA test for desktop, mobile, reduced-motion, and missing media in tests/e2e/onboarding-visual.spec.ts"
Task: "Create branded onboarding shell frame in shell/src/components/onboarding/BrandFrame.tsx"
Task: "Create Matrix capability education panel in shell/src/components/onboarding/CapabilityIntro.tsx"
Task: "Create goal selector component in shell/src/components/onboarding/GoalSelector.tsx"
Task: "Create readiness checklist component in shell/src/components/onboarding/ReadinessChecklist.tsx"
```

---

## Graphite Stack Plan

Use `docs/dev/stacked-prs.md`; do not flatten this feature.

- **Stack 1: `feat(onboarding): add launch readiness contracts`**  
  Tasks T001-T015 plus spec artifacts. Backend PR body must include source of truth, transaction/lock scope, acceptable orphan states, auth source of truth, and deferred scope.
- **Stack 2: `feat(onboarding): ship premium first-run setup`**  
  Tasks T016-T029. Include desktop/mobile/reduced-motion screenshots.
- **Stack 3: `feat(onboarding): activate coding setup and Hermes continuity`**  
  Tasks T030-T051. Keep Symphony changes scoped and include duplicate-run invariant.
- **Stack 4: `feat(integrations): approve assistant capabilities`**  
  Tasks T052-T062. Include provider-error and approval invariants.
- **Stack 5: `feat(onboarding): add admin control surface`**  
  Tasks T063-T071. Include provider-card, setup-resume, settings, automation, activity, and readiness evidence.
- **Stack 6: `feat(onboarding): add company brain and draft workflows`**  
  Tasks T072-T087. Split US5 and US6 into separate PRs if file count grows.
- **Stack 7: `feat(platform): gate launch readiness`**  
  Tasks T088-T094. Include entitlement data-preservation invariant.
- **Stack 8: `docs(onboarding): publish launch validation evidence`**  
  Tasks T095-T101. Include final command results and visual QA artifacts.

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete US1 premium onboarding.
3. Validate the user can understand Matrix, select a goal, and reach ready/degraded status.
4. Stop and review visual quality before backend scope expands.

### Launch-Critical Slice

1. Foundation.
2. US1 onboarding UX.
3. US2 coding loop.
4. US3 Claude/Codex/Hermes agent routing.
5. US4 approved integration capabilities.
6. Admin/control surface for models, settings, automations, activity, and readiness.
7. US7 operator gates for the release-critical checks.

### Full Scope

Add US5 company brain and US6 support/growth workflows after the launch-critical slice is stable, unless the release positioning requires them before charging.
