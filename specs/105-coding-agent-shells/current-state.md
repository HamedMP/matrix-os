# Current State: Coding Agent Shells

**Branch stack**: `spec/coding-agent-shells` plus stacked implementation branches through `105-coding-agent-attention-summary`
**Updated**: 2026-07-07
**Scope**: Inventory for the coding-agent desktop/mobile shell work. This file records the current Matrix-native route, contract, client, and regression-test state so later slices keep gateway/runtime as source of truth and keep desktop/mobile as thin shells.

## Summary

The stack currently has shared contracts, a gateway runtime summary read model, a gateway-owned bounded attention summary, read-only desktop and mobile workspaces behind flags, thread create/replay/abort/event streaming, provider adapters, a workspace-backed provider, approval/input route handling, a read-only coding-agent review summary route/client contract, desktop/mobile read-only review summary panels, and a read-only coding-agent review snapshot route with bounded file metadata from safe owner worktree diffs plus findings fallback metadata. Review snapshots can include bounded per-hunk diff lines with truncation markers. Desktop and mobile review details render changed-file counts, selectable hunk coordinate metadata, and gateway-bounded diff lines. Desktop and mobile can seed their existing agent composers from a selected review hunk using bounded prompt context and a `structured_ref` attachment. Mobile active thread rows now open a bounded thread detail route that hydrates `AgentThreadSnapshotSchema` through the authenticated gateway client, renders safe thread metadata, event counts, in-app attention labels, and snapshot event timeline, can hand a bound canonical terminal session to the existing mobile Terminal tab, and can submit approval decisions plus user-input answers through the authenticated gateway client. Desktop active thread rows can open a matching attachable bound canonical terminal session in the existing Terminal tab model and selected desktop threads now hydrate `AgentThreadSnapshotSchema` through trusted main-process IPC for safe metadata and event timeline rendering. Desktop approval-request events can submit allowed decisions, and desktop user-input request events can submit bounded answers, through trusted main-process IPC and replace local details with the gateway-returned bounded thread snapshot. Desktop native notification clicks focus the Agents tab and visibly select the bounded coding-agent workspace thread reference in the active thread list. Full file content and preview coding-agent surfaces are contract-only or existing workspace routes; dedicated preview shell UI is not yet integrated.

Current source-of-truth boundaries:

- Gateway/runtime owns coding-agent summaries, provider adapters, thread state, events, approvals, and terminal binding.
- Desktop gets coding-agent data through main-process IPC and never receives bearer/provider credentials.
- Mobile gets coding-agent data through the existing authenticated gateway client and stores only bounded UI references.
- Canonical terminal sessions remain the existing Matrix shell/session primitives under `/api/terminal/sessions` and `/ws/terminal`.

## Shared Contracts

Package: `packages/contracts/src/index.ts`

Implemented coding-agent schemas:

- IDs and bounds: `RuntimeIdSchema`, `ProviderIdSchema`, `ProjectIdSchema`, `TaskIdSchema`, `ThreadIdSchema`, `EventIdSchema`, `ApprovalIdSchema`, `RequestIdSchema`, `CorrelationIdSchema`, `TerminalSessionIdSchema`, `WorktreeIdSchema`, `CursorSchema`, `IsoTimestampSchema`, `SafeDisplayStringSchema`, `SafeClientErrorSchema`.
- Runtime summary: `RuntimeTargetSchema`, `RuntimeCapabilitySchema`, `RuntimeLimitsSchema`, `RuntimeSummarySchema` with bounded `activeThreads` and separate bounded `attentionThreads`.
- Providers: `AgentProviderSummarySchema`, provider availability/install/auth enums, `AgentModeSchema`, `ApprovalPolicySchema`, `SandboxModeSchema`, `SafeSetupActionSchema`.
- Threads: `CreateAgentThreadRequestSchema`, `AgentThreadSummarySchema`, `AgentThreadStatusSchema`, `AgentAttachmentSchema`, `AgentThreadSnapshotSchema`.
- Events: `AgentThreadEventSchema` discriminated union with lifecycle, text delta, tool activity, approval/input, file change, review ready, terminal bound, safe error, and completion event variants.
- Approvals/input: `AgentApprovalRequestSchema`, `ApprovalDecisionRequestSchema`, `UserInputRequestSchema`, `UserInputAnswerRequestSchema`.
- Terminal frames/summaries: `TerminalSessionSummarySchema`, `TerminalClientFrameSchema`, `TerminalServerFrameSchema`.
- File/review/preview: `FilePathSchema`, `FileMetadataSchema`, `ReviewSummarySchema`, `ReviewFileDiffSchema`, `ReviewDiffLineSchema`, `ReviewDiffHunkSchema`, `ReviewFindingSummarySchema`, `ReviewSnapshotFileSchema`, `ReviewSnapshotSchema`, `PreviewSessionSummarySchema`.

Contract tests:

- `tests/contracts/coding-agents.test.ts`

## Gateway HTTP Routes

Coding-agent route module: `packages/gateway/src/coding-agents/routes.ts` mounted under `/api/coding-agents`.

Implemented routes:

| Route | Method | State | Notes |
| --- | --- | --- | --- |
| `/api/coding-agents/summary` | `GET` | Implemented | Authenticated runtime summary. Returns `RuntimeSummarySchema`. |
| `/api/coding-agents/threads` | `POST` | Implemented | Validates `CreateAgentThreadRequestSchema`, body limit 96 KiB, idempotent by `clientRequestId`. |
| `/api/coding-agents/threads` | `GET` | Implemented | Authenticated bounded thread list. |
| `/api/coding-agents/threads/:threadId` | `GET` | Implemented | Authenticated snapshot replay for one thread. No-cursor snapshots return the latest bounded event window. |
| `/api/coding-agents/threads/:threadId/events` | `GET` | Implemented | Authenticated snapshot replay with optional cursor. |
| `/api/coding-agents/threads/:threadId/abort` | `POST` | Implemented | Body limit 8 KiB, idempotent abort by client request id. |
| `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` | `POST` | Implemented | Body limit 8 KiB, validates approval id and decision payload. |
| `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` | `POST` | Implemented | Body limit 40 KiB, validates bounded answer payload. |
| `/api/coding-agents/reviews` | `GET` | Implemented | Authenticated read-only review summary list. Returns bounded `ReviewSummarySchema` items only. |
| `/api/coding-agents/reviews/:reviewId` | `GET` | Implemented | Authenticated read-only review snapshot. Returns bounded `ReviewSnapshotSchema` with partial findings-derived file metadata and bounded hunk diff lines when available; no full file contents. |

Security and ownership:

- All coding-agent routes resolve a `RequestPrincipal` using the gateway auth path.
- Path params and query cursors are Zod-validated at the route boundary.
- Mutating routes use Hono `bodyLimit`.
- Route errors are mapped to safe client errors and log details server-side only.
- Thread store state is owner-scoped in the existing owner file convention at `system/coding-agents/threads.json`; no new embedded DB was added.

Related workspace routes in `packages/gateway/src/workspace-routes.ts`:

- Sessions: `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:sessionId`, `POST /api/sessions/:sessionId/send`, `POST /api/sessions/:sessionId/observe`, `POST /api/sessions/:sessionId/takeover`, `DELETE /api/sessions/:sessionId`.
- Agent readiness: `GET /api/agents`, `GET /api/agents/sandbox-status`.
- Workspace events: `GET /api/workspace/events`.
- Reviews: `POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:reviewId`, `POST /api/reviews/:reviewId/next`, `POST /api/reviews/:reviewId/approve`, `POST /api/reviews/:reviewId/stop`.
- Workspace data: `POST /api/workspace/export`, `DELETE /api/workspace/data`.

These routes predate the coding-agent shell contracts and remain the source for workspace/session/review behavior until dedicated coding-agent file/review/preview surfaces are integrated.

## Gateway WebSockets

Current WS endpoints relevant to coding-agent shells:

| Route | State | Notes |
| --- | --- | --- |
| `/ws` | Existing | Main gateway/kernel/sync socket. Browser auth uses existing gateway auth handling. |
| `/ws/terminal` | Existing canonical terminal socket | Supports attach/input/resize/replay/exit flow for terminal surfaces. Mobile uses this through `TerminalClient`. |
| `/ws/terminal/session` | Existing named shell-session socket | Used by shared named terminal session model. |
| `/ws/coding-agents/thread/:threadId` | Implemented | Authenticates before success, validates thread id/cursor, sends replay and live `thread.event` frames, caps pending frames and subscribers in the stream service. |

Thread streaming implementation:

- Gateway registration: `packages/gateway/src/server.ts`
- Stream service: `packages/gateway/src/coding-agents/thread-stream.ts`
- Tests: `tests/gateway/coding-agents-thread-stream.test.ts`

## Runtime Summary

Service: `packages/gateway/src/coding-agents/runtime-summary.ts`

Current summary sources:

- Runtime target metadata and server time.
- Capability flags.
- Provider summaries from the coding-agent provider registry.
- Active thread summaries from the thread store when present.
- Attention thread summaries from the thread store when present, including failed or waiting threads without changing the active-thread list semantics.
- Terminal session summaries from the existing terminal registry adapter.
- Bounded list metadata and runtime limits.

Safe degradation:

- Optional dependency failures return partial safe summaries.
- Summary tests assert caps, stable sort, attention list separation, and no sensitive fields.

Focused tests:

- `tests/gateway/coding-agents-summary.test.ts`

## Providers And Thread Store

Core files:

- `packages/gateway/src/coding-agents/thread-store.ts`
- `packages/gateway/src/coding-agents/provider-registry.ts`
- `packages/gateway/src/coding-agents/workspace-provider.ts`
- `packages/gateway/src/coding-agents/review-summary.ts`

Implemented providers:

- Fake provider for deterministic gateway tests behind `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1`.
- Workspace-backed provider behind `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER=1`.

Workspace provider behavior:

- Starts deterministic workspace agent sessions through `WorkspaceSessionOrchestrator`.
- Passes through prompt, project, task, worktree, mode, approval policy, sandbox mode, and zellij runtime preference.
- Passes bounded `structured_ref` attachments into the runtime launch prompt as safe reference metadata so review follow-up runs can inspect the selected file/hunk without client-side diff contents.
- Binds coding-agent threads to canonical `terminalSessionId` from the workspace session.
- Aborts through the deterministic workspace session id.
- Keeps provider startup failures safe in the returned thread snapshot.

Thread store behavior:

- Owner-scoped thread summaries and events.
- Idempotent thread creation, aborts, approval decisions, and input answers by bounded request-id arrays.
- Event replay with bounded per-thread event storage; default thread snapshots return the latest bounded event window, while explicit cursors continue forward from the cursor.
- Safe terminal statuses and attention states derived from events.

Review summary behavior:

- Adapts existing owner-local review-loop records into bounded `ReviewSummarySchema` rows.
- Adapts existing owner-local review-loop records, safe owner worktree git diffs, and structured findings into bounded `ReviewSnapshotSchema` rows for the review detail route.
- Drops malformed legacy records instead of exposing raw review state.
- Caps the coding-agent route response at 50 items.
- Drops unsafe findings paths or display text instead of exposing raw filesystem paths, provider output, or parse errors.
- Reads git diff metadata only from the validated owner worktree root, uses a bounded no-shell `git diff` call with timeout/output cap, and falls back to partial findings metadata when diff state is unavailable.

Focused tests:

- `tests/gateway/coding-agents-threads.test.ts`
- `tests/gateway/coding-agents-workspace-provider.test.ts`
- `tests/gateway/agent-launcher.test.ts`
- `tests/gateway/workspace-session-orchestrator.test.ts`
- `tests/gateway/agent-session-manager.test.ts`

## Terminal Session Surfaces

Canonical named shell sessions:

- Routes: `packages/gateway/src/shell/routes.ts`
- Mounted under both `/api/terminal` and `/api` in `packages/gateway/src/server.ts`.
- Key routes: `GET /api/terminal/sessions`, `POST /api/terminal/sessions`, `PUT /api/terminal/sessions/order`, `DELETE /api/terminal/sessions/:name`, `PUT /api/terminal/sessions/:name/rename`, `PATCH /api/terminal/sessions/:name/ui-state`.
- Session creation is rate-limited and uses route body limits.

Legacy PTY session compatibility:

- Routes: `packages/gateway/src/terminal-session-routes.ts`
- `GET /api/terminal/pty-sessions`
- `DELETE /api/terminal/pty-sessions/:id`

Mobile terminal client:

- `apps/mobile/lib/terminal-client.ts`
- Uses `/ws/terminal` with optional query token.
- Parses `attached`, `output`, `replay-start`, `replay-end`, `exit`, and safe `error` frames.

## Desktop Shell State

IPC contract:

- `desktop/src/shared/ipc-contract.ts`
- `runtime:get-summary` returns `RuntimeSummarySchema`.
- `runtime:get-thread-snapshot` accepts a bounded `threadId` and returns `AgentThreadSnapshotSchema`.
- `runtime:submit-approval-decision` accepts bounded thread/approval ids plus `ApprovalDecisionRequestSchema` fields and returns `AgentThreadSnapshotSchema`.
- `runtime:submit-input-answer` accepts bounded thread/input request ids plus `UserInputAnswerRequestSchema` fields and returns `AgentThreadSnapshotSchema`.
- `runtime:get-reviews` returns a bounded list of `ReviewSummarySchema` rows from the trusted main process.
- `notify` accepts bounded notification data with `threadId`, `title`, `body`, and kind.
- `notification:clicked` emits bounded `threadId`.

Main process:

- `desktop/src/main/coding-agents/runtime-summary-client.ts`
- Fetches `/api/coding-agents/summary` from the selected runtime origin with bearer auth in the main process.
- Fetches `/api/coding-agents/threads/:threadId` from the selected runtime origin with bearer auth in the main process and validates `AgentThreadSnapshotSchema`.
- Posts approval decisions to `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` from the main process with bearer auth, a timeout, and `AgentThreadSnapshotSchema` response validation.
- Posts user-input answers to `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` from the main process with bearer auth, a timeout, and `AgentThreadSnapshotSchema` response validation.
- Fetches `/api/coding-agents/reviews` from the selected runtime origin with bearer auth in the main process.
- Uses `AbortSignal.timeout(10_000)` and validates `RuntimeSummarySchema`, `AgentThreadSnapshotSchema`, or bounded `ReviewSummarySchema` lists.
- Renderer receives only parsed summary data through IPC.

Renderer:

- Store: `desktop/src/renderer/src/stores/coding-agent-workspace.ts`.
- UI: `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`.
- Integration point: `desktop/src/renderer/src/features/mission-control/TabContent.tsx`.
- Flag: `desktop/src/renderer/src/lib/feature-flags.ts` with `VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0"`.

Current behavior:

- Read-only dashboard renders providers, active threads, and terminals.
- Active thread rows with a matching attachable `terminalSessionId` can open the existing desktop Terminal tab for that canonical session; stale or unavailable terminal bindings do not render an action.
- Selected active threads hydrate a bounded thread snapshot through `runtime:get-thread-snapshot`, show provider/status/terminal metadata, event counts, loading and safe generic error states, and render gateway-bounded snapshot events with generic copy for assistant text, tool output, file changes, approval/input prompts, and unsafe runtime errors.
- Approval-request events render allowed decision actions in the desktop thread detail. Decisions use desktop-generated idempotency request ids, go through trusted IPC, never expose bearer/provider credentials to the renderer, and replace the thread detail with the gateway-returned bounded snapshot. Failed decisions show a generic recovery-oriented message.
- User-input request events render a bounded answer composer in the desktop thread detail. Answers use desktop-generated idempotency request ids, go through trusted IPC, never expose bearer/provider credentials to the renderer, and replace the thread detail with the gateway-returned bounded snapshot. Failed submissions show a generic recovery-oriented message.
- Native notification clicks carrying a bounded `threadId` focus the existing Agents tab and visibly mark that thread current in the coding-agent workspace thread list while preserving the legacy thread-store selection path.
- When the runtime advertises `codingAgentsReview`, the dashboard fetches bounded review summaries through the trusted main-process IPC route and renders project, PR, round, status, and high-severity count.
- Review snapshot details render bounded file paths, additions/deletions, partial markers, selectable hunk coordinate metadata, gateway-bounded hunk lines, and safe finding summaries. Diff line containers are blocked from session recording.
- When thread creation is enabled, selecting a review hunk can open the mobile composer with bounded review metadata and a `structured_ref` attachment for the target file/hunk; the existing authenticated `createCodingAgentThread` gateway client performs the mutation.
- When thread creation is enabled, selecting a review hunk can seed the existing desktop composer with bounded review metadata and a `structured_ref` attachment for the target file/hunk; the normal trusted `runtime:create-thread` IPC path performs the mutation.
- Safe generic error state if the runtime summary is unavailable.
- Safe generic review error state if review summaries are unavailable; review failures do not drop the runtime summary dashboard.
- No provider credentials or bearer tokens are exposed to the renderer.

Focused tests:

- `tests/desktop/coding-agent-workspace.test.tsx`
- `tests/desktop/coding-agent-runtime-client.test.ts`
- `tests/desktop/ipc-contract.test.ts`
- `tests/desktop/ipc-handlers.test.ts`
- `tests/desktop/kernel-wiring.test.ts`

## Mobile Shell State

Gateway client:

- `apps/mobile/lib/gateway-client.ts`
- `getCodingAgentRuntimeSummary()` calls `GET /api/coding-agents/summary`, validates `RuntimeSummarySchema`, and returns the safe `"Runtime summary unavailable"` error on failure.
- `getCodingAgentThreadSnapshot()` calls `GET /api/coding-agents/threads/:threadId`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Thread state unavailable"` error on failure.
- `submitCodingAgentApprovalDecision()` posts bounded approval decisions to `POST /api/coding-agents/threads/:threadId/approvals/:approvalId/decision`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Approval could not be sent. Try again."` error on failure.
- `submitCodingAgentInputAnswer()` posts bounded answers to `POST /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Input could not be sent. Try again."` error on failure.
- `getCodingAgentReviews()` calls `GET /api/coding-agents/reviews`, validates a bounded review summary list, and returns the safe `"Review state unavailable"` error on failure.
- Existing terminal session methods call `/api/terminal/sessions`.

Screen:

- `apps/mobile/app/agents/index.tsx`
- `apps/mobile/app/agents/new.tsx`
- `apps/mobile/app/agents/[threadId].tsx`
- Read-only phone-first dashboard with providers, active threads, and terminal sessions.
- When the runtime advertises `codingAgentsReview`, the dashboard fetches bounded review summaries through the authenticated gateway client and renders project, PR, round, status, and high-severity count.
- Review snapshot details render bounded file paths, additions/deletions, partial markers, selectable hunk coordinate metadata, gateway-bounded hunk lines, and safe finding summaries.
- Safe generic review error state if review summaries are unavailable; review failures do not drop the runtime summary dashboard.
- Composer route for creating accepted coding-agent threads.
- Active thread rows navigate to `/agents/:threadId`; the thread route hydrates a bounded thread snapshot, shows provider/status/terminal metadata, event counts, loading, refresh, safe generic error states, and an event timeline for gateway-bounded snapshot events. Assistant text and file-change events render generic summaries instead of raw event text or paths. Live replay/subscription and richer transcript grouping remain follow-up work.
- Active thread rows render safe in-app attention badges for approval-required and input-required threads from the gateway-owned active-thread summary. Thread details render safe banners for approval-required, input-required, and failed threads from the bounded thread snapshot. No raw provider errors, paths, or event bodies are surfaced in these badges or banners.
- Approval-request events render allowed decisions in the mobile thread route. Decisions use mobile-generated idempotency request ids, go through the authenticated gateway client, and replace local thread details with the gateway-returned bounded snapshot. Failed decisions show a generic recovery-oriented message.
- User-input request events render a transient bounded answer composer in the mobile thread route. Answers use mobile-generated idempotency request ids, go through the authenticated gateway client, and replace local thread details with the gateway-returned bounded snapshot. Failed submissions show a generic recovery-oriented message.
- Thread details with a bound `terminalSessionId` can open the existing `/terminal` tab after persisting only the safe canonical shell-session reference in `mobile-shell-state`; terminal output and transcripts remain outside AsyncStorage.
- Flag: `apps/mobile/lib/feature-flags.ts` with `EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE === "1"`.

Persisted UI references:

- `apps/mobile/lib/agent-workspace-state.ts` stores only `selectedThreadId`, `selectedTerminalSessionId`, and `updatedAt`.
- `apps/mobile/lib/mobile-shell-state.ts` stores only the current shell mode plus safe bounded app or terminal session references, including canonical named shell sessions such as `main` or `matrix-abc1234`.
- Agent workspace state reconciles stale references against runtime summary items.
- Does not store transcripts, terminal output, file contents, diffs, credentials, approvals payloads, or launch tokens.

Focused tests:

- `apps/mobile/__tests__/gateway-client.test.ts`
- `apps/mobile/__tests__/agents-screen.test.tsx`
- `apps/mobile/__tests__/agent-thread-screen.test.tsx`
- `apps/mobile/__tests__/agent-workspace-state.test.ts`

## Browser Shell State

The browser shell remains Canvas-first. This stack has not moved coding-agent source of truth into browser shell state.

Relevant existing browser shell paths:

- `shell/src/lib/proxy-routes.ts` treats `/ws` and `/ws/*` as gateway paths.
- `shell/src/components/terminal/TerminalApp.tsx` continues to use canonical terminal sessions.
- Built-in app/canvas behavior remains outside this coding-agent stack.

Open follow-up: decide whether a browser-shell coding-agent entry belongs in Canvas, Developer mode, or both after desktop/mobile read-only shells settle.

Public docs note: public docs remain deferred for these review-summary/snapshot/follow-up slices because the cross-shell review flow still lacks shell-rendered full diff views and preview integration. Update `www/content/docs/` when the file/review/preview surfaces become stable in desktop, mobile, or browser shell navigation.

## Feature Flags

Defined capabilities in `RuntimeSummary`:

- `codingAgentsRuntimeSummary`
- `codingAgentsDesktopWorkspace`
- `codingAgentsMobileWorkspace`
- `codingAgentsThreadCreate`
- `codingAgentsApprovals`
- `codingAgentsReview`
- `codingAgentsNativeMobileTerminal`

Client flags:

- Desktop: `VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0"`.
- Mobile: `EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE === "1"`.

Server flags:

- Fake provider: `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1`.
- Workspace provider: `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER=1`.

Current behavior:

- Runtime summary advertises desktop/mobile read-only workspace capabilities only when the coding-agent thread store and workspace provider wiring are present.
- Runtime summary advertises `codingAgentsThreadCreate` when a coding-agent thread store is wired.
- Runtime summary advertises `codingAgentsApprovals` only when a thread store is wired and gateway summary wiring explicitly sets `capabilities.approvals`; current production wiring keeps it disabled until a provider/handler can bridge approval decisions to the running agent, not merely record local resolution events.
- Runtime summary advertises `codingAgentsNativeMobileTerminal` when a terminal registry is wired and the caller can read terminal sessions.
- Runtime summary advertises `codingAgentsReview` when the read-only coding-agent review summary route is wired.

## Baseline Commands

Focused gateway/contracts:

```bash
pnpm exec vitest run tests/gateway/coding-agents-workspace-provider.test.ts tests/gateway/coding-agents-threads.test.ts tests/gateway/coding-agents-thread-stream.test.ts tests/gateway/coding-agents-summary.test.ts tests/contracts/coding-agents.test.ts tests/gateway/agent-launcher.test.ts tests/gateway/agent-session-manager.test.ts tests/gateway/workspace-session-orchestrator.test.ts tests/observability/process-error-entrypoints.test.ts
```

Gateway typecheck:

```bash
pnpm --filter @matrix-os/gateway exec tsc --noEmit
```

Mobile focused Jest:

```bash
pnpm --filter matrix-os-mobile exec jest __tests__/gateway-client.test.ts __tests__/apps-screen.test.tsx __tests__/agents-screen.test.tsx __tests__/agent-thread-screen.test.tsx __tests__/agent-workspace-state.test.ts --runInBand
```

Desktop typecheck:

```bash
pnpm --filter desktop run typecheck
```

Repo gates:

```bash
bun run check:patterns
bun run typecheck
```

Docs-only slices:

```bash
git diff --check
```

## Open Questions And Deferred Work

- Session completion reconciliation: implemented for workspace `session.stopped` events that carry owner id, workspace session id, and bound `terminalSessionId`; the gateway thread store marks matching active coding-agent threads completed or failed server-side without matching unrelated owners or reused terminal ids. Remaining work: if runtime managers add autonomous process-exit detection beyond explicit workspace stop events, route those through the same `session.stopped` publisher path.
- File/review/preview shell surfaces: read-only review summaries now have coding-agent contracts/routes/desktop IPC/mobile clients plus desktop and mobile read-only review panels. A read-only review snapshot route now exposes bounded diff hunk metadata and capped hunk line bodies from safe owner worktrees plus partial findings-derived fallback metadata for later shell diff panels. Full file contents and previews are not implemented yet.
- Approval/input shell actions: desktop approval decisions and user-input answers now have trusted IPC, main-process gateway submission, bounded UI controls, and focused tests. Remaining work: mobile approval/input action sheets and cross-shell resolved-state refresh tests.
- Browser shell entry point: Canvas-first placement is still undecided.
- Notifications/attention routing: desktop notification IPC exists and notification clicks focus the coding-agent workspace thread in the Agents tab with a visible current-thread marker. Gateway runtime summaries now expose bounded `attentionThreads` separately from `activeThreads`, allowing failed or waiting attention to be surfaced without reclassifying terminal threads as active. Mobile now shows in-app active-thread attention badges and thread-detail banners from gateway-owned thread attention state. Remaining work: OS-level thread attention notifications are not yet wired end-to-end from gateway events, and desktop/mobile dashboards do not yet render the new `attentionThreads` list directly.
- Public docs: public Matrix OS docs should be updated once the user-facing coding-agent shell flow is stable enough to document.
