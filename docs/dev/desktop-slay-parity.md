# Matrix Desktop Slay Zone Parity

Slay Zone is the workflow reference for Matrix Desktop. Matrix should preserve
the useful product loops while keeping Matrix ownership, cloud runtime, and
security constraints.

## Parity Map

| Slay-like capability | Matrix Desktop status | Matrix implementation |
| --- | --- | --- |
| Native desktop workbench | Implemented foundation | Electron wrapper in `apps/desktop` loads Matrix shell |
| App launcher and default apps | Implemented foundation | Existing shell launcher plus desktop-aware affordances |
| Project command center | Implemented foundation | `WorkspaceApp` shows projects, tickets, sessions, worktrees, previews, events, workflow, shared board members |
| Task/workbench tabs | Implemented foundation | Serializable task workbench store and tabs |
| Agent status panel | Implemented foundation | Cloud session status panel; no local agent starts |
| Terminal/session visibility | Implemented foundation | Cloud sessions can be observed, taken over, duplicated, or killed |
| Git/worktree information | Implemented foundation | Gateway worktree endpoints and workspace panel |
| Linear ticket sync | Implemented foundation | Server-side Linear sync into tracked tickets |
| Matrix-native tickets | Implemented foundation | Kysely `tracked_tickets` repository and ticket routes |
| Unified Kanban/list | Implemented foundation | Workspace unified ticket surface with scale tests |
| Symphony assignment | Implemented foundation | Manual/rule assignment creates cloud worktree/session claims |
| Duplicate claim prevention | Implemented foundation | Active claim uniqueness in Symphony repository/orchestrator |
| Workflow file awareness | Implemented foundation | Project workflow setup/live/preview config routes and UI |
| Browser/previews | Implemented foundation | Preview refs with SSRF and redirect protections |
| Shared team boards | Implemented foundation | Shared board membership service/routes and claim authorization |
| Operator/admin settings | Implemented foundation | Desktop settings section and runtime operator helpers |
| Desktop release automation | Implemented foundation | Desktop release workflow, reusable foundation, artifact manifest/checksum script |

## Deliberate Differences

- Matrix Desktop runs coding agents only in Matrix cloud/VPS runtime. Slay-style
  local agent process management is intentionally out of scope.
- Matrix uses owner-controlled Postgres/Kysely for durable ticket, board, and
  Symphony state. Desktop local storage is only for native shell preferences and
  connection state.
- Desktop preview/browser flows must pass Matrix SSRF and redirect policy before
  the app displays a URL.
- Provider credentials remain server-side. The desktop app only sees coarse
  readiness or configured/not-configured state.

## Known Gaps

- Deep multi-user board UX is still minimal: membership is available and
  authorization is wired, but richer teammate assignment controls need a later
  UI pass.
- Release workflows currently package and manifest artifacts. Production
  publishing policy still needs real signing secret rollout and live notarization
  verification.
- Slay import guidance exists in settings/docs, but automated Slay data import is
  not implemented.
- Full Playwright desktop smoke automation remains follow-up; current coverage
  is Vitest-focused plus Electron build/typecheck coverage.
