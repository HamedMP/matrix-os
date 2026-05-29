# Feature Specification: Matrix Messaging Bridge

**Feature Branch**: `077-matrix-messaging-bridge`  
**Created**: 2026-05-12  
**Status**: Draft  
**Input**: User description: "Specify an owner-controlled Matrix messaging hub for each Matrix OS user. All of the user's conversations from favorite messaging apps should land on Matrix, and Matrix OS should be able to read, automate, and reply only in conversations the user allows. Prefer the direct self-hosted Matrix bridge track over Beeper-backed bridge management. Consider whether Matrix OS should move away from Conduit if Synapse plus mautrix is the durable bridge stack."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect WhatsApp And Telegram To Matrix (Priority: P1)

A Matrix OS user can connect WhatsApp and Telegram first so conversations from those apps appear as Matrix conversations inside Matrix OS. The permission, storage, and recovery model must be reusable for later networks such as Signal, Discord, and Slack, but those later networks are not part of the first planning scope.

**Why this priority**: The core promise is "all my conversations are on Matrix." Without reliable account connection and conversation sync, automation and reply permissions have nothing useful to act on.

**Independent Test**: Start with a user who has no connected messaging accounts, connect Telegram, complete its login flow, receive a message in Telegram, and verify that the matching Matrix conversation appears in Matrix OS with the message content and sender identity visible to the user. Repeat the same lifecycle for WhatsApp before the bridge stack is considered ready for broad product rollout.

**Acceptance Scenarios**:

1. **Given** a user has a running Matrix OS VPS and no connected messaging apps, **When** they choose Telegram and complete the login flow, **Then** Matrix OS shows Telegram as connected and begins creating Matrix conversations for that account.
2. **Given** a user has Telegram working and chooses WhatsApp, **When** they complete the WhatsApp linking flow, **Then** Matrix OS shows WhatsApp as connected without changing the room-level permission model used for Telegram.
3. **Given** a connected Telegram or WhatsApp account receives a new message in the original app, **When** Matrix OS syncs the account, **Then** the user sees the message in the corresponding Matrix conversation without needing to open the original app.
4. **Given** the user sends a message from Matrix OS in a bridged Telegram or WhatsApp conversation, **When** the message is accepted, **Then** the recipient receives it through the original messaging app and Matrix OS records it in the same conversation.

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
- WhatsApp requires relinking because the paired device session expires or is removed by the user.
- Telegram login requires a verification code or 2FA password and the user abandons the flow.
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
- An encrypted Matrix room cannot share keys with the selected Hermes participation mode without exposing more history than the user allowed.
- A user revokes room access while Hermes is already streaming a response or an outbound reply is in the send path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix OS MUST provide a Messages experience where users can connect supported messaging accounts and view the resulting Matrix conversations.
- **FR-002**: Matrix OS MUST make Matrix the canonical conversation surface for connected messaging apps on the user's VPS.
- **FR-003**: Matrix OS MUST support sending and receiving text messages between Matrix conversations and connected external messaging apps.
- **FR-004**: Matrix OS MUST focus the first implementation track on Telegram and WhatsApp. Telegram may be the first demoable slice, but the bridge stack, permissions, backups, and homeserver decision are not considered product-ready until WhatsApp has been validated against the same architecture.
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
- **FR-020**: Client-visible errors MUST be safe and action-oriented. They MAY name the user-facing network when useful, such as "WhatsApp needs relinking," but MUST NOT expose bridge tokens, access tokens, phone numbers, email addresses, raw upstream errors, internal service names, filesystem paths, stack traces, or database errors.
- **FR-021**: Messaging setup, permission changes, disconnects, and automation changes MUST be testable end-to-end from user action through Matrix room behavior and Hermes visibility.
- **FR-022**: Matrix OS MUST prove the selected homeserver can run Telegram and WhatsApp bridge application services through registration, restart, backfill, media handling, and backup/restore before implementation tasks are generated.
- **FR-023**: Matrix OS MUST define whether Hermes participates as a real Matrix member, a non-member gated observer, or an event-consumer behind the Matrix OS permission registry before any message content is delivered to Hermes.
- **FR-024**: Matrix OS MUST keep permission enforcement outside bridge-specific code so Telegram and WhatsApp cannot bypass room-level read, reply, mention-only, or automation checks.
- **FR-025**: Matrix OS MUST define the encrypted-room posture before implementation. If Matrix room E2EE is enabled for bridged rooms, the plan MUST prove how keys are shared, withheld, revoked, or scoped so Hermes cannot decrypt rooms beyond current user permission.
- **FR-026**: Matrix OS MUST abort or quarantine in-flight Hermes work when room permission is revoked, and MUST recheck permission immediately before any outbound send.
- **FR-027**: Matrix OS MUST provide a visible pending-drafts/approvals surface for Hermes or automation replies that cannot be sent immediately.

### Key Entities *(include if feature involves data)*

- **Messaging Network**: An external chat network the user can connect, such as WhatsApp, Telegram, Signal, Discord, or Slack.
- **Connected Account**: A user's linked account on a messaging network, including connection status and user-visible identity metadata.
- **Bridge Runtime**: The per-network process or service that syncs messages between a connected account and Matrix conversations.
- **Matrix Conversation**: The Matrix room that represents a direct or group conversation from a connected account.
- **Conversation Mapping**: The durable association between a Matrix conversation and its external network conversation.
- **Hermes Permission**: The room-level policy describing whether Hermes may read, reply, trigger automations, or act only when invoked.
- **Automation Rule**: A user-defined rule that observes permitted messages and performs an action in Matrix OS.
- **Messaging Audit Event**: A durable record of permission changes, automation triggers, outgoing AI replies, bridge health changes, and disconnect actions.
- **Hermes Participation Mode**: The chosen privacy model for Hermes in Matrix rooms: direct room member, gated observer, or Matrix OS event consumer.

### Assumptions

- Matrix OS will pursue the direct self-hosted bridge track for this feature rather than depending on Beeper-managed bridge infrastructure.
- The initial product surface is a first-party Messages app or settings surface inside Matrix OS, not a separate Beeper-branded product.
- Telegram and WhatsApp are the first priority networks. Telegram can be used for the earliest architecture demo because its login and bridge behavior are usually easier to automate, but WhatsApp must be validated before declaring the feature ready for normal users.
- Room-level opt-in is the default privacy posture for Hermes and automations.
- Existing Matrix OS direct channel adapters may remain for legacy paths, but bridged Matrix conversations become the preferred long-term messaging backbone.
- The homeserver decision is part of this feature's planning scope because bridge support may require changing the current Conduit-based direction.

### Required Planning Gates

- **Gate 1 - Homeserver and bridge spike**: Before implementation planning, Matrix OS MUST run a throwaway Telegram bridge and a throwaway WhatsApp bridge against each candidate homeserver option that remains under consideration. The spike must prove application-service registration, namespace control, inbound events, outbound messages, media fetch/send, restart recovery, and backup/restore of bridge state.
- **Gate 2 - Hermes privacy model**: Before implementation planning, Matrix OS MUST choose and document Hermes participation mode. If Hermes joins rooms as a Matrix member, the plan must explain room-history visibility, membership visibility, revocation behavior, and why that is acceptable. If Hermes is only a gated observer or event consumer, the plan must describe how message events are delivered without granting Matrix room membership.
- **Gate 3 - Owner storage, resource caps, and VPS floor**: Before implementation planning, Matrix OS MUST document which owner-controlled store holds homeserver state, each Telegram/WhatsApp bridge database, conversation mappings, permission records, audit events, media, logs, and setup sessions. It MUST also choose numeric caps for queues, idempotency windows, media jobs, and minimum customer-VPS resources.
- **Gate 4 - Route and appservice contract**: Before implementation planning, Matrix OS MUST define method/path-level API contracts for setup, callback/pairing, account status, conversation listing, permission changes, disconnect, health, recovery, and reply/draft actions.
- **Gate 5 - Duplicate adapter reconciliation**: Before implementation planning, Matrix OS MUST decide how legacy direct Telegram/WhatsApp-style channel adapters coexist with bridged Matrix conversations so the same message cannot trigger Hermes or automations twice.
- **Gate 6 - E2EE and migration stance**: Before implementation planning, Matrix OS MUST decide whether bridged Matrix rooms are unencrypted for the first slice, encrypted with a proven gated decryptor/key-sharing path, or blocked from Hermes access. If Synapse is selected over Conduit, the plan MUST include either a migration spike or an explicit split-homeserver architecture.

### Security Architecture

| Surface | Operation | Auth Method | Public? | Authorization / Notes |
|---------|-----------|-------------|---------|-----------------------|
| `GET /api/messages/networks` | List supported networks and setup availability | Matrix OS user session | No | Shows Telegram and WhatsApp first. No secrets or raw bridge health details. |
| `POST /api/messages/accounts/setup` | Start Telegram or WhatsApp linking | Matrix OS user session plus body limit | No | Creates owner-bound setup session. Network slug must be allowlisted. |
| `POST /api/messages/accounts/setup/{setupId}/complete` | Complete app-specific callback, QR, code, or pairing flow | Short-lived owner-bound setup session plus body limit | No | Setup state must be single-use, expires after 10 minutes, and uses constant-time secret comparison. |
| `GET /api/messages/accounts` | Inspect connected account status | Matrix OS user session | No | Only owner-visible coarse status. Account identifiers are redacted unless explicitly user-facing. |
| `DELETE /api/messages/accounts/{accountId}` | Disconnect Telegram or WhatsApp account | Matrix OS user session plus body limit | No | Stops future sync, audits action, and applies retention choice. |
| `GET /api/messages/conversations` | List bridged conversations and permission state | Matrix OS user session | No | Only owner-scoped conversations. Pagination params are validated and capped. |
| `PATCH /api/messages/conversations/{roomId}/permissions` | Grant or revoke Hermes read, reply, mention-only, and automation access | Matrix OS user session plus body limit | No | Default is denied. Changes require owner action, optimistic concurrency, and audit event. |
| `POST /api/messages/conversations/{roomId}/reply` | Send user or Hermes-approved response | Matrix OS user session or trusted Hermes reply request plus body limit | No | Reply permission is rechecked immediately before send. Without permission this creates a draft/approval item. |
| `GET /api/messages/drafts` | List pending Hermes/automation draft replies | Matrix OS user session | No | Owner can inspect pending replies without exposing raw provider details. |
| `POST /api/messages/drafts/{replyId}/approve` | Approve a pending reply | Matrix OS user session plus body limit | No | Rechecks room reply permission and current room mapping before send. |
| `POST /api/messages/drafts/{replyId}/cancel` | Cancel a pending reply | Matrix OS user session plus body limit | No | Marks draft cancelled and audits action. |
| `POST /api/messages/appservice/{network}/events` | Receive bridge/appservice event notifications if Matrix OS owns an internal callback | Trusted local appservice token plus body limit | No | Token comparison must be constant-time. Message content reaches Hermes only after permission checks. |
| `GET /api/messages/health` | Show bridge and homeserver health | Matrix OS user session | No | Coarse booleans/status only. No raw provider, bridge, or homeserver errors. |
| `POST /api/messages/recovery/{accountId}` | Restart or relink unhealthy bridge/account | Matrix OS user session plus body limit | No | Safe recovery actions only; detailed operator diagnostics stay server-side. |

**Input validation plan**:

- Validate account identifiers, network slugs, room ids, setup session ids, automation ids, pagination cursors, and permission values at route boundaries.
- Validate Telegram and WhatsApp setup payloads with network-specific schemas instead of accepting generic records.
- Validate every incoming Matrix event before storing it, showing it, sending it to Hermes, or evaluating automation rules.
- Validate all outgoing reply requests against current room permission immediately before sending.
- Sanitize display names, room names, contact names, message previews, media filenames, and network-provided metadata before rendering or storing in app-visible state.
- Treat external message content as untrusted user content and never as system instructions to Hermes.

**Error response and credential policy**:

- Client-visible errors must be generic and user-actionable.
- Detailed bridge, homeserver, provider, and database errors are logged server-side with redaction.
- Access tokens, bridge tokens, phone numbers, QR payloads, invite links, and setup secrets must not appear in URLs, client errors, audit events, or user-visible logs.

### Storage And Ownership Requirements

- Homeserver state, bridge state, Matrix OS permission records, audit events, setup sessions, and media cache state MUST stay inside the user's VPS-local ownership boundary and backup lifecycle.
- Telegram bridge state and WhatsApp bridge state MUST be stored separately from each other and from the homeserver database. They may share the owner-local Postgres service only if each program has its own database or isolated schema according to the selected bridge's support policy.
- Matrix OS permission and audit records MUST live in Matrix OS-owned Postgres tables, not only inside bridge or homeserver state, so Hermes access can be inspected, exported, revoked, and restored independently.
- Conversation mappings MUST include the Matrix room id, network slug, connected account id, external conversation id, bridge-controlled ghost/user ids where applicable, last processed event id, and deletion/retention state.
- Export MUST include conversation mappings, permission records, audit events, and user-selected retained message history. Delete MUST remove or tombstone connected-account metadata, setup secrets, permission records, automation records, and retained message content according to the user's chosen retention policy.

### Integration Wiring Requirements

- Matrix OS MUST define a startup sequence for the homeserver, bridge runtimes, Messages surface, messaging permission registry, Hermes Matrix participation, and automation evaluator.
- Bridge runtimes MUST register with the selected homeserver before user account linking is offered.
- Hermes MUST use the selected Hermes participation mode and MUST NOT gain direct or indirect access to room history or new message content without an active room permission.
- The permission registry MUST be checked at the last possible point before message content enters Hermes, before an automation runs, and before a reply is sent.
- Messaging data MUST use the user's VPS-local ownership boundary and the existing Matrix OS backup/recovery lifecycle.
- The selected homeserver MUST support the bridge registration, room event delivery, identity namespace, media, restart, and backup behavior required by the supported networks.
- The Messages surface MUST expose setup, conversation status, permission status, health status, and disconnect flows without requiring the user to use a terminal.
- Existing Matrix OS social, channel, and Hermes routes MUST be reconciled with this messaging backbone so duplicate adapters do not produce duplicate AI events.
- Revocation MUST invalidate queued but unread Hermes/automation work for that room before any new work is delivered.
- Revocation MUST signal cancellation to active Hermes turns for that room. A reply may only be sent after a final permission and room-mapping recheck succeeds.
- The canonical bridge event id for idempotency MUST be the Matrix homeserver `event_id`. Bridge-local or external network ids may be stored as secondary metadata but MUST NOT replace homeserver `event_id` for the main dedupe key.
- If a legacy direct channel adapter and bridged Matrix account exist for the same owner/network/account, the bridged Matrix path is authoritative for Hermes and automation visibility. The legacy adapter must be disabled for AI delivery or marked notification-only.

### Failure Modes And Resource Management

- Setup sessions must expire after 10 minutes, be single-use, and be cleaned up at least every 15 minutes if linking is abandoned.
- Initial sync/backfill must have user-visible progress and must not block unrelated Matrix OS functionality. The first slice must cap initial visible backfill at 100 latest messages per room unless the user explicitly asks for more.
- Message ingestion queues must be bounded per user, per network, and per room, with clear overflow behavior. Initial caps: 10,000 queued events per owner, 2,000 per network, 500 per room, 100 concurrent media jobs per owner, 10 concurrent media jobs per room, and 30 days of retained idempotency keys.
- Automation evaluation must not block message sync or room rendering.
- Failed sends must be surfaced as failed messages or approval items without retrying indefinitely.
- Bridge restarts must not duplicate already-processed messages or rerun already-completed automations.
- Health checks must complete within 5 seconds, return coarse status only, and avoid exposing upstream provider details.
- Shutdown must drain or pause ingestion cleanly so partial permission updates do not leave Hermes with stale access.
- Backup and restore must include enough homeserver, bridge, conversation mapping, permission, and automation state to reconnect without losing the user's privacy policy.
- Logs and audit events must have retention and redaction policies appropriate for sensitive message metadata.
- Media download/send operations must use explicit size limits and timeouts. The first planning pass must define those limits separately for thumbnails/previews and original files.
- Customer VPSes that enable Telegram plus WhatsApp bridging must meet the messaging resource floor defined in the plan. Smaller VPSes must keep Messages disabled, Telegram-only experimental, or require an upgrade before WhatsApp/Synapse is enabled.
- Backup/restore must state RPO/RTO boundaries. If a WhatsApp restore is older than the supported session recovery window, the user may be required to relink WhatsApp rather than silently entering a broken state.
- First planning baseline: messaging backup RPO is 1 hour, restore RTO is 15 minutes after the VPS is reachable, and WhatsApp may require relink after restoring from a snapshot older than 24 hours or whenever the bridge reports the paired-device session invalid.

### Deferred Scope

- Bidirectional edits, deletes, reactions, read receipts, typing indicators, stickers, voice notes, and full historical import are deferred from the first implementation unless the Telegram/WhatsApp bridge spike proves them with the same permission, audit, and idempotency model.
- Org-shared messaging accounts and shared-room ownership transfer are deferred.
- Full Conduit-to-Synapse migration for existing social/federation rooms is deferred unless Gate 1 selects a single Synapse homeserver for both social and private messaging.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can connect Telegram and see the first bridged conversation in Matrix OS within 5 minutes in a guided setup flow.
- **SC-002**: New bridged conversations grant Hermes zero read, reply, or automation access by default in 100% of tested setup paths.
- **SC-003**: After a user grants read access to one conversation and denies another, Hermes receives message content only from the allowed conversation in end-to-end tests.
- **SC-004**: After a user grants reply access to one conversation, a message sent from Matrix OS is delivered through the original messaging app and appears in the Matrix conversation history.
- **SC-005**: Revoking room access stops new Hermes visibility and automation triggers for that room within 10 seconds.
- **SC-006**: A restart of the user's VPS preserves connected-account status, conversation mappings, permission settings, and at least the latest 100 visible messages for Telegram and WhatsApp in the validated first-track environments.
- **SC-007**: A user can view all rooms with Hermes read, reply, and automation access from a single permissions screen.
- **SC-008**: All supported setup, permission, disconnect, and reply failure paths return safe user-facing errors without exposing tokens, raw internal errors, internal service names, filesystem paths, database details, phone numbers, or email addresses.
- **SC-009**: Planning produces an explicit homeserver decision that compares the current Conduit direction with the bridge-compatible alternative and states whether migration is required before implementation.
- **SC-010**: Planning proves both Telegram and WhatsApp bridge spikes against the selected homeserver before implementation tasks are generated.
- **SC-011**: Revoking room access cancels queued Hermes/automation work and prevents unsent replies from leaving Matrix OS unless a final permission recheck already accepted the send before revocation.
