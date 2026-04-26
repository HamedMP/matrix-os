# Implementation Plan: Cloud Coding Workspaces

**Branch**: `069-cloud-coding-workspaces` | **Date**: 2026-04-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/069-cloud-coding-workspaces/spec.md`, incorporating the prior 068 cloud coding workspace and review-loop plan.

## Summary

Build Matrix OS into a full cloud coding workspace. Users add GitHub repositories as projects, browse PRs and branches, create isolated worktrees, manage tasks, launch human shells or coding agents, attach from web/desktop/CLI/TUI/local terminal, edit files through an authenticated browser IDE, open previews beside the workspace, and run autonomous multi-agent review loops until convergence.

The implementation is intentionally headless-first: gateway managers own project, task, worktree, session, transcript, review, preview, and activity state. Web, desktop, browser IDE, CLI, and Ink TUI are clients of the same APIs and file-backed records.

## Technical Context

**Language/Version**: TypeScript strict, ES modules, Node.js 24 in Matrix services
**Primary Dependencies**: Hono, node-pty, Zellij, tmux fallback, Ink, Zod, GitHub CLI, code-server, git, WebSocket terminal infrastructure
**Storage**: File-backed JSON under Matrix user home with atomic writes, operation logs for multi-record changes, derived/rebuildable reverse indexes
**Testing**: Vitest, integration tests for manager/API/runtime flows, browser proxy tests, targeted e2e for workspace/CLI convergence
**Target Platform**: Single-user Docker container per Matrix user, non-root `matrixos` user
**Performance Goals**: existing session attach under 3s, live fanout under 1s, URL-to-agent under 60s where dependencies are warm, responsive project/task lists at 100 projects and 1,000 tasks
**Constraints**: bounded replay buffers, bounded clone/review/session operations, 20-ish concurrent sessions for v1, 1-5 active review loops, no desktop-local source of truth

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| Data Belongs to Its Owner | PASS | Projects, tasks, sessions, transcripts, reviews, and editor state live in the user's Matrix home. |
| AI Is the Kernel | PASS | Agent sessions and review loops are first-class workflow primitives. |
| Headless Core, Multi-Shell | PASS | Gateway APIs own state; web, desktop, CLI, TUI, and browser IDE are clients. |
| Self-Healing | PASS | Startup reconciliation covers file records, Zellij/tmux runtime state, bridges, transcripts, worktree leases, reviews, and editor availability. |
| Quality Over Shortcuts | PASS | TDD for managers, explicit state machines, bounded resources, no shell interpolation for user input. |
| App Ecosystem | N/A | This is a workspace feature, not app distribution. |
| Multi-Tenancy | N/A for v1 | Single-user container scope; data model must not block org/shared workspaces later. |
| Defense in Depth | PASS | Auth, ownership checks, path validation, body limits, subprocess argv execution, non-root runtime, sandbox preflight. |
| TDD | PASS | New managers and state machines require unit/integration tests before broad UI wiring. |

## Project Structure

### Documentation

```text
specs/069-cloud-coding-workspaces/
├── spec.md
├── plan.md
├── tasks.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md
└── checklists/
    └── requirements.md
```

### Source Code

```text
packages/gateway/src/
├── server.ts
├── project-manager.ts
├── worktree-manager.ts
├── task-manager.ts
├── agent-launcher.ts
├── agent-session-manager.ts
├── state-ops.ts
├── zellij-runtime.ts
├── session-runtime-bridge.ts
├── session-transcript.ts
├── agent-sandbox.ts
├── review-loop.ts
├── findings-parser.ts
├── preview-manager.ts
└── workspace-events.ts

packages/platform/src/
├── main.ts                    # code.matrix-os.com authenticated proxy
├── orchestrator.ts            # container port/env wiring
└── ws-upgrade.ts              # app/code-domain websocket routing

bin/
├── matrixos.ts
└── tui/
    ├── app.tsx
    ├── dashboard.tsx
    ├── session-list.tsx
    ├── review-status.tsx
    ├── project-browser.tsx
    └── task-board.tsx
```

## Data Layout

Canonical records live under the user's Matrix home:

```text
~/projects/{slug}/config.json
~/projects/{slug}/repo/
~/projects/{slug}/worktrees/{worktreeId}/
~/projects/{slug}/tasks/{taskId}.json
~/system/sessions/{sessionId}.json
~/system/session-output/{sessionId}.jsonl
~/system/reviews/{reviewId}.json
~/system/ops/{opId}.json
~/system/zellij/layouts/{sessionId}.kdl
~/system/code-server/
```

Branch names, PR refs, and URL-derived names are never used directly as REST path identifiers. Worktrees use stable IDs such as `wt_...`; sessions and reviews use UUIDs or similarly opaque IDs.

## API Surface

Core routes:

```text
GET    /api/github/status

POST   /api/projects
GET    /api/projects
GET    /api/projects/:slug
DELETE /api/projects/:slug
GET    /api/projects/:slug/prs
GET    /api/projects/:slug/branches

POST   /api/projects/:slug/worktrees
GET    /api/projects/:slug/worktrees
DELETE /api/projects/:slug/worktrees/:worktreeId

POST   /api/projects/:slug/tasks
GET    /api/projects/:slug/tasks
PATCH  /api/projects/:slug/tasks/:taskId
DELETE /api/projects/:slug/tasks/:taskId

POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:sessionId
POST   /api/sessions/:sessionId/send
POST   /api/sessions/:sessionId/observe
POST   /api/sessions/:sessionId/takeover
DELETE /api/sessions/:sessionId

POST   /api/reviews
GET    /api/reviews
GET    /api/reviews/:reviewId
POST   /api/reviews/:reviewId/next
POST   /api/reviews/:reviewId/approve
POST   /api/reviews/:reviewId/stop

GET    /api/agents
GET    /api/agents/sandbox-status
GET    /api/workspace/events
```

All mutating routes use body limits, authenticated user context, ownership checks, Zod validation, structured errors, and no raw provider/internal details in responses.

## CLI/TUI Surface

Scriptable commands:

```bash
matrixos project add github.com/owner/repo [--slug slug]
matrixos project ls
matrixos project prs <slug>
matrixos project branches <slug>

matrixos worktree create <slug> --pr <number>
matrixos worktree create <slug> --branch <branch>
matrixos worktree ls <slug>
matrixos worktree rm <slug> <worktreeId>

matrixos task create "<title>" --project <slug>
matrixos task ls --project <slug>
matrixos task work <taskId> --agent claude

matrixos session start --project <slug> [--task <taskId>] [--pr <number>] --agent codex
matrixos session ls
matrixos session attach <sessionId>
matrixos session attach <sessionId> --terminal
matrixos session observe <sessionId>
matrixos session send <sessionId> "<text>"
matrixos session kill <sessionId>

matrixos review start --project <slug> --pr <number>
matrixos review status --project <slug> --pr <number>
matrixos review watch --project <slug> --pr <number>
matrixos review next --project <slug> --pr <number>
matrixos review approve --project <slug> --pr <number>

matrixos agent sandbox-status
matrixos tui
matrixos
```

## Implementation Phases

### Phase 0: Browser IDE Foundation

**Status**: In progress in this worktree.

Deliverables:

1. Add code-server to prod/dev container images with a Node 22 runtime isolated from Matrix's Node 24 runtime.
2. Start code-server inside each user container on a private port.
3. Route `code.matrix-os.com` through the authenticated platform proxy to the user's private code-server port.
4. Support editor HTTP resources and WebSocket upgrades without leaking Matrix credentials or serving cacheable auth HTML for protected editor responses.
5. Add platform proxy tests for code-domain routing, short-lived editor session cookies, unauthenticated asset behavior, and WebSocket host acceptance.

### Phase 1: Project Registry, GitHub, And Worktree Manager

Requirements: FR-001, FR-002, FR-011 through FR-013, FR-017 through FR-023, FR-031 through FR-034, FR-048

Deliverables:

1. `project-manager.ts`: CRUD for projects, GitHub URL validation, slug generation, `gh auth status` preflight, bounded clone staging, pre-clone size probe where feasible, timeout cleanup, atomic rename into `~/projects/{slug}/repo`, PR listing through `gh pr list --json`, branch listing through `git`.
2. `worktree-manager.ts`: create/list/delete git worktrees for branches and PRs, use stable `wt_` IDs, derive session membership from session records, require explicit confirmation for dirty cleanup, acquire/release worktree write leases.
3. `state-ops.ts`: atomic write helpers, per-project locks, operation log in `~/system/ops`, startup recovery/replay, reverse-index rebuild.
4. Gateway API routes for projects, GitHub status, PRs, branches, and worktrees.
5. CLI commands for project and worktree workflows.
6. Tests for CRUD, clone staging cleanup, command injection rejection, invalid refs, lease behavior, stale lease recovery, path validation, and op-log recovery.

### Phase 2: Agent Session Runtime

Requirements: FR-006 through FR-010, FR-035 through FR-040, FR-049, FR-050

Deliverables:

1. `agent-launcher.ts`: detect installed agents, validate commands, construct launch argv for Claude, Codex, OpenCode, and Pi, and report missing/auth-needed states.
2. `zellij-runtime.ts`: generate layouts in `~/system/zellij/layouts/{sessionId}.kdl`, start/attach/observe/kill sessions, inspect runtime health, and report degraded fallback reasons.
3. `agent-session-manager.ts`: create/list/get/send/kill session records in `~/system/sessions`, acquire worktree leases, monitor exit state, release leases, reconcile on startup.
4. `session-runtime-bridge.ts`: register runtime-backed coding sessions with the existing terminal registry as external sessions, fan out live output, preserve write/observe modes, and avoid making `/api/terminal/sessions` the business source of truth.
5. `session-transcript.ts`: append-only JSONL transcripts, replay rehydration, retention/truncation policy, export hooks.
6. `agent-sandbox.ts`: preflight for Codex-style sandboxing, non-root execution, workspace-write scoping to the target worktree and scratch dirs, fail-closed behavior with explicit admin override.
7. Gateway and CLI session commands, including native Zellij terminal handoff.
8. Tests for session lifecycle, runtime fallback, attach/replay after gateway restart, write lease conflicts, observe/takeover semantics, sandbox preflight, and transcript retention.

### Phase 3: Review Loop Engine

Requirements: FR-041 through FR-044 plus project/session/worktree dependencies

Deliverables:

1. `findings-parser.ts`: parse `.matrix/review-round-{N}.md`, extract findings, severity, file references, summary counts, and return explicit parse success/failure.
2. `review-loop.ts`: state machine for reviewer -> parser -> implementer -> reviewer rounds with max rounds, stop/approve/next controls, failed_parse state, verification gates, and full round history.
3. Review control files: agents atomically write `.matrix/review-round-{N}.json` with statuses such as `ready_for_parse`, `implemented`, and commit metadata.
4. Review prompts for reviewer and implementer roles with structured output requirements.
5. Review records in `~/system/reviews/{reviewId}.json`, linked sessions per round, and activity events visible in project/task/session UI.
6. API and CLI review commands.
7. Tests for all legal/illegal transitions, convergence, stall, parse failure, verification failure, operator stop/approve, and recovery from partial control/report writes.

### Phase 4: Task Workflows And Workspace Events

Requirements: FR-003 through FR-005, FR-009, FR-014 through FR-016, FR-022, FR-023

Deliverables:

1. `task-manager.ts`: CRUD for project-scoped tasks in `~/projects/{slug}/tasks/{taskId}.json`, ordering, priority, status, parent/child links, session/worktree links, archive.
2. `workspace-events.ts`: bounded event stream for project/task/session/review/git/preview changes used by web, CLI, TUI, and desktop clients.
3. `preview-manager.ts`: save preview URLs, detect local preview URLs from session output, validate allowed schemes, expose recoverable failure states.
4. API routes and CLI commands for tasks and preview links.
5. Tests for task lifecycle, ordering, session links, event fanout, preview URL validation, and stale/missing linked state.

### Phase 5: Matrix Web Workspace And Terminal Cockpit

Requirements: FR-001 through FR-016, FR-024, FR-026 through FR-030, FR-040, FR-044

Deliverables:

1. Matrix-native workspace app with project list, project detail, task board/list, git/worktree panel, sessions panel, review loop panel, preview panel, and browser IDE launch/deep links.
2. Terminal cockpit integration using `/api/sessions` for coding sessions and terminal registry only for attach transport.
3. One-click attach, observe, takeover, kill, duplicate pane, local-terminal handoff, and transcript/search health panel.
4. Browser IDE entry points from home/project/task/worktree context.
5. Desktop parity by consuming the same APIs and terminal components.
6. Browser tests for layout, no overlapping controls, reconnect banners, duplicate input prevention, and mobile/desktop behavior.

### Phase 6: Ink TUI

Requirements: FR-045 through FR-047

Deliverables:

1. `bin/tui/app.tsx`: root component, auth/bootstrap, API client, event subscription or polling.
2. `dashboard.tsx`: sessions, reviews, projects, tasks, and PRs in a keyboard-driven layout.
3. `session-list.tsx`: status, runtime, agent, project, task/PR, last activity, attach/watch/native handoff.
4. `review-status.tsx`: round counter, status, active agent, findings, next actions.
5. `project-browser.tsx` and `task-board.tsx`: project drilldown, PR/worktree creation, task work start.
6. `matrixos` with no subcommand opens TUI; `matrixos tui` remains explicit.
7. Ink component tests and layout snapshots.

### Phase 7: Docker, Startup Recovery, And Docs

Requirements: FR-025, FR-049, FR-050

Deliverables:

1. Ensure container includes `zellij`, `tmux`, `gh`, `openssh-client`, `bubblewrap` or documented sandbox helper, agent CLIs, git, and code-server.
2. Create required directories at startup with correct ownership.
3. Startup recovery order: state ops replay, project registry scan, worktree lease reconciliation, runtime session discovery, bridge recreation, transcript rehydration, review loop reconciliation, browser IDE health, preview detection startup.
4. `/health` includes workspace managers, session count, review loop status, sandbox status, and editor availability.
5. Public docs for cloud coding, GitHub auth, project data ownership, task/worktree workflows, terminal sharing, review loops, browser IDE, and nested agent sandboxing.

## Dependency Graph

```text
Phase 0: Browser IDE Foundation

Phase 1: Project Registry + GitHub + Worktrees
    |
    v
Phase 2: Agent Session Runtime
    |
    v
Phase 3: Review Loop Engine
    |
    +--> Phase 4: Task Workflows + Workspace Events
    |        |
    |        v
    +--> Phase 5: Web Workspace + Terminal Cockpit
    |
    v
Phase 6: Ink TUI

Phase 7: Docker + Startup Recovery + Docs can proceed in parallel after Phase 2 APIs stabilize.
```

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Zellij recovery is unreliable | Sessions appear lost after restart | Persist metadata and transcripts, reconcile runtime state, recreate bridges, expose degraded fallback. |
| Worktree conflicts corrupt git state | User work can be damaged | Exclusive write leases, 409 holder responses, observe/read-only attach, stale lease recovery only after runtime death is confirmed. |
| Review loop falsely converges | Broken code may be marked done | Require parser success, zero findings, structured control file, optional verification commands, and explicit failed_parse state. |
| Agent output format changes | Parser and status detection break | Keep parser tolerant but convergence strict; rely on control files rather than terminal scraping. |
| GitHub auth or rate limits fail | PR workflows become flaky | Explicit auth status, structured provider errors, cache last known PR/branch data, manual refresh. |
| Clone/worktree operations fill disk | Container becomes unhealthy | Size probes where feasible, timeouts, staging cleanup, disk warnings, cleanup policies. |
| Browser IDE assets cache auth HTML | Editor breaks after auth transitions | Non-cacheable unauthorized responses, static asset rules, MIME preservation, tests for worker/font/icon/module paths. |
| Command injection via repo/ref/task input | Container compromise | Strict validation, execFile with argv arrays, sanitized env, no shell interpolation. |
| Sandbox unavailable | Unsafe agent execution | Startup preflight, fail closed, explicit admin override only. |
| Event stream grows unbounded | Memory pressure | Bounded activity buffers, pagination, transcript retention/truncation. |
