# Coding-Agent Backend Shell Handoff

This note is the stable integration boundary for desktop and mobile Conversation/Kanban work. The gateway and canonical workspace services remain the source of truth; shell clients render bounded projections and persist only safe selection references.

## Hydration

1. Fetch `GET /api/coding-agents/summary` and validate `RuntimeSummarySchema`.
2. Read `codingAgentsProjectWorkspace` before enabling project-first navigation.
3. Read `codingAgentsSameThreadTurns` before enabling the selected-thread composer.
4. Treat `codingAgentsConversationView` and `codingAgentsKanbanView` as additive shell capability flags.
5. Select a project from `summary.projects.items`, then fetch `GET /api/coding-agents/projects/:projectId/workspace`.

`ProjectAgentWorkspaceSchema` is the canonical bounded navigation projection. Its `projectThreads` and `taskThreads` lists are independent; a task may own several selectable threads. Canonical task status comes from `tasks.items` and must not be inferred from thread status.

## Mutations

- Create a new project chat or task chat with `POST /api/coding-agents/threads` and `CreateAgentThreadRequestSchema`. New shell-created threads require `projectId`; `taskId` is optional but must belong to that project.
- Send later messages to the selected conversation with `POST /api/coding-agents/threads/:threadId/turns` and `CreateAgentTurnRequestSchema`. A 202 response is newly accepted, a 200 response is an idempotent retry, and a safe 409 means the shell should keep the current thread selected and offer retry after refresh.
- Adopt an old unassigned conversation with `POST /api/coding-agents/threads/:threadId/adopt` and `AdoptAgentThreadRequestSchema`. This compatibility route cannot move an already assigned thread.
- Keep task create/update/delete on the canonical `/api/projects/:projectId/tasks` routes. Thread state never moves a Kanban card automatically.
- Continue using the existing abort, approval-decision, and input-answer routes with a new bounded `clientRequestId` per user action.

Every persisted public thread change emits a bounded `coding-agent.thread.created`, `coding-agent.thread.updated`, or `coding-agent.thread.removed` workspace activity event in its project/task scope. Shells may use the existing authenticated workspace activity path as a refresh signal; they must re-fetch the project workspace rather than reconstructing aggregates from events.

## Conversation Replay

- Fetch `GET /api/coding-agents/threads/:threadId` for the latest bounded `AgentThreadSnapshotSchema` window.
- Fetch `GET /api/coding-agents/threads/:threadId/events?cursor=...` for bounded continuation.
- Subscribe to `/ws/coding-agents/thread/:threadId` through the existing authenticated shell client and validate every frame before reducing it.
- Keep the server-provided `threadId`, event cursor, and event IDs. Never store transcripts, terminal output, provider resume identity, approvals, file contents, or diffs in shell persistence.

Workspace input delivery completes the accepted turn but does not complete a still-running thread. The canonical workspace session-stop path owns terminal thread completion/failure. Shell reducers should therefore render turn and thread lifecycle independently.

## Error And Recovery Rules

- Render only allowlisted bounded `safeMessage` values; use a generic refresh/retry fallback for unknown client errors.
- On runtime switch or foreground resume, re-fetch summary and reconcile selected project/task/thread IDs against live projections.
- A missing selected thread is recoverable navigation state, not proof that the provider or runtime failed.
- Provider credentials, bearer credentials, server-only resume identity, filesystem paths, and raw provider errors never cross into shell state.

## Focused Backend Validation

```bash
pnpm exec vitest run tests/contracts/coding-agent*.test.ts tests/gateway/coding-agent*.test.ts tests/gateway/workspace-event-publisher.test.ts tests/gateway/workspace-events.test.ts tests/gateway/workspace-routes.test.ts tests/gateway/workspace-session-orchestrator.test.ts tests/gateway/zellij-runtime.test.ts tests/gateway/agent-session-manager.test.ts
pnpm --filter @matrix-os/gateway exec tsc --noEmit
bun run check:patterns
bun run typecheck
```

For deterministic local UI development, set `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1` in the gateway environment. Real workspace execution remains separately flag-controlled and should not be required to build or test shell navigation, loading, empty, busy, retry, and replay states.
