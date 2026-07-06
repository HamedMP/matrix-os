# Architecture: Coding Agent Shells

**Status**: Draft  
**Last Updated**: 2026-07-06  
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
  provider-registry.ts      # Configured providers and health
  thread-store.ts           # Thread CRUD/projections
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
  index.tsx                  # Recent work / active threads
  new.tsx                    # New agent run
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
- `eventId`: `evt_[A-Za-z0-9_-]{1,128}`.
- `approvalId`: `appr_[A-Za-z0-9_-]{1,128}`.
- `terminalSessionId`: existing named session/UUID schema; do not invent a second ID if canonical names already exist.

### Runtime Summary

```ts
type RuntimeSummary = {
  runtime: RuntimeTarget;
  capabilities: RuntimeCapability[];
  providers: AgentProviderSummary[];
  projects: ProjectSummary[];
  activeThreads: AgentThreadSummary[];
  terminalSessions: TerminalSessionSummary[];
  recentActivity: ActivityEventSummary[];
  serverTime: string;
  limits: RuntimeLimits;
};
```

Rules:

- Summary is bounded and safe for first hydration.
- Include `hasMore` or cursors where lists are truncated.
- Include capability flags so clients do not assume unavailable features.
- Include `serverTime` so clients can reason about expiry without trusting local clock.

### Agent Provider

```ts
type AgentProviderSummary = {
  id: string;
  displayName: string;
  kind: "claude" | "codex" | "opencode" | "cursor" | "custom";
  availability: "available" | "setup_required" | "auth_required" | "installing" | "unavailable" | "unknown";
  installStatus: "installed" | "missing" | "installing" | "failed" | "unknown";
  authStatus: "authenticated" | "missing" | "expired" | "unknown";
  supportedModes: Array<"default" | "plan" | "review" | "full_access">;
  defaultMode: "default" | "plan" | "review" | "full_access";
  defaultModel?: string;
  setupActions: SafeSetupAction[];
  lastCheckedAt?: string;
};
```

Guidance:

- `displayName` is safe UI text controlled by the server.
- `setupActions` should contain safe action IDs and labels, not raw arbitrary commands unless explicitly marked as foreground terminal actions.
- Health checks must be timeout-bound.

### Thread Create

```ts
type CreateAgentThreadRequest = {
  providerId: string;
  prompt: string;
  projectId?: string;
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

1. Gather bounded provider/project/thread/session/activity summaries.
2. Include limits and capability flags.
3. Return coarse runtime health.
4. Omit secrets, raw logs, file contents, terminal content, and provider output.
5. Make every list stable sorted.
6. Include `serverTime`.

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
- `runtime:select`
- `agents:create-thread`
- `agents:abort-thread`
- `agents:submit-approval`
- `agents:submit-input`
- `agents:subscribe-thread`
- `terminal:list-sessions`
- `terminal:create-session`
- `terminal:terminate-session`
- `workspace:get-review`
- `workspace:read-file`
- `workspace:write-file`
- `preview:open`

Every channel:

- Has request schema.
- Has response schema.
- Maps internal errors to safe errors.
- Logs rejected malformed requests.
- Does not return raw credential/token.

### Desktop UI Layout

Recommended first screen after sign-in:

```
┌────────────────────────────────────────────────────────────┐
│ Top bar: runtime, project switcher, global composer, status │
├──────────────┬──────────────────────────────┬──────────────┤
│ Projects /   │ Active thread or task         │ Inspector    │
│ threads      │ transcript / terminal / files │ review/info  │
│              │                              │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

Use dense operational UI, not a marketing layout:

- Sidebar for projects/tasks/threads.
- Main panel for selected thread/workspace.
- Inspector for approvals, review, preview, metadata.
- Keyboard shortcuts for new thread, command palette, terminal focus, review toggle, file search.

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
  index
  new
  [threadId]
  [threadId]/review
  [threadId]/files
  [threadId]/terminal
```

Phone-first hierarchy:

1. Recent work/inbox.
2. Thread list.
3. Thread detail.
4. Sheets for approvals, provider picker, file actions.
5. Separate full-screen routes for terminal, review, files, preview.

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

Prefer routes under `/api/coding-agents` or an equivalent clear namespace:

- `GET /api/coding-agents/summary`
- `GET /api/coding-agents/providers`
- `POST /api/coding-agents/threads`
- `GET /api/coding-agents/threads`
- `GET /api/coding-agents/threads/:threadId`
- `POST /api/coding-agents/threads/:threadId/abort`
- `POST /api/coding-agents/approvals/:approvalId/decision`
- `POST /api/coding-agents/input/:requestId/answer`
- `GET /api/coding-agents/threads/:threadId/events`
- `GET /api/coding-agents/threads/:threadId/review`
- `GET /api/coding-agents/projects/:projectId/files`
- `GET /api/coding-agents/projects/:projectId/files/read`
- `PUT /api/coding-agents/projects/:projectId/files/write`

WebSocket:

- `/ws/coding-agents/runtime`
- `/ws/coding-agents/threads/:threadId`

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

- Thread metadata/history: owner Postgres or existing kernel conversation store, depending on current architecture.
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

### Gateway Unit Tests

- Provider registry health normalization.
- Safe error mapper.
- Thread create idempotency.
- Event append/replay.
- Approval lifecycle.
- Runtime summary caps and stable sort.
- Route auth/validation/body limits.

### Desktop Tests

- IPC schema request/response validation.
- Runtime switch closes old streams.
- Notification payload validation.
- Agent event reducer.
- Thread list rendering.
- Approval action handling.
- Existing desktop typecheck.

### Mobile Tests

- Runtime summary parser.
- Mobile resume state reconciliation.
- Thread reducer.
- Approval reducer.
- Terminal client frame parser.
- New agent route smoke tests.
- Existing mobile Jest suite.

### End-To-End Tests

- Desktop create thread and receive completion.
- Mobile attach to existing thread and submit follow-up.
- Cross-shell terminal attach.
- Approval opened on desktop, resolved on mobile.
- Runtime switch recovery.
- Network loss replay.

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

Each stage must be revertible without losing user data.

## Implementation Invariants

- Core runtime works without desktop or mobile.
- Desktop and mobile use the same runtime contracts.
- Clients never become source of truth.
- Every external boundary validates.
- Every mutating route has body limit and ownership check.
- Every long-lived stream has caps, stale cleanup, and shutdown drain.
- Every user-visible error is safe.
- Existing desktop/mobile behavior remains intact unless replaced by a tested superset.
- Mobile SDK 57 remains the target for native mobile work.
- New plans, comments, code, docs, and tests must use Matrix-native terminology only.
