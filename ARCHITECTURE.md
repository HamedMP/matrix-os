# Matrix OS Architecture

Matrix OS is a Web 4 operating system: the AI kernel, gateway, platform, owner-controlled data, and app runtime are headless; shells render and operate those capabilities.

This document is the root map for contributors. Package-specific architecture notes should link back here instead of redefining system boundaries.

## Runtime Shape

```text
matrix-os.com / app.matrix-os.com
  |-- matrix-os-site       public docs, marketing, signup entry points (separate repository)
  |-- shell/               web shell renderer for owner runtime
  |-- desktop/             desktop shell packaging/runtime
  |-- apps/                companion app surfaces, including mobile and menu bar
  |
  +-- packages/platform/   control plane: auth, billing, VPS provisioning, routing
      |
      +-- customer VPS per owner
          |-- packages/gateway/       HTTP, WebSocket, app bridge, channel adapters
          |-- packages/kernel/        AI kernel, agents, tools, skills
          |-- packages/sync-client/   CLI and sync daemon
          |-- home/                   owner-visible OS template and default apps
          +-- owner Postgres          canonical app/workspace/social data
```

Production customer runtime is VPS-native. Do not model new user-facing runtime behavior around shared platform containers, Docker Compose rollouts, or platform-owned app data.

## Top-Level Areas

| Path | Responsibility | Should Not Own |
|------|----------------|----------------|
| `packages/kernel/` | AI kernel, Agent SDK integration, agent/tool orchestration, skills | HTTP routing, shell rendering, platform billing |
| `packages/gateway/` | Owner runtime API, WebSockets, app bridge, filesystem bridge, channel adapters | Platform auth/control-plane state, shell UI policy |
| `packages/platform/` | Clerk auth, customer VPS lifecycle, billing/provisioning gates, host-bundle release metadata, platform-owned integrations | Owner app data, per-owner runtime internals |
| `packages/proxy/` | Shared API proxy, usage and quota accounting | Product-domain state or shell behavior |
| `packages/sync-client/` | CLI, sync daemon, local profile/session commands | Gateway route ownership or platform provisioning |
| `packages/observability/` | Shared telemetry, PostHog wiring, and error tracking helpers | Product-domain behavior or user-owned data |
| `packages/edge-router/` | Edge routing helpers and Cloudflare-facing routing code | Owner runtime state or shell UI policy |
| `packages/neo-worker/` | Cloudflare Worker surface for PostHog/edge support paths | Owner runtime APIs or platform database ownership |
| `packages/mcp-browser/` | Browser automation MCP helpers and browser security utilities | Shell renderer state or app data persistence |
| `packages/clerk-sync/` | Clerk user/profile synchronization helpers | General platform provisioning or owner app data |
| `packages/ui/` | Shared UI primitives used by shells/apps | Domain business rules |
| `shell/` | Browser shell renderer, Canvas/Desktop windows, frontend stores | Canonical backend source of truth |
| `desktop/` | Desktop package/runtime integration | Web-only shell product logic |
| `apps/` | Companion shell surfaces such as mobile and menu bar apps | Canonical backend source of truth or platform control-plane ownership |
| `home/` | Owner-visible OS files, default apps, icons, templates | Hidden platform state |
| `specs/` | Product/architecture specs and quality gates | Implementation-only scratch plans |
| `tests/` | Cross-package Vitest suites | Runtime code |

## Source-Of-Truth Rules

- Identity/config/export state lives in inspectable owner files under `home/` or the deployed owner home.
- App, workspace, social, and durable runtime data live in owner-controlled Postgres through Kysely.
- Platform-owned data is limited to control-plane state: auth linkage, billing/provisioning status, release metadata, routing, and platform-owned integration credentials.
- Shell stores are renderer state. They may cache or optimistically stage data, but backend files/Postgres remain canonical.
- Default apps under `home/apps/**` use the Matrix bridge, not direct fetches to `/api/bridge/*`.

## Domain Boundary Direction

The current repo has infrastructure-oriented packages. As product domains become large enough to extract, prefer domain packages with explicit boundary docs instead of growing gateway or shell catch-all modules.

Recommended dependency direction:

```text
shell/ or apps/*
  -> packages/ui
  -> domain package API/types
  -> packages/gateway route adapters
  -> packages/kernel/platform/proxy infrastructure as needed
```

Rules:

- A domain package may expose pure types, validators, repository/service interfaces, and route registration helpers.
- Gateway/platform packages may adapt HTTP/auth/runtime dependencies into domain APIs.
- Domain packages must not import renderer components from `shell/`.
- Domain packages must not bypass owner data rules with a new database or ORM.
- Cross-domain calls should go through explicit service interfaces or stable public functions, not deep imports from another domain's internals.
- If `packages/domains/*` is introduced, update `pnpm-workspace.yaml` before adding packages there.

## When To Extract A Domain

Extract a package or add a package-level `DOMAIN.md` when at least two of these are true:

- The feature spans gateway routes, shell UI, persistence, tests, and docs.
- Multiple files import the same domain schemas/helpers across packages.
- Reviewers need domain invariants to judge changes safely.
- The feature has its own source-of-truth, auth, concurrency, or recovery policy.
- The gateway or shell module has become a catch-all for unrelated behavior.

Do not extract only to move files around. The first useful extraction is usually documentation plus a narrow public API.

## Change Workflow

For architecture-affecting changes:

1. Add or update the relevant spec under `specs/` when behavior changes.
2. Update this root map if ownership or dependency direction changes.
3. Add or update a `DOMAIN.md` near the domain code when domain invariants matter.
4. Keep PRs split by boundary: docs, gateway, platform, shell, sync-client, or one domain package.
5. Run the normal review gates from `docs/dev/review-pipeline.md`.
