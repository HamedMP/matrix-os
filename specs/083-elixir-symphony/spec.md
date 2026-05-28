# Feature Specification: Elixir Symphony Runtime

**Feature Branch**: `083-elixir-symphony`  
**Created**: 2026-05-25  
**Status**: Draft  
**Input**: User description: "Use the Elixir Symphony implementation, adapt it for Matrix, replace the current TypeScript Symphony runner, keep it as a per-VPS service, proxy it through the gateway, show its Codex app-server state in the Matrix app, use Matrix-owned Linear auth, and use Matrix workspace conventions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Symphony As A Matrix VPS Service (Priority: P1)

A Matrix owner signs in to their VPS-backed OS and Symphony is available as a host service named `matrix-symphony.service`, running as the `matrix` user with `MATRIX_HOME=/home/matrix/home`. The service uses Matrix-owned workspace paths and runs the adapted Elixir Symphony orchestrator instead of the in-gateway TypeScript run table.

**Why this priority**: The replacement only works if Symphony is part of the normal customer VPS runtime and survives shell/gateway restarts.

**Independent Test**: Build a host bundle, install it into a VPS-like fixture, start `matrix-symphony.service`, and verify the service reads `MATRIX_HOME`, binds only to loopback, reports health/state, and uses a workspace root under the owner home.

**Acceptance Scenarios**:

1. **Given** a customer VPS has the latest host bundle installed, **When** systemd starts Matrix services, **Then** `matrix-symphony.service` runs as `matrix`, receives `MATRIX_HOME=/home/matrix/home`, and binds its HTTP API to `127.0.0.1`.
2. **Given** the gateway restarts while Symphony is running, **When** the gateway comes back, **Then** it can read the current Symphony state from the local Elixir service without reconstructing a separate TypeScript run table.
3. **Given** the Elixir service fails to start, **When** the app requests Symphony state, **Then** the gateway returns a generic unavailable response and logs the service failure server-side.
4. **Given** Symphony creates a workspace for a ticket, **When** the workspace path is inspected, **Then** it lives under the configured owner-home project/worktree root and not under a temporary global path.

---

### User Story 2 - Proxy Symphony Through Matrix Gateway Control (Priority: P1)

The Matrix gateway exposes `/api/symphony/*` as the authenticated control plane for the local Elixir API. Browser apps never call the Elixir service directly, and the gateway owns auth, body limits, request validation, timeout behavior, and client-safe error mapping.

**Why this priority**: Matrix users need one authenticated API surface, and the Elixir service should not become a second browser-visible trust boundary.

**Independent Test**: With a fake loopback Symphony service, call `/api/symphony/state`, `/api/symphony/issues/:issueIdentifier`, `/api/symphony/refresh`, and stop/control routes through the gateway as authorized and unauthorized users; verify proxying, timeouts, body limits, and generic errors.

**Acceptance Scenarios**:

1. **Given** an authorized Matrix user requests Symphony state, **When** the Elixir service responds, **Then** the gateway returns the normalized state payload with no provider secrets or internal paths beyond allowed workspace/workpad paths.
2. **Given** an unauthorized user requests Symphony state or controls, **When** the request reaches the gateway, **Then** the gateway rejects it before contacting the Elixir service.
3. **Given** the Elixir service hangs or is offline, **When** the gateway proxies a request, **Then** the request times out within the configured service timeout and returns a generic unavailable response.
4. **Given** a client sends a mutating Symphony request, **When** the gateway handles it, **Then** `bodyLimit` applies before buffering and the payload is validated at the route boundary.

---

### User Story 3 - Use Matrix-Owned Linear Auth And Project Roots (Priority: P1)

A Matrix owner connects Linear through the existing Matrix integration path, and Symphony receives a short-lived or locally bridged credential from Matrix instead of requiring users to manually put `LINEAR_API_KEY` on the VPS. Symphony workspaces are created under Matrix-managed project roots, such as `~/projects/matrix-os/symphony-workspaces/<issue>`, and can be opened from Matrix workspace UI.

**Why this priority**: The current separate credential and workspace setup is the source of confusion; Matrix must remain the owner of integrations and project state.

**Independent Test**: Configure a Matrix Linear integration without `LINEAR_API_KEY` in the VPS environment, start Symphony, and verify issue polling/comments work through the Matrix credential bridge while workspace paths remain under the Matrix owner home.

**Acceptance Scenarios**:

1. **Given** Linear is connected in Matrix/Pipedream/platform integrations, **When** Symphony polls Linear, **Then** it uses a Matrix-provided credential bridge rather than requiring `LINEAR_API_KEY` in the shell environment.
2. **Given** no Matrix-owned Linear credential is available, **When** Symphony starts, **Then** it reports a setup-required state without exposing provider details.
3. **Given** Symphony creates or reuses a worktree, **When** the path is serialized to the UI, **Then** it is under the configured Matrix workspace root and can be opened by Matrix workspace links.
4. **Given** an issue identifier contains unexpected characters, **When** Symphony derives a workspace path, **Then** it validates and sanitizes the identifier before using it in filesystem paths.

---

### User Story 4 - Operate Codex App-Server Sessions From The Matrix App (Priority: P2)

The Matrix Symphony app is a UI shell over the Elixir service. It shows queue/running/attention/done state, active issue, Codex session ID, thread/turn count, latest lifecycle event, bounded logs, workpad URL, workspace path, and refresh/stop actions.

**Why this priority**: The Elixir implementation exposes useful Codex lifecycle state; Matrix should surface that instead of showing an ambiguous terminal-or-auth status.

**Independent Test**: Run the app against seeded Symphony state payloads and verify each status group, issue detail, session ID, turn count, workpad link, workspace link, refresh action, stop action, loading state, and unavailable state renders correctly on desktop and mobile widths.

**Acceptance Scenarios**:

1. **Given** Symphony has a running ticket, **When** the app loads, **Then** it shows the issue identifier/title, session ID, turn count, workspace path, workpad URL, latest event, and bounded logs.
2. **Given** Symphony has queued, running, needs-attention, and done items, **When** the app loads, **Then** the items are grouped into those operational states without crowding the first screen.
3. **Given** the user taps refresh or stop, **When** the gateway action succeeds, **Then** the app updates from the returned Elixir state and does not clear unrelated run details.
4. **Given** the app is used on a narrow viewport, **When** state includes long issue titles, session IDs, or paths, **Then** controls remain visible, text wraps or truncates intentionally, and no controls overlap.

---

### User Story 5 - Retire The Duplicate TypeScript Symphony Runner (Priority: P3)

Matrix removes or disables the existing in-gateway TypeScript Symphony orchestrator/run table once the Elixir service is the source of truth. Documentation and tests describe the new ownership boundary and migration behavior.

**Why this priority**: Keeping two orchestrators creates conflicting run state, credentials, logs, and operator semantics.

**Independent Test**: Search for TypeScript Symphony runner entrypoints, start the gateway with the Elixir service configured, and verify `/api/symphony/*` uses the proxy path while legacy runner state is not created or mutated.

**Acceptance Scenarios**:

1. **Given** the new Elixir service path is enabled, **When** a user starts or refreshes Symphony, **Then** no TypeScript Symphony run table or TypeScript ticket runner is used.
2. **Given** old local Symphony config files exist, **When** the gateway starts, **Then** it either ignores them safely or migrates only non-secret settings to the new service config.
3. **Given** docs mention Symphony setup, **When** users follow the docs, **Then** they configure Matrix integrations and host service controls rather than manual `LINEAR_API_KEY` runner setup.

### Edge Cases

- The Elixir service is installed but not running.
- The Elixir service is running but bound to the wrong host or port.
- The gateway receives a slow or malformed loopback response.
- Matrix Linear integration exists in the platform but the VPS cannot reach the credential bridge.
- The Linear credential is revoked during an active run.
- A ticket becomes ineligible while Codex app-server is mid-turn.
- Codex app-server emits malformed JSON, exits unexpectedly, or requests unsupported dynamic tools.
- Workpad sync succeeds but Linear comment update fails, or vice versa.
- Workspace creation succeeds but Codex session startup fails.
- A service restart happens while a worktree lease or Codex turn is active.
- A user-controlled issue identifier, repo slug, branch name, or workpad path attempts traversal.
- Log payloads exceed browser-safe display limits.
- Mobile viewport receives long paths, issue titles, or session identifiers.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST package an adapted Elixir Symphony runtime in the host bundle with its upstream Apache-2.0 license/notice preserved.
- **FR-002**: Matrix MUST install a `matrix-symphony.service` systemd unit for customer VPS runtime, running as `matrix`, using `MATRIX_HOME=/home/matrix/home`, and binding its HTTP API to loopback only.
- **FR-003**: Matrix MUST expose `/api/symphony/*` through the gateway as the browser-facing API and MUST NOT require browser clients to call the Elixir service directly.
- **FR-004**: The gateway MUST enforce Matrix auth/authorization before proxying any Symphony state or control request.
- **FR-005**: Every mutating `/api/symphony/*` route MUST use Hono `bodyLimit` before body parsing and validate payloads with Zod at the route boundary.
- **FR-006**: Every gateway fetch to the Elixir service MUST use `AbortSignal.timeout()` and map loopback/network/internal failures to generic client-facing errors.
- **FR-007**: Gateway proxying MUST only target a configured loopback origin; it MUST NOT proxy arbitrary user-controlled URLs.
- **FR-008**: Matrix MUST normalize Elixir state into a stable browser contract that includes service status, issue identifier/title, run status, session ID, thread ID, turn count, latest event, bounded logs, workspace path, workpad URL, and allowed actions.
- **FR-009**: The Matrix Symphony app MUST show queue, running, needs-attention, and done/handoff groups from Elixir state.
- **FR-010**: The Matrix Symphony app MUST render active issue details, Codex app-server session ID, turn count, bounded logs, workpad URL, workspace path, refresh, and stop actions.
- **FR-011**: The Matrix Symphony app MUST remain usable on mobile widths without overlapping controls or hiding essential links/actions.
- **FR-012**: Symphony MUST use `codex app-server` for agent execution, not terminal-session spawning as the primary run mechanism.
- **FR-013**: Symphony MUST serve or proxy Codex lifecycle state from Elixir as the source of truth for active runs.
- **FR-014**: Symphony MUST create/reuse workspaces under a Matrix-managed owner-home root, with safe path validation for all issue-derived segments.
- **FR-015**: Symphony MUST prefer Matrix-owned Linear credentials from platform/Pipedream/integration state over requiring `LINEAR_API_KEY` in a user VPS environment.
- **FR-016**: If Matrix-owned Linear credentials are unavailable, Symphony MUST report setup-required status without exposing provider tokens or raw provider errors.
- **FR-017**: Symphony MUST preserve workpad and Linear comment functionality through Matrix-approved dynamic tools or credential bridging.
- **FR-018**: Matrix MUST retire, disable, or bypass the duplicate TypeScript Symphony orchestrator/run table once the Elixir service is enabled.
- **FR-019**: Runtime config and non-secret state MUST live under owner-controlled Matrix home files; provider credentials MUST remain in Matrix secret/integration storage.
- **FR-020**: In-memory state for logs, recent events, runs, and subscribers MUST be capped with explicit eviction or retention rules.
- **FR-021**: Shutdown of the Elixir service MUST drain or mark active runs consistently so gateway/app state does not show stale progress as healthy.
- **FR-022**: Tests MUST cover service packaging, systemd unit rendering, gateway proxy auth, timeout/error mapping, credential bridge behavior, path validation, app rendering, and mobile layout.
- **FR-023**: Public docs MUST describe the Matrix-owned Symphony service, gateway proxy, Linear setup, workspace root convention, troubleshooting, and migration away from legacy TypeScript runner behavior.

### Security Architecture

#### Auth Matrix

| Route/Surface | Caller | Auth Method | Public? | Notes |
| --- | --- | --- | --- | --- |
| `matrix-symphony.service` loopback HTTP | Local gateway only | Loopback binding plus optional internal token | No | Must bind to `127.0.0.1`; browser never calls it directly. |
| `GET /api/symphony/state` | Matrix app/user | Existing Matrix gateway auth | No | Returns normalized, secret-free state. |
| `GET /api/symphony/issues/:issueIdentifier` | Matrix app/user | Existing Matrix gateway auth | No | Validates identifier and maps not-found generically. |
| `POST /api/symphony/refresh` | Matrix app/user | Existing Matrix gateway auth + bodyLimit | No | Proxies refresh with timeout. |
| `POST /api/symphony/runs/:runId/stop` | Matrix app/user | Existing Matrix gateway auth + bodyLimit | No | Stops through Elixir API when supported; returns normalized state. |
| Matrix Linear credential bridge | Elixir service/gateway | Matrix internal service auth | No | Must not expose raw tokens in browser responses or local logs. |
| Workpad/workspace links | Matrix app/user | Existing Matrix file/workspace auth | No | Only exposes owner-home paths that Matrix can open. |

#### Input Validation

- Issue identifiers, run IDs, workspace roots, workpad paths, repo slugs, action payloads, and query params MUST be validated at the gateway boundary.
- Issue-derived path segments MUST use a strict safe-slug mapping and resolved paths MUST stay under the configured workspace root.
- Gateway proxy routes MUST construct upstream paths from allowlisted route patterns, not from raw client URLs.
- Elixir dynamic tool payloads for Linear/workpad operations MUST use bounded schemas and generic error mapping.

#### Error Policy

- Browser responses MUST never include raw Elixir exceptions, provider errors, filesystem paths outside allowed owner-home display paths, Postgres errors, stack traces, tokens, or raw Codex stderr.
- Gateway logs and Elixir logs MAY include internal details required for debugging, but secrets must be redacted.
- Service-unavailable, timeout, credential-missing, and validation-failed states MUST be distinguishable to the UI using coarse codes.

#### Resource Management

- Gateway proxy timeout default: 10 seconds for state/control APIs.
- Elixir Codex app-server line length and stream logs MUST be bounded.
- Browser-visible logs MUST be capped by count and byte length.
- Run/event registries MUST define max active/completed records and eviction semantics.
- Workspace roots MUST have cleanup/recovery policy for abandoned failed workspaces; active user data must not be deleted automatically.
- Service shutdown MUST stop accepting new dispatch, mark in-flight state consistently, and close Codex app-server ports/processes.

### Key Entities *(include if feature involves data)*

- **Symphony Service Instance**: Per-VPS Elixir runtime process with loopback API, service status, version, owner home, workspace root, and configuration.
- **Gateway Proxy Contract**: Stable Matrix API shape for normalized Symphony state and actions.
- **Credential Bridge**: Matrix-owned path for giving the local service the minimum Linear capability without exposing provider tokens to browser or shell setup.
- **Symphony Issue Run**: A ticket lifecycle owned by the Elixir service, including status, issue metadata, workspace, workpad, session ID, thread ID, turn count, latest event, timestamps, and allowed actions.
- **Codex App-Server Session**: Elixir-managed Codex lifecycle with thread/turn/session IDs and bounded lifecycle events.
- **Matrix Symphony App View Model**: Browser-safe projection rendered by the Matrix app.
- **Legacy TypeScript Symphony Runner**: Existing in-gateway orchestration path to be bypassed or removed after the Elixir runtime is active.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh customer VPS host bundle starts `matrix-symphony.service` as `matrix` with `MATRIX_HOME=/home/matrix/home`, loopback API binding, and a Matrix-managed workspace root.
- **SC-002**: Authorized Matrix app calls to `/api/symphony/state` return Elixir-backed state within 10 seconds and contain zero provider secrets or raw internal errors.
- **SC-003**: Unauthorized calls to all `/api/symphony/*` routes are rejected before the gateway contacts the Elixir service.
- **SC-004**: A Linear-connected Matrix owner can run an eligible ticket without manually setting `LINEAR_API_KEY` on the VPS.
- **SC-005**: A running ticket exposes Codex app-server `session_id`, `thread_id`, turn count, latest lifecycle event, bounded logs, workpad URL, and workspace path in the Matrix app.
- **SC-006**: Mobile and desktop app views show refresh/stop/open-workspace/open-workpad actions without overlap for long issue titles and paths.
- **SC-007**: With the Elixir service enabled, no TypeScript Symphony run table entries are created or mutated by normal `/api/symphony/*` use.
- **SC-008**: CI passes `bun run typecheck`, `bun run check:patterns`, focused gateway/app tests, host-bundle/systemd tests, and Elixir runtime tests or a documented CI-equivalent fallback.
