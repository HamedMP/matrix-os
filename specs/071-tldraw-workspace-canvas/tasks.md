# Tasks: Workspace Canvas

**Input**: Design documents from `specs/071-tldraw-workspace-canvas/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`
**Tests**: Mandatory for this repository. Matrix OS constitution requires tests first, so every user story starts with failing tests before implementation.
**Storage Decision**: Canonical canvas documents MUST use the user-owned Postgres app/workspace database inside the user's VPS. Filesystem writes are limited to export/backup/recovery materialization, never primary canvas state.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other marked tasks in the same phase because it touches different files and has no dependency on incomplete tasks.
- **[Story]**: User story label from `spec.md`. Story labels appear only in user story phases.
- Every task includes exact repository file paths.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare dependencies, scaffolding, and public docs placeholder before tests and implementation.

- [X] T001 Add `@tldraw/tldraw` to the shell workspace dependency list in `shell/package.json` and update `pnpm-lock.yaml` from the repository root
- [X] T002 [P] Create empty gateway canvas module files in `packages/gateway/src/canvas/contracts.ts`, `packages/gateway/src/canvas/repository.ts`, `packages/gateway/src/canvas/routes.ts`, `packages/gateway/src/canvas/service.ts`, `packages/gateway/src/canvas/subscriptions.ts`, and `packages/gateway/src/canvas/recovery.ts`
- [X] T003 [P] Create empty shell workspace canvas files in `shell/src/stores/workspace-canvas-store.ts`, `shell/src/components/canvas/WorkspaceCanvas.tsx`, `shell/src/components/canvas/WorkspaceCanvasNode.tsx`, `shell/src/components/canvas/WorkspaceCanvasToolbar.tsx`, `shell/src/components/canvas/WorkspaceCanvasInspector.tsx`, and `shell/src/components/canvas/WorkspaceCanvasFallbackNode.tsx`
- [X] T004 [P] Create the public documentation placeholder in `www/content/docs/workspace-canvas.mdx`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define shared contracts, Postgres persistence, routing, realtime infrastructure, and gateway wiring. No user story work can begin until this phase is complete.

### Tests First

- [X] T005 [P] Write failing Zod contract tests for IDs, document limits, node metadata limits, unsafe URLs, unsafe file paths, stale revisions, and safe error shapes in `tests/gateway/canvas-contracts.test.ts`
- [X] T006 [P] Write failing Postgres repository tests for schema bootstrap, per-owner scope isolation, optimistic revision updates, soft delete, export reads, and transaction rollback in `tests/gateway/canvas-repository.test.ts`
- [X] T007 [P] Write failing route tests for auth rejection, Hono body limits before buffering, generic client errors, CRUD status codes, and conflict responses in `tests/gateway/canvas-routes.test.ts`
- [X] T008 [P] Write failing realtime tests for subscribe authorization, 32 KiB frame validation, 100 total subscriber cap, 10 subscribers per canvas/user cap, TTL presence eviction, and generic errors in `tests/gateway/canvas-subscriptions.test.ts`
- [X] T009 [P] Write failing edge contract tests for valid node references, compatible visual edge types, and rejection of implicit domain mutations in `tests/gateway/canvas-contracts.test.ts`

### Implementation

- [X] T010 Implement canonical canvas Zod schemas and exported TypeScript types using `zod/v4` in `packages/gateway/src/canvas/contracts.ts`
- [X] T011 Implement edge schemas, compatibility validation, and visual-only relationship guards in `packages/gateway/src/canvas/contracts.ts`
- [X] T012 Implement user-owned Postgres canvas table bootstrap and indexes with Kysely in `packages/gateway/src/canvas/repository.ts`
- [X] T013 Implement `CanvasRepository` CRUD, optimistic revision checks, soft delete, export read, edge persistence, and transaction helpers against the user VPS Postgres database in `packages/gateway/src/canvas/repository.ts`
- [X] T014 Implement generic safe canvas error mapping without raw Zod issues, filesystem paths, provider names, or stack traces in `packages/gateway/src/canvas/service.ts`
- [X] T015 Implement `CanvasSubscriptionHub` with capped Maps/Sets, LRU/TTL cleanup, authorization callback hooks, and safe websocket messages in `packages/gateway/src/canvas/subscriptions.ts`
- [X] T016 Implement `createCanvasRoutes()` with Hono `bodyLimit`, auth-aware user resolution, Zod request validation, and REST routes from `contracts/rest-api.md` in `packages/gateway/src/canvas/routes.ts`
- [X] T017 Wire `CanvasRepository`, `CanvasService`, `CanvasSubscriptionHub`, REST routes, and websocket message handling at gateway startup in `packages/gateway/src/server.ts`
- [X] T018 Replace legacy `/api/canvas` JSON-file persistence with a compatibility response or migration shim that delegates to Postgres-backed canvas documents in `packages/gateway/src/server.ts`
- [X] T019 Export the canvas gateway module surface from `packages/gateway/src/index.ts`

**Checkpoint**: Gateway contracts, Postgres-backed persistence, route auth/body limits, and subscription caps are ready for story implementation.

---

## Phase 3: User Story 1 - See PR Work Visually (Priority: P1)

**Goal**: A developer opens a project or pull request workspace canvas and sees PR context, worktree state, review status, linked task, and attachable terminal nodes.

**Independent Test**: Open a GitHub-backed project with an active PR worktree and verify that the canvas shows the PR, review state, linked task, and at least one attachable terminal node.

### Tests First

- [X] T020 [P] [US1] Write failing service tests for creating a PR workspace canvas from project/worktree/PR summaries in `tests/gateway/canvas-service.test.ts`
- [X] T021 [P] [US1] Write failing route tests for `GET /api/canvases`, `POST /api/canvases`, and `GET /api/canvases/:canvasId` with PR scope authorization in `tests/gateway/canvas-routes.test.ts`
- [X] T022 [P] [US1] Write failing shell store tests for loading a PR canvas document and linked state summaries in `tests/shell/workspace-canvas-store.test.ts`
- [X] T023 [P] [US1] Write failing renderer tests for PR, task, review-status, and terminal summary nodes in `tests/shell/workspace-canvas-renderer.test.tsx`

### Implementation

- [X] T024 [US1] Implement PR, project, task, review summary, and terminal summary node derivation in `packages/gateway/src/canvas/service.ts`
- [X] T025 [US1] Implement scope authorization for global, project, task, pull_request, and review_loop canvas reads in `packages/gateway/src/canvas/service.ts`
- [X] T026 [US1] Implement canvas summary listing with pagination, node counts, stale counts, and live counts in `packages/gateway/src/canvas/routes.ts`
- [X] T027 [US1] Implement PR workspace creation templates without duplicating project/worktree/PR source-of-truth records in `packages/gateway/src/canvas/service.ts`
- [X] T028 [US1] Implement typed canvas loading, create/list/read API calls, and safe client error state in `shell/src/stores/workspace-canvas-store.ts`
- [X] T029 [US1] Implement the tldraw-backed workspace renderer that maps canonical canvas nodes to tldraw records in `shell/src/components/canvas/WorkspaceCanvas.tsx`
- [X] T030 [US1] Implement PR, task, review status, finding-count, and terminal summary node rendering in `shell/src/components/canvas/WorkspaceCanvasNode.tsx`
- [X] T031 [US1] Replace or route the existing canvas-mode renderer through `WorkspaceCanvas` while preserving existing window canvas behavior in `shell/src/components/canvas/CanvasRenderer.tsx`
- [X] T032 [US1] Add PR canvas open/focus integration from the desktop shell into the workspace canvas store in `shell/src/components/Desktop.tsx`

**Checkpoint**: User Story 1 is independently usable as the MVP canvas for PR work visibility.

---

## Phase 4: User Story 2 - Use Live Terminals As Nodes (Priority: P1)

**Goal**: A developer creates, arranges, and attaches live terminal sessions from canvas nodes while preserving durable shared session identity.

**Independent Test**: Create or attach a terminal session from the canvas, reattach from the CLI or browser shell, and verify all surfaces observe the same live session.

### Tests First

- [X] T033 [P] [US2] Write failing integration tests for terminal create/attach actions that reuse `SessionRegistry` identities and reject duplicate session creation in `tests/gateway/canvas-terminal.test.ts`
- [X] T034 [P] [US2] Write failing shell tests for terminal node activation, inactive summary rendering, resize persistence, and reload reattach behavior in `tests/shell/workspace-canvas-renderer.test.tsx`
- [X] T035 [P] [US2] Write failing store tests for terminal node action requests, optimistic node movement, conflict rollback, and safe action errors in `tests/shell/workspace-canvas-store.test.ts`
- [X] T036 [P] [US2] Write failing service tests for terminal observe, write, and takeover permission delegation in `tests/gateway/canvas-terminal.test.ts`

### Implementation

- [X] T037 [US2] Implement `terminal.create`, `terminal.attach`, and `terminal.kill` canvas actions through injected `SessionRegistry` dependencies in `packages/gateway/src/canvas/service.ts`
- [X] T038 [US2] Validate terminal create, attach, observe, write, takeover, and kill action payloads with existing UUID/session schemas and project/task source refs in `packages/gateway/src/canvas/contracts.ts`
- [X] T039 [US2] Implement `POST /api/canvases/:canvasId/actions` terminal action routing with generic errors in `packages/gateway/src/canvas/routes.ts`
- [X] T040 [US2] Persist terminal node position, size, display state, and source references through revisioned node updates in `packages/gateway/src/canvas/repository.ts`
- [X] T041 [US2] Implement observe, write, and takeover permission checks by delegating to the existing terminal/session authorization source of truth in `packages/gateway/src/canvas/service.ts`
- [X] T042 [US2] Implement focused live terminal mounting with `TerminalPane` reuse, observe/write/takeover mode handling, and summary fallback in `shell/src/components/canvas/WorkspaceCanvasNode.tsx`
- [X] T043 [US2] Add terminal node commands for create, attach, focus, resize, minimize, close, and kill in `shell/src/components/canvas/WorkspaceCanvasToolbar.tsx`
- [X] T044 [US2] Add terminal session handoff support for canvas-originated attach metadata in `shell/src/components/terminal/TerminalApp.tsx`
- [X] T045 [US2] Add terminal node save/reload behavior to the workspace canvas store in `shell/src/stores/workspace-canvas-store.ts`

**Checkpoint**: Terminal nodes preserve durable sessions and survive browser reloads without duplicate terminal state.

---

## Phase 5: User Story 3 - Coordinate Review Loops (Priority: P1)

**Goal**: A developer starts or watches autonomous PR review loops from the canvas and inspects rounds, findings, commits, verification, and convergence state spatially.

**Independent Test**: Start a review loop for a PR, complete at least one reviewer round and one implementer round, and verify the canvas records the round graph and current state.

### Tests First

- [X] T046 [P] [US3] Write failing service tests for review loop node state transitions, finding summaries, commit links, and degraded missing-auth state in `tests/gateway/canvas-review-loop.test.ts`
- [X] T047 [P] [US3] Write failing route tests for `review.start`, `review.stop`, `review.next`, `review.approve`, and `pr.refresh` canvas actions with safe provider errors in `tests/gateway/canvas-routes.test.ts`
- [X] T048 [P] [US3] Write failing shell renderer tests for review loop round graph, finding groups, next actions, and final states in `tests/shell/workspace-canvas-renderer.test.tsx`

### Implementation

- [X] T049 [US3] Implement review loop and PR action payload schemas with no provider-specific secrets or raw errors in `packages/gateway/src/canvas/contracts.ts`
- [X] T050 [US3] Implement review loop summary resolution, round graph derivation, finding grouping, and convergence state mapping in `packages/gateway/src/canvas/service.ts`
- [X] T051 [US3] Implement `review.start`, `review.stop`, `review.next`, `review.approve`, and `pr.refresh` action handlers with 10 second external-call timeouts in `packages/gateway/src/canvas/service.ts`
- [X] T052 [US3] Implement review loop node and finding node persistence updates after review action results in `packages/gateway/src/canvas/repository.ts`
- [X] T053 [US3] Broadcast review loop and reference-state changes through canvas realtime events in `packages/gateway/src/canvas/subscriptions.ts`
- [X] T054 [US3] Render review loop nodes, finding groups, round history, verification status, and allowed actions in `shell/src/components/canvas/WorkspaceCanvasNode.tsx`
- [X] T055 [US3] Add review loop action controls and disabled/degraded states to `shell/src/components/canvas/WorkspaceCanvasInspector.tsx`

**Checkpoint**: Review loops can be started or inspected from the canvas and remain visible after loop completion or failure.

---

## Phase 6: User Story 4 - Persist Project Canvases (Priority: P2)

**Goal**: A developer maintains saved canvases per project or PR so spatial organization survives reloads, client changes, and VPS recovery.

**Independent Test**: Arrange nodes in a project canvas, reload from the browser, inspect from another client, and verify the layout and node links persist.

### Tests First

- [X] T056 [P] [US4] Write failing repository tests for project/PR uniqueness, revision conflicts, per-user view state, export, delete, and Postgres transaction atomicity in `tests/gateway/canvas-repository.test.ts`
- [X] T057 [P] [US4] Write failing recovery tests for restored canvases with missing sessions, missing worktrees, stale review loops, and recoverable node display states in `tests/gateway/canvas-recovery.test.ts`
- [X] T058 [P] [US4] Write failing realtime tests for second-client visibility after document and node writes in `tests/gateway/canvas-subscriptions.test.ts`
- [X] T059 [P] [US4] Write failing shell store tests for debounced saves, conflict handling, second-client refetch, and reload persistence in `tests/shell/workspace-canvas-store.test.ts`
- [X] T060 [P] [US4] Write failing cleanup tests for temporary export bundles, backup materialization files, preview artifacts, and stale recovery records in `tests/gateway/canvas-recovery.test.ts`

### Implementation

- [X] T061 [US4] Implement unique active canvas constraints for owner/scope pairs in the Postgres schema in `packages/gateway/src/canvas/repository.ts`
- [X] T062 [US4] Implement `PUT /api/canvases/:canvasId`, `PATCH /api/canvases/:canvasId/nodes/:nodeId`, `DELETE /api/canvases/:canvasId`, and `GET /api/canvases/:canvasId/export` in `packages/gateway/src/canvas/routes.ts`
- [X] T063 [US4] Implement crash-safe export and backup materialization from Postgres to temp file plus rename in `packages/gateway/src/canvas/recovery.ts`
- [X] T064 [US4] Implement startup reconciliation for missing terminal sessions, worktrees, PRs, and review loops without deleting nodes in `packages/gateway/src/canvas/recovery.ts`
- [X] T065 [US4] Implement TTL and max-count cleanup policies for temporary export bundles, backup materialization files, preview artifacts, and stale recovery records in `packages/gateway/src/canvas/recovery.ts`
- [X] T066 [US4] Wire canvas recovery reconciliation into gateway startup after dependencies are constructed in `packages/gateway/src/server.ts`
- [X] T067 [US4] Implement debounced revisioned saves, conflict refetch, delete, export, and realtime update handling in `shell/src/stores/workspace-canvas-store.ts`
- [X] T068 [US4] Persist tldraw node position, size, grouping, selection, viewport, and display options through canonical canvas documents in `shell/src/components/canvas/WorkspaceCanvas.tsx`

**Checkpoint**: Project and PR canvases persist through reloads, second clients, and VPS recovery flows.

---

## Phase 7: User Story 5 - Add Custom Nodes Safely (Priority: P2)

**Goal**: A developer adds notes, files, previews, app windows, GitHub issues, and later custom node types through typed, bounded, recoverable node definitions.

**Independent Test**: Add a note, file, preview, and app-window node to a project canvas, persist them, and verify invalid node definitions are rejected with a recoverable error.

### Tests First

- [X] T069 [P] [US5] Write failing schema tests for note, file, preview, app-window, issue, custom, and fallback node metadata validation in `tests/gateway/canvas-contracts.test.ts`
- [X] T070 [P] [US5] Write failing route tests for unsafe file paths, unsafe URLs, unauthorized app IDs, oversized custom payloads, and fallback node loading in `tests/gateway/canvas-routes.test.ts`
- [X] T071 [P] [US5] Write failing renderer tests for note, file, preview, app-window, issue, custom, and fallback nodes in `tests/shell/workspace-canvas-renderer.test.tsx`
- [X] T072 [P] [US5] Write failing store and renderer tests for creating visual edges, preserving edge layout, and requiring confirmation before domain relationship mutations in `tests/shell/workspace-canvas-renderer.test.tsx`
- [X] T073 [P] [US5] Write failing service tests for custom node `migrationRefs`, version upgrades, invalid migrations, and fallback on missing renderer versions in `tests/gateway/canvas-service.test.ts`

### Implementation

- [X] T074 [US5] Implement note, file, preview, app-window, issue, custom, and fallback node schemas with metadata caps in `packages/gateway/src/canvas/contracts.ts`
- [X] T075 [US5] Implement safe file path resolution through `resolveWithinHome` or project-root guards for file nodes in `packages/gateway/src/canvas/service.ts`
- [X] T076 [US5] Implement preview URL scheme validation and `preview.healthCheck` with `AbortSignal.timeout(10_000)` in `packages/gateway/src/canvas/service.ts`
- [X] T077 [US5] Implement custom node definition validation, renderer reference allowlisting, version migration execution, and fallback conversion in `packages/gateway/src/canvas/service.ts`
- [X] T078 [US5] Add toolbar actions for note, file, preview, app-window, issue, and custom node creation in `shell/src/components/canvas/WorkspaceCanvasToolbar.tsx`
- [X] T079 [US5] Render note, file, preview, app-window, issue, custom, and fallback nodes with safe degraded states in `shell/src/components/canvas/WorkspaceCanvasNode.tsx`
- [X] T080 [US5] Implement fallback node details and recovery metadata in `shell/src/components/canvas/WorkspaceCanvasFallbackNode.tsx`
- [X] T081 [US5] Implement visual edge creation, edge rendering, edge deletion, and confirmation prompts before any domain relationship mutation in `shell/src/components/canvas/WorkspaceCanvas.tsx`

**Checkpoint**: Custom and non-core nodes are typed, bounded, persisted, and safely recoverable.

---

## Phase 8: User Story 6 - Navigate Large Workspaces (Priority: P3)

**Goal**: A developer searches, filters, groups, zooms, and focuses a large project canvas without losing orientation or rendering too many expensive live surfaces.

**Independent Test**: Load a canvas with at least 200 nodes and verify search, focus, filtering, grouping, overview navigation, and live-node budgets remain usable.

### Tests First

- [X] T082 [P] [US6] Write failing service tests for 200-node canvas list/read performance, pagination, node query filters, and oversized document rejection in `tests/gateway/canvas-service.test.ts`
- [X] T083 [P] [US6] Write failing shell tests for search, filter, focus, group collapse, minimap/overview, and live activation budget behavior in `tests/shell/workspace-canvas-renderer.test.tsx`
- [X] T084 [P] [US6] Write failing Playwright smoke coverage for opening a seeded PR canvas, moving a terminal node, reloading, and verifying the same node/session in `tests/e2e/workspace-canvas.spec.ts`
- [X] T085 [P] [US6] Write failing performance and reliability assertions for opening a PR canvas under 30 seconds, keeping 200-node interactions under 1 second, and repeated terminal attach without duplicates in `tests/e2e/workspace-canvas.spec.ts`

### Implementation

- [X] T086 [US6] Implement canvas node search, filter, focus, and summary query helpers in `packages/gateway/src/canvas/service.ts`
- [X] T087 [US6] Enforce max document size, 500-node cap, 1,000-edge cap, view-state cap, and oversized metadata rejection in `packages/gateway/src/canvas/contracts.ts`
- [X] T088 [US6] Implement live terminal/app/preview activation budgeting, render-cache TTL/max-count cleanup, and summary-mode selection in `shell/src/stores/workspace-canvas-store.ts`
- [X] T089 [US6] Implement search, filter, group, collapse, expand, focus, and overview UI controls in `shell/src/components/canvas/WorkspaceCanvasToolbar.tsx`
- [X] T090 [US6] Implement inspector search results, focused node details, group summaries, and recoverable missing-reference details in `shell/src/components/canvas/WorkspaceCanvasInspector.tsx`
- [X] T091 [US6] Add Playwright fixture seeding and assertions for the workspace canvas smoke path in `tests/e2e/workspace-canvas.spec.ts`

**Checkpoint**: Large canvases remain searchable, focusable, and bounded under the specified resource limits.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, docs, migration notes, and pre-PR quality gates across all stories.

- [X] T092 [P] Update public docs for concepts, PR review workflows, terminal nodes, custom node boundaries, data ownership, export/delete, and VPS recovery in `www/content/docs/workspace-canvas.mdx`
- [X] T093 [P] Update developer quickstart verification commands and manual scenarios in `specs/071-tldraw-workspace-canvas/quickstart.md`
- [X] T094 [P] Add or update screenshots/test fixture data for seeded workspace canvases in `tests/fixtures/workspace-canvas/`
- [X] T095 Run targeted Vitest suites listed in `specs/071-tldraw-workspace-canvas/quickstart.md`
- [X] T096 Run `bun run typecheck` and fix TypeScript errors in changed files under `packages/gateway/src/`, `shell/src/`, and `tests/`
- [X] T097 Run `bun run check:patterns` and fix any canvas-related violations in `packages/gateway/src/canvas/`, `shell/src/stores/workspace-canvas-store.ts`, and `shell/src/components/canvas/`
- [X] T098 Run `bun run test` and fix regressions in changed gateway, shell, and e2e test files
- [X] T099 Verify backend PR invariants for source of truth, Postgres transaction scope, orphan states, auth source of truth, and deferred org-shared scope in `specs/071-tldraw-workspace-canvas/tasks.md`

### Backend PR Invariants

- **Source of truth**: canonical workspace canvas documents live in the authenticated user's VPS Postgres database via `canvas_documents`; filesystem materialization is limited to export and recovery artifacts.
- **Lock/transaction scope**: repository create/replace/patch/delete operations are Postgres writes; revisioned replace and transaction helpers keep multi-write changes inside Kysely transactions, with no network calls inside transaction scope.
- **Acceptable orphan states**: linked terminal, PR, worktree, review, file, app, and issue records remain external source-of-truth records; missing references degrade nodes to `recoverable`/fallback states instead of deleting canvas data.
- **Auth source of truth**: gateway auth middleware resolves the user identity and canvas routes map it to personal owner scope; org/shared scope is reserved and fail-closed until separate authorization lands.
- **Deferred scope**: multi-user org canvases, provider-specific review-loop execution, and domain relationship mutation from visual edges are intentionally deferred behind explicit action/authorization work.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **User Stories 1-3 (P1)**: Depend on Foundational and can proceed in parallel after shared contracts, repository, routes, and subscriptions exist.
- **User Stories 4-5 (P2)**: Depend on Foundational. US4 can build on US1/US2 persistence needs; US5 can proceed once schema and routes support generic node writes.
- **User Story 6 (P3)**: Depends on the relevant node types and persistence from US1-US5.
- **Polish (Phase 9)**: Depends on all desired stories for the release.

### User Story Dependencies

- **US1 (P1)**: Starts after Phase 2. MVP scope.
- **US2 (P1)**: Starts after Phase 2; integrates with US1 terminal summaries but remains independently testable through terminal actions.
- **US3 (P1)**: Starts after Phase 2; integrates with US1 PR nodes but remains independently testable through review loop actions.
- **US4 (P2)**: Starts after Phase 2; strongest validation comes after US1/US2 nodes exist.
- **US5 (P2)**: Starts after Phase 2; independent from PR/review behavior.
- **US6 (P3)**: Starts after US1-US5 provide realistic node variety.

### Within Each User Story

- Tests MUST be written and observed failing before implementation.
- Gateway schemas before repository/service route behavior.
- Repository/service behavior before shell integration.
- Shell store behavior before React rendering.
- Story checkpoint validation before moving to the next priority when working sequentially.

---

## Parallel Execution Examples

### User Story 1

```bash
Task: "Write failing service tests for creating a PR workspace canvas from project/worktree/PR summaries in tests/gateway/canvas-service.test.ts"
Task: "Write failing shell store tests for loading a PR canvas document and linked state summaries in tests/shell/workspace-canvas-store.test.ts"
Task: "Write failing renderer tests for PR, task, review-status, and terminal summary nodes in tests/shell/workspace-canvas-renderer.test.tsx"
```

### User Story 2

```bash
Task: "Write failing integration tests for terminal create/attach actions that reuse SessionRegistry identities and reject duplicate session creation in tests/gateway/canvas-terminal.test.ts"
Task: "Write failing shell tests for terminal node activation, inactive summary rendering, resize persistence, and reload reattach behavior in tests/shell/workspace-canvas-renderer.test.tsx"
```

### User Story 3

```bash
Task: "Write failing service tests for review loop node state transitions, finding summaries, commit links, and degraded missing-auth state in tests/gateway/canvas-review-loop.test.ts"
Task: "Write failing shell renderer tests for review loop round graph, finding groups, next actions, and final states in tests/shell/workspace-canvas-renderer.test.tsx"
```

### User Story 4

```bash
Task: "Write failing repository tests for project/PR uniqueness, revision conflicts, per-user view state, export, delete, and Postgres transaction atomicity in tests/gateway/canvas-repository.test.ts"
Task: "Write failing recovery tests for restored canvases with missing sessions, missing worktrees, stale review loops, and recoverable node display states in tests/gateway/canvas-recovery.test.ts"
Task: "Write failing shell store tests for debounced saves, conflict handling, second-client refetch, and reload persistence in tests/shell/workspace-canvas-store.test.ts"
```

### User Story 5

```bash
Task: "Write failing schema tests for note, file, preview, app-window, issue, custom, and fallback node metadata validation in tests/gateway/canvas-contracts.test.ts"
Task: "Write failing renderer tests for note, file, preview, app-window, issue, custom, and fallback nodes in tests/shell/workspace-canvas-renderer.test.tsx"
```

### User Story 6

```bash
Task: "Write failing service tests for 200-node canvas list/read performance, pagination, node query filters, and oversized document rejection in tests/gateway/canvas-service.test.ts"
Task: "Write failing Playwright smoke coverage for opening a seeded PR canvas, moving a terminal node, reloading, and verifying the same node/session in tests/e2e/workspace-canvas.spec.ts"
```

---

## Implementation Strategy

### MVP First (P1 Stories)

1. Complete Phase 1 and Phase 2.
2. Complete US1 to show a PR workspace canvas with typed PR/task/review/terminal summary nodes.
3. Complete US2 so terminal nodes attach to durable shared sessions.
4. Complete US3 so review loops are visible and controllable.
5. Stop and validate the P1 workflow with targeted tests and manual quickstart steps.

### Incremental Delivery

1. Foundation: contracts, Postgres persistence, REST, realtime, and gateway wiring.
2. MVP visibility: PR canvas with linked source-of-truth summaries.
3. Live work: terminal attach/create through existing session registry.
4. Review workflow: review loop graph and actions.
5. Persistence/recovery: revisioned saves, export/delete, VPS recovery markers.
6. General nodes: notes, files, previews, app windows, issues, custom fallback.
7. Scale: search, focus, grouping, and activation budgets.

### Parallel Team Strategy

1. One developer owns gateway contracts/Postgres repository/routes in `packages/gateway/src/canvas/`.
2. One developer owns shell store/tldraw renderer in `shell/src/stores/` and `shell/src/components/canvas/`.
3. One developer owns test fixtures, recovery tests, Playwright smoke, and docs in `tests/`, `specs/`, and `www/content/docs/`.
4. Do not edit the same files concurrently without coordinating because all workers share the current branch.

---

## Notes

- Canonical storage is Postgres in the user's VPS. Do not create a new `~/system/canvas.json` source of truth.
- Filesystem output is acceptable only for export bundles, backup materialization, and recovery artifacts with temp-file plus rename semantics.
- Canvas nodes store typed references to terminal, PR, worktree, review loop, file, app, and issue records; they do not duplicate those records as canonical state.
- All external calls need `AbortSignal.timeout(...)`.
- All Maps/Sets in subscriptions, presence, caches, and pending saves need caps and eviction.
- Client errors stay generic; detailed diagnostics are logged server-side.
- Commit after each completed phase or coherent task group.
