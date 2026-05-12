# Feature Specification: Matrix Messaging Bridge

**Feature Branch**: `077-matrix-messaging-bridge`  
**Created**: 2026-05-12  
**Status**: Draft  
**Input**: User description: "Specify an owner-controlled Matrix messaging hub for each Matrix OS user. All of the user's conversations from favorite messaging apps should land on Matrix, and Matrix OS should be able to read, automate, and reply only in conversations the user allows. Prefer the direct self-hosted Matrix bridge track over Beeper-backed bridge management. Consider whether Matrix OS should move away from Conduit if Synapse plus mautrix is the durable bridge stack."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Messaging Apps To Matrix (Priority: P1)

A Matrix OS user can connect their existing messaging accounts so conversations from apps such as WhatsApp, Telegram, Signal, Discord, and Slack appear as Matrix conversations inside Matrix OS.

**Why this priority**: The core promise is "all my conversations are on Matrix." Without reliable account connection and conversation sync, automation and reply permissions have nothing useful to act on.

**Independent Test**: Start with a user who has no connected messaging accounts, connect one supported messaging app, complete its login flow, receive a message in the original app, and verify that the matching Matrix conversation appears in Matrix OS with the message content and sender identity visible to the user.

**Acceptance Scenarios**:

1. **Given** a user has a running Matrix OS VPS and no connected messaging apps, **When** they choose a supported app and complete the app-specific login or linking flow, **Then** Matrix OS shows that app as connected and begins creating Matrix conversations for that account.
2. **Given** a connected account receives a new message in the original app, **When** Matrix OS syncs the account, **Then** the user sees the message in the corresponding Matrix conversation without needing to open the original app.
3. **Given** the user sends a message from Matrix OS in a bridged conversation, **When** the message is accepted, **Then** the recipient receives it through the original messaging app and Matrix OS records it in the same conversation.

---

### User Story 2 - Grant Room-Level AI Access (Priority: P1)

A user can decide which bridged conversations Matrix OS and Hermes may read, summarize, automate, and reply to, independently per room.

**Why this priority**: Messaging data is highly sensitive. The feature must make owner consent explicit before any automation reads or acts on private conversations.

**Independent Test**: Connect one messaging app with at least two conversations, allow Hermes to read and reply in only one conversation, send messages in both conversations, and verify Hermes only receives and can act in the allowed conversation.

**Acceptance Scenarios**:

1. **Given** a bridged conversation has no AI access permission, **When** a message arrives, **Then** Matrix OS stores and displays the message for the user but does not deliver it to Hermes or automation rules.
2. **Given** a user grants read-only access to a conversation, **When** a message arrives, **Then** Hermes may summarize or classify it but cannot send a reply into that conversation.
3. **Given** a user grants reply access to a conversation, **When** Hermes is asked to respond or an allowed automation triggers a reply, **Then** Matrix OS sends the reply through the same Matrix conversation and original messaging network.
4. **Given** a user revokes access for a conversation, **When** new messages arrive afterward, **Then** Hermes and automation rules stop receiving those message contents.

---

### User Story 3 - Automate From Allowed Conversations (Priority: P2)

A user can create automations that react to messages from allowed conversations and update Matrix OS apps, files, notifications, or outgoing replies.

**Why this priority**: The main value beyond unified messaging is letting the AI OS help with real-life messages, while respecting room-level consent.

**Independent Test**: Grant automation access to one bridged conversation, create a rule such as "when this chat sends a deadline, create a task," send a matching message from the original app, and verify the task is created with a visible audit trail.

**Acceptance Scenarios**:

1. **Given** a conversation has automation permission enabled, **When** an incoming message matches a user-created automation rule, **Then** Matrix OS performs the configured action and records which conversation triggered it.
2. **Given** a conversation has read permission but not automation permission, **When** a message matches an automation rule, **Then** Matrix OS does not run the automation for that message.
3. **Given** an automation would send a message into a conversation without reply permission, **When** the automation reaches the reply step, **Then** Matrix OS creates a draft or approval request instead of sending.

---

### User Story 4 - Operate A Private Messaging Backbone (Priority: P2)

An operator can provision and maintain the user's Matrix messaging backbone on the user's VPS so conversation data, bridge state, and AI permissions remain owner-controlled and recoverable.

**Why this priority**: "Do it once and do it well" requires the bridge stack to be reliable, backup-aware, upgradeable, and compatible with the chosen homeserver.

**Independent Test**: Provision a fresh user VPS, connect one bridged app, restart messaging services, and verify the user can still view conversations, receive new messages, and retain permissions after restart.

**Acceptance Scenarios**:

1. **Given** a user's VPS restarts, **When** Matrix OS messaging services come back online, **Then** connected accounts, bridge state, conversations, and permissions recover without requiring the user to reconnect accounts.
2. **Given** a messaging bridge becomes unhealthy, **When** the user opens Messages settings, **Then** Matrix OS shows a coarse health status and a safe recovery action without exposing secrets or provider internals.
3. **Given** the current Matrix homeserver cannot reliably support required bridge behavior, **When** planning evaluates the messaging backbone, **Then** moving to a bridge-compatible homeserver is considered in scope and must preserve existing Matrix OS identities and rooms where feasible.

### Edge Cases

- A user connects an app but cancels the app-specific login flow before completion.
- A connected messaging app invalidates or expires its session.
- A bridge creates many rooms at once during initial sync or backfill.
- A message contains media, voice notes, stickers, reactions, edits, deletes, or forwarded content.
- A bridged contact changes display name, avatar, phone number, username, or workspace membership.
- A user grants access to a room and later revokes it while automations are queued.
- A reply send fails after Hermes has generated the response.
- A Matrix room maps to a group conversation with multiple external participants.
- A remote network rate-limits or temporarily blocks bridge activity.
- A user deletes or exports their Matrix OS data.
- A VPS restore happens from backup after bridge state has changed.
- The homeserver, bridge, and Hermes disagree about room membership or encryption state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix OS MUST provide a Messages experience where users can connect supported messaging accounts and view the resulting Matrix conversations.
- **FR-002**: Matrix OS MUST make Matrix the canonical conversation surface for connected messaging apps on the user's VPS.
- **FR-003**: Matrix OS MUST support sending and receiving text messages between Matrix conversations and connected external messaging apps.
- **FR-004**: Matrix OS MUST support at least one production-quality messaging network in the first implementation slice, with additional networks added without changing the permission model.
- **FR-005**: Matrix OS MUST display connected-account status, sync status, and coarse bridge health for each connected messaging app.
- **FR-006**: Matrix OS MUST store bridge account state, Matrix conversation state, and AI permission state in owner-controlled storage associated with the user's VPS and backup lifecycle.
- **FR-007**: Users MUST be able to grant and revoke Hermes read access independently for each bridged Matrix conversation.
- **FR-008**: Users MUST be able to grant and revoke Hermes reply access independently for each bridged Matrix conversation.
- **FR-009**: Users MUST be able to grant and revoke automation-trigger access independently for each bridged Matrix conversation.
- **FR-010**: Matrix OS MUST default new bridged conversations to no Hermes read, reply, or automation access until the user grants it.
- **FR-011**: Matrix OS MUST ensure Hermes and automation workflows receive message content only from conversations where the user has granted the relevant permission.
- **FR-012**: Matrix OS MUST support a mode where Hermes can act only when explicitly mentioned or invoked in a permitted conversation.
- **FR-013**: Matrix OS MUST record an audit trail for permission changes, automation triggers, and AI-generated replies.
- **FR-014**: Matrix OS MUST allow users to inspect which conversations Hermes can read, reply to, or automate from in one place.
- **FR-015**: Matrix OS MUST allow users to disconnect a messaging app and stop future message sync for that app.
- **FR-016**: Matrix OS MUST preserve user access to already-synced Matrix conversations according to the user's retention and deletion choices after a messaging app is disconnected.
- **FR-017**: Matrix OS MUST provide safe export and deletion paths for bridged messaging data, connected-account metadata, permission records, and automation records.
- **FR-018**: Matrix OS MUST evaluate the existing Matrix homeserver choice against bridge compatibility, operational reliability, backup behavior, and migration cost before implementation planning.
- **FR-019**: If the selected bridge-compatible homeserver differs from the current Matrix OS homeserver, Matrix OS MUST define a migration path for user Matrix identities, Hermes participation, room records, and routing behavior before shipping the feature.
- **FR-020**: Client-visible errors MUST be generic and MUST NOT expose bridge tokens, access tokens, phone numbers, email addresses, raw provider errors, filesystem paths, stack traces, or database errors.
- **FR-021**: Messaging setup, permission changes, disconnects, and automation changes MUST be testable end-to-end from user action through Matrix room behavior and Hermes visibility.

### Key Entities *(include if feature involves data)*

- **Messaging Network**: An external chat network the user can connect, such as WhatsApp, Telegram, Signal, Discord, or Slack.
- **Connected Account**: A user's linked account on a messaging network, including connection status and user-visible identity metadata.
- **Bridge Runtime**: The per-network process or service that syncs messages between a connected account and Matrix conversations.
- **Matrix Conversation**: The Matrix room that represents a direct or group conversation from a connected account.
- **Conversation Mapping**: The durable association between a Matrix conversation and its external network conversation.
- **Hermes Permission**: The room-level policy describing whether Hermes may read, reply, trigger automations, or act only when invoked.
- **Automation Rule**: A user-defined rule that observes permitted messages and performs an action in Matrix OS.
- **Messaging Audit Event**: A durable record of permission changes, automation triggers, outgoing AI replies, bridge health changes, and disconnect actions.

### Assumptions

- Matrix OS will pursue the direct self-hosted bridge track for this feature rather than depending on Beeper-managed bridge infrastructure.
- The initial product surface is a first-party Messages app or settings surface inside Matrix OS, not a separate Beeper-branded product.
- The first shipping slice can support one messaging network if the architecture, permissions, backups, and Hermes path are ready for additional networks.
- Room-level opt-in is the default privacy posture for Hermes and automations.
- Existing Matrix OS direct channel adapters may remain for legacy paths, but bridged Matrix conversations become the preferred long-term messaging backbone.
- The homeserver decision is part of this feature's planning scope because bridge support may require changing the current Conduit-based direction.

### Security Architecture

| Surface | Operation | Auth Method | Public? | Authorization / Notes |
|---------|-----------|-------------|---------|-----------------------|
| Messages settings | Connect, disconnect, and inspect messaging accounts | Matrix OS user session | No | Only the owner may manage their connected accounts. |
| Messaging account login callback or pairing flow | Complete app-specific account linking | Short-lived owner-bound setup session | No | Setup state must be single-use and expire if not completed. |
| Conversation permission controls | Grant or revoke Hermes read, reply, mention-only, and automation access | Matrix OS user session | No | Default is denied. Changes require owner action and are audited. |
| Matrix room event ingestion | Normalize messages for Matrix OS and Hermes | Trusted local messaging backbone identity | No | Message content is forwarded to Hermes only after room permission checks. |
| Automation trigger path | Evaluate permitted messages against user rules | Trusted local messaging backbone identity plus stored owner permission | No | Rules run only for rooms with automation access enabled. |
| AI reply path | Send Hermes-generated responses into bridged conversations | Stored owner permission plus Matrix room membership | No | Reply access must be enabled or the response becomes a draft/approval item. |
| Health and recovery controls | Show bridge state and restart/recover unhealthy connections | Matrix OS user session or operator support path | No | Client sees coarse status only; detailed errors stay in server logs. |

**Input validation plan**:

- Validate account identifiers, network slugs, room ids, setup session ids, automation ids, pagination cursors, and permission values at route boundaries.
- Validate every incoming Matrix event before storing it, showing it, sending it to Hermes, or evaluating automation rules.
- Validate all outgoing reply requests against current room permission immediately before sending.
- Sanitize display names, room names, contact names, message previews, media filenames, and network-provided metadata before rendering or storing in app-visible state.
- Treat external message content as untrusted user content and never as system instructions to Hermes.

**Error response and credential policy**:

- Client-visible errors must be generic and user-actionable.
- Detailed bridge, homeserver, provider, and database errors are logged server-side with redaction.
- Access tokens, bridge tokens, phone numbers, QR payloads, invite links, and setup secrets must not appear in URLs, client errors, audit events, or user-visible logs.

### Integration Wiring Requirements

- Matrix OS MUST define a startup sequence for the homeserver, bridge runtimes, Messages surface, messaging permission registry, Hermes Matrix participation, and automation evaluator.
- Bridge runtimes MUST register with the selected homeserver before user account linking is offered.
- Hermes MUST join or observe only Matrix conversations where the user has granted the needed permission.
- The permission registry MUST be checked at the last possible point before message content enters Hermes, before an automation runs, and before a reply is sent.
- Messaging data MUST use the user's VPS-local ownership boundary and the existing Matrix OS backup/recovery lifecycle.
- The selected homeserver MUST support the bridge registration, room event delivery, identity namespace, media, restart, and backup behavior required by the supported networks.
- The Messages surface MUST expose setup, conversation status, permission status, health status, and disconnect flows without requiring the user to use a terminal.
- Existing Matrix OS social, channel, and Hermes routes MUST be reconciled with this messaging backbone so duplicate adapters do not produce duplicate AI events.

### Failure Modes And Resource Management

- Setup sessions must expire and be cleaned up if linking is abandoned.
- Initial sync/backfill must have user-visible progress and must not block unrelated Matrix OS functionality.
- Message ingestion queues must be bounded per user, per network, and per room, with clear overflow behavior.
- Automation evaluation must not block message sync or room rendering.
- Failed sends must be surfaced as failed messages or approval items without retrying indefinitely.
- Bridge restarts must not duplicate already-processed messages or rerun already-completed automations.
- Health checks must return coarse status only and avoid exposing upstream provider details.
- Shutdown must drain or pause ingestion cleanly so partial permission updates do not leave Hermes with stale access.
- Backup and restore must include enough homeserver, bridge, conversation mapping, permission, and automation state to reconnect without losing the user's privacy policy.
- Logs and audit events must have retention and redaction policies appropriate for sensitive message metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can connect the first supported messaging app and see the first bridged conversation in Matrix OS within 5 minutes in a guided setup flow.
- **SC-002**: New bridged conversations grant Hermes zero read, reply, or automation access by default in 100% of tested setup paths.
- **SC-003**: After a user grants read access to one conversation and denies another, Hermes receives message content only from the allowed conversation in end-to-end tests.
- **SC-004**: After a user grants reply access to one conversation, a message sent from Matrix OS is delivered through the original messaging app and appears in the Matrix conversation history.
- **SC-005**: Revoking room access stops new Hermes visibility and automation triggers for that room within 10 seconds.
- **SC-006**: A restart of the user's VPS preserves connected-account status, conversation mappings, permission settings, and at least the latest 100 visible messages for the tested network.
- **SC-007**: A user can view all rooms with Hermes read, reply, and automation access from a single permissions screen.
- **SC-008**: All supported setup, permission, disconnect, and reply failure paths return safe user-facing errors without exposing provider names, tokens, raw internal errors, filesystem paths, or database details.
- **SC-009**: Planning produces an explicit homeserver decision that compares the current Conduit direction with the bridge-compatible alternative and states whether migration is required before implementation.
