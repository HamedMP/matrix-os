# Feature Specification: Side Chat in the Electron Desktop Chats Inspector

**Feature Branch**: `633-add-inspector-side-chat`
**Created**: 2026-10-19
**Status**: Draft for product review
**Input**: Add a side chat to the right sidebar of the Electron Desktop Chats app, alongside its Files and Terminal tabs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask a separate question beside the main Chat (Priority: P1)

While working in a Chat in Electron Desktop, the user opens the right inspector and chooses **New side chat** from its add-tab menu. A new Chat tab opens in the inspector. The main Chat remains visible and usable, so the user can ask a related question without navigating away.

**Why this priority**: Keeping the main conversation visible is the reason to add a side chat to this surface.

**Independent Test**: Open a main Chat, create a side chat, send one message in each pane, and confirm both conversations remain visible and independent.

**Acceptance Scenarios**:

1. **Given** a main Chat is open and the inspector is hidden, **when** the user opens the inspector and selects **New side chat**, **then** the inspector displays a new side chat tab beside the main Chat.
2. **Given** a side chat tab is open, **when** the user sends a message in it, **then** that message and its response appear in the side chat, while the main Chat's transcript, draft, and active run remain unchanged.
3. **Given** a side chat is running, **when** the user continues the main Chat, **then** both conversations can progress without either pane replacing the other's selection or messages.

---

### User Story 2 - Move among inspector tabs (Priority: P2)

The user can switch among Files, existing Terminal tabs, and side chat tabs in the same right inspector. The add-tab menu still opens Files and creates a Terminal; it now also creates a side chat.

**Why this priority**: A side chat must fit the inspector's existing workflow and preserve its other tools.

**Independent Test**: Open a file, a Terminal, and a side chat; switch among their tabs and confirm each returns to its prior content.

**Acceptance Scenarios**:

1. **Given** Files, Terminal, and side chat tabs are open, **when** the user switches tabs, **then** the chosen panel appears and the other panels retain their in-progress state.
2. **Given** the Files tab is selected, **when** the user chooses **Files** from the add-tab menu, **then** the existing Files tab is selected rather than duplicated.
3. **Given** a side chat tab is open, **when** the user closes that tab, **then** the Chat remains in the user's Chat history and the inspector selects another available tab.

---

### User Story 3 - Resume the right conversation (Priority: P3)

The user can close and reopen the inspector or return to a main Chat and find its side chat again, without accidentally showing a side chat from a different main Chat or account.

**Why this priority**: Side chats are useful beyond a single uninterrupted inspector session, and conversation mix-ups would erode trust.

**Independent Test**: Create a side chat, leave and return to the main Chat, reload Electron Desktop, and verify the side chat can be reopened with its transcript intact.

**Acceptance Scenarios**:

1. **Given** a side chat has messages, **when** the user hides and reopens the inspector, **then** its tab and selected state return for the same main Chat.
2. **Given** a side chat is associated with main Chat A, **when** the user opens main Chat B, **then** A's inspector tab is not presented as B's side chat; returning to A restores access to it.
3. **Given** the application is reloaded, **when** the user returns to the main Chat, **then** they can reopen the side Chat and see its persisted conversation.

### Edge Cases

- Starting from a new, unsent main Chat must not send a message or create a main Chat merely to open the inspector. The side chat may be drafted, then attached to the resulting main Chat when one exists.
- A narrow Electron window must keep both conversations usable through the existing responsive inspector behavior; controls and message input must remain reachable by keyboard.
- Switching inspector tabs while either Chat is responding must not cancel, duplicate, or redirect a run.
- A failed side chat creation or send must show a recoverable error in the side chat and preserve both drafts.
- A deleted or inaccessible side Chat must show a clear unavailable state and let the user remove its tab without affecting the main Chat.
- Signing out or switching runtime/account must not show a previous account's side chat tabs or messages.
- A shared or read-only main Chat must not grant extra sending rights in a side chat. The user's normal Chat permissions apply.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: In Electron Desktop's Chats view, the right inspector MUST offer **New side chat** alongside its existing Files and New terminal actions.
- **FR-002**: Selecting **New side chat** MUST create and select a distinguishable inspector tab containing a Chat composer and conversation view.
- **FR-003**: The side Chat MUST be an independent, owner-visible Chat. Its messages, draft, run, provider selection, and errors MUST remain separate from the main Chat.
- **FR-004**: The side Chat MUST inherit the main Chat's project association when one exists. It MUST NOT automatically copy or send the main Chat's transcript, files, or unpublished draft.
- **FR-005**: The main Chat MUST remain visible while the side chat tab is selected whenever the Electron window is wide enough for the inspector's existing side-by-side layout.
- **FR-006**: The inspector MUST retain the existing Files and Terminal actions and allow switching among their tabs and side chat tabs without losing in-progress work.
- **FR-007**: A user MUST be able to create more than one side chat for a main Chat; each must have its own tab and independent conversation.
- **FR-008**: Closing a side chat tab MUST remove only that inspector tab. It MUST NOT delete or archive the Chat.
- **FR-009**: Side chat tabs MUST stay associated with their main Chat, restore after the inspector is hidden, and remain reopenable after an application reload. They MUST never cross account or runtime boundaries.
- **FR-010**: Side Chats MUST follow the existing Chat authorization, persistence, loading, empty, error, and run-state behavior.
- **FR-011**: Keyboard users MUST be able to reach the add-tab action, side chat tabs, close controls, transcript, and composer; focus MUST move predictably when a tab opens, closes, or is selected.
- **FR-012**: This inspector affordance MUST be available only in Electron Desktop for this feature. Web Canvas, Web Desktop, Web Mobile, and Native Mobile are outside this feature's scope because the requested interaction is specific to Electron Desktop's right inspector tab strip.

### Key Entities *(include if feature involves data)*

- **Main Chat**: The conversation occupying the primary Chats pane; provides the side chat's project association and the inspector scope.
- **Side Chat**: A normal persisted Chat with its own messages and run state, opened in an inspector tab and associated with a main Chat for navigation.
- **Inspector tab**: A Files, Terminal, or side chat view entry with a selected state. Closing a tab affects presentation, not Chat history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open a side chat from an existing main Chat in at most three actions without leaving the main Chat.
- **SC-002**: In all acceptance tests, sending in one Chat changes only that Chat's transcript and draft; both Chats remain independently usable while a response is in progress.
- **SC-003**: In all acceptance tests, Files and Terminal tabs remain usable before and after creating, switching, and closing side chat tabs.
- **SC-004**: In all reload and account-switch tests, users can recover their own side Chats and see no tabs or messages from another account or runtime.
- **SC-005**: In keyboard-only acceptance tests, a user can create, use, switch, and close a side chat tab without a pointer.

## Scope and Assumptions

- **Platform limitation**: This feature is scoped to Electron Desktop's Chats inspector at the user's request. The other OS views do not receive a new side chat surface in this feature.
- **Context**: “Side chat” means a separate Chat shown next to the main Chat. It shares an applicable project association, but it does not inherit the main transcript or create a fork from a selected message.
- **History**: Side Chats use the normal Chat history and deletion behavior. Closing their inspector tabs does not remove conversation data.
- **Files control**: The existing Files tab remains singular; choosing Files from the add-tab menu simply selects it. This feature does not add a separate open-file tab system.
- **Delivery**: The implementation plan must include behavior tests and rendered Electron Desktop verification, plus a separate public documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`.
