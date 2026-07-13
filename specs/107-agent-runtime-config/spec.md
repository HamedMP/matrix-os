# Feature Specification: Unified Agent Runtime Configuration

**Feature Branch**: `107-agent-runtime-config`
**Created**: 2026-07-13
**Status**: Draft
**Input**: User description: "Make it trivial for a Matrix OS owner to choose an agent runtime, provider, model, and authentication method from the web shell or desktop while preserving mobile compatibility and Chat reliability."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure the Chat Agent Once (Priority: P1)

As a Matrix OS owner, I want one Agent settings surface where I can see the active Chat model, select another supported model and effort level, and understand how it is authenticated so that my choice works consistently across Matrix OS shells.

**Why this priority**: Chat is the primary agentic OS surface. A runtime dashboard is not useful if the owner cannot confidently configure the kernel that answers there.

**Independent Test**: An owner can open Agent settings on an existing computer, see the effective model and authentication state, choose another supported model and effort, save, and observe the next Chat request use that choice without exposing a secret.

**Acceptance Scenarios**:

1. **Given** a computer using its platform-provided Chat configuration, **When** the owner opens Agent settings, **Then** the current model, effort, provider, and platform authentication state are shown without revealing credentials.
2. **Given** multiple supported models, **When** the owner chooses a model and effort and saves, **Then** subsequent Chat requests use the saved choice from every shell.
3. **Given** an owner chooses a different supported model for one message, **When** that message is sent, **Then** only that message uses the override and the saved default remains unchanged.
4. **Given** an older shell that understands only model and effort, **When** it reads or updates Agent settings, **Then** those fields continue to work without requiring a shell upgrade.

---

### User Story 2 - Authenticate With the Right Provider Flow (Priority: P1)

As a Matrix OS owner, I want each provider to explain and launch its supported authentication method—platform billing, my own key, subscription login, or a custom endpoint—so that I can connect it without guessing where credentials belong.

**Why this priority**: Provider choice is only usable when authentication is clear, secure, and accurately reflects the computer's current state.

**Independent Test**: For each advertised authentication kind, an owner can follow the presented flow, return to Agent settings, and see a coarse authenticated or action-required state while no raw credential is returned to any shell.

**Acceptance Scenarios**:

1. **Given** a platform-billed provider, **When** the owner selects it, **Then** the settings surface explains that no key entry is required and shows whether platform access is available.
2. **Given** a provider that supports owner-supplied keys, **When** the owner submits a valid key, **Then** it is validated and retained only by the trusted computer service, and the settings surface receives only a coarse success state.
3. **Given** a subscription-login provider, **When** the owner begins setup, **Then** the settings surface opens a visible terminal-backed instruction flow and can refresh the resulting login state.
4. **Given** a custom-endpoint provider, **When** the owner enters an endpoint and required credential, **Then** invalid or unsafe endpoints are rejected without disclosing upstream or network details.
5. **Given** an expired or revoked credential, **When** settings refreshes or a request fails authentication, **Then** the owner sees an action-required state and a safe recovery path without a raw provider error.

---

### User Story 3 - Choose the Optional Messaging Runtime Safely (Priority: P2)

As a Matrix OS owner, I want to choose Hermes or OpenClaw for optional messaging-agent duties, see whether each is installed and healthy, and change the selection without risking Chat.

**Why this priority**: Runtime choice expands owner control, but it is secondary to the always-available Chat kernel and must preserve the Matrix OS permission boundary.

**Independent Test**: On a computer with Hermes healthy and OpenClaw absent, an owner can view both runtime options, see OpenClaw as unavailable, attempt no destructive switch, and continue using Chat and Hermes unchanged.

**Acceptance Scenarios**:

1. **Given** Hermes is installed and healthy, **When** the owner opens Agent settings, **Then** Hermes is shown as the active messaging runtime with its health and provider/model summary.
2. **Given** OpenClaw is installed, authenticated, and healthy, **When** the owner selects it and confirms, **Then** new messaging work is routed to OpenClaw after a bounded health check while Chat remains available.
3. **Given** OpenClaw is absent or unhealthy, **When** the owner views or attempts to select it, **Then** it is shown as unavailable or action-required and the current healthy runtime remains active.
4. **Given** a runtime switch while messaging work is in progress, **When** the switch begins, **Then** new work is paused, active work is allowed a bounded drain or is cancelled safely, and no conversation is processed by both runtimes.
5. **Given** a room has not granted agent access, **When** either runtime is active, **Then** the runtime cannot read, act on, or reply to that room.

---

### User Story 4 - Configure From Any Shell (Priority: P2)

As a Matrix OS owner, I want the web shell and desktop app to present the same effective configuration and safe fallbacks so that changing devices does not produce contradictory agent state.

**Why this priority**: Matrix OS is headless and multi-shell. Configuration must belong to the computer, not a browser or desktop renderer.

**Independent Test**: An owner changes a model in the web shell, opens desktop settings, and sees the same selection; an older gateway shows a clear update-needed fallback rather than a broken settings page.

**Acceptance Scenarios**:

1. **Given** a current gateway, **When** the owner changes a supported setting in the web shell, **Then** desktop shows the same effective state on refresh.
2. **Given** an older gateway returning only the legacy fields, **When** web or desktop settings loads, **Then** model and effort remain usable and newer runtime/provider controls show a non-blocking update-needed state.
3. **Given** a settings request fails, **When** the owner retries, **Then** the last confirmed state remains visible and no unconfirmed choice is presented as active.
4. **Given** the primary Canvas shell, **When** the owner opens Settings, **Then** the Agent section is discoverable and complete without exposing other deferred settings sections.

---

### User Story 5 - Preserve Conversation Continuity on Mobile (Priority: P2)

As a Matrix OS owner using mobile Chat, I want session history and effective model information to load reliably while mobile adopts the extended configuration incrementally.

**Why this priority**: Mobile work is shipping in a separate stack and depends on additive contracts; breaking the existing surface would strand users during rollout.

**Independent Test**: A legacy-compatible mobile client can read and update model/effort, fetch a stored conversation after switching sessions, and display the computer's active model without understanding runtime/provider fields.

**Acceptance Scenarios**:

1. **Given** a stored conversation, **When** mobile switches to it, **Then** the conversation transcript is returned in stored order.
2. **Given** a connected computer, **When** mobile loads system information, **Then** the effective Chat model is present.
3. **Given** a mobile client that sends only model and effort updates, **When** it saves, **Then** runtime, provider, authentication, and unrelated configuration remain unchanged.

### Edge Cases

- The configured model is no longer present in the current provider catalog.
- A runtime disappears, crashes, or becomes unhealthy after it was selected.
- Provider authentication expires between settings refresh and the next request.
- A provider is authenticated but has no models available to the owner.
- A custom endpoint resolves to a private, loopback, link-local, or otherwise prohibited address.
- Two shells save different settings nearly simultaneously.
- A runtime switch is requested while an agent reply or automation is queued, running, or waiting for approval.
- A runtime accepts a configuration update but fails its post-change health check.
- An older gateway omits all extended fields or an older client omits them on update.
- A per-message model or effort value is malformed, unsupported, or not available for the selected provider.
- A stored conversation identifier is malformed or attempts to escape the owner conversation directory.
- Messaging is disabled entirely on a small or resource-constrained computer.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix OS MUST present one owner-visible Agent configuration containing the effective Chat selection, optional messaging-runtime selection, provider catalog, authentication states, and available model choices.
- **FR-002**: Matrix OS MUST distinguish the always-available Chat kernel from optional Hermes and OpenClaw messaging runtimes in user-facing names, state, and behavior.
- **FR-003**: Owners MUST be able to select a supported Chat model and effort as a computer-wide default.
- **FR-004**: Owners MUST be able to request a supported model and effort for one Chat message without changing the saved default.
- **FR-005**: Matrix OS MUST reject unsupported per-message model or effort choices before dispatching work.
- **FR-006**: Matrix OS MUST report the effective Chat model in computer system information.
- **FR-007**: Matrix OS MUST return a stored conversation transcript to its owner when given a valid conversation identifier.
- **FR-008**: Matrix OS MUST preserve existing model/effort read and update behavior for clients that do not understand the extended contract.
- **FR-009**: An update that omits runtime, provider, or authentication fields MUST leave those values unchanged.
- **FR-010**: Each provider entry MUST include a stable identifier, display name, effective authentication kind, bounded list of supported authentication kinds, bounded model catalog, and coarse authentication status.
- **FR-011**: Authentication status MUST distinguish at least ready, action required, unavailable, and unknown without returning credentials or upstream errors.
- **FR-012**: Matrix OS MUST support platform-provided access, owner-supplied keys, subscription login, and custom-endpoint authentication when a provider advertises the corresponding kind.
- **FR-013**: Provider credentials MUST be stored only by trusted computer services and MUST NOT be persisted in web, desktop-renderer, or mobile client storage.
- **FR-014**: Credential reads MUST be redacted, and all client-visible authentication failures MUST use bounded, provider-neutral messages.
- **FR-015**: Owners MUST be able to view Hermes and OpenClaw install state, health, and selection eligibility before attempting a runtime switch.
- **FR-016**: Matrix OS MUST NOT activate a runtime that is absent, unauthenticated where required, or unhealthy.
- **FR-017**: A failed runtime selection MUST leave the last healthy selection active and MUST NOT interrupt Chat.
- **FR-018**: Runtime switching MUST prevent duplicate delivery by pausing new messaging work, applying a bounded drain or cancellation policy, and activating the target only after health verification.
- **FR-019**: Either messaging runtime MUST receive messages and permission changes only through the Matrix OS-controlled delivery boundary defined for room-level access.
- **FR-020**: Runtime selection MUST NOT grant room access, expand tool permissions, expose prior room history, or bypass current permission revision checks.
- **FR-021**: Revoking room permission MUST stop queued work, request cancellation of running work, and prevent unsent replies for the active runtime.
- **FR-022**: Web Canvas and desktop settings MUST render the same effective configuration and clear loading, empty, unavailable, update-needed, validation-error, and retry states.
- **FR-023**: The web shell MUST expose only the Agent settings section among currently deferred settings sections.
- **FR-024**: Desktop MUST keep privileged credential, login, installation, and service-control actions outside its renderer process.
- **FR-025**: Every client-supplied identifier, selection, endpoint, credential submission, and real-time message option MUST be validated and bounded before use.
- **FR-026**: Every mutating operation MUST require owner authentication, enforce a body-size limit before parsing, and return only a bounded safe error contract.
- **FR-027**: Custom endpoints MUST be restricted to supported secure schemes and protected against requests to prohibited network ranges and unsafe redirects.
- **FR-028**: Provider catalogs, status probes, login sessions, runtime processes, work queues, and temporary files MUST have explicit time, count, memory, and cleanup bounds.
- **FR-029**: Concurrent settings changes MUST never silently overwrite unrelated fields; the system MUST either merge disjoint updates safely or reject a stale conflicting update.
- **FR-030**: Configuration changes and runtime transitions MUST produce owner-local diagnostic events that exclude secrets, provider-specific raw errors, and message content.

### Key Entities

- **Agent Configuration**: The owner-computer configuration that combines the Chat default, messaging runtime selection, and revision used for safe updates.
- **Chat Selection**: The effective provider, model, and effort for the always-available Matrix OS Chat kernel.
- **Messaging Runtime**: An optional process adapter, currently Hermes or OpenClaw, with install, health, eligibility, and active state.
- **Provider Descriptor**: A safe catalog entry describing a provider, its authentication kind, supported models, and coarse status.
- **Authentication Status**: A secret-free readiness summary and permitted recovery action for one provider.
- **Runtime Transition**: A bounded, auditable change from one messaging runtime to another.
- **Message Override**: A validated model and effort selection scoped to one Chat request.

### Scope Boundaries

- The Chat kernel remains the Claude Agent SDK-based Matrix OS kernel. This feature does not replace it with Hermes or OpenClaw.
- Runtime selection applies to optional messaging-agent duties. It does not mean that two messaging runtimes process the same event.
- The first OpenClaw release supports lifecycle, provider/model configuration, and controlled messaging delivery. Raw OpenClaw configuration editing, arbitrary plugin installation, and unrestricted tool parity are deferred.
- OpenClaw direct Matrix-room membership is not part of the first release. Matrix OS remains the permission-gated event consumer and reply sender.
- Mobile UI implementation remains in its separate stack. This feature supplies backward-compatible behavior and shared extended contracts.
- Provider billing purchase flows, usage metering redesign, and arbitrary provider marketplace installation are outside this feature.

### Assumptions

- Existing computers default to Hermes as the selected optional messaging runtime when no explicit runtime value exists.
- Existing Chat model and effort values remain authoritative until the owner changes them.
- A visible terminal-backed flow is acceptable for subscription login in the first release.
- Provider and model availability can vary by computer configuration and authentication state.
- A safe unavailable state is preferable to automatically installing or switching a runtime without owner intent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of test participants can identify the active Chat model, authentication method, and messaging runtime within 30 seconds of opening Agent settings.
- **SC-002**: At least 90% of test participants can complete a supported provider authentication and model-selection flow without external documentation.
- **SC-003**: A saved model or effort change appears consistently in web, desktop, and legacy-compatible mobile reads within 2 seconds on the same computer.
- **SC-004**: In validation, 100% of unsupported per-message choices are rejected before agent work begins, and 100% of accepted overrides leave the saved default unchanged.
- **SC-005**: In failure tests where OpenClaw is absent, unhealthy, or loses authentication, 100% preserve Chat availability and the last healthy messaging-runtime selection.
- **SC-006**: In runtime-switch tests, no source event is delivered to both runtimes and new messaging work resumes within 10 seconds or returns a clear retryable state.
- **SC-007**: In security tests, no settings, status, error, diagnostic, or conversation response contains provider credentials, login tokens, raw upstream errors, or filesystem paths.
- **SC-008**: Existing desktop and mobile contract tests for model/effort continue to pass unchanged while current clients can consume the extended fields.
- **SC-009**: An owner can switch mobile Chat sessions and load the stored transcript and effective model on every validated session change.
