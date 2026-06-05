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
