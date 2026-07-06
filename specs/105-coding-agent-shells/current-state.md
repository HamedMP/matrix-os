# Current State: Coding Agent Shells

**Branch stack**: `spec/coding-agent-shells` plus stacked implementation branches through `105-coding-agent-approvals`
**Updated**: 2026-07-06
**Scope**: Inventory for the coding-agent desktop/mobile shell work. This file records the current Matrix-native route, contract, client, and regression-test state so later slices keep gateway/runtime as source of truth and keep desktop/mobile as thin shells.

## Summary

The stack currently has shared contracts, a gateway runtime summary read model, read-only desktop and mobile workspaces behind flags, thread create/replay/abort/event streaming, provider adapters, a workspace-backed provider, and approval/input route handling. File/review/preview coding-agent surfaces are contract-only or existing workspace routes; they are not yet integrated into the coding-agent shell UI.

Current source-of-truth boundaries:

- Gateway/runtime owns coding-agent summaries, provider adapters, thread state, events, approvals, and terminal binding.
- Desktop gets coding-agent data through main-process IPC and never receives bearer/provider credentials.
- Mobile gets coding-agent data through the existing authenticated gateway client and stores only bounded UI references.
- Canonical terminal sessions remain the existing Matrix shell/session primitives under `/api/terminal/sessions` and `/ws/terminal`.

## Shared Contracts

Package: `packages/contracts/src/index.ts`

Implemented coding-agent schemas:

- IDs and bounds: `RuntimeIdSchema`, `ProviderIdSchema`, `ProjectIdSchema`, `TaskIdSchema`, `ThreadIdSchema`, `EventIdSchema`, `ApprovalIdSchema`, `RequestIdSchema`, `CorrelationIdSchema`, `TerminalSessionIdSchema`, `WorktreeIdSchema`, `CursorSchema`, `IsoTimestampSchema`, `SafeDisplayStringSchema`, `SafeClientErrorSchema`.
- Runtime summary: `RuntimeTargetSchema`, `RuntimeCapabilitySchema`, `RuntimeLimitsSchema`, `RuntimeSummarySchema`.
- Providers: `AgentProviderSummarySchema`, provider availability/install/auth enums, `AgentModeSchema`, `ApprovalPolicySchema`, `SandboxModeSchema`, `SafeSetupActionSchema`.
- Threads: `CreateAgentThreadRequestSchema`, `AgentThreadSummarySchema`, `AgentThreadStatusSchema`, `AgentAttachmentSchema`, `AgentThreadSnapshotSchema`.
- Events: `AgentThreadEventSchema` discriminated union with lifecycle, text delta, tool activity, approval/input, file change, review ready, terminal bound, safe error, and completion event variants.
- Approvals/input: `AgentApprovalRequestSchema`, `ApprovalDecisionRequestSchema`, `UserInputRequestSchema`, `UserInputAnswerRequestSchema`.
- Terminal frames/summaries: `TerminalSessionSummarySchema`, `TerminalClientFrameSchema`, `TerminalServerFrameSchema`.
- File/review/preview: `FilePathSchema`, `FileMetadataSchema`, `ReviewFileDiffSchema`, `PreviewSessionSummarySchema`.

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
| `/api/coding-agents/threads/:threadId` | `GET` | Implemented | Authenticated snapshot replay for one thread. |
| `/api/coding-agents/threads/:threadId/events` | `GET` | Implemented | Authenticated snapshot replay with optional cursor. |
| `/api/coding-agents/threads/:threadId/abort` | `POST` | Implemented | Body limit 8 KiB, idempotent abort by client request id. |
| `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` | `POST` | Implemented | Body limit 8 KiB, validates approval id and decision payload. |
| `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` | `POST` | Implemented | Body limit 40 KiB, validates bounded answer payload. |

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
- Terminal session summaries from the existing terminal registry adapter.
- Bounded list metadata and runtime limits.

Safe degradation:

- Optional dependency failures return partial safe summaries.
- Summary tests assert caps, stable sort, and no sensitive fields.

Focused tests:

- `tests/gateway/coding-agents-summary.test.ts`

## Providers And Thread Store

Core files:

- `packages/gateway/src/coding-agents/thread-store.ts`
- `packages/gateway/src/coding-agents/provider-registry.ts`
- `packages/gateway/src/coding-agents/workspace-provider.ts`

Implemented providers:

- Fake provider for deterministic gateway tests behind `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1`.
- Workspace-backed provider behind `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER=1`.

Workspace provider behavior:

- Starts deterministic workspace agent sessions through `WorkspaceSessionOrchestrator`.
- Passes through prompt, project, task, worktree, mode, approval policy, sandbox mode, and zellij runtime preference.
- Binds coding-agent threads to canonical `terminalSessionId` from the workspace session.
- Aborts through the deterministic workspace session id.
- Keeps provider startup failures safe in the returned thread snapshot.

Thread store behavior:

- Owner-scoped thread summaries and events.
- Idempotent thread creation, aborts, approval decisions, and input answers by bounded request-id arrays.
- Event replay with bounded per-thread event storage.
- Safe terminal statuses and attention states derived from events.

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
- `notify` accepts bounded notification data with `threadId`, `title`, `body`, and kind.
- `notification:clicked` emits bounded `threadId`.

Main process:

- `desktop/src/main/coding-agents/runtime-summary-client.ts`
- Fetches `/api/coding-agents/summary` from the selected runtime origin with bearer auth in the main process.
- Uses `AbortSignal.timeout(10_000)` and validates `RuntimeSummarySchema`.
- Renderer receives only parsed summary data through IPC.

Renderer:

- Store: `desktop/src/renderer/src/stores/coding-agent-workspace.ts`.
- UI: `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`.
- Integration point: `desktop/src/renderer/src/features/mission-control/TabContent.tsx`.
- Flag: `desktop/src/renderer/src/lib/feature-flags.ts` with `VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0"`.

Current behavior:

- Read-only dashboard renders providers, active threads, and terminals.
- Safe generic error state if the runtime summary is unavailable.
- No provider credentials or bearer tokens are exposed to the renderer.

## Mobile Shell State

Gateway client:

- `apps/mobile/lib/gateway-client.ts`
- `getCodingAgentRuntimeSummary()` calls `GET /api/coding-agents/summary`, validates `RuntimeSummarySchema`, and returns the safe `"Runtime summary unavailable"` error on failure.
- Existing terminal session methods call `/api/terminal/sessions`.

Screen:

- `apps/mobile/app/agents.tsx`
- Read-only phone-first dashboard with providers, active threads, and terminal sessions.
- Flag: `apps/mobile/lib/feature-flags.ts` with `EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE === "1"`.

Persisted UI references:

- `apps/mobile/lib/agent-workspace-state.ts`
- Stores only `selectedThreadId`, `selectedTerminalSessionId`, and `updatedAt`.
- Reconciles stale references against runtime summary items.
- Does not store transcripts, terminal output, file contents, diffs, credentials, approvals payloads, or launch tokens.

Focused tests:

- `apps/mobile/__tests__/gateway-client.test.ts`
- `apps/mobile/__tests__/agents-screen.test.tsx`
- `apps/mobile/__tests__/agent-workspace-state.test.ts`

## Browser Shell State

The browser shell remains Canvas-first. This stack has not moved coding-agent source of truth into browser shell state.

Relevant existing browser shell paths:

- `shell/src/lib/proxy-routes.ts` treats `/ws` and `/ws/*` as gateway paths.
- `shell/src/components/terminal/TerminalApp.tsx` continues to use canonical terminal sessions.
- Built-in app/canvas behavior remains outside this coding-agent stack.

Open follow-up: decide whether a browser-shell coding-agent entry belongs in Canvas, Developer mode, or both after desktop/mobile read-only shells settle.

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

- Runtime summary advertises desktop/mobile read-only workspace capabilities as enabled when the summary service is available.
- Runtime summary advertises `codingAgentsThreadCreate` and `codingAgentsApprovals` when a coding-agent thread store is wired.
- Runtime summary advertises `codingAgentsNativeMobileTerminal` when a terminal registry is wired and the caller can read terminal sessions.
- Runtime summary keeps `codingAgentsReview` disabled until coding-agent-specific review shell integration is implemented.

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
pnpm --filter matrix-os-mobile exec jest __tests__/gateway-client.test.ts __tests__/apps-screen.test.tsx __tests__/agents-screen.test.tsx __tests__/agent-workspace-state.test.ts --runInBand
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

- Session completion reconciliation: workspace-backed sessions need a runtime event path that marks coding-agent threads completed/failed when the underlying workspace session exits without a user abort.
- File/review/preview shell surfaces: contracts exist and workspace routes exist, but coding-agent-specific UI integration is not implemented yet.
- Browser shell entry point: Canvas-first placement is still undecided.
- Notifications/attention routing: desktop notification IPC exists, but thread attention notifications are not yet wired end-to-end from gateway events.
- Public docs: public Matrix OS docs should be updated once the user-facing coding-agent shell flow is stable enough to document.
