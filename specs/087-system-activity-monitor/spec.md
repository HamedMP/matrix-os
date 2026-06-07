# Feature Specification: System Activity Monitor

**Feature Branch**: `087-system-activity-monitor`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "Add an Activity Monitor-like Matrix app so users can see which machine they have, RAM/CPU/disk usage, active services and processes, and clean up stale processes automatically or by a click."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect My Matrix Computer (Priority: P1)

As a Matrix OS owner, I can open a built-in System Activity Monitor and see the current health of my Matrix computer in one place: machine identity, release, uptime, CPU, memory, disk, swap, service status, and top resource consumers.

**Why this priority**: Users need trustworthy visibility before Matrix can safely offer cleanup. This is the MVP and has no destructive behavior.

**Independent Test**: On a running Matrix computer, open the System Activity Monitor and verify the dashboard shows current machine identity and resource values that match an operator-side health snapshot within a short refresh window.

**Acceptance Scenarios**:

1. **Given** a user has an active Matrix computer, **When** they open System Activity Monitor, **Then** they see handle, runtime slot, hostname, installed release, uptime, and machine status.
2. **Given** the dashboard is open, **When** resource usage changes, **Then** CPU, memory, disk, swap, pressure, service, and process summaries refresh without requiring a page reload.
3. **Given** system memory includes reclaimable cache, **When** memory is displayed, **Then** the dashboard separates app memory from reclaimable file/kernel cache so the user does not mistake cache for a leak.
4. **Given** a health probe cannot collect one section, **When** the dashboard renders, **Then** available sections still render and the failed section shows a generic unavailable state.

---

### User Story 2 - Review Cleanup Suggestions (Priority: P2)

As a Matrix OS owner, I can see safe cleanup suggestions with clear explanations, estimated resource recovery, confidence, and risk before taking action.

**Why this priority**: Cleanup decisions need user trust. Suggestions should be explainable and bounded before any button mutates the machine.

**Independent Test**: Create known stale resource candidates, open the monitor, and verify suggestions appear only for resources that match documented cleanup rules and never for active user work.

**Acceptance Scenarios**:

1. **Given** an orphaned app server is still running with no active connections, **When** the monitor evaluates cleanup candidates, **Then** it suggests stopping that app server and explains why it is safe.
2. **Given** a zellij session or code editor is active or recently used, **When** suggestions are generated, **Then** no cleanup suggestion is shown for that active resource.
3. **Given** old cache or rollback files can be cleaned, **When** suggestions are generated, **Then** the user sees expected reclaimed space and which directories or retained versions are affected.
4. **Given** the system cannot determine whether a process is stale, **When** suggestions are generated, **Then** it is omitted or marked as manual-review-only rather than offered as a one-click cleanup.

---

### User Story 3 - Clean Up Safely by Click (Priority: P3)

As a Matrix OS owner, I can run approved cleanup actions from the System Activity Monitor and see the result without raw internal errors or accidental termination of active work.

**Why this priority**: Manual cleanup makes the monitor actionable, but it must be guarded by typed actions and confirmations.

**Independent Test**: Select each approved cleanup type against a safe fixture resource and verify only that resource is affected, the monitor refreshes, and an audit event records the action.

**Acceptance Scenarios**:

1. **Given** a stale app server suggestion exists, **When** the user confirms cleanup, **Then** the server is stopped, the dashboard refreshes, and active services remain healthy.
2. **Given** a stale zellij session suggestion exists, **When** the user confirms cleanup, **Then** only that session is closed and other sessions remain available.
3. **Given** a cache cleanup suggestion exists, **When** the user confirms cleanup, **Then** only the approved cache scope is cleaned and owner data is preserved.
4. **Given** a cleanup target disappears before the action runs, **When** the action executes, **Then** it returns an already-clean result and does not fail as an error.

---

### User Story 4 - Enable Automatic Cleanup Policy (Priority: P4)

As a Matrix OS owner, I can opt into conservative automatic cleanup for high-confidence stale resources and review what happened afterward.

**Why this priority**: Automatic cleanup can keep small VPSes healthy, but it should only ship after the monitor and manual cleanup path prove the classifier.

**Independent Test**: Enable auto-clean for a known safe class, create stale resources, and verify the policy cleans only eligible resources after the grace period while recording visible history.

**Acceptance Scenarios**:

1. **Given** automatic cleanup is disabled, **When** stale resources are detected, **Then** the system only suggests actions and does not mutate the machine.
2. **Given** automatic cleanup is enabled for high-confidence app servers, **When** an eligible resource remains stale past the grace period, **Then** it is cleaned and a history entry records the reason.
3. **Given** a resource becomes active during the grace period, **When** auto-clean evaluates it, **Then** the cleanup is skipped.

### Edge Cases

- The Matrix computer is provisioned but unreachable or still booting.
- A process exits between snapshot collection and cleanup action execution.
- A process belongs to the OS or another critical service and must never be offered for direct termination.
- Disk usage is high because of owner data, not reclaimable system/cache files.
- Resource counters are temporarily unavailable because the host lacks an optional tool.
- The user has multiple runtime slots and needs to distinguish primary, staging, and preview machines.
- Cleanup succeeds but a later health refresh fails.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an owner-only System Activity Monitor entry point in Matrix shell.
- **FR-002**: System MUST show machine identity including handle, runtime slot, hostname, machine status, installed release, release channel, and uptime.
- **FR-003**: System MUST show current CPU load, memory, swap, disk usage, pressure indicators, running service status, and top resource-consuming processes.
- **FR-004**: System MUST distinguish live process memory from reclaimable cache or kernel/file accounting where available.
- **FR-005**: System MUST refresh activity data periodically and allow manual refresh without reloading the shell.
- **FR-006**: System MUST degrade section-by-section when a metric cannot be collected.
- **FR-007**: System MUST classify cleanup candidates into explicit resource types before presenting suggestions.
- **FR-008**: System MUST NOT expose arbitrary process termination; cleanup actions must be typed, allowlisted, and tied to a server-generated candidate.
- **FR-009**: System MUST show cleanup reason, confidence, risk, target, and estimated reclaimed resources before action.
- **FR-010**: System MUST require confirmation for actions that stop a process, close a session, restart a service, or delete files.
- **FR-011**: System MUST preserve owner data and protected system files during cleanup.
- **FR-012**: System MUST record cleanup attempts and outcomes in an owner-visible history.
- **FR-013**: System MUST return generic user-facing errors while retaining enough operator-side detail for diagnosis.
- **FR-014**: System MUST support an opt-in automatic cleanup policy limited to high-confidence, documented cleanup classes.
- **FR-015**: System MUST allow users to disable automatic cleanup and review the last automatic actions.
- **FR-016**: System MUST keep cleanup candidate registries and any in-memory state bounded with eviction.
- **FR-017**: System MUST validate all action inputs and reject stale, unknown, or mismatched cleanup targets.
- **FR-018**: System MUST notify the dashboard after cleanup so service health and resource summaries refresh.

### Key Entities *(include if feature involves data)*

- **Activity Snapshot**: Point-in-time machine identity, resource, service, process, and cleanup suggestion view.
- **Machine Identity**: User-visible runtime identity including handle, slot, hostname, release, and status.
- **Resource Metric**: CPU, memory, disk, swap, pressure, and service accounting values with collection status.
- **Process Summary**: Sanitized process identity, owner class, CPU, memory, runtime, listening ports, and classification.
- **Cleanup Candidate**: Server-generated, typed recommendation for a safe cleanup action.
- **Cleanup Action**: User-initiated or policy-initiated request to clean a specific candidate.
- **Cleanup History Entry**: Owner-visible record of action, reason, actor, result, reclaimed resources, and timestamp.
- **Auto-Cleanup Policy**: Owner-controlled configuration for conservative automatic cleanup classes and grace periods.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can identify their current Matrix computer, installed release, and top three memory and CPU consumers in under 10 seconds after opening the monitor.
- **SC-002**: Read-only activity refresh completes within 2 seconds for at least 95% of requests on a small customer VPS under normal load.
- **SC-003**: Cleanup suggestions never include critical Matrix services or active user work in documented active-resource scenarios.
- **SC-004**: A safe stale app server or stale session can be cleaned from the dashboard and reflected in the next refresh within 5 seconds.
- **SC-005**: Disk cleanup preserves owner data paths in all protected-path test cases.
- **SC-006**: Automatic cleanup, when enabled, records 100% of actions in user-visible history.
