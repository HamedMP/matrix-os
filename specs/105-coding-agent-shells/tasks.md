# Tasks: Coding Agent Shells

**Status**: Backend Phases 18-20 implemented; Phase 21 shell implementation next; real-process Gate 3 smoke pending
**Lineage**: foundation merged through the recorded implementation checkpoint; clarified follow-up is specified against current `main`
**Rule**: Preserve all existing desktop and mobile functionality. Add coding-agent capabilities incrementally behind contracts, tests, and feature flags.

## Implementation Checkpoint

The phase checklist below is the original implementation plan. The authoritative
landed-state inventory is now `current-state.md`, and the requirement/evidence
matrix is `completion-audit.md`.

As of the `056b3da668ed6d1753712120316d2d5accfafdcf` main checkpoint:

- Shared contracts, gateway summary/routes, provider/thread/review/file/preview/source-control contracts, desktop shell surfaces, mobile SDK 57 surfaces, browser Workspace handoff, notification preferences, and public/internal docs are implemented and inventoried in `current-state.md`.
- Startup/runtime degradation recovery now routes closed coding-agent sessions through the same workspace `session.stopped` publisher path used by live session completion reconciliation.
- GitHub CI for the `87bc72d0fdd9067fcec395c479de80fcaccfe641` implementation checkpoint completed successfully, including pattern scan, React Doctor, typecheck, shell production build, sync-client package checks, all four unit shards, and E2E.
- Docker Tests and Host Bundle Release completed successfully for the `87bc72d0fdd9067fcec395c479de80fcaccfe641` implementation checkpoint; Host Bundle Release built the bundle, published the release, and triggered exact-version VPS deploy.
- Platform Cloud Run completed successfully for the browser Workspace implementation checkpoint commit `87ce9e8cc2a6357a122ea0fd9120487702ea9323`; the later `87bc72d0fdd9067fcec395c479de80fcaccfe641` checkpoint changed gateway/spec state and did not require a platform app-shell deploy.
- PR #866 desktop operator e2e smoke validation now covers the stubbed sign-in/device-auth flow, project board hydration, canonical terminal attach and echo, the current Agents workspace summary/create path, Terminal Shells, Apps, Settings, Chat, and hosted-shell detach behavior.
- PR #868 mobile validation now confirms thread detail terminal handoff persists the bounded canonical terminal session reference needed by the mobile Terminal route without persisting terminal output or transcript data.
- PR #869 desktop validation now confirms the command-palette Agents entry still opens after terminal interaction, and menu-template tests cover the native Agents accelerator used to focus the same workspace.
- Remaining work is validation and rollout hardening: real-runtime desktop smoke, mobile SDK 57 device smoke, and continued docs sync as later provider/runtime behavior changes.

That checkpoint is not the clarified final product. The active backlog now requires a project-first hierarchy, same-thread conversation turns, tasks with multiple threads, and Conversation/Kanban views. `acceptance-tests.md` is the authoritative test matrix for this follow-up work.

## Active Confirmation Plan

- [x] Record one visible chat/session as one resumable `AgentThread`.
- [x] Record each accepted user message as one server-side `AgentTurn` in that thread.
- [x] Record `Project -> Task -> many AgentThreads` cardinality and project-level threads.
- [x] Keep canonical Matrix task statuses separate from aggregated thread execution state.
- [x] Define Conversation and Kanban as two views over one gateway-owned model.
- [x] Add aligned architecture, phased plan, implementation tasks, and acceptance-test IDs.
- [x] Product owner confirmed all four product decisions in Gate 0 on 2026-07-10; the two mechanical readiness checks also pass.
- [x] Begin implementation only after confirmation.

Gate 0 is closed. Phase 18+ work must follow the acceptance IDs and completion gates below.

## Agent Instructions

Before starting any task:

- Read `AGENTS.md` and `.specify/memory/constitution.md`.
- Read this spec package: `README.md`, `SPEC.md`, `ARCHITECTURE.md`, and `tasks.md`.
- Read the relevant existing spec before editing a subsystem:
  - `specs/075-mobile-shell/spec.md` for mobile shell.
  - `specs/094-electron-macos-shell/spec.md` for desktop shell.
  - `specs/104-terminal-refactor-foundation/spec.md` for terminal refactor boundaries.
  - `specs/069-cloud-coding-workspaces/spec.md` if changing cloud coding workspace behavior.
  - `specs/098-terminal-session-reliability/spec.md` if changing terminal session lifecycle.
- Write failing tests first for implementation work.
- Use Zod 4 (`zod/v4`) for new runtime contracts.
- Keep new persistence in owner Postgres/Kysely or existing owner files according to current Matrix architecture. Do not add new embedded database persistence.
- Do not expose provider errors, raw paths, stack traces, tokens, or internal hostnames in UI.
- Do not move core runtime behavior into desktop or mobile clients.

## Completion Gates

Every PR slice must satisfy the relevant gates:

- [ ] Focused tests added before implementation.
- [ ] `bun run check:patterns` passes when touching Matrix OS source.
- [ ] `bun run typecheck` passes when changed package graph allows it.
- [ ] `bun run test -- <focused pattern>` passes for touched gateway/kernel/shared modules.
- [ ] `pnpm --filter desktop run typecheck` passes for desktop changes.
- [ ] `pnpm --filter matrix-os-mobile run test` or equivalent mobile Jest command passes for mobile changes.
- [ ] Existing desktop regression checklist passes manually or by smoke test when desktop behavior changes.
- [ ] Existing mobile regression checklist passes manually or by test when mobile behavior changes.
- [ ] No generated docs/code/comments mention external reference project names.
- [ ] Public docs update task is completed or explicitly deferred with reason.

## Phase 0 - Discovery And Baseline

Goal: establish exact current behavior and regression gates before adding new runtime surfaces.

### 0.1 Inventory Current Runtime Surfaces

- [ ] List current gateway routes for terminal sessions, apps, files, previews, agent credentials, and shell auth.
- [ ] List current WebSocket endpoints and frame shapes.
- [ ] List current desktop IPC channels in `desktop/src/shared/ipc-contract.ts`.
- [ ] List current mobile gateway methods in `apps/mobile/lib/gateway-client.ts`.
- [ ] List current terminal client methods in `apps/mobile/lib/terminal-client.ts`.
- [ ] List current desktop renderer agent/session/task stores under `desktop/src/renderer/src/stores`.
- [ ] List current shell terminal/session helpers under `shell/src`.
- [ ] Document which current flows are canonical and which are compatibility paths.

Deliverable:

- [ ] Add `specs/105-coding-agent-shells/current-state.md` with route/contract inventory and open questions.

Tests:

- [ ] No code tests required unless inventory finds existing broken tests. Run `git status` and keep this docs-only unless implementation is needed.

### 0.2 Establish Regression Scripts

- [ ] Identify existing focused tests for mobile terminal, gateway client, shell sessions, desktop IPC, and desktop renderer stores.
- [ ] Add missing smoke-test commands to `current-state.md`.
- [ ] Confirm mobile SDK 57 test command in this branch.
- [ ] Confirm desktop typecheck command in this branch.
- [ ] Confirm gateway focused test command for terminal/session routes.

Deliverable:

- [ ] `current-state.md` includes a "Baseline Commands" section.

### 0.3 Define Feature Flags

- [ ] Find existing feature flag mechanism in shell/desktop/mobile.
- [ ] Define flags:
  - `codingAgentsRuntimeSummary`
  - `codingAgentsDesktopWorkspace`
  - `codingAgentsMobileWorkspace`
  - `codingAgentsThreadCreate`
  - `codingAgentsApprovals`
  - `codingAgentsReview`
  - `codingAgentsNativeMobileTerminal`
- [ ] Decide whether flags are server capabilities, build-time flags, local dev flags, or a combination.

Deliverable:

- [ ] Add feature flag plan to `current-state.md` or a separate `flags.md`.

## Phase 1 - Shared Contracts

Goal: create Matrix-native typed contracts consumed by gateway, desktop, mobile, shell, and tests.

### 1.1 Contract Package Decision

- [ ] Check whether `packages/contracts` exists in this branch.
- [ ] If it exists, add coding-agent schemas there.
- [ ] If it does not exist, decide between:
  - Create `packages/contracts`.
  - Start in `packages/gateway/src/contracts` and schedule package extraction.
- [ ] Update `pnpm-workspace.yaml` if a new package is added.
- [ ] Update package imports without creating circular dependencies.

Tests:

- [ ] Add package-level typecheck/test scripts if creating a new package.
- [ ] Add schema parse tests.

### 1.2 ID And Error Schemas

- [ ] Add schemas for runtime ID, provider ID, project ID/slug, task ID, thread ID, event ID, approval ID, terminal session ID, cursor, ISO timestamp, safe display string, bounded text.
- [ ] Add `SafeClientError` schema with `code`, `safeMessage`, `retryable`, optional `recoveryActions`.
- [ ] Add helper tests for valid/invalid IDs and text bounds.

Acceptance:

- [ ] Invalid IDs reject traversal, empty strings, whitespace-only, overly long values, and unsafe characters.
- [ ] Safe errors reject long/internal-looking messages.

### 1.3 Runtime Summary Schemas

- [ ] Add `RuntimeTarget`.
- [ ] Add `RuntimeCapability`.
- [ ] Add `RuntimeLimits`.
- [ ] Add `RuntimeSummary`.
- [ ] Add bounded list metadata: `hasMore`, `nextCursor`, `limit`.
- [ ] Add parse tests for truncated lists and missing optional capabilities.

Acceptance:

- [ ] Summary cannot include terminal output, file contents, provider logs, tokens, or raw errors.

### 1.4 Agent Provider Schemas

- [ ] Add `AgentProviderSummary`.
- [ ] Add `SafeSetupAction`.
- [ ] Add provider availability/auth/install enums.
- [ ] Add supported modes and sandbox/approval policy enums.
- [ ] Add tests rejecting raw command setup actions unless explicitly marked foreground terminal and bounded.

Acceptance:

- [ ] Unknown providers can be represented only through validated custom provider shape.
- [ ] Provider display metadata is safe.

### 1.5 Agent Thread Schemas

- [ ] Add `CreateAgentThreadRequest`.
- [ ] Add `AgentThreadSummary`.
- [ ] Add `AgentThreadStatus`.
- [ ] Add `AgentAttachment`.
- [ ] Add `AgentThreadSnapshot`.
- [ ] Add idempotency via `clientRequestId`.
- [ ] Add tests for prompt/attachment bounds.

Acceptance:

- [ ] Create request requires provider and prompt.
- [ ] Legacy optional project/task/session/worktree references validate independently; Phase 18 supersedes new shell-created threads by requiring `projectId`.

### 1.6 Thread Event Schemas

- [ ] Add discriminated union for thread events.
- [ ] Include lifecycle, text delta, tool activity, approval, input request, file change, review ready, terminal bound, safe error, completion.
- [ ] Add schema tests for each event type.
- [ ] Add tests rejecting unknown required fields, unsafe text lengths, and malformed nested payloads.

Acceptance:

- [ ] Event union is extensible without crashing older clients.

### 1.7 Approval Schemas

- [ ] Add `AgentApprovalRequest`.
- [ ] Add `ApprovalDecisionRequest`.
- [ ] Add `UserInputRequest`.
- [ ] Add `UserInputAnswerRequest`.
- [ ] Add allowed decision enum.
- [ ] Add risk/action kind enums.
- [ ] Add preview bounds.

Acceptance:

- [ ] Approval preview cannot contain unbounded raw command output.
- [ ] Decisions include idempotency/correlation.

### 1.8 Terminal Schemas

- [ ] Align with existing terminal frame contracts.
- [ ] Add or extend client/server frame schemas with attach, input, resize, detach, attached, output, replay gap, replay end, exit, safe error.
- [ ] Add clamp bounds for cols/rows.
- [ ] Add input size bounds.
- [ ] Add terminal session summary schema.

Acceptance:

- [ ] Existing mobile terminal parser can migrate to shared frame schema or adapter tests.

### 1.9 File, Review, Preview Schemas

- [ ] Add project file browse/search/read/write request and response schemas if not already canonical.
- [ ] Add file metadata with etag/base revision.
- [ ] Add review snapshot, file diff, hunk metadata, partial diff notice.
- [ ] Add preview session summary and status.
- [ ] Add tests for path traversal rejection and large diff truncation markers.

Acceptance:

- [ ] File write schema includes conflict token.
- [ ] Review schema supports partial data safely.

## Phase 2 - Gateway Read Models And Summary

Goal: expose a read-only runtime summary that desktop/mobile/shell can hydrate from without changing existing behavior.

### 2.1 Runtime Summary Service

- [ ] Create gateway service module for runtime summary.
- [ ] Gather selected runtime target.
- [ ] Gather capability flags.
- [ ] Gather safe provider summaries from current agent/tool install state.
- [ ] Gather bounded projects/tasks if available.
- [ ] Gather bounded active threads once thread store exists; initially return empty list.
- [ ] Gather bounded terminal sessions from existing canonical session list.
- [ ] Gather bounded recent activity from existing workspace events.
- [ ] Include server time and limits.

Tests:

- [ ] Unit test caps and stable sort.
- [ ] Unit test no sensitive fields.
- [ ] Unit test unavailable dependencies produce safe partial summary.

### 2.2 Runtime Summary Route

- [ ] Add authenticated `GET /api/coding-agents/summary` or chosen canonical route.
- [ ] Validate auth source.
- [ ] Map errors to safe errors.
- [ ] Add route tests for authenticated success, unauthenticated failure, dependency unavailable, and capped lists.

Acceptance:

- [ ] No public access.
- [ ] No raw internal errors.

### 2.3 Provider Registry Read Path

- [ ] Add provider registry service that normalizes current coding tools and setup state.
- [ ] Integrate existing onboarding agent credential status where applicable.
- [ ] Add timeout-bound health checks.
- [ ] Add TTL cache with max size.
- [ ] Add safe setup actions.

Tests:

- [ ] Provider installed/authenticated.
- [ ] Provider missing.
- [ ] Provider auth required.
- [ ] Health timeout.
- [ ] Unknown provider config rejected or marked unavailable safely.

### 2.4 Terminal Session Summary Adapter

- [ ] Reuse canonical `/api/terminal/sessions` model where possible.
- [ ] Add adapter to shared `TerminalSessionSummary`.
- [ ] Mark attachable vs non-attachable sessions explicitly.
- [ ] Do not show orchestrator-only records as attachable.

Tests:

- [ ] Attachable session appears.
- [ ] Non-attachable session excluded or marked non-attachable.
- [ ] Session list capped.

## Phase 3 - Thread Store And Events

Goal: introduce canonical agent thread lifecycle without requiring clients to know provider internals.

### 3.1 Storage Design

- [ ] Decide canonical store for thread metadata/events: owner Postgres/Kysely or existing kernel conversation store.
- [ ] Document source of truth in `current-state.md` or `storage-decision.md`.
- [ ] Define transaction boundaries.
- [ ] Define acceptable orphan states.
- [ ] Define event retention and compaction strategy.

Acceptance:

- [ ] No new embedded DB persistence.
- [ ] Multi-write operations use transaction or atomic statement.

### 3.2 Thread Create Service

- [ ] Add `createThread` service with idempotent `clientRequestId`.
- [ ] Validate provider and runtime availability.
- [ ] Insert thread + initial event atomically.
- [ ] Return accepted snapshot.
- [ ] Enqueue provider start separately.

Tests:

- [ ] Valid create.
- [ ] Duplicate `clientRequestId` returns existing thread.
- [ ] Invalid provider rejected safely.
- [ ] Missing auth rejected.
- [ ] Transaction failure does not create orphan event.

### 3.3 Thread Events Service

- [ ] Add append event function.
- [ ] Add replay by cursor.
- [ ] Add bounded event window.
- [ ] Add live subscriber registry with cap and stale cleanup.
- [ ] Add shutdown drain.
- [ ] Add idempotent event handling if provider emits duplicates.

Tests:

- [ ] Replay ordered events.
- [ ] Replay from cursor.
- [ ] Cursor too old reports gap or bounded replay state.
- [ ] Subscriber failure isolated.
- [ ] Stale subscriber evicted.

### 3.4 Thread Routes

- [ ] `POST /api/coding-agents/threads`
- [ ] `GET /api/coding-agents/threads`
- [ ] `GET /api/coding-agents/threads/:threadId`
- [ ] `POST /api/coding-agents/threads/:threadId/abort`
- [ ] `GET /api/coding-agents/threads/:threadId/events`

Tests:

- [ ] Body limit on mutating routes.
- [ ] Route param validation.
- [ ] Ownership checks.
- [ ] Safe error mapping.
- [ ] Abort idempotency.

### 3.5 Thread WebSocket

- [ ] Add thread event stream WebSocket or extend existing runtime WS.
- [ ] Authenticate before success.
- [ ] Support cursor replay.
- [ ] Validate incoming client frames if bidirectional.
- [ ] Keep max subscribers per owner/runtime/thread.
- [ ] Add keepalive if needed.

Tests:

- [ ] Unauthenticated rejected.
- [ ] Malformed frame rejected.
- [ ] Replay then live event delivered.
- [ ] Shutdown drains.

## Phase 4 - Provider Runtime Integration

Goal: make threads start actual coding-agent provider work through the Matrix runtime.

### 4.1 Provider Adapter Interface

- [X] Define provider adapter interface:
  - `getSummary`
  - `healthCheck`
  - `buildSetupAction`
  - `startThread`
  - `abortThread`
  - `submitApproval`
  - `submitInput`
- [X] Keep provider-specific logic out of clients.
- [X] Normalize provider events to `AgentThreadEvent`.

Tests:

- [X] Fake provider emits normalized events.
- [X] Provider error maps to safe thread error.
- [X] Abort maps correctly.

### 4.2 First Provider Path

- [ ] Select the first existing provider path already most integrated with Matrix.
- [ ] Implement adapter through existing kernel/dispatcher/session manager.
- [ ] Bind provider run to project/task/session when supplied.
- [ ] Stream assistant text, tool activity, status, approval/input requests, and completion.

Tests:

- [ ] Start run with fake provider.
- [ ] Start run with real provider behind integration flag if safe.
- [ ] Completion updates thread.
- [ ] Failure updates thread safely.

### 4.3 Multi-Provider Registry

- [ ] Add additional configured providers after first path is stable.
- [ ] Add provider-specific setup actions that open foreground terminal sessions.
- [ ] Add provider auth status refresh.
- [ ] Add provider model/mode options as safe metadata.

Tests:

- [ ] Multiple providers can be listed.
- [ ] Thread create picks provider by ID.
- [ ] Missing provider does not crash dashboard.

### 4.4 Approvals And Input

- [ ] Connect provider approval requests to approval service.
- [ ] Add approval decision route.
- [ ] Add user input answer route.
- [ ] Ensure repeated decisions are idempotent.
- [ ] Broadcast resolved state to all connected shells.

Tests:

- [ ] Desktop and mobile simulated clients race decision; only one applies.
- [ ] Expired approval safely rejected.
- [ ] Decline/cancel unblock thread correctly.

## Phase 5 - Desktop Read-Only Agent Workspace

Goal: desktop can view runtime summary, providers, threads, terminal sessions, and safe statuses without creating runs yet.

### 5.1 Desktop Runtime Client

- [ ] Add trusted-core runtime client for summary route.
- [ ] Add safe error mapper.
- [ ] Add typed IPC channel `runtime:get-summary`.
- [ ] Add tests for IPC validation.
- [ ] Add reconnect/refresh state in renderer store.

Acceptance:

- [ ] Renderer does not receive bearer credential.
- [ ] Runtime switch refreshes summary.

### 5.2 Desktop Agent Dashboard UI

- [ ] Add feature-flagged dashboard route/view.
- [ ] Show runtime status.
- [ ] Show provider cards.
- [ ] Show active threads.
- [ ] Show terminal sessions.
- [ ] Show recent activity.
- [ ] Add empty states and setup-required states.

Tests:

- [ ] Renderer unit tests for summary states.
- [ ] Safe error rendering tests.

Manual:

- [ ] Sign in.
- [ ] Runtime switch.
- [ ] Existing embeds still work.
- [ ] Existing settings still work.

### 5.3 Desktop Navigation Integration

- [ ] Add command palette/menu entry for agent workspace.
- [ ] Add notification focus target parser without sending notifications yet.
- [ ] Persist last selected thread/project UI state safely.
- [ ] Validate deep link targets.

Tests:

- [ ] Invalid target rejected.
- [ ] Last selected stale target falls back.

## Phase 6 - Mobile Read-Only Agent Workspace

Goal: mobile SDK 57 can view the same runtime summary and recent coding-agent state without creating runs yet.

### 6.1 Mobile Runtime Client

- [ ] Add typed runtime summary fetch wrapper to `apps/mobile/lib`.
- [ ] Reuse current `GatewayClient` auth/token behavior.
- [ ] Add parser tests.
- [ ] Add timeout and safe error handling.

Tests:

- [ ] Summary success.
- [ ] Auth failure.
- [ ] Safe partial summary.
- [ ] Invalid payload rejected safely.

### 6.2 Mobile State And Resume

- [ ] Add mobile agent/workspace resume parser.
- [ ] Store only safe IDs and timestamp.
- [ ] Reconcile persisted state against summary.
- [ ] Add reducer/helper tests.

Acceptance:

- [ ] Stale thread/session/project references are dropped.

### 6.3 Mobile Agent Screens

- [ ] Add `/agents` recent work screen.
- [ ] Add provider list section.
- [ ] Add active threads list.
- [ ] Add terminal sessions section.
- [ ] Add safe empty/loading/offline states.
- [ ] Preserve existing tabs/routes.

Tests:

- [ ] Render loading.
- [ ] Render empty.
- [ ] Render providers/threads/sessions.
- [ ] Render safe error.

Manual:

- [ ] Chat tab works.
- [ ] Terminal tab works.
- [ ] Apps tab works.
- [ ] Canvas entry works.
- [ ] Settings works.

## Phase 7 - Thread Creation And Composer

Goal: desktop and mobile can create new coding-agent runs through the same gateway contract.

### 7.1 Shared Composer Model

- [ ] Define composer view model fields:
  - provider ID
  - prompt
  - project/task/session target
  - mode
  - approval policy
  - sandbox mode
  - attachments
- [ ] Add pure validation helpers.
- [ ] Add tests.

### 7.2 Desktop Composer

- [ ] Add global composer UI.
- [ ] Add provider picker.
- [ ] Add project/task/session target picker.
- [ ] Add create thread IPC.
- [ ] Navigate to thread on accepted create.
- [ ] Show safe create failure.

Tests:

- [ ] Composer validation.
- [ ] IPC request validation.
- [ ] Create success navigation.
- [ ] Safe failure.

### 7.3 Mobile Composer

- [ ] Add `/agents/new`.
- [ ] Add provider picker sheet.
- [ ] Add project/task/session selectors with mobile layout.
- [ ] Submit create request.
- [ ] Navigate to thread detail on accepted create.
- [ ] Preserve typed prompt when provider picker opens/closes.

Tests:

- [ ] Required prompt/provider validation.
- [ ] Create success.
- [ ] Create failure safe message.
- [ ] Keyboard/safe-area snapshot or component test where feasible.

### 7.4 Thread Event Subscription

- [ ] Desktop subscribes to thread stream on thread detail.
- [ ] Mobile subscribes to thread stream on detail route.
- [ ] Reducers handle replay + live events.
- [ ] Unknown events do not crash UI.

Tests:

- [ ] Reducer idempotency.
- [ ] Text delta accumulation.
- [ ] Tool event grouping.
- [ ] Completion status.

## Phase 8 - Approvals, Input Requests, And Attention

Goal: users can respond to provider approval and input prompts from desktop or mobile.

### 8.1 Gateway Approval Routes

- [ ] Add decision route.
- [ ] Add user input answer route.
- [ ] Add idempotency.
- [ ] Add event broadcast on resolution.
- [ ] Add expiry handling.

Tests:

- [ ] Approve.
- [ ] Approve for session when allowed.
- [ ] Decline.
- [ ] Cancel.
- [ ] Stale duplicate.
- [ ] Expired.
- [ ] Unauthorized.

### 8.2 Desktop Approval UI

- [ ] Add approval card in thread detail.
- [ ] Add approval inspector/attention badge.
- [ ] Add notification when unfocused.
- [ ] Add click-through to thread.
- [ ] Coalesce repeated notifications.

Tests:

- [ ] Approval card renders safe preview.
- [ ] Decision submit disables buttons.
- [ ] Notification payload validates.

### 8.3 Mobile Approval UI

- [ ] Add approval card/sheet in thread detail.
- [ ] Add push/local notification integration if existing push path supports it.
- [ ] Add safe decision states.
- [ ] Ensure app resume refreshes pending approvals.

Tests:

- [ ] Approval render.
- [ ] Decision submit.
- [ ] Duplicate resolved event.
- [ ] Background/resume reconciliation helper.

## Phase 9 - Terminal Binding And Cross-Shell Sessions

Goal: agent threads and project workspaces can bind to named remote terminal sessions across desktop and mobile.

### 9.1 Gateway Terminal Binding

- [ ] Add thread-to-terminal binding model.
- [ ] Add create/attach session helpers if missing.
- [ ] Add terminal session summary to thread snapshot.
- [ ] Ensure process state and attachment state remain distinct.

Tests:

- [ ] Bind existing session.
- [ ] Create new session for thread.
- [ ] Detach does not end process.
- [ ] Terminate ends process and updates summaries.

### 9.2 Desktop Terminal Panel Integration

- [ ] Add terminal panel to agent workspace.
- [ ] Reuse existing terminal runtime where possible.
- [ ] Attach only focused terminal.
- [ ] Background panels keep bounded buffer.
- [ ] Add replay gap marker.

Tests:

- [ ] Attach/detach lifecycle.
- [ ] Resize coalescing.
- [ ] Fatal `session_not_found` stops retry.

### 9.3 Mobile Terminal Integration

- [ ] Add thread terminal route linking to existing terminal client.
- [ ] Preserve existing terminal tab.
- [ ] Add from-thread attach path.
- [ ] Add resume state update.
- [ ] Add safe ended-session state.

Tests:

- [ ] Thread terminal attach.
- [ ] Existing terminal tab unaffected.
- [ ] Ended state.

### 9.4 Native Mobile Terminal Spike

- [ ] Create separate spike branch or PR.
- [ ] Evaluate native terminal rendering against SDK 57.
- [ ] Verify iOS and Android build constraints.
- [ ] Verify hardware keyboard, soft keyboard, paste, resize, ANSI, scrollback.
- [ ] Add feature flag.
- [ ] Keep WebView fallback.

Acceptance:

- [ ] No native terminal replacement lands without device validation.

## Phase 10 - Files, Review, And Diff

Goal: users can inspect files and review agent changes from both shells.

### 10.1 Gateway File Contracts

- [ ] Add/normalize browse/search/read/write file endpoints.
- [ ] Server-side path validation.
- [ ] Etag/base revision on reads.
- [ ] Conflict-safe write.
- [ ] Body limits.

Tests:

- [ ] Traversal rejected.
- [ ] Read valid file.
- [ ] Write with matching etag.
- [ ] Write conflict.
- [ ] Oversized write rejected.

### 10.2 Gateway Review Snapshot

- [ ] Add review snapshot service for thread/project/task.
- [ ] Include file list, hunks, additions/deletions, partial/truncated markers.
- [ ] Add large diff limits.
- [ ] Add safe error mapping.

Tests:

- [ ] Small diff full snapshot.
- [ ] Large diff partial snapshot.
- [ ] Binary file marker.
- [ ] Unauthorized project rejected.

### 10.3 Desktop Review Panel

- [ ] Add file list.
- [ ] Add diff renderer.
- [ ] Add hunk selection.
- [ ] Add ask-agent-follow-up action.
- [ ] Add partial diff notice.

Tests:

- [ ] Render diff.
- [ ] Render partial notice.
- [ ] Follow-up prompt context generated with structured refs.

### 10.4 Mobile Review Screens

- [ ] Add `[threadId]/review`.
- [ ] Add file navigator.
- [ ] Add hunk rendering.
- [ ] Add follow-up action.
- [ ] Ensure large diffs remain scrollable.

Tests:

- [ ] Render changed files.
- [ ] Render hunk.
- [ ] Partial notice.
- [ ] Follow-up action.

## Phase 11 - Preview And App Runtime Integration

Goal: agent workspaces can open safe previews and Matrix apps without weakening existing embed/session isolation.

### 11.1 Preview Summary

- [ ] Add preview capability to runtime summary.
- [ ] List running local dev servers or app previews safely.
- [ ] Use origin allowlist.
- [ ] Return coarse health.

Tests:

- [ ] Safe preview listed.
- [ ] Foreign origin rejected.
- [ ] Health failure safe.

### 11.2 Desktop Preview Panel

- [ ] Reuse existing embed/session isolation.
- [ ] Add preview panel in workspace.
- [ ] Add reload/open-external controls.
- [ ] Validate navigation.

Tests:

- [ ] Launch safe preview.
- [ ] Reject unsafe URL.
- [ ] Embedded auth failure does not sign out native session.

### 11.3 Mobile Preview

- [ ] Add preview route/screen using existing app runtime frame patterns.
- [ ] Validate launch URLs.
- [ ] Provide fallback to open in external browser only for safe HTTPS links.
- [ ] Preserve app launcher behavior.

Tests:

- [ ] Safe preview route.
- [ ] Unsafe URL rejected.
- [ ] Return to thread.

## Phase 12 - Notifications And Attention Routing

Goal: users are notified when agent work completes, fails, or needs input, and click-through focuses the correct shell target.

### 12.1 Attention Model

- [ ] Add attention state to thread summary.
- [ ] Add attention event types.
- [ ] Add coalescing rules.
- [ ] Add read/ack behavior if needed.

Tests:

- [ ] Attention derived from approval request.
- [ ] Attention clears on approval resolution.
- [ ] Completion notification created once.

### 12.2 Desktop Notifications

- [ ] Map thread attention/completion to native notifications.
- [ ] Validate click payload.
- [ ] Focus existing window.
- [ ] Navigate to thread.
- [ ] Set badge count for active attention.

Tests:

- [ ] Payload schema rejects invalid thread IDs.
- [ ] Coalescing.

### 12.3 Mobile Notifications

- [ ] Evaluate existing push/local notification path.
- [ ] Add notification type for thread attention if supported.
- [ ] Ensure tapping notification opens thread safely after auth.
- [ ] If unsupported in first phase, show in-app attention only and document follow-up.

Tests:

- [ ] Notification payload parser.
- [ ] Stale target fallback.

## Phase 13 - Desktop Polish And Power User Flow

Goal: desktop feels like a high-quality developer cockpit.

### 13.1 Keyboard Flow

- [ ] Command palette actions:
  - New agent thread.
  - Open thread.
  - Open project.
  - Open terminal.
  - Open review.
  - Open provider setup.
- [ ] Shortcuts for terminal focus, composer, thread list, review, file search.
- [ ] Menu entries for agent workspace.

Tests:

- [ ] Shortcut/command model helpers.
- [ ] Command availability by runtime capability.

### 13.2 Workspace Layout

- [ ] Add resizable panel strip.
- [ ] Persist per-project/task/thread layout.
- [ ] Use LRU for heavy live panels.
- [ ] Respect minimum widths.
- [ ] Avoid card-inside-card layout.

Tests:

- [ ] Layout parser.
- [ ] Stale panel references dropped.
- [ ] LRU releases background live sockets.

### 13.3 Settings

- [ ] Add provider settings section.
- [ ] Show install/auth status.
- [ ] Open foreground setup terminal.
- [ ] Refresh health.
- [ ] Keep existing account/runtime/billing/integration settings.

Tests:

- [ ] Provider setting state.
- [ ] Setup action validation.

## Phase 14 - Mobile Polish And Daily Use

Goal: mobile becomes a strong day-to-day interface, not just a companion viewer.

### 14.1 Recent Work Home

- [ ] Add recent active threads.
- [ ] Add pending approvals.
- [ ] Add running terminal sessions.
- [ ] Add provider setup warnings.
- [ ] Add quick new prompt.

Tests:

- [ ] Recent work sorting.
- [ ] Pending approval prominence.

### 14.2 Thread Detail UX

- [ ] Improve transcript rendering.
- [ ] Group tool activity.
- [ ] Add jump to latest.
- [ ] Add status/attention banner.
- [ ] Add follow-up composer.
- [ ] Add terminal/review/files actions.

Tests:

- [ ] Transcript reducer/rendering.
- [ ] Tool group collapsed/expanded state.

### 14.3 Mobile Ergonomics

- [ ] Keyboard avoidance.
- [ ] Safe area support.
- [ ] Landscape support.
- [ ] Offline/reconnecting banners.
- [ ] Pull-to-refresh summary.
- [ ] Haptics for successful approval/submit where appropriate.

Tests:

- [ ] Layout helper tests where possible.
- [ ] Manual device checklist.

## Phase 15 - Public Docs And Developer Guides

Goal: users and future agents can understand and extend the feature.

### 15.1 Internal Developer Guide

- [ ] Add docs for contracts, event reducers, provider adapters, terminal binding, approval flow, and client state ownership.
- [ ] Include examples of adding a new provider.
- [ ] Include examples of adding a new thread event type.
- [ ] Include security checklist.

Suggested path:

- [ ] `docs/dev/coding-agent-shells.md`

### 15.2 Public Docs

- [ ] Add or update public docs under `www/content/docs/`.
- [ ] Explain desktop/mobile coding-agent workflows.
- [ ] Explain remote Matrix computer model without implementation secrets.
- [ ] Explain provider setup at a user level.
- [ ] Explain terminal/session continuity.

### 15.3 Operator Runbook

- [ ] Add support notes for provider setup failures.
- [ ] Add runtime offline troubleshooting.
- [ ] Add mobile SDK/native terminal validation notes if native terminal lands.
- [ ] Keep private/customer identifiers out of public repo docs.

## Phase 16 - End-To-End Validation

Goal: prove cross-shell coding-agent workflows before broad rollout.

### 16.1 E2E Scenarios

- [ ] Desktop sign in -> create thread -> stream completion.
- [ ] Mobile sign in -> open same thread -> send follow-up.
- [ ] Desktop approval request -> mobile approves -> desktop sees resolved.
- [ ] Desktop creates terminal -> mobile attaches -> desktop reattaches.
- [ ] Agent changes file -> desktop review -> mobile review.
- [ ] Runtime switch -> old streams close -> new summary hydrates.
- [ ] Network loss -> replay resumes without duplicate terminal output.
- [ ] Provider setup required -> foreground terminal setup -> provider appears available.

### 16.2 Security Validation

- [ ] Unauthenticated routes reject.
- [ ] Invalid IDs reject.
- [ ] Path traversal rejects.
- [ ] Oversized frame rejects.
- [ ] Oversized prompt/attachment rejects.
- [ ] WebSocket auth setup awaited before success.
- [ ] Subscriber cap enforced.
- [ ] Safe errors only in UI.
- [ ] Desktop renderer never receives credential.
- [ ] Mobile persisted state contains no sensitive data.

### 16.3 Performance Validation

- [ ] Runtime summary p95 under target.
- [ ] Thread event reduction remains responsive for long transcripts.
- [ ] Terminal output ring buffer caps memory.
- [ ] Desktop with multiple cached workspaces stays responsive.
- [ ] Mobile thread detail scroll remains responsive.
- [ ] Large diff opens partial view instead of freezing.

## Phase 17 - Rollout And Cleanup

### 17.1 Flag Rollout

- [ ] Enable read-only summary in dev.
- [ ] Enable desktop dashboard in dev.
- [ ] Enable mobile dashboard in dev.
- [ ] Enable thread creation for internal users.
- [ ] Enable approvals.
- [ ] Enable review/preview.
- [ ] Enable native terminal only after spike and fallback validation.

### 17.2 Compatibility Cleanup

- [ ] Remove temporary compatibility adapters only after all clients migrate.
- [ ] Keep old route aliases until release notes and host-bundle compatibility are clear.
- [ ] Document deprecations.
- [ ] Verify host-bundle and app-shell deployment implications.

### 17.3 Release Checklist

- [ ] Host-bundle build path documented if gateway/shell changes affect customer VPS.
- [ ] Platform/app-shell deployment path documented if pre-VPS auth/settings surfaces changed.
- [ ] Desktop release channel impact documented.
- [ ] Mobile SDK 57 native build impact documented.
- [ ] Rollback path documented.

## Phase 18 - Project, Task, Thread, And Turn Contracts

Goal: make the clarified hierarchy explicit and independently testable before runtime/UI changes.

### 18.1 Shared Project Workspace Contracts

- [x] Add bounded project summary counts for tasks, threads, and attention.
- [x] Add canonical `TaskAgentSummarySchema` using existing Matrix task status/priority values.
- [x] Add bounded `ProjectAgentWorkspaceSchema` with independent task/thread caps and truncation metadata.
- [x] Add thread list filters for required `projectId` and optional `taskId`.
- [x] Keep legacy unassigned thread read filters explicit and bounded.
- [x] Enforce no new shell-created unassigned threads in Phase 19 (`GW-009`) after real project hydration exists.

Tests: `CT-001`, `CT-002`, `CT-003`, `CT-004`.

### 18.2 Same-Thread Turn Contracts

- [x] Add `AgentTurnIdSchema`, `CreateAgentTurnRequestSchema`, and `CreateAgentTurnResponseSchema`.
- [x] Bound message, attachments, idempotency key, and safe errors.
- [x] Add turn lifecycle event contracts without exposing provider resume identity.
- [x] Add capability IDs for project workspace projection, same-thread turns, and Conversation/Kanban shells.

Tests: `CT-005`, `CT-006`, `CT-007`.

Gate:

- [x] Gate 1 rerun passes for the additive contracts (`CT-001` through `CT-007`).

Maintenance boundary: `packages/contracts/src/index.ts` is now a 1,000+ line schema-only barrel. Before adding another coding-agent contract family, extract the coding-agent schemas into focused domain modules while preserving the package's existing root exports.

## Phase 19 - Gateway Project Workspace Read Model

Goal: replace placeholder project hydration with canonical owner project/task/thread projections.

### 19.1 Real Project Summary Adapter

- [x] Read canonical owner projects through the existing workspace project service.
- [x] Return stable bounded project summaries from runtime summary.
- [x] Expose safe degraded state when project discovery fails; never return raw errors.
- [x] Add timeout/abort handling for project summary dependencies.

Tests: `GW-001`, `GW-002`, `GW-003`.

### 19.2 Project Workspace Projection

- [x] Add authenticated `GET /api/coding-agents/projects/:projectId/workspace`.
- [x] Validate project path param and independent task/thread cursors/limits with Zod 4.
- [x] Enforce owner access before reading tasks or threads.
- [x] Join canonical tasks with bounded project-level/task-bound thread aggregates.
- [x] Support several threads on one task without nested unbounded arrays.
- [x] Reject/quarantine stale cross-project relations without mutating during a read.

Tests: `GW-004`, `GW-005`, `GW-006`, `GW-007`, `GW-008`.

### 19.3 Task/Thread Relation Mutations

- [x] Require valid project for new shell-created threads.
- [x] Validate optional task exists in the same project before thread insert.
- [x] Add explicit idempotent thread reassignment only if required for legacy adoption.
- [x] Publish project/task/thread projection updates after successful persistence.

Tests: `GW-009`, `GW-010`, `GW-011`.

Gate:

- [x] Gate 2 rerun proves real project hydration, caps, auth, validation, and safe errors.

## Phase 20 - Same-Thread Provider Turns

Goal: sending a message in an existing chat resumes that chat's provider conversation.

### 20.1 Turn Store And Route

- [x] Add authenticated `POST /api/coding-agents/threads/:threadId/turns`.
- [x] Apply body limit before JSON parsing and validate all params/body with Zod 4.
- [x] Check thread ownership, project/task integrity, and terminal thread state.
- [x] Insert user turn/event and idempotency record atomically.
- [x] Atomically claim one active normal turn per thread; return safe busy conflict otherwise.
- [x] Persist idempotency and active-turn ownership in the existing owner thread store's atomic mutation path; no client or in-memory-only source of truth.
- [x] Cap/evict any in-memory idempotency or dispatch registry and drain it on shutdown.

Tests: `GW-012`, `GW-013`, `GW-014`, `GW-015`, `SEC-001`, `SEC-002`.

Maintenance boundary: `thread-store.ts` is already over 1,000 lines. Phase 20.2 must extract the normalized provider adapter boundary and bounded turn-dispatch registry into focused modules; provider dispatch behavior must not be added inline to this store.

### 20.2 Provider Resume

- [x] Extend normalized provider adapter with a bounded `resumeTurn` operation and `AbortSignal`.
- [x] Keep provider credentials/resume identity on the runtime.
- [x] Persist resume identity/state before publishing idle/completed state.
- [x] Release active-turn ownership on completion, failure, abort, and startup reconciliation.
- [x] Verify one thread receives two sequential turns without creating a second provider conversation.

Tests: `GW-016`, `GW-017`, `GW-018`, `SEC-005`, `E2E-001`.

Gate:

- [ ] Gate 3 rerun passes with fake provider and first flagged real provider.

## Phase 21 - Desktop Project Conversation And Kanban

Goal: replace the checkpoint dashboard with the confirmed project-first desktop workspace.

### 21.1 Project/Task/Thread Navigator

- [ ] Add persistent project groups in the left navigator.
- [ ] Render project-level threads and task groups.
- [ ] Render every thread under a task; do not infer cardinality from singular `linkedSessionId`.
- [ ] Add new-chat action with required project and optional task/provider.
- [ ] Reconcile persisted selected project/task/thread against live projections.
- [ ] Keep renderer bearer/provider credentials absent through trusted IPC.

Tests: `DT-001`, `DT-002`, `DT-003`, `DT-004`, `SEC-003`.

### 21.2 Conversation View

- [ ] Render selected same-thread transcript, attention, approvals, terminal, files, review, and preview context.
- [ ] Send follow-up through the turn IPC, not thread create.
- [ ] Keep explicit "new chat from context" separate from same-thread send.
- [ ] Handle busy/idempotent/offline states with generic recovery copy.

Tests: `DT-005`, `DT-006`, `DT-007`.

### 21.3 Kanban View

- [ ] Add segmented Conversation/Kanban control.
- [ ] Reuse canonical task columns/order/mutations.
- [ ] Show bounded thread count, active count, and attention count on task cards.
- [ ] Open all task threads from a card and preserve selected identity when switching modes.
- [ ] Never auto-move task status from thread reducer/effects.

Tests: `DT-008`, `DT-009`, `DT-010`, `DT-011`.

Gate:

- [ ] Desktop typecheck, focused Vitest, operator E2E, Canvas/Desktop regression, pattern scan, and screenshot checks pass.

## Phase 22 - Mobile Project Conversation And Kanban

Goal: expose the same hierarchy and conversations with SDK 57 phone/tablet ergonomics.

### 22.1 Project-First Routes And Resume

- [ ] Add project route/selector and project workspace hydration.
- [ ] Render task groups with all attached threads plus project-level threads.
- [ ] Persist only bounded project/task/thread/view references.
- [ ] Reconcile stale references on app resume/runtime switch.

Tests: `MB-001`, `MB-002`, `MB-003`, `MB-004`, `SEC-004`.

### 22.2 Conversation View

- [ ] Send follow-ups to the selected thread turn route.
- [ ] Preserve keyboard avoidance, safe areas, app suspension, streaming, and approval/input behavior.
- [ ] Keep terminal handoff on canonical named sessions.

Tests: `MB-005`, `MB-006`, `MB-007`.

### 22.3 Kanban View

- [ ] Add Conversation/Kanban control for the selected project.
- [ ] Render canonical task columns as phone-appropriate sections/horizontal board and tablet split view.
- [ ] Show bounded multi-thread aggregates and open any thread on a task.
- [ ] Preserve selected context when returning to Conversation.

Tests: `MB-008`, `MB-009`, `MB-010`.

Gate:

- [ ] Mobile Jest, lint, `tsc --noEmit`, SDK 57 dev-client device smoke, and existing tab/terminal/app/auth regressions pass.

## Phase 23 - Final Cross-Shell Acceptance

- [ ] Desktop creates a project task and two independent chats on it; mobile sees both (`E2E-002`).
- [ ] Mobile sends a second turn in one chat; desktop sees the same thread/provider conversation (`E2E-003`).
- [ ] Conversation/Kanban switching preserves project/task/thread identity on both shells (`E2E-004`).
- [ ] Task status mutations propagate without being overwritten by mixed thread states (`E2E-005`).
- [ ] Cross-shell terminal, review, preview, approval, notification, offline/reconnect, and runtime-switch paths pass (`E2E-006`).
- [ ] Security and unsafe-error audit passes (`SEC-001` through `SEC-006`).
- [ ] Public/internal docs update only after behavior is implemented and verified; until then public docs are explicitly deferred to avoid advertising unshipped behavior.
- [ ] `completion-audit.md` has current evidence for every clarified requirement.
- [ ] Product owner performs final desktop/mobile checkpoint test and confirms release readiness.

## Cross-Cutting Guardrails

### Do

- [ ] Build shared contracts first.
- [ ] Keep runtime source of truth server-side.
- [ ] Use feature flags.
- [ ] Reuse existing terminal/session routes where possible.
- [ ] Reuse existing desktop auth/embed/updater patterns.
- [ ] Reuse existing mobile auth/offline/persistence patterns.
- [ ] Add pure reducers for event state.
- [ ] Make every stream resumable.
- [ ] Cap every list, cache, buffer, and subscriber set.
- [ ] Prefer additive migrations.

### Do Not

- [ ] Do not put provider-specific branching into mobile/desktop UI when the gateway can normalize it.
- [ ] Do not show raw provider command output as errors.
- [ ] Do not store terminal output or transcripts in mobile AsyncStorage.
- [ ] Do not pass bearer credentials through desktop renderer.
- [ ] Do not create a second terminal session model just for agent threads.
- [ ] Do not make desktop/mobile required for the kernel to work.
- [ ] Do not break Canvas or current mobile launcher behavior.
- [ ] Do not replace mobile terminal rendering without fallback.
- [ ] Do not introduce new persistence tech for this feature.
- [ ] Do not hide interactive provider setup in a background job when the user needs to act.

## Suggested PR Slices

The original slices below document the landed foundation. The active next stack is Phase 18 through Phase 23 and must start only after Gate 0 confirmation.

1. **contracts(agent-shells): add schemas and tests**
   - Contract package or gateway-local contracts only.
   - No runtime behavior.

2. **feat(gateway): expose read-only coding agent summary**
   - Runtime summary route.
   - Provider/session adapters.
   - Focused tests.

3. **feat(desktop): add read-only agent workspace**
   - Trusted-core summary IPC.
   - Renderer dashboard.
   - Feature flag.

4. **feat(mobile): add read-only agent workspace**
   - Summary client.
   - Recent work screen.
   - State reconciliation.

5. **feat(gateway): create and stream agent threads**
   - Thread store/events/routes/WS.
   - Fake provider tests.

6. **feat(desktop): create and monitor agent threads**
   - Composer.
   - Thread detail stream.
   - Reducer tests.

7. **feat(mobile): create and monitor agent threads**
   - Mobile composer.
   - Thread detail stream.
   - Reducer tests.

8. **feat(agents): support approvals and input requests**
   - Gateway lifecycle.
   - Desktop/mobile UI.
   - Idempotency tests.

9. **feat(agents): bind terminal sessions to threads**
   - Gateway binding.
   - Desktop/mobile terminal integration.

10. **feat(review): add file and diff review surfaces**
    - Gateway review snapshots.
    - Desktop review panel.
    - Mobile review route.

11. **feat(preview): add workspace preview integration**
    - Safe previews.
    - Desktop panel.
    - Mobile screen.

12. **feat(notifications): route agent attention**
    - Desktop native notifications.
    - Mobile notification path or documented in-app-only first stage.

13. **docs(agent-shells): publish developer and user docs**
    - Internal developer guide.
    - Public docs.
    - Support notes.

## Open Questions

Resolved by the product clarification checkpoint:

- [x] One visible chat/session is one resumable coding-agent thread.
- [x] One task may own several independent coding-agent threads.
- [x] Conversation and Kanban are two views over the same canonical project/task/thread records.
- [x] A normal follow-up is a new turn in the same thread; creating a new related chat is a separate explicit action.
- [x] Existing Matrix project/task APIs and task statuses remain canonical.

Awaiting product-owner confirmation before Phase 18 implementation:

- [ ] New chats require a project; legacy unassigned chats remain read-compatible under `Unassigned`.
- [ ] Task status is explicit/manual canonical state; mixed thread states only change card badges/attention.
- [ ] A busy thread rejects another normal turn instead of silently queueing it.
- [ ] Both desktop and mobile expose Conversation and Kanban as primary agent-workspace modes.

Resolved implementation questions:

- [x] Canonical project/task records remain in existing workspace services; coding threads remain in the gateway/runtime thread store until a separately reviewed owner-persistence migration.
- [x] Existing workspace-backed provider tests remain the fake/baseline path; real providers stay behind normalized server-side adapters and flags.
- [x] Desktop trusted core owns authenticated thread streams and bridges validated events to the renderer.
- [x] Mobile uses the `/agents` stack without replacing existing Mission Control or tabs.
- [x] Public docs for the clarified UX are deferred until implementation/runtime verification, so unshipped behavior is not advertised.

Historical questions retained for unrelated future work:

- [ ] Does the current terminal WebSocket already carry monotonic sequence numbers in all environments, or do we need a compatibility replay adapter?
- [ ] Which provider setup actions must be foreground terminal sessions because they need user interaction?
- [ ] What is the safe cap for active thread event subscribers per runtime?
- [ ] What are the exact memory limits for desktop cached workspaces and mobile transcript windows?
- [ ] When native mobile terminal lands, which devices and OS versions are required for validation?
