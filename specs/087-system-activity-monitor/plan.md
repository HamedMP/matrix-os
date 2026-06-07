# Implementation Plan: System Activity Monitor

**Branch**: `087-system-activity-monitor` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/087-system-activity-monitor/spec.md`

## Summary

Create a first-party, owner-only System Activity Monitor that surfaces each user's Matrix computer identity, resource pressure, service health, top processes, and safe cleanup opportunities. The implementation uses the customer VPS gateway as the trusted collector and mutation boundary, exposes bounded typed endpoints for read-only snapshots and approved cleanup actions, and renders the experience as a Canvas-first built-in shell app. Cleanup starts as suggestions and explicit user actions; automatic cleanup is a later opt-in policy once classifiers have tests and audit history.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16  
**Primary Dependencies**: Hono gateway, Zod 4 via `zod/v4`, existing shell built-in app routing, Node `fs/promises`, `child_process`, `/proc` and cgroup filesystem readers, systemd host tools  
**Storage**: Owner-controlled files for cleanup history and auto-clean policy under `~/system/`; no new database or ORM  
**Testing**: Vitest for gateway, shell/store, and contract tests; React Doctor required for React changes  
**Target Platform**: VPS-native Matrix customer runtime with Linux systemd services, plus browser shell through Canvas and Desktop renderers  
**Project Type**: Web application with gateway backend and shell frontend  
**Performance Goals**: Read-only snapshot p95 under 2 seconds on a small VPS; cleanup action result visible in the next refresh within 5 seconds; collectors avoid blocking the event loop  
**Constraints**: Owner-only auth; all mutating routes use `bodyLimit`; all inputs validated by Zod; no arbitrary PID kill; subprocess probes have timeouts; no raw errors or filesystem paths to clients; bounded in-memory caches; protected owner paths are never deleted; health probes return coarse booleans and sanitized details  
**Scale/Scope**: One owner-controlled customer VPS per runtime slot; v1 supports the local machine only, with platform/fleet links deferred to future multi-machine fleet views

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Runtime activity is observed on the owner-controlled VPS. Cleanup history and policy live under the owner's `~/system/` files. Owner data is protected from cleanup.
- **AI Is the Kernel**: PASS. The monitor is a system app and does not bypass kernel ownership semantics. No model-specific dependency is introduced.
- **Headless Core, Multi-Shell**: PASS. Collection and cleanup live in gateway/host services; shell is only a renderer. Future CLI or mobile clients can use the same contracts.
- **Self-Healing and Self-Expanding**: PASS. The feature adds guarded self-healing actions with audit and opt-in automation.
- **Quality Over Shortcuts**: PASS. Uses a real first-party shell experience, typed APIs, tests, and operations docs.
- **App Ecosystem**: PASS. The monitor is a privileged built-in app, not a sandboxed app granted arbitrary host power.
- **Multi-Tenancy**: PASS. Scope is the owner runtime; no cross-user or platform-wide data is exposed.
- **Defense in Depth**: PASS. The design uses owner-only auth, route-boundary validation, body limits, generic client errors, subprocess timeouts, allowlisted cleanup actions, and protected path enforcement.
- **TDD**: PASS. Tasks require failing tests before implementation for collectors, contracts, cleanup actions, and UI behavior.
- **Worktree, PR, and Greptile 5/5**: PASS. This spec is created in a manual worktree PR and tasks include a Graphite split for later implementation layers.

## Project Structure

### Documentation (this feature)

```text
specs/087-system-activity-monitor/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── system-activity-api.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/gateway/src/system-activity/
├── collector.ts              # host metric, service, and process snapshot collection
├── cleanup.ts                # typed candidate classification and cleanup execution
├── history.ts                # owner-file cleanup history and policy persistence
├── routes.ts                 # Hono routes and Zod schemas
└── types.ts                  # shared backend DTOs

packages/gateway/src/server.ts # route registration and dependency wiring

shell/src/stores/
└── systemActivityStore.ts     # serializable dashboard state and actions

shell/src/components/system-activity/
├── ActivityMonitorApp.tsx
├── CleanupSuggestions.tsx
├── MachineSummary.tsx
├── ProcessTable.tsx
└── ResourceMeters.tsx

shell/src/components/canvas/CanvasWindow.tsx # built-in app path handling
shell/src/components/Desktop.tsx             # built-in app path handling

tests/gateway/
├── system-activity-collector.test.ts
├── system-activity-cleanup.test.ts
├── system-activity-routes.test.ts
└── system-activity-history.test.ts

tests/shell/
└── system-activity-app.test.tsx

www/content/docs/guide/
└── system-activity-monitor.mdx
```

**Structure Decision**: Keep host observation and mutation in `packages/gateway` because the gateway already runs on the customer VPS and owns authenticated system routes. Keep the UI in `shell/` as a privileged built-in app reachable from Canvas and Desktop. Keep cleanup policy/history as owner files under `~/system/` to preserve the owner-data invariant and avoid new persistence.

## Complexity Tracking

No constitution violations are required for the planned design.

## Phase 0: Research

See [research.md](./research.md).

## Phase 1: Design & Contracts

See [data-model.md](./data-model.md), [contracts/system-activity-api.md](./contracts/system-activity-api.md), and [quickstart.md](./quickstart.md).

## Post-Design Constitution Check

- **Data ownership** remains satisfied: cleanup history and policy are owner files, and cleanup scopes explicitly exclude protected owner data.
- **Defense in depth** remains satisfied: contracts require body limits, route-boundary Zod validation, typed cleanup actions, sanitized responses, subprocess timeouts, and bounded caches.
- **TDD** remains satisfied: tasks require tests before implementation for collectors, routes, cleanup classifiers, shell state, and UI flows.
- **Worktree/PR** remains satisfied: implementation is split into reviewable Graphite stack layers with the spec layer as the first PR.
