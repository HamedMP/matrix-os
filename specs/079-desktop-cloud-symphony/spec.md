# Feature Specification: Desktop Cloud Symphony

**Feature Branch**: `079-desktop-cloud-symphony`  
**Created**: 2026-05-14  
**Status**: Draft  
**Input**: User description: "Build a desktop app that continues the existing work, is very similar to Slay Zone in almost all product capabilities, shows Matrix shell and app launcher, supports cloud development, runs coding agents only in the cloud, syncs tickets from Linear or Matrix-internal tickets, and assigns them to the Symphony runner in Matrix."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Launch Matrix As A Desktop Workbench (Priority: P1)

A user opens the Matrix desktop app and lands in the same Matrix shell they already use on the web, with Canvas/Desktop mode, dock/app launcher, built-in apps, settings, chat, terminal/workspace views, and persistent window/session state presented as a native desktop workbench.

**Why this priority**: The desktop app is not useful unless it is first a high-quality Matrix shell with app-launcher parity and stable native behavior.

**Independent Test**: Install or run the desktop app against a local or hosted Matrix instance, open the shell, launch at least five built-in apps including Symphony and Terminal/Workspace, reload/restart the desktop app, and verify app/window/session state returns without opening a browser.

**Acceptance Scenarios**:

1. **Given** a user has a reachable Matrix instance, **When** they open the desktop app, **Then** the app displays Matrix shell as the primary surface with no marketing or setup page in front of the actual workbench.
2. **Given** the desktop app is connected, **When** the user opens the app launcher, **Then** built-in apps, installed apps, Symphony, workspace, terminal, file browser, and settings are discoverable and launchable.
3. **Given** the user opens, moves, pins, or closes Matrix shell windows, **When** the desktop app restarts, **Then** shell state is restored consistently with the same Matrix account and workspace.
4. **Given** an app or external ticket link opens a third-party URL, **When** it leaves the Matrix trust boundary, **Then** the desktop app opens the URL externally or in a clearly marked external view without granting Matrix desktop privileges.
5. **Given** a built-in default Matrix app is opened from desktop, **When** it launches, **Then** it can use desktop-aware presentation affordances while still running as a Matrix app with the same permissions and data ownership rules.

---

### User Story 2 - Work On Cloud Development Projects (Priority: P1)

A developer manages Matrix cloud workspaces from the desktop app: projects, repositories, worktrees, previews, files, terminals, task artifacts, and running sessions are visible in one task/workbench view similar to Slay Zone, but execution happens on the Matrix cloud/VPS runtime instead of the local desktop.

**Why this priority**: Slay-like productivity depends on a unified project/task/runtime surface, and the user explicitly wants cloud development rather than local agent execution.

**Independent Test**: Connect a Matrix project, create or select a cloud worktree, open project files and a terminal/session view, start a preview, attach to an existing cloud agent session, and verify no coding-agent process is launched locally.

**Acceptance Scenarios**:

1. **Given** a Matrix project is connected, **When** the user opens its desktop workbench, **Then** the project view shows tasks/tickets, worktrees, sessions, previews, artifacts, and recent events.
2. **Given** a user creates a new worktree from the desktop app, **When** the worktree is provisioned, **Then** the worktree exists in the Matrix cloud runtime and appears in the desktop workbench with branch, status, and preview/session affordances.
3. **Given** an agent session is running in the cloud, **When** the user opens the session from desktop, **Then** they can observe, send allowed input, stop, retry, or take over through Matrix APIs without a local agent binary.
4. **Given** the desktop machine is offline or loses connection, **When** cloud work continues, **Then** the app shows a disconnected/reconnecting state and recovers current cloud state after reconnect.
5. **Given** a repository has workflow setup instructions, **When** a cloud worktree is created, **Then** Matrix can run the configured setup/live commands in the VPS runtime and expose approved preview ports back to the desktop app.

---

### User Story 3 - Sync And Manage Tickets From Linear And Matrix (Priority: P1)

A user configures ticket sources from Linear and Matrix-native internal tickets, sees one unified task board/list with statuses, assignees, labels, priorities, dependencies, artifacts, and history, and can assign eligible tickets to Symphony.

**Why this priority**: The desired product centers on turning external or internal tickets into coding-agent work.

**Independent Test**: Configure a Linear source and a Matrix-internal ticket source, sync tickets, create a Matrix-native ticket, update status/assignee/labels from desktop, and confirm deduplication and source attribution are correct.

**Acceptance Scenarios**:

1. **Given** Linear credentials or an approved Linear connection exist, **When** the user configures a team/project/label/state rule, **Then** eligible Linear issues sync into Matrix as tracked tickets without exposing provider secrets to the desktop UI.
2. **Given** a user creates an internal Matrix ticket, **When** it is saved, **Then** it appears in the same board/list, can have labels/status/assignee/dependencies/artifacts, and can be selected for Symphony work.
3. **Given** a ticket exists in both an external source and Matrix state, **When** sync runs, **Then** Matrix preserves source identity and avoids duplicate active tickets.
4. **Given** a user changes ticket status or metadata in Matrix, **When** the ticket is connected to Linear, **Then** Matrix either pushes the update through the configured sync policy or clearly marks it as Matrix-local only.

---

### User Story 4 - Assign Tickets To Matrix Symphony (Priority: P1)

A user selects tickets manually or through saved rules and assigns them to the Matrix Symphony runner, which claims work, creates/reuses cloud worktrees, starts cloud coding agents, streams status back to the desktop app, and prevents duplicate claims.

**Why this priority**: Symphony assignment is the central automation loop connecting tickets, cloud development, and coding agents.

**Independent Test**: Select a Linear ticket and a Matrix-native ticket, assign both to Symphony, verify exactly one cloud worktree/session claim per ticket, observe status updates in desktop, stop/retry one run, and verify run state survives gateway restart.

**Acceptance Scenarios**:

1. **Given** an eligible ticket is selected, **When** the user assigns it to Symphony, **Then** Symphony creates or reuses a cloud worktree, starts a cloud coding-agent session, and records a visible run.
2. **Given** a ticket is already claimed by a running Symphony run, **When** another assignment rule or user action targets it, **Then** Symphony reuses or rejects the duplicate claim without starting a conflicting agent.
3. **Given** a Symphony run needs attention, **When** the user opens it in desktop, **Then** they see ticket context, worktree/session, status, recent events, validation/PR handoff, and safe stop/retry/open actions.
4. **Given** the gateway restarts while runs are active, **When** desktop reconnects, **Then** the dashboard reconstructs active, stale, failed, and completed run state without manual cleanup.
5. **Given** a repository requires Codex authentication, **When** Symphony validates setup, **Then** Matrix shows Codex login/readiness status and blocks unattended runs until the cloud runtime has valid server-side Codex credentials.

---

### User Story 5 - Operate A Slay-Like Developer Command Center (Priority: P2)

A power user gets the major Slay Zone workflows in Matrix desktop: multi-tab task workbench, agent/status panels, browser/previews, file editor, terminal/session panels, automation triggers, usage/status visibility, settings, and onboarding for cloud-only development.

**Why this priority**: The user explicitly wants near Slay Zone feature parity, but these workflows can layer on top of the P1 desktop/cloud/ticket/Symphony foundation.

**Independent Test**: Use the desktop app for a full development loop: choose a project, open task tabs, inspect files/artifacts, open preview/browser, observe agent status, run an automation or ticket rule, adjust settings, and complete a ticket handoff without using Slay Zone.

**Acceptance Scenarios**:

1. **Given** multiple active tickets or sessions exist, **When** the user opens them, **Then** the desktop app supports tabbed task/workspace navigation and preserves active context.
2. **Given** cloud sessions are active, **When** the user opens the agent/status panel, **Then** it shows idle/running/attention/done runs, active agents, and shortcuts to open the related workspace.
3. **Given** a ticket has artifacts, files, logs, previews, or browser URLs, **When** the user opens the ticket workbench, **Then** those resources are available in the same desktop task context.
4. **Given** a user configures automations, **When** a ticket/source/status event matches, **Then** the automation runs in the approved Matrix cloud/runtime scope and records a visible event.

---

### User Story 6 - Administer Security, Cloud Policy, And Desktop Distribution (Priority: P2)

An owner or admin configures desktop connections, cloud-only agent policy, allowed ticket sources, operator access, update channels, telemetry preferences, and recovery behavior without weakening Matrix ownership or defense-in-depth rules.

**Why this priority**: A native desktop app expands the trust boundary and must be governed before production rollout.

**Independent Test**: Configure a desktop app for a Matrix instance, verify cloud-only policy cannot be disabled from the client, grant/revoke operator access, simulate update/reconnect/failure states, and confirm secrets/errors remain protected.

**Acceptance Scenarios**:

1. **Given** a desktop app connects to Matrix, **When** runtime capabilities are loaded, **Then** the app shows cloud agent execution as enforced and does not expose a local-agent execution toggle.
2. **Given** an unauthorized user opens a project/ticket/Symphony route, **When** access is checked, **Then** the user receives no ticket, run, credential, file path, or provider details.
3. **Given** the desktop app receives provider, gateway, filesystem, or cloud-runner errors, **When** it displays an error, **Then** it uses allowlisted/capped client-safe messages and logs details server-side.
4. **Given** a desktop update or runtime migration is available, **When** the user checks status, **Then** the app shows clear update state without overwriting Matrix owner data.
5. **Given** a release tag or manual release is triggered, **When** the desktop release workflow runs, **Then** Matrix builds signed/notarized desktop artifacts, bundles checksums/manifests, supports dry-run and publish modes, and publishes to configured release channels.

---

### User Story 7 - Collaborate On Shared Team Boards (Priority: P3)

A team shares one Matrix project board backed by Linear or Matrix-native tickets, assigns tasks to people, and lets each assignee route their work to their own Matrix/Symphony runner while preserving team visibility.

**Why this priority**: The first version can focus on a personal owner instance, but team-shared boards are required for the intended collaborative product direction.

**Independent Test**: Add two Matrix users to the same project board, assign one Matrix-native ticket and one Linear ticket to different users, and verify each user sees the shared board while their own Symphony runner can claim only authorized work.

**Acceptance Scenarios**:

1. **Given** a Matrix owner shares a project board with another Matrix user, **When** the teammate opens the board, **Then** they see authorized tickets, statuses, assignees, labels, and run state.
2. **Given** a ticket is assigned to a teammate, **When** the teammate assigns it to Symphony, **Then** the ticket is claimed by that teammate's authorized Matrix/Symphony runtime according to project policy.
3. **Given** a teammate is removed from the board, **When** they attempt to view or control tickets/runs, **Then** Matrix denies access without leaking ticket, run, repo, credential, or filesystem details.
4. **Given** Linear is the shared source of truth, **When** Matrix syncs the board, **Then** Linear's multi-user assignment state remains visible and Matrix-specific collaboration metadata stays scoped to authorized users.

### Edge Cases

- Matrix shell is reachable but gateway APIs are unavailable.
- Gateway is reachable but the selected cloud workspace runtime is degraded.
- Desktop app restarts while cloud agents continue running.
- A local machine lacks any supported coding-agent binary; the desktop app must still function because agents run only in cloud.
- Linear sync returns more tickets than the configured cap.
- Linear credentials are revoked, expired, or connected for browser use but not for server-side runner use.
- Matrix-native and Linear tickets share the same title/branch but represent different source identities.
- A ticket changes status, assignee, or label while Symphony is claiming it.
- Cloud worktree creation succeeds but agent session startup fails.
- Agent session startup succeeds but status/event streaming is interrupted.
- A preview/browser URL redirects to an untrusted or local/private address.
- A desktop external link attempts `file:`, `javascript:`, custom app protocols, or credential-bearing URLs.
- A user tries to configure local agent execution from the desktop app.
- Offline desktop actions conflict with newer cloud state after reconnect.
- A user closes the desktop app while long-running cloud work is active.
- A project workflow file is missing, has unsafe setup commands, or references unavailable preview ports.
- Codex cloud credentials are missing, expired, or valid for one Matrix user but not another.
- Two teammates assign the same shared ticket to different Symphony runners at nearly the same time.
- Release signing/notarization secrets are missing during a dry run or publish run.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The desktop app MUST present Matrix shell as the primary first screen, including Canvas/Desktop workflows, dock/app launcher, built-in apps, settings, chat, workspace, terminal/session, and app viewer surfaces.
- **FR-002**: The desktop app MUST support connecting to local development, customer VPS, and hosted Matrix instances through explicit, validated Matrix instance configuration.
- **FR-003**: The desktop app MUST discover and launch built-in and installed Matrix apps, including Symphony, Workspace, Terminal/Session, File Browser, App Store, Settings, Chat, and user-installed apps.
- **FR-004**: The desktop app MUST persist desktop-specific window/app/session preferences without replacing owner-controlled Matrix shell state.
- **FR-004a**: Default Matrix apps SHOULD expose desktop-aware presentation affordances when opened in the desktop app while preserving Matrix app sandboxing and permission rules.
- **FR-005**: The system MUST enforce cloud-only coding-agent execution for this desktop product; the desktop app MUST NOT start Claude, Codex, OpenCode, Pi, or similar coding-agent processes locally.
- **FR-006**: Users MUST be able to observe, attach to, send allowed input to, stop, retry, and take over cloud coding-agent sessions through Matrix-controlled APIs.
- **FR-007**: The system MUST provide a cloud development project view with projects, repositories, worktrees, branches, previews, sessions, artifacts, files, events, and run history.
- **FR-007a**: Projects MUST support repository workflow configuration, including setup commands, live/dev commands, validation commands, allowed preview ports, and runner prerequisites.
- **FR-007b**: Cloud workspaces MUST expose approved live preview URLs or port-forwarding targets to the desktop app without exposing private runtime internals.
- **FR-008**: Users MUST be able to create, list, open, and delete cloud worktrees through approved Matrix workspace controls with duplicate/lease protection.
- **FR-009**: Users MUST be able to create, view, update, archive, restore, and search Matrix-native tickets with statuses, priorities, assignees, labels, dependencies, descriptions, artifacts, and history.
- **FR-010**: The system MUST sync Linear tickets into Matrix using saved eligibility rules for team, project, labels, states, terminal states, and assignees.
- **FR-011**: The system MUST unify Linear and Matrix-native tickets in one board/list/workbench while preserving source identity, sync status, and deduplication.
- **FR-012**: Users MUST be able to assign one or more eligible tickets to Matrix Symphony manually.
- **FR-013**: Users MUST be able to define saved Symphony assignment rules that claim eligible Linear or Matrix-native tickets automatically.
- **FR-013a**: Symphony setup MUST include cloud Codex readiness, authentication status, and blocked-run messaging when Codex is unavailable in the Matrix runtime.
- **FR-014**: Symphony MUST create or reuse one cloud worktree/session claim per assigned ticket and prevent duplicate active claims across manual assignment, automatic rules, retries, and restarts.
- **FR-015**: The desktop app MUST show Symphony run states including queued, running, blocked, retrying, needs attention, stopped, failed, handoff, and completed.
- **FR-016**: The desktop app MUST provide Slay-like task/workspace tabs with persistent active task context, closable/reopenable tabs, and clear indicators for cloud runtime state.
- **FR-017**: The desktop app MUST provide agent/status panels that summarize active cloud sessions, idle/attention states, run ownership, and shortcuts to open related tickets/workspaces.
- **FR-018**: The desktop app MUST provide file/artifact/preview/browser surfaces scoped to the selected Matrix project or ticket.
- **FR-019**: The system MUST support event-driven or scheduled automations for ticket/source/status changes, with execution constrained to approved Matrix cloud/runtime scope.
- **FR-020**: The desktop app MUST expose safe settings for Matrix instance connection, appearance, shell preferences, ticket source rules, Symphony rules, cloud runtime status, update status, and privacy/telemetry preferences.
- **FR-020a**: The system MUST support shared project boards with authorized Matrix users, assignment to teammates, and per-user/per-runner Symphony claim permissions.
- **FR-021**: The system MUST provide onboarding/import guidance for users coming from Slay Zone, including feature mapping and cloud-only differences.
- **FR-022**: Browser-visible and desktop-visible APIs MUST never expose provider tokens, Linear API keys, Pipedream secrets, raw database errors, raw provider errors, filesystem paths, or cloud runner secrets.
- **FR-023**: Every desktop-facing gateway endpoint, realtime channel, and ticket/Symphony mutation MUST enforce Matrix request-principal authorization and operator access.
- **FR-024**: Every mutating endpoint used by the desktop app MUST apply body size limits and route-boundary validation.
- **FR-025**: Server-side fetches of user-controlled preview/browser/integration URLs MUST use timeouts and SSRF protections before any network request.
- **FR-026**: Realtime desktop updates MUST use bounded subscriber registries, stale-connection eviction, failure-isolated broadcasts, and shutdown drains.
- **FR-027**: The desktop app MUST cap and allowlist any client-displayed server error strings before rendering them.
- **FR-028**: The system MUST reconcile cloud worktree/session/ticket/Symphony state after gateway restart, desktop reconnect, and failed partial operations.
- **FR-029**: The feature MUST include automated tests for desktop bridge policy, app-launcher shell loading, cloud-only agent enforcement, ticket sync/deduplication, internal tickets, Symphony assignment/claiming, realtime updates, and restart recovery.
- **FR-030**: The feature MUST update developer and user documentation for desktop setup, cloud-only agent policy, Linear/internal ticket workflows, Symphony assignment, security model, and known parity gaps.
- **FR-031**: The feature MUST include desktop release workflows comparable to Slay Zone's release flow: CI validation, dry-run release, publish release, multi-platform Electron packaging, macOS signing/notarization, artifact manifests/checksums, and channel publishing.
- **FR-032**: Release workflows MUST validate required publish secrets before packaging and provide dry-run artifacts without requiring production signing publication.

### Key Entities *(include if feature involves data)*

- **Desktop Installation**: Native app profile for a Matrix instance, including connection target, app preferences, update state, and local-only desktop UI settings.
- **Desktop Runtime Policy**: Server-declared capabilities and constraints, including enforced cloud-only agent execution and allowed desktop surfaces.
- **Cloud Project**: Matrix-owned project binding to a repository, workspace, ticket sources, worktrees, sessions, previews, and runtime settings.
- **Repository Workflow**: Project-owned setup/live/test/review instructions, preview port policy, and runner prerequisites used by Symphony and cloud workspaces.
- **Codex Runtime Credential**: Server-side credential/readiness state for cloud Codex execution, scoped to the authorized Matrix runtime and never exposed to desktop/browser clients.
- **Cloud Worktree**: Isolated cloud development workspace for a branch/ticket/run, with lease and lifecycle status.
- **Cloud Agent Session**: Matrix-controlled coding-agent process running in cloud/VPS runtime, observable and controllable from desktop.
- **Ticket Source**: Linear or Matrix-native source configuration that produces tracked tickets.
- **Tracked Ticket**: Unified Matrix representation of external or internal work, preserving source identity, sync state, status, assignees, labels, artifacts, and history.
- **Symphony Assignment Rule**: Manual or automatic rule that determines which tickets Symphony may claim.
- **Symphony Run**: Execution lifecycle linking a tracked ticket, worktree claim, cloud agent session, status events, retries, and handoff.
- **Task Workbench Tab**: Desktop UI context for a ticket/project/session, including panels, active resource, and restore state.
- **Operator Event**: Bounded audit/status event for ticket sync, assignment, session control, automation, settings, and security-sensitive changes.
- **Shared Board Membership**: Authorization relationship between a Matrix user/team and a project board, including role, assignment permissions, and runner claim permissions.
- **Desktop Release Channel**: Distribution target for signed desktop artifacts, manifests, checksums, and update metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open the desktop app, connect to a Matrix instance, launch the app launcher, open Symphony, open Workspace, and open at least three installed apps in under 3 minutes from a clean desktop profile.
- **SC-002**: In automated validation, the desktop app cannot start or configure a local coding-agent process; all agent starts route through Matrix cloud/session APIs.
- **SC-003**: A user can sync at least 100 Linear tickets and 100 Matrix-native tickets into one project board while preserving source identity and avoiding duplicate active tickets.
- **SC-004**: Assigning 10 eligible tickets to Symphony with concurrency set to 3 starts no more than 3 active cloud agents and creates zero duplicate active claims for the same ticket.
- **SC-005**: Symphony run status changes become visible in the desktop app within one realtime event delivery or within 5 seconds of reconnect/poll fallback.
- **SC-006**: After a gateway restart and desktop reconnect, active tickets, worktrees, sessions, and Symphony runs reconcile to a user-visible state without manual cleanup.
- **SC-007**: Browser/desktop-visible responses for setup, ticket sync, worktree/session, Symphony, and integrations contain zero provider secrets, raw provider errors, raw database errors, or filesystem paths in security tests.
- **SC-008**: A full P1 development loop can be completed from desktop without Slay Zone: sync/create ticket, open cloud worktree, assign to Symphony, observe cloud agent, inspect artifact/preview, and mark the ticket ready for handoff.
- **SC-009**: User-facing documentation identifies at least 95% of Slay Zone-equivalent workflows and either maps each to a Matrix desktop workflow or marks it as intentionally changed because Matrix runs agents only in the cloud.
- **SC-010**: A repository can define setup/live commands and approved preview ports, and a user can open a live cloud preview from the desktop app after Symphony or a terminal starts the dev environment.
- **SC-011**: Codex readiness checks prevent unattended Symphony dispatch when cloud Codex credentials are missing and show an operator-safe remediation state.
- **SC-012**: A dry-run desktop release produces downloadable platform artifacts, checksums, and a release manifest; a publish release validates signing/notarization secrets before packaging.
