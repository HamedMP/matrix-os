# Feature Specification: Matrix Symphony

**Feature Branch**: `078-matrix-symphony`  
**Created**: 2026-05-13  
**Status**: Draft  
**Input**: User description: "Make Symphony Matrix-first: easy and secure Linear setup, assigned-ticket automation for selected people, Matrix-hosted coding agents/worktrees, and a simple dashboard for running agents, worktrees, and statuses."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Linear Securely (Priority: P1)

A Matrix owner opens Symphony, connects Linear or adds a Linear API secret through a server-side Matrix secret flow, chooses the team/project/labels/states/assignees that define eligible work, and can save those rules without exposing secrets in browser-visible app state.

**Why this priority**: Symphony cannot safely run unattended work unless issue-source credentials and eligibility rules are configured correctly.

**Independent Test**: Start from a Matrix instance with no Symphony config, connect a Linear account, select a team, label, and assignee, save the rule set, reload the app, and verify the secret is not exposed in app config or UI responses.

**Acceptance Scenarios**:

1. **Given** a Matrix owner has no Linear connection or stored Linear secret, **When** they open Symphony, **Then** the app shows a single clear credential setup step before any runner controls are enabled.
2. **Given** Linear is connected, **When** the owner selects a team, project, labels, active states, and assignees, **Then** Symphony stores the non-secret rule set and shows an eligible ticket preview.
3. **Given** Linear credentials exist server-side, **When** app config is read from the browser, **Then** no Linear token, API key, Pipedream secret, or provider credential appears in the payload.
4. **Given** the owner removes all assignees from the rule set, **When** rules are saved, **Then** Symphony treats assignee filtering as disabled and clearly shows that any matching assignee is eligible.

---

### User Story 2 - Run Assigned Tickets Inside Matrix (Priority: P1)

A Matrix owner starts Symphony and the system continuously watches eligible Linear tickets, creates or reuses one Matrix worktree per ticket, starts a coding-agent session inside that worktree, and prevents duplicate agents from claiming the same ticket/worktree.

**Why this priority**: This is the core value: Linear tickets become Matrix-owned coding-agent work without leaving the OS.

**Independent Test**: With a connected Linear account and an eligible assigned ticket, start Symphony and verify a Matrix worktree and agent session are created for that ticket, then attempt a second claim and verify it is rejected or reused safely.

**Acceptance Scenarios**:

1. **Given** an eligible Linear ticket has the required label, active state, and selected assignee, **When** Symphony runs a poll cycle, **Then** it creates or reuses a deterministic Matrix worktree for that ticket and starts one coding-agent session in that worktree.
2. **Given** an eligible ticket is already running, **When** a later poll sees the same ticket, **Then** Symphony does not create a duplicate active agent or conflicting worktree lease.
3. **Given** a running ticket changes to an ineligible state, loses a required label, or changes to an unselected assignee, **When** Symphony reconciles active work, **Then** the active claim is released or stopped according to the configured policy and the dashboard explains why.
4. **Given** a worktree or agent session cannot be created, **When** Symphony handles the failure, **Then** the ticket moves to a retry/attention state without exposing internal errors to the browser.

---

### User Story 3 - Operate Agents From A Simple Dashboard (Priority: P2)

An authorized Matrix owner or teammate opens Symphony and sees what agents are running, which ticket and worktree each owns, the latest status, validation/PR handoff state, and basic controls to stop, retry, or open the related Matrix workspace.

**Why this priority**: The upstream service only requires logs/status, but Matrix users need an in-OS operator surface for confidence and debugging.

**Independent Test**: Seed running, retrying, stopped, and attention-needed Symphony runs, then verify the dashboard displays each state and performs stop/retry/open actions without requiring raw GraphQL or shell commands.

**Acceptance Scenarios**:

1. **Given** multiple Symphony runs exist, **When** the dashboard loads, **Then** it groups runs by Queue, Running, Needs Attention, and Done/Handoff.
2. **Given** a run has a Matrix worktree and session, **When** the user selects it, **Then** the dashboard shows ticket identifier/title, assignee, branch/worktree, agent, status, last event, and links/actions to open the workspace and ticket.
3. **Given** the user stops a run, **When** the stop succeeds, **Then** the agent session stops, the worktree lease is released, and the dashboard updates without clearing unrelated runs.
4. **Given** a retryable failure exists, **When** the user retries, **Then** Symphony reuses the same ticket/worktree claim if still eligible and records the new attempt.
5. **Given** a Matrix user is not authorized for a Symphony installation, **When** they try to view or control runs, **Then** Symphony refuses the request without revealing run, ticket, worktree, or credential details.

---

### User Story 4 - Preserve Workflow Policy In The Repo (Priority: P3)

A team keeps coding-agent instructions in the repository workflow contract while Matrix stores per-owner runtime preferences and eligibility rules.

**Why this priority**: This preserves the upstream Symphony contract while adapting execution and credentials to Matrix ownership.

**Independent Test**: Configure a project with a `WORKFLOW.md`, start a ticket run, and verify the agent prompt includes the repo workflow body and ticket context while owner credentials remain server-side.

**Acceptance Scenarios**:

1. **Given** a Matrix project has a workflow contract, **When** Symphony dispatches a ticket, **Then** the agent prompt is composed from the workflow contract plus normalized ticket context.
2. **Given** the workflow contract is missing or invalid, **When** Symphony polls, **Then** new dispatch is blocked and existing dashboard state shows a configuration error.
3. **Given** the workflow contract changes, **When** a future ticket is dispatched, **Then** the new workflow applies to future runs without mutating in-flight session history.

### Edge Cases

- Linear is connected for the browser integration but no server-side runner credential is available.
- A Linear API secret is entered but validation fails or the secret is later revoked.
- The selected Linear assignee leaves the team or becomes unavailable.
- Linear API pagination returns more matching tickets than the dashboard page cap.
- Multiple labels are required but Linear only supports efficient server-side filtering for one label.
- A ticket changes assignee/state/labels while its agent is running.
- The gateway restarts while runs are active and persisted worktree/session state must be reconciled.
- Worktree creation succeeds but agent session startup fails.
- Agent session stops but worktree lease release fails.
- A user-controlled repo/workflow path attempts traversal or points outside allowed Matrix project/workflow locations.
- Linear, GitHub, or Matrix workspace APIs are temporarily unavailable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Symphony MUST provide a Matrix-first setup flow that connects Linear or stores a Linear API secret server-side, then saves only non-secret rule/configuration data in app-visible state.
- **FR-002**: Symphony MUST support Linear eligibility rules for team, optional project, required labels, active states, terminal states, and zero or more selected assignees.
- **FR-003**: Symphony MUST preview eligible Linear tickets using the saved rule set before the owner starts unattended dispatch.
- **FR-004**: Symphony MUST never expose Linear API keys, OAuth tokens, Pipedream secrets, gateway secrets, or raw provider errors to browser clients.
- **FR-005**: Symphony MUST allow only the Matrix owner and explicitly authorized teammates to view or control a Symphony installation.
- **FR-006**: Symphony MUST run as a Matrix-owned orchestrator that uses existing Matrix project, worktree, and agent-session primitives instead of requiring the user to run an external command for normal operation.
- **FR-007**: Symphony MUST create or reuse a deterministic Matrix worktree per eligible ticket and acquire a lease before starting an agent.
- **FR-008**: Symphony MUST prevent duplicate active claims for the same ticket or worktree across poll cycles, retries, and manual actions.
- **FR-009**: Symphony MUST start coding-agent sessions with ticket context, workflow instructions, project/worktree context, and the configured agent identity.
- **FR-010**: Symphony MUST maintain operator-visible run state for queued, running, retrying, blocked, stopped, failed, and handoff/completed runs.
- **FR-011**: Symphony MUST reconcile active runs when tickets become ineligible, terminal, missing, blocked, or unavailable.
- **FR-012**: Symphony MUST provide bounded retry behavior with visible retry reason, attempt count, and next retry time.
- **FR-013**: Symphony MUST provide dashboard actions to start/stop the orchestrator, stop a run, retry a run, open the Matrix workspace, and open the external ticket.
- **FR-014**: Symphony MUST persist configuration and run metadata in owner-controlled Matrix state so a gateway restart can reconstruct dashboard state and reconcile active work.
- **FR-015**: Symphony MUST validate all route payloads, query parameters, workflow references, project slugs, worktree IDs, ticket IDs, and action types at the boundary.
- **FR-016**: Symphony MUST bound in-memory collections for poll results, run state, subscribers, and logs, with eviction or retention rules.
- **FR-017**: Symphony MUST use generic client-facing error messages and server-side detailed logs for provider, filesystem, database, and agent-launch failures.
- **FR-018**: Symphony MUST provide realtime or refresh-based status updates so dashboard state reflects run transitions without manual page reload.
- **FR-019**: Symphony MUST keep the advanced Linear GraphQL surface out of the default operator workflow.
- **FR-020**: Symphony MUST keep repository workflow policy in `WORKFLOW.md` or an explicitly selected project workflow file, while Matrix stores owner runtime rules separately.
- **FR-021**: Symphony MUST include tests that cover credential isolation, Linear assignee filtering, duplicate claim prevention, worktree/session orchestration, reconciliation, dashboard state rendering, and restart recovery.
- **FR-022**: Symphony MUST document how Matrix owners configure Linear, eligible assignees, workflow policy, run controls, and failure recovery.
- **FR-023**: Symphony MUST record operator events for security-sensitive actions such as credential changes, rule changes, start, stop, retry, and teammate access changes.

### Key Entities *(include if feature involves data)*

- **Symphony Installation**: Owner-scoped configuration for orchestrator enabled state, connected tracker, project binding, concurrency, polling, credential reference, and authorized operators.
- **Ticket Source Rule**: Eligibility rule for Linear team/project/labels/states/terminal states/assignees.
- **Tracked Ticket**: Normalized issue data used for preview, dispatch, reconciliation, and dashboard display.
- **Symphony Run**: One ticket execution lifecycle, including status, attempt count, agent, worktree, session, timestamps, and failure/handoff reason.
- **Worktree Claim**: Exclusive relationship between a ticket/run and a Matrix worktree/session holder.
- **Workflow Contract**: Repo-owned instructions used to compose coding-agent prompts.
- **Operator Event**: Bounded status/log entry visible in the dashboard.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Matrix owner can connect Linear or add a server-side Linear secret, select assignees and eligibility rules, preview matching tickets, and start Symphony in under 5 minutes from a clean Matrix instance with Linear available.
- **SC-002**: Browser-visible Symphony config and status responses contain zero provider secrets or raw provider error strings across setup, status, start, stop, and retry flows.
- **SC-003**: In a test run with 10 matching Linear tickets and concurrency set to 3, Symphony starts no more than 3 active agents and creates no duplicate active worktree claims for the same ticket.
- **SC-004**: When an active ticket becomes ineligible, the dashboard reflects the stop/release/block reason within one polling interval plus 5 seconds.
- **SC-005**: After a gateway restart, the dashboard reconstructs prior run/worktree/session state and reconciliation resolves stale active claims without manual cleanup.
- **SC-006**: The default Symphony dashboard presents the primary operator view without requiring raw GraphQL, shell command copying, or editing runner paths.
- **SC-007**: Local automated validation covers all P1 scenarios plus the main dashboard P2 scenario before the feature is eligible for PR review.
- **SC-008**: An unauthorized Matrix user receives no Symphony run, ticket, worktree, or credential details from setup, status, or control endpoints.
