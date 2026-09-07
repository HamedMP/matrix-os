# Feature Specification: Collaboration and Session Sharing

**Feature Branch**: `codex/121-collaboration-session-sharing`
**Created**: 2026-09-07
**Status**: Draft — rewritten product specification with phased implementation plan
**Input**: Rewrite the shared-project specification with whole-project sharing, standalone Chat and terminal sharing, common collaboration behavior, and first-release collaborative Chat interactions.
**Source**: [PR #1325](https://github.com/HamedMP/matrix-os/pull/1325), [original spec at reviewed revision](https://github.com/HamedMP/matrix-os/blob/3dcec8d89fa7bea044885b2b36cb5efd3aa1bce5/specs/117-shared-project-workspace/spec.md). This document is a proposed replacement; it does not modify or close that PR.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share an Entire Project (Priority: P1)

As an owner, I want to share a new or existing project with another Matrix user so we work from one authoritative project, including its files, Chats, apps, layout, and terminal sessions.

**Why this priority**: Project sharing establishes a complete shared working context with understandable membership and no independently writable personal copies.

**Independent Test**: Share a populated project with an editor and viewer, accept from separate accounts, and verify all listed project contents and a subsequently created Chat inherit project access.

**Acceptance Scenarios**:

1. **Given** a private project with files, Chats, apps, layout, and project-owned terminals, **when** its owner starts sharing, **then** one confirmation lists all those contents, identifies the invited users and roles, and explains that current and future project contents inherit access; there are no item-selection checkboxes or exclusions.
2. **Given** that confirmation, **when** the owner cancels, **then** no sharing transition or invitation is committed; **when** they confirm and the transition succeeds, **then** each invitee receives a pending invitation describing the entire project and their role.
3. **Given** a pending invitation, **when** the invitee accepts, **then** the project appears under `Shared with me` and all its contents are accessible according to that role; unaccepted invitations grant no access.
4. **Given** an accepted editor and viewer, **when** the editor saves a project file, **then** both subsequently read the same saved content without synchronizing personal copies.
5. **Given** a shared project, **when** an authorized participant creates a file, Chat, app instance, layout node, or terminal in it, **then** the new item inherits project membership without a separate sharing flow.
6. **Given** a project Chat or terminal, **when** a member opens sharing information, **then** it shows inherited project access and routes membership management to the project; it offers no private child exception.
7. **Given** an existing personal project, **when** sharing succeeds, **then** the shared workspace becomes authoritative and a retained source copy is labeled as a backup; **when** the transition fails, **then** the original stays authoritative and usable with no collaborator access to staged content.
8. **Given** project contents change after confirmation is displayed but before confirmation is committed, **when** the owner confirms, **then** the inventory refreshes and requires confirmation of the current whole-project scope. Contents added after successful sharing inherit the access already explained in the confirmation.
9. **Given** any project-owned item cannot safely participate in sharing, **when** the owner tries to confirm, **then** the entire transition is blocked with an actionable explanation; Matrix must not silently omit that item or share the rest.

### User Story 2 - Share Only One Chat or Terminal (Priority: P1)

As an owner, I want to invite someone into a single Chat or terminal without sharing its containing private project, other sessions, or personal computer.

**Why this priority**: The same collaboration capability must be usable from the current conversation or terminal without requiring whole-project sharing.

**Independent Test**: Share one Chat and, separately, one eligible terminal from a private project. Verify access to each selected item while sibling sessions, referenced files, the parent project, and unrelated resources stay inaccessible.

**Acceptance Scenarios**:

1. **Given** a private Chat, including one in a private project, **when** the owner shares it and an invitee accepts, **then** only that Chat becomes accessible, including its shared conversation history and live Chat interactions; no project membership is created.
2. **Given** an eligible terminal, **when** its owner shares it and a participant accepts, **then** the participant attaches to that same session and receives only the permitted session capabilities, with no access to session creation, sibling terminals, or the parent project.
3. **Given** a shared Chat references a private file, attachment destination, app, or terminal, **when** a participant follows the reference, **then** that reference grants no access to the separate resource. Material already embedded in the visible conversation remains part of the shared Chat; external destinations do not become shared.
4. **Given** a selected Chat or terminal contains partial history or output the owner would prefer to exclude, **when** they share the item, **then** there is no selective transcript or replay-sharing mode: the complete item is shared subject to existing retention, or sharing is cancelled.
5. **Given** two independently shared items, **when** membership is changed on one, **then** the other item's membership and any project membership remain unchanged.
6. **Given** a terminal or Chat execution context can reach unrelated private resources, **when** sharing is requested, **then** Matrix must establish the selected-item boundary before granting access or report sharing unavailable. It must not silently expose the wider runtime, replace the selected session, or claim that choosing a working directory provides isolation.
7. **Given** a standalone-shared item later joins a shared project, **when** the owner confirms the scope transition, **then** access changes to project inheritance as one guarded transition. Existing item-only invitees must not silently become project members; grants outside the resulting project membership end rather than survive as child exceptions.

### User Story 3 - Work Together in the Same Chat (Priority: P1)

As an owner or editor, I want to discuss work with collaborators and explicitly ask the AI to act within one shared conversation, with predictable ordering and clear responsibility.

**Why this priority**: Shared Chat is a first-release collaboration experience alongside Terminal, rather than merely shared history delivered later.

**Independent Test**: Two editors exchange human messages while an AI request runs, submit additional AI requests concurrently, and inspect ordering, authorship, approvals, cancellation, retry, and private drafts from separate clients.

**Acceptance Scenarios**:

1. **Given** a shared Chat, **when** a participant sends a message or requests AI work, **then** all members see the named human initiator and can distinguish human messages from AI output.
2. **Given** an owner or editor composing a message, **when** they choose human discussion, **then** the message is shared without starting AI work; an explicitly chosen AI request enters the execution flow.
3. **Given** AI work is running, **when** two editors submit new AI requests, **then** both accepted requests appear once in a common visible queue with their authors and accepted order; only one request executes at a time in that Chat.
4. **Given** a request cannot be accepted, **when** submission fails or the queue is full, **then** its author sees an explicit recoverable failure and retains their unsent text; other members must not see it as accepted work.
5. **Given** queued work, **when** a participant reconnects, **then** they recover the same accepted order and current run state without duplicating a request or replaying completed work.
6. **Given** a pending approval, **when** members inspect it, **then** they see its pending or decided state and the authorized controls from the role matrix below. Only one valid decision takes effect, and everyone sees who decided it.
7. **Given** active, pending, failed, or cancelled work, **when** an authorized participant cancels or retries through an available control, **then** everyone sees the resulting state and actor; retry creates an identifiable new attempt, not a rewritten history entry.
8. **Given** two people compose simultaneously, **when** either types, changes message mode, or discards a draft, **then** the other person's draft is unaffected and no unsent draft content is visible to collaborators.
9. **Given** an editor becomes a viewer or loses access before a queued request starts, **when** that request reaches the front, **then** current permissions are checked and unauthorized work is not started; eligible members see an explicit non-executed state.
10. **Given** a viewer opens a shared Chat, **when** they attempt discussion, AI submission, approval, cancellation, retry, or another mutation, **then** it is rejected without changing the Chat.

### User Story 4 - Observe and Pass Terminal Control (Priority: P1)

As an owner or editor, I want to watch the same live terminal and deliberately pass keyboard control without starting another process.

**Why this priority**: Shared process output and predictable control are core session-sharing behavior for both project and standalone terminals.

**Independent Test**: Attach two editors and a viewer to one terminal, transfer control, disconnect the controller, revoke a participant, and verify output continuity and access restrictions.

**Acceptance Scenarios**:

1. **Given** an authorized participant attaches, **when** the terminal is live, **then** they receive bounded retained output followed by the same ordered live output as other participants.
2. **Given** one participant controls input, **when** another requests control, **then** release or an authorized takeover transfers control as one operation; delayed input from the former controller is rejected.
3. **Given** two editors request control simultaneously, **when** a controller is selected, **then** at most one can send accepted input and everyone sees the current controller.
4. **Given** a controller disconnects, **when** their time-bounded control expires, **then** another eligible participant can acquire control without restarting the terminal.
5. **Given** a viewer attaches, **when** they attempt keyboard input, paste, resize that affects other participants, creation, takeover, or stop, **then** the terminal is unchanged.
6. **Given** access is revoked, **when** revocation completes, **then** the participant's attachment closes, their input control ends, retained replay becomes inaccessible, and reconnect fails.
7. **Given** a terminal exits, **when** participants view it, **then** they see the same exit state and retained replay remains restricted to current members.
8. **Given** a personal process or terminal is merely linked from a project but is not owned by it, **when** that project is shared, **then** the process remains personal and the confirmation identifies the reference as external. An actually project-owned terminal cannot be hidden under this exception; Story 1's all-or-nothing transition applies.

### User Story 5 - Review Shared Work Without Changing It (Priority: P1)

As an owner, I want a viewer to inspect everything within the selected share boundary without gaining direct or indirect write access.

**Why this priority**: Read-only access must hold consistently across files, Chats, apps, agents, and terminals.

**Independent Test**: Invite a viewer at each sharing scope, then exercise every permitted read and attempted mutation using both visible controls and direct access attempts.

**Acceptance Scenarios**:

1. **Given** a project viewer, **when** they browse files, Chats, app views, layout, or terminal output, **then** they can read shared content but cannot edit files, send messages, invoke AI work, change shared layout, or mutate app data.
2. **Given** an app exposes a mutating control, **when** it tries to act for a viewer, **then** permission is enforced independently of the visible control and no state changes.
3. **Given** a viewer uses search, recent activity, a stale link, or an old client, **when** they access content, **then** only the authorized share boundary is visible and personal resources are not disclosed.
4. **Given** an app cannot enforce the current participant's role, **when** it is opened, **then** Matrix displays it as unavailable rather than permitting wider access. The app stays a project-owned item in the shared inventory; this does not create an owner-selected exclusion.

### User Story 6 - Share Project Apps and Spatial Context (Priority: P2)

As a project participant, I want the project's app instances, app data, and shared layout to belong to the same workspace as its files, Chats, and terminals.

**Why this priority**: This retains the original project's broader collaboration scope while Chat and Terminal remain independently useful P1 journeys.

**Independent Test**: Open a shared project as two members, modify an app's data and a layout node, and verify shared state alongside independent personal view state.

**Acceptance Scenarios**:

1. **Given** a project app, **when** an editor changes its project-owned data, **then** other authorized members subsequently see the same state.
2. **Given** shared layout nodes, **when** an editor changes placement or adds a project app, **then** the common layout updates without replacing another member's viewport, selection, or focus.
3. **Given** personal apps, databases, or Chats outside the project, **when** a project is shared, **then** those resources remain outside its boundary.
4. **Given** members read a project Chat, **when** one changes read position, pin, mute, or last-opened state, **then** the other member's personal state is unaffected.

### User Story 7 - Manage Membership and Lifecycle (Priority: P2)

As an owner, I want to manage access and retain ownership, export, deletion, and recovery guarantees for a shared project or standalone item.

**Why this priority**: Membership management is one common capability across scopes. Its security guarantees are prerequisites for every P1 journey even where management UI is delivered in P2.

**Independent Test**: Change roles and revoke access on project and standalone shares, then exercise expiry, archive, deletion, export, and failed transitions while participants are connected.

**Acceptance Scenarios**:

1. **Given** an active editor, **when** the owner downgrades them to viewer, **then** current and new interactions lose write authority and terminal control while authorized reads remain available.
2. **Given** an active member, **when** the owner revokes access, **then** all live connections for that scope close and later access fails; delayed client input cannot be replayed after revocation.
3. **Given** repeated or simultaneous invite, accept, role-change, or revoke requests, **when** they settle, **then** there is one consistent membership outcome, with no duplicate memberships or contradictory permissions.
4. **Given** the owner inspects security activity, **when** membership, terminal-control, or lifecycle changes have occurred, **then** bounded content-free records identify the actor, action, scope, and outcome without exposing content or credentials.
5. **Given** the owner exports or deletes a shareable resource, **when** the operation completes, **then** only its owned content and required membership metadata are included or removed; unrelated personal data and private drafts are excluded from shared exports.
6. **Given** the final owner tries to leave or downgrade themselves, **when** ownership would be lost, **then** the operation requires an explicit transfer or deletion first.
7. **Given** archive, transfer, expiry, deletion, or recovery changes availability, **when** members reopen the resource, **then** they see its current lifecycle state and no stale route grants access.

### Edge Cases

- Self-invitation, nonexistent users, duplicate pending invitations, expired invitations, and already active members.
- A standalone Chat or terminal belongs to a private project, or moves into a shared project after receiving direct grants.
- A project inventory changes during confirmation, or contains an item that cannot safely become shared.
- Existing project Chats include personal resource links or hidden execution context outside the project.
- A shared terminal's process can access private resources despite starting in a project directory.
- Two people submit, cancel, retry, approve, or request terminal control simultaneously.
- Requests arrive again after reconnect or settle after access changes, resource deletion, or controller transfer.
- Queue capacity is reached, the active run fails, or the collaboration runtime restarts or becomes unavailable.
- Private drafts, per-person read state, and personal view state are accidentally included in shared updates or exports.
- A project root moves or contains links outside its boundary, oversized content, secrets, dirty source-control state, or active personal processes.
- A stale client or app tries to bypass viewer restrictions or disclose unrelated content through search, replay, or references.
- A transfer fails halfway, a member disconnects without releasing control, or the final owner attempts to leave.

## Requirements *(mandatory)*

### Sharing Scope and Product Rules

| Selected sharing target | Included | Membership source | Not granted by this share |
| --- | --- | --- | --- |
| Project | All project-owned files/documents, Chats, apps/data, layout, and terminals; future contents inherit access | Project membership, inherited by every contained item | Other projects, personal home, external linked resources, personal credentials and system state |
| Standalone Chat | That Chat's shared history, live messages, queue, run/approval state, and embedded conversation content | Membership on that Chat | Parent project, separate attachment/file destinations, linked apps/terminals, sibling Chats, private drafts or hidden personal context |
| Standalone terminal | That same terminal's retained output, live output, lifecycle, and role-permitted input control | Membership on that session | Parent project, separate file access, sibling sessions, terminal creation, unrelated runtime resources |

A whole-project share has one inventory confirmation, never a content-selection flow. Existing and new contents inherit access. A standalone share has no excerpt-selection flow. References to external resources do not change resource ownership or confer access. All-or-nothing scope does not override each member's role or the existing app safety checks.

### Role and Action Matrix

This specification retains exactly three roles. Permissions apply only within the selected scope.

| Capability | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Read shared Chat history, run state, and permitted terminal replay/output | Yes | Yes | Yes |
| Read project files, apps, and layout | Project share only | Project share only | Project share only |
| Write project files, layout, or app data | Project share only | Project share only | No |
| Send human messages or explicit AI requests | Yes | Yes | No |
| Cancel queued requests or active AI runs; retry eligible requests | Any in scope | Their own requests | No |
| Decide AI approvals | Owner, subject to existing action policy | No | No |
| Create terminals | Project share only | Project share only | No |
| Request or hold terminal input control | Yes | Yes | No |
| Release terminal control | Their held control | Their held control | No |
| Take control from another participant | Yes | With current controller's release or after expiry | No |
| Stop a terminal | Any in scope | Only terminals they created | No |
| Invite, change roles, revoke, archive, transfer, or delete shared resources | Yes | No | No |

Owners and editors each retain private composer drafts and personal view state. Reading and personal navigation do not change shared content. Viewer cannot send discussion messages, reactions that mutate shared state, or AI requests. Input-capable terminal access is execution authority within the selected boundary; Matrix does not classify arbitrary commands as read-only.

### Functional Requirements

#### Common scope and membership

- **FR-001**: Matrix MUST support sharing an entire project, a standalone Chat, or a standalone terminal with supported Matrix identities, using the same invitation, acceptance, role, membership-display, revocation, and audit semantics.
- **FR-002**: The three entry points MUST consume one common collaboration authority; independent app-specific permission rules MUST NOT produce different outcomes for the same actor, scope, role, and action.
- **FR-003**: Project sharing MUST present one complete inventory confirmation and grant access to all project-owned contents together without item exclusions; failure of any required transition MUST grant no partial project access.
- **FR-004**: Existing projects MUST be shareable after creation. All future project-owned contents MUST inherit current project membership; contained items MUST NOT offer separate role overrides or private exceptions.
- **FR-005**: A standalone share MUST grant access only to the selected whole Chat or terminal; containment, links, and references MUST NOT implicitly grant access to other resources or the containing project.
- **FR-006**: Before changing from item membership to project inheritance, Matrix MUST show the resulting scope and membership effects for owner confirmation, end conflicting item-only grants, and prevent silent promotion of item-only participants to project membership.
- **FR-007**: The owner MUST invite with an explicit editor or viewer role; the invitee MUST see owner, target scope, role, and data/execution implications and accept before gaining access.
- **FR-008**: Membership operations MUST be idempotent and maintain one consistent effective membership per actor and scope, including concurrent changes and expiry.
- **FR-009**: Every read, write, live attachment, subscription, replay, and action MUST verify the authenticated actor, current effective membership, role, resource identity, and lifecycle. Client-supplied identity, roles, paths, and runtime references MUST NOT establish authority.
- **FR-010**: Only the owner MUST manage membership and shared lifecycle. The final owner MUST NOT leave or downgrade without explicit ownership transfer or deletion.

#### Shared Chat

- **FR-011**: Shared Chat MUST be P1 alongside Terminal and support identical interaction semantics under project inheritance or standalone membership.
- **FR-012**: All authorized members MUST see one canonical shared history and active-run state. Human messages, AI requests, approval decisions, cancellations, and retries MUST identify their initiating human; AI output MUST be distinguishable from human authorship.
- **FR-013**: Owners and editors MUST explicitly choose between human discussion and requesting AI work. Human discussion alone MUST NOT trigger a new AI run.
- **FR-014**: Accepted AI requests MUST enter one visible ordered queue per Chat, with at most one executing request at a time. Concurrent submissions and reconnect retries MUST NOT lose, duplicate, or silently reorder accepted work.
- **FR-015**: Queue entries MUST show author, accepted order, and lifecycle state. Submission failure or capacity rejection MUST be visible to the author and preserve unsent input. The initial limit is 32 pending AI requests per Chat; running and historical requests do not consume pending capacity.
- **FR-016**: Approval, cancellation, and retry MUST enforce the action matrix at the moment the action takes effect, publish one consistent outcome to members, and reject conflicting late decisions. Retry MUST remain a distinct attempt associated with the original request.
- **FR-017**: Every participant's unsent composer draft and composing mode MUST remain private and independent. Read position, pin, mute, last-opened, and comparable presentation state MUST remain per member.
- **FR-018**: Queued requests MUST be reauthorized immediately before execution; revoked or downgraded authors MUST NOT start work they can no longer request. Reconnection or recovery MUST expose the actual accepted, running, failed, cancelled, or completed state rather than inventing success or replaying work.
- **FR-019**: Viewers MUST NOT send discussion, mutate reactions, request AI work, decide approvals, cancel, or retry. Shared Chat permission MUST NOT authorize private files, hidden personal context, or unrelated tools through the AI.

#### Terminal sharing

- **FR-020**: A shared terminal MUST retain a stable session identity, one process/lifecycle truth, and ordered bounded replay and live output for current authorized members.
- **FR-021**: At most one eligible participant MUST control terminal input at a time. Control MUST be time-bounded, displayed to members, transferable under the role matrix, and recoverable after disconnection.
- **FR-022**: Transfer MUST reject old-controller input, including delayed paste and resize operations. Input, paste, creation, attachment, takeover, resize, stop, and replay MUST each enforce the applicable role and scope.
- **FR-023**: Viewer terminal access MUST mean observation only. An editor's input MUST remain inside the selected execution boundary; a working-directory change alone MUST NOT be treated as isolation.
- **FR-024**: Project sharing MUST NOT automatically expose personal processes or terminals merely referenced by the project. Every actually project-owned terminal MUST participate in the whole-project transition or block it. Standalone sharing MUST NOT silently replace the selected terminal with a new process.

#### Project context, isolation, and lifecycle

- **FR-025**: A shared project MUST have one authoritative folder and project-owned state, isolated from every participant's unrelated personal files, Chats, terminals, apps, credentials, identity, and system state. It MUST NOT expose independently writable personal copies as the same live project.
- **FR-026**: Project paths, moved roots, symbolic links, searches, recent activity, exports, and stale references MUST NOT escape the selected sharing boundary.
- **FR-027**: Editors MUST be able to read and write project files; viewers MUST be prevented from direct or indirect writes through files, uploads, source control, agents, apps, and terminals.
- **FR-028**: Project app instances and their data MUST be common to members and enforce their effective role. An app unable to enforce that role MUST be unavailable rather than grant broader access. Personal app data MUST NOT be copied or exposed automatically.
- **FR-029**: Project layout and app references MUST remain shared, with each member retaining their own viewport, selection, and focus. This preserves the original shared-layout model.
- **FR-030**: A successful personal-to-shared transition MUST establish one declared authority and label retained personal copies as backups. Failed transitions MUST preserve the usable original and expose no staged content to collaborators.
- **FR-031**: Downgrading an editor MUST end write authority and terminal control without removing authorized reads. Revocation MUST reject subsequent access and terminate affected live connections within the stated revocation bound, with no acceptance of delayed mutations after the authoritative change.
- **FR-032**: Invite, acceptance, role, control-transfer, archive, transfer, export, and deletion actions MUST produce bounded content-free audit records. Shared exports MUST contain owned content and necessary membership metadata, excluding private drafts and unrelated participant data.
- **FR-033**: Archive, expiry, transfer, export, and deletion MUST preserve explicit ownership and consistent access. Deletion MUST remove only the selected owned resource and its eligible state, leaving unrelated participant data intact.

#### Delivery and recovery

- **FR-034**: Shared changes MUST become visible to currently authorized subscribers only after authoritative acceptance. Delivery MUST recover through bounded replay or refresh, isolate failed recipients, remove stale connections, and drain on shutdown.
- **FR-035**: All invitation, membership, file, Chat, queue, app, terminal, replay, and realtime inputs MUST have validated types and explicit size/capacity limits. User-facing failures MUST be safe and bounded, without private paths, credentials, host details, provider errors, or database internals.
- **FR-036**: Web Canvas, Web Desktop, and Electron Desktop MUST expose equivalent sharing scope, actions, copy, and loading/empty/disabled/error/recovery semantics. Web Mobile and Native Mobile MUST provide parity wherever the affected capability exists; CLI MUST use the same membership and authorization rules. Physical layout may adapt without duplicating business rules.
- **FR-037**: Initial shared scopes MUST support one owner and up to seven invited collaborators. Capacity limits MUST never evict an existing member or grant broader access as a fallback.
- **FR-038**: Implementation MUST include tests of the full owner-invite-accept-read-act-downgrade-revoke flow for every scope, plus whole-project inheritance and standalone isolation, using distinct accounts and applicable surfaces.

### Key Entities *(include if feature involves data)*

- **Sharing Scope**: A project, one Chat, or one terminal; identifies exactly what is shared and where effective membership comes from.
- **Shared Project Workspace**: The isolated authoritative project folder and its owned files, Chats, terminals, apps/data, and layout.
- **Membership and Invitation**: Actor, owner, scope, editor/viewer/owner role, pending or accepted state, and acceptance/change/revocation/expiry history.
- **Project Inventory Confirmation**: The complete scope shown to the owner before sharing, including inheritance and any membership-transition effects; never a partial selection.
- **Shared Chat**: Canonical shared messages, human authorship, AI requests, run state, and separate per-member read/presentation state.
- **AI Request and Attempt**: Initiating human, accepted order, execution state, and distinct retry attempts within one Chat.
- **Approval Decision**: Pending action, authorized decision-maker, outcome, and attribution, governed by existing action policy and the collaboration role matrix.
- **Private Composer Draft**: Unsent text and composing mode visible only to its author.
- **Shared Terminal and Control Lease**: Stable session identity, process lifecycle, bounded output, attached participants, and one time-bounded current input controller.
- **Shared App and Layout**: Project-owned app state and common spatial nodes, separate from personal viewport and selection.
- **Audit Event**: Bounded content-free evidence of a security-sensitive action within a specific scope.

### Security Architecture and Authorization Boundary

Authentication identifies the actor; current membership and the role matrix authorize the action. Every collaboration surface, resource reader, app action, and agent/terminal execution path must apply that same authority. No anonymous collaboration access is introduced. This product spec introduces no route names or transport contracts; the implementation plan must enumerate every route, live connection, and tool in the auth matrix required by `specs/quality-gates.md` before implementation.

Personal credentials, identity, system configuration, and hidden personal execution context remain outside sharing. Existing credential and execution policy remains authoritative; this rewrite adds no funding model or credential-management product. A Chat or terminal that cannot enforce the selected scope must remain unavailable for sharing until it can, rather than granting wider access or offering partial sharing.

### Integration Wiring and Verification Boundary

The runtime path is: authenticated participant enters through a supported surface, common collaboration authority resolves direct or inherited membership, the authoritative resource applies the authorized operation, then accepted state reaches authorized members. Chat requests continue through the existing AI execution path and terminal input through the session's current controller. Personal drafts and personal view state never enter shared delivery.

Before implementation, the plan must describe initialization order, dependency ownership, configuration injection, cross-component communication, and shutdown order for those boundaries. Full integration acceptance must follow that path from invite through live use and revocation using separate accounts, including direct-access attempts. Applicable Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile, and CLI evidence must be recorded separately; customer-runtime verification uses a disposable VPS-native environment.

### Failure Modes and Resource Management

Concurrent membership changes, queue admission, approvals, control transfer, and lifecycle operations require guarded all-or-nothing outcomes. A failed transition may retain an inaccessible staged workspace or labeled backup only while the original remains authoritative and no collaborator can access staged content. Two active authorities, duplicate accepted AI work, or multiple input controllers are unacceptable.

The plan must assign finite operation timeouts, invitation/connection limits, replay retention, cleanup of staging/temporary artifacts, and stale-controller/subscriber expiry. The membership and pending-queue limits above are product limits; further buffer and cleanup values belong to planning. Crashes and reconnects must preserve truthful recoverable state, discard no private drafts silently, and never replay work without rechecking current permission. Failures reach the affected participant with safe recovery guidance rather than hidden success.

### Assumptions and Dependencies

- Owner/editor/viewer remains the complete role set. To make accepted run controls testable, the initial default is owner-only approval decisions and editor cancellation/retry of their own requests; existing action policy can further restrict, never enlarge, these permissions.
- Whole-project means all project-owned content. A reference to an external resource is not ownership; an actual project-owned resource cannot be excluded by relabeling it as a reference.
- Direct membership supports items outside shared projects. Once an item is in a shared project, project membership is its sole collaboration authority; conversion must explicitly reconcile earlier direct grants.
- Shared projects require a healthy compatible runtime. No infrastructure isolation mechanism, new billing model, spending controls, or personal credential transfer is prescribed here.
- Shared Chat relies on canonical Chat identity/history, existing run/approval behavior, and project identity. Terminal sharing relies on stable session identity, bounded replay, control, and a proven execution boundary.
- P1 delivers whole-project membership/inheritance, standalone sharing, Chat, Terminal, and viewer enforcement. P2 app/layout and management stories retain original scope; existing project-owned content cannot be silently excluded while a P2 surface is pending. Unsupported whole-project transitions stay unavailable until all present contents can satisfy the scope promise.
- Test-first implementation and a separate public documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` are explicit implementation deliverables. No public site tree is created in this repository.

### Approved Incremental Delivery

The usable internal milestones are (1) shared Chat history and human discussion with shared AI disabled, (2) shared AI requests and controls, (3) standalone terminal sharing, and (4) whole-project sharing. Each milestone can be merged, enabled for an internal cohort, used and tested while later work continues. Smaller supporting PRs remain dormant until their connected milestone is ready.

This sequence is delivery order, not a reduction of the final P1/P2 scope. Discussion-only M1 is not full P1 completion. Whole-project sharing stays unavailable until every owned resource can participate; no stage introduces partial sharing. Authorization, revocation, isolation, recovery and applicable surface parity are prerequisites for each enabled capability.

[plan.md](plan.md) defines the technical design and [delivery-plan.md](delivery-plan.md) defines the proposed PR boundaries, dependencies, acceptance gates and rollback. API and execution contracts are planning artifacts alongside this product spec.

### Explicitly Out of Scope

- Commenter/custom roles or viewer discussion permissions.
- Partial project sharing, per-child exclusions/role overrides, transcript excerpt selection, or selective content migration.
- Standalone document/file sharing, new document comments/suggestions/version-history features, or simultaneous character editing/cursor presence.
- Replacing the original shared project layout with personal layouts by default, or adding follow-participant mode.
- A new collaboration billing, budgeting, credential-selection, or running-agent revocation-policy product; existing policy continues to apply alongside the required access checks.
- Independently writable offline project peers or bidirectional synchronization of personal copies.
- Automatic exposure or live migration of unrestricted personal processes and terminals, personal homes, credentials, or system state.
- Anonymous public links, custom organization-wide policies, outside identity federation, or automatic public project publishing.
- Runtime implementation or deployment as part of this specification and planning PR.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For each sharing scope, an owner can invite and a recipient can accept and open it in under three minutes, excluding runtime provisioning time.
- **SC-002**: In all whole-project acceptance cases, one confirmation lists every current project-owned item with zero exclusion controls, and 100% of contents created after sharing inherit membership without further invitations.
- **SC-003**: Standalone Chat and terminal acceptance tests grant access to the selected item and zero unauthorized access to parent projects, sibling resources, separate file destinations, or unrelated personal context, including through agent and terminal actions.
- **SC-004**: In two-user project tests, an editor's saved file is visible to the other member on their next read with no manual copy or sync step.
- **SC-005**: In concurrent Chat tests, every accepted AI request appears exactly once in the same order for all members, no two requests execute simultaneously in the same Chat, and every human-discussion message starts zero AI runs.
- **SC-006**: Every shared human message and run-control decision displays its actor; 100% of draft-isolation tests reveal no unsent draft content to another member.
- **SC-007**: For eight connected members under normal network conditions, 95% of accepted Chat messages and terminal output become visible within two seconds without losing accepted state.
- **SC-008**: Terminal control transfers within three seconds between connected eligible participants, and concurrent-control tests observe at most one accepted controller.
- **SC-009**: Role-matrix tests reject 100% of unauthorized mutations, including viewer discussion, AI requests, approvals, app writes, terminal input/paste/creation/takeover/stop, and editor attempts to manage membership or decide approvals.
- **SC-010**: Successful revocation rejects new access and delayed mutations immediately at the authority boundary and closes all tested affected live connections within 60 seconds, without restarting the shared resource.
- **SC-011**: Every tested failure stage of a sharing transition preserves the usable original with zero partial collaborator access; inventory changes before commit require updated whole-project confirmation.
- **SC-012**: Queue-full, reconnect, retry, simultaneous approval, downgrade-before-dispatch, and restart scenarios yield explicit consistent outcomes with zero silently lost accepted requests or duplicate execution caused by recovery.
- **SC-013**: In moderated review, at least 90% of participants correctly identify whether they received a project or a single item, their role, and whether their next Chat message will request AI work before acting.
- **SC-014**: Export, deletion, inheritance, and membership-transition acceptance tests preserve ownership and reveal or remove zero unrelated personal resources; project app/layout tests preserve the shared-state and personal-view separation.
