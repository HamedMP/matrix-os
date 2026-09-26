# Feature Specification: Join Matrix and Work Together Without a Machine

**Feature Branch**: `codex/535-guest-collaboration`
**Created**: 2026-09-26
**Status**: Proposed; specification only, no implementation or production readiness claim
**Input**: Make Matrix the collaborative equivalent of Google Docs for AI chat: collaborators join without another Matrix machine, see one another, improve a shared result, and work with AI together.

## Product intent and relationship to existing work

One person brings a Matrix computer; invited people join with a free account and a browser. They work in the same Chat, project, terminal or document hosted on the resource owner's computer. Buying compute, connecting an AI account and joining someone else's work are separate actions.

The defining journey is: invite someone, open the same work, see one another contributing, jointly revise a document, ask AI to propose an improvement, and retain an attributable, recoverable result. A shared document beside Chat is the first collaboratively editable artifact; this does not attempt to recreate every office application.

This specification extends [121 session sharing](../121-collaboration-session-sharing/spec.md), [124 organization collaboration](../124-organization-collaboration/spec.md), and [525 collaboration UX](../525-collaboration-ux-redesign/spec.md). It deliberately brings resource-specific external guests, personal invitations outside an organization, presence, mentions, document co-editing and revision recovery into scope. These were excluded or deferred by those specifications. It preserves owner-hosted authority, existing organization member semantics and the confirmed Chat/discussion/access interaction model. Earlier organization-only restrictions remain enforced until the new authorization path is delivered and verified; deleting a membership check is not an implementation of guest access.

The first milestone closes a gap in an existing promise: 124 already says recipients need no computer. The new work must prove that from account creation through real browser use, not only at the transport layer. Architecture findings and planning constraints are recorded separately in [architecture.md](architecture.md); staged delivery and evidence gates are in [delivery-plan.md](delivery-plan.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Join with only an account (Priority: P1)

An invited person signs in or creates a free account and immediately joins shared work. They need no subscription, payment method, computer, installed app or AI credentials.

**Why this priority**: An invitation must bring a teammate into the work without a purchase or infrastructure setup journey.

**Independent Test**: An existing organization member with zero machines opens an existing share in a phone browser, contributes within their permission, signs out and returns through Shared with me. The same journey later runs for a new external guest under Story 2.

**Acceptance Scenarios**:

1. **Given** an authenticated member with no machine or paid entitlement, **when** they open a permitted share, **then** the exact resource opens without billing, provisioning, machine selection or personal-runtime boot requests.
2. **Given** a signed-out recipient, **when** they finish sign-in or signup, **then** the invitation destination is retained and only the intended authenticated account may accept it.
3. **Given** access to resources on two owners' computers, **when** the recipient switches resources, **then** each opens on its own host without creating copies or changing their selected personal computer.
4. **Given** the recipient later purchases a computer, **when** they return to existing shares, **then** the same identities, permissions, drafts and destinations continue to work.
5. **Given** a signed-in free account with no shares, **when** it opens Shared with me, **then** it sees an empty state and can sign out without entering onboarding; starting its own hosted work is a separate optional action.

### User Story 2 - Invite a specific person outside the team (Priority: P1)

An owner invites a person by email to one resource with Viewer or Contributor access. An invitation can exist before the recipient has an account. Acceptance never makes them an organization member.

**Why this priority**: Requiring prior organization setup would prevent a link from being the natural way to start collaborating.

**Independent Test**: Invite a new verified email address to a standalone Chat, accept with a new free account, then prove the recipient cannot open its parent project, sibling resources, organization directory or host administration.

**Acceptance Scenarios**:

1. **Given** a personal resource, **when** its owner invites an external email address, **then** the owner sees the role, included history/content, host, expiry and AI permission before sending; default access is Viewer.
2. **Given** an invitation, **when** another account follows its forwarded link, **then** no content or grant is exposed; the intended verified account can accept once and safely repeat the same acceptance.
3. **Given** an organization-bound resource, **when** external sharing is disabled by organization policy, **then** the owner cannot create or accept an external grant. An organization owner/admin may explicitly enable external invitations; that setting grants no content access by itself.
4. **Given** an accepted guest, **when** its owner changes its role or revokes access, **then** the capability changes apply to new reads, edits, connections and AI actions, and open sessions converge to that state without losing the guest's private unsent text.
5. **Given** an expired, declined or revoked invitation, **when** it is reused, **then** it grants nothing. Re-inviting is an explicit fresh operation; account email changes cannot transfer an accepted grant.
6. **Given** a Viewer, **when** they inspect shared work, **then** they may read and observe but cannot discuss, edit, control a terminal, request AI, manage access or invite others. Contributor access permits in-scope discussion/editing; terminal control and AI remain separately authorized actions.

### User Story 3 - Feel present and coordinate (Priority: P2)

Participants see who is online and where they are working, discuss the result, and notify the right person without sharing private prompt drafts.

**Why this priority**: Shared access becomes collaboration when people can understand each other's activity and coordinate decisions.

**Independent Test**: Two authorized accounts open a Chat and document, observe presence, exchange a mention and a comment, and reconnect without duplicate alerts or false online status.

**Acceptance Scenarios**:

1. **Given** accepted members and connected participants, **when** access details open, **then** membership and live presence are distinguished. Idle, reconnecting and offline states never imply someone is actively watching.
2. **Given** a private prompt or discussion draft, **when** its author types, **then** draft text remains private. An ephemeral typing indicator may reveal activity only to the current audience; document cursors and selections apply only to shared document content.
3. **Given** an authorized mention in discussion or a document comment, **when** it is committed, **then** the mentioned participant receives one in-app activity item and can open the permitted context. Mention suggestions list only participants visible in that scope.
4. **Given** unread activity, **when** the person returns, **then** they can identify new discussion, comments and document revisions since their last visit; marking activity read is personal and does not start AI.
5. **Given** revoked access, **when** an old notification is opened, **then** it exposes no resource content or preview and reports that access is unavailable.

### User Story 4 - Improve one shared document (Priority: P2)

Participants keep a shared document beside Chat and edit it simultaneously. They can discuss specific passages, inspect changes, and recover earlier work.

**Why this priority**: The durable outcome of collaboration must be editable and useful beyond a sequence of answers.

**Independent Test**: Two Contributors concurrently edit overlapping and separate passages, anchor comments, inspect authorship, undo their own edit and restore an earlier revision while a third Viewer follows.

**Acceptance Scenarios**:

1. **Given** a Chat or project, **when** an authorized Contributor creates its first document, **then** it receives that scope's audience and is discoverable from the same session. Standalone documents use explicit resource grants.
2. **Given** concurrent authorized edits, **when** they reach the host in different orders, **then** all connected views converge and every acknowledged edit is retained or explicitly represented in a conflict/recovery result; silent last-writer replacement is forbidden.
3. **Given** a comment anchored to text, **when** the text moves or is deleted, **then** the comment follows the text where possible or becomes explicitly unanchored; it never silently attaches to unrelated text. Participants can reply and resolve comments with attribution.
4. **Given** multiple authors' edits, **when** a participant invokes undo, **then** it reverses their own applicable edit without silently erasing another person's later work. Restoring history creates a new attributable revision, preserves the intervening history and requires confirmation of the affected document.
5. **Given** a lost connection, **when** edits are not acknowledged, **then** they remain visibly unsaved and recoverable on that device. Reconnection rechecks access before applying anything; conflicts preserve local work for deliberate resolution.
6. **Given** a shared document, **when** an authorized participant exports it, **then** they receive a portable document; authorized history/comment export is supported separately. No credentials, private drafts or unrelated history are included.

### User Story 5 - Ask AI to change shared work (Priority: P2)

An authorized participant asks the owner's configured AI to improve the shared document. Everyone can see the requester, progress, proposed edits, acceptance and resulting revision.

**Why this priority**: AI should help a team produce a common result with understandable authority and cost.

**Independent Test**: A guest with explicitly enabled AI permission requests an edit; another human changes the target before the proposal finishes. The stale proposal cannot overwrite that change, and the requester or owner can reconcile and accept a current proposal.

**Acceptance Scenarios**:

1. **Given** an invitation or AI composer, **when** a guest inspects it, **then** they see whether AI is allowed, that it runs on the host, and which owner-selected access source pays; no guest credentials or payment method are required.
2. **Given** AI permission and available owner limits, **when** the guest submits, **then** one attributable request enters the canonical queue. The UI shows queued, running, awaiting approval, completed, failed, cancelled or interrupted as appropriate.
3. **Given** an AI document edit, **when** its result arrives, **then** a visible proposal identifies the target and source revision. The requester or resource owner may accept/reject it while their current permissions allow; other participants observe. Stale proposals require rebase/review before application.
4. **Given** concurrent human edits or an access change, **when** a proposal is applied, **then** authorization and target revision are checked at the write boundary; accepted changes are attributed to AI and its requester and remain undoable.
5. **Given** exhausted, disconnected or unknown funding availability, **when** new paid work is requested, **then** execution pauses with safe copy; it never switches payer, source or creates infrastructure implicitly. Existing readable work remains accessible while its host is available.
6. **Given** only guest document-AI permission, **when** a prompt requests an unrelated file, integration action, Git push or terminal command, **then** it cannot use broader owner credentials or capabilities. Broader execution requires separately explicit, enforceable scope permission.

### User Story 6 - Recover and retain control (Priority: P1, exercised at every milestone)

An owner and collaborators can trust attribution, access changes and recovery when devices, connections or the host fail.

**Why this priority**: Each released slice needs trustworthy failure behavior, not a final hardening phase.

**Independent Test**: Interrupt connections and restart a disposable host during discussion, edits and AI; reconnect, revoke one participant and verify canonical state, private drafts, billing attribution and access.

**Acceptance Scenarios**:

1. **Given** an offline owner host, **when** a participant opens a share, **then** it shows host unavailable with retry; it neither asks the guest to provision a machine nor creates a second authority.
2. **Given** a host restart, **when** clients recover, **then** acknowledged content is retained, duplicate operations are not applied, and unknown AI outcomes are shown as interrupted rather than successful or silently rerun.
3. **Given** a queued AI request from a revoked participant, **when** dispatch resumes, **then** it is denied before execution. Active runs follow an explicitly documented cancellation/termination policy and lose future guest-authorized side effects; already committed external effects cannot be claimed undone.
4. **Given** sign-out, account switching or access removal, **when** it completes, **then** live sessions and unauthorized cached previews clear and private drafts never appear under another identity. Previously downloaded files cannot be remotely recalled.
5. **Given** an owner export or deletion, **when** it finishes, **then** documents, discussion and history obey existing ownership/export/deletion rules, with no orphaned public previews or active grants. Authorship is retained or anonymized according to the existing deletion policy, never silently reassigned.

### Edge Cases

- Pending invitations for an unregistered email; verified aliases; wrong signed-in account; repeated accept; expiry racing accept; capacity racing concurrent invites.
- Existing organization member without a machine versus external guest; a person who is both; departure/rejoin; organization policy disabling external access; no automatic conversion of a revoked member into a guest.
- A guest invitation derived from an organization policy cannot outlive that policy; the last valid grant disappearing revokes effective access.
- Host unavailable before acceptance or after a ticket is issued; policy service partition; stale bundle/client; direct session renewal; copied deep link and open redirects.
- Invite includes existing content: title/history preview is shown only after intended-recipient verification. Standalone shares never disclose parents/siblings through breadcrumbs, search, attachments, mentions, exports or AI context.
- Host machine deleted, subscription suspended, or owner account removed: explain unavailability, follow existing retention/export policy and never bill a guest as fallback.
- Multiple tabs/devices per actor; background phone suspension; presence expiry; duplicated/out-of-order events; comments whose anchors disappear; deleted documents with pending edits.
- Source-specific spend cannot be measured or reserved: show usage as unknown, use enforceable request/concurrency limits, and do not promise a hard currency cap.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Account identity and collaboration grants MUST be independent of machine ownership, subscription, payment method and AI-account setup. New free accounts MUST be able to complete the invited journey.
- **FR-002**: Shared entry and Shared with me MUST load from the platform without a personal-runtime bootstrap. Authentication MUST preserve a validated same-origin destination and allow correcting the signed-in account.
- **FR-003**: All supported shares MUST resolve their authoritative host by resource identity. Joining MUST create no computer, project copy, worktree or charge.
- **FR-004**: Owners MUST be able to invite existing accounts and new verified email recipients to personal resources. Organization-bound resources MUST additionally obey explicit organization external-sharing policy, default off.
- **FR-005**: Guest status MUST describe the access relationship, not a third permission preset. Viewer and Contributor remain the content presets; guests gain neither organization membership nor resource-management authority.
- **FR-006**: Invitations MUST be recipient-bound, expiring, revocable, idempotent and safe under concurrent acceptance. The owner MUST see scope, included history, role and AI permission before sending. Default expiry is seven days; acceptance creates a durable grant until revoked, expired by an explicit grant policy, or the resource is deleted.
- **FR-007**: Every access path MUST enforce the current actor, effective grant, resource, lifecycle and applicable organization policy. Tickets, sockets, search, attachments, exports, presence, history and queued execution MUST follow the same authority.
- **FR-008**: Guest revocation and organization departure MUST have distinct recorded causes; departure MUST revoke grants bound to that organization and MUST NOT synthesize a personal grant. Independent pre-existing personal shares remain independent.
- **FR-009**: Live presence MUST distinguish accepted members from active connections, expire stale participants and limit exposed activity to the current audience. Private drafts MUST never enter shared content or AI context.
- **FR-010**: Discussion/comments MUST support participant-scoped mentions and personal unread activity with deduplicated in-app notifications. Background content previews MUST be reauthorized before display.
- **FR-011**: The first shared artifact MUST be a rich-text document supporting paragraphs, headings, lists, links and code blocks, simultaneous editing, cursor/selection presence, anchored comments, attribution, history, undo and portable export.
- **FR-012**: Shared documents and their history/comments MUST inherit their enclosing audience or hold explicit standalone grants. A document cannot be inserted into a broader Chat with narrower confidential content; publication requires explicit authorized audience expansion.
- **FR-013**: Concurrent edits, history restore and AI proposal application MUST preserve acknowledged work. Conflicts and unsaved local changes MUST remain visible and recoverable instead of being replaced silently.
- **FR-014**: Guest AI submission MUST be opt-in per shared resource and subject to the owner's permitted submitters, source, concurrent-run and request limits. Where supported, funding reservations MUST be atomic. Joining and ordinary viewing/editing MUST not require the guest to pay.
- **FR-015**: Every shared AI run MUST retain requester, owner, payer/access source, harness/model, resource and authorization provenance. Preserve the existing one-run-per-Chat queue; do not create one execution session per collaborator.
- **FR-016**: Document-AI output MUST be a revision-bound proposal with visible progress and attributed application. Acceptance requires current edit and proposal-approval authority. Requester/owner cancellation and tool decisions MUST retain the existing control semantics.
- **FR-017**: External guest AI and terminal permissions MUST NOT inherit unrestricted owner integrations or credentials by default. Before enablement, a capability test MUST prove that the granted actions are the only reachable actions, including through indirect tools and prompt injection.
- **FR-018**: Disconnection MUST preserve private drafts and visibly unsaved document work, bound local storage, reauthorize before replay and distinguish host outage from revoked access. Arbitrary offline authoritative editing is excluded.
- **FR-019**: The experience MUST reuse ordinary Chat/Terminal components, the compact access summary/owner manager, discussion drawer or mobile sheet, and Shared with me. Do not add a duplicate collaboration app, alternate timeline or Discussion/Ask AI composer switch.
- **FR-020**: Web Canvas, Web Desktop and Electron Desktop MUST expose equivalent information, actions, permissions and recovery. Web Mobile MUST complete machine-free entry and document collaboration; Native Mobile MUST use the same authority and recover its existing collaboration transport before new functionality is claimed. Per-milestone surface gates are explicit in the delivery plan.
- **FR-021**: Invitation, role, grant, source-policy, proposal, restore and deletion actions MUST be attributable and exportable within the authorized owner boundary. Platform metadata MUST not become an alternate content store.
- **FR-022**: Capacities, retention, expiry, recovery and timeout policies MUST be bounded and tested before each milestone ships. Limits MUST yield actionable states without creating additional compute.
- **FR-023**: Each delivered milestone MUST include real separate-account acceptance evidence, owner-host failure/revocation tests, and a separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/`.

### Key Entities

- **Account**: stable authenticated person, optionally owns zero or more machines; buying compute does not change identity.
- **Invitation**: owner, resource, intended verified recipient, preset, guest AI permission, expiry and acceptance/decline/revocation state.
- **Access grant**: resource-scoped relationship, subject, personal or organization policy boundary, capabilities, revision, expiry and revocation cause; multiple grant sources are evaluated explicitly.
- **Resource home**: existing authoritative owner host; independent of the recipient's devices or machines.
- **Presence session**: ephemeral authorized actor/device activity in a scope with last-seen expiry; never draft content.
- **Shared document**: stable identity, audience, content and revision history; associated with a Chat/project or shared standalone.
- **Comment/activity item**: attributed discussion, anchor and resolution or notification state; content stays within the resource audience and read state is personal.
- **AI change proposal**: run/requester provenance, target document and base revision, proposed changes, decision and resulting revision.
- **Execution policy**: owner-selected access source, submitters, capabilities and enforceable limits; no implicit guest billing or funding fallback.

### Assumptions and explicit exclusions

- Signed-in accounts are required for live participation. Anonymous snapshot sharing keeps its existing separate semantics; an invitation URL alone grants no live content access.
- Start with the existing participant cap of eight per scope; this feature does not silently raise it. Invitation and presence limits are specified during planning and include pending recipients and multi-device use.
- A recipient can view, discuss, edit and request authorized AI without an extra machine. The existing host bears compute/storage and configured inference costs; this specification sets no new price, paid guest seat or infrastructure sponsorship product.
- Member-owned resources remain member-owned. Contribution attribution and collaborative access do not silently transfer ownership. Organization-owned durability and owner-departure recovery remain separate work; no creator-independent availability claim is made.
- External sharing policy requires a minimal authenticated organization security control, not a full organization administration/billing product. Existing member sharing semantics remain compatible.
- A document is the first editable artifact. Spreadsheets, slides, general whiteboard co-editing, follow-participant mode, reactions, offline peer authorities, host migration/failover, anonymous live editing and third-party messaging bridges are deferred.
- Copy/export of permitted content is supported; copied files are independent and do not synchronize back. No mechanism promises to erase files already downloaded by a former participant.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a ten-person first-use acceptance study, at least nine invited people with no Matrix machine complete sign-in, acceptance and their first permitted contribution within two minutes, excluding time waiting for email delivery; zero encounter checkout or provisioning.
- **SC-002**: In automated real-account journeys, machine and subscription counts for recipients remain zero before and after accept/open/discuss/edit/AI/reconnect. Every granted action succeeds and every sibling/parent/outsider probe fails.
- **SC-003**: With eight participants on a supported host and network round-trip latency at or below 150 ms, p95 remote document edit visibility is at most one second; presence changes appear within two seconds and stale presence disappears within 30 seconds of lost heartbeat.
- **SC-004**: Across at least 100 randomized concurrent-edit/reconnect scenarios, every acknowledged edit is preserved or explicitly represented by a conflict/recovery result; no committed discussion or AI request is duplicated.
- **SC-005**: New guest operations are denied immediately after authoritative revocation commits; connected views lose access within five seconds on a healthy link, and partitioned grants expire under a documented authorization lease of at most 60 seconds. Tests verify no new content/action admission after expiry.
- **SC-006**: The same revision/proposal journey succeeds on Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile before full feature completion, with per-surface evidence and no client-side permission disagreement.
- **SC-007**: All stale AI proposals, unauthorized approvals, exhausted-limit requests and revoked queued requests in the acceptance matrix are rejected or paused without overwriting human edits, changing payer or duplicating paid work.
- **SC-008**: Every milestone passes host-offline, restart, account-switch and sign-out tests, preserves acknowledged content and private drafts as specified, and publishes documentation of its actual availability and limits.
