# Tasks: Native Collaboration UX Redesign

**Input**: Design documents in `specs/525-collaboration-ux-redesign/`  
**Prerequisites**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/collaboration-ux-api.md](contracts/collaboration-ux-api.md), [quickstart.md](quickstart.md)

**TDD rule**: Every test task below is completed and observed failing for the intended reason before its paired implementation task begins. Record red/green commands and results in `specs/525-collaboration-ux-redesign/implementation-log.md`.

## Phase 1: Setup and Confirmation

**Purpose**: Freeze the approved interaction model, current-main evidence, and delivery boundaries before production edits.

- [x] T001 Record the user's interaction-model confirmation and any approved refinements in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [x] T002 Record baseline commit, current-UI Playwright result, screenshot paths, and dirty-original-worktree protection in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [x] T003 Record the five-layer Graphite stack names, base relationships, PR size checks, and no-merge-without-approval gate in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [x] T004 [P] Add a reusable evidence manifest for Canvas, responsive web, Electron, and mobile captures in `specs/525-collaboration-ux-redesign/evidence/README.md`

---

## Phase 2: Foundational Contract Gaps (Stack PR 1)

**Purpose**: Add only the invite-decline and scope-discussion capabilities required by every client, behind the existing collaboration authority.

**⚠️ CRITICAL**: Complete this phase before user-story UI work.

### Failing tests

- [ ] T005 [P] Add failing strict Zod tests for invitation decline, discussion message/page, and discussion user-state contracts in `tests/contracts/collaboration.test.ts`
- [ ] T006 [P] Add failing database-bootstrap tests for terminal discussion messages, per-actor read state, constraints, authoritative deletion, bounded export inclusion, and idempotent migration in `tests/gateway/collaboration-database.test.ts`
- [ ] T007 [P] Add failing invitee-decline repository tests for target-only authorization inputs, revision races, expiry, audit, idempotency, and outbox state in `tests/gateway/collaboration-repository.test.ts` and `tests/gateway/collaboration-repository-postgres.test.ts`
- [ ] T008 [P] Add failing discussion adapter tests proving Chat uses a database-filtered bounded `purpose=discussion` query, terminal notes stay scope-local, terminal messages export, and personal read state does not export in `tests/gateway/collaboration-chat-discussion.test.ts` and `tests/gateway/collaboration-terminal-discussion.test.ts`
- [ ] T009 [P] Add failing route/lifecycle tests for decline and discussion owner/editor/viewer/pending/revoked matrices, body limits, exact queries, stale revisions, export/delete/retry behavior, and generic errors in `tests/gateway/collaboration-routes.test.ts` and `tests/gateway/collaboration-lifecycle.test.ts`
- [ ] T010 [P] Add failing platform tests for exact proxy allowlists, proof method/path/body binding, feature modes, directory invalidation, and snapshot-token rejection in `tests/platform/collaboration-proxy.test.ts`, `tests/platform/collaboration-proof.test.ts`, and `tests/platform/collaboration-routes.test.ts`
- [ ] T011 [P] Add failing startup/shutdown wiring and CLI exact-path tests in `tests/gateway/collaboration-wiring.test.ts`, `tests/platform/collaboration-wiring.test.ts`, and `tests/cli/collaboration-terminal.test.ts`

### Implementation

- [ ] T012 Implement Zod 4 decline/discussion request and response schemas with bounded UTF-8 text and inferred types in `packages/contracts/src/collaboration.ts`
- [ ] T013 Implement additive terminal discussion and discussion-user-state tables, indexes, Kysely types, authoritative deletion behavior, and idempotent bootstrap in `packages/gateway/src/collaboration/database.ts`
- [ ] T014 Implement pending-to-revoked invitee decline with scope/member locks, write-enforced revision, idempotency, audit, event, and outbox in `packages/gateway/src/collaboration/repository.ts`
- [ ] T015 Implement a scope-kind discussion adapter with bounded database-filtered Chat reads, terminal storage, bounded terminal export projection, and personal-state exclusion in `packages/gateway/src/collaboration/discussion-adapter.ts`
- [ ] T016 Register exact decline and discussion routes with existing authorization actions, body limits, query parsing, and safe error mapping in `packages/gateway/src/collaboration/routes.ts`
- [ ] T017 Extend dependency injection and event notification for the discussion adapter without adding pool/timer ownership in `packages/gateway/src/collaboration/wiring.ts`
- [ ] T018 Extend only exact invitation/discussion proxy patterns and milestone classification in `packages/platform/src/collaboration/proxy.ts`
- [ ] T019 Update invited-directory reconciliation after decline without storing content or adding authority in `packages/platform/src/collaboration/repository.ts` and `packages/platform/src/collaboration/routes.ts`
- [ ] T020 Extend the CLI collaboration path allowlist and typed decline/discussion commands in `packages/sync-client/src/cli/commands/collaboration.ts`
- [ ] T021 Run all Phase 2 red-to-green suites and record commands, results, backend invariants, diff-size check, and Stack PR 1 evidence in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: The additive backend is independently usable by old and new clients; existing Chat discussion/history, membership, queue, terminal control, and snapshots remain unchanged.

---

## Phase 3: User Story 1 — Collaborate in an Ordinary Chat (Priority: P1, Stack PR 2)

**Goal**: Open a shared Chat in the normal Chat app, use the ordinary composer for AI, render attributed human prompts on the right and AI output on the left, and reveal queue information only when useful.

**Independent Test**: In Canvas with two authorized accounts, both submit through the ordinary composer, receive normal AI rendering, see correct subtle human attribution, and never see a duplicate shared header or Discussion/Ask AI switch.

### Failing tests

- [ ] T022 [P] [US1] Add failing projection tests that exclude discussion from the main timeline while preserving AI requests, assistant/tool/system parts, actor attribution, and safe unknown authors in `tests/ui/shared-chat-two-account.test.tsx`
- [ ] T023 [P] [US1] Add failing normal-Chat integration tests for owner/editor submit, viewer read-only behavior, private drafts, compact queue thresholds, and unavailable/revoked frame stability in `tests/shell/shared-chat-app-integration.test.tsx`
- [ ] T024 [P] [US1] Add failing native-route tests proving shared Chat deep links select the normal Chat session and never mount standalone collaboration content in `tests/shell/shared-chat-deep-link.test.tsx` and `tests/shell/shared-chat-route-sync.test.tsx`
- [ ] T025 [P] [US1] Replace the current Canvas expectation with a failing Playwright journey for native Chat appearance, two-account attribution, ordinary composer, and queue disclosure in `shell/e2e/shared-chat.spec.ts`

### Implementation

- [ ] T026 [P] [US1] Extract a serializable shared-session projection and stable selectors from the legacy renderer in `packages/ui/src/collaboration/useCollaborationSession.ts` and `packages/ui/src/collaboration/chat-projection.ts`
- [ ] T027 [US1] Adapt canonical shared messages into the existing normal Chat message model without copying history in `shell/src/hooks/useCanonicalChatState.ts`
- [ ] T028 [US1] Integrate collaboration context into the ordinary Chat timeline/header instead of rendering `ChatCollaboration` in `shell/src/components/ChatApp.tsx` and `shell/src/components/chat/ShellChatCollaboration.tsx`
- [ ] T029 [US1] Route the ordinary owner/editor composer to existing shared AI requests and make viewer/unavailable states explicitly read-only in `shell/src/components/chat/ChatInput.tsx` and `shell/src/components/ChatApp.tsx`
- [ ] T030 [P] [US1] Add subtle accessible author name/avatar presentation for committed human prompts while retaining existing AI/tool/approval renderers in `shell/src/components/ChatApp.tsx` and `packages/ui/src/collaboration/ParticipantAttribution.tsx`
- [ ] T031 [P] [US1] Refactor queue presentation into hidden, compact, and expanded states driven by existing queue data in `shell/src/components/chat/ChatQueuedRequests.tsx`
- [ ] T032 [US1] Normalize `/shared/chat/:scopeId` into the native Chat selection while preserving safe revoked/unavailable states in `shell/src/app/shared/chat/[scopeId]/page.tsx` and `shell/src/components/ShellHome.tsx`
- [ ] T033 [US1] Remove the shared-mode header/title and mode-switch entry path while retaining a compatibility adapter for old clients in `packages/ui/src/collaboration/ChatCollaboration.tsx` and `packages/ui/src/collaboration/SharedChatControls.tsx`
- [ ] T034 [US1] Run the US1 component, shell-route, and Canvas Playwright suites and record red/green results in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T035 [US1] Capture current-head Canvas screenshots/recording for unshared parity, two-account native Chat, attribution, viewer, queue, revoked, and unavailable states in `specs/525-collaboration-ux-redesign/evidence/canvas-chat/README.md`
- [ ] T036 [US1] Run shell and shared-UI typechecks, pattern scan, react-doctor, and Stack PR 2 diff-size/PR gates, recording results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: User Story 1 is independently complete in Canvas and responsive web; shared Chat now looks and behaves like ordinary Chat.

---

## Phase 4: User Story 2 — Discuss Without Replacing the Session (Priority: P1, Stack PR 3)

**Goal**: Provide a human-only overlay drawer/bottom sheet with private drafts, unread state, light dismiss, Escape, and viewer-safe read-only behavior.

**Independent Test**: Open discussion over a shared Chat, exchange notes between two accounts, preserve separate drafts, dismiss every supported way, and prove the underlying session dimensions and AI queue never change.

### Failing tests

- [ ] T037 [P] [US2] Add failing accessibility and responsive tests for overlay geometry, focus containment/return, Escape, light dismiss, reduced motion, unread announcement, and viewer read-only behavior in `tests/ui/session-discussion-layer.test.tsx`
- [ ] T038 [P] [US2] Add failing draft tests proving prompt/discussion separation, author/scope isolation, close/reopen persistence, bounded storage, and parse-failure recovery in `tests/ui/collaboration-drafts.test.ts`
- [ ] T039 [P] [US2] Add failing two-account realtime tests proving notes never enter the AI timeline/queue and updates preserve the local draft in `tests/ui/shared-chat-two-account.test.tsx`
- [ ] T040 [P] [US2] Add failing shell tests proving the drawer overlays without layout shift and becomes a full-height sheet at mobile width in `tests/shell/shared-chat-app-integration.test.tsx`

### Implementation

- [ ] T041 [P] [US2] Implement the accessible desktop overlay drawer and responsive full-height bottom sheet primitive in `packages/ui/src/collaboration/SessionDiscussionLayer.tsx`
- [ ] T042 [P] [US2] Replace mode-bearing draft state with an independently keyed, serializable private discussion draft store in `packages/ui/src/collaboration/discussion-drafts.ts`
- [ ] T043 [US2] Implement bounded discussion loading, pagination, append, read-state, event refresh, safe errors, and viewer restrictions in `packages/ui/src/collaboration/useSessionDiscussion.ts`
- [ ] T044 [US2] Add the separate discussion trigger, restrained unread state, focus return, and polite announcements to normal Chat chrome in `shell/src/components/ChatApp.tsx`
- [ ] T045 [US2] Remove discussion/AI mode controls from the primary composer compatibility path in `packages/ui/src/collaboration/SharedChatControls.tsx` and `packages/ui/src/collaboration/chat-state.ts`
- [ ] T046 [US2] Add Canvas responsive Playwright coverage for no-layout-shift drawer, mobile sheet, draft privacy, keyboard dismissal, and human-only isolation in `shell/e2e/shared-chat.spec.ts`
- [ ] T047 [US2] Capture current-head Canvas desktop/mobile discussion evidence in `specs/525-collaboration-ux-redesign/evidence/canvas-discussion/README.md`
- [ ] T048 [US2] Run US2 targeted tests, accessibility checks, typecheck, and react-doctor and record results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: Chat discussion is independently usable without replacing, resizing, or prompting the primary session.

---

## Phase 5: User Story 3 — Share and Manage Access from Session Chrome (Priority: P1, Stack PR 3)

**Goal**: Add one compact access summary, preserve snapshot/live distinction, and disclose owner management only at the second level.

**Independent Test**: Share an ordinary Chat, invite by supported identity, inspect owner/editor/viewer summaries, change role and revoke as owner, and verify feature-off/unshared sessions remain visually restrained.

### Failing tests

- [ ] T049 [P] [US3] Add failing access-summary tests for private/shared state, current role, owner/member avatars, inherited scope, owner-only management, keyboard behavior, and safe errors in `tests/ui/session-access-control.test.tsx`
- [ ] T050 [P] [US3] Extend failing sharing tests for snapshot/live distinction, username/email validation, role changes, revocation races, and feature-off absence in `tests/ui/chat-collaboration-sharing.test.tsx`
- [ ] T051 [P] [US3] Add failing shell tests for restrained unshared/shared header chrome and zero layout shift in `tests/shell/shared-chat-app-integration.test.tsx`

### Implementation

- [ ] T052 [P] [US3] Implement compact access summary popover with stable member/avatar projection and accessible state in `packages/ui/src/collaboration/SessionAccessControl.tsx`
- [ ] T053 [US3] Refactor member invitation, role change, and revocation into the owner-only second-level manager in `packages/ui/src/collaboration/ChatCollaboratorsDialog.tsx`
- [ ] T054 [US3] Preserve distinct snapshot and live-invite explanations/actions from the access entry point in `packages/ui/src/collaboration/ShareChoiceDialog.tsx` and `packages/ui/src/chat/ChatSharingButton.tsx`
- [ ] T055 [US3] Integrate access summary into ordinary Chat chrome and hide live controls/data hooks when collaboration is off in `shell/src/components/chat/ChatSharing.tsx` and `shell/src/components/ChatApp.tsx`
- [ ] T056 [US3] Add safe generic client feedback and stale-action reconciliation for member mutations in `packages/ui/src/collaboration/ChatCollaboratorsDialog.tsx`
- [ ] T057 [US3] Capture Canvas access-summary, management, snapshot distinction, inherited access, and feature-off evidence in `specs/525-collaboration-ux-redesign/evidence/canvas-access/README.md`
- [ ] T058 [US3] Run US3 targeted tests, typecheck, react-doctor, and shared Stack PR 3 diff-size checks and record results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: Access is discoverable and complete without becoming a persistent collaboration dashboard.

---

## Phase 6: User Story 4 — Collaborate in an Ordinary Terminal (Priority: P1, Stack PR 4)

**Goal**: Keep the ordinary terminal dominant while adding compact access, discussion, role/controller status, and existing control actions.

**Independent Test**: In Canvas, attach owner/editor/viewer to one eligible shared terminal, exchange output and discussion, transfer/take over control, revoke, and verify delayed input/paste/resize rejection.

### Failing tests

- [ ] T059 [P] [US4] Add failing terminal-chrome tests for compact role/controller status, owner takeover, editor request/wait/release, viewer restrictions, ineligible-sharing preservation, and feature-off absence in `tests/shell/terminal-collaboration-controls.test.tsx`
- [ ] T060 [P] [US4] Add failing terminal discussion integration tests for overlay/no-reflow, two-account notes, private drafts, unread state, and zero input side effects in `tests/ui/shared-terminal-discussion.test.tsx`
- [ ] T061 [P] [US4] Extend failing authorization tests for delayed input, paste, resize, renew, and release after transfer/downgrade/revoke in `tests/gateway/collaboration-terminal-authorization.test.ts` and `tests/gateway/collaboration-terminal-control.test.ts`
- [ ] T062 [P] [US4] Add failing native shared-terminal route tests for Canvas normal-terminal selection, ineligible preflight leaving the process unchanged, and safe unavailable states in `tests/shell/shared-terminal-route.test.tsx`

### Implementation

- [ ] T063 [US4] Refactor shared terminal state/actions out of the standalone surface into a reusable controller hook in `packages/ui/src/collaboration/useSharedTerminalSession.ts`
- [ ] T064 [P] [US4] Implement compact controller/role status and capability-gated actions in `packages/ui/src/collaboration/TerminalCollaborationStatus.tsx`
- [ ] T065 [US4] Integrate access, discussion, and controller status into existing Canvas terminal chrome without altering viewport measurement in `shell/src/components/terminal/TerminalChrome.tsx` and `shell/src/components/terminal/TerminalApp.tsx`
- [ ] T066 [US4] Normalize legacy shared-terminal entry into the native Terminal app and keep revoked/unavailable results inside its frame in `shell/src/app/shared/terminal/[scopeId]/page.tsx` and `shell/src/components/ShellHome.tsx`
- [ ] T067 [US4] Retain the standalone terminal component only as a compatibility adapter over the native controller hook in `packages/ui/src/collaboration/SharedTerminalControls.tsx`
- [ ] T068 [US4] Verify authoritative rejection produces no optimistic input/control success in `packages/ui/src/collaboration/useSharedTerminalSession.ts` and `shell/src/components/terminal/TerminalApp.tsx`
- [ ] T069 [US4] Add Canvas terminal Playwright coverage for shared output, control handoff, discussion, viewer, revoke, ineligible sharing, and delayed input/paste/resize in `shell/e2e/shared-terminal.spec.ts`
- [ ] T070 [US4] Capture current-head Canvas terminal evidence in `specs/525-collaboration-ux-redesign/evidence/canvas-terminal/README.md`
- [ ] T071 [US4] Run US4 gateway/UI/shell tests, typecheck, react-doctor, and Stack PR 4 diff-size checks and record results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: Shared terminal collaboration is a compact extension of the ordinary terminal and retains all server-side control fencing.

---

## Phase 7: User Story 5 — Find Invitations and Shared Sessions (Priority: P1, Stack PR 4)

**Goal**: Put Shared with me and a bounded pending badge in Chat navigation, support accept/decline, and open accepted resources directly in native apps.

**Independent Test**: Invite one account to a Chat and terminal, see the Chat-sidebar badge, accept one and decline one, then open the accepted item directly in the ordinary app with polished empty/error/revoked/unavailable states.

### Failing tests

- [ ] T072 [P] [US5] Add failing discovery-view tests for pending-first pagination, metadata, capped badge, accept/decline, safe state variants, mutation refresh, and feature-off absence in `tests/ui/shared-with-me.test.tsx`
- [ ] T073 [P] [US5] Add failing Canvas sidebar tests for first-class row placement, keyboard selection, mobile drawer parity, and no separate app/dock entry in `tests/shell/shared-with-me-navigation.test.tsx`
- [ ] T074 [P] [US5] Add failing route tests proving accepted Chat/terminal and legacy links resolve into native apps across refresh and shell mode changes in `tests/shell/shared-chat-route-sync.test.tsx` and `tests/shell/shared-terminal-route.test.tsx`
- [ ] T075 [P] [US5] Add failing invitation UI tests for decline idempotency, conflict/expiry, immediate badge/list update, and safe generic failures in `tests/ui/chat-collaboration-sharing.test.tsx`

### Implementation

- [ ] T076 [P] [US5] Extract reusable pending/accepted discovery content and state variants from the standalone page in `packages/ui/src/collaboration/SharedWithMe.tsx`
- [ ] T077 [P] [US5] Implement a bounded invited-page badge hook and mutation/event invalidation without a second counter authority in `packages/ui/src/collaboration/useSharedWithMe.ts`
- [ ] T078 [US5] Add inline accept/decline actions and native open callbacks with safe optimistic reconciliation in `packages/ui/src/collaboration/SharedWithMe.tsx`
- [ ] T079 [US5] Add the first-class Shared with me row and capped badge before conversation groups in `shell/src/components/ChatApp.tsx`
- [ ] T080 [US5] Integrate Shared with me into responsive Chat navigation and remove the redundant account-menu-only entry in `shell/src/components/UserButton.tsx` and `shell/src/components/ChatApp.tsx`
- [ ] T081 [US5] Convert standalone home/invitation pages into compatibility resolvers/content hosted inside native Chat navigation in `shell/src/components/collaboration/CollaborationPage.tsx` and `shell/src/app/shared/invitations/[invitationId]/page.tsx`
- [ ] T082 [US5] Add Canvas Playwright coverage for badge, pending/accepted lists, accept/decline, native Chat/Terminal open, empty/error/revoked/unavailable, and feature-off in `shell/e2e/shared-with-me.spec.ts`
- [ ] T083 [US5] Capture current-head Canvas and responsive discovery/routing evidence in `specs/525-collaboration-ux-redesign/evidence/canvas-shared-with-me/README.md`
- [ ] T084 [US5] Run US5 targeted tests, typecheck, react-doctor, and shared Stack PR 4 PR gates and record results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: Invitations and accepted resources are discoverable without copied links and always enter a native app surface.

---

## Phase 8: User Story 6 — Preserve One Experience Across Surfaces (Priority: P2, Stack PR 5)

**Goal**: Bring the confirmed model to Web Desktop, Electron, responsive web, and supported mobile integration points with equivalent authority and adapted physical layout.

**Independent Test**: Repeat owner/editor/viewer/pending/revoked/unavailable journeys on every applicable surface and compare native routing, permissions, attribution, discussion, access, queue/controller, and feature-off outcomes.

### Failing tests

- [ ] T085 [P] [US6] Add failing Electron native shared-Chat, sidebar destination, badge, deep-link, attribution, discussion, and access tests in `tests/desktop/shared-chat-navigation.test.tsx` and `tests/desktop/shared-chat-surface.test.tsx`
- [ ] T086 [P] [US6] Add failing Electron shared-terminal chrome, discussion, controller, routing, and viewer tests in `tests/desktop/terminal-sharing-runtime.test.tsx` and `tests/desktop/terminals-tab.test.tsx`
- [ ] T087 [P] [US6] Add failing mobile request/draft tests for decline, discussion routes/read state, bounded badge data, and independent private drafts in `apps/mobile/__tests__/requests-collaboration.test.ts` and `apps/mobile/__tests__/collaboration-drafts.test.ts`
- [ ] T088 [P] [US6] Add failing mobile screen/navigation tests for Shared with me, native Chat/Terminal open, full-height discussion sheet, access summary, viewer/revoked/unavailable, and feature-off in `apps/mobile/__tests__/shared-screen.test.tsx` and `apps/mobile/__tests__/drawer-layout.test.tsx`

### Implementation

- [ ] T089 [US6] Integrate Shared with me into the Electron Chat work rail with capped badge and native selection in `desktop/src/renderer/src/features/work/WorkRail.tsx` and `desktop/src/renderer/src/features/work/work-rail-model.ts`
- [ ] T090 [US6] Integrate collaboration context, ordinary composer, attribution, compact queue, access, and discussion into the canonical Electron Chat workspace in `desktop/src/renderer/src/features/chat/CanonicalChatWorkspace.tsx`
- [ ] T091 [US6] Integrate access, discussion, and controller status into Electron terminal chrome without resizing the viewport in `desktop/src/renderer/src/features/terminal/TerminalsTab.tsx` and `desktop/src/renderer/src/features/terminal/TerminalSessionHeader.tsx`
- [ ] T092 [US6] Normalize Electron shared Chat/terminal/invitation links into native tabs and safe state frames in `desktop/src/renderer/src/features/desktop-shell/DesktopSurfaceFrame.tsx` and `desktop/src/renderer/src/features/work/work-navigation.ts`
- [ ] T093 [P] [US6] Add typed mobile decline/discussion requests and safe responses in `apps/mobile/lib/requests/collaboration.ts`
- [ ] T094 [P] [US6] Split mobile collaboration presentation into Shared with me content, native Chat context, and full-height discussion sheet in `apps/mobile/app/(drawer)/shared.tsx` and `apps/mobile/components/collaboration/SessionDiscussionSheet.tsx`
- [ ] T095 [US6] Preserve Shared with me as a feature-gated navigation drawer row with bounded badge and native resource navigation in `apps/mobile/components/shell/DrawerContent.tsx` and `apps/mobile/app/(drawer)/_layout.tsx`
- [ ] T096 [US6] Remove the mobile Discussion/AI composer mode and route the ordinary native Chat composer to shared AI for permitted roles in `apps/mobile/components/collaboration/SharedChatComposer.tsx` and `apps/mobile/app/(drawer)/shared.tsx`
- [ ] T097 [US6] Run Electron and mobile red-to-green suites and record parity results in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T098 [US6] Capture current-head Web Desktop, Electron, responsive web, and materially distinct mobile screenshots/recordings in `specs/525-collaboration-ux-redesign/evidence/cross-surface/README.md`
- [ ] T099 [US6] Run desktop/mobile typechecks, builds, pattern scans, react-doctor, and Stack PR 5 diff-size checks and record results in `specs/525-collaboration-ux-redesign/implementation-log.md`

**Checkpoint**: Every applicable surface shares one collaboration mental model and one authority while adapting only its physical presentation.

---

## Phase 9: Cross-Cutting Verification, Documentation, and PR Gates

**Purpose**: Prove the full story, publish accurate documentation, and bring every stack PR to review-ready without merging.

- [ ] T100 [P] Add/extend two-account realtime E2E for attributed prompts, AI output, notes, queue changes, roles, terminal controller changes, and revocation in `tests/e2e/collaboration-native-sessions.spec.ts`
- [ ] T101 [P] Add route/security regression coverage for feature-off, snapshot/live separation, no parent/sibling/owner-home access, and unavailable owner runtime in `tests/e2e/collaboration-native-sessions.spec.ts` and `tests/platform/collaboration-proof.test.ts`
- [ ] T102 Run the complete quickstart acceptance matrix and record exact commands, failures/fixes, timings, and evidence links in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T103 Run all required affected/full tests, typechecks, builds, pattern scan, and react-doctor checks and record final results in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T104 Audit every changed file against `AGENTS.md`, `.specify/memory/constitution.md`, and `specs/quality-gates.md`, recording any explicit deferrals with linked issues in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T105 Create the separate private `FinnaAI/matrix-os-site` documentation worktree/PR under `content/docs/` and record its URL and validation in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T106 Update each Graphite PR body with Conventional Commit title, source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, deferred scope, test results, and evidence links tracked in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T107 Run `$worktree-pr-monitor` for every stack PR, apply `ready-for-ci`, fix relevant CI failures, and record current-head Greptile 5/5 plus non-draft status in `specs/525-collaboration-ux-redesign/implementation-log.md`
- [ ] T108 Verify no PR is merged and record the explicit user-approval gate and final stacked PR order in `specs/525-collaboration-ux-redesign/implementation-log.md`

---

## Dependencies and Execution Order

### Phase dependencies

- Phase 1 blocks all production edits because user confirmation is mandatory.
- Phase 2 blocks all clients that consume decline or generic discussion.
- US1 (Phase 3) starts after Phase 2 and establishes the native Chat composition seam.
- US2 (Phase 4) depends on Phase 2 and consumes the native Chat chrome from US1 for Canvas integration.
- US3 (Phase 5) can build its shared component after Phase 2, but final Chat placement depends on US1.
- US4 (Phase 6) depends on Phase 2 and the shared layer primitives from US2/US3.
- US5 (Phase 7) follows US4 in the same stack layer so native terminal open acceptance uses the completed route normalization.
- US6 (Phase 8) depends on the relevant shared components and Canvas reference implementations from US1–US5.
- Phase 9 depends on all selected user stories.

### User-story graph

```text
Confirmation -> Foundation -> US1 Native Chat ----+----> US6 Cross-surface -> Final gates
                           -> US2 Discussion ------|
                           -> US3 Access ----------|
                           -> US4 Terminal --------|
                           -> US5 Discovery -------+
```

US2, US3, US4, and the component portion of US5 are independently testable after the foundation; their final native placement reuses US1/session chrome rather than duplicating it.

### Graphite stack plan

1. **Stack PR 1 — `feat(collaboration): add discussion and invitation UX contracts`**: T005–T021.
2. **Stack PR 2 — `feat(chat): make shared sessions native`**: T022–T036.
3. **Stack PR 3 — `feat(collaboration): add native session layers`**: T037–T058.
4. **Stack PR 4 — `feat(collaboration): complete native terminal and discovery`**: T059–T084.
5. **Stack PR 5 — `feat(collaboration): align desktop and mobile surfaces`**: T085–T108.

If any layer exceeds repository limits, split only at a coherent surface boundary and update `plan.md`, this stack map, and the implementation log before opening PRs.

## Parallel Opportunities

- In Phase 2, contract/database/repository/route/proxy/wiring red tests touch separate suites and may run in parallel; implementation converges in order T012 → T019.
- In US1, projection, route, and Playwright red tests may run in parallel; attribution and queue components may be implemented in parallel after the adapter shape settles.
- In US2, accessibility, draft, realtime, and layout tests may run in parallel; drawer and draft storage are separate implementations.
- In US3, access-summary and sharing tests may run in parallel; the summary component can be built before Chat integration.
- In US4, shell UI, discussion, authorization, and route tests may run in parallel; controller status can be built independently of native route integration.
- In US5, discovery UI, navigation, route, and invitation tests may run in parallel; badge hook and reusable list component are independent until shell integration.
- In US6, Electron Chat, Electron Terminal, mobile request, and mobile screen tests are independent; desktop and mobile integrations can proceed in parallel once common UI is stable.

## Implementation Strategy

### MVP first

1. Confirm the interaction model (T001).
2. Complete and validate the additive foundation (T005–T021).
3. Complete native Canvas Chat (T022–T036).
4. Stop and demo User Story 1 before expanding the stack.

### Incremental delivery

Deliver the five stack layers in order. Each layer must be green, evidenced, within size limits, and reviewable before its child is opened. The feature flag keeps incomplete consumer surfaces hidden. Do not merge any layer without explicit user approval, even after CI and Greptile pass.

## Format Validation

All 108 tasks use the required checkbox, sequential task ID, optional `[P]`, required user-story label inside story phases, and an exact repository file path or evidence-log path.
