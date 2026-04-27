# Implementation Plan: Workspace Canvas

**Branch**: `071-tldraw-workspace-canvas` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/071-tldraw-workspace-canvas/spec.md`

## Summary

Build a tldraw-powered workspace canvas inside the Matrix OS shell that lets users spatially organize PRs, review loops, terminals, files, notes, previews, and app windows. The canvas becomes a typed, persisted Matrix-owned workspace document served by the gateway, rendered by the browser shell, and wired to existing terminal/session, project/worktree, sync/recovery, and GitHub review-loop state without making the drawing surface the source of truth for those records.

The first implementation should replace the current ad hoc `/api/canvas` state shape with versioned canvas documents, scoped APIs, safe node schemas, and real-time canvas update events. Existing canvas-mode window behavior remains reusable, but persistence and interactions move behind validated contracts.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16
**Primary Dependencies**: Hono, Zod 4 via `zod/v4`, Kysely/Postgres for user app/workspace data, existing terminal stack (`node-pty`, `@xterm/xterm`), planned `@tldraw/tldraw` for the shell canvas renderer
**Storage**: User-owned Postgres workspace tables for canonical canvas documents and references; filesystem export/backup integration under `~/system/` or project export bundles where required by recovery flows
**Testing**: Vitest unit/integration tests, shell component tests, gateway contract tests, Playwright smoke coverage for canvas rendering and terminal attach
**Target Platform**: Matrix OS web desktop shell plus gateway APIs; CLI/editor/TUI consumers use the same contracts later
**Project Type**: Web application with shared gateway, shell, tests, and docs changes
**Performance Goals**: 200-node canvas searchable/focusable with primary interactions not blocked longer than 1 second; inactive live nodes render as lightweight summaries; at most 20 active expensive live surfaces per canvas view unless explicitly raised by config
**Constraints**: Auth on every endpoint/WS/IPC path, body limits before buffering, Zod validation at boundaries, safe generic client errors, no unbounded Maps/Sets, atomic multi-record writes, crash-safe persistence, no privileged credentials in preview/browser content
**Scale/Scope**: Personal developer workspaces first; scopes include global developer workspace, project workspace, PR workspace, and review-loop workspace; org-shared canvases are deferred but schema and auth model must leave room for ownership scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Plan Response |
|-----------|--------|---------------|
| Data Belongs to Its Owner | PASS | Canvas documents include explicit owner scope, export/delete behavior, and recoverable state. Canonical data stays in user-owned storage, not browser-local state. |
| AI Is the Kernel | PASS | Canvas actions may start or inspect agent review loops, but domain state remains exposed through gateway/kernel contracts. No shell-only business logic becomes canonical. |
| Headless Core, Multi-Shell | PASS | Browser shell is one renderer. Gateway contracts support future CLI, TUI, and editor consumers through stable canvas IDs and typed node references. |
| Self-Healing and Self-Expanding | PASS | Missing runtime links degrade to recoverable placeholder nodes; recovery reconciles canvas references with sessions, worktrees, and review loops. |
| Quality Over Shortcuts | PASS | Use real React/tldraw integration and existing design system patterns; no bare HTML or browser-local-only prototype. |
| App Ecosystem | PASS | App-window/custom nodes require explicit typed definitions, scoped permissions, and fallback rendering. |
| Multi-Tenancy | PASS | Initial implementation is personal scope, but document model includes ownership scope and org authorization fields for later shared canvases. |
| Defense in Depth | PASS | Contracts include auth matrix, input validation, body limits, safe errors, resource caps, crash-safe writes, and integration tests. |
| Test-Driven Development | PASS | Tasks must begin with failing schema, route, renderer, terminal attach, and recovery tests before implementation. |
| Documentation-Driven Development | PASS | Public docs updates under `www/content/docs/` are a required task before release. |

No constitution violations require justification.

## Project Structure

### Documentation (this feature)

```text
specs/071-tldraw-workspace-canvas/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md
│   ├── realtime-events.md
│   └── schemas.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/gateway/src/
├── canvas/
│   ├── contracts.ts
│   ├── repository.ts
│   ├── recovery.ts
│   ├── routes.ts
│   ├── service.ts
│   └── subscriptions.ts
├── projects.ts
├── session-registry.ts
└── server.ts

shell/src/components/
├── canvas/
│   ├── WorkspaceCanvas.tsx
│   ├── WorkspaceCanvasNode.tsx
│   ├── WorkspaceCanvasToolbar.tsx
│   ├── WorkspaceCanvasInspector.tsx
│   └── WorkspaceCanvasFallbackNode.tsx
└── terminal/
    ├── TerminalApp.tsx
    └── TerminalPane.tsx

shell/src/stores/
├── workspace-canvas-store.ts
├── terminal-store.ts
└── desktop-mode.ts

tests/
├── gateway/
│   ├── canvas-contracts.test.ts
│   ├── canvas-repository.test.ts
│   ├── canvas-routes.test.ts
│   ├── canvas-service.test.ts
│   ├── canvas-recovery.test.ts
│   ├── canvas-subscriptions.test.ts
│   ├── canvas-terminal.test.ts
│   └── canvas-review-loop.test.ts
├── shell/
│   ├── workspace-canvas-store.test.ts
│   └── workspace-canvas-renderer.test.tsx
└── e2e/
    └── workspace-canvas.spec.ts

www/content/docs/
└── workspace-canvas.mdx
```

**Structure Decision**: Implement canonical canvas behavior in `packages/gateway/src/canvas/` and keep the shell renderer in `shell/src/components/canvas/`. Shared validation schemas live in gateway contracts first and may later move to a shared package if CLI/editor consumers need compile-time reuse. Existing `CanvasRenderer` code is migration input, not the long-term document model.

## Phase 0: Research

See [research.md](./research.md). Decisions resolve storage, rendering engine, real-time update approach, terminal integration, PR/review integration, recovery, and resource limits.

## Phase 1: Design and Contracts

Design artifacts:

- [data-model.md](./data-model.md)
- [contracts/rest-api.md](./contracts/rest-api.md)
- [contracts/realtime-events.md](./contracts/realtime-events.md)
- [contracts/schemas.md](./contracts/schemas.md)
- [quickstart.md](./quickstart.md)

## Security Architecture

| Surface | Operation | Auth | Body Limit | Validation | Error Policy |
|---------|-----------|------|------------|------------|--------------|
| REST canvas documents | list/read/create/update/delete/export | Matrix session or CLI token | 256 KiB writes, 1 MiB export request metadata | Zod schemas for scope, IDs, version, node/edge/view payloads | Generic client errors; log details server-side |
| Realtime canvas subscription | subscribe, presence, patch broadcast | Matrix session or CLI token | 32 KiB message frames | Zod message schemas and authorized canvas scope | Close with generic policy code/message |
| Terminal node actions | create, attach, observe, input, resize, kill | Matrix session or CLI token | Existing terminal limits | Existing session registry schemas plus canvas node reference validation | Delegate existing terminal errors through safe messages |
| PR/review node actions | refresh, start loop, stop loop, next action | Matrix session or CLI token | 64 KiB action bodies | Project/worktree/PR IDs and action payload schemas | No raw GitHub/provider output to clients |
| File/preview nodes | open, link, preview URL | Matrix session or CLI token | 64 KiB action bodies | `resolveWithinHome` or project root guard, URL scheme allowlist | No raw filesystem paths in client errors |
| Custom node definitions | register, migrate, render metadata | Matrix session, CLI token, or app permission | 128 KiB definitions | Versioned schema, permission scope, metadata caps | Invalid definitions fail closed with fallback node |

## Integration Wiring

Startup sequence:

1. `createGateway()` constructs `CanvasRepository`, `CanvasService`, and `CanvasSubscriptionHub` after auth/session/project dependencies are available.
2. `server.ts` registers canvas routes through `createCanvasRoutes({ homePath, appDb, sessionRegistry, projects, logger, subscriptions })`.
3. Realtime canvas updates reuse the main authenticated WebSocket or a dedicated `/ws/canvas` endpoint with the same auth middleware and explicit subscriber cap.
4. Shell loads canvas summaries through REST, subscribes to changes after auth is ready, then hydrates the tldraw document.
5. Startup recovery calls the canvas reconciliation service before reporting a canvas healthy: missing sessions/worktrees/review loops are marked as stale references, not deleted.

Cross-package communication:

- Shell never reads project, terminal, file, or PR state directly from local storage.
- Canvas service resolves terminal actions through `SessionRegistry` dependency injection.
- Project/worktree/review summaries resolve through gateway project/review services.
- No `globalThis` handoff is allowed.

## Failure Modes and Resource Management

- Canvas documents are versioned and optimistic writes require the latest revision. Conflicts return a recoverable conflict response.
- Multi-record mutations use transactions when app DB records and canvas records change together. If an external GitHub or terminal operation follows persistence, the acceptable orphan state is recorded on the node as `pending`, `stale`, or `failed`.
- File-backed export and backup writes use temp-file plus rename semantics.
- Subscriber sets are capped at 100 total gateway canvas subscribers and 10 subscribers per canvas per user process.
- Presence records use TTL eviction; render caches and thumbnail caches use max count plus TTL.
- Live terminal/app/preview activation is capped per viewport. Summary nodes render when zoomed out or over budget.
- External GitHub refreshes use `AbortSignal.timeout(10_000)`. Preview health checks use `AbortSignal.timeout(10_000)` and strict URL validation.

## Test Plan

Tests must be written before implementation:

1. Contract tests for Zod schemas rejecting invalid IDs, unsafe URLs, oversized payloads, unauthorized references, and stale revisions.
2. Gateway route tests for auth rejection, body limits, CRUD, export/delete, safe errors, and conflict responses.
3. Integration tests for canvas-to-terminal attach using the existing session registry without duplicate sessions.
4. Integration tests for PR worktree/review-loop summaries and degraded missing-auth state.
5. Recovery tests for restored canvas documents with missing runtime-linked nodes.
6. Shell tests for tldraw document hydration, node fallback rendering, search/focus, and live-node activation caps.
7. Playwright smoke test for opening a PR canvas, attaching terminal node, moving it, reloading, and seeing the same node/session.
8. Edge interaction tests for visual-only relationships and confirmation before any domain relationship mutation.
9. Permission tests for terminal observe/write/takeover modes and review-loop approval actions.
10. Cleanup and migration tests for custom node version migrations, temporary export bundles, preview artifacts, and renderer caches.

## Post-Design Constitution Check

| Principle | Status | Evidence |
|-----------|--------|----------|
| Data ownership | PASS | Data model includes owner scope, export/delete, and recovery fields. |
| Headless multi-shell | PASS | REST and realtime contracts are shell-independent. |
| Defense in depth | PASS | Auth, validation, body limits, resource caps, timeout rules, and safe errors are specified. |
| TDD | PASS | Test plan requires failing tests before implementation. |
| Documentation | PASS | Quickstart and source structure include public docs deliverable. |

## Complexity Tracking

No constitution violations or complexity exceptions.
