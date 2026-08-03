# Tasks: Unified Agent Runtime Configuration

**Input**: Design documents from `specs/107-agent-runtime-config/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `security.md`, `integration.md`, `failure-modes.md`, `resource-management.md`, `contracts/`

**Tests**: TDD is mandatory. Every test task is completed and observed red before its corresponding implementation task begins.

**Organization**: Tasks are grouped by user story, with the three independent mobile/backend contract gaps scheduled early in the Graphite stack even though they map to US1/US5.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel in a separate worktree because it changes different files and has no incomplete dependency.
- **[Story]**: Maps to a user story in `spec.md`.
- Every task names its primary file path.

## Phase 1: Setup and Spec Gate

**Purpose**: Freeze the spike-backed design and prepare the manual Graphite stack.

- [ ] T001 Validate all links, headings, scope boundaries, and checklist results in `specs/107-agent-runtime-config/spec.md` and `specs/107-agent-runtime-config/checklists/requirements.md`
- [ ] T002 Validate the OpenClaw version/process/RPC/plugin/resource evidence and official source links in `specs/107-agent-runtime-config/research.md`
- [ ] T003 Validate the HTTP contract syntax and cross-schema consistency in `specs/107-agent-runtime-config/contracts/agent-settings.openapi.yaml`
- [ ] T004 Run Spec Kit cross-artifact analysis and resolve all critical/high findings across `specs/107-agent-runtime-config/`
- [ ] T005 Create the spec-only Graphite PR from the manual `107-agent-runtime-config` worktree using `specs/107-agent-runtime-config/pr-invariants.md` in its PR body

**Checkpoint**: The spec PR is reviewable, under size limits, and implementation does not begin until the spike-before-spec gate is visible to reviewers.

---

## Phase 2: Foundational Shared Contracts

**Purpose**: Define bounded, reusable wire schemas before backend or shell adoption.

**Critical**: These tasks block unified settings and both current-shell implementations, but do not block the three independent contract-gap PRs.

- [ ] T006 Add failing runtime/provider/model/effective-and-supported-auth/selection schema tests in `tests/contracts/agent-runtime-config.test.ts`
- [ ] T007 Add failing additive legacy-response and legacy-update compatibility fixtures in `tests/contracts/agent-runtime-config.test.ts`
- [ ] T008 Implement `AgentRuntimeId`, runtime descriptor, provider descriptor with effective/supported auth kinds, model, auth status, Chat/messaging selection, settings view, and update schemas in `packages/contracts/src/index.ts`
- [ ] T009 Add cross-field caps, uniqueness, selected-runtime, selected-model, and strict-object refinements in `packages/contracts/src/index.ts`
- [ ] T010 Export inferred agent runtime configuration types from `packages/contracts/src/index.ts` and run `tests/contracts/agent-runtime-config.test.ts` green
- [ ] T011 Create the shared-contract Graphite PR and record red/green test counts in its body using `specs/107-agent-runtime-config/pr-invariants.md`

**Checkpoint**: Current clients can ignore new fields; current and future shells share one bounded schema package.

---

## Phase 3: User Story 1 - Configure the Chat Agent Once (Priority: P1) MVP

**Goal**: Make effective Chat model/effort visible and allow safe saved or one-message choices without changing the kernel architecture.

**Independent Test**: Save a model/effort, send one message with another allowlisted choice, and verify the next unoverridden message returns to the saved selection.

### Tests for User Story 1

- [ ] T012 [P] [US1] Add failing optional model/effort frame validation tests in `tests/gateway/ws-message-schema.test.ts`
- [ ] T013 [P] [US1] Add failing dispatcher tests proving request-scoped model/effort reach `KernelConfig` without persistence in `tests/gateway/dispatcher.test.ts`
- [ ] T014 [P] [US1] Add failing effective-model and default-model system-info tests in `tests/gateway/system-info.test.ts`
- [ ] T015 [US1] Run T012–T014 focused tests and preserve expected red output before production edits

### Implementation for User Story 1

- [ ] T016 [US1] Add optional allowlisted `model` and `effort` to the strict message frame in `packages/gateway/src/ws-message-schema.ts`
- [ ] T017 [US1] Introduce a typed request-scoped dispatch-options parameter and thread model/effort through queueing in `packages/gateway/src/dispatcher.ts`
- [ ] T018 [US1] Pass validated request-scoped model and effort into `KernelConfig` in `packages/gateway/src/dispatcher.ts`
- [ ] T019 [US1] Wire parsed message overrides into dispatch without changing channel/cron/API callers in `packages/gateway/src/server.ts`
- [ ] T020 [US1] Extract/reuse the effective kernel model resolver and expose it on `SystemInfo` in `packages/gateway/src/system-info.ts`
- [ ] T021 [US1] Run focused gateway tests green and add a regression proving the following message uses the saved/default selection in `tests/gateway/dispatcher.test.ts`
- [ ] T022 [US1] Create separate Graphite PRs for per-message overrides and system-info model, each with exact red/green evidence and `specs/107-agent-runtime-config/pr-invariants.md`

**Checkpoint**: Chat configuration is independently functional; no messaging runtime is required.

---

## Phase 4: User Story 2 - Authenticate With the Right Provider Flow (Priority: P1)

**Goal**: Normalize provider/model catalogs and offer secure platform, key, login, and base-URL setup actions.

**Independent Test**: Exercise one provider of each advertised auth kind and verify only coarse readiness returns while a secret canary never appears in reads, errors, logs, or client state.

### Tests for User Story 2

- [ ] T023 [P] [US2] Add failing provider catalog normalization, malformed-item, and global-cap tests in `tests/gateway/agent-provider-catalog.test.ts`
- [ ] T024 [P] [US2] Add failing legacy/additive Agent settings GET/PUT, revision, body-limit, and strict-patch tests in `tests/gateway/settings-desktop.test.ts`
- [ ] T025 [P] [US2] Add failing provider API-key/login/delete auth-matrix and secret-canary tests in `tests/gateway/agent-provider-auth.test.ts`
- [ ] T026 [US2] Run T023–T025 focused tests and preserve expected red output before production edits

### Implementation for User Story 2

- [ ] T027 [P] [US2] Define gateway-only write-only credential, base-URL, path-param, and runtime-response schemas in `packages/gateway/src/agent-config/schemas.ts`
- [ ] T028 [P] [US2] Implement deterministic scoped Chat/Hermes provider normalization and catalog caps in `packages/gateway/src/agent-config/provider-catalog.ts`
- [ ] T029 [US2] Implement one-read additive Agent configuration orchestration and atomic field-presence patching in `packages/gateway/src/agent-config/service.ts`
- [ ] T030 [US2] Extend legacy `GET/PUT /api/settings/agent` and mount body-limited provider auth routes in `packages/gateway/src/routes/settings.ts`
- [ ] T031 [US2] Reuse the existing Anthropic API-key validation path behind the provider-scoped route without changing `/api/settings/api-key` in `packages/gateway/src/routes/settings.ts`
- [ ] T032 [US2] Implement HTTPS/base-URL validation with prohibited-range and redirect policy in `packages/gateway/src/agent-config/base-url-policy.ts`
- [ ] T033 [US2] Map all runtime/provider failures to bounded provider-neutral client codes in `packages/gateway/src/agent-config/errors.ts`
- [ ] T034 [US2] Run focused tests green, then affected gateway/contracts tests, and create the additive-settings Graphite PR using `specs/107-agent-runtime-config/pr-invariants.md`

**Checkpoint**: The unified contract works with the current kernel and Hermes; OpenClaw can remain unavailable.

---

## Phase 5: User Story 3 - Choose the Optional Messaging Runtime Safely (Priority: P2)

**Goal**: Add OpenClaw lifecycle/config support and fail-closed switching without affecting Chat or Matrix room permissions.

**Independent Test**: Verify absent OpenClaw cannot be selected, then install/configure it on preview, switch once with no duplicate work, and inject activation failure to prove rollback to Hermes.

### Tests for User Story 3

- [ ] T035 [P] [US3] Add failing authenticated handshake, RPC allowlist, correlation-cap, timeout, malformed-frame, and close tests in `tests/gateway/openclaw-adapter.test.ts`
- [ ] T036 [P] [US3] Add failing Hermes normalization compatibility tests in `tests/gateway/hermes-runtime-adapter.test.ts`
- [ ] T037 [P] [US3] Add failing lock, drain, activation, health-gate, rollback, concurrent-switch, and startup-reconcile tests in `tests/gateway/agent-runtime-controller.test.ts`
- [ ] T038 [P] [US3] Add failing installer/wrapper/unit/admission/plugin-allowlist/host-bundle tests in `tests/deploy/customer-vps/openclaw-systemd.test.ts`
- [ ] T039 [P] [US3] Add failing permission-revision, late-output discard, and duplicate-delivery switch tests in `tests/gateway/messages-runtime-delivery.test.ts`
- [ ] T040 [US3] Run T035–T039 focused tests and preserve expected red output before production edits

### Implementation for User Story 3

- [ ] T041 [P] [US3] Implement the normalized Hermes `MessagingRuntimeAdapter` in `packages/gateway/src/agent-config/hermes-adapter.ts`
- [ ] T042 [P] [US3] Implement authenticated bounded OpenClaw WebSocket RPC in `packages/gateway/src/agent-config/openclaw-rpc.ts`
- [ ] T043 [US3] Implement OpenClaw catalog, auth, selection, configure, health, dashboard, and shutdown adapter behavior in `packages/gateway/src/agent-config/openclaw-adapter.ts`
- [ ] T044 [US3] Implement exclusive-lock transition orchestration, bounded drain, fixed controller invocation, atomic commit, rollback, and startup reconciliation in `packages/gateway/src/agent-config/runtime-controller.ts`
- [ ] T045 [P] [US3] Add the pinned, bounded, integrity-aware optional installer in `distro/customer-vps/host-bin/matrix-install-openclaw`
- [ ] T046 [P] [US3] Add the loopback/token/plugin-allowlist wrapper in `distro/customer-vps/host-bin/matrix-openclaw-gateway`
- [ ] T047 [US3] Add bounded restart/admission systemd policy in `distro/customer-vps/systemd/matrix-openclaw-gateway.service`
- [ ] T048 [US3] Add the exact-argument status/switch controller in `distro/customer-vps/host-bin/matrix-agent-runtime-control`
- [ ] T049 [US3] Stage/chmod/install the OpenClaw wrapper, unit, and controller in `scripts/build-host-bundle.sh` and `distro/customer-vps/cloud-init.yaml`
- [ ] T050 [US3] Generalize Matrix-owned work delivery to the selected adapter in `packages/gateway/src/messages/runtime-delivery.ts` and retain compatibility exports in `packages/gateway/src/messages/hermes-delivery.ts`
- [ ] T051 [US3] Wire both adapters and controller dependencies at gateway registration time in `packages/gateway/src/server.ts`
- [ ] T052 [US3] Run focused and affected deploy/gateway tests green and create separate runtime-host and runtime-adapter Graphite PRs if either approaches 1,000 additions

**Checkpoint**: Messaging runtime selection is independently usable from API tests while Chat remains available in every failure injection.

---

## Phase 6: User Story 4 - Configure From Any Shell (Priority: P2)

**Goal**: Deliver a complete Canvas-first web Agent section and equivalent desktop cards with older-gateway fallback.

**Independent Test**: Change model/runtime/provider state in web, refresh desktop to the same effective state, and render both shells against a legacy response without crashing or hiding model/effort.

### Tests for User Story 4

- [ ] T053 [P] [US4] Add failing shell normalizer/client tests for current, legacy, malformed, oversized, timeout, and safe-error responses in `shell/src/lib/agent-config.test.ts`
- [ ] T054 [P] [US4] Add failing Canvas Agent section tests for loading, empty, unavailable, update-needed, auth, runtime, model, save, retry, and secret-state behavior in `tests/shell/agent-settings.test.tsx`
- [ ] T055 [P] [US4] Add failing Settings navigation test proving only Agent is removed from the deferred hidden set in `tests/shell/settings-panel.test.tsx`
- [ ] T056 [P] [US4] Extend failing desktop normalizer tests for optional extended fields and legacy fallback in `tests/desktop/agent-config.test.ts`
- [ ] T057 [P] [US4] Add failing desktop runtime/provider/auth/current-selection tests in `tests/desktop/agent-section.test.tsx`
- [ ] T058 [P] [US4] Add failing trusted IPC setup-action validation tests in `tests/desktop/ipc-contract.test.ts`
- [ ] T059 [US4] Run T053–T058 focused tests and preserve expected red output before production edits

### Implementation for User Story 4

- [ ] T060 [P] [US4] Implement bounded shared-contract parsing, legacy fallback, and abortable requests in `shell/src/lib/agent-config.ts`
- [ ] T061 [US4] Extract identity/SOUL behavior and implement current selection, runtime picker, provider/auth cards, model/effort picker, dashboard, and state handling in `shell/src/components/settings/sections/AgentSection.tsx`
- [ ] T062 [US4] Remove only `agent` from `HIDDEN_SECTION_IDS` and preserve every other deferred section in `shell/src/components/Settings.tsx`
- [ ] T063 [US4] Route install/login actions through the canonical visible Terminal built-in in `shell/src/components/settings/sections/AgentSection.tsx`
- [ ] T064 [P] [US4] Extend the defensive current/legacy wire normalizer in `desktop/src/renderer/src/lib/agent-config.ts`
- [ ] T065 [US4] Add messaging runtime, provider/auth, model, and messaging dashboard cards while extracting focused subcomponents from `desktop/src/renderer/src/features/settings/sections/AgentSection.tsx`
- [ ] T066 [US4] Add typed allowlisted setup actions in `desktop/src/shared/ipc-contract.ts`, register them in `desktop/src/main/ipc/handlers.ts`, and expose only the validated bridge in `desktop/src/preload/index.ts`
- [ ] T067 [US4] Run shell/desktop focused tests green, React Doctor on changed React files, and `bun run build:shell:production`
- [ ] T068 [US4] Create separate web-shell and desktop Graphite PRs with screenshots/evidence, exact test counts, and `specs/107-agent-runtime-config/pr-invariants.md`

**Checkpoint**: Web Canvas and desktop configure the same computer state; legacy gateways remain understandable and usable.

---

## Phase 7: User Story 5 - Preserve Conversation Continuity on Mobile (Priority: P2)

**Goal**: Supply the independent backend gaps and shared schemas mobile needs without changing its separately developed UI.

**Independent Test**: A legacy-compatible client updates model/effort, reads effective system model, switches to a stored conversation, and receives the persisted transcript in order.

### Tests for User Story 5

- [ ] T069 [P] [US5] Add failing valid/missing/malformed/traversal/store-error transcript route tests in `tests/gateway/conversations-routes.test.ts`
- [ ] T070 [US5] Run the focused conversation route test and preserve expected red output before production edits

### Implementation for User Story 5

- [ ] T071 [US5] Add a bounded conversation-id schema and authenticated `GET /api/conversations/:id` handler in `packages/gateway/src/routes/conversations.ts`, then wire that registrar in `packages/gateway/src/server.ts`
- [ ] T072 [US5] Map only true absence to 404 and operational read failures to safe 5xx in `packages/gateway/src/routes/conversations.ts`
- [ ] T073 [US5] Run conversation list/create/delete/search/transcript tests green and create the independent conversation-transcript Graphite PR using `specs/107-agent-runtime-config/pr-invariants.md`
- [ ] T074 [US5] Verify current PR #941 and #955 contract fixtures against the extended settings schemas without modifying `apps/mobile/` in `tests/contracts/agent-runtime-config.test.ts`

**Checkpoint**: Mobile contract compatibility is proven without coupling this stack to mobile UI implementation.

---

## Phase 8: Polish, Gates, and Live Verification

**Purpose**: Complete cross-cutting review, exact-head CI, and real preview deployment proof.

- [ ] T075 [P] Add failing owner-local diagnostic redaction, cap, rotation, and mutation/switch event tests in `tests/gateway/agent-runtime-diagnostics.test.ts`
- [ ] T076 Implement async capped owner-local diagnostic events and shutdown cleanup in `packages/gateway/src/agent-config/diagnostics.ts`, then wire them into `packages/gateway/src/agent-config/service.ts` and `packages/gateway/src/agent-config/runtime-controller.ts`
- [ ] T077 [P] Add a timed 100-read probe-cache and cross-shell save/read consistency test with a 2-second budget in `tests/gateway/agent-settings-performance.test.ts`
- [ ] T078 [P] Run `bun run typecheck` and record exact result for every stack head in the corresponding PR body
- [ ] T079 [P] Run `bun run check:patterns` and the trust-boundary/atomicity review from `docs/dev/review-pipeline.md` for every changed backend file
- [ ] T080 Run `bun run test` and record exact passing/failing/skipped counts for every stack head
- [ ] T081 [P] Verify kernel prompt token count remains below 7K using the repository prompt check and record evidence in the affected PR body
- [ ] T082 Freeze each review range, obtain current-head CI and Greptile 5/5, and resolve review comments without flattening the stack
- [ ] T083 Apply `preview-vps`, resolve the PR #919 deployed bundle to an exact SHA, and record whether the #929–#935 backend-stack tip is installed in `specs/107-agent-runtime-config/verification.md`
- [ ] T084 If missing, build/publish/deploy the exact backend-stack-tip host bundle through the VPS-native release path and record installed `BUNDLE_VERSION`/`release.json` evidence in `specs/107-agent-runtime-config/verification.md`
- [ ] T085 Re-verify authenticated terminal-session create/connect and the real mobile provider install/login action end to end in `specs/107-agent-runtime-config/verification.md`
- [ ] T086 Build, publish, and deploy each runtime-feature exact head to the preview computer; record bundle SHA, installed version, service health, and API schema results in `specs/107-agent-runtime-config/verification.md`
- [ ] T087 Verify Canvas Agent settings and OpenClaw absent, auth-required, healthy switch, rollback, and Chat-continuity cases on preview in `specs/107-agent-runtime-config/verification.md`
- [ ] T088 Update public-safe runtime configuration and troubleshooting documentation in `docs/dev/agent-runtime-configuration.md` and run the repository documentation sync workflow
- [ ] T089 Submit/update the full Graphite stack and report PR order, exact SHAs, file/addition counts, test counts, CI/Greptile state, bundle/deploy evidence, and deferred scope in `specs/107-agent-runtime-config/verification.md`

---

## Dependencies and Execution Order

### Phase Dependencies

- **Phase 1**: No dependency; spec/spike gate.
- **Phase 2**: Depends on the reviewed spec contract; blocks unified backend and UI, but not independent gaps.
- **Phase 3**: Per-message override and system-info PRs may start after Phase 1 and land before Phase 2.
- **Phase 4**: Depends on Phase 2; Hermes-only/Chat catalog provides an independently useful increment.
- **Phase 5**: Depends on Phase 2 and the additive settings service in Phase 4.
- **Phase 6**: Depends on Phase 4; runtime picker activation behavior additionally depends on Phase 5.
- **Phase 7**: Conversation PR may start after Phase 1; final compatibility fixture depends on Phase 2.
- **Phase 8**: Per-PR gates run continuously; full preview scenarios depend on desired stack layers.

### User Story Dependencies

- **US1**: Independent of messaging runtime; only current kernel/gateway.
- **US2**: Depends on shared contracts; independently useful with Chat + Hermes.
- **US3**: Depends on shared contracts and provider normalization; does not depend on shell UI.
- **US4**: Depends on current unified backend; web and desktop PRs are separate and may be implemented in parallel worktrees.
- **US5**: Transcript/system-info subparts are independent; extended schema adoption depends on shared contracts.

### Within Each Story

- Tests are written and observed failing before production edits.
- Schemas precede services; services precede route/UI wiring.
- External calls remain outside filesystem critical sections except the bounded runtime transition controller, which holds only its exclusive transition lock and has a hard deadline.
- A story checkpoint is completed before its PR is declared ready for review.

## Parallel Opportunities

- T012–T014 are independent focused tests; T023–T025 are independent focused tests.
- T035–T039 cover distinct runtime/host/permission modules and can run in separate worktrees after shared contracts.
- T053–T058 split web, desktop, and IPC tests; the web and desktop Graphite layers can be built in parallel on the same backend parent.
- The independent transcript PR (T069–T073) can proceed while shared contract work is reviewed.
- Mechanical gates that do not mutate source (T078–T081) can run concurrently when host resources allow.

## Parallel Example: User Story 4

```text
Worktree A: T053–T055, then T060–T063 for web Canvas.
Worktree B: T056–T058, then T064–T066 for desktop and trusted IPC.
Both stack on the same unified-backend parent and remain separate PRs.
```

## Graphite Stack Plan

1. **Stack 1** — T001–T005: `docs(agent): specify unified runtime configuration`.
2. **Stack 2** — T069–T073: `feat(gateway): expose stored conversation transcript`.
3. **Stack 3** — T012–T013 and T016–T019/T021: `feat(kernel): support per-message model and effort`.
4. **Stack 4** — T014/T020/T021: `fix(gateway): report active kernel model`.
5. **Stack 5** — T006–T011: `feat(contracts): define agent runtime configuration`.
6. **Stack 6** — T023–T034: `feat(gateway): unify agent configuration`.
7. **Stack 7** — T038/T045–T049: `feat(runtime): provision OpenClaw gateway`.
8. **Stack 8** — T035–T037/T039/T041–T044/T050–T052: `feat(runtime): select messaging runtime safely`.
9. **Stack 9** — T053–T055/T060–T063/T067–T068: `feat(shell): add Agent runtime settings`.
10. **Stack 10** — T056–T058/T064–T068: `feat(desktop): extend Agent runtime settings`.
11. **Final diagnostics and evidence updates** — T075–T089 amend the relevant backend layer for diagnostics/performance, then land documentation-only verification evidence separately; do not mix functional fixes into evidence-only commits.

Each layer targets under 1,000 additions/20 files and must remain below 3,000 additions/50 files. If Stack 8 approaches the target, split adapter RPC from transition/delivery without weakening independent tests.

## Implementation Strategy

### MVP First

1. Land the three independent backend gaps (transcript, per-message override, system-info model).
2. Land shared schemas.
3. Land additive Agent settings with current Chat + Hermes provider state.
4. Validate current clients before adding OpenClaw or UI.

### Incremental Delivery

- Each backend gap solves a current mobile/Chat problem independently.
- Shared contracts add no runtime behavior.
- Unified backend remains useful when OpenClaw is absent.
- OpenClaw service and safe switch are independently API-testable.
- Web Canvas and desktop adopt the same stable backend in separate layers.
- Preview verification is repeated per risky layer, not postponed to the end.

## Format Validation

- All 89 tasks use `- [ ] TNNN` checklist format.
- Every user-story task includes `[US1]` through `[US5]`.
- `[P]` appears only where files and incomplete dependencies permit parallel work.
- Every task includes at least one exact repository file or spec path.
