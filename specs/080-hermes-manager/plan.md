# Implementation Plan: Hermes Manager

**Branch**: `080-hermes-manager` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/080-hermes-manager/spec.md`

**Goal**: Build a first-party Matrix OS Hermes Manager app that onboards Hermes, configures model and messaging channels, lets operators message Hermes, and manages Hermes lifecycle through supported Hermes CLI/IPC/API surfaces.

## Summary

Hermes Manager makes Hermes the Matrix-native agent/orchestrator surface. The implementation adds an owner-scoped gateway subsystem under `/api/hermes`, a first-party Vite app under `home/apps/hermes-manager`, redacted credential/config handling under the Matrix owner home, and a typed bridge that adapts Hermes CLI/local API/WebSocket capabilities without duplicating Hermes internals.

The stack is intentionally split into four reviewable phases:

1. Gateway foundation: contracts, repository, credential store, Hermes bridge, status/config routes, tests.
2. Setup and channel operations: onboarding, Telegram/WhatsApp connect/status/recovery, operator events, tests.
3. Messaging session surface: Hermes session create/resume/prompt stream/approval flow, bounded event hub, tests.
4. First-party app and docs: polished Vite app, manifest/icon, docs, default app build, UI tests.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 24+, React 19, ES modules  
**Primary Dependencies**: Hono, Zod 4 via `zod/v4`, Kysely/Postgres where relational state is needed, Node `child_process`/`fs/promises` for Hermes CLI bridge, EventSource/WebSocket-compatible gateway primitives, Vite + React + Tailwind/shadcn-style components for the app  
**Storage**: Owner-controlled Matrix state. Use owner Postgres/Kysely for structured Hermes Manager records where gateway DB is available; use owner home files under `~/system/hermes-manager/` for redacted config/credential references and runtime-safe export snapshots. Never add new embedded databases.  
**Testing**: Vitest unit/integration tests, default app React tests, pattern scanner, typecheck  
**Target Platform**: Matrix OS customer VPS gateway and first-party bundled Vite app  
**Project Type**: Web app plus gateway subsystem  
**Performance Goals**: setup/status endpoints p95 under 300 ms with mocked Hermes, initial app render under 2 s after static load, stream at least 100 Hermes events without unbounded memory growth, default event retention capped to 500 per owner/session  
**Constraints**: no secrets in browser-visible payloads, all mutating endpoints use `bodyLimit`, every external/provider/network call has timeout, all Hermes process calls bounded by timeout, all Maps/Sets capped or TTL-evicted, app works as a shell over a headless Hermes core  
**Scale/Scope**: personal-owner first; up to 50 authorized operators, 20 channels reported by Hermes, 100 session summaries, 500 retained events, Telegram and WhatsApp are P1 connect/recovery targets

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. All Hermes Manager state is owner-scoped. Secrets remain server-side in owner-controlled storage. Exports are redacted.
- **AI Is the Kernel**: PASS. Hermes is treated as the orchestrator/kernel-facing agent surface. Matrix does not duplicate Hermes reasoning internals.
- **Headless Core, Multi-Shell**: PASS. Hermes remains operable through CLI/IPC/API; the Matrix app is a renderer/operator shell.
- **Defense in Depth**: PASS. The spec includes auth matrix, input validation, body limits, secret redaction, bounded resources, timeout policy, startup dependency checks, and integration wiring tests.
- **TDD**: PASS. Tasks must start with failing route/bridge/repository/UI tests before implementation.
- **App Ecosystem**: PASS. App is packaged as a first-party Vite app with `matrix.json`, shipped icon, and explicit permissions.
- **No New Persistence Stack**: PASS. Uses existing owner Postgres/Kysely or owner files only; no new database/ORM.
- **Documentation**: PASS. Public docs and developer wiring docs are explicit deliverables.

## Project Structure

### Documentation (this feature)

```text
specs/080-hermes-manager/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
packages/gateway/src/hermes/
├── auth.ts
├── bridge.ts
├── contracts.ts
├── credential-store.ts
├── event-hub.ts
├── index.ts
├── repository.ts
└── routes.ts

home/apps/hermes-manager/
├── index.html
├── matrix.json
├── package.json
├── src/
│   ├── App.tsx
│   ├── components/
│   ├── lib/
│   └── main.tsx
├── tsconfig.json
└── vite.config.ts

home/system/icons/
└── hermes-manager.svg

www/content/docs/
└── hermes.mdx

docs/platform/dev/
└── hermes-manager.md

tests/
├── default-apps/hermes-manager-app.test.tsx
├── gateway/hermes-auth.test.ts
├── gateway/hermes-bridge.test.ts
├── gateway/hermes-credential-store.test.ts
├── gateway/hermes-event-hub.test.ts
├── gateway/hermes-repository.test.ts
├── gateway/hermes-routes.test.ts
└── gateway/hermes-restart-recovery.test.ts
```

**Structure Decision**: Add a dedicated `packages/gateway/src/hermes/` subsystem following the Matrix-native Symphony route/repository/auth pattern, plus a first-party app under `home/apps/hermes-manager/`. Keep Hermes-specific runtime adaptation in `bridge.ts`; the app talks only to `/api/hermes/*`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |

## Post-Design Constitution Check

- **Defense in Depth**: PASS. Contracts define route auth, body limits, redaction, bounded event streams, and startup dependency checks.
- **TDD**: PASS. Tasks must create failing tests for each phase before implementation.
- **Owner Data**: PASS. Data model separates redacted owner state from server-side credential references.
- **Headless Core**: PASS. Contracts document Hermes bridge inputs/outputs while preserving CLI/IPC/API as the source of truth.
- **App Ecosystem**: PASS. App manifest/icon/build/test tasks are included.

## Graphite Stack Plan

1. `docs(hermes): specify manager app` - spec/plan/tasks only.
2. `feat(hermes): add manager gateway foundation` - contracts, repository, credential store, bridge, status/config routes, tests.
3. `feat(hermes): add setup and channel operations` - onboarding actions, Telegram/WhatsApp operations, recovery/audit events, tests.
4. `feat(hermes): add messaging session bridge` - sessions, streaming/event hub, approvals, restart recovery, tests.
5. `feat(hermes): add first-party manager app` - Vite app, manifest/icon, docs, app tests, default app build.

Each PR must be ready for review, not draft, and must include backend invariants where backend surfaces change.
