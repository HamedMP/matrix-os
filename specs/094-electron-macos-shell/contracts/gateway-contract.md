# Gateway Contract (consumed by Operator)

Verified against `packages/gateway/src/` on `main` (2026-06-13) and the 092 prototype. The
desktop client adds NO new server routes in this feature; deltas it depends on are listed at
the end. All HTTP via the platform proxy host with `Authorization: Bearer <token>`;
`?runtime=<slot>` appended when slot ≠ primary. Every call carries
`AbortSignal.timeout(10_000)` (30s for file downloads).

## Auth (platform-side)

| Route | Method | Request | Response |
|---|---|---|---|
| `/api/auth/device/code` | POST | `{clientId: "matrix-os-desktop", redirectUri}` | `{deviceCode, userCode, verificationUri, expiresIn, interval}` |
| `/api/auth/device/token` | POST | `{deviceCode}` | 200 `{accessToken, expiresAt(ms), userId, handle}` · 428 pending · 429 slow-down (+5s) · 410 expired |
| `/api/auth/app-session` | POST | `{redirectTo}` | Set-Cookie ×2: `matrix_app_session` AND `matrix_native_app_session` (both REQUIRED — L2) |

## Workspace / board

| Route | Method | Notes |
|---|---|---|
| `/api/workspace/projects` | GET | projects list |
| `/api/projects/{slug}/tasks` | GET | paginated `?limit&cursor&includeArchived` |
| `/api/projects/{slug}/tasks` | POST | `{title(1-200), description?, status?, priority?, order?, parentTaskId?, dueAt?, linkedSessionId?, linkedWorktreeId?, previewIds?}` |
| `/api/projects/{slug}/tasks/{id}` | PATCH/DELETE | update fields optional; server is last-write-wins → client serializes per-task mutations |
| `/api/workspace/events` | GET | REST poll `?projectSlug&taskId&sessionId&limit&cursor` (fallback alongside `/ws` task events) |

## Sessions / terminal

| Route | Method | Notes |
|---|---|---|
| `/api/terminal/sessions` | GET | zellij sessions `{name, status}` — attach by `name` |
| `/api/sessions` | GET | workspace records; attachable ONLY if `runtime.zellijSession` non-empty (L6); `POST {kind:shell}` is agent-only (400) — create via WS auto-create |

### WS `/ws/terminal/session?session=<name>&fromSeq=<n>` (attach existing)
### WS `/ws/terminal?cwd=<path>` (auto-create)

- Auth: Authorization header at upgrade (query `?token=` exists only as browser fallback).
- Live-tail sentinel: `fromSeq = 9_007_199_254_740_991` → server replays last 50 events.
- **Client→server**: `{type:"input", data≤65536}` · `{type:"resize", cols 1-500, rows 1-200}` · `{type:"detach"}` · `{type:"ping"}`
- **Server→client**: `{type:"attached", session, state:"running"|"exited", fromSeq}` ·
  `{type:"output", seq, data}` · `{type:"exit", code}` · `{type:"pong"}` ·
  `{type:"error", code, message}` · `{type:"replay-evicted", fromSeq, nextSeq}` (legacy path;
  named path may instead silently skip — client tolerates both)
- Fatal codes (stop retrying, recreate CTA): `session_not_found`, `invalid_request`, `attach_failed`.
- Nonfatal: `buffer_overflow`, `invalid_message`.

## Kernel `/ws` (Hermes + events)

- **Client→server**: `{type:"message", text(1-100k), displayText?, sessionId?, requestId?}` ·
  `{type:"switch_session", sessionId}` · `{type:"approval_response", id, approved}` ·
  `{type:"abort", requestId}` · `{type:"ping"}`
- **Server→client** (subset consumed): `kernel:init{sessionId,requestId?}` ·
  `kernel:text{text,requestId?}` · `kernel:tool_start{tool,requestId?}` ·
  `kernel:tool_end{input?,requestId?}` · `kernel:result{data,requestId?}` ·
  `kernel:error{message,requestId?}` · `kernel:aborted{requestId?}` ·
  `session:switched{sessionId}` · `task:created{task}` · `task:updated{taskId,status}` ·
  `approval:request{id,toolName,args,timeout}` · `file:change{path,event}` · `pong`
- Schema source: `packages/gateway/src/ws-message-schema.ts`, `server.ts:319-345`.

## Files

| Route | Method | Notes |
|---|---|---|
| `/api/files/list` · `/api/files/tree` | GET | `?path=` |
| `/api/files/stat` | GET | `?path=` → mtime/size/type (basis of save conflict guard) |
| `/api/files/search` | GET | `?q&path&content&limit≤500` |
| `/files/{path}` | GET/PUT | PUT is unconditional overwrite → client stat-guard before save |

## Apps & embeds

| Route | Method | Notes |
|---|---|---|
| `/api/apps` | GET | catalog `{slug, name, icon, category}` |
| `/api/apps/{slug}/session-token` | POST | `{token, expiresAt(ms), launchUrl}`; launchUrl MUST be relative, resolved against gateway origin, foreign origins rejected |

## Git / system / settings (read parity)

| Route | Method | Notes |
|---|---|---|
| `/api/projects/{slug}/branches` · `/prs` · `/worktrees` · `/previews` | GET | lists + `refreshedAt` |
| `/api/projects/{slug}/worktrees` | POST | `{branch?} XOR {pr}` |
| `/api/system/info` | GET | version/runtime/build/resources/release/channels/skills |
| `/api/settings/theme` | GET/PUT | appearance parity |

## Dependencies (server deltas — degrade gracefully until they land)

1. **Full task event push** on `/ws` (`task:updated` full-record + delete) — today only
   created + status; client supplements with focus-refresh.
2. **Kill zellij session by name** — terminate UI disabled-with-tooltip until present.
3. **Diff content endpoint** — git panel ships lists/status only; diff pane gated.
4. **Desktop release feed** (signed, channel-aware) — updater no-ops without it.
5. **Process listing endpoint** — processes panel shows an explicit unavailable state until present.
6. **Command-completion attention signal** — best-effort; absent = no terminal-idle notifications.
