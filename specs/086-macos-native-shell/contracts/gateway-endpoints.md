# Contract: Gateway Endpoints Consumed by the macOS App

These already exist in `packages/gateway/src/workspace-routes.ts` (+ session orchestrator, symphony proxy). The app is a client; confirm exact shapes against source during implementation. All carry the principal (`Authorization` header) and are scoped via `ownerScopeFromPrincipal`. All responses use generic error bodies (no raw internals).

## Tasks (= kanban cards)
- `GET  /api/workspace/projects` — list projects.
- `GET  /api/projects/:slug/tasks` — list tasks (cards) for a project.
- `POST /api/projects/:slug/tasks` — create. Body (`CreateTaskSchema`): `{ title(1..200), description?(<=10000), status?(todo|running|waiting|blocked|complete|archived), priority?(low|normal|high|urgent), order?, parentTaskId?, dueAt?, linkedSessionId?, linkedWorktreeId?, previewIds?[<=20] }`. (`tags?` only if T040 ships it.)
- `PATCH /api/projects/:slug/tasks/:taskId` — partial update (`UpdateTaskSchema` = CreateTaskSchema.partial()). Used for move (status), reorder (order), rename (title), tag. MUST be revision/`updatedAt`-guarded server-side (optimistic concurrency).
- `DELETE /api/projects/:slug/tasks/:taskId` — archive/delete (filter already-deleted).

**Mapping**: column = `status`; intra-column position = `order`; card↔session = `linkedSessionId`; worktree chip = `linkedWorktreeId`; preview chips = `previewIds`.

## Sessions (zellij-backed)
- `POST /api/sessions` — start a session (links to a task via request). Returns `{ session }`.
- `GET  /api/sessions?projectSlug=&taskId=&status=&limit=&cursor=` — list (filter by `taskId` to find a card's session). Returns `{ sessions, nextCursor }`.
- `GET  /api/sessions/:sessionId` — get one.
- `POST /api/sessions/:sessionId/send` — send input (non-WS path).
- `POST /api/sessions/:sessionId/observe` — attach read-only.
- `POST /api/sessions/:sessionId/takeover` — attach as owner.

Terminal I/O for the UI uses the **shell WS** (see `shell-ws-protocol.md`), not `/send`.

## Workspace events (live board updates)
- Publisher: `workspace-event-publisher.ts` emits `task.created`, `task.updated` (scope `{projectSlug, taskId}`). Phase 0/T002 confirms the client-facing delivery (existing WS vs new subscription). Client diff-applies to `BoardStore`.

## Symphony
- Via `packages/gateway/src/symphony/proxy.ts` — run status + agent activity read-model; start/observe actions. Exact routes confirmed in T070.

## Auth / endpoint resolution
- Device-auth + VPS endpoint resolution via platform (`packages/platform/src/customer-vps-routes.ts`, `/runtime`); see `auth.md` matrix in plan.md. Confirmed in T004.

## Error policy
- Every client-facing error is generic; the app shows safe copy and never echoes gateway/DB/provider/path text (FR-023). Misconfiguration (no VPS) is distinguished from not-found and transient connectivity.
