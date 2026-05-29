# Implementation Plan: Matrix Symphony

**Branch**: `078-matrix-symphony` | **Date**: 2026-05-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/078-matrix-symphony/spec.md`

## Summary

Make Symphony a Matrix-native coding-agent orchestrator. The current app is a setup-heavy wrapper around an external local runner; this plan consolidates Symphony into one gateway-owned Matrix product path that uses Matrix Linear integrations/secrets, Matrix project/worktree/session primitives, owner-controlled Postgres state, and a simplified first-party dashboard. The upstream Symphony contract remains the product reference: poll tracker, claim eligible issues, create isolated workspaces, run coding agents, reconcile/retry, and expose operator status.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+  
**Primary Dependencies**: Hono, Zod 4 via `zod/v4`, Kysely/Postgres, React 19, Vite first-party app runtime, existing Matrix workspace managers  
**Storage**: Owner-controlled PostgreSQL via the existing app database/Kysely path for Symphony config/runs/events; Matrix files only for repo-owned workflow contracts and compatibility export snapshots  
**Testing**: Vitest with focused gateway, integration, and default-app tests; Playwright/manual smoke only after local app behavior is ready  
**Target Platform**: Matrix customer VPS gateway + shell, first-party Matrix app, local owner workspace services  
**Project Type**: Web app plus gateway backend service within the existing Matrix monorepo  
**Performance Goals**: Poll cycle handles 100 eligible issues with default page caps within 10 seconds; dashboard status reads under 500ms on local VPS; realtime/status update delivered within one poll interval plus 5 seconds  
**Constraints**: No provider secrets in browser state; every mutating endpoint has `bodyLimit`; every external fetch/proxy call has bounded timeout through existing integration client paths; no Docker production runtime dependency; no new ORM or embedded DB; public and developer docs must be updated with the Matrix-native setup path  
**Scale/Scope**: Single Matrix owner installation initially, with explicitly authorized teammates as operators; default concurrency 3 active agents, configurable within a bounded range

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Symphony config/run state belongs to the Matrix owner and will live in owner-controlled Postgres; workflow policy remains repo-owned files under the selected project.
- **AI Is the Kernel**: PASS. Agent execution uses existing Matrix coding-agent session primitives instead of sidecar business logic.
- **Headless Core, Multi-Shell**: PASS. Orchestration is gateway/headless; the Symphony app is only one operator surface.
- **Defense in Depth**: PASS with required deliverables: auth matrix, boundary schemas, body limits, generic client errors, resource caps, shutdown behavior, and integration tests.
- **TDD**: PASS with required tests before implementation tasks for repository, service, routes, integration filtering, and dashboard behavior.
- **Postgres/Kysely Only**: PASS. New durable Symphony state uses owner Postgres/Kysely, not JSON-only persistence or a new embedded database.
- **Documentation-Driven Development**: PASS with `www/content/docs/symphony.mdx` and `docs/dev/symphony.md` updates required before PR.

## Project Structure

### Documentation (this feature)

```text
specs/078-matrix-symphony/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md
│   └── realtime-events.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/gateway/src/
├── symphony/
│   ├── auth.ts
│   ├── contracts.ts
│   ├── credential-store.ts
│   ├── repository.ts
│   ├── linear-source.ts
│   ├── orchestrator.ts
│   ├── prompt.ts
│   ├── routes.ts
│   └── status-hub.ts
├── integrations/registry.ts
├── server.ts
└── workspace/session/worktree managers already used by routes

home/apps/symphony/
├── src/App.tsx
├── src/index.css
└── matrix.json

tests/gateway/
├── symphony-credential-store.test.ts
├── symphony-repository.test.ts
├── symphony-linear-source.test.ts
├── symphony-orchestrator.test.ts
├── symphony-routes.test.ts
├── symphony-status-hub.test.ts
└── symphony-restart-recovery.test.ts

tests/integrations/
└── registry.test.ts

tests/default-apps/
└── symphony-app.test.tsx

www/content/docs/
└── symphony.mdx

docs/dev/
└── symphony.md
```

**Structure Decision**: Add a `packages/gateway/src/symphony/` module for the single Matrix-native orchestrator and migrate existing `symphony-runner.ts` / `symphony-routes.ts` behavior into that path. Keep temporary compatibility exports only if needed for downstream imports during this PR, with tests moved to the Matrix-native contracts. Reuse existing workspace/project/worktree/session managers through dependency injection. Keep the first-party app under `home/apps/symphony/`.

## Security Architecture

| Surface | Auth Method | Public? | Data Exposed | Notes |
|---------|-------------|---------|--------------|-------|
| `GET /api/symphony/status` | Matrix request principal | No | Sanitized orchestrator status, no secrets | Operator authorization required |
| `GET /api/symphony/config` | Matrix request principal | No | Non-secret config and credential presence | No token material |
| `POST /api/symphony/config` | Matrix request principal + body schema | No | Saved non-secret config | `bodyLimit` 16KB, audit event |
| `POST /api/symphony/credentials/linear` | Matrix owner only + body schema | No | Credential validation result | Secret write only, generic failures |
| `DELETE /api/symphony/credentials/linear` | Matrix owner only | No | Credential removal result | `bodyLimit` even when empty |
| `GET /api/symphony/tickets/preview` | Authorized operator | No | Sanitized Linear ticket preview | Server-side credential use only |
| `GET /api/symphony/runs` | Authorized operator | No | Sanitized run/worktree/session list | Cursor and status filters capped |
| `POST /api/symphony/start` | Authorized operator | No | Sanitized status | Starts poller, no raw provider errors |
| `POST /api/symphony/stop` | Authorized operator | No | Sanitized status | Drains poller/status subscribers |
| `POST /api/symphony/runs/:runId/actions` | Authorized operator + action union | No | Sanitized run status | Discriminated action schema |
| `GET /api/symphony/events` | Matrix request principal | No | Bounded SSE status events | Subscriber caps, stale eviction, shutdown drain |

Boundary validation: all params/query/body values use Zod schemas; project slugs reuse workspace validation; Linear IDs are length/cap validated; action payloads use discriminated unions.  
Error policy: detailed provider/filesystem/DB/agent errors are logged server-side; clients receive generic codes/messages.  
Resource policy: poll result caps, event retention caps, subscriber caps, stale subscriber sweep, and shutdown drains are required.  
Credential policy: browser-visible app config stores only credential references/presence; tokens remain server-side and are never forwarded to spawned agents unless explicitly allowed by server policy.

## Integration Wiring

1. Gateway boot creates the Symphony repository when app DB/Kysely is available.
2. Gateway creates the server-side credential store under the owner Matrix home for API-key compatibility, using atomic writes and owner-only permissions, with browser responses exposing only credential presence.
3. Gateway creates the Linear source adapter using the existing integration registry plus the server-side Linear credential resolver.
4. Gateway creates the Symphony orchestrator with injected repository, Linear source, project manager, worktree manager, agent session manager, workspace event publisher, and clock/timer dependencies.
5. `server.ts` mounts the consolidated Matrix-native Symphony routes at `/api/symphony`; the old external runner routes are removed or become thin aliases to the new route factory.
6. Shutdown order stops the Symphony orchestrator before destroying workspace/session/app DB dependencies.
7. The first-party Symphony app uses only `/api/symphony/*` for normal setup/dashboard flows and keeps `/api/integrations/*` only for account connection affordances.

## Failure Modes

- Linear unavailable: keep poller alive, mark source degraded, do not dispatch new work, retry next poll.
- Credential missing/invalid: stop dispatch, show setup attention state, keep run history visible.
- Config invalid: reject save at boundary; if persisted config cannot load, return 503 generic error and block start.
- Credential write/delete partial failure: leave prior credential reference active until the atomic replace/delete succeeds; record a server-side audit event and return a generic setup failure.
- Worktree creation failure: create a failed/retry run event; do not claim indefinitely.
- Agent session startup failure after lease: release lease in `finally`, record retryable failure.
- Ticket becomes terminal/ineligible: stop/release active run and record reconciliation reason.
- Gateway restart: repository reconstructs runs; orchestrator reconciles active claims against workspace/session state and Linear eligibility.
- Shutdown: stop poll timers, clear retry timers, drain status subscribers, then release in-memory runtime state.

## Complexity Tracking

No constitution violations. The feature adds a gateway submodule because current `symphony-runner.ts` is an external-process adapter and cannot safely satisfy Matrix-native credential, worktree, and dashboard requirements without becoming a hidden second orchestrator.
