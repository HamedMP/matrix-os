# Feature Specification: Shell Connection Resilience

**Feature Branch**: `099-shell-connection-resilience`
**Created**: 2026-06-25
**Status**: Ready for Planning
**Input**: User description: "Make the shell browser disconnect banner and backend connection more resilient and stable. This should almost never happen; if it happens it should not affect the user experience. Cover gateway shell, auth, and browser network behavior."

## Scope Boundary

This spec owns browser-shell live connection resilience: reconnect/degraded-state UX, browser live-event replay, credential refresh, queued outbound shell actions, public route health, platform/runtime route classification, and shell-wide connection diagnostics.

Related spec `specs/098-terminal-session-reliability/` owns terminal runtime/session reliability: terminal process liveness, terminal session truth, saved shell metadata, terminal pane references, terminal WebSocket reattach, terminal close/delete behavior, and terminal-specific diagnostics.

When implementation touches both specs, use this boundary:

- If the user-visible problem is a disruptive browser reconnect banner, missed live events, credential refresh churn, public route failure, queued action delivery, or shell-wide connection health, plan it under this spec.
- If the user-visible problem is a terminal process/session appearing stuck, lost, duplicated, killed, detached, or not reattached, plan it under `098-terminal-session-reliability`.
- Shared connection contracts may serve terminal flows, but terminal liveness, session reconciliation, and stale terminal metadata remain acceptance criteria for `098`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Short Connection Blips Stay Invisible (Priority: P1)

As a Matrix OS browser-shell user, I can keep typing, reading, launching apps, and watching agent output during brief network or backend transport interruptions without seeing disruptive offline warnings or losing confidence in the workspace.

**Why this priority**: The browser shell is the primary Matrix OS experience. Brief transport churn should not make the cloud computer feel unstable or unusable.

**Independent Test**: Can be fully tested by opening an active shell session, forcing several short transport interruptions under five seconds, and verifying the user can continue interacting without a blocking banner, disabled input, or lost visible state.

**Acceptance Scenarios**:

1. **Given** a user is typing a message in the browser shell, **When** the live connection briefly drops and recovers within five seconds, **Then** the typed text remains editable, the send action remains available through a queued send state, and no disruptive banner appears.
2. **Given** an agent response is streaming, **When** the live connection briefly reconnects, **Then** the visible response resumes without duplicate text, missing text, or a full-screen/interruption-style warning.
3. **Given** the user has apps and windows open, **When** the live connection reconnects, **Then** open windows, app contents, scroll positions, and shell controls remain stable.

---

### User Story 2 - Longer Interruptions Preserve Work and Explain Impact (Priority: P1)

As a Matrix OS browser-shell user, if the live connection cannot recover quickly, I see a calm, accurate status that preserves my workspace and tells me only what is affected.

**Why this priority**: Real outages and deploy restarts will happen. The shell must make them feel controlled, recoverable, and narrowly scoped.

**Independent Test**: Can be fully tested by keeping the live connection unavailable for longer than the short-blip threshold while the gateway health varies between reachable and unreachable, and verifying that the status copy, enabled controls, queued work, and recovery behavior match the actual impact.

**Acceptance Scenarios**:

1. **Given** the gateway is reachable but the live session connection is closed, **When** the interruption lasts beyond the quiet recovery window, **Then** the user sees a non-blocking status that says live updates are reconnecting while the workspace remains usable.
2. **Given** the gateway is not reachable, **When** the interruption lasts beyond the quiet recovery window, **Then** the user sees a non-blocking degraded-state notice that indicates Matrix is preserving the workspace and retrying.
3. **Given** the user sends a message while reconnecting, **When** the connection returns, **Then** the message is delivered exactly once or the user receives a clear retryable failure without losing the draft.

---

### User Story 3 - Active Agent Runs Resume Across Reconnects (Priority: P1)

As a Matrix OS user waiting on an agent, I can close a laptop, switch networks, or ride through a deploy without losing the run transcript, approval prompts, tool status, or final result.

**Why this priority**: Agent work is the kernel experience. A transport reconnect must not break trust in long-running agent tasks.

**Independent Test**: Can be fully tested by starting a long-running agent task, interrupting the browser connection at several points, reconnecting, and verifying the reconstructed transcript and run state match a continuously connected reference run.

**Acceptance Scenarios**:

1. **Given** an agent run is streaming, **When** the browser reconnects after missing several live events, **Then** all missed user-visible events are replayed in order without duplication.
2. **Given** an approval prompt is active during a reconnect, **When** the user returns, **Then** the prompt is still visible with the correct timeout state and any response is applied at most once.
3. **Given** the agent run completed while the browser was disconnected, **When** the browser reconnects, **Then** the final state, output, and any generated app/file change notifications are visible without requiring a page refresh.

---

### User Story 4 - Auth and Routing Failures Recover Without User Intervention (Priority: P2)

As a signed-in user, transient authentication-token, session, or public-edge routing problems recover automatically without sending me into a visible reconnect loop.

**Why this priority**: The user cannot distinguish auth-token refresh, public WebSocket upgrade, and gateway routing failures. Matrix OS should repair these paths internally and show impact only when work is actually blocked.

**Independent Test**: Can be fully tested by causing token fetch failures, expired connection credentials, and public routing failures, then confirming the shell retries the correct layer and recovers or reports a precise degraded state.

**Acceptance Scenarios**:

1. **Given** connection credentials cannot be refreshed immediately, **When** the shell needs to connect, **Then** it retries credential refresh instead of entering a guaranteed-failing connection loop.
2. **Given** connection credentials expire while the page remains open, **When** the shell reconnects later, **Then** fresh credentials are acquired before attempting the live connection.
3. **Given** the public route fails while the user runtime is healthy, **When** monitoring and client diagnostics classify the failure, **Then** operators can distinguish public-edge failure from user-runtime failure.

---

### User Story 5 - Operators Can Prove Connection Health (Priority: P2)

As an operator, I can see whether shell connection failures are caused by browser network conditions, credential refresh, public edge routing, platform routing, user runtime health, deploy restarts, or gateway session state.

**Why this priority**: Intermittent connection symptoms are otherwise expensive to diagnose and easy to misclassify.

**Independent Test**: Can be fully tested by inducing each failure class and verifying that health checks, telemetry, and logs identify the layer without exposing secrets or user content.

**Acceptance Scenarios**:

1. **Given** many users experience shell reconnects, **When** an operator reviews health telemetry, **Then** the operator can identify whether the public edge, platform router, user runtime, or client network is the likely layer.
2. **Given** one user reports a reconnect banner, **When** support reviews metadata-only diagnostics, **Then** support can see recent connection attempts, reconnect duration, close classification, and runtime reachability without viewing private user content.

### Edge Cases

- Browser goes offline and returns on a different network while a message draft is being edited.
- Browser tab is backgrounded or suspended long enough for timers to be throttled.
- Browser wakes from laptop sleep after the live connection was closed by an intermediary.
- Live connection drops during an agent approval prompt.
- Live connection drops after a message was sent but before the browser received acknowledgment.
- Runtime deploy or gateway restart closes existing connections while active work is running.
- Public route is unhealthy while the user runtime reports healthy locally.
- Credential refresh fails temporarily because the signed-in session is still being refreshed.
- Multiple tabs for the same user are open and reconnect at the same time.
- Replayed events arrive near the same time as new live events.
- Reconnection succeeds after queued outbound work has expired.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The shell MUST keep primary workspace interactions available during short live-connection interruptions unless a specific action cannot be safely completed.
- **FR-002**: The shell MUST preserve in-progress user input, attachments, selected session, open windows, visible app state, and active task context across live-connection reconnects.
- **FR-003**: The shell MUST queue user-initiated outbound actions during short interruptions when those actions can be delivered safely after reconnect.
- **FR-004**: Queued outbound actions MUST be delivered at most once, or fail with a clear retryable state that keeps the user's original input available.
- **FR-005**: The shell MUST avoid disruptive connection banners for short interruptions that recover before the user is meaningfully blocked.
- **FR-006**: The shell MUST show a non-blocking degraded-state notice when live reconnection remains unavailable beyond the quiet recovery window.
- **FR-007**: Degraded-state copy MUST distinguish, in user-facing terms, between "workspace reachable but live updates reconnecting" and "workspace temporarily unreachable."
- **FR-008**: Active agent runs MUST be resumable after browser reconnection, including missed visible text, tool status, completion state, and approval prompts.
- **FR-009**: Replayed live events MUST preserve order and MUST NOT duplicate already rendered events.
- **FR-010**: The system MUST track acknowledgment state for user-submitted messages and other user-visible live actions so the browser can distinguish accepted, pending, retried, and failed actions.
- **FR-011**: Connection credential refresh MUST be retried as its own recoverable step; the shell MUST NOT repeatedly attempt a live connection that is known to lack valid credentials.
- **FR-012**: Connection credentials MUST refresh before their normal expiration while the shell remains open, so routine expiration does not cause visible reconnect churn.
- **FR-013**: If signed-in identity or authorization has genuinely expired, the shell MUST preserve local work and guide the user to re-authenticate without losing current context.
- **FR-014**: The platform and runtime health model MUST classify connection failures into browser/network, credential, public-route, platform-route, runtime-reachable, runtime-unreachable, restart/deploy, and unknown categories.
- **FR-015**: Operators MUST have metadata-only diagnostics for live shell connection attempts, reconnect duration, close classification, route layer, credential refresh result, runtime reachability, and recovery outcome.
- **FR-016**: Diagnostics MUST NOT include user message content, terminal output, raw credentials, private file paths, or provider raw error messages.
- **FR-017**: The system MUST provide an automated health check that verifies the public live-connection route separately from general runtime health.
- **FR-018**: Runtime deploys and restarts MUST produce a graceful live-connection transition that preserves user state and resumes active work after services return.
- **FR-019**: The shell MUST handle browser sleep, background-tab timer throttling, network changes, and multi-tab reconnect storms without treating the first missed heartbeat as user-visible failure.
- **FR-020**: The feature MUST provide regression coverage for short network blips, longer outages, credential refresh failure, public-route failure, active run replay, queued outbound actions, and deploy/restart recovery.

### One-by-One Work Order

1. **Slice 1: Suppress short disruptive reconnect states** - Covers User Story 1 and FR-001 through FR-006. Deliver failing browser-shell tests for brief live-connection interruptions, then keep local work usable and avoid disruptive banners during the quiet recovery window.
2. **Slice 2: Preserve outbound actions and acknowledgments** - Covers User Story 2 and FR-003, FR-004, and FR-010. Deliver queued-action and at-most-once delivery tests for messages, approvals, aborts, and other user-visible live actions.
3. **Slice 3: Replay active agent runs after reconnect** - Covers User Story 3 and FR-008 through FR-009. Deliver run-resume cursor and replay ordering tests for missed text, tool status, approval prompts, completion, and generated change notifications.
4. **Slice 4: Repair auth and routing recovery** - Covers User Story 4 and FR-011 through FR-014, FR-017, and FR-019. Deliver credential-refresh and route-classification tests that prevent guaranteed-failing reconnect loops.
5. **Slice 5: Add metadata-only operator diagnostics** - Covers User Story 5 and FR-015 through FR-016. Deliver diagnostics that classify browser/network, credential, public-route, platform-route, runtime, deploy/restart, and unknown failures without exposing private content.
6. **Slice 6: Prove deploy/restart recovery and harden resource cleanup** - Covers FR-018, FR-020, failure modes, and resource-management requirements. Deliver controlled restart/deploy validation plus cleanup tests for timers, subscribers, replay buffers, and diagnostic windows.

### Planning Readiness Review

- **MVP slice**: Slice 1 is the correct first task group because it directly targets the disruptive browser disconnect banner and keeps scope away from deeper replay infrastructure.
- **Implementation shape**: Plan each slice as an independently reviewable PR. Do not combine user-visible reconnect UX with operator diagnostics unless a shared contract is required.
- **TDD requirement**: Every slice must start with failing tests. Browser-shell changes need regression tests that cover the no-banner/quiet-window behavior before implementation.
- **Frontend evidence**: Any slice that changes connection banners, degraded-state copy, disabled/enabled controls, or queued-action indicators needs screenshot or screen-recording evidence.
- **Public docs**: Implementation planning must include a docs update if user-visible reconnect/degraded-state behavior or operator diagnostic workflow changes.
- **Spec Kit pointer**: `.specify/feature.json` is intentionally not part of this PR's durable diff. For local planning, point Spec Kit at `specs/099-shell-connection-resilience` before running plan/tasks commands.

### Key Entities *(include if feature involves data)*

- **Live Connection Session**: A browser shell's current live update channel, including connection state, last confirmed event, credential status, reconnect attempts, and visible degradation state.
- **Shell Event**: A user-visible or state-changing event delivered from Matrix OS to the browser shell, such as agent text, tool status, task status, app/file change, approval prompt, session switch, or completion.
- **Outbound Action**: A user-initiated action that may be sent while the live connection is unavailable, including chat messages, approvals, aborts, and session-control actions.
- **Delivery Acknowledgment**: The acceptance, rejection, or timeout state for an outbound action, used to avoid duplicates and preserve user drafts.
- **Run Resume Cursor**: The user's last confirmed point in a live event stream, used to replay missed events after reconnect.
- **Connection Health Snapshot**: Metadata-only classification of the route and runtime state at a point in time, visible to user-facing status and operator diagnostics.

## Security Architecture

### Auth Matrix

| Surface | User / Caller | Auth Source of Truth | Required Behavior |
|---------|---------------|----------------------|-------------------|
| Browser shell live connection | Signed-in browser user | Platform-issued user session and short-lived live-connection credential | Accept only credentials for the selected user's active runtime; reject invalid, expired, or mismatched credentials with a generic failure. |
| Browser shell credential refresh | Signed-in browser user | Platform user session | Issue only scoped live-connection credentials for the user's own selected runtime; do not expose raw platform or runtime secrets. |
| Runtime live-connection upgrade | Platform router acting for signed-in user | Platform proof plus runtime verification token | Runtime accepts only platform-authenticated upgrades for the correct user/runtime. |
| Runtime reachability/status probes | Signed-in browser user or platform operator | User session for browser, operator authorization for operations | Return coarse reachability/status only; never expose internal route details or provider errors to normal users. |
| Public live-route synthetic health check | Operator-controlled monitor | Operator/service credential | Verify route availability without using or logging a real user's private content. |
| Operator diagnostics | Authorized operator/support role | Platform operator authorization | Show metadata-only connection and health classification; no message content, terminal output, credentials, private paths, or raw provider errors. |

### Input Validation Plan

- Live-connection messages MUST be schema-validated by message type before dispatch.
- Resume cursors, event identifiers, action identifiers, runtime selectors, and route selectors MUST be bounded and validated before use.
- User-controlled query parameters and path components MUST be validated at the route boundary and must not be used directly in file paths, SQL identifiers, or upstream URLs.
- Operator diagnostic filters MUST validate user/runtime identifiers, date windows, pagination limits, and failure categories.
- Browser-originated health and reconnect requests MUST be rate-limited or deduplicated so reconnect storms do not overload platform or runtime services.

### Error Response Policy

- User-facing errors MUST describe impact and recovery state, not internal service names, stack traces, provider messages, filesystem paths, database details, or credential state.
- Operator logs MAY include stable error categories, path classes, close classes, timing, and correlation IDs, but MUST NOT include raw tokens, user message content, terminal output, or private file paths.
- Health checks and reachability probes MUST return coarse classifications only.
- Credential refresh failures MUST be distinguishable in telemetry without revealing whether a specific secret or token value was wrong.

### Credential Handling

- Live-connection credentials MUST be short-lived, scoped to a user/runtime, and refreshable without page reload.
- Raw credentials MUST NOT appear in browser logs, URLs retained for diagnostics, telemetry events, operator dashboards, screenshots, or error messages.
- Public route monitors MUST use dedicated monitoring credentials or synthetic accounts, not copied user session credentials.
- Runtime verification tokens and platform signing secrets MUST remain separated; user runtimes must never receive global platform signing secrets.

## Integration Wiring

### Startup Sequence

- Browser shell initializes local connection state, credential-refresh state, outbound action queue, live-event cursor state, and user-facing degraded-state state before opening the live connection.
- Platform startup initializes credential issuance, runtime routing, public-route health classification, and metadata-only diagnostic capture before accepting browser shell traffic.
- Runtime gateway startup initializes live-connection auth, message validation, event replay state, active-run tracking, and graceful shutdown/drain behavior before accepting live shell connections.
- Operator monitoring initializes public live-route probes separately from normal runtime health probes.

### Cross-Package Communication

- Browser shell, platform router, runtime gateway, and diagnostics MUST communicate through explicit typed messages, request contracts, or dependency injection.
- Cross-package state MUST NOT be passed through global mutable process state.
- Shared event names, health categories, and connection states MUST be defined in a shared contract so client, platform, runtime, tests, and dashboards agree on meanings.

### Config Injection

- Recovery thresholds, credential lifetimes, replay retention, diagnostic retention, health probe cadence, and public-route monitor configuration MUST come from runtime configuration with safe defaults.
- Production defaults MUST favor user continuity and low-noise alerts while still surfacing sustained failures quickly.
- Local development configuration MAY relax auth for developer ergonomics only when explicitly enabled and clearly labeled.

## Failure Modes

- **Short browser network interruption**: Keep workspace usable, queue safe outbound actions, suppress disruptive warning, and replay missed live events after reconnect.
- **Long browser network interruption**: Preserve local drafts and visible state, surface a non-blocking degraded state, and resume or clearly mark pending actions when connectivity returns.
- **Credential refresh failure**: Retry credential refresh separately from live connection attempts; preserve local work; ask for re-authentication only when identity is actually expired.
- **Public route failure with healthy runtime**: Classify as public-route degradation, keep retrying, and provide operator-visible diagnostics that distinguish it from runtime failure.
- **Runtime gateway restart/deploy**: Drain or close live connections with a recoverable state, preserve event replay, and reconnect without page refresh after services return.
- **Missed or delayed heartbeat**: Avoid declaring user-visible failure on the first delayed response caused by browser sleep, background throttling, or brief CPU/network stalls.
- **Duplicate reconnect attempts from multiple tabs**: Deduplicate or rate-limit connection and credential-refresh attempts while preserving each tab's local state.
- **Replay race**: Merge replayed and newly live events using ordering and deduplication so users do not see duplicated, reordered, or missing output.
- **Queued action expiry**: Keep original user input and show a retryable state rather than silently dropping the action.
- **Diagnostics pipeline failure**: Continue user recovery behavior even if telemetry capture fails; log the diagnostic failure as metadata without blocking the shell.

## Resource Management

- In-memory event replay buffers, outbound queues, active run registries, connection registries, and diagnostic windows MUST have explicit size caps and eviction policies.
- Reconnect timers, health probes, credential-refresh timers, replay subscriptions, and degraded-state timers MUST be cleaned up on tab unload, route teardown, successful reconnect, and runtime shutdown.
- Stale subscribers and dead senders MUST be evicted even if normal close handlers do not run.
- Diagnostic data MUST have retention limits and must be metadata-only.
- Public health monitors MUST limit probe rate and isolate failures so one bad route does not cascade into user-facing service degradation.
- Graceful shutdown MUST notify or drain live subscribers before destroying dependencies used for auth, replay, or broadcasts.

## Integration Test Checkpoint

- Validate short browser-network blips with no disruptive banner and no disabled primary input.
- Validate long interruption with non-blocking degraded state and preserved local work.
- Validate credential-refresh failure and later recovery without a guaranteed-failing connection loop.
- Validate active agent run replay after missed events, including completion and approval prompt states.
- Validate public-route failure where runtime health is still reachable and diagnostics classify the mismatch.
- Validate runtime restart/deploy recovery without page refresh.
- Validate multi-tab reconnect behavior with bounded credential refresh and connection attempts.
- Run the standard repository checks required for changed areas, including unit tests, pattern checks, typecheck, React audit for browser-shell changes, and screenshot evidence for user-visible shell changes during implementation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation scenarios with live-connection interruptions shorter than five seconds, users see no disruptive reconnect banner in at least 99% of trials.
- **SC-002**: In validation scenarios with browser network changes or sleep/wake interruptions under thirty seconds, active agent transcripts resume without duplicate or missing visible events in at least 99% of trials.
- **SC-003**: In validation scenarios where a user submits while reconnecting, the user action is delivered exactly once or preserved with a clear retry state in 100% of trials.
- **SC-004**: Users can continue editing message drafts and navigating already-open workspace surfaces during live-connection interruptions in 100% of supported browsers.
- **SC-005**: Sustained live-connection failures show a non-blocking, accurately classified degraded-state notice within ten seconds of meaningful user impact.
- **SC-006**: Operator diagnostics classify induced browser-network, credential, public-route, platform-route, runtime-unreachable, and deploy/restart failures correctly in at least 95% of validation cases.
- **SC-007**: Public live-connection health checks detect a public-route failure that general runtime health would miss within two minutes.
- **SC-008**: During controlled runtime restart or deploy validation, active browser sessions return to a usable connected state without page refresh in at least 99% of trials.

## Assumptions

- The default quiet recovery window for short live-connection blips is five seconds unless testing shows a different threshold better preserves user trust.
- Users should be told about connection state only when work is delayed, at risk, or requires their action.
- Existing open app surfaces can remain useful while live shell updates reconnect, even if fresh backend data may be delayed.
- Metadata-only diagnostics are acceptable for support and operations, but private user content is not.
- This feature covers the browser shell's live gateway connection and related auth/routing/recovery behavior; terminal-specific runtime/session truth belongs to `specs/098-terminal-session-reliability/`.
