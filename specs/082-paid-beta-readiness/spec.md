# Feature Specification: Paid Beta Readiness

**Feature Branch**: `082-paid-beta-readiness`  
**Created**: 2026-05-23  
**Status**: Draft  
**Input**: User description: "Make Matrix release-ready for founders and developers before adding Clerk payments. Matrix must be usable for all our coding from terminal locally or online, through Symphony and the shell terminal when needed, and as the company brain for user acquisition, coding, customer support, social media posts, and related work."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete Guided Onboarding To A Useful Workspace (Priority: P1)

A technical founder or developer signs up, receives a working Matrix OS instance, learns what Matrix can do for them, connects only the services needed for their goals, and reaches a guided "ready to work" state without manual SSH, hidden setup commands, or support intervention.

**Why this priority**: Paid beta cannot start until the first target user can understand the product, complete setup, and reach a useful working environment reliably.

**Independent Test**: Start from a new invited user account, complete signup and provisioning, follow the onboarding app, connect or skip each recommended service, open Matrix, and verify the user sees a beautiful Matrix-branded ready state with coding, terminal, agent, personal-assistant, and company-brain capabilities clearly marked as available or incomplete.

**Acceptance Scenarios**:

1. **Given** a new invited founder/developer has no Matrix instance, **When** they complete signup, **Then** Matrix provisions their workspace and shows progress until the workspace is ready or a recoverable failure is shown.
2. **Given** the workspace is ready, **When** the user opens Matrix for the first time, **Then** the onboarding app uses the same premium visual language as the redesigned Matrix website: calm stone/sage/forest surfaces, ember accents, refined typography, polished motion, real product imagery where useful, and no generic SaaS wizard styling.
3. **Given** the workspace is ready, **When** the user starts onboarding, **Then** Matrix explains the main jobs it can do: build software, create apps, operate tasks, manage company memory, draft support/growth work, summarize knowledge, and act through connected services after approval.
4. **Given** the user chooses a goal such as "code with Matrix", "run my company brain", or "use Matrix as an assistant", **When** onboarding continues, **Then** Matrix shows a short path for that goal with required, recommended, and optional steps separated.
5. **Given** the user wants coding help, **When** Matrix recommends setup, **Then** the onboarding app handholds GitHub connection, project selection, issue/task source selection, and optional Claude or Codex login for coding workflows.
6. **Given** the user wants assistant workflows, **When** Matrix recommends setup, **Then** the onboarding app handholds calendar, email, and communication integrations only as needed for approved tasks such as adding an event, reading email, or summarizing updates.
7. **Given** an integration, credential, or runtime dependency is missing, **When** onboarding reaches that step, **Then** Matrix explains what the missing piece enables, why it is optional or required, and how to retry without losing prior progress.
8. **Given** the user skips a non-critical setup step, **When** onboarding completes, **Then** Matrix clearly marks which workflows are available, which are degraded, and what to connect later from settings.
9. **Given** onboarding is viewed on desktop or mobile, **When** the user moves through setup, **Then** the experience preserves visual polish, readable hierarchy, smooth transitions, and stable layout without cropped text, overlapping controls, or hidden primary actions.

---

### User Story 2 - Run The Core Coding Loop In Matrix (Priority: P1)

A founder/developer uses Matrix as their primary coding control plane: they can connect GitHub, work locally or online, use a terminal inside Matrix when needed, dispatch coding work through Symphony, monitor the agent, and receive a concrete handoff such as a branch, commit, pull request, or validation result.

**Why this priority**: The first release promise is that Matrix helps founders and developers ship software, not merely chat with an assistant.

**Independent Test**: Connect GitHub or another supported project source, connect an issue/task source when available, start one coding task from Matrix, observe terminal/agent progress, and verify a completed handoff is visible without relying on external manual orchestration.

**Acceptance Scenarios**:

1. **Given** the user has not connected GitHub or a project source, **When** they try to start coding work, **Then** Matrix explains the minimum connection needed and offers a non-destructive setup path.
2. **Given** a connected project and eligible coding task, **When** the user starts the task from Matrix, **Then** Symphony creates or reuses the correct workspace and starts one agent run for the task.
3. **Given** an agent run is active, **When** the user opens the run, **Then** Matrix shows status, latest activity, related terminal/workspace access, next expected handoff, and whether Claude, Codex, or Hermes is currently powering the work.
4. **Given** terminal access is needed, **When** the user opens the Matrix terminal, **Then** they can inspect or intervene in the same project/workspace context used by the agent.
5. **Given** the task completes, fails, or needs human input, **When** the user returns to Matrix, **Then** the result is summarized with safe links/actions for review, retry, or follow-up.
6. **Given** the same task is already running, **When** Matrix polls or the user retries, **Then** Matrix does not start duplicate conflicting agents for the same task.

---

### User Story 3 - Connect Agent Credentials While Keeping Hermes Always On (Priority: P1)

A founder/developer can tell Matrix which agent capabilities they have available, including Claude for the core agent path and Codex for coding support, while Hermes remains the built-in Matrix system agent for app building, operating tasks, and approved integrations regardless of Claude or Codex credential state.

**Why this priority**: Users should not get stuck because they lack one provider credential, and adding Claude or Codex must not make the native Matrix agent disappear. Matrix must feel useful, honest, and stable across every agent mode.

**Independent Test**: Start onboarding with no Claude or Codex login, verify Hermes remains available for app-building guidance and operating tasks, then connect Claude or Codex later and verify the readiness state upgrades without recreating the workspace or disabling Hermes workflows.

**Acceptance Scenarios**:

1. **Given** the user has Claude access, **When** onboarding reaches agent setup, **Then** Matrix helps them log in, verifies the core agent is available, and explains which workflows now use it.
2. **Given** the user wants coding support through Codex, **When** onboarding reaches coding assistant setup, **Then** Matrix helps them log in, verifies the connection, and explains which coding workflows can use it.
3. **Given** the user has no Claude access or skips Claude login, **When** onboarding completes, **Then** Matrix keeps Hermes as the available system agent for building apps, completing operating tasks, using connected integrations, and explaining any limitations.
4. **Given** an agent credential is missing, expired, or revoked, **When** the user asks Matrix to do work, **Then** Matrix routes to the best available approved agent or asks for reconnection before attempting the action.
5. **Given** a user later connects Claude or Codex, **When** the connection is verified, **Then** Matrix updates the readiness checklist and agent routing explanation without requiring reprovisioning.
6. **Given** Claude or Codex is connected and verified, **When** the user asks Hermes to build an app, add a calendar event, read or summarize email, summarize company context, or update a work item, **Then** Hermes still completes the approved task or coordinates with the connected specialist agent without losing system-agent ownership.

---

### User Story 4 - Make Integrations Usable By Agents Through Skills (Priority: P1)

A founder/developer connects work services once, and Matrix agents can use approved integrations through skills to read context, create/update work items, and report progress without exposing provider secrets or requiring the user to copy API calls.

**Why this priority**: Integrations are only release-ready when agents can use them safely and predictably.

**Independent Test**: Connect the initial required services, ask a Matrix coding agent to inspect work context and update a tracked item, and verify the action succeeds through approved skills with no secrets or raw provider errors visible to the user.

**Acceptance Scenarios**:

1. **Given** the user has not connected a required service, **When** an agent needs that service, **Then** Matrix asks the user to connect it before attempting the action.
2. **Given** a service is connected and approved for the agent, **When** the agent invokes an integration skill, **Then** Matrix executes the action and records a user-visible summary.
3. **Given** a calendar or email service is connected and approved, **When** the user asks Matrix to add an event, read relevant email, or summarize recent updates, **Then** the active agent performs the task within the approved capability and records what it did.
4. **Given** an integration call fails, **When** the failure is shown to the user or agent, **Then** the message is safe, actionable, and does not leak provider secrets, database errors, or internal paths.
5. **Given** a service connection is revoked, **When** an agent tries to use it, **Then** Matrix refuses the action and prompts for reconnection or an alternate workflow.

---

### User Story 5 - Use Matrix As The Company Brain (Priority: P2)

A founder/developer uses Matrix to capture and retrieve company context across product decisions, customer notes, support threads, growth ideas, social posts, tasks, and coding work so agents can act with current company knowledge.

**Why this priority**: The second release promise is operating leverage: Matrix should help run the company, not only write code.

**Independent Test**: Add representative company context, ask Matrix for a decision or operating artifact that depends on that context, and verify the answer cites or links the relevant company memory, task, customer, or project record.

**Acceptance Scenarios**:

1. **Given** the user captures a product decision, customer note, or growth idea, **When** they later ask Matrix about related work, **Then** Matrix retrieves and uses the relevant company context.
2. **Given** multiple work streams exist, **When** the user asks what needs attention, **Then** Matrix summarizes active coding, support, acquisition, and content work with clear next actions.
3. **Given** an agent uses company context for a task, **When** it produces an output, **Then** the output links back to the source context or records the decision made.
4. **Given** company context includes private customer or business data, **When** Matrix uses it, **Then** access is scoped to the workspace owner and authorized teammates only.

---

### User Story 6 - Operate Growth And Support Workflows (Priority: P2)

A founder/developer asks Matrix to draft user acquisition content, support replies, social posts, and customer follow-ups using company context and connected services, while keeping final publishing or customer-facing replies under user control by default.

**Why this priority**: Founders need Matrix to move the business forward beyond code, but unsafe autopublishing would create trust risk.

**Independent Test**: Provide a support issue or acquisition goal, ask Matrix to draft the response or post, review it in Matrix, and approve or reject the suggested action.

**Acceptance Scenarios**:

1. **Given** a customer support request is available in Matrix context, **When** the user asks for help, **Then** Matrix drafts a response grounded in product/customer context and marks any unknowns.
2. **Given** the user asks for social or acquisition content, **When** Matrix drafts posts, **Then** the drafts match the user's product positioning and are queued for review rather than published automatically.
3. **Given** the user approves a draft action, **When** Matrix sends or publishes it through a connected service, **Then** the action is recorded with the actor, destination, and summary.
4. **Given** a draft contains sensitive or uncertain claims, **When** Matrix presents it, **Then** it highlights the uncertainty before approval.

---

### User Story 7 - Gate Paid Beta On Operational Readiness (Priority: P3)

An operator can see whether Matrix is ready to charge users by checking activation, runtime, integration, agent, coding-loop, company-brain, and support/growth readiness before enabling paid access.

**Why this priority**: Payments should amplify a working product, not mask incomplete onboarding or broken workflows.

**Independent Test**: Run the launch readiness check for a fresh workspace and an existing workspace, then verify the operator sees pass/fail status and concrete remediation steps for each release gate.

**Acceptance Scenarios**:

1. **Given** paid beta is not enabled, **When** an operator checks readiness, **Then** Matrix lists each release gate with pass/fail/blocked status and owner.
2. **Given** a gate fails, **When** the operator opens its details, **Then** Matrix shows the affected workflow, last check time, and recommended next action.
3. **Given** all release-critical gates pass, **When** the operator prepares to enable paid beta, **Then** Matrix confirms that onboarding, coding, integrations, agents, and workspace readiness meet the launch threshold.
4. **Given** payments are enabled later, **When** a user lacks entitlement, **Then** Matrix gates provisioning or runtime access without deleting owner data.

### Edge Cases

- Workspace provisioning succeeds but the browser shell cannot route to the user's workspace.
- Shell opens but Canvas, terminal, skills, or Symphony fail readiness checks.
- The onboarding app renders on a small mobile viewport where step labels, connector cards, or primary actions could overflow.
- A user has reduced-motion preferences enabled, but onboarding includes brand animation or progress motion.
- Product imagery, videos, or screenshots from the website-inspired branding fail to load.
- A user connects an integration in the browser but agents cannot access the approved capability.
- A user does not have Claude access, declines Claude login, or loses Claude access after activation.
- A user logs into Codex but has not connected GitHub or selected a project.
- A user connects GitHub but has not granted repository or issue permissions for the project they choose.
- A user connects email or calendar but has not approved the specific action the agent wants to take.
- An agent has partial context and must ask for permission or clarification before acting.
- A coding run completes but cannot create the expected handoff because the external work service is unavailable.
- A terminal session exists but is stale, detached, or bound to a missing workspace.
- Company-brain context contains contradictory notes or stale decisions.
- A support or social draft depends on facts Matrix cannot verify.
- A paid-beta entitlement changes while a workspace is provisioning or running.
- The operator readiness check itself cannot reach one of the underlying systems.

### Assumptions

- The first paid-beta customer is a technical founder or developer who already has active product, code, customer, and growth work.
- The first paid-beta promise is not broad consumer onboarding; it is a working operating system for shipping code and running an early-stage company.
- The initial coding workflow can use a narrow set of connected work services as long as missing services are clearly marked and recoverable.
- GitHub is the primary first-run project connection for founder/developer coding workflows, while Matrix should allow later support for other project sources.
- The core agent path is Claude-powered when the user has valid Claude access, but Hermes remains the always-on Matrix-native system agent before and after Claude/Codex connection.
- Codex is an optional coding assistant path that should be explained and verified when the user wants it, but lack of Codex must not block non-Codex workflows.
- Hermes should be able to guide app building and complete approved operating tasks through connected integrations, including calendar, email, summarization, and work-item updates.
- The onboarding app should align with the active Matrix website redesign in PR #162, including its calm premium palette, cloud-computer framing, always-on hub metaphor, and bring-your-own-agent education.
- The admin/settings surface should use `/home/deploy/finna-cloud` as inspiration for provider cards, model setup, configuration editing, setup wizard recovery, automation tabs, activity summaries, and mission-control style operations.
- Premium UI quality is a release gate for paid beta, not polish after functional completion.
- User approval is required before customer-facing support replies, social posts, or acquisition messages are sent by default.
- Payment enforcement is downstream of readiness; this feature defines the launch gates that must pass before paid access is enabled.

### Out of Scope

- Full public app store launch.
- Broad consumer persona onboarding beyond founders and developers.
- Fully autonomous support, social, or acquisition publishing without review.
- Complex usage-based billing, metering, invoices, or plan packaging.
- Organization-wide enterprise administration beyond explicitly authorized teammate access.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST define the initial paid-beta ICP as technical founders and developers who need one OS for coding, company memory, and operating workflows.
- **FR-002**: Matrix MUST provide a first-run activation path that ends in a visible "ready to work" state, not merely successful account creation.
- **FR-003**: Matrix MUST provide a guided onboarding app that teaches the user what Matrix can do for coding, app building, personal assistance, company memory, support, growth, and social workflows.
- **FR-004**: Matrix MUST ask the user what they want Matrix to help with first and tailor setup steps to that goal.
- **FR-005**: Matrix MUST treat onboarding UI/UX quality as a paid-beta readiness gate and align it with the active Matrix website redesign: premium calm palette, refined typography, deliberate motion, real product imagery, always-on cloud-computer framing, and bring-your-own-agent education.
- **FR-006**: Matrix MUST provide responsive onboarding layouts for desktop and mobile with stable dimensions, readable hierarchy, no overlapping text, no hidden primary actions, and reduced-motion fallbacks.
- **FR-007**: Matrix MUST show a readiness checklist covering workspace provisioning, shell routing, Canvas, terminal, skills, agent credentials, Hermes system-agent availability, coding agents, Symphony, integrations, and company-brain setup.
- **FR-008**: Matrix MUST distinguish required, recommended, and optional setup steps so users can start useful work without completing every future workflow.
- **FR-009**: Matrix MUST explain each setup step in terms of the workflow it unlocks and the consequences of skipping it.
- **FR-010**: Matrix MUST handhold GitHub connection, repository/project selection, and issue/task source selection for users who choose coding workflows.
- **FR-011**: Matrix MUST handhold Claude login when the user has Claude access and verify whether the Claude-powered core agent is available.
- **FR-012**: Matrix MUST handhold Codex login when the user chooses Codex-supported coding workflows and verify whether Codex is available.
- **FR-013**: Matrix MUST keep Hermes available and fully functional as the Matrix system agent whether Claude and Codex are missing, skipped, connected, expired, or revoked, with clear explanation of available, coordinated, and degraded workflows.
- **FR-014**: Matrix MUST allow users to connect agent credentials later and upgrade the readiness state without reprovisioning their workspace.
- **FR-015**: Matrix MUST support Hermes-assisted app building and approved operating tasks such as adding calendar events, reading or summarizing email, summarizing company context, and updating work items.
- **FR-016**: Matrix MUST provide an admin/control surface for models, agent credentials, integrations, settings, automations, readiness, and activity that uses dense but polished operational patterns inspired by Finna Cloud: provider status cards, model search/filter, setup wizard recovery, tabbed automation views, configuration save/reload states, and actionable activity summaries.
- **FR-017**: Matrix MUST support a core coding loop where a user can start, monitor, intervene in, and receive handoff from a coding-agent task inside Matrix.
- **FR-018**: Matrix MUST allow terminal access from the shell for the project or workspace context involved in a coding task.
- **FR-019**: Matrix MUST prevent duplicate active coding-agent claims for the same task/workspace during polling, retries, and manual actions.
- **FR-020**: Matrix MUST provide safe run states for queued, running, needs input, failed, stopped, completed, and handoff-ready coding work.
- **FR-021**: Matrix MUST make the initial work integrations usable by agents through approved skills, including connect-required, connected, revoked, failed, and unavailable states.
- **FR-022**: Matrix MUST require explicit user approval before an agent uses newly connected calendar, email, messaging, repository, or publishing capabilities for externally visible actions.
- **FR-023**: Matrix MUST never expose provider secrets, raw provider errors, database errors, internal filesystem paths, or platform credentials to users or browser-visible clients.
- **FR-024**: Matrix MUST record integration and agent actions with enough summary detail for the user to understand what happened and why.
- **FR-025**: Matrix MUST provide a company-brain workflow for capturing, retrieving, and reusing company context across coding, product, support, growth, and social work.
- **FR-026**: Matrix MUST scope company-brain access to the owner and explicitly authorized teammates.
- **FR-027**: Matrix MUST produce support, acquisition, and social-media drafts that require user approval before external publishing or customer-facing replies by default.
- **FR-028**: Matrix MUST highlight uncertainty, missing context, and sensitive claims in support, acquisition, or social drafts before approval.
- **FR-029**: Matrix MUST provide an operator-facing launch readiness view or report covering activation, runtime, onboarding UX, integrations, agent execution, coding handoff, company brain, support/growth drafts, and entitlement gating.
- **FR-030**: Matrix MUST block paid-beta enablement or clearly mark it unsafe when any release-critical gate fails.
- **FR-031**: Matrix MUST preserve owner data when paid entitlement is missing, expired, changed, or disabled.
- **FR-032**: Matrix MUST include user-facing recovery paths for retryable setup failures without requiring manual SSH or direct database edits.
- **FR-033**: Matrix MUST include acceptance tests or scripted checks for the complete golden path from signup to first coding-agent handoff.
- **FR-034**: Matrix MUST include acceptance tests or scripted checks for onboarding with no Claude access where Hermes remains the active agent for app-building and assistant tasks.
- **FR-035**: Matrix MUST include acceptance tests or scripted checks where Claude and/or Codex are connected and Hermes still completes system-agent workflows.
- **FR-036**: Matrix MUST include visual QA for onboarding across desktop and mobile, including screenshot comparison or review evidence against the Matrix website branding direction.
- **FR-037**: Matrix MUST document what is in scope for the first paid beta and what remains explicitly deferred.

### Key Entities *(include if feature involves data)*

- **Paid Beta ICP**: The target customer profile, needs, excluded segments, buying trigger, and must-win workflows for the first release.
- **Activation Checklist**: User-visible readiness state for account, workspace, shell, integrations, skills, agents, terminal, and company brain.
- **Onboarding Goal**: The user's selected first use case, such as coding with Matrix, building an app, setting up a company brain, or using Matrix as an assistant.
- **Onboarding Visual System**: The Matrix-branded UI rules, content tone, motion behavior, responsive layout constraints, and product imagery used by first-run setup.
- **Agent Credential State**: Availability, verification, expiry, coordination, and system-agent status for Claude, Codex, Hermes, and any later supported agent paths.
- **Admin Control Surface**: The user/operator-facing surface for model/provider setup, agent credentials, integrations, settings, automations, activity, and readiness remediation.
- **Coding Work Item**: A user-selected or agent-selected task that can be started, monitored, and handed off through Matrix.
- **Agent Run**: One execution lifecycle for a coding or operating task, including status, actor, context, logs, result, and handoff.
- **Integration Capability**: An approved service/action that Matrix agents can invoke through skills on behalf of the user.
- **Company Context Item**: Product decision, customer note, support thread, growth idea, social draft, task, or project record used by Matrix as company memory.
- **Draft Action**: A support reply, social post, acquisition message, or customer follow-up prepared by Matrix and awaiting approval.
- **Readiness Gate**: A release-critical pass/fail check used to decide whether paid beta can be enabled.
- **Entitlement State**: A user's paid-beta access state and the allowed Matrix behavior when access is active, missing, expired, or changed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new invited founder/developer can complete signup, provision a workspace, open Matrix, and reach the "ready to work" state in under 15 minutes without operator intervention.
- **SC-002**: At least 90% of internal onboarding rehearsal users can correctly identify three things Matrix can do for them after completing first-run onboarding.
- **SC-003**: Internal visual review rates the onboarding app as paid-beta quality and consistent with the Matrix website redesign before paid-beta enablement.
- **SC-004**: Onboarding passes desktop and mobile visual QA with no cropped text, overlapping controls, hidden primary actions, broken imagery, or motion that ignores reduced-motion preferences.
- **SC-005**: At least 90% of fresh-workspace readiness checks pass on the first retry during internal launch rehearsal.
- **SC-006**: A coding-focused user can connect GitHub, select a project, and see the next coding action in under 5 minutes after workspace readiness.
- **SC-007**: A user without Claude access can complete onboarding with Hermes active and successfully run one app-building or assistant task in every no-Claude golden-path rehearsal.
- **SC-008**: A user with Claude and/or Codex connected can still run one Hermes-owned app-building or assistant task in every connected-agent rehearsal.
- **SC-009**: A user can connect Claude or Codex after initial onboarding and see the agent readiness state upgrade without workspace reprovisioning.
- **SC-010**: A user can start one coding-agent task from Matrix and receive a visible completed, failed, or needs-input handoff within the expected task window without duplicate active runs.
- **SC-011**: The Matrix terminal can be opened from the coding workflow and shows the relevant project or workspace context in every P1 golden-path rehearsal.
- **SC-012**: Agents can use the required launch integrations through skills in a golden-path test without exposing secrets or raw provider errors.
- **SC-013**: A user can ask Matrix to perform one calendar, email, or summarization task through an approved integration and receive a clear action summary.
- **SC-014**: The admin/control surface lets an internal rehearsal user inspect model/provider setup, settings, automation status, activity, and readiness remediation without needing a separate runbook.
- **SC-015**: A user can capture company context and later get a Matrix answer or draft that links to or names the relevant source context.
- **SC-016**: Support, acquisition, and social workflows produce reviewable drafts and require explicit approval before any external send or publish action.
- **SC-017**: The operator readiness report identifies every failed release-critical gate with a concrete remediation owner or next action.
- **SC-018**: Paid-beta enablement is not considered launch-ready until signup, provisioning, shell routing, onboarding education, onboarding visual quality, integrations, Hermes system-agent continuity, agent execution, coding handoff, and company-brain checks all pass for at least one fresh workspace and one existing workspace.
- **SC-019**: Entitlement denial or expiry prevents new paid-only access without deleting or corrupting owner data.
