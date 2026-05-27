# Research: Elixir Symphony Runtime

## Decision: Use Elixir Symphony As The Runtime Source Of Truth

The Matrix `078-matrix-symphony` spec intentionally moved Symphony into the gateway as a Matrix-native TypeScript orchestrator. The user has now reversed that direction for this feature: the Elixir implementation should become the per-VPS runtime because it already models Codex app-server sessions and exposes lifecycle observability that the current Matrix app lacks.

**Rationale**:

- Elixir Symphony already starts `codex app-server` and tracks thread/turn/session identifiers.
- It exposes an HTTP/LiveView observability surface that can be adapted behind Matrix gateway auth.
- It keeps the orchestration process independent from gateway restarts.
- Matrix can still own auth, workspace roots, host-bundle packaging, and app UX through adapter layers.

**Rejected alternative**: Continue extending the TypeScript gateway orchestrator from `078-matrix-symphony`. That keeps everything in one language, but recreates app-server lifecycle tracking and continues to split user expectations between terminal auth state, gateway run state, and actual Codex progress.

## Decision: Gateway Proxy, Not Browser Direct-To-Elixir

Matrix gateway remains the browser-facing control plane. `/api/symphony/*` routes authenticate the Matrix user, validate and bound requests, call the loopback Elixir API with timeouts, and return a Matrix-normalized response.

**Rationale**:

- Preserves existing Matrix auth and browser security model.
- Keeps the Elixir API loopback-only.
- Lets Matrix map errors and shape payloads without forking every Elixir dashboard detail into the browser contract.

**Rejected alternative**: Expose the Elixir Phoenix endpoint directly to the browser. That would create a second auth/session surface and make CORS, CSRF, and service reachability harder to reason about.

## Decision: Matrix-Owned Linear Credential Bridge

Symphony should prefer Matrix/Pipedream/platform integration state and avoid requiring `LINEAR_API_KEY` in customer VPS shell environments. The bridge may start as a gateway/platform endpoint that returns a scoped capability to the local service, then evolve into a first-class integration token exchange.

**Rationale**:

- Users already connect integrations through Matrix.
- Secrets remain in Matrix-managed storage instead of copied into VPS dotfiles.
- It aligns with the owner-data model: browser sees setup state, not provider credentials.

**Open implementation detail**: The first implementation can proxy Linear calls through the gateway/platform rather than minting a local token, if that is smaller and easier to audit.

## Decision: Matrix-Managed Workspace Root

Default workspace root should be under owner home, using a deterministic Matrix project path such as `/home/matrix/home/projects/matrix-os/symphony-workspaces/<issue>`.

**Rationale**:

- Workspaces are inspectable user-owned files.
- Matrix can open them in Workspace/Code surfaces.
- Path validation can be centralized around a single configured root.

## Decision: Preserve Upstream License And Keep Fork Boundary Explicit

The upstream Symphony repository is Apache-2.0. Matrix can adapt and redistribute it, but the host-bundle source should retain license/notice material and document local Matrix changes.

**Rationale**:

- Keeps license compliance straightforward.
- Makes future upstream rebases possible.
- Helps reviewers separate upstream code from Matrix adapters.

## Spike Findings From Local Upstream Clone

- Elixir package app: `symphony_elixir`, version `0.1.0`, Elixir `~> 1.19`.
- Runtime HTTP API includes `GET /api/v1/state`, `GET /api/v1/:issue_identifier`, and `POST /api/v1/refresh`.
- Codex app-server client starts a `codex app-server` process over stdio, starts a thread, then starts turns and emits `session_id=<thread_id>-<turn_id>`.
- Dynamic tools include `linear_graphql` and `sync_workpad` in the local clone.
- The Phoenix endpoint can bind to a configured host/port; Matrix must force loopback in customer runtime.

## Risks

- Elixir runtime toolchain may not exist in current host-bundle build/runtime images.
- The upstream API does not yet expose every Matrix action needed by the app, especially stop controls; we may need small Elixir API additions.
- Matrix-owned Linear credentials require a service-to-service bridge that does not leak secrets and does not couple customer VPSes to platform internals.
- Retiring TypeScript Symphony too early could break existing app tests before the Elixir proxy/app contract is complete.
