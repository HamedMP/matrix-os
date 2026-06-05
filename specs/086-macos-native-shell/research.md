# Research: Matrix OS macOS App (Phase 0)

**Feature**: [086-macos-native-shell](./spec.md)

## Headline finding: the backend already exists

A grep-level audit of `packages/gateway/src` shows the "card ⇄ session ⇄ task" model is already implemented. The macOS app is a **native client over existing routes**, not a new backend.

### Evidence

| Concern | Existing surface | File |
|---|---|---|
| Kanban tasks | `CreateTaskSchema { title, description, status: todo\|running\|waiting\|blocked\|complete\|archived, priority, order, parentTaskId, linkedSessionId, linkedWorktreeId, previewIds }`; routes `GET/POST/PATCH/DELETE /api/projects/:slug/tasks[/:taskId]` | `workspace-routes.ts`, `task-manager.ts` |
| Card↔session link | task `linkedSessionId`; `listSessions({ taskId })` | `workspace-routes.ts` |
| Session lifecycle | `/api/sessions` (start), `/:id` (get), `/:id/send`, `/:id/observe`, `/:id/takeover`; session orchestrator | `workspace-routes.ts`, `workspace-session-orchestrator.ts` |
| Terminal attach | `createShellWsHandler` with `fromSeq`, `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ`, `SHELL_ATTACH_RECENT_REPLAY_EVENTS=50`, `ShellReplayBuffer.replayFromSeq`, `replay-evicted`; messages `input/resize/detach/ping` ↔ `attached/output(seq)/exit/error/pong` | `shell/ws.ts` |
| zellij ops | `listSessions / createSession({name,cwd,layout,cmd}) / attachSession / listTabs / createTab` | `shell/zellij.ts` |
| Live board updates | `workspace-event-publisher.ts` → `task.created`, `task.updated` with scope `{projectSlug, taskId}`; events store | `workspace-event-publisher.ts`, `workspace-events.ts` |
| WS principal auth (header) | canvas WS does `requireRequestPrincipal(c).userId` inside `upgradeWebSocket((c)=>…)` — proves header-based principal on WS upgrades | `server.ts` (`/api/canvases/:id/ws`) |
| Subscriber hub pattern | `canvasSubscriptionHub.subscribe({connectionId,userId,send})` with per-send try/catch | `server.ts` |
| Symphony | `symphony/proxy.ts`, `symphony-runner.ts` | gateway |
| VPS endpoint resolution | platform `customer-vps-routes.ts`, `ws-upgrade.ts`, `/runtime` | `packages/platform` |

## Decisions

1. **D1 — Reuse, don't rebuild.** Board CRUD = task routes; sessions = session routes; terminals = shell WS. Net-new backend limited to: optional task `tags`, native-WS header-auth confirmation, and a native board-events subscription only if `task.*` events aren't already exposed over a client WS.
2. **D2 — Terminal emulator = SwiftTerm.** Mature Swift VT100/xterm emulator; avoids hand-rolling ANSI parsing. The WS client maps `output/seq` → feed, `input` → send, `resize` → resize; tracks `lastSeq` for resume.
3. **D3 — Reconnect (F1).** Reattach with `fromSeq = lastSeq + 1`; on `replay-evicted` clear buffer and re-attach at `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ`. No duplication/gap.
4. **D4 — Native networking.** `URLSession` (HTTP, bounded timeouts) + `URLSessionWebSocketTask` (sets `Authorization` header on the upgrade — S1). No third-party networking deps.
5. **D5 — App target placement.** New top-level `macos/` Swift package/Xcode target, outside pnpm/turbo, to isolate native build + any GPL-adjacent UX inspiration from the TS monorepo.
6. **D6 — Auth = platform device flow** (same as `matrix` CLI), principal token in Keychain; VPS resolved via platform.

## Open confirmations for implementation (cheap, do first)
- C1: exact shell-WS route path + that it reads principal from the `Authorization` header (extend if it currently only accepts query token).
- C2: whether `task.*` workspace events are already delivered over a client-facing WS (if yes, no new subscription needed).
- C3: session-archive semantics — detach vs terminate in the orchestrator.
- C4: platform endpoint-resolution contract for multi-VM selection.

These are confirmations, not unknowns that block design; each maps to a Phase-0 task.

## Phase 0 confirmation results (T001-T004)

Verified against `packages/gateway/src` and `packages/platform/src` at branch `086-macos-native-shell`. All four confirmations resolved; **no gateway delta is required** (no failing tests added).

### C1 / S1 — Shell-WS route + Authorization-header auth ✅ CONFIRMED (header auth already accepted)

**Routes.** There are two zellij shell-WS routes, both `app.get(...)` + `upgradeWebSocket(...)` in `packages/gateway/src/server.ts`:
- `/ws/terminal/session` — `server.ts:2274` (attach an existing named session; requires `?session=`, optional `?fromSeq=`).
- `/ws/terminal` — `server.ts:2358` (named attach via `?session=` OR auto-create via `?cwd=`; optional `?fromSeq=`).

Both delegate to `zellijShellWs.open({ ws, session, fromSeq })`, where `zellijShellWs = createShellWsHandler(...)` (`server.ts:511`, handler in `packages/gateway/src/shell/ws.ts:108`). The handler validates the session name (`validateSessionName`), attaches, replays from `effectiveFromSeq`, and pumps `output(seq)/exit/error/pong` ↔ `input/resize/detach/ping` (matches D2/D3).

**Auth mechanism.** Auth is enforced by the global `authMiddleware(process.env.MATRIX_AUTH_TOKEN)` (`server.ts:1632`, impl `packages/gateway/src/auth.ts:142`), not by the route handlers. The handlers themselves do **not** call `requireRequestPrincipal(c)` (unlike the canvas WS at `server.ts:4124`).

Both shell-WS paths are listed in `WS_QUERY_TOKEN_PATHS` (`auth.ts:89`): `["/ws", "/ws/voice", "/ws/terminal", "/ws/terminal/session", "/ws/onboarding", "/ws/vocal"]`. For these paths the middleware computes `presentedToken` from **either** an `Authorization: Bearer <token>` header **or** the `?token=` query param (`auth.ts:233-237`). The query-param fallback exists only because browsers cannot set headers on a WS upgrade; native clients can. Both legacy shared-secret (`timingSafeCompare`, `auth.ts:270-277`) and platform JWT (`looksLikeJwt` → `validateSyncJwt`, `auth.ts:243-268`) accept the token from header or query.

**Conclusion:** the shell WS **already accepts header-based auth**. `URLSessionWebSocketTask` can set `Authorization` on the upgrade (D4/S1), so the macOS client needs no gateway change. This is already locked by existing tests:
- `tests/gateway/terminal-zellij-ws.test.ts:254` "accepts terminal query token and bearer auth..." asserts `/ws/terminal` succeeds with `Authorization: Bearer secret-token` (`next` called twice, line 276).
- `tests/gateway/auth.test.ts:201,211` cover `/ws/terminal[/session]` query-token success; `tests/gateway/auth-jwt.test.ts:206` covers JWT query-token success.

Because the "header auth missing" branch is **false**, no `tests/gateway/shell-ws-header-auth.test.ts` failing test was written (it would duplicate green coverage). One caveat for the client design (not a gateway blocker): the shell-WS handlers do not derive a per-user principal — the gateway is single-user/single-VPS and the principal is implicit. The macOS client resolves the correct VPS via the platform (see C4) and presents that VPS's principal token; cross-user isolation is enforced by the platform proxy, not by per-handler scoping on these routes.

### C2 / W1 — Are `task.*` events delivered over a client WS? ❌ NO. A new board-events subscription is needed.

`task.created` / `task.updated` / `task.deleted` are produced by `createWorkspaceEventPublisher` (`packages/gateway/src/workspace-event-publisher.ts:48-70`) and **persisted only** to the JSON file `system/workspace-events.json` via `createWorkspaceEventStore.publishEvent` (`packages/gateway/src/workspace-events.ts:127-142`, max 5000 events). They are exposed to clients **only by polling** `GET /api/workspace/events` (`packages/gateway/src/workspace-routes.ts:484`, → `eventStore.listEvents`, query-filterable by `projectSlug/taskId/...` with cursor+limit).

There is **no client-facing WebSocket that pushes `task.*` events**. The only WS subscription hubs in the gateway are:
- `CanvasSubscriptionHub` (`server.ts:756`, `packages/gateway/src/canvas/subscriptions.ts`) — canvas documents only.
- The sync peer registry (`sync/ws-events.ts`, `server.ts:2133` `sync:subscribe`) — file-sync `sync:change` between device peers, not workspace task events.

Neither carries board events.

**Decision (W1) — a new board-events subscription endpoint IS required** for the "<2s cross-client" board-sync goal (US2 / T040, T044). Until it exists, US1 can ship by polling `GET /api/workspace/events`. Design for the new endpoint (do **not** implement in Phase 0):
- **Route:** `GET /api/workspace/events/ws` (or `/ws/workspace-events`) as a Hono `upgradeWebSocket` route. Add its path to `WS_QUERY_TOKEN_PATHS` / `WS_QUERY_TOKEN_PATH_PATTERNS` in `auth.ts` so browser query-token upgrades pass (native clients use the header). Derive the principal with `requireRequestPrincipal(c)` inside the upgrade callback (mirror canvas WS at `server.ts:4124`).
- **Subscriber registry:** a bounded hub modeled on `CanvasSubscriptionHub` — `subscribe({ connectionId, userId, projectSlug?, send })`, per-send `try/catch` that logs and **evicts dead senders** after the broadcast loop, an explicit **size cap + LRU/stale eviction** (network partitions can skip `onClose`), a periodic stale-`lastTouched` sweep, and a **shutdown drain** added to the gateway close path. Filter delivery by `event.scope.projectSlug` (and optionally `taskId`) so a subscriber only receives its project's events.
- **Publish hook:** have `createWorkspaceEventPublisher` (or the routes that call it) notify the hub after `publishEvent` succeeds, emitting the generic stored `ActivityEvent` (id, type, scope, payload, createdAt). Persisted store remains the source of truth; the WS is a best-effort fast path with REST polling as the backstop/reconciliation read.

### C3 — Session archive = detach, NOT terminate ✅ CONFIRMED

Archiving a task is a **pure metadata mutation** on the task record. `taskManager.updateTask` (`packages/gateway/src/task-manager.ts:206-228`) sets `status: "archived"` and stamps `archivedAt` (`task-manager.ts:225`); it never touches `linkedSessionId`'s runtime. There is **no** call to `killSession` / `stopSession` / `registry.destroy` anywhere in the archive path. Archived tasks are simply filtered out of normal `listTasks` reads unless `includeArchived` is set (`task-manager.ts:198`).

Session lifecycle is fully decoupled and has two distinct operations:
- **detach** — `SessionRegistry` handle `detach()` (`packages/gateway/src/session-registry.ts:474-487`): removes the subscriber, decrements `attachedClients`. The PTY/zellij session keeps running; nothing is killed. (Shell-WS `detach` message → `closeSession` aborts only that attach process; the underlying zellij session persists — `shell/ws.ts:228-232`.)
- **terminate** — `SessionRegistry.destroy(sessionId)` (`session-registry.ts:493-515`): `session.kill()`, clears subscribers + replay buffer, deletes the registry entry. The workspace-level equivalent is `orchestrator.stopSession` → `agentSessionManager.killSession` (`workspace-session-orchestrator.ts:177-182`, `agent-session-manager.ts:405`), which also publishes `session.stopped`.

**Semantics for the app (validates T045):** archive defaults to **detach** (close the terminal panel, leave the zellij session alive and reattachable via `fromSeq`); **terminate** (`stopSession`/`destroy`) is a separate, explicit, confirm-gated action. No backend change required; the app drives both via existing routes.

### C4 / W2 — Platform VPS endpoint resolution + multi-VM selection ✅ CONFIRMED

The macOS app does **not** address a VPS directly. The platform (`packages/platform/src/main.ts`) is a **reverse proxy**: the client always talks to the app domain (`app.matrix-os.com` / `app.localhost`, `customer-vps` for code domain), and the platform resolves and forwards to the user's VPS over `https://${machine.publicIPv4}:443/...` (e.g. `main.ts:1579`, `:3607`, `:3810`, `:3964`, `:4140`; health probe `main.ts:4278`).

**Resolution key = Clerk identity + `runtimeSlot`.** Requests are authenticated to a Clerk `userId`/`handle` (app-session cookie / JWT). The platform selects the machine with `getRunningUserMachineByClerkId(db, userId, runtimeSlot)` then `getActiveUserMachineByClerkId(...)` (`main.ts:3885-3896`, also `:1532-1536`, `:4018`), falling back to handle lookup. `runtimeSlot` (`RuntimeSlotSchema`, `customer-vps-schema.ts`) defaults to `'primary'`; other slots (e.g. `staging`) are the multi-VM mechanism.

**Multi-VM selection / `/runtime`.** The slot is chosen by the `?runtime=<slot>` query param (`main.ts:481-488`, `:522-524`); it is a platform-only selector that is stripped before forwarding upstream (`ws-upgrade.ts:116` `stripWebSocketUpgradeToken` deletes `runtime`; query-forwarding allowlist omits it, `main.ts:508-524`). The `/runtime` path renders a **runtime picker** page when the user has machines (and auto-redirects when 0/1) — `main.ts:3860-3881` (`getRuntimePickerPage`, `buildRuntimePickerMachines`, `listActiveUserMachinesByClerkId`). Explicit addressing of a specific machine uses `/vm/{handle}/...` routes (`main.ts:1089`, `:951`).

**WS upgrades** through the platform use `getSessionRoutedWebSocketHost` / `getWebSocketUpgradeHost` (`ws-upgrade.ts:12-64`), reading `x-forwarded-host`, validating the host against the app/code allowlists, and treating internal-origin upgrades that carry a `?token=` as `app.matrix-os.com`.

**Client-facing flow for the macOS app (validates D6, T026):**
1. Device-auth via the platform device flow (same as the `matrix` CLI; `packages/platform/src/device-flow.ts`), store the principal/JWT in Keychain.
2. Connect to the app domain (`https://app.matrix-os.com`), not the VPS IP. The platform resolves `userId → primary` machine and proxies.
3. For multi-VM, fetch the user's machines (runtime picker / fleet) and let the user select a slot; pass `?runtime=<slot>` on subsequent requests. Default is `primary`.
4. All HTTP and the shell WS go through the platform proxy; the macOS client never needs (and must not assume) a direct `publicIPv4`. Auth token travels in the `Authorization` header (HTTP + WS), which both the platform proxy and the gateway accept (C1).
