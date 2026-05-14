# Implementation Plan: Desktop Cloud Symphony

**Branch**: `079-desktop-cloud-symphony` | **Date**: 2026-05-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/079-desktop-cloud-symphony/spec.md`

## Summary

Build Matrix Desktop as a native desktop workbench with near Slay Zone workflow parity while preserving Matrix OS architecture: the desktop app renders Matrix shell and app launcher, all coding-agent execution happens in Matrix cloud/VPS runtime, tickets come from Linear and Matrix-native sources, and Matrix Symphony claims tickets into cloud worktrees/sessions. Slay Zone is the product reference for task/workbench UX, tabs, agent status, artifacts, previews, automations, and settings; Matrix remains the source of truth for identity, data ownership, cloud sessions, and security policy.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16  
**Primary Dependencies**: Electron + electron-vite for native shell, electron-builder for desktop packaging, existing Matrix shell Next.js app, Hono gateway, Zod 4 via `zod/v4`, Kysely/Postgres, existing workspace/worktree/session/Symphony modules, lucide-react UI icons  
**Storage**: Owner-controlled PostgreSQL via Kysely for cloud projects, shared boards, tickets, assignments, Symphony runs, events, and desktop-visible runtime state; owner-controlled files only for desktop connection preferences, Matrix shell state, workflow contracts, exported backups, and shipped app assets  
**Testing**: Vitest for unit/integration/contract tests; Playwright for shell/desktop smoke and app-launcher verification; existing `bun run typecheck`, `bun run check:patterns:diff`, `bun run test`, and focused desktop/gateway tests  
**Target Platform**: macOS/Linux/Windows desktop app connecting to local dev Matrix, customer VPS Matrix, or hosted Matrix; cloud agent runtime remains Matrix VPS/gateway-side  
**Project Type**: Multi-project monorepo feature spanning desktop app package, gateway backend, shell UI, first-party Symphony/workspace apps, docs, and tests  
**Performance Goals**: Desktop cold window ready under 5 seconds after local shell is reachable; app launcher interactions under 150ms perceived latency after load; ticket board handles 200 synced tickets without visible jank; run status visible within one realtime event or 5 seconds fallback  
**Constraints**: Cloud-only coding-agent execution; no local agent process starts; no new embedded DB or ORM; no provider secrets or raw errors in desktop/browser state; all external fetches time out and SSRF-filter user-controlled URLs; mutating routes use `bodyLimit`; subscriber registries capped and drained; production customer runtime remains VPS-native  
**Scale/Scope**: Single-owner personal OS first with authorized teammate/operator access, followed by shared team boards; default Symphony concurrency 3 active cloud agents; ticket sync target 100+ Linear and 100+ Matrix-native tickets per project; parity target is workflow parity, not copying Slay Zone local persistence/runtime internals

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Desktop preferences are local files; cloud project/ticket/run state lives in owner-controlled Postgres; workflow policy remains owner/project files.
- **AI Is the Kernel**: PASS. Coding agents run through Matrix gateway/session/Symphony primitives; desktop is an operator shell, not a second agent kernel.
- **Headless Core, Multi-Shell**: PASS. Gateway/cloud orchestration remains headless and desktop joins web/mobile/channel shells as another renderer.
- **Defense in Depth**: PASS with required deliverables: auth matrix, route schemas, body limits, SSRF controls, generic errors, bounded realtime, cloud-only enforcement tests, restart recovery tests.
- **TDD**: PASS. Tasks require failing tests before implementation for desktop bridge policy, gateway contracts, internal tickets, sync, assignment, realtime, and UI flows.
- **Postgres/Kysely Only**: PASS. New Matrix durable state uses existing Postgres/Kysely paths; Electron must not add app data SQLite persistence.
- **Documentation-Driven Development**: PASS. Desktop setup, Slay parity map, cloud-only policy, and Symphony workflows require docs before implementation is complete.

## Project Structure

### Documentation (this feature)

```text
specs/079-desktop-cloud-symphony/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── desktop-bridge.md
│   ├── rest-api.md
│   └── realtime-events.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/desktop/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── src/main/
│   ├── config.ts
│   ├── index.ts
│   ├── security.ts
│   └── *.test.ts
└── src/preload/
    ├── index.ts
    └── index.d.ts

packages/gateway/src/
├── desktop/
│   ├── contracts.ts
│   ├── routes.ts
│   └── runtime-policy.ts
├── tickets/
│   ├── contracts.ts
│   ├── internal-repository.ts
│   ├── linear-sync.ts
│   ├── routes.ts
│   └── status-hub.ts
├── workflow/
│   ├── contracts.ts
│   ├── preview-policy.ts
│   ├── repository.ts
│   └── routes.ts
├── boards/
│   ├── contracts.ts
│   ├── membership.ts
│   └── routes.ts
├── symphony/
│   ├── orchestrator.ts
│   ├── repository.ts
│   └── routes.ts
└── workspace/
    └── existing project/worktree/session managers

shell/src/
├── components/
│   ├── Desktop.tsx
│   ├── CommandPalette.tsx
│   ├── workspace/WorkspaceApp.tsx
│   └── symphony/ or existing home/apps/symphony integration points
├── lib/
│   ├── desktop-runtime.ts
│   └── gateway.ts
└── stores/
    └── existing shell/workspace stores

home/apps/symphony/
└── existing Matrix Symphony app updated for unified tickets and desktop affordances

tests/
├── desktop/
├── gateway/
├── shell/
└── e2e/

docs/dev/
www/content/docs/
.github/workflows/
scripts/release/
```

**Structure Decision**: Add a small `apps/desktop` native wrapper that loads the existing Matrix shell and exposes only safe desktop capabilities. Add gateway modules for desktop runtime policy and Matrix-native tickets; extend existing workspace and Symphony modules rather than copying Slay Zone's local app database. Keep Slay-like product workflows in shell/first-party Matrix apps backed by cloud APIs.

## Slay Zone Release Reference

Slay Zone's release pipeline is the reference for desktop distribution shape: a tag/manual `release.yml`, reusable `release-foundation.yml`, dry-run/publish modes, channel JSON input, preflight typecheck, multi-platform electron-builder matrix, macOS certificate import, notarization, collected assets, release manifest/checksums, GitHub release publication, Homebrew cask update, and release notifications. Matrix Desktop should adapt this to Matrix secrets, package names, and release channels rather than copying Slay's Convex or brand-specific steps.

## Security Architecture

| Surface | Auth Method | Public? | Data Exposed | Notes |
|---------|-------------|---------|--------------|-------|
| Desktop preload bridge | Context-isolated desktop bridge | Local desktop only | Runtime policy, open-external result | No raw Node/Electron APIs exposed to shell |
| `GET /api/desktop/runtime` | Matrix request principal | No | Safe capabilities, cloud-only policy, instance info | No secrets or filesystem paths |
| `GET /api/projects/:projectSlug/tickets` | Matrix request principal + project access | No | Sanitized tickets | Query filters capped/validated |
| `POST /api/projects/:projectSlug/tickets` | Matrix request principal + body schema | No | Created internal ticket | `bodyLimit`; transaction for ticket + history |
| `PATCH /api/projects/:projectSlug/tickets/:ticketId` | Matrix request principal + body schema | No | Updated ticket | Optimistic revision in update statement |
| `POST /api/projects/:projectSlug/tickets/sync/linear` | Authorized operator | No | Sync summary | Server-side credential use only |
| `POST /api/projects/:projectSlug/tickets/:ticketId/assignments/symphony` | Authorized operator | No | Assignment/run summary | Idempotent claim path |
| `GET /api/projects/:projectSlug/tickets/events` | Authorized operator | No | Bounded ticket/status events | Subscriber cap, stale eviction |
| `GET /api/projects/:projectSlug/workflow` | Project operator | No | Sanitized workflow setup/readiness | No raw cloud paths/secrets |
| `POST /api/projects/:projectSlug/workflow` | Project owner/operator | No | Saved workflow config | Validates commands/ports |
| `GET /api/projects/:projectSlug/members` | Project operator | No | Authorized board members | Role-scoped |
| `POST /api/projects/:projectSlug/members` | Project owner/admin | No | Membership update | Audit event |
| `GET /api/projects/:projectSlug/previews` | Project operator | No | Approved preview/browser refs | SSRF/port policy enforced |
| Existing `/api/symphony/*` | Authorized operator/owner | No | Sanitized config/runs/events | Extended to internal tickets and desktop status |
| Workspace/worktree/session APIs | Matrix request principal + project access | No | Sanitized cloud runtime state | Cloud-only agent starts enforced server-side |

Boundary validation: all desktop runtime, ticket, sync, assignment, worktree, session, and Symphony payloads use Zod 4 route-boundary schemas.  
Error policy: clients receive short generic messages; server logs contain details. Desktop UI applies allowlist/cap before display.  
Network policy: server-side preview/browser/integration URL fetches parse and SSRF-filter URLs, reject unvalidated redirects, and use `AbortSignal.timeout()`.  
Resource policy: all realtime registries and in-memory caches have caps, eviction, and shutdown drains. Ticket sync page caps prevent unbounded provider pulls.  
Cloud-only policy: desktop bridge has no local-agent start API; gateway rejects local runtime modes for this product path; tests assert no desktop IPC invokes local agent execution.

## Integration Wiring

1. Desktop app reads a local connection target and loads the Matrix shell URL.
2. Shell calls `/api/desktop/runtime` to learn capabilities, cloud-only policy, and instance health.
3. Gateway mounts desktop runtime routes after request-principal middleware and before shell app APIs that depend on runtime policy.
4. Gateway mounts Matrix-native ticket routes with injected Kysely repository, Linear source adapter, event hub, workspace manager, and Symphony assignment service.
5. Gateway mounts workflow/readiness routes for project setup commands, live commands, preview ports, and Codex cloud readiness.
6. Linear sync reuses server-side integration/credential paths and never sends provider secrets to desktop or spawned sessions.
7. Internal tickets and synced Linear tickets share one tracked-ticket repository and event stream.
8. Board membership routes authorize shared team boards and per-runner claim permissions.
9. Symphony assignment service calls the existing Symphony orchestrator with normalized ticket context and cloud worktree/session dependencies.
10. Shell Workspace/Symphony views consume unified ticket/worktree/session/run contracts and preserve app-launcher/canvas/desktop compatibility.
11. Release workflows package desktop artifacts using the Slay-inspired dry-run/publish/channel model.
12. Gateway shutdown drains ticket/Symphony event hubs before destroying database/session dependencies.

## Failure Modes

- Desktop cannot reach shell: show connection setup/retry state; do not silently fall back to unrelated hosted shell.
- Shell reachable but gateway unhealthy: app launcher remains visible, cloud runtime surfaces show degraded state.
- Desktop bridge receives invalid URL/protocol: deny navigation or open-external request.
- Local agent start attempted: desktop has no IPC path; gateway returns cloud-only policy violation if route is probed.
- Linear credential missing/revoked: ticket sync and Symphony auto-claim pause with setup attention state.
- Codex cloud credential missing/revoked: Symphony setup shows blocked readiness and does not dispatch unattended work.
- Workflow setup/live command invalid or unsafe: route rejects save with generic client error and logs details server-side.
- Preview port unavailable or disallowed: desktop shows preview unavailable without exposing host internals.
- Shared board membership revoked mid-session: realtime/control requests are denied on the next authorization check.
- Ticket sync partial failure: commit successful ticket updates in transactions, record sync summary, retry failed pages later.
- Internal ticket update conflict: reject stale revision without overwriting newer cloud state.
- Worktree claim race: assignment uses transaction/unique claim and idempotent retry semantics.
- Agent session startup fails after worktree claim: release claim in failure path and record retryable run event.
- Realtime stream drops: desktop falls back to bounded polling and reconciles by revision/timestamp.
- Gateway restart: startup recovery reconciles tickets, worktrees, sessions, Symphony runs, stale claims, and event streams.
- Provider/filesystem/DB errors: detailed logs only; client sees safe generic message.
- Desktop release publish secrets missing: publish workflow fails before package publication; dry-run remains available.

## Phase 0 Research Summary

See [research.md](./research.md). Key decisions:

- Use Electron as a thin native shell around Matrix shell, not a full Slay Zone code copy.
- Treat Slay Zone as a workflow parity reference; Matrix owns data and cloud runtime.
- Store Matrix-native tickets in owner Postgres/Kysely with source attribution and revisions.
- Enforce cloud-only coding agents in both desktop bridge and gateway contracts.
- Extend Matrix Symphony for internal tickets instead of creating a second runner.
- Adapt Slay Zone's release pipeline shape for signed/notarized Matrix Desktop artifacts.

## Phase 1 Design Summary

See [data-model.md](./data-model.md), [contracts/desktop-bridge.md](./contracts/desktop-bridge.md), [contracts/rest-api.md](./contracts/rest-api.md), [contracts/realtime-events.md](./contracts/realtime-events.md), and [quickstart.md](./quickstart.md).

## Complexity Tracking

No constitution violations. This is a large multi-PR feature because true Slay-like parity crosses native desktop, gateway contracts, Matrix tickets, cloud runtime, Symphony, shell UI, docs, and verification. The tasks deliberately split it into stacked PR layers to keep review size controlled.
