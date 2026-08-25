# Feature Specification: Shared Project Workspace

**Feature Branch**: `codex/shared-project-workspace-spec`
**Created**: 2026-08-25
**Status**: Draft — under review
**Input**: Share one Matrix project between users so they work from the same authoritative folder and can share project chats, apps, and live terminal sessions with explicit read-only or read/write access.

## Product Decision Under Review

A shared project is one isolated collaboration workspace, not a synchronized copy of each collaborator's personal project. All participants connect to the same authoritative project folder, project-bound chats, workspace layout, shared app instances, and named terminal sessions.

The initial access model has three roles:

| Capability | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Read project files | Yes | Yes | Yes |
| Write project files | Yes | Yes | No |
| Read project chats | Yes | Yes | Yes |
| Send project chat messages | Yes | Yes | No |
| Use shared app instances | Yes | Yes | Read-only actions only |
| Observe terminal output and replay | Yes | Yes | Yes |
| Create a terminal | Yes | Yes | No |
| Request or hold terminal input control | Yes | Yes | No |
| Stop a terminal | Any project terminal | Terminals they created | No |
| Invite, change roles, revoke, archive, or delete | Yes | No | No |

Terminal observation is read-only. Matrix does not attempt to classify shell commands as "read" or "write." A user who can send terminal input is an editor and receives the project's write authority.

## User Scenarios & Testing

### User Story 1 - Share One Authoritative Project (Priority: P1)

As a project owner, I want to invite another Matrix user into a project so both of us see and work from the same folder rather than maintaining diverging copies.

**Why this priority**: A single authoritative workspace is the foundation for trustworthy collaboration. Chats, terminals, and apps cannot be meaningfully shared if each participant works against a different project state.

**Independent Test**: The owner shares a project with an editor, both users open it from separate Matrix sessions, one edits a file, and the other sees the same saved content without a manual sync or copy step.

**Acceptance Scenarios**:

1. **Given** an eligible personal project, **when** the owner shares it with a valid Matrix user as an editor, **then** the invitee receives a pending invitation that identifies the project, owner, role, and access implications.
2. **Given** a pending invitation, **when** the invitee accepts it, **then** the project appears under `Shared with me` and opens in its collaboration workspace.
3. **Given** two participants viewing the same shared project, **when** an authorized participant saves a file, **then** subsequent reads by both participants return the same authoritative content.
4. **Given** an existing project is moved into shared authority, **when** the transition completes, **then** Matrix identifies the shared workspace as authoritative and does not silently continue writing to a personal peer copy.
5. **Given** a sharing transition fails, **when** the owner returns to the project, **then** the original personal project remains authoritative and usable with no partial collaborator access.
6. **Given** a project contains active personal terminal sessions, **when** it becomes shared, **then** those sessions remain personal and are not exposed; shared terminal sessions begin only inside the collaboration workspace.

---

### User Story 2 - Collaborate in the Same Live Terminal (Priority: P1)

As an owner or editor, I want collaborators to watch the same live terminal and intentionally hand off keyboard control so we can debug, review, and pair without screen sharing.

**Why this priority**: A shared terminal is the clearest distinction between a genuinely shared workspace and ordinary file synchronization.

**Independent Test**: Two editors attach to one named terminal, both receive identical live output, the active controller types a command, and control transfers to the second editor without starting a second terminal process.

**Acceptance Scenarios**:

1. **Given** a shared terminal is running, **when** an authorized participant opens it, **then** they attach to that exact terminal session and receive its bounded replay followed by live output.
2. **Given** two editors are attached, **when** one editor holds control, **then** only that editor's input is accepted while every attached participant continues receiving output.
3. **Given** another editor requests control, **when** the current controller releases it or an allowed takeover occurs, **then** control transfers atomically and pending input from the former controller is rejected.
4. **Given** a viewer is attached, **when** they attempt keyboard input, paste, terminal creation, takeover, or stop, **then** the action is rejected and the terminal is unchanged.
5. **Given** an editor loses network connectivity while holding control, **when** the control lease expires, **then** another editor can acquire control without restarting the terminal.
6. **Given** a user's project access is revoked, **when** revocation succeeds, **then** their terminal attachments close, their control lease ends, and later reconnect attempts fail.
7. **Given** a terminal exits, **when** participants remain attached, **then** all participants see the same exit state and the retained replay remains subject to project access.

---

### User Story 3 - Review Without Editing (Priority: P1)

As an owner, I want to invite a reviewer who can inspect the folder, chats, apps, and terminal output without modifying the project or sending terminal input.

**Why this priority**: Read-only review is a primary collaboration use case and must be a real security boundary, not merely disabled buttons.

**Independent Test**: A viewer reads files, chats, app views, and terminal output, while attempted writes through every supported project surface are rejected and leave no state change.

**Acceptance Scenarios**:

1. **Given** a viewer has accepted access, **when** they browse the project, **then** they can read eligible project files but cannot create, edit, rename, upload, move, or delete them.
2. **Given** a viewer opens project chat, **when** they attempt to send, edit, react through a mutating action, or start an agent run, **then** the action is rejected.
3. **Given** a viewer opens a shared app, **when** the app attempts a project or app-data mutation on their behalf, **then** the mutation is rejected even if the app UI exposes the control.
4. **Given** a viewer observes a terminal, **when** they use direct requests rather than the visible UI, **then** input, paste, creation, takeover, and stop remain unauthorized.
5. **Given** content is not project-scoped, **when** a viewer searches, browses recent activity, or follows a stale link, **then** personal files, chats, terminals, app data, credentials, and system state are not disclosed.

---

### User Story 4 - Share Project Chats, Layout, and Apps (Priority: P2)

As a project participant, I want the project conversation history, spatial workspace, and project apps to follow the project so collaboration has shared context beyond source files.

**Why this priority**: These surfaces turn the folder and terminal into a complete Matrix workspace, but file and terminal collaboration remain independently valuable first.

**Independent Test**: Two participants open the project and see the same project-bound chat, shared workspace nodes, and shared app instance while retaining individual read state and viewport preferences.

**Acceptance Scenarios**:

1. **Given** a chat belongs to the shared project, **when** a member opens it, **then** authorized members see the same canonical history and active-run state.
2. **Given** a personal chat has no shared-project association, **when** a collaborator lists project chats, **then** the personal chat is absent.
3. **Given** collaborators open the shared workspace, **when** one editor changes shared node placement or adds a project app, **then** the shared document updates for other participants without replacing their personal viewport or selection state.
4. **Given** a shared app stores project data, **when** an editor changes that data, **then** all authorized participants subsequently see the same project-owned state.
5. **Given** a personal app or personal app database exists on the owner's personal Matrix computer, **when** a project is shared, **then** it is not copied, mounted, or exposed automatically.
6. **Given** an app cannot enforce the participant's role, **when** a participant tries to open it in the shared project, **then** Matrix blocks the app or presents it as unavailable rather than granting broader access.

---

### User Story 5 - Manage and Revoke Access (Priority: P2)

As the project owner, I want to understand who has access, change roles, and revoke access immediately without deleting shared project data.

**Why this priority**: Collaboration is unsafe without understandable membership, reliable revocation, and durable audit evidence.

**Independent Test**: The owner changes an editor to viewer, verifies write and terminal control are removed, then revokes the member and verifies every live and subsequent project access path closes.

**Acceptance Scenarios**:

1. **Given** an active member, **when** the owner changes their role, **then** new permissions apply to existing and new connections without requiring the project to restart.
2. **Given** an active member, **when** the owner revokes access, **then** live project, chat, app, and terminal connections close and later access fails.
3. **Given** a revoked member had uncommitted client input, **when** revocation occurs, **then** Matrix does not accept or replay that input after revocation.
4. **Given** the owner reviews membership history, **when** they inspect security activity, **then** invite, acceptance, role-change, control-transfer, and revocation events are visible without exposing content or credentials.
5. **Given** the owner archives or deletes the project, **when** the lifecycle action succeeds, **then** collaborator access changes consistently with the project lifecycle and no stale shared route remains usable.

### Edge Cases

- An invitation targets the owner, a nonexistent user, an already active member, or a user with a pending invitation.
- Two owners or devices attempt to change the same member role concurrently.
- Two editors request terminal control at nearly the same time.
- The current terminal controller disconnects without releasing control.
- A role is downgraded while the user is saving a file, sending chat input, or controlling a terminal.
- A project is archived, deleted, transferred, or becomes unavailable while collaborators are connected.
- The collaboration workspace is starting, recovering, offline, out of capacity, or running an incompatible version.
- A project transfer includes symlinks, files outside the project root, oversized files, secrets, dirty Git state, or active personal processes.
- A shared app attempts to access personal app data, personal credentials, or paths outside the project.
- A viewer uses a stale client, direct request, WebSocket frame, deep link, or app bridge to attempt a mutation.
- Terminal replay contains sensitive project output; losing file access must also remove replay access.
- The final owner attempts to leave, downgrade themselves, or delete their own membership while the shared project still exists.

## Requirements

### Functional Requirements

- **FR-001**: Matrix MUST represent a shared project as one authoritative collaboration workspace, not as independently writable synchronized copies.
- **FR-002**: The shared workspace MUST be isolated from every participant's personal Matrix files, chats, terminals, apps, credentials, identity state, and system configuration.
- **FR-003**: The owner MUST be able to invite a Matrix user with an explicit `editor` or `viewer` role.
- **FR-004**: An invitee MUST explicitly accept an invitation before receiving project access.
- **FR-005**: Matrix MUST present the project owner, requested role, shared surfaces, terminal implications, and project-data implications before acceptance.
- **FR-006**: Matrix MUST maintain one active membership per project and participant and MUST make repeated invite, accept, role-change, and revoke operations idempotent.
- **FR-007**: Every project read or mutation MUST validate the authenticated actor, current membership, current role, project lifecycle, and project identity at the authorization boundary.
- **FR-008**: Client-provided owner identity, role, project path, terminal ownership, runtime identity, or forwarded headers MUST NOT grant access.
- **FR-009**: Viewers MUST be able to read eligible project files and MUST be unable to modify project files through file operations, uploads, Git operations, agents, terminals, apps, or indirect bridges.
- **FR-010**: Editors MUST be able to read and write project files while the project is active and available.
- **FR-011**: Matrix MUST prevent project paths, project links, symlinks, or moved roots from granting access outside the authoritative project boundary.
- **FR-012**: Existing personal terminal sessions MUST NOT become shared when a project becomes shared.
- **FR-013**: Every shared terminal MUST belong to exactly one shared project and MUST be discoverable only by currently authorized project members.
- **FR-014**: Authorized participants attached to one shared terminal MUST receive the same ordered live output and an explicitly bounded replay of prior output.
- **FR-015**: Terminal input MUST use a single-writer control lease so at most one participant can send input to a terminal at any time.
- **FR-016**: Owners and editors MUST be able to request terminal control; viewers MUST be observe-only.
- **FR-017**: Terminal control transfer MUST be atomic, must reject input from the former controller after transfer, and must recover from stale controllers.
- **FR-018**: Terminal input, paste, creation, attachment, takeover, resize where applicable, stop, and replay operations MUST each enforce project membership and the applicable role. Owners MAY stop any project terminal; editors MAY stop only terminals they created; viewers MUST NOT stop terminals.
- **FR-019**: Matrix MUST NOT attempt to implement a read-only interactive shell by classifying commands as safe; terminal read-only access means observation without input.
- **FR-020**: Project-bound chats MUST expose one canonical history to authorized members and MUST preserve per-member read, pin, mute, and last-opened state separately.
- **FR-021**: Viewers MUST NOT send project-chat messages, start agent work, answer approvals, or perform other chat mutations.
- **FR-022**: Shared workspace layout and project app references MUST be common to members while viewport, selection, focus, and comparable personal presentation state remain per member.
- **FR-023**: Only project-scoped or explicitly shared app instances and data MAY appear in a shared project.
- **FR-024**: Shared apps MUST receive the participant's effective project role and MUST NOT provide a mutation path that exceeds it.
- **FR-025**: Personal apps, personal app databases, personal chats, personal terminals, and personal credentials MUST NOT be shared implicitly.
- **FR-026**: Changing a member from editor to viewer MUST end terminal input control and reject later writes without ending authorized read access.
- **FR-027**: Revocation MUST terminate the member's active project, chat, app, and terminal connections and MUST reject later reconnects and mutations.
- **FR-028**: Membership, role, terminal-control, archive, transfer, export, and deletion changes MUST create bounded content-free audit events.
- **FR-029**: Shared project lifecycle operations MUST preserve explicit ownership, export, deletion, and transfer semantics and MUST prevent the final owner from leaving without a reviewed transfer or deletion.
- **FR-030**: A failed transition from personal to shared authority MUST leave the original project authoritative and MUST grant no partial collaborator access.
- **FR-031**: A successful transition MUST identify the shared workspace as authoritative and MUST not silently keep another writable project peer active.
- **FR-032**: Personal processes and personal terminal sessions MUST remain personal after transition; users create new shared sessions inside the shared workspace.
- **FR-033**: Every shared mutation that affects realtime state MUST notify authorized subscribers only after the authoritative write succeeds.
- **FR-034**: Realtime delivery MUST isolate failing subscribers, evict dead connections, support bounded replay or refresh recovery, and drain on shutdown.
- **FR-035**: All user-visible failures MUST use safe, bounded messages and MUST NOT expose filesystem paths, credentials, private hosts, provider errors, database details, or other members' private identity data.
- **FR-036**: Invitation, membership, project, chat, file, app, terminal, replay, and realtime inputs MUST be strictly bounded and validated before use.
- **FR-037**: Matrix MUST provide an export containing the shared project's owner-controlled code and eligible project-owned state without including personal participant data beyond required membership metadata.
- **FR-038**: Project deletion MUST remove shared project data according to the confirmed lifecycle action without deleting unrelated participant data.
- **FR-039**: Desktop, browser, mobile, and CLI shells MUST consume the same headless membership and authorization rules, even when individual shells ship the UI at different times.
- **FR-040**: The initial release MUST support at least one owner and up to seven invited collaborators in one shared project without changing the authorization model.

### Access-Control Invariants

- Authentication identifies the actor; it does not by itself establish project ownership or role.
- Project ownership and active membership are independent facts and are checked together.
- Role checks occur on every read, mutation, attachment, and realtime subscription, not only when rendering controls.
- No terminal attached to a personal workspace can be made safe merely by starting it in a project directory.
- A viewer's ability to read project files means terminal output and app views may reveal the same project information; invitation copy must set that expectation.
- Personal and shared authority never merge. Moving a project into shared authority does not make the owner's personal Matrix home collaborative.
- Role downgrade and revocation apply to live connections, not only the next sign-in.
- A stale or forged client projection never overrides server-authoritative membership, role, or control state.

### Data Ownership and Lifecycle Invariants

- **Source of truth**: The shared workspace owns the authoritative project folder and project-owned collaboration state. Platform identity data may locate and authorize the workspace but does not own transcript or project content.
- **Membership source of truth**: One durable membership record determines invitation status and effective role for each participant.
- **Terminal source of truth**: One named terminal session owns its process, output sequence, lifecycle state, and current input-control lease.
- **Concurrency**: Membership changes, role changes, terminal control transfers, and destructive lifecycle changes use guarded writes so concurrent requests cannot grant duplicate or contradictory authority.
- **Acceptable orphan state**: A failed project transition may leave an inaccessible staged shared workspace or retained personal backup, provided the personal project remains the declared authority and no collaborator can access the staged copy.
- **Unacceptable orphan state**: Two independently writable copies both presented as the same shared project, a revoked member retaining a live connection, or a terminal accepting input from more than one controller.
- **Export and deletion**: Shared project content remains inspectable, exportable, and deletable by its owner according to Matrix ownership guarantees.

### Key Entities

- **Shared Project Workspace**: The isolated collaboration boundary containing the authoritative project folder and eligible project-owned chats, terminal sessions, workspace layout, apps, and data.
- **Project Membership**: The relationship between a Matrix user and a shared project, including invitation state, effective role, inviter, acceptance, role-change, revocation, and expiry metadata.
- **Authoritative Project Root**: The single folder treated as current project truth. A project may have backups or exports, but no second live peer is presented as the same authority.
- **Shared Terminal Session**: One project-bound process with a stable identity, ordered output, bounded replay, lifecycle state, attached participants, and a single current input controller.
- **Terminal Control Lease**: The time-bounded authority allowing one owner or editor to send input to one shared terminal.
- **Project Chat**: A project-bound canonical conversation with shared history and per-member personal read/presentation state.
- **Shared App Instance**: A project-scoped app execution and data scope that enforces the current participant's project role.
- **Shared Workspace Document**: The common spatial/project layout with shared nodes and per-member presentation state.
- **Audit Event**: A bounded, content-free record of a security-sensitive collaboration action and outcome.

## Assumptions and Dependencies

- The initial product supports owner, editor, and viewer roles; custom permissions are deferred.
- Terminal viewers observe output only. Interactive command-level read-only enforcement is not offered.
- Shared terminal sessions start inside the collaboration workspace. Existing personal processes are not migrated or exposed.
- A project transition establishes the collaboration workspace as the new authority. Any retained source copy is a labeled backup, not an active synchronized peer.
- Shared agents and apps use project/shared credentials and policy. Personal provider credentials are never copied automatically.
- The first release supports up to eight total members, matching the current bounded collaborator shape; raising the limit requires capacity and abuse review.
- Shared workspaces require a healthy compatible collaboration runtime. Offline personal copies are not writable shared peers.
- Existing provider-neutral Chat membership and project-identity work is a dependency for fully shared project chats.
- A separate public documentation change in `FinnaAI/matrix-os-site` is required when implementation ships.

## Explicitly Out of Scope

- Real-time character-by-character collaborative text editing or cursor presence inside source files.
- Bidirectional synchronization between independently writable personal project copies.
- Sharing an owner's personal Matrix runtime, home directory, personal terminals, personal chats, personal apps, or personal credentials.
- Classifying arbitrary shell commands as read-only or safe.
- Anonymous public links or unauthenticated project access.
- Custom roles, field-level app permissions, guest federation outside supported Matrix identities, or organization-wide policy management in the first release.
- Migrating active personal processes or terminal sessions into a shared workspace.
- Automatically publishing or exposing a project to the internet.

## Review Focus

Reviewers should explicitly confirm or challenge these product decisions before planning:

1. A shared project has one authoritative collaboration workspace rather than writable synchronized personal copies.
2. The collaboration workspace is isolated from every participant's personal Matrix runtime.
3. A viewer can read files, chats, app views, and terminal output but cannot type into a terminal or invoke indirect writes.
4. Editors share terminal output but only one editor controls terminal input at a time.
5. Existing personal terminal sessions are never exposed; shared sessions begin after the project becomes shared.
6. Fully shared chats and apps depend on project-scoped membership and role enforcement rather than machine-wide access.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An owner can invite a collaborator and the collaborator can accept and open the shared project in under three minutes, excluding workspace provisioning time.
- **SC-002**: In a two-user acceptance test, a file saved by an editor is visible to the other participant from the same authoritative project on the next refresh, with no manual sync or conflict-choice step.
- **SC-003**: Two attached participants receive the same ordered terminal output, and 95% of live output becomes visible to both within two seconds under normal network conditions.
- **SC-004**: Terminal control transfers between two connected editors in under three seconds and automated concurrency tests never observe more than one accepted controller.
- **SC-005**: Automated role-matrix tests reject 100% of viewer mutation attempts across files, chats, apps, agents, Git operations, terminal input, paste, creation, takeover, and stop.
- **SC-006**: Revoking a participant closes all tested live shared connections and prevents subsequent access within 60 seconds, with no project restart required.
- **SC-007**: Security tests find zero paths from a shared project into another participant's personal files, chats, terminals, apps, credentials, or system state.
- **SC-008**: A failed personal-to-shared transition leaves the original project usable and grants zero collaborator access in every tested failure stage.
- **SC-009**: Up to eight project members can concurrently open the workspace and observe shared terminal output without losing project or terminal state.
- **SC-010**: Owner, editor, and viewer participants can each identify their role and permitted actions without trial-and-error in moderated usability review.
