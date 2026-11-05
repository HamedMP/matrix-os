# Tasks: Organization-wide Project Access

**Input**: Design documents from `/specs/2689-organization-project-access/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`
**Tracking**: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)

**Tests**: Mandatory. Every behavior task starts with a focused failing test that exercises production code and names the user-visible fault it detects.

**Organization**: Tasks are grouped by user story. The GitHub Stack Plan keeps the existing specification PR as layer 1 and adds four implementation layers beneath the same ENG-29 ticket.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: May run in parallel because it changes different files and has no dependency on an incomplete task.
- **[Story]**: Maps the task to the corresponding user story in `spec.md`.
- Each task names the production or verification path it changes.

## Phase 1: Setup and Baseline

**Purpose**: Freeze the current behavior and establish a scoped test/validation baseline before changing authorization.

- [x] T001 Record current project collaboration test coverage and named fault gaps in `specs/2689-organization-project-access/tasks.md`
- [x] T002 Run the changed-area pattern baseline with `bun run check:patterns:diff` and record any pre-existing warnings in `specs/2689-organization-project-access/tasks.md`
- [x] T003 Verify the implementation worktree ignore/config setup without changing unrelated repository files in `.gitignore`, `eslint.config.*`, and `.prettierignore`

---

## Phase 2: Foundational Project-access Contract

**Purpose**: Establish one role-free project access contract and one membership-derived authorization decision used by every later story.

**Critical**: Complete this phase before user-story implementation.

- [x] T004 [P] Add failing role-free projection and forbidden legacy-field contract tests in `tests/contracts/collaboration-capabilities.test.ts`
- [x] T005 [P] Add failing membership-only project authorization, owner-private access, archived narrowing, and outsider-denial tests in `tests/gateway/collaboration-capabilities-postgres.test.ts`
- [x] T006 [P] Add failing compatibility tests proving standalone resource grants retain their existing behavior in `tests/gateway/collaboration-standalone-scope-postgres.test.ts`
- [x] T007 Define the `organization_full_access` project projection and contributor action contract without role, grant, activation, or AI-policy fields in `packages/contracts/src/collaboration-capabilities.ts` and `packages/contracts/src/collaboration.ts`
- [x] T008 Implement the shared-project membership decision using fresh owner and actor organization evidence while preserving owner-private access in `packages/gateway/src/collaboration/capability-evaluator.ts`
- [x] T009 Route inherited project resources through the same project decision and lifecycle narrowing in `packages/gateway/src/collaboration/authority.ts` and `packages/gateway/src/collaboration/capability-evaluator.ts`
- [x] T010 Preserve standalone grant semantics while making historical project grants and activations non-authoritative in `packages/gateway/src/collaboration/capability-evaluator.ts` and `packages/gateway/src/collaboration/capability-routes.ts`

**Checkpoint**: A project access decision is derived solely from project ownership/lifecycle and fresh owner/requester organization membership; standalone sharing is unchanged.

---

## Phase 3: User Story 1 — Share Once With the Organization (Priority: P1) 🎯 MVP

**Goal**: The owner shares one project with one organization in one confirmation and every active current/future member can discover it without grants or acceptance.

**Independent Test**: Share a private project, open it as two active members without invitation/activation, add a future member, and verify all receive the same role-free project access projection.

### Tests for User Story 1

- [x] T011 [P] [US1] Add failing transition tests proving project share creates no serving grant or execution policy in `tests/gateway/collaboration-project-transition.test.ts`
- [x] T012 [P] [US1] Add failing inventory tests proving current and future active members discover shared projects without activation in `tests/platform/collaboration-routes.test.ts`
- [x] T013 [P] [US1] Add failing UI tests for one organization confirmation and absence of roles, people, capabilities, provider/model, and acknowledgement controls in `tests/ui/collaboration-project-sharing.test.tsx`

### Implementation for User Story 1

- [x] T014 [US1] Publish/unshare projects from canonical scope organization/lifecycle state without creating project grants or execution policies in `packages/gateway/src/collaboration/project-sharing.ts` and `packages/gateway/src/collaboration/project-transition.ts`
- [x] T015 [US1] Derive project inventory visibility from fresh organization membership and scope lifecycle without activation in `packages/platform/src/collaboration/repository.ts`, `packages/platform/src/collaboration/routes.ts`, and `packages/platform/src/collaboration/ticket-issuer.ts`
- [x] T016 [US1] Reject project grant/preset/accept/decline and project execution-policy mutations with typed safe responses while retaining standalone routes in `packages/gateway/src/collaboration/capability-routes.ts` and `packages/gateway/src/collaboration/execution-policy-routes.ts`
- [x] T017 [US1] Replace project sharing controls with one organization share/unshare decision and role-free explanatory copy in `packages/ui/src/collaboration/ProjectSharingDialog.tsx`, `packages/ui/src/collaboration/ProjectSharingButton.tsx`, and `packages/ui/src/collaboration/useProjectSharing.tsx`
- [x] T018 [US1] Remove project-flow rendering of `ProjectAccessManager` and `ContributorAiSettings` while preserving standalone compatibility consumers in `packages/ui/src/collaboration/SharedProjectView.tsx` and `packages/ui/src/collaboration/ChatCollaboratorsDialog.tsx`

**Checkpoint**: Sharing is one owner decision; current and future active members see and open the project with no individual configuration.

---

## Phase 4: User Story 2 — Work Freely Inside the Shared Project (Priority: P1)

**Goal**: An active member can use current/future project Chats, content, tools, apps, terminals, and Git within the project boundary, but cannot reach owner administration or unrelated data.

**Independent Test**: As a non-owner member, exercise chat, content, app/tool, terminal, and Git paths; reload/reconnect and verify persistence; verify owner-only and unrelated-owner resources remain denied.

### Tests for User Story 2

- [x] T019 [P] [US2] Add failing route/broker matrix tests for Chat, files, apps, layout, terminal, Git, and WebSocket membership authorization across `tests/gateway/collaboration-project-viewer.test.ts`, `tests/gateway/collaboration-project-apps.test.ts`, `tests/gateway/collaboration-project-layout.test.ts`, and `tests/gateway/collaboration-terminal-sandbox.test.ts`
- [x] T020 [P] [US2] Add owner-only administration coverage for share/unshare, whole-project delete, Provider Settings/billing isolation, and organization-policy independence in `tests/gateway/collaboration-authority.test.ts`, `tests/gateway/collaboration-project-sharing.test.ts`, and `tests/gateway/shared-project-deletion.test.ts`
- [x] T021 [P] [US2] Retain persistence/reconnect coverage for canonical project Chat history and project mutations in `tests/gateway/collaboration-project-chat-assignment.test.ts` and `tests/gateway/collaboration-project-integration.test.ts`

### Implementation for User Story 2

- [x] T022 [US2] Apply the central project work decision to shared Chat admission and transactional history paths in `packages/gateway/src/collaboration/shared-chat-authority.ts`, `packages/gateway/src/collaboration/project-chat-routes.ts`, and `packages/gateway/src/collaboration/chat-execution-adapter.ts`
- [x] T023 [US2] Apply the same decision to project files/apps/layout/terminal/Git brokers without expanding the project path boundary in `packages/gateway/src/collaboration/project-adapters.ts`, `packages/gateway/src/collaboration/project-app-adapter.ts`, `packages/gateway/src/collaboration/project-layout-adapter.ts`, `packages/gateway/src/collaboration/terminal-dispatcher.ts`, and `packages/gateway/src/collaboration/project-git-broker.ts`
- [x] T024 [US2] Keep share/unshare, whole-project deletion, and owner Provider Settings/billing behind explicit owner checks and organization membership administration behind organization policy in `packages/gateway/src/collaboration/authority.ts`, `packages/gateway/src/collaboration/owner-project-deletion.ts`, and `packages/gateway/src/collaboration/project-routes.ts`
- [x] T025 [US2] Present the same bounded member work state in Web Canvas/Web Desktop/Electron shared project rendering in `packages/ui/src/collaboration/SharedProjectView.tsx` and the shared shell integration

**Checkpoint**: Members can complete normal project work through every supported broker while administrative and owner-home boundaries remain closed.

---

## Phase 5: User Story 3 — Use the Owner's Current AI Connection (Priority: P1)

**Goal**: Every member AI request resolves only the owner's current ready Provider Settings V3 route at admission/dispatch, binds exact provenance for that run, and never falls back.

**Independent Test**: Run a member prompt on route A, switch the owner to route B, run another prompt, then remove readiness and prove later work makes no provider request and uses no alternate funding source.

### Tests for User Story 3

- [x] T026 [P] [US3] Add failing exact-current-route and no-fallback tests using the real Provider Settings projection in `tests/gateway/shared-ai-eligibility.test.ts`
- [x] T027 [P] [US3] Add failing admission/dispatch race, immutable run binding, and owner-route-change fencing tests in `tests/gateway/shared-ai-runtime.test.ts`
- [x] T028 [P] [US3] Add failing credential/error non-disclosure contract tests in `tests/integration/collaboration-provider-boundaries.integration.ts`

### Implementation for User Story 3

- [x] T029 [US3] Resolve the exact owner `active` provider instance/access source/model tuple from Provider Settings V3 on every shared-project admission in `packages/gateway/src/collaboration/shared-run-owner-source.ts` and the bounded refreshed snapshot source in `packages/gateway/src/collaboration/wiring.ts`
- [x] T030 [US3] Verify the exact tuple again at queue claim, dispatch, and broker credential resolution without fallback in `packages/gateway/src/chat/queue-repository.ts`, `packages/gateway/src/collaboration/shared-ai-runtime.ts`, and `packages/gateway/src/collaboration/shared-ai-runtime-registry.ts`
- [x] T031 [US3] Persist immutable per-run route provenance and settings/credential generation without turning it into reusable project policy in `packages/gateway/src/collaboration/run-account-binding.ts` and `packages/gateway/src/collaboration/shared-ai-runtime.ts`
- [x] T032 [US3] Fence queued/active member work when the owner disconnects, disables, replaces, or changes the active route in `packages/gateway/src/collaboration/revocation-enforcer.ts`, `packages/gateway/src/collaboration/shared-ai-runtime.ts`, and `packages/gateway/src/ai-providers/provider-settings-mutations.ts`

**Checkpoint**: Shared AI follows the owner's current global route exactly, records what each run used, and fails closed without fallback or credential disclosure.

---

## Phase 6: User Story 4 — Revoke Access With One Boundary (Priority: P2)

**Goal**: Unsharing or loss of requester/owner active membership denies new non-owner work and drains stale sessions while leaving the owner's private project intact.

**Independent Test**: Remove a member, remove the owner from the selected organization, and unshare during open project/AI/terminal sessions; verify the next operation is denied, active work drains, and owner-private access survives.

### Tests for User Story 4

- [x] T033 [P] [US4] Add failing requester-removal, owner-removal, and unshare race tests across REST/WebSocket/terminal/AI in `tests/gateway/collaboration-membership-races.test.ts`
- [x] T034 [P] [US4] Add failing owner-private preservation and explicit eligible re-share tests in `tests/gateway/collaboration-project-lifecycle.test.ts`

### Implementation for User Story 4

- [x] T035 [US4] Advance canonical authority fences and drain affected non-owner sessions/runs on unshare or requester/owner membership loss in `packages/gateway/src/collaboration/revocation-enforcer.ts`, `packages/gateway/src/collaboration/project-membership-transition.ts`, and `packages/gateway/src/collaboration/project-fence.ts`
- [x] T036 [US4] Preserve owner-private project access and require a new explicit eligible-organization share before member access resumes in `packages/gateway/src/collaboration/project-lifecycle.ts` and `packages/gateway/src/collaboration/project-sharing.ts`

**Checkpoint**: The next authoritative operation after revocation is denied for non-owners, stale sessions drain, and no owner data is lost.

---

## Phase 7: Polish, Qualification, and Documentation

**Purpose**: Prove the complete journey, record exact evidence, and document the shipped behavior.

- [x] T037 Add/extend the deterministic owner/member/outsider end-to-end journey in `tests/e2e/collaboration-project.spec.ts` with required assertions that cannot silently skip
- [x] T038 Run focused contract/gateway/UI suites and touched-module coverage; record commands and red/green evidence in `specs/2689-organization-project-access/tasks.md`
- [x] T039 Run `bun run typecheck`, `bun run check:patterns:diff`, `bun run test`, and applicable E2E lanes; record any environment-limited lane exactly in `specs/2689-organization-project-access/tasks.md`
- [ ] T040 Capture exact-build live evidence for Web Canvas, Web Desktop, and Electron Desktop, attach it to the implementation PR, post it with ENG-29 and stack links in Slack `#tech`, and link the Slack permalink in the PR
- [ ] T041 Update the spec/quickstart with implementation deviations and final verification links in `specs/2689-organization-project-access/spec.md` and `specs/2689-organization-project-access/quickstart.md`
- [ ] T042 Create the required public documentation PR in the private `FinnaAI/matrix-os-site` repository under `content/docs/` and link it from ENG-29 and the implementation stack

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: Starts immediately on the implementation branch.
- **Phase 2**: Depends on Phase 1 and blocks every user story.
- **US1**: Depends on Phase 2 and establishes the share/inventory path.
- **US2**: Depends on Phase 2 and the US1 project projection/inventory contract.
- **US3**: Depends on Phase 2; integrates with the US2 Chat admission path but remains independently testable through shared-AI suites.
- **US4**: Depends on the central access decision plus US2/US3 session registries so one revocation boundary drains every path.
- **Phase 7**: Depends on all selected user stories.

### User Story Dependencies

```text
Foundation
   └── US1 Share/inventory
         ├── US2 Bounded project work
         │     └── US4 Revocation/drain
         └── US3 Current owner AI route
               └── US4 Revocation/drain
```

### Within Each User Story

- Write the listed tests first and verify they fail for the intended missing behavior.
- Implement only enough production behavior to make those tests pass.
- Refactor after green while retaining the real producer/consumer and PostgreSQL boundaries.
- Mark tasks complete only after the named validation has run.

### Parallel Opportunities

- T004–T006 may be written in parallel because they cover separate suites.
- T011–T013, T019–T021, T026–T028, and T033–T034 are parallel test-writing groups.
- Contract, gateway, and UI verification in Phase 7 may run concurrently once implementation is frozen.

## GitHub Stack Plan

Use one GitHub native stack, one ENG-29 ticket, and no more than these five layers:

1. **Layer 1 — Specification**: existing PR #3124 (`codex/eng-29-shared-codex-subscription`).
2. **Layer 2 — Project access foundation and sharing**: Phases 1–3 (T001–T018), including role-free contracts, membership-derived authorization, inventory, and simplified share UI.
3. **Layer 3 — Bounded project work**: Phase 4 (T019–T025), including every project broker and owner/admin boundary.
4. **Layer 4 — Current owner AI route**: Phase 5 (T026–T032), including exact Provider Settings resolution, run binding, and no-fallback fencing.
5. **Layer 5 — Revocation and qualification**: Phases 6–7 (T033–T042), including cross-path drains, E2E, live surface evidence, and documentation links.

Each layer must stay below 1000 additions and 20 files where possible and must never exceed 3000 additions or 50 files. Publish with `gh stack submit`; keep new layers draft until their exact head has Greptile 5/5, then run full CI. The separate public-docs PR is required because it lives in another repository and is linked as an external deliverable rather than flattened into this repository's native stack.

## Implementation Strategy

### MVP First

1. Complete Phases 1–2.
2. Complete US1 and prove organization-wide discovery without grants.
3. Publish stack layer 2 as a draft checkpoint.
4. Add bounded work, AI, and revocation layers incrementally without rewriting reviewed lower layers.

### Completion Rule

The feature is complete only when all T001–T042 tasks are checked, focused and broad validation is recorded, every stack layer has current-head Greptile 5/5 and passing CI, live evidence exists for all three affected surfaces, and ENG-29 plus every PR links the full stack and evidence.

## Execution Record

- Coverage baseline (T001): existing contract and PostgreSQL suites protect grant/activation behavior, membership failure, archived/lifecycle behavior, project transitions, and standalone compatibility. Named gaps are the new role-free project projection, fresh membership for both owner and actor, automatic future-member discovery without activation, project-route rejection of legacy grant/policy mutations, exact Provider Settings V3 routing, and cross-path owner-departure drains.
- Pattern baseline (T002): `bun run check:patterns:diff` completed with 0 violations and 5 warning categories. Reported paths are pre-existing/outside this feature's scoped files; changed collaboration files will be re-scanned before each layer is published.
- Ignore/config verification (T003): repository `.gitignore` already covers Node, build, environment, log, coverage, editor, and worktree artifacts; `.dockerignore` covers dependency/build/environment/test inputs; ESLint config is intentionally scoped to `shell/` and `apps/mobile/`; no repository Prettier configuration exists, so no new ignore file is required.
- Red/green evidence (foundation/US1): the role-free contract first failed because the legacy schema required role/general-access/people fields; membership authorization first failed on grant/activation and owner-membership ordering; sharing first emitted a default project grant; current/future member discovery returned no items; the project dialog exposed people, roles, activation and AI policy; grantless root/inherited tickets were denied; unshare had no service or UI action; shared-project rendering still showed Viewer/Editor. The corresponding focused contract, gateway, platform, UI and shell suites are green after central membership authorization, grantless discovery/tickets, canonical lifecycle publication/unshare, and role-free UI changes.
- Validation commands and results (foundation/US1): `bunx vitest run tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-direct.test.ts tests/gateway/collaboration-capabilities-postgres.test.ts tests/gateway/collaboration-standalone-scope-postgres.test.ts tests/gateway/collaboration-project-transition.test.ts tests/gateway/collaboration-capability-routes.test.ts tests/gateway/collaboration-owner-source.test.ts` passed 149 tests with 5 repository skips; route/member/private-grant/readiness/foundation batch passed 21 tests; project/UI rendering batch passed 56 tests. Full typecheck and repository-wide test results are recorded before publishing layer 2.
- Layer 2 qualification: `bun run typecheck` passed; `bun run check:patterns:diff` reported 0 violations and the same 5 repository-wide warning categories. A bounded project/platform/UI sweep passed 453 tests with 44 expected skips after correcting four obsolete role/grant expectations; the three remaining ticket-control tests are environment-limited because this sandbox rejects `listen(127.0.0.1)` with `EPERM`. `bun run test` was attempted, but the macOS temp/data volume reached `ENOSPC`; Vitest then reported thousands of files as zero-test worker failures, while the pre-exhaustion failures were unrelated environment cases (blocked sockets, GPG temp access, BSD/GNU `date`, and protected temp ancestors). This is not recorded as a passing repository-wide lane.
- Red/green evidence (US2): historical Viewer rows first blocked app and layout writes after the central organization decision had allowed them; inherited host-shell terminals first required a separate owner opt-in; and the shared Chat transaction fence first re-read historical grants. Focused tests failed on those exact paths, then passed after each broker accepted the fresh project decision while retaining scope/binding/epoch fences and standalone behavior.
- Layer 3 qualification: the focused broker and owner-boundary matrix passed 105 tests with 1 expected skip. The complete gateway project family passed 183 tests with 2 expected skips; the only excluded/failing file was the unrelated real Git-driver fixture, where all 7 cases were blocked by sandboxed GPG keybox/temp-file access before the driver assertions ran. `bun run typecheck` passed, `bun run check:patterns:diff` reported 0 violations with the same 5 repository-wide warning categories, and `git diff --check` passed.
- Red/green evidence (US3): the initial exact-route tests failed in three places because no Provider Settings `active` tuple resolver or route-generation fence existed. The implementation now resolves only the exact ready active instance/source/model tuple, replaces inherited-project Chat bindings at admission, rechecks that tuple at dispatch and broker authorization, persists immutable settings revision plus route generation, and drains shared runtimes before an authority-changing Provider Settings mutation. Historical standalone execution policies retain their prior path.
- Layer 4 qualification: the focused owner-source/runtime/coding/provider-store/terminal/foundation/Slack/provider-boundary matrix passed 170 tests with 2 expected skips; the final adapter regression rerun passed 41 tests with 1 expected skip. Migration and organization-derived wiring assertions passed independently. `bun run typecheck` passed, `bun run check:patterns:diff` reported 0 violations with the same 5 repository-wide warning categories, and `git diff --check` passed. A wider 15-file sweep before the expectation fixes passed 244 tests with 11 expected skips; its remaining 10 failures were environment-limited Unix-socket `listen EPERM` cases under the sandbox temp directory, while every product regression from that sweep was corrected and rerun green.
- Red/green evidence (US4): the new race tests first failed because there was no project-level revocation coordinator and unshare did not invoke a post-commit drain. The implementation now advances the existing session fence, closes project and inherited REST/WebSocket/terminal access, stops matching sandboxes and shared-AI runs, distinguishes requester removal from owner removal, preserves the owner's private project, and requires an explicit eligible re-share. The red batch failed 3 assertions for those missing paths; its green rerun passed 7 tests with 4 real-PostgreSQL skips.
- Layer 5 focused qualification: the complete contract/gateway/UI/platform collaboration regression lane passed 217 tests with 6 expected repository skips. The revocation-specific event/terminal/sandbox/runtime suite passed 95 tests with 5 expected skips, the control/broker/sandbox callback suite passed 17 tests, and the actor-specific interruption plus private-preservation/re-share cases passed. The deterministic E2E fixture suite passed 2 tests, and the exact Playwright CLI discovered both required owner/member/outsider journeys without conditional skips.
- Touched-module coverage (T038): the narrowed V8 run executed 200 tests successfully with 5 expected skips. The report covered the new revocation coordinator at 94.37% lines/92.5% functions, the shared-AI registry at 100% lines/functions, and the loss coordinator at 97% lines/93.1% functions. Vitest exited non-zero because a deliberately narrowed set cannot satisfy the repository-wide 99% global threshold (73.83% lines, 72.56% functions, 69.88% statements, 57.36% branches across all included legacy modules); this is recorded as executed coverage, not a passing global-coverage lane.
- Final repository gates (T039): `bun run typecheck` passed; `bun run check:patterns:diff` reported 0 violations and the same 5 repository-wide warning categories; `git diff --check` passed. `bun run test` was attempted and the feature-focused collaboration assertions completed, but unrelated real-socket/HTTP, GPG/temp, protected-path, CLI and build fixtures failed or timed out under the sandbox. The run consumed the remaining data-volume capacity (about 102 MiB free), began reporting zero-test worker files, and was stopped with exit 130 to avoid filling the host; it is not a passing lane. Live Playwright execution is blocked because `MATRIX_COLLABORATION_E2E_OWNER_STATE`, `MATRIX_COLLABORATION_E2E_MEMBER_STATE`, and `MATRIX_COLLABORATION_E2E_OUTSIDER_STATE` are not configured; no required assertion is skipped.
- Live evidence and Slack permalink: pending T040.
