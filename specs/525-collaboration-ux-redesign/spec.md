# Feature Specification: Native Collaboration UX Redesign

**Feature Branch**: `525-collaboration-ux-redesign`  
**Created**: 2026-09-17  
**Status**: Draft — pending targeted UX clarification  
**Input**: Redesign Matrix OS collaboration so sharing feels like a capability of ordinary Chat and Terminal sessions, with unobtrusive human discussion, access management, and first-class discovery, while preserving the existing collaboration architecture and authorization model.
**Depends on**: The behavior, authority, roles, canonical history, queue, invitation, realtime, and terminal-control contracts in `specs/121-collaboration-session-sharing/`. This specification changes their presentation and shell integration, not their security model.

## Context

The current collaboration implementation is functionally integrated with Matrix, but shared sessions still read as a separate product. A shared Chat replaces the ordinary Chat timeline and composer with a collaboration-specific renderer, adds a second session header, asks people to switch between “Discussion” and “Ask AI,” and gives the queue persistent visual weight. “Shared with me” is not yet a first-class shell destination on all applicable surfaces. Shared terminals expose sharing, but their access and discussion controls are not yet presented as a restrained extension of the ordinary terminal chrome.

This redesign makes collaboration a state of an existing Chat or terminal. The ordinary session remains dominant; collaboration controls disclose membership, human-only discussion, invitations, queue state, and terminal control only when relevant.

## Clarifications

### Session 2026-09-17

- Q: What transient surface should the human-only discussion layer use on desktop and mobile? → A: [NEEDS CLARIFICATION: choose the desktop and mobile discussion-layer presentation]
- Q: How should collaboration status and member management be progressively disclosed from the session header? → A: [NEEDS CLARIFICATION: choose the compact access-control interaction]
- Q: How should “Shared with me” appear in Canvas, Desktop/Electron, and mobile navigation? → A: [NEEDS CLARIFICATION: choose the shell-level destination model]

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Collaborate in an Ordinary Chat (Priority: P1)

As an owner or editor, I want a shared Chat to keep the same timeline, AI behavior, and composer as every other Matrix Chat so collaboration feels native and I do not have to learn a second Chat product.

**Why this priority**: The current replacement renderer and “Discussion / Ask AI” mode switch directly conflict with the intended product model. Restoring the ordinary Chat experience is the central outcome of the redesign.

**Independent Test**: Open the same accepted shared Chat as two authorized accounts in Canvas. Each person submits through the ordinary composer, sees both human prompts on the human/right side with subtle author attribution, and sees the AI reply on the AI/left side without encountering a collaboration-specific mode switch.

**Acceptance Scenarios**:

1. **Given** an owner opens a private Chat, **when** it is unshared, **then** its timeline, composer, header, setup controls, shortcuts, and responsive behavior remain visually and behaviorally equivalent to the current normal Chat except for one restrained access entry point.
2. **Given** an owner or editor opens an accepted shared Chat, **when** they submit text through the ordinary composer, **then** it is accepted as a prompt to the shared AI session without selecting a separate “Ask AI” mode.
3. **Given** two authorized people submit prompts, **when** their messages appear in the timeline, **then** both use the normal human/right-side presentation and show subtle, persistent attribution sufficient to distinguish the authors.
4. **Given** the AI responds, requests input, uses tools, exposes reasoning, or needs approval, **when** that content appears, **then** it uses the existing normal Chat presentation and remains on the AI/left side.
5. **Given** one or more AI requests are waiting, **when** the queue is relevant, **then** the affected people see a compact status close to the normal composer; a detailed queue is disclosed only when multiple requests are pending, a request is waiting, or the person explicitly opens it.
6. **Given** a viewer opens the same Chat, **when** they inspect the timeline, **then** the ordinary composer is visibly read-only and all direct or stale mutation attempts remain rejected.
7. **Given** the owner runtime is unavailable, the membership is revoked, or access expires while the Chat is open, **when** the state is detected, **then** the normal Chat frame remains stable and shows a safe, actionable unavailable or revoked state without exposing owner-runtime details.
8. **Given** a person has an unsent Chat draft, **when** collaboration events, role changes, navigation, or another person's typing occurs, **then** that draft remains private to its author and is neither overwritten nor broadcast.

---

### User Story 2 - Discuss Around the Session Without Replacing It (Priority: P1)

As a collaborator, I want a separate human-only discussion layer attached to a Chat or terminal so the team can leave notes and comments without turning those comments into AI prompts or displacing the main session.

**Why this priority**: Human discussion is required, but placing it in the primary composer creates a mode-switching product that competes with the AI session.

**Independent Test**: From a shared Chat and a shared terminal, open the discussion control, exchange human-only messages between two accounts, dismiss the layer with all supported mechanisms, and verify no AI request or terminal input is created and the underlying session never changes size or position.

**Acceptance Scenarios**:

1. **Given** a shared Chat or terminal, **when** an authorized member activates the discussion control, **then** a clearly labeled human-only layer appears above the session without replacing it or permanently changing its layout.
2. **Given** the discussion layer is open, **when** a person posts a note, **then** the note is shared with members and never enters the AI queue or terminal input stream.
3. **Given** a person is composing a discussion note, **when** another person posts, the layer closes, access changes, or the connection recovers, **then** their unsent draft remains private and is not silently discarded.
4. **Given** the layer is open, **when** the person activates its trigger again, clicks outside it, or presses Escape, **then** it closes and focus returns to the trigger.
5. **Given** an unread human note arrives while the layer is closed, **when** the recipient views the session header, **then** the discussion control shows a restrained unread indication without interrupting the AI conversation or terminal.
6. **Given** a viewer opens discussion, **when** they read notes, **then** they may inspect the human discussion but cannot post or mutate it under the existing viewer rules.
7. **Given** reduced motion is enabled, **when** the layer opens or closes, **then** it uses a non-spatial fade or equivalent low-motion transition.
8. **Given** a narrow or mobile viewport, **when** discussion opens, **then** all messages, composer state, dismiss actions, focus order, and the underlying-session context remain usable without horizontal scrolling.

---

### User Story 3 - Share and Manage Access from Session Chrome (Priority: P1)

As an owner, I want compact sharing controls in the ordinary Chat or terminal header so I can see whether the session is shared, distinguish snapshot publishing from live collaboration, and manage members without leaving my work.

**Why this priority**: Sharing must be discoverable without turning the session into an access dashboard or conflating public snapshots with live authorization.

**Independent Test**: Starting from an unshared Chat, create a snapshot and separately invite a collaborator by supported identifier, accept from another account, change the collaborator's role, revoke access, and verify the session chrome stays visually restrained throughout.

**Acceptance Scenarios**:

1. **Given** an unshared Chat or eligible terminal, **when** the owner views its header, **then** a restrained collaboration/access control is available and the rest of the session remains visually equivalent to its normal unshared state.
2. **Given** a Chat owner opens sharing choices, **when** choices are presented, **then** “Share snapshot” and “Invite collaborators” are distinct actions with concise explanations of frozen-public-copy versus authenticated-live-access consequences.
3. **Given** collaboration is enabled and an owner invites a person, **when** they enter a supported exact username or email and choose editor or viewer, **then** the invitation is created through the existing identity resolution and authority model with safe generic failure messages.
4. **Given** a session is shared, **when** any member opens collaboration details, **then** they can see members, roles, invitation state where authorized, owner identity, their own role, and the scope of the share.
5. **Given** the owner changes a role or revokes a member, **when** the operation succeeds, **then** the displayed access state and live capabilities update promptly; late or delayed client actions remain rejected.
6. **Given** an editor or viewer opens collaboration details, **when** they inspect it, **then** owner-only actions are absent or disabled consistently and direct unauthorized requests remain rejected.
7. **Given** a snapshot exists independently of live collaboration, **when** membership changes or the snapshot is revoked, **then** the other access mechanism is unchanged and the interface explains the distinction where the action occurs.
8. **Given** the collaboration feature flag is off, **when** any Chat or terminal renders, **then** live collaboration controls, discussion controls, member management, invitations, badges, and Shared-with-me destinations are hidden while existing snapshot sharing continues under its own policy.

---

### User Story 4 - Collaborate in an Ordinary Terminal (Priority: P1)

As an owner, editor, or viewer, I want terminal collaboration to extend the existing terminal chrome while the terminal remains the dominant surface.

**Why this priority**: Terminal sharing has high execution authority and must communicate controller state clearly without creating a dashboard or alternate terminal experience.

**Independent Test**: Share one eligible running terminal with an editor and viewer, attach from separate accounts, request and transfer control, revoke the editor, and verify the same terminal stays dominant while delayed input, paste, and resize are rejected.

**Acceptance Scenarios**:

1. **Given** a private eligible terminal, **when** it is unshared, **then** the terminal viewport, session controls, tabs, layout, and keyboard interaction remain unchanged except for compact collaboration/access and discussion entry points in existing chrome.
2. **Given** a shared terminal, **when** members attach, **then** all see the same retained and live output inside the normal terminal experience with an unobtrusive label for owner, role, and current controller.
3. **Given** an eligible editor does not control input, **when** control is free or held, **then** the available request/wait/release state is understandable without a large collaboration dashboard.
4. **Given** the owner takes over or the controller releases/expires, **when** control transfers, **then** the chrome announces the new controller and input focus follows the authorized state.
5. **Given** control transfers, a role is downgraded, or access is revoked, **when** stale input, paste, or resize arrives, **then** it is rejected and the terminal shows no misleading local success.
6. **Given** a viewer attaches, **when** they use the terminal, **then** output remains readable while input, paste, resize, stop, takeover, and creation controls remain unavailable.
7. **Given** human discussion is available for the terminal, **when** it opens, **then** it uses the same discussion-layer pattern and semantics as Chat, adapted only for viewport size.
8. **Given** a terminal is ineligible for safe sharing or its owner runtime is unavailable, **when** the owner attempts sharing or a member opens it, **then** the existing terminal continues unchanged and a safe, specific unavailable state appears in the collaboration control.

---

### User Story 5 - Find Invitations and Shared Sessions (Priority: P1)

As a Matrix user, I want a first-class “Shared with me” destination so I can find pending invitations and reopen accepted shared Chats or terminals without keeping a deep link.

**Why this priority**: A collaboration product is incomplete if discovery depends on copied URLs or an account-menu entry.

**Independent Test**: Invite a user to a Chat and terminal, verify a pending count appears in supported shell navigation, accept one and decline one, then reopen the accepted item from “Shared with me” inside the normal Chat or Terminal app in Canvas and Desktop/Electron.

**Acceptance Scenarios**:

1. **Given** collaboration is enabled, **when** the user opens Canvas, Desktop/Electron, responsive web, or an applicable native/mobile shell, **then** “Shared with me” is present in the shell's primary navigation at the clarified location.
2. **Given** pending invitations exist, **when** the navigation is visible, **then** it shows a clear bounded pending indication that does not disclose private resource data.
3. **Given** the user opens “Shared with me,” **when** data loads, **then** pending invitations appear before accepted items and show owner, requested role, item type, and accept and decline actions.
4. **Given** accepted shared items exist, **when** they are listed, **then** Chats and terminals show owner, role, item type, useful live/unavailable status, and a direct open action.
5. **Given** a shared Chat or terminal is opened from the destination or a deep link, **when** navigation resolves, **then** it opens inside the native Chat or Terminal app and never as a naked standalone collaboration page.
6. **Given** no items exist, data is loading, the directory is unavailable, access was revoked, or the owner runtime is unavailable, **when** the destination renders, **then** it shows a polished, appropriately differentiated state with a safe recovery action.
7. **Given** an invitation is accepted or declined, **when** the operation settles, **then** the list and pending indication update without a full shell reload and repeated operations remain safe.
8. **Given** the collaboration feature flag is off, **when** the shell renders, **then** the destination and pending indication are absent on every surface.

---

### User Story 6 - Preserve One Experience Across Surfaces (Priority: P2)

As a person who moves between Matrix surfaces, I want shared sessions to preserve the same mental model, permissions, and navigation even when physical layout adapts to the device.

**Why this priority**: Canvas is primary, but collaboration cannot create divergent authority or interaction semantics in Web Desktop, Electron, responsive web, or supported native/mobile integration points.

**Independent Test**: Repeat the owner, editor, viewer, pending, revoked, and unavailable-runtime journeys in Canvas first, then Web Desktop, Electron Desktop, responsive web, and supported native/mobile surfaces, comparing behavior and recorded evidence.

**Acceptance Scenarios**:

1. **Given** the same shared Chat, **when** it opens on Canvas, Web Desktop, or Electron Desktop, **then** it uses the same ordinary Chat information hierarchy, author attribution, access controls, discussion semantics, and routing outcome.
2. **Given** a supported mobile surface, **when** the person opens collaboration controls or discussion, **then** those transient surfaces adapt to touch and safe areas without changing permissions or replacing the main session model.
3. **Given** any openable collaboration panel, **when** it opens or closes, **then** it supports trigger toggle, light dismiss, Escape where a hardware keyboard exists, focus entry/return, labeled controls, and reduced-motion behavior.
4. **Given** realtime events arrive on two accounts, **when** human prompts, AI responses, discussion notes, queue state, roles, controller state, or revocation changes, **then** both surfaces converge on the same authoritative outcome with correct human attribution.
5. **Given** a user follows an old collaboration deep link, **when** the item still exists, **then** the shell normalizes it into the corresponding native app; when it does not, the shell shows the appropriate revoked or unavailable state without exposing internal details.
6. **Given** a user-visible redesign change is proposed for review, **when** its pull request is ready, **then** current screenshots or a recording demonstrate Canvas first and every materially different applicable surface.

### Edge Cases

- Several authorized people submit AI prompts while one response is streaming and the queue moves between one, several, waiting, failed, and empty states.
- Human attribution is missing for imported historical entries, an account has no avatar, display names collide, or a display name changes after a message is committed.
- A discussion note arrives while the discussion layer is closing, focus is inside the composer, or the viewport changes between desktop and mobile sizes.
- The collaboration feature flag changes while a collaboration surface is open.
- An invitation is accepted, declined, revoked, expired, or duplicated from another device while “Shared with me” is open.
- The owner deletes, archives, transfers, or makes a resource unavailable while a participant has the Chat, terminal, discussion layer, queue details, or access manager open.
- A role downgrade or revocation races with prompt submission, discussion posting, approval, retry, terminal control acquisition, paste, or resize.
- A deep link opens before shell bootstrap, account authentication, feature-capability discovery, or owner-runtime availability finishes.
- The pending-invitation indication reaches its display cap and must remain useful without revealing invitation details.
- A small window, browser zoom, large text, screen reader, keyboard-only navigation, high contrast, reduced motion, or mobile safe-area inset affects transient layers and header controls.
- Snapshot sharing is available while live collaboration is off, or both exist with independent revocation states.
- The Chat or terminal belongs to a shared project and access is inherited rather than directly managed on the item.

## Requirements *(mandatory)*

### Functional Requirements

#### Native Chat experience

- **FR-001**: A shared Chat MUST use the ordinary Matrix Chat timeline, message presentation, composer, AI response rendering, tool/approval rendering, keyboard behavior, and responsive frame rather than a separate collaboration page or replacement Chat UI.
- **FR-002**: The ordinary Chat composer MUST submit AI prompts for owners and editors in shared Chats; no prominent “Ask AI” mode or discussion/AI mode switch may be required.
- **FR-003**: Prompts from every authorized human MUST use the normal human/right-side presentation and include subtle display-name and avatar attribution with an accessible text equivalent.
- **FR-004**: AI output MUST use the normal AI/left-side presentation and existing rendering for streaming, rich content, tools, approvals, and recoverable errors.
- **FR-005**: The shared AI session MUST continue to execute on the owner runtime through the owner's existing gateway, workspace/runtime context, AI account, authorized credentials, canonical history, and execution policy while preserving the authenticated initiating actor at every authorization boundary.
- **FR-006**: Queue admission, accepted order, single-active execution, cancellation, retry, approval, and reauthorization behavior MUST remain governed by the existing collaboration contracts.
- **FR-007**: Queue UI MUST remain hidden when it has no useful information, use a compact indicator for one active or queued request, and disclose detailed ordered state when multiple requests are pending, a request is waiting, an error requires action, or a person opens it.
- **FR-008**: Viewer restrictions MUST be reflected in the composer and action controls and MUST remain enforced by the authoritative server behavior.

#### Human-only discussion layer

- **FR-009**: Every shared Chat and shared terminal MUST provide a separate, clearly labeled human-only discussion layer opened from session chrome.
- **FR-010**: Discussion messages MUST NOT enter the Chat AI queue, prompt the AI, write terminal input, or appear as AI-session prompts.
- **FR-011**: The discussion layer MUST use the clarified desktop/mobile presentation, overlay the session without layout shift, and support trigger toggle, light dismiss, Escape, focus entry/return, keyboard navigation, touch targets, and reduced motion.
- **FR-012**: Discussion drafts MUST remain private to their author, be independently scoped from the normal Chat prompt draft, and survive transient closing and safe reconnect/navigation behavior consistent with existing bounded draft policy.
- **FR-013**: The closed discussion control MUST support a restrained unread indication and accessible announcement without interrupting the primary session.
- **FR-014**: Viewers MUST be able to read discussion where the existing role contract allows session reads, but MUST NOT post or mutate discussion.

#### Session access and sharing

- **FR-015**: Ordinary Chat and terminal chrome MUST include the clarified compact collaboration/access control and a separate discussion control only when live collaboration is enabled for the user and runtime.
- **FR-016**: Unshared sessions MUST remain visually close to their current normal state; shared status, current role, member presence, and controller state MUST use progressive disclosure and restrained indicators.
- **FR-017**: Chat sharing MUST preserve distinct “Share snapshot” and “Invite collaborators” actions and MUST explain their different audience, mutability, authentication, expiry, and revocation semantics at the point of choice.
- **FR-018**: Snapshot tokens MUST never authenticate live collaboration, and live collaboration proofs, tickets, or invitations MUST never authenticate snapshot management or public snapshot reads.
- **FR-019**: Authorized owners MUST be able to invite by every exact identity form supported by the existing backend, including username and verified email, choose editor or viewer, inspect pending and accepted members, change roles, and revoke access.
- **FR-020**: Editors and viewers MUST see only the access information and actions permitted by the existing owner/editor/viewer model; the redesign MUST NOT add commenter, custom, or item-exception roles.
- **FR-021**: Member, invitation, scope, inherited-access, and lifecycle displays MUST derive from the existing collaboration authority and MUST NOT create a second client or backend source of truth.
- **FR-022**: Client-facing collaboration failures MUST use bounded generic messages and MUST NOT expose owner paths, provider names, host details, credentials, database errors, or raw validation details.

#### Native terminal experience

- **FR-023**: Shared terminal output and input MUST remain inside the ordinary terminal surface, with the terminal viewport visually dominant and no embedded collaboration dashboard.
- **FR-024**: Terminal chrome MUST show compact shared/private status, effective role, and current controller state, with owner/editor control actions disclosed only when relevant.
- **FR-025**: Controller acquisition, waiting, release, owner takeover, lease expiry, stop, and viewer restrictions MUST retain the existing terminal-control rules.
- **FR-026**: Delayed input, paste, resize, renew, or release after controller transfer, downgrade, or revocation MUST remain rejected authoritatively and MUST not receive optimistic success styling.
- **FR-027**: The terminal discussion control MUST use the same human-only layer pattern as Chat unless the clarified responsive presentation requires a device adaptation.
- **FR-028**: Ineligible sharing MUST leave the original terminal and process unchanged and explain that sharing is unavailable without revealing the isolation implementation.

#### Shared discovery and native routing

- **FR-029**: Matrix MUST provide a first-class “Shared with me” destination at the clarified shell-navigation location in Canvas first, Web Desktop, Electron Desktop, responsive web, and supported native/mobile surfaces.
- **FR-030**: The destination MUST show a bounded pending-invitation indication and list pending invitations with owner, role, item type, accept, and decline actions.
- **FR-031**: The destination MUST list accepted shared Chats and terminals with owner, effective role, item type, and relevant availability or live status.
- **FR-032**: Opening an accepted item from discovery or a deep link MUST resolve into the ordinary native Chat or Terminal app and MUST NOT leave the user on standalone collaboration HTML.
- **FR-033**: Discovery MUST distinguish loading, empty, partial-pagination, error, pending, revoked, expired, archived, owner-runtime-unavailable, and unsupported-client states with safe recovery actions.
- **FR-034**: Invitation actions, realtime updates, and membership changes MUST update the destination and pending indication without requiring a full shell reload.
- **FR-035**: When live collaboration is off for the user, all live-collaboration destinations, pending indicators, access controls, discussion controls, member controls, and terminal-sharing controls MUST be hidden on every surface; snapshot sharing remains governed independently.

#### Cross-surface quality and state

- **FR-036**: Canvas MUST be the primary design and verification surface, followed by Web Desktop and Electron Desktop; responsive web and supported native/mobile integration points MUST retain equivalent behaviors and permissions with adapted physical layout.
- **FR-037**: Transient collaboration surfaces MUST NOT push, shrink, or reflow the Chat timeline, composer, terminal viewport, existing window chrome, or shell navigation.
- **FR-038**: Open/closed presentation state, drafts, focus return targets, read state, and other personal presentation state MUST remain per person and MUST NOT enter shared history, shared layout, directory metadata, or exports.
- **FR-039**: Any shared client store state introduced or changed by the redesign MUST remain serializable, and component subscriptions MUST not create unstable derived selections.
- **FR-040**: The experience MUST support keyboard-only use, visible focus, screen-reader labels and state, polite announcements for collaboration changes, appropriate focus containment, touch-safe targets, high-contrast readability, and reduced-motion transitions.
- **FR-041**: Route and navigation behavior MUST be tested so Chat and terminal invitations, accepted items, browser refreshes, shell-mode changes, and legacy deep links always resolve into native application surfaces.
- **FR-042**: Owner, editor, viewer, pending invitation, revoked member, expired invitation, feature-off, and unavailable-owner-runtime states MUST have automated coverage and current user-visible evidence on applicable surfaces.
- **FR-043**: Realtime tests MUST use two distinct accounts and verify human attribution, prompt ordering, discussion isolation, queue changes, role changes, terminal controller changes, and revocation outcomes.
- **FR-044**: Every implementation change MUST preserve the existing collaboration backend, canonical Chat history, membership authority, role model, queue, realtime events, owner-runtime execution, and terminal-control model unless a documented, minimal UX-enabling contract gap is proven first.

### Key Entities

- **Native Shared Session**: An ordinary Chat or terminal with collaboration capabilities and status added to its existing chrome; it is not a separate product surface.
- **Session Collaboration State**: Private/shared status, effective role, owner, capabilities, member summary, invitation status, availability, and current authority revision derived from the existing collaboration scope.
- **Attributed Human Prompt**: A normal AI prompt in canonical Chat history that retains its initiating human's safe display attribution.
- **Human Discussion Thread**: Human-only notes attached to one collaboration scope and kept distinct from AI prompts, AI output, and terminal input.
- **Private Drafts**: Separate author-only unsent prompt and discussion text plus personal presentation state.
- **Queue Summary**: A compact projection of existing accepted order and request state, expanded only when useful.
- **Access Summary**: Compact session-header projection of whether the session is shared, the current role, member presence, and available management actions.
- **Shared Discovery Item**: A pending invitation or accepted shared Chat/terminal projection with owner, role, kind, and safe status; it never authorizes access by itself.
- **Pending Invitation Indicator**: A bounded, non-content-bearing navigation signal derived from the current signed-in user's invitation index.
- **Terminal Controller Summary**: Current controller identity label, lease state, and role-permitted control actions projected into normal terminal chrome.

### Preserved Authorization and Privacy Boundary

- Authentication MUST continue to identify the actual human actor. The redesign MUST never rewrite a participant into the owner's identity or use owner session credentials as participant authentication.
- The owner runtime MUST remain authoritative for live membership and content. Platform discovery metadata may locate a resource but MUST never grant it.
- AI and terminal execution MUST remain on the owner's runtime within the existing scoped execution and credential policy. The participant's runtime or AI account MUST not become an alternate execution authority.
- Standalone Chat or terminal sharing MUST not grant parent-project, sibling-resource, owner-home, separate attachment-destination, or personal-system access.
- Snapshot publication MUST remain a frozen, separately authorized feature and MUST not become live history or membership.
- Private drafts, view preferences, focus, read position, and presentation state MUST remain private to the person.

### Assumptions and Dependencies

- The owner/editor/viewer role model, invitation capacity, queue ordering, membership authority, canonical history, realtime invalidations, owner-runtime execution, and terminal lease/control behavior implemented under specification 121 remain authoritative.
- Existing backend identity resolution supports exact Matrix username and verified email where configured; this redesign exposes only already-supported forms.
- Existing human attribution is sufficient at the contract boundary; historical entries without a known actor use the existing safe unknown-author treatment.
- The redesign may add the smallest safe read projection needed for navigation badges or discussion unread state only if current contracts cannot supply it without broad fetching. Any such gap must be documented before backend work.
- “Chat” remains capitalized when referring to the Matrix app/session concept, matching current product language.
- Current public documentation under `www/content/docs/` will be updated as an implementation deliverable.

### Explicitly Out of Scope

- Replacing or redesigning the collaboration backend, authority, actor-proof, owner-runtime routing, canonical Chat store, queue, realtime transport, role model, execution isolation, or terminal-control lease model.
- A second transcript, discussion-as-AI mode, snapshot-backed live history, participant-runtime AI execution, or owner impersonation.
- Commenter/custom roles, viewer posting, partial-project sharing, per-child exceptions, or personal shared layouts.
- Standalone file/document sharing, document co-editing, cursor presence, reactions, mentions, general team messaging, or unrelated collaboration products.
- Exposing owner-home files, private memory, credentials, sibling sessions, parent projects, or separate attachment destinations through standalone sharing.
- A large terminal collaboration dashboard, replacement terminal renderer, or automatic replacement of an ineligible running process.
- Merging pull requests or enabling production rollout without explicit owner approval and the repository's review gates.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability verification, at least 9 of 10 participants correctly use the ordinary shared-Chat composer to ask the AI on their first attempt without looking for an “Ask AI” mode.
- **SC-002**: In automated and manual comparison, unshared Chat and terminal primary layouts show zero unintended position or size changes when live collaboration is enabled but unused.
- **SC-003**: In all tested shared-Chat messages, 100% of human prompts appear on the human/right side with an accessible author label and 100% of AI responses remain on the AI/left side.
- **SC-004**: In all discussion-layer tests, opening and closing causes no measured reflow of the underlying Chat composer or terminal viewport, and all three dismiss mechanisms succeed where supported.
- **SC-005**: In two-account tests, 100% of discussion messages remain outside the AI request queue and terminal input, while 100% of ordinary shared-Chat composer submissions enter the existing AI flow for authorized owners/editors.
- **SC-006**: A signed-in recipient can discover a pending invitation, accept it, and open the shared item inside the native Chat or Terminal app in under two minutes without using a copied deep link.
- **SC-007**: Route tests show 100% of supported shared Chat and terminal links resolve into native app surfaces across Canvas, Web Desktop, and Electron Desktop, with no naked standalone collaboration page.
- **SC-008**: Role-state tests show zero successful viewer mutations and zero accepted delayed terminal input, paste, or resize after control transfer, downgrade, or revocation.
- **SC-009**: Feature-off tests show zero live-collaboration controls, badges, destinations, or broken actions across every applicable surface while existing snapshot sharing remains usable.
- **SC-010**: Keyboard and screen-reader verification completes every primary collaboration flow without a pointer, with focus returning to each trigger after transient surfaces close and status changes announced without interrupting typing.
- **SC-011**: Current screenshot or recording evidence demonstrates the final owner, editor, viewer, pending, revoked/unavailable, feature-off, Chat discussion, Chat queue, terminal control, Canvas, Desktop/Electron, and responsive/mobile states before the implementation is considered review-ready.
- **SC-012**: No implementation pull request exceeds the repository's review-size limit; any required stack is split only along coherent UX boundaries and every layer passes its relevant tests independently.
