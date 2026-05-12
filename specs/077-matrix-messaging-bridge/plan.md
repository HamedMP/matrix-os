# Implementation Plan: Matrix Messaging Bridge

**Branch**: `077-matrix-messaging-bridge` | **Date**: 2026-05-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/077-matrix-messaging-bridge/spec.md`

## Summary

Build an owner-controlled Matrix messaging backbone for each Matrix OS user, focused first on Telegram and WhatsApp. The durable architecture is self-hosted bridges on the user's VPS, a bridge-compatible Matrix homeserver, a first-party Messages surface, and a Matrix OS permission registry that gates Hermes read/reply/automation access per Matrix room.

Planning is intentionally spike-first: implementation tasks must not be generated until Telegram and WhatsApp are proven against the selected homeserver for appservice registration, inbound/outbound messaging, media, E2EE posture, restart recovery, backup/restore, and revocation-driven Hermes isolation.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16  
**Primary Dependencies**: Hono gateway routes, Zod 4 via `zod/v4`, Kysely/Postgres, Matrix homeserver appservice support, self-hosted Telegram and WhatsApp bridge runtimes, existing Matrix OS shell/app bridge, Hermes/Claude Agent SDK V1 `query()` path  
**Storage**: Owner-local Postgres on the customer VPS for Matrix OS permission/audit data; separate homeserver database; separate Telegram bridge database; separate WhatsApp bridge database; owner-local media/cache paths covered by backup/restore policy  
**Testing**: Vitest unit/contract/integration tests, homeserver/bridge spike checks, gateway route contract tests, Messages app tests, manual VPS restart/restore quickstart  
**Target Platform**: Matrix OS customer VPS, Linux host services, local owner-controlled Postgres, Matrix shell/gateway over HTTPS  
**Project Type**: Web app plus gateway/platform/runtime services in the existing monorepo  
**Performance Goals**: Telegram guided setup shows first conversation within 5 minutes; room permission revocation stops new Hermes/automation visibility within 10 seconds and cancels queued/unsent work; health checks complete within 5 seconds; initial visible backfill capped at latest 100 messages per room by default  
**Constraints**: No Beeper-managed backbone; no Docker Compose as production customer runtime path; no wildcard CORS; all mutating endpoints use `bodyLimit`; external calls and bridge health probes use explicit timeouts; user-visible errors are safe and action-oriented; Hermes defaults to no room visibility; E2EE/key-sharing posture must be proven before Hermes reads encrypted rooms  
**Scale/Scope**: First track covers Telegram and WhatsApp for one owner VPS; later networks must reuse the same permission/storage model but are out of scope for the first implementation plan  
**Resource Floor**: Messaging-enabled customer VPS baseline is 2 vCPU, 4 GiB RAM, 40 GiB disk. If Synapse is selected, recommended baseline is 2 vCPU, 6 GiB RAM, 60 GiB disk. Smaller tiers must leave messaging disabled, Telegram-only experimental, or require upgrade before WhatsApp/Synapse enablement.
**Recovery Boundary**: Messaging state RPO is 1 hour; RTO is 15 minutes after the VPS is reachable. WhatsApp may require relink after restoring from a snapshot older than 24 hours or whenever the paired-device session is invalid.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Bridge state, homeserver state, permissions, audit events, media/cache metadata, and export/delete flows are scoped to the user's VPS and owner-local storage.
- **AI Is the Kernel**: PASS. Hermes receives messages only through the Matrix OS permission gate and replies through a controlled Matrix OS path.
- **Headless Core, Multi-Shell**: PASS. Messaging backbone is gateway/service-driven; the Messages app is one renderer, not the source of truth.
- **Quality Over Shortcuts**: PASS. The plan starts with bridge/homeserver proof rather than a demo-only UI.
- **App Ecosystem and Multi-Tenancy**: PASS. The first slice is personal-owner scoped and leaves org/shared policy explicit future work.
- **Defense in Depth**: PASS. The spec and contracts include route-level auth, body limits, constant-time appservice/setup token checks, input validation, redacted errors, bounded queues, and timeout requirements.
- **TDD**: PASS. Tests and throwaway bridge spikes are required before implementation tasks.
- **Documentation-Driven Development**: PASS. The eventual task list must include public docs and developer docs updates for Messages, privacy controls, and VPS operations.

## Project Structure

### Documentation (this feature)

```text
specs/077-matrix-messaging-bridge/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── rest-api.md
└── tasks.md              # Generated only after spike gates pass
```

### Source Code (repository root)

```text
packages/gateway/src/messages/
├── routes.ts                 # /api/messages route registration and body limits
├── schemas.ts                # Zod route, event, permission, setup schemas
├── repository.ts             # Kysely persistence for permissions/audit/mappings
├── permission-registry.ts    # last-point Hermes/reply/automation checks
├── appservice-events.ts      # trusted local appservice event ingestion
├── bridge-health.ts          # coarse health/recovery orchestration
└── hermes-delivery.ts        # selected Hermes participation mode

packages/gateway/src/server.ts
└── route wiring for /api/messages with registration-time dependencies

packages/platform/src/
├── matrix-provisioning.ts    # homeserver identity provisioning migration hooks
└── customer-vps-routes.ts    # deploy/recovery hooks for homeserver/bridge services

shell/src/
├── components/messages/      # first-party Messages UI and permissions screen
└── stores/messages-store.ts  # serializable state, stable selectors

home/apps/messages/
├── matrix.json
└── src/                      # bundled Vite React Messages app, opened in Canvas

distro/customer-vps/
├── systemd/                  # homeserver, bridge, and recovery service units
└── host-bin/                 # bridge health/recovery helpers

tests/gateway/messages/
├── routes.test.ts
├── permission-registry.test.ts
├── appservice-events.test.ts
└── repository.test.ts

tests/shell/messages/
└── messages-app.test.tsx

tests/deploy/customer-vps/
└── matrix-messaging-bridge.test.ts
```

**Structure Decision**: Add a dedicated `packages/gateway/src/messages/` module for all owner-scoped messaging contracts and permission gates. This is intentionally separate from `packages/gateway/src/channels/`: `channels` remains the legacy/direct adapter namespace, while `messages` is the Matrix-room-backed messaging backbone. Keep homeserver/bridge process installation in `distro/customer-vps/` and platform provisioning hooks in `packages/platform/`. The user-facing Messages surface is a first-party bundled Vite React app under `home/apps/messages/` and must work in Canvas first while calling `/api/messages/*` rather than talking to bridge runtimes directly. Customer-VPS rollout tests live under `tests/deploy/customer-vps/` to match the runtime surface under `distro/customer-vps/`.

## Phase 0: Research Decisions

See [research.md](./research.md). Required outcomes:

- Choose the homeserver path by proving Telegram and WhatsApp bridges against Conduit, Synapse, or a split-homeserver option.
- Choose Hermes participation mode before any message content enters Hermes.
- Decide E2EE posture and key-sharing semantics for bridged rooms before Hermes receives encrypted-room content.
- Confirm backup/restore boundaries for homeserver DB, bridge DBs, Matrix OS permission/audit data, media/cache, and setup sessions.
- Confirm RPO/RTO: 1 hour backup RPO, 15 minute restore RTO after reachable VPS, and explicit WhatsApp relink after stale or invalid restored sessions.
- Confirm resource floor and numeric caps: 10,000 queued events per owner, 2,000 per network, 500 per room, 100 concurrent media jobs per owner, 10 per room, and 30 days of idempotency keys.
- If Synapse is selected, choose split-homeserver or run a migration spike before implementation tasks.
- Confirm Beeper is prior art only, not the runtime backbone.

## Phase 1: Design Artifacts

- [data-model.md](./data-model.md): owner-scoped entities, validation rules, state transitions, and transaction boundaries.
- [contracts/rest-api.md](./contracts/rest-api.md): route-level REST and trusted appservice contracts.
- [quickstart.md](./quickstart.md): spike and validation flow before implementation tasks.

## Post-Design Constitution Check

- **Owner control**: PASS. Data model separates Matrix OS owner records from homeserver/bridge state and defines export/delete behavior.
- **Defense in depth**: PASS. Contracts define body limits, auth methods, safe errors, token comparison, event validation, queue limits, and coarse health status.
- **TDD**: PASS. Quickstart starts with failing contract/permission tests and throwaway bridge spikes before implementation.
- **Headless core**: PASS. Gateway contracts work without the shell; the Messages UI consumes owner-scoped APIs.
- **Operational fit**: PASS with dependency. Production rollout remains VPS-native, but homeserver selection is blocked on the required spike matrix and customer-VPS resource floor.

## Complexity Tracking

No constitution violations are currently justified. The extra homeserver/bridge spike phase is required to avoid selecting an incompatible messaging backbone.
