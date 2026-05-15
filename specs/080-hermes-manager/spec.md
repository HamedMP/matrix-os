# Feature Specification: Hermes Manager

**Feature Branch**: `080-hermes-manager`  
**Created**: 2026-05-15  
**Status**: Draft  
**Input**: User description: "Build a custom Matrix OS app for messaging Hermes and configuring it. It should use Hermes IPC tools and CLI, make Hermes the main agent/orchestrator in Matrix, and provide easy onboarding for setup, channels, AI model, and proper use."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Onboard Hermes In Matrix (Priority: P1)

A Matrix owner opens Hermes Manager for the first time, sees whether Hermes is installed and reachable, chooses or creates an owner-scoped Hermes home, configures the minimum identity/model/channel settings, and reaches a ready state without copying shell commands or exposing secrets in the browser.

**Why this priority**: Hermes cannot become the primary Matrix orchestrator unless a non-technical owner can install, configure, and verify it safely from inside Matrix OS.

**Independent Test**: Start from a Matrix instance with no Hermes configuration, complete the setup flow with a test model provider and a test channel, reload the app, and verify Hermes reports ready while browser-visible state contains no provider tokens or gateway secrets.

**Acceptance Scenarios**:

1. **Given** no Hermes installation is configured, **When** the owner opens Hermes Manager, **Then** the app shows an ordered setup checklist with installation, owner home, model provider, channel, and readiness steps.
2. **Given** Hermes is installed but not reachable, **When** the readiness check runs, **Then** the app shows a generic recovery action and records detailed diagnostics server-side.
3. **Given** the owner provides model or channel credentials, **When** they save setup, **Then** credentials are stored server-side only and the client receives only redacted status.
4. **Given** setup is complete, **When** the owner reloads Hermes Manager, **Then** the app resumes at the operational dashboard with Hermes ready, default profile selected, and no duplicate setup prompts.

---

### User Story 2 - Connect Messaging Channels (Priority: P1)

A Matrix owner connects Telegram and WhatsApp first, verifies pairing or bot reachability, chooses allowed senders/home channel behavior, and can enable or disable each channel without editing config files manually.

**Why this priority**: Hermes is intended to be the main Matrix messaging orchestrator, and channel setup is the highest-friction part of making it useful.

**Independent Test**: With Hermes installed, connect a Telegram bot token and a WhatsApp pairing session through the app, verify both channels reach a healthy state, then disable and re-enable each channel without losing saved non-secret preferences.

**Acceptance Scenarios**:

1. **Given** Telegram is disconnected, **When** the owner enters a valid bot token and allowed sender policy, **Then** Hermes Manager verifies the bot, stores the secret server-side, and marks Telegram connected.
2. **Given** WhatsApp is disconnected, **When** the owner starts pairing, **Then** Hermes Manager shows the pairing state, QR/code instructions when available, timeout behavior, and final connected/failed status.
3. **Given** a channel is connected, **When** the owner disables it, **Then** Hermes stops accepting new messages from that channel while retaining safe configuration for later re-enable.
4. **Given** a channel check fails, **When** the app displays the result, **Then** it shows a generic actionable message and does not reveal upstream tokens, raw provider errors, filesystem paths, or internal command output.

---

### User Story 3 - Message Hermes From The App (Priority: P1)

An authorized Matrix user opens Hermes Manager, starts or resumes a Hermes conversation, sends prompts, watches streamed responses and tool activity, and handles approval requests in a Matrix-native interface.

**Why this priority**: The app must be more than a settings page; it must be the primary way to work with Hermes inside Matrix.

**Independent Test**: Start a Hermes session from the app, send a prompt, observe streamed text/tool events, respond to an approval request, close/reopen the app, and verify the session resumes with bounded history and correct state.

**Acceptance Scenarios**:

1. **Given** Hermes is ready, **When** a user sends a prompt from Hermes Manager, **Then** Hermes starts or resumes a session and streams assistant output into the conversation view.
2. **Given** Hermes emits tool calls, tool results, or progress events, **When** the session is active, **Then** the app renders those events in chronological order with bounded retained history.
3. **Given** Hermes requests approval, **When** the user approves or denies from the app, **Then** the decision is delivered once and the session continues or stops according to the decision.
4. **Given** the gateway restarts during a session, **When** the user reopens Hermes Manager, **Then** the app reconciles the persisted session state and marks stale live streams recoverable.

---

### User Story 4 - Operate Hermes As Matrix Orchestrator (Priority: P2)

A Matrix owner manages Hermes profiles, model routing, skills/toolsets, gateway lifecycle, updates, and health from a compact operator dashboard without needing the upstream Hermes dashboard for everyday work.

**Why this priority**: Hermes will be the main agent/orchestrator, so Matrix needs an operational surface for confidence, maintenance, and safe changes.

**Independent Test**: Seed profiles, providers, skills, toolsets, and gateway statuses, then verify the owner can change the default model/profile, inspect enabled tools, restart the gateway, and run health checks without raw shell access.

**Acceptance Scenarios**:

1. **Given** multiple Hermes model/provider options exist, **When** the owner changes the default model, **Then** Hermes validates and applies the change and the app shows the active model after reload.
2. **Given** skills and toolsets are discovered, **When** the owner views the capabilities panel, **Then** the app shows enabled/disabled capability groups and clear setup gaps without exposing raw config files by default.
3. **Given** Hermes gateway is unhealthy, **When** the owner restarts it, **Then** the app records the operator event, starts a bounded restart action, and updates health after completion.
4. **Given** a Hermes update is available, **When** the owner runs update from Matrix, **Then** the app shows progress and final status while preserving owner config and secrets.

---

### User Story 5 - Audit, Recover, And Learn Proper Use (Priority: P3)

A Matrix owner can inspect safe audit events, export non-secret configuration, recover stale sessions or channel state, and access concise guidance for using Hermes as the Matrix orchestrator.

**Why this priority**: Once Hermes is always-on, supportability and safe onboarding docs prevent confusion and reduce manual repair.

**Independent Test**: Trigger setup changes, channel failures, stale sessions, and operator actions, then verify audit/recovery views explain what happened and recover normal operation without leaking sensitive details.

**Acceptance Scenarios**:

1. **Given** security-sensitive settings change, **When** the owner opens audit history, **Then** Hermes Manager shows who changed what category, when, and the redacted result.
2. **Given** a session or channel has stale live-resource references, **When** the recovery view loads, **Then** the app marks the issue recoverable and offers a bounded repair action.
3. **Given** the owner exports Hermes Manager configuration, **When** export completes, **Then** the export excludes secrets and includes enough non-secret state to understand setup.
4. **Given** onboarding is incomplete or a capability is disabled, **When** the owner opens help for that area, **Then** the app gives short Matrix-specific guidance rather than upstream CLI-only instructions.

### Edge Cases

- Hermes repository or CLI is missing, outdated, or present at a non-default path.
- Hermes IPC or WebSocket endpoint is unreachable while the CLI still exists locally.
- A model provider credential is saved but the provider is revoked, unavailable, or returns an invalid model list.
- Telegram or WhatsApp setup is interrupted during credential save, pairing, gateway restart, or status polling.
- Two browser tabs attempt the same setup, channel connect, approval decision, restart, or update action at the same time.
- Hermes emits high-volume stream/tool events faster than the browser can render.
- The gateway restarts while setup, pairing, approval, update, or session streaming is in progress.
- A stale Hermes session ID, tool approval ID, channel ID, profile ID, or file path is read from persisted state.
- A Matrix user without operator permission attempts to view config, send prompts, approve tools, or control gateway actions.
- Hermes returns raw errors that include provider names, secrets, filesystem paths, stack traces, or command output.
- Owner home disk is full, config writes fail, or a partial config file exists after a crash.
- Upstream Hermes changes available IPC, CLI, or dashboard API fields between versions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Hermes Manager MUST provide a first-run setup flow that detects Hermes installation/reachability, configures owner-scoped Hermes home, validates minimum readiness, and resumes correctly after reload.
- **FR-002**: Hermes Manager MUST store Hermes identity, non-secret preferences, enabled capabilities, channel state, and recoverable session references in owner-controlled Matrix state.
- **FR-003**: Hermes Manager MUST store model provider credentials, messaging credentials, OAuth tokens, pairing secrets, gateway tokens, and CLI environment secrets server-side only.
- **FR-004**: Browser-visible setup, config, status, and export responses MUST redact secrets and MUST NOT include raw provider errors, command output, filesystem paths, stack traces, or internal environment values.
- **FR-005**: Hermes Manager MUST allow only the Matrix owner and explicitly authorized operators to configure Hermes, manage channels, send prompts, respond to approvals, restart gateway processes, update Hermes, or view audit/recovery details.
- **FR-006**: Hermes Manager MUST expose a readiness model with at least these states: missing, installed, configuring, degraded, ready, updating, and needs attention.
- **FR-007**: Hermes Manager MUST support Telegram and WhatsApp as the first channel setup targets, including connect, verify, enable, disable, status, and recovery actions.
- **FR-008**: Hermes Manager SHOULD present Discord, Slack, Matrix protocol, and future Hermes-supported channels as discoverable locked or later-stage capabilities when Hermes reports them, without blocking the Telegram/WhatsApp-first flow.
- **FR-009**: Hermes Manager MUST validate all setup fields, channel identifiers, profile IDs, model IDs, session IDs, approval IDs, action types, file paths, and query params at the route or IPC boundary.
- **FR-010**: Hermes Manager MUST perform all mutating app requests with request body limits before body buffering.
- **FR-011**: Hermes Manager MUST use atomic writes for file-backed owner config and MUST avoid check-then-write races for exclusive file creation.
- **FR-012**: Hermes Manager MUST make every external provider or network call with an explicit timeout and generic client-facing error policy.
- **FR-013**: Hermes Manager MUST resolve required Hermes IPC, CLI, process, credential-store, and session dependencies at registration/startup time, not lazily at tool-call time.
- **FR-014**: Hermes Manager MUST interact with Hermes through its supported CLI, local API, IPC, or WebSocket surfaces rather than duplicating Hermes internals.
- **FR-015**: Hermes Manager MUST provide a Matrix-native conversation interface that can create sessions, resume sessions, submit prompts, stream assistant responses, show tool activity, and deliver approval decisions.
- **FR-016**: Hermes Manager MUST cap in-memory session events, stream buffers, status history, audit summaries, subscribers, and pairing/update progress logs with clear eviction or retention behavior.
- **FR-017**: Hermes Manager MUST reconcile stale live-resource references on main read paths so sessions, channel pairings, and gateway status do not appear healthy only because old references exist.
- **FR-018**: Hermes Manager MUST isolate WebSocket or event-stream subscriber failures, evict failed senders, and drain subscribers on gateway shutdown.
- **FR-019**: Hermes Manager MUST prevent duplicate concurrent setup, pairing, approval, restart, update, and session-send actions for the same logical target.
- **FR-020**: Hermes Manager MUST record redacted operator events for credential changes, model changes, channel connect/disable, approvals, gateway restart, Hermes update, and recovery actions.
- **FR-021**: Hermes Manager MUST provide owner-safe configuration export and recovery views that exclude secrets but include actionable state, health, and next-step guidance.
- **FR-022**: Hermes Manager MUST include public user documentation for onboarding and everyday Hermes use, plus developer documentation for runtime wiring and failure recovery.
- **FR-023**: Hermes Manager MUST include automated tests for P1 setup, channel setup, session messaging, approval delivery, secret isolation, auth refusal, stale-resource reconciliation, and duplicate-action prevention.

### Key Entities *(include if feature involves data)*

- **Hermes Installation**: Owner-scoped record of Hermes location, version, reachability, selected home, readiness state, and gateway status.
- **Hermes Setup Step**: Ordered onboarding milestone with status, required action, redacted result, and recovery hint.
- **Model Provider Connection**: Redacted provider/model state, validation status, default model choice, and server-side credential reference.
- **Messaging Channel**: Telegram, WhatsApp, or future channel configuration with enabled state, connection health, allowed sender policy, home channel behavior, and redacted setup state.
- **Hermes Session**: Conversation/session reference with owner/operator, profile/model, status, bounded event summary, live stream state, and recoverability status.
- **Approval Prompt**: Pending or resolved tool/action approval with target session, redacted description, requested action, decision, actor, and timestamp.
- **Hermes Capability**: Skill, toolset, profile, or gateway capability reported by Hermes with enabled state, setup gaps, and operator-facing description.
- **Operator Event**: Redacted audit entry for security-sensitive or operational changes, including actor, category, timestamp, target, and generic outcome.

### Security & Integration Requirements

| Surface | Actor | Auth source | Public? | Secret exposure policy |
| --- | --- | --- | --- | --- |
| Setup/status/config read | Owner, authorized operator | Matrix request principal | No | Redacted only |
| Credential save/reveal/test | Owner only by default | Matrix request principal plus owner role | No | Never returned to browser except explicit masked reveal metadata |
| Channel connect/disable/recover | Owner, authorized operator | Matrix request principal | No | Redacted only |
| Session prompt/stream/approval | Owner, authorized operator | Matrix request principal and session ownership | No | Prompt/session data scoped to owner |
| Gateway restart/update | Owner only by default | Matrix request principal plus owner role | No | Generic progress/status only |
| Audit/export/recovery | Owner, authorized operator | Matrix request principal | No | Secret-free export; redacted audit |

- Hermes Manager MUST keep the core usable headlessly through Hermes CLI/IPC/API surfaces; the app is one renderer/operator shell.
- Hermes Manager MUST use startup wiring checks for Hermes bridge dependencies and include an integration test that exercises app route -> Hermes bridge -> mocked Hermes IPC/CLI -> app response.
- Hermes Manager MUST treat Hermes upstream API drift as a recoverable needs-attention state when safe, not as a raw crash exposed to the user.
- Hermes Manager MUST define bounded timeouts for Hermes process actions, channel verification, pairing polling, updates, and model-provider checks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Matrix owner can complete clean Hermes onboarding through the app in under 7 minutes with a reachable Hermes install, one model provider, and one messaging channel.
- **SC-002**: Browser-visible Hermes Manager responses and exports contain zero provider tokens, gateway secrets, raw upstream errors, stack traces, or filesystem paths across setup, channel, session, health, and recovery flows.
- **SC-003**: Telegram and WhatsApp setup flows both reach connected, disabled, re-enabled, and recovery states in automated or mocked integration tests.
- **SC-004**: A Hermes session started in the app can stream at least 100 assistant/tool events without unbounded memory growth or UI lockup.
- **SC-005**: Duplicate approval, pairing, restart, update, or prompt-send actions for the same target are rejected or safely deduplicated in tests.
- **SC-006**: After a gateway restart, Hermes Manager reconstructs installation, channel, and session state and marks stale live resources recoverable within one app refresh.
- **SC-007**: Unauthorized Matrix users receive no Hermes config, session, channel, audit, secret, or operational details from app endpoints.
- **SC-008**: The default Hermes Manager experience does not require shell command copying, raw config editing, or visiting the upstream Hermes dashboard for P1 setup and messaging.
