# Implementation Plan: Unified Agent Runtime Configuration

**Branch**: `107-agent-runtime-config` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/107-agent-runtime-config/spec.md`

## Summary

Extend the existing additive Agent settings contract into a single computer-owned view without collapsing two different systems called Hermes. Matrix OS Chat remains the Claude Agent SDK V1 kernel. A separate `messagingRuntime` selects the optional Hermes or OpenClaw process adapter. Shared Zod contracts describe the Chat selection, provider/model/auth catalog, runtime health, and current messaging selection. Gateway adapters normalize each external runtime behind the same safe boundary, while web Canvas and desktop render the same state and legacy model/effort clients continue to work.

The work lands as a Graphite stack of small, independently testable PRs. Three current contract gaps—conversation transcript read, per-message model/effort, and effective system-info model—land before the larger configuration changes. The OpenClaw service/config work lands separately from UI work. Every code PR is tested red-green-refactor, receives Greptile 5/5 on its exact head, and is deployed as an exact host bundle to a `preview-vps` computer before promotion.

## Technical Context

**Language/Version**: TypeScript 5.9+ strict ES modules; Node.js 24+; React 19; shell Next.js 16; Bash for host wrappers
**Primary Dependencies**: Hono, Zod 4 via `zod/v4`, Claude Agent SDK V1 `query()`, existing Hermes dashboard API, OpenClaw gateway WebSocket RPC, systemd, `@matrix-os/contracts`, `@matrix-os/brand`
**Storage**: Owner files under `$MATRIX_HOME`: `system/config.json` for Matrix selection, `.hermes/` for Hermes-owned config, `.openclaw/` for OpenClaw-owned config; no new Matrix database. External runtime state remains runtime-owned and is excluded from client responses.
**Testing**: Vitest unit/route/component tests, systemd/host-bundle tests, current mobile compatibility tests, React Doctor, production shell build, preview VPS live probes
**Target Platform**: VPS-native Linux gateway and systemd services; web Canvas/desktop shell; Electron desktop renderer with trusted main/preload boundary; mobile contract consumers
**Project Type**: Monorepo backend contracts + gateway + host runtime + web shell + Electron desktop
**Performance Goals**: Agent settings visible within 2 seconds; runtime status probes bounded to 2 seconds each and performed concurrently; runtime switch completes or safely fails within 75 seconds, including a host-control action bounded to 70 seconds; no effect on Chat request latency when messaging runtimes are absent
**Constraints**: Additive wire compatibility; no browser-side secrets; no provider-specific raw errors; loopback-only external dashboards with auth; bounded catalogs and queues; no direct OpenClaw Matrix room membership; kernel prompt remains under 7K tokens
**Scale/Scope**: One owner per customer VPS; two selectable messaging runtimes; maximum 32 provider descriptors, 256 models total, 128 models per provider; one serialized runtime transition; existing Chat queue limits unchanged

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Matrix selection remains in owner-controlled `system/config.json`. Hermes and OpenClaw own their state under the owner's Matrix home. No secret or conversation state is added to platform storage. OpenClaw's internal SQLite file is external runtime-owned implementation state, not new Matrix persistence.
- **AI Is the Kernel**: PASS. Claude Agent SDK V1 `query()` remains the Chat kernel. Per-message overrides are allowlisted and passed to the already-supported `KernelConfig`; no prompt or orchestration fork is added.
- **Headless Core, Multi-Shell**: PASS. Shared contracts and gateway endpoints are authoritative. Web, desktop, and mobile are renderers with additive compatibility.
- **Defense in Depth**: PASS with mandatory design controls. [security.md](./security.md) defines the auth matrix, validation, body limits, secret boundaries, SSRF defense, safe errors, and loopback authentication. [resource-management.md](./resource-management.md) defines caps, timeouts, cleanup, and shutdown.
- **TDD**: PASS with required implementation ordering. Each stack branch begins with a failing focused test; production code follows only after the failure is observed.
- **Worktree, PR, and Greptile 5/5**: PASS conditionally. Every stack branch uses its own manual worktree, `gt create`, the shared PR invariants, current-head CI, Greptile 5/5, and preview evidence. Nothing merges from this planning branch.
- **Documentation-Driven Development**: PASS. The spec, operational contracts, quickstart, and deployment proof precede and accompany implementation.
- **Spike Before Spec**: PASS. [research.md](./research.md) records the completed OpenClaw 2026.6.11 throwaway spike, including actual process, config, RPC, auth, Matrix plugin, footprint, and failure behavior.
- **Postgres/Kysely Only**: PASS. No Matrix persistence engine is added. Runtime-owned OpenClaw state is not accessed as a Matrix data store.
- **Large-File Rule**: PASS with extraction requirements. New behavior is added through focused route/service/schema/component modules. The gateway `server.ts`, desktop `AgentSection.tsx`, and shell `Settings.tsx` receive wiring-only changes.

No complexity exception is required.

## Architecture Decisions

### Two independent selections

```text
Chat selection
  Claude Agent SDK kernel
  provider: anthropic in this release
  model + effort defaults, with optional per-message override

Messaging selection
  Matrix permission-gated delivery adapter
  runtime: hermes | openclaw
  runtime-owned provider + model + authentication
```

`runtime` in the extended client contract is the messaging runtime. It never changes the Chat kernel. The response names both selections explicitly to make conflation difficult.

### Runtime adapters

The gateway depends on a typed `MessagingRuntimeAdapter`, not on runtime-specific response objects:

- `probe()` returns bounded install, process, config, and auth readiness.
- `catalog()` returns normalized provider/model descriptors.
- `configure()` validates a selected provider/model and calls only allowlisted runtime operations.
- `prepare()`, `activate()`, and `deactivate()` participate in a serialized fail-closed transition.
- `dashboard()` exposes a normalized optional messaging dashboard summary.

Hermes uses the existing loopback dashboard routes. OpenClaw uses an authenticated loopback WebSocket RPC client. Neither client exposes a generic pass-through or raw config endpoint.

### Runtime transition

One lock file created exclusively under `system/agent-runtime/` serializes transitions. The controller validates the target, pauses new Matrix messaging delivery, drains for at most 5 seconds, stops the previous delivery process, starts and probes the target, persists the selection atomically, then resumes delivery. Failure before persistence restarts the old runtime. Failure after persistence rolls the file and services back. Chat dispatch is outside this path.

### Provider authentication

- Platform access is read-only status; the client never receives a platform token.
- API keys use write-only provider-scoped mutations. Reads return only coarse status.
- Subscription login uses the canonical visible `__terminal__` setup flow; desktop asks trusted main/preload to launch it.
- Custom endpoints are HTTPS-only by default, DNS/private-range checked, redirect-rejected, and never fetched without a timeout. A loopback endpoint is allowed only for fixed Matrix-owned adapter URLs, never from user input.
- Provider descriptors expose the effective/recommended `authKind` and a bounded `supportedAuthKinds` list so one provider can safely advertise platform, BYOK, and subscription-login choices together.

## Project Structure

### Documentation (this feature)

```text
specs/107-agent-runtime-config/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── security.md
├── integration.md
├── failure-modes.md
├── resource-management.md
├── quickstart.md
├── pr-invariants.md
├── checklists/requirements.md
├── contracts/agent-settings.openapi.yaml
├── contracts/messaging-runtime-adapter.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/contracts/src/
└── index.ts                         # shared agent config schemas/types

packages/gateway/src/
├── routes/settings.ts               # legacy route wiring only
├── agent-config/
│   ├── schemas.ts                   # gateway-only secret/input schemas
│   ├── service.ts                   # read/update orchestration
│   ├── provider-catalog.ts          # normalized Chat/runtime catalog
│   ├── runtime-controller.ts        # serialized fail-closed transition
│   ├── hermes-adapter.ts            # existing dashboard adapter
│   └── openclaw-adapter.ts          # authenticated WS RPC adapter
├── routes/conversations.ts          # stored transcript GET
├── ws-message-schema.ts             # optional model/effort
├── dispatcher.ts                    # message options -> KernelConfig
├── system-info.ts                   # effective kernel model
└── server.ts                        # registration/wiring only

distro/customer-vps/
├── host-bin/
│   ├── matrix-install-openclaw
│   ├── matrix-openclaw-gateway
│   └── matrix-agent-runtime-control
└── systemd/
    └── matrix-openclaw-gateway.service

shell/src/
├── components/Settings.tsx          # unhide Agent only
├── components/settings/sections/AgentSection.tsx
└── lib/agent-config.ts              # bounded wire normalizer/client

desktop/src/renderer/src/
├── features/settings/sections/AgentSection.tsx
└── lib/agent-config.ts              # older-gateway normalizer

tests/
├── gateway/
├── shell/
├── desktop/
└── deploy/customer-vps/
```

**Structure Decision**: Keep schemas shared in `packages/contracts`, secrets and runtime calls in gateway/host-only modules, and shell-specific rendering in each shell. Extract behavior from existing large composition files; do not add runtime logic to `server.ts` or privileged logic to a renderer.

## Stack and PR Boundaries

1. `docs(agent): specify unified runtime configuration` — spec package only.
2. `feat(gateway): expose stored conversation transcript` — safe path schema, GET route, tests.
3. `feat(kernel): support per-message model and effort` — frame schema, allowlist, dispatcher threading, tests.
4. `fix(gateway): report active kernel model` — system-info effective model, tests.
5. `feat(contracts): define agent runtime configuration` — shared additive schemas and fixtures.
6. `feat(gateway): unify agent configuration` — provider catalog, additive settings response/update, auth status, tests.
7. `feat(runtime): add OpenClaw messaging adapter` — installer/unit/control/RPC adapter and rollback tests.
8. `feat(shell): add Agent runtime settings` — Canvas-first UI, Agent-only unhide, component tests, production build.
9. `feat(desktop): extend Agent runtime settings` — provider/runtime UI, older-gateway fallback, trusted-action wiring.

Every PR stays below 3,000 additions and 50 files. If a boundary grows beyond that limit it is split before submission, never waived.

## Post-Design Constitution Check

- Owner storage and export boundaries remain explicit in [data-model.md](./data-model.md).
- The Chat kernel/runtime separation is encoded in both shared types and UI labels.
- Every boundary in [security.md](./security.md) has auth, Zod validation, body limits where mutating, safe errors, and secret rules.
- Runtime Maps, catalogs, polls, queues, subprocesses, timers, temp files, and shutdown behavior are bounded in [resource-management.md](./resource-management.md).
- The runtime transition has idempotency, an exclusive lock, health-gated persistence, and rollback in [failure-modes.md](./failure-modes.md).
- TDD and exact preview release verification are executable in [quickstart.md](./quickstart.md) and [tasks.md](./tasks.md).

All gates pass; no complexity exception is introduced.

## Complexity Tracking

No constitution violations or justified exceptions are planned.
