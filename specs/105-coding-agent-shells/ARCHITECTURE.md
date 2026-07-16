# Architecture: Coding Agent Shells

**Status**: Gate 0 confirmed; Phase 18 implementation active
**Last Updated**: 2026-07-10
**Audience**: Agents implementing gateway, desktop, mobile, shell, and runtime changes.

## Design Thesis

Matrix OS should have one headless coding-agent runtime and many shells. Desktop, mobile, browser shell, CLI, and future channels render the same runtime state through shell-appropriate interfaces.

Do not create separate "desktop agent threads" or "mobile terminal sessions." Create owner-scoped runtime primitives behind the gateway, then build clients as resumable projections over those primitives.

## Architecture Pattern

### Selected Pattern

**Headless Runtime + Typed Gateway Contracts + Thin Shells**

```
Desktop Renderer       Mobile App         Browser Shell          CLI
       |                   |                   |                  |
       v                   v                   v                  v
Validated IPC       Typed Gateway Client  Typed Gateway Client  CLI Client
       |                   |                   |                  |
       v                   v                   v                  v
Desktop Trusted Core -----> Matrix Gateway HTTP/WS <-------------+
                              |
                              v
                 Runtime Services on Matrix Computer
          Agent providers, terminal sessions, files, diffs,
          previews, app runtime, source control, activity log
                              |
                              v
                 Owner files + owner PostgreSQL + project repos
```

### Key Characteristics

- **Source of truth**: Matrix computer runtime, owner files, owner PostgreSQL, and repositories.
- **Contracts**: Zod 4 schemas at every public boundary. Export inferred types for clients.
- **Transport**: HTTP for commands/snapshots, WebSocket streams for terminal/thread/runtime events.
- **Client state**: bounded, serializable UI state; no local source-of-truth copies.
- **Desktop trust boundary**: Electron main/preload are trusted; renderer is not trusted.
- **Mobile trust boundary**: mobile app JS can hold short-lived session material according to existing auth design, but never provider credentials or raw privileged tokens.
- **Failure model**: reconnect and resume by cursor/reference; distinguish runtime process state from client attachment state.

## Canonical Domain Model

The shells use one hierarchy and must not reinterpret a provider process, terminal process, task, and conversation as the same object.

```text
Project 1 ── * Task
Project 1 ── * AgentThread
Task    1 ── * AgentThread
AgentThread 1 ── * AgentTurn
AgentThread * ── 0..1 TerminalSession (reference only)
```

Rules:

- `Project` and `Task` remain the existing Matrix workspace records and APIs.
- `AgentThread` is the visible chat/session and stable provider conversation identity.
- `AgentTurn` is one idempotent user message/provider execution inside a thread.
- New threads require a valid owner project. `taskId` is optional, but when present its canonical `projectSlug` must equal `thread.projectId`.
- A task owns an unbounded logical history but every API projection is capped/paginated. Multiple threads per task are normal.
- A thread has at most one active normal turn. Approval and requested-input responses are correlated actions within that active turn, not new turns.
- A provider resume token/session ID is encrypted or owner-local runtime state and never appears in shell contracts.
- Task status and thread status are independent. Kanban cards aggregate thread status for display but only explicit task mutations change task columns.

### Read Models

First hydration stays small:

```ts
type RuntimeSummary = {
  runtime: RuntimeTarget;
  capabilities: RuntimeCapability[];
  providers: AgentProviderSummary[];
  projects: BoundedList<ProjectSummary>;
  activeThreads: BoundedList<AgentThreadSummary>;
  attentionThreads: BoundedList<AgentThreadSummary>;
  terminalSessions: BoundedList<TerminalSessionSummary>;
  previewSessions: BoundedList<PreviewSessionSummary>;
  recentActivity: BoundedList<ActivityEventSummary>;
  limits: RuntimeLimits;
  serverTime: string;
};
```

Selecting a project loads a separate bounded projection:

```ts
type ProjectAgentWorkspace = {
  project: ProjectSummary;
  tasks: BoundedList<TaskAgentSummary>;
  projectThreads: BoundedList<AgentThreadSummary>;
  taskThreads: BoundedList<AgentThreadSummary>;
  updatedAt: string;
};
```

`TaskAgentSummary` contains canonical task metadata plus bounded aggregates (`threadCount`, status counts, attention count, latest activity), not nested full transcripts or an unbounded thread array. Thread rows are fetched/filterable by `projectId` and optional `taskId`.

## Package And Module Plan

### New Or Expanded Contract Package

Preferred path:

```
packages/contracts/
  package.json
  tsconfig.json
  src/
    ids.ts
    runtime.ts
    agents.ts
    threads.ts
    approvals.ts
    terminal.ts
    files.ts
    review.ts
    preview.ts
    activity.ts
    errors.ts
    index.ts
```

If adding a package is too large for the first PR, start inside `packages/gateway/src/contracts/` and move to `packages/contracts` in a follow-up. The end state should be a package imported by gateway, shell, desktop, mobile, and tests.

Rules:

- Use `zod/v4`.
- Export both schemas and inferred types.
- Keep contracts schema-only; no runtime service logic.
- Avoid barrel files that hide ownership if the repo pattern discourages them. If using `index.ts`, export only stable public schemas.
- Use additive versioning: `AgentThreadEventV1`, `TerminalFrameV1`, etc. when changing existing frames.
- Tests must parse representative payloads and reject malformed/oversized payloads.

### Gateway Runtime Modules

Recommended layout:

```
packages/gateway/src/coding-agents/
  contracts.ts              # Re-exports shared schemas if package not created yet
  routes.ts                 # HTTP route registration
  ws.ts                     # Thread/runtime WebSocket handlers
  runtime-summary.ts        # Hydration projection
  project-workspace.ts      # Canonical project/task/thread read projection
  provider-registry.ts      # Configured providers and health
  thread-store.ts           # Thread CRUD/projections
  turn-service.ts           # Same-thread turn idempotency and active-turn lock
  thread-events.ts          # Append/read/replay event model
  approval-service.ts       # Approval lifecycle and idempotency
  terminal-binding.ts       # Thread/session relationships
  review-service.ts         # Diff snapshots and limits
  preview-service.ts        # Preview coordination where not already covered
  safe-errors.ts            # Error mapper
```

This module should integrate with existing `agent-session-manager.ts`, `dispatcher.ts`, `preview-manager.ts`, terminal routes, workspace events, and onboarding agent credential routes instead of replacing them.

### Desktop Modules

Recommended layout:

```
desktop/src/shared/
  ipc-contract.ts           # Expand or compose coding-agent IPC schemas
  coding-agent-contract.ts  # Optional if IPC file becomes too large

desktop/src/main/
  runtime/runtime-client.ts      # Gateway HTTP/WS client in trusted core
  runtime/runtime-session.ts     # Runtime selection, reconnect, token expiry
  runtime/stream-registry.ts     # Bounded WS stream ownership
  notifications/agent-events.ts  # Notification mapping

desktop/src/renderer/src/features/agents/
  AgentMissionControl.tsx
  AgentNavigator.tsx
  AgentViewModeControl.tsx
  AgentConversationView.tsx
  AgentKanbanView.tsx
  TaskThreadList.tsx
  AgentProviderPicker.tsx
  AgentComposer.tsx
  AgentThreadList.tsx
  AgentThreadView.tsx
  ApprovalCard.tsx
  RuntimeStatus.tsx

desktop/src/renderer/src/features/workspace/
  ProjectWorkspace.tsx
  WorkspacePanelStrip.tsx
  FilePanel.tsx
  ReviewPanel.tsx
  PreviewPanel.tsx
  ActivityTimeline.tsx
```

Rules:

- Renderer uses typed IPC/preload APIs, not direct privileged credential access.
- Main process owns bearer injection, embedded session handoff, runtime switching, and trusted launch token handling.
- Renderer stores only UI state in Zustand or local stores.
- Every IPC channel validates request and response.
- Keep existing desktop features: embeds, auth, settings, updater, menu, notifications, window state.

### Mobile Modules

Recommended layout for Expo SDK 57:

```
apps/mobile/lib/
  runtime-client.ts          # Typed HTTP/WS gateway client wrapper
  coding-agent-contract.ts   # Re-export shared types or local import facade
  agent-state.ts             # Reducers/helpers, pure and tested
  thread-events.ts           # Parse/reduce thread events
  approval-state.ts          # Approval reducer/helpers
  workspace-state.ts         # Project/thread/session resume helpers

apps/mobile/components/agents/
  AgentProviderPicker.tsx
  AgentComposer.tsx
  AgentThreadCard.tsx
  AgentStatusPill.tsx
  ApprovalCard.tsx
  ToolActivity.tsx

apps/mobile/app/agents/
  index.tsx                  # Project-first workspace entry
  projects/[projectId]/index.tsx  # Project conversation/task list
  projects/[projectId]/board.tsx  # Phone/tablet Kanban projection
  new.tsx                    # New project-bound conversation
  [threadId].tsx             # Thread detail
  [threadId]/review.tsx
  [threadId]/files.tsx
  [threadId]/terminal.tsx

apps/mobile/modules/
  matrix-terminal-native/    # Future native terminal module after spike
```

Rules:

- Preserve existing routes and tabs. Add new routes; do not break current imports.
- Keep current WebView terminal as fallback until native terminal is proven.
- Every persisted reference in AsyncStorage must pass a parser and reconcile with live runtime state.
- Use reducers for thread/terminal state transitions; unit-test reducers.
- Use phone-first layouts: list -> detail -> sheet, not dense desktop panels.
- Treat app backgrounding as expected. Reconnect from runtime summary and stream cursors.
- Keep all task/thread collections capped. AsyncStorage stores only selected project/task/thread/view references.

### Browser Shell Modules

The browser shell should consume the same contracts so Canvas/Desktop and mobile web routes do not drift.

Recommended areas:

```
shell/src/lib/coding-agents/
  client.ts
  contracts.ts
  reducers.ts
  runtime-summary.ts

shell/src/components/agents/
  ...
```

Canvas and Desktop shell modes must both route built-in agent/workspace paths correctly. Do not let built-in `__...` paths fall through to file/app viewers.

## Contract Sketches

These sketches are intentionally precise enough for implementation tests, but final code should live in Zod schemas.

### IDs

Use branded or schema-validated string aliases:

- `runtimeId`: `rt_[A-Za-z0-9_-]{1,128}` or existing runtime slot ID if already canonical.
- `providerId`: safe slug, lower-case preferred.
- `projectId`: existing project slug/ID contract.
- `taskId`: `task_[A-Za-z0-9_-]{1,128}` or existing task ID.
- `threadId`: `thread_[A-Za-z0-9_-]{1,128}`.
- `turnId`: `turn_[A-Za-z0-9_-]{1,128}`.
- `eventId`: `evt_[A-Za-z0-9_-]{1,128}`.
- `approvalId`: `appr_[A-Za-z0-9_-]{1,128}`.
- `terminalSessionId`: existing named session/UUID schema; do not invent a second ID if canonical names already exist.

### Runtime Summary

```ts
type RuntimeSummary = {
  runtime: RuntimeTarget;
  capabilities: RuntimeCapability[];
  providers: AgentProviderSummary[];
  projects: BoundedList<ProjectSummary>;
  activeThreads: BoundedList<AgentThreadSummary>;
  attentionThreads: BoundedList<AgentThreadSummary>;
  terminalSessions: BoundedList<TerminalSessionSummary>;
  previewSessions: BoundedList<PreviewSessionSummary>;
  recentActivity: BoundedList<ActivityEventSummary>;
  serverTime: string;
  limits: RuntimeLimits;
};
```

Rules:

- Summary is bounded and safe for first hydration.
- Include `hasMore` or cursors where lists are truncated.
- Include capability flags so clients do not assume unavailable features.
- Include `serverTime` so clients can reason about expiry without trusting local clock.

### Project And Task Projection

```ts
type ProjectSummary = {
  id: string;
  label: string;
  status: "available" | "missing" | "stale" | "unknown";
  taskCount: number;
  threadCount: number;
  attentionCount: number;
  updatedAt?: string;
};

type TaskAgentSummary = {
  id: string;
  projectId: string;
  title: string;
  status: "todo" | "running" | "waiting" | "blocked" | "complete" | "archived";
  priority: "low" | "normal" | "high" | "urgent";
  order: number;
  threadCount: number;
  activeThreadCount: number;
  attentionCount: number;
  latestThreadAt?: string;
  revision?: number;
};

type ProjectAgentWorkspace = {
  project: ProjectSummary;
  tasks: BoundedList<TaskAgentSummary>;
  projectThreads: BoundedList<AgentThreadSummary>;
  taskThreads: BoundedList<AgentThreadSummary>;
  updatedAt: string;
};
```

Rules:

- Project/task values come from canonical workspace services, not renderer stores.
- Counts are bounded non-negative integers and may carry a `hasMore`/truncated signal when exact aggregation is intentionally capped.
- Project workspace lists sort deterministically by canonical task order, then stable ID.
- Task mutation remains on the existing validated project task route; coding-agent routes provide relations/read projections and thread actions.

### Agent Provider

```ts
type AgentProviderSummary = {
  id: string;
  displayName: string;
  adapterFamily: "built_in" | "custom_acp";
  protocol: "native_cli" | "app_server" | "acp" | "mcp" | "shell_bridge";
  supportTier: "first_class" | "compatibility";
  availability: "available" | "setup_required" | "auth_required" | "installing" | "unavailable" | "unknown";
  installStatus: "installed" | "missing" | "installing" | "failed" | "unknown";
  authStatus: "authenticated" | "missing" | "expired" | "unknown";
  executionReady: boolean;
  capabilities: AgentProviderCapabilities;
  supportedModes: Array<"default" | "plan" | "review" | "full_access">;
  defaultMode: "default" | "plan" | "review" | "full_access";
  defaultModel?: string;
  setupActions: SafeSetupAction[];
  lastCheckedAt?: string;
};
```

Guidance:

- `displayName` is safe UI text controlled by the server.
- Provider IDs are stable registry IDs. Protocol, release tier, readiness, and
  operation capabilities are separate validated fields; no closed brand union
  or executable detection implies support.
- Custom ACP-compatible profiles complete a bounded handshake/version and
  capability negotiation. A user-controlled label cannot grant a built-in
  provider identity or capabilities.
- `setupActions` should contain safe action IDs and labels, not raw arbitrary commands unless explicitly marked as foreground terminal actions.
- Health checks must be timeout-bound.

### Thread Create

```ts
type CreateAgentThreadRequest = {
  providerId: string;
  prompt: string;
  projectId: string;
  taskId?: string;
  terminalSessionId?: string;
  worktreeId?: string;
  mode?: "default" | "plan" | "review" | "full_access";
  approvalPolicy?: "untrusted" | "on_request" | "on_failure" | "never";
  sandboxMode?: "read_only" | "workspace_write" | "full_access";
  attachments?: AgentAttachment[];
  clientRequestId: string;
};
```

Rules:

- `clientRequestId` makes create idempotent.
- Prompt and attachments are bounded.
- Provider/mode/sandbox/approval combinations are validated server-side.
- Create should return accepted thread snapshot quickly; streaming happens separately.
- New shell requests require `projectId`; compatibility parsing may accept legacy unassigned records on reads only.
- If `taskId` is present, the gateway resolves the task and enforces project ownership/match before inserting the thread and first event.

### Same-Thread Turn

```ts
type CreateAgentTurnRequest = {
  message: string;
  attachments?: AgentAttachment[];
  clientRequestId: string;
};

type CreateAgentTurnResponse = {
  threadId: string;
  turnId: string;
  status: "accepted" | "already_accepted";
  acceptedAt: string;
};

type CreateAgentTurnErrorCode =
  | "thread_busy"
  | "thread_not_found"
  | "turn_unavailable";
```

Route: `POST /api/coding-agents/threads/:threadId/turns`.

Rules:

- Authenticate, validate body under the same prompt/attachment limits, check ownership, and apply `bodyLimit` before parsing.
- Enforce idempotency on `(ownerId, threadId, clientRequestId)` in the same persistence transaction as the user-turn event.
- Enforce one active normal turn through an atomic compare/update or owner/thread lock. Return HTTP 409 with `SafeClientErrorSchema.code = "thread_busy"` and generic recovery copy when another turn is active; do not queue silently.
- Return `thread_not_found` only through the existing owner-safe not-found mapping, and `turn_unavailable` for a generic non-busy state that cannot accept a turn. No turn error includes provider, path, database, token, or resume details.
- Resume the thread's server-owned provider identity. Provider credentials and resume tokens never cross HTTP/WS/IPC contracts.
- Publish accepted/status events only after persistence succeeds.

### Thread Events

```ts
type AgentThreadEvent =
  | { type: "thread.created"; eventId: string; thread: AgentThreadSummary }
  | { type: "thread.status"; eventId: string; threadId: string; status: AgentThreadStatus }
  | { type: "assistant.text.delta"; eventId: string; threadId: string; messageId: string; delta: string }
  | { type: "assistant.text.completed"; eventId: string; threadId: string; messageId: string }
  | { type: "tool.started"; eventId: string; threadId: string; toolCallId: string; displayName: string; kind: string }
  | { type: "tool.output"; eventId: string; threadId: string; toolCallId: string; text: string; truncated?: boolean }
  | { type: "tool.completed"; eventId: string; threadId: string; toolCallId: string; outcome: "success" | "failed" | "cancelled" }
  | { type: "approval.requested"; eventId: string; threadId: string; approval: AgentApprovalRequest }
  | { type: "approval.resolved"; eventId: string; threadId: string; approvalId: string; decision: string }
  | { type: "user_input.requested"; eventId: string; threadId: string; request: UserInputRequest }
  | { type: "file.changed"; eventId: string; threadId: string; path: string; changeKind: string }
  | { type: "review.ready"; eventId: string; threadId: string; reviewId: string; summary: ReviewSummary }
  | { type: "terminal.bound"; eventId: string; threadId: string; terminalSessionId: string }
  | { type: "thread.error"; eventId: string; threadId: string; safeMessage: string; retryable: boolean }
  | { type: "thread.completed"; eventId: string; threadId: string; outcome: "completed" | "failed" | "aborted" };
```

Reduction rules:

- Events are append-only and ordered per thread.
- Clients reduce events into read models.
- Delta events append to the target message by `messageId`.
- Tool events group by `toolCallId`.
- Unknown event types are ignored with diagnostics, not crashes.
- Replayed events must be idempotent.

### Approval

```ts
type AgentApprovalRequest = {
  approvalId: string;
  threadId: string;
  title: string;
  safeDescription: string;
  risk: "low" | "medium" | "high";
  actionKind: "command" | "file_change" | "network" | "provider" | "other";
  preview?: ApprovalPreview;
  allowedDecisions: Array<"approve" | "approve_for_session" | "decline" | "cancel">;
  expiresAt?: string;
  correlationId: string;
};
```

Rules:

- `preview` is bounded and redacted.
- Decision endpoint must be idempotent by `approvalId` and `correlationId`.
- If two clients decide concurrently, one wins and all clients receive resolved event.

### Terminal Frame

Prefer extending the existing terminal contract instead of replacing it.

```ts
type TerminalClientFrame =
  | { type: "attach"; sessionId: string; fromSeq?: number; cols?: number; rows?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

type TerminalServerFrame =
  | { type: "attached"; sessionId: string; cwd?: string; nextSeq?: number; replay?: string }
  | { type: "replay-start"; fromSeq?: number; toSeq?: number }
  | { type: "output"; seq?: number; data: string }
  | { type: "replay-gap"; fromSeq?: number; nextSeq: number }
  | { type: "replay-end"; nextSeq?: number }
  | { type: "exit"; exitCode?: number | null }
  | { type: "error"; code: "session_not_found" | "unauthorized" | "unavailable" | "invalid_frame"; safeMessage: string };
```

Rules:

- Existing clients may not support `seq`; add compatibility carefully.
- If a requested replay cursor is too old, emit `replay-gap`.
- Fatal errors stop reconnect loops.
- Nonfatal disconnects trigger bounded reconnect.

## Runtime Service Patterns

### Provider Registry Pattern

Provider registry is server-owned and returns safe projections.

Implementation pattern:

1. Discover configured providers from owner runtime config and installed tool state.
2. Validate provider IDs against known provider adapters or custom provider config.
3. Run health checks with `AbortSignal.timeout`.
4. Normalize output into `AgentProviderSummary`.
5. Cache health results with TTL and cap.
6. Never expose raw check command output.

### Thread Store Pattern

Thread creation and event append must be safe under retries.

Implementation pattern:

1. `createThread(input)` validates route payload.
2. Check `clientRequestId` for existing accepted create.
3. Insert thread and initial event in one transaction.
4. Start provider runtime asynchronously through a queue/worker.
5. Append lifecycle events as runtime progresses.
6. Publish events after persistence succeeds.

Same-thread follow-up pattern:

1. Validate owner/thread/project/task references and `clientRequestId`.
2. Atomically claim the idle thread for one new turn and append the user-turn event.
3. Return the prior accepted turn for an idempotent retry.
4. Start the normalized provider adapter with the server-owned resume identity and an `AbortSignal`.
5. Persist provider resume identity changes before exposing a completed/idle status.
6. Release active-turn ownership on completion, failure, or abort and publish the new projection.

### Event Stream Pattern

Thread streams use cursor replay and live subscription.

Implementation pattern:

1. Client opens stream with `threadId` and optional `afterEventId` or cursor.
2. Gateway authenticates and authorizes before sending success frame.
3. Gateway replays bounded history.
4. Gateway subscribes to live events.
5. Send keepalive or heartbeat if required by infrastructure.
6. On disconnect, remove subscriber; stale subscribers are swept by TTL.
7. On shutdown, drain subscribers with a safe close frame.

### Terminal Attachment Pattern

Terminal process state is separate from client attachment.

Implementation pattern:

1. List sessions from canonical terminal/session registry.
2. Attach creates a client attachment, not a new process unless requested.
3. Client sends resize after attach/open.
4. Output is replayed from cursor when possible.
5. Detach closes only the attachment.
6. Terminate endpoint kills the named session after confirmation/auth.
7. All clients observe session ended.

### Runtime Summary Pattern

Summary is a safe hydration projection, not a dump.

Implementation pattern:

1. Gather bounded provider/project/thread/session/activity summaries from canonical services.
2. Include limits and capability flags.
3. Return coarse runtime health.
4. Omit secrets, raw logs, file contents, terminal content, and provider output.
5. Make every list stable sorted.
6. Include `serverTime`.
7. Never ship a permanent placeholder project list when canonical projects exist; adapter failures produce a safe degraded capability/state.

### Project Workspace Projection Pattern

1. Validate project ID and owner access at the route boundary.
2. Read canonical tasks through the existing task manager and coding threads through the thread store.
3. Reject or quarantine stale cross-project task references; never repair them in a read path.
4. Compute bounded task aggregates with deterministic sorting and explicit truncation.
5. Keep task writes on canonical task routes and publish workspace events after successful mutations.
6. Support independent cursors for tasks and threads so a project with many chats cannot create an oversized response.

## Client State Patterns

### General State Rules

- Keep state serializable.
- Store arrays/records, not `Map`/`Set`, in Zustand/React state.
- Derive filtered/sorted lists with pure helpers and `useMemo`.
- Persist only small UI resume state.
- Reconcile persisted IDs with live runtime summary before rendering detail screens.
- Use generation guards for async actions that can race route changes.
- Abort or ignore stale requests when switching runtime, project, task, or thread.
- Show stale-but-revalidating state when safe.

### Thread Reducer Pattern

Use pure reducers for event streams.

Reducer responsibilities:

- Create/update thread summary.
- Append text deltas by `messageId`.
- Group tool activity by `toolCallId`.
- Track approvals by `approvalId`.
- Track input requests by request ID.
- Track review availability.
- Track terminal binding.
- Track status and attention reason.
- Ignore duplicate event IDs.
- Cap arrays and mark truncation.

Do not:

- Mutate nested state in place.
- Render raw event payloads directly.
- Let unknown events crash the thread.
- Assume events arrive only once.

### Desktop Stream Ownership

Desktop should avoid opening unbounded sockets.

Pattern:

- Main process owns long-lived gateway stream clients if credentials are needed.
- Renderer subscribes through typed IPC or preload event bridge.
- One stream per active runtime summary/event channel.
- One terminal attachment per focused terminal session per app instance.
- Background workspaces release live sockets but keep bounded read models.
- Runtime switch closes streams for old runtime and clears embedded sessions as needed.

### Mobile Stream Ownership

Mobile should assume suspension at any time.

Pattern:

- Use runtime summary on focus/app resume.
- Attach streams only for visible thread/detail/terminal screens.
- Persist last selected IDs, not event caches.
- Use event cursor from current session memory when available.
- On app resume, fetch snapshot before trusting old stream.
- Treat WebSocket close as expected; surface reconnect only when user is actively viewing the stream.

### Approval UI Pattern

Approval cards should be consistent across shells.

Display:

- Provider display name.
- Thread/project context.
- Risk label.
- Safe action description.
- Bounded preview.
- Expiry/timeout if present.
- Approve/decline buttons matching allowed decisions.

Behavior:

- Disable buttons after decision submit.
- Treat duplicate/stale decision as resolved, not fatal.
- Show safe resolution state.
- Never expose hidden raw payloads in expandable UI unless explicitly redacted and bounded.

## Desktop Implementation Guide

### Trusted Core

Responsibilities:

- Credential storage.
- Gateway auth injection.
- Runtime selection.
- Embedded session handoff.
- Native notifications.
- Deep link validation.
- Update state.
- Bounded diagnostic logs.

Renderer must call trusted core for:

- Auth state.
- Runtime selection.
- Embedded app/session launch.
- Native notification focus targets.
- Any operation requiring bearer credential handling.

### IPC Design

Add grouped channels or a typed method object:

- `runtime:get-summary`
- `runtime:get-project-workspace`
- `runtime:select`
- `runtime:create-thread`
- `runtime:create-turn`
- `runtime:abort-thread`
- `runtime:get-thread-snapshot`
- `runtime:subscribe-thread-events`
- `runtime:unsubscribe-thread-events`
- `runtime:submit-approval-decision`
- `runtime:submit-input-answer`
- Existing `runtime:get-reviews`, `runtime:get-review-snapshot`, and `runtime:*file*` channels remain canonical.

Do not introduce a parallel `agents:*` IPC namespace. Extend the existing `runtime:*` coding-agent bridge and keep terminal, workspace task, preview, and external-open operations on their existing typed operator/IPC paths.

Every channel:

- Has request schema.
- Has response schema.
- Maps internal errors to safe errors.
- Logs rejected malformed requests.
- Does not return raw credential/token.

### Desktop UI Layout

Required first-class Agents workspace after sign-in:

```
┌────────────────────────────────────────────────────────────┐
│ Top bar: runtime, Conversation | Kanban, new chat, status    │
├──────────────┬──────────────────────────────┬──────────────┤
│ Projects     │ Conversation transcript or    │ Context      │
│  Task        │ project Kanban board           │ terminal /   │
│   Chat A     │                                │ files/review │
│   Chat B     │                                │ preview      │
│  Chat C      │                                │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

Use dense operational UI, not a marketing layout:

- Persistent sidebar for projects, task groups, and every task-bound/project-level thread.
- Segmented Conversation/Kanban control; both modes retain selected project and reconcile selected task/thread.
- Conversation main panel for selected thread transcript and same-thread composer.
- Kanban main panel reuses canonical task statuses and renders thread counts/attention without nesting cards inside cards.
- Inspector for approvals, review, preview, metadata.
- Keyboard shortcuts for new thread, command palette, terminal focus, review toggle, file search.

Navigator behavior:

- Project rows expand/collapse and show safe activity/attention counts.
- An expanded project has a `Project chats` group for unbound threads and task rows ordered by canonical task order.
- Each task row shows its thread count and expands to every attached thread. Thread rows show title, provider display label, execution/attention status, and latest bounded activity only.
- Selecting a project with no selected thread opens its last valid mode. Selecting a task without a thread opens a task overview/list of chats. Selecting a thread opens Conversation mode for that exact thread.
- `New chat` inherits the active project and optional selected task, then asks for provider and first message. `New chat from context` creates a distinct thread; normal composer send always creates a turn in the selected thread.

Kanban behavior:

- The board is scoped to one selected project and uses the existing canonical task columns and ordering.
- A task card shows task title/priority plus bounded thread count, active count, attention count, and latest activity. It does not render full nested chat cards.
- Opening a task card reveals its thread list in the contextual inspector or task detail surface. Choosing one thread switches to Conversation mode and preserves project/task identity.
- Drag/drop or menu movement uses the existing task mutation and optimistic-concurrency behavior. Thread reducers never dispatch a task move.

### Desktop Regression Checklist

Before merging each desktop phase:

- Sign in/out.
- Runtime switch.
- Hosted shell embed.
- Matrix app embed.
- Deep link focus.
- Native notification click.
- Update status check.
- Window bounds persistence.
- Menu actions.
- Settings sections.
- Terminal attach/reconnect.
- Existing desktop typecheck.

## Mobile Implementation Guide

### SDK 57 Constraints

- Expo Go is not a supported runtime for native-module work.
- Use Expo dev client for native changes.
- Keep React Native 0.86 and Expo SDK 57 dependency constraints intact.
- Add native modules only after spike and lockfile update.
- Mobile tests use Jest and `@testing-library/react-native`; add reducer/unit tests before UI.

### Mobile Navigation

Add agent routes without breaking current tabs:

```
/(tabs)
  chat
  mission-control
  terminal
  apps
  settings

/agents
  index                         # Projects/recent attention
  projects/[projectId]          # Conversation hierarchy
  projects/[projectId]/board    # Kanban
  new
  [threadId]
  [threadId]/review
  [threadId]/files
  [threadId]/terminal
```

Phone-first hierarchy:

1. Project/recent attention list.
2. Selected project with Conversation/Kanban control.
3. Task groups and all attached threads, or Kanban columns/cards.
4. Thread detail with same-thread composer.
5. Sheets for approvals, provider picker, file actions.
6. Separate full-screen routes for terminal, review, files, preview.

Mobile interaction behavior:

- `/agents` lists projects plus bounded global attention/recent work; it does not flatten every transcript into one unbounded feed.
- `/agents/projects/:projectId` provides a segmented Conversation/Kanban control. Conversation mode lists project-level chats and expandable task groups before navigating to the existing thread detail route.
- Kanban mode uses horizontally scrollable fixed-width columns or vertically grouped sections on narrow phones. Tablet may use a split board/task-thread detail layout.
- Opening a task exposes every attached chat; opening a chat navigates by validated `threadId` and the detail composer posts a same-thread turn.
- Back navigation returns to the prior project/mode/task selection after live-state reconciliation.

Tablet/foldable:

- May use split view when width allows.
- Do not make split view required for phone.

### Mobile State

Persist:

- Last selected runtime ID.
- Last active thread ID.
- Last active project ID.
- Last active terminal session ID.
- Last active surface/mode.
- Updated timestamp.

Do not persist:

- Terminal output.
- Thread transcript content.
- Provider credentials.
- Approval raw payloads.
- File contents.
- Diff contents.
- App launch tokens.

Every load:

1. Parse persisted state.
2. Fetch runtime summary.
3. Drop stale IDs not present in summary.
4. Navigate to best valid resume target.
5. Fall back to recent work/home.

### Mobile Terminal Path

Phase 1:

- Preserve existing WebView terminal.
- Add typed frame parser tests.
- Add replay/cursor handling if gateway supports it.
- Add stronger reconnect/attach lifecycle.

Phase 2:

- Spike native terminal module with feature flag.
- Keep WebView fallback.
- Validate hardware keyboard, soft keyboard, paste, resize, colors, scrollback, and performance.
- Do not remove fallback until native path passes device validation.

### Mobile Review Path

Start with JS-rendered diffs:

- File list.
- Per-file hunks.
- Additions/deletions.
- Partial diff notice.
- Ask-agent-follow-up action.

Later native/performance path:

- Add native diff renderer only after large-diff profiling shows need.
- Keep JS fallback.

### Mobile Regression Checklist

Before merging each mobile phase:

- Existing Jest suite.
- Sign in.
- Chat tab.
- Mission control.
- Terminal create/attach/delete.
- Apps tab and app launch.
- Canvas entry/return.
- Settings.
- Push/offline handling.
- Persisted mobile shell resume.
- Safe area and keyboard behavior on iPhone-sized viewport/device.

## Gateway Implementation Guide

### Route Design

Current canonical routes under `/api/coding-agents`:

- `GET /api/coding-agents/summary`
- `POST /api/coding-agents/threads`
- `POST /api/coding-agents/threads/:threadId/adopt`
- `GET /api/coding-agents/threads`
- `GET /api/coding-agents/threads/:threadId`
- `GET /api/coding-agents/threads/:threadId/events`
- `POST /api/coding-agents/threads/:threadId/abort`
- `POST /api/coding-agents/threads/:threadId/approvals/:approvalId/decision`
- `POST /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer`
- `POST /api/coding-agents/threads/:threadId/turns`
- `GET /api/coding-agents/projects/:projectId/workspace`
- `GET /api/coding-agents/reviews`
- `GET /api/coding-agents/reviews/:reviewId`
- `GET /api/coding-agents/files/browse`
- `GET /api/coding-agents/files/search`
- `GET /api/coding-agents/files/read`
- `POST /api/coding-agents/files/write`
- `POST /api/coding-agents/source-control/prepare-commit`
- `POST /api/coding-agents/source-control/pull-requests`
- `GET /api/coding-agents/notification-preferences`
- `PUT /api/coding-agents/notification-preferences`

The project workspace route returns `ProjectAgentWorkspaceSchema` after validating the owner-scoped project path plus independent bounded task/thread cursors and limits. The turns route accepts `CreateAgentTurnRequestSchema` and applies auth, `bodyLimit`, path/body validation, ownership/project/task checks, persisted idempotency, atomic active-turn ownership, and safe error mapping. The adoption route is compatibility-only: it can attach a fully unassigned legacy thread to one validated project/task relation but cannot move an assigned thread.

Current canonical coding-agent WebSocket:

- `/ws/coding-agents/thread/:threadId`

Project/task/thread summary changes publish bounded events through the existing authenticated workspace event path after owner-file persistence succeeds. Do not add `/ws/coding-agents/runtime` without its own schemas, auth registration, subscriber caps, stale cleanup, shutdown drain, and tests.

Compatibility:

- Existing terminal and shell routes may remain where they are.
- If adding aliases, document canonical routes and deprecate old ones later.

### Route Checklist

For every new route:

- Auth.
- Body limit on mutating routes.
- Zod parse params/query/body.
- Ownership check.
- Timeout external calls.
- Safe error mapper.
- Tests for valid, invalid, unauthorized, oversized, not found, stale/concurrent where relevant.

### WebSocket Checklist

For every new WS:

- Auth before success frame.
- Query token support only where required and allowlisted.
- Max message size.
- JSON parse error handling.
- Frame schema validation.
- Subscriber cap.
- Stale connection sweep.
- Shutdown drain.
- Per-subscriber send isolation.
- Cursor replay tests.
- Malformed frame tests.

## Data Ownership And Persistence

Canonical persistence:

- Project/task metadata: existing canonical workspace project/task services and their current owner-controlled persistence.
- Phase 18-20 thread/turn metadata and bounded event history: the existing owner coding-thread store (`system/coding-agents/threads.json`). Persist idempotency and active-turn ownership with the thread record through the store's atomic single-writer mutation path; do not rely on renderer/mobile state or an in-memory-only lock.
- Full Workspace V2 durable state: the separately reviewed owner-Postgres migration defined in `FULL-WORKSPACE-BACKEND.md`. After its cutover marker, Postgres is authoritative and the owner file remains bounded import/export/rollback compatibility only.
- Provider conversation resume identity: server-only field in the existing owner thread/provider persistence, excluded from every shell projection, export intended for UI, diagnostic, and notification payload.
- Runtime/provider config: owner files and/or Postgres according to existing Matrix ownership rules.
- App/project files: owner filesystem under scoped project/app directories.
- App/user data: owner Postgres.
- Client UI state: local bounded desktop/mobile storage.

Do not add new SQLite/better-sqlite/drizzle persistence for this feature. Existing legacy dependencies should not be expanded.

## Testing Strategy

### Contract Tests

- Runtime summary accepts valid payload.
- Provider summary rejects unsafe status/action shapes.
- Thread create bounds prompt and attachments.
- Thread events reduce idempotently.
- Approval decisions are idempotent.
- Terminal frames reject invalid sizes/input.
- File paths reject traversal.
- Diff snapshots enforce size limits.
- Project/task/thread cardinality schemas reject cross-project and oversized projections.
- Same-thread turn requests bound message/attachments/idempotency IDs.

### Gateway Unit Tests

- Provider registry health normalization.
- Safe error mapper.
- Thread create idempotency.
- Event append/replay.
- Approval lifecycle.
- Runtime summary caps and stable sort.
- Route auth/validation/body limits.
- Real project adapter populates summary when canonical projects exist.
- Project workspace groups project-level and task-bound threads, including several threads on one task.
- Cross-project task/thread binding is rejected.
- Same-thread turns resume one provider conversation, are idempotent, and reject concurrent active turns.

### Desktop Tests

- IPC schema request/response validation.
- Runtime switch closes old streams.
- Notification payload validation.
- Agent event reducer.
- Thread list rendering.
- Approval action handling.
- Existing desktop typecheck.
- Project navigator renders multiple threads under one task.
- Conversation/Kanban switching preserves valid selection.
- Kanban task cards show bounded thread aggregates without changing canonical task status.
- Follow-up sends a turn to the selected thread rather than creating another thread.

### Mobile Tests

- Runtime summary parser.
- Mobile resume state reconciliation.
- Thread reducer.
- Approval reducer.
- Terminal client frame parser.
- New agent route smoke tests.
- Existing mobile Jest suite.
- Project/task/thread route params and resume references reconcile against live state.
- Multiple threads on one task remain independently selectable.
- Conversation/Kanban switching and same-thread follow-up work on phone layouts.

### End-To-End Tests

- Desktop create thread and receive completion.
- Mobile attach to existing thread and submit follow-up.
- Cross-shell terminal attach.
- Approval opened on desktop, resolved on mobile.
- Runtime switch recovery.
- Network loss replay.
- One task with two independent chats is navigable from desktop and mobile.
- One chat accepts two sequential user turns and preserves one provider conversation identity.
- Conversation/Kanban switching opens the same task/thread records across shells.

## Migration And Rollout

### Feature Flags

Use flags/capabilities for:

- New agent workspace UI.
- Multi-provider thread creation.
- Approval UI.
- Review panel.
- Preview automation.
- Native mobile terminal.
- Push notifications for agent attention.
- Project workspace projections.
- Same-thread turns.
- Conversation/Kanban workspace UI.

### Compatibility Stages

1. Contracts compile, tests pass, no UI usage.
2. Gateway summary read-only.
3. Desktop read-only dashboard.
4. Mobile read-only dashboard.
5. Thread creation for one provider.
6. Multi-provider thread creation.
7. Approvals/input.
8. Terminal binding.
9. Files/review/preview.
10. Native terminal improvement.
11. Real project/task/thread projection.
12. Same-thread turns.
13. Desktop project navigator and Conversation/Kanban modes.
14. Mobile project/task/thread navigation and Kanban mode.
15. Owner-Postgres coding-workspace repository and legacy import.
16. Stable transcript pages and complete lifecycle operations.
17. Pending queue, steering/interrupt, execution graph, and attention inbox.
18. Many-terminal bindings, repository operations, review comments, and attachments.
19. Runtime handoff and role-based collaboration.
20. Shared preview-computer acceptance by desktop and mobile.

Each stage must be revertible without losing user data.

## Full Workspace V2 Architecture

The detailed capability, data, route, migration, and delivery contract is
authoritative in [FULL-WORKSPACE-BACKEND.md](./FULL-WORKSPACE-BACKEND.md).

### Computer And Preview Control Plane

Platform owns one bounded computer inventory projection for verified Clerk and
native/sync principals. A nullable selected slot is derived only from the
verified principal; individual computer rows never infer client-local selection.
Electron main may exchange its native/sync principal for a runtime-scoped bearer
and stores it in the native credential store. Mobile selects a server-derived
same-origin route: `/vm/{handle}` for primary or the same path with a validated
`runtime` query for non-primary slots, then continues using Clerk/platform
session routing. No renderer/mobile state receives a runtime bearer.

Preview environments use a dedicated platform authority keyed by repository,
PR, and exact head SHA. One generation owns isolated database/JWT/edge/provider/
object resources, platform revision, disposable VPS, expiry, cleanup state, and
compare-and-swap generation. Production credentials are unavailable to the
preview service. Native app HTTP/WebSocket routes remain ordinary runtime routes
through explicit `/vm/{handle}` forwarding with an optional validated runtime
slot selector and retain current owner/session proofs, limits, TTL, and shutdown
cleanup.

### Durable Store Boundary

`system/coding-agents/threads.json` remains a bounded compatibility
import/export projection. Complete conversation history, turns, pending
messages, execution graphs, runtime/terminal bindings, attachments, attention,
review comments, participants, and idempotency records move to additive tables
in the existing owner-controlled Postgres through the gateway's owned Kysely
lifecycle.

The repository owns transaction boundaries and accepts an executor for nested
transactions. Only the gateway bootstrap that creates the shared Kysely/pool may
destroy it. Required atomic groups include:

- thread plus initial turn/transcript/idempotency
- pending-message reorder with optimistic queue revision
- queue claim plus accepted turn
- transcript append plus thread sequence/status projection
- attention transition plus approval/input/lifecycle transition
- terminal binding plus projection event
- handoff source/destination state transition plus audit event
- participant grant/revoke plus audit event

Every optimistic update includes its base revision in the write predicate.
Every retryable create uses a unique key and `ON CONFLICT` rather than a
check-then-insert flow.

### Transcript And Stream Boundary

The durable transcript is optimized for display and replay; provider execution
state remains opaque and server-only. Stream reducers receive normalized
entries with one monotonic conversation sequence. HTTP pages are authoritative
for hydration and gap recovery. WebSocket delivery is an invalidation/live-tail
optimization and never the only copy of a transcript record.

Streaming assistant/tool updates may replace one aggregation key while a turn is
active. Finalization persists one bounded normalized entry representation and
advances the conversation sequence atomically. Raw provider errors are logged
only after redaction and map to safe lifecycle entries.

### Session Discovery And Handoff Boundary

Provider discovery adapters inspect only server-side owner runtime state and
return expiring opaque import handles. Import validates project/worktree/provider
compatibility, then creates or links canonical Matrix conversation records
without revealing provider resume identity.

Cross-computer handoff is a saga with persisted phases. Destination preflight
must complete before source detachment. A destination failure keeps the source
active when possible; otherwise it records a recoverable detached state. Clients
never transfer credentials, process IDs, paths, or provider state directly.

### Queue And Steering Boundary

Normal turns preserve the one-active-turn safe conflict. Pending messages are a
separate explicit durable queue. Dispatch claims one pending record through an
atomic state transition. Steering and interruption target the active turn and
are never emulated as queued messages when the adapter lacks support.

### Execution Graph Boundary

Parent/child runs use stable IDs and a bounded acyclic relation. Provider-native
subagents and Matrix-spawned delegated runs normalize into the same read model,
but adapters retain provider-specific execution identity. Runtime limits cap
depth, children, active runs, event rate, and transcript expansion.

### Terminal And Repository Boundary

Terminal bindings reference canonical `/api/terminal/sessions` records and
`/ws/terminal` process streams. They do not persist terminal bytes. Repository,
file, review, preview, and source-control services resolve a validated owner
project/worktree root on every operation and return only bounded structured
metadata/content allowed by their contract.

### Preview Integration Boundary

The backend Graphite stack is based on `main`, not a shell branch. Once a backend
gate is green, its exact top SHA is deployed to a disposable preview computer.
Desktop and mobile development branches point to that same preview runtime.
Temporary integration branches may combine shell and backend heads for visual
testing but are not merged and do not become a source of truth.

## Implementation Invariants

- Core runtime works without desktop or mobile.
- Desktop and mobile use the same runtime contracts.
- Clients never become source of truth.
- Every external boundary validates.
- Every mutating route has body limit and ownership check.
- Every long-lived stream has caps, stale cleanup, and shutdown drain.
- Every user-visible error is safe.
- Existing desktop/mobile behavior remains intact unless replaced by a tested superset.
- One visible chat/session always maps to one `AgentThread`; one user message maps to one `AgentTurn` in that thread.
- Tasks may own multiple threads; no singular task-session field may be treated as the coding conversation source of truth.
- Task status is never silently derived into a mutation from thread status.
- Mobile SDK 57 remains the target for native mobile work.
- New plans, comments, code, docs, and tests must use Matrix-native terminology only.
