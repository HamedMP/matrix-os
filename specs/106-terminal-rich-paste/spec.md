# Feature Specification: Attached Terminal Rich Paste

**Feature Branch**: `106-terminal-rich-paste`  
**Created**: 2026-07-08  
**Status**: Draft  
**Input**: User description: "While attached with Matrix shell, pasted local screenshot paths and image-only clipboard pastes should become owner-scoped remote image references before the prompt reaches the attached terminal session."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Paste Screenshot Path Inside Prompt (Priority: P1)

As a Matrix CLI user attached to a remote terminal session, I want to paste a local screenshot path together with normal prompt text so the remote AI can inspect the image without me manually uploading or moving the file.

**Why this priority**: This is the common failure case today. Users paste a screenshot path from macOS and expect the attached session to receive the actual image context, not an unusable local-only path.

**Independent Test**: Can be fully tested by attaching to a session, pasting a prompt that contains a quoted local screenshot path with spaces plus extra text, and verifying the remote session receives a rewritten prompt that references an owner-scoped remote image path while preserving the user's text.

**Acceptance Scenarios**:

1. **Given** an active attached terminal session and a readable local screenshot file, **When** the user pastes `"local screenshot path.png" what about this?`, **Then** the remote session receives an image-inspection prompt containing a remote Matrix path and the text `what about this?`.
2. **Given** an active attached terminal session and a paste containing two readable local image paths with surrounding prose, **When** the paste is submitted, **Then** both image paths are copied to remote Matrix-owned paths and the rest of the prompt remains in the same order.
3. **Given** an active attached terminal session and a paste containing a non-image local path, **When** the paste is submitted, **Then** the non-image path is not uploaded as an image asset.

---

### User Story 2 - Paste Image Clipboard Without Path Text (Priority: P2)

As a Matrix CLI user with an image copied to the macOS clipboard, I want pressing paste during an attached session to insert a usable remote image reference even when the terminal does not provide a file path in the pasted text.

**Why this priority**: This makes image paste feel natural when the clipboard contains only image bytes. It completes the user expectation that paste means "send this image to the conversation."

**Independent Test**: Can be tested by copying an image to the clipboard, attaching to a session, pasting with no text path available, and verifying a remote image reference is inserted into the outgoing prompt when the paste action is observable.

**Acceptance Scenarios**:

1. **Given** an active attached terminal session and an observable paste action with an image-only clipboard, **When** the user pastes, **Then** the image is copied to a remote Matrix-owned path and the outgoing prompt includes a concise request to inspect that image.
2. **Given** an active attached terminal session where the terminal provides no paste signal and no input bytes for an image-only clipboard, **When** the user presses paste, **Then** the system does not hang, does not insert stale data, and does not claim that an image was sent.

---

### User Story 3 - Fail Safely Without Leaking Local Paths (Priority: P3)

As a privacy-conscious user, I want failed image paste attempts to be handled locally and clearly so that local filesystem paths or clipboard data are not exposed to the remote session by accident.

**Why this priority**: Rich paste touches local files and clipboard content. Failures must preserve trust even when the happy path cannot complete.

**Independent Test**: Can be tested by pasting an unreadable image path, an oversized image, and a disconnected session, then verifying the user sees local feedback and the remote session does not receive local-only image paths.

**Acceptance Scenarios**:

1. **Given** an active attached terminal session and a pasted local image path that cannot be read, **When** the paste is submitted, **Then** the user receives a local failure message and the detected local image path is not forwarded to the remote session.
2. **Given** an active attached terminal session and an image that exceeds the accepted size, **When** the user pastes it, **Then** the user receives a local size-limit message and no partial image reference is inserted.
3. **Given** a remote upload failure during a rich paste transaction, **When** the paste cannot be completed, **Then** the user receives local feedback and can retry without losing the original prompt text.

### Edge Cases

- Pasted paths may be quoted or unquoted, contain spaces, include punctuation near the path, or appear in the middle of a larger prompt.
- A single paste transaction may contain multiple image references, repeated references, ordinary text, and non-image paths.
- Image file names may contain sensitive local details; the remote asset path must not depend on exposing the original local path.
- The clipboard may contain both text and an image; text path rewriting takes precedence, and a clipboard image is used only when doing so will not duplicate a path already handled in the same paste.
- The user may paste while the session is disconnected, reconnecting, or unable to accept uploads.
- The local file may disappear between paste detection and upload.
- The terminal may not provide an observable paste boundary for image-only clipboard content.
- Failed sends must not leave orphaned partial prompt text in the remote session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST treat paste input during an active attached terminal session as a single paste transaction before forwarding it to the remote session.
- **FR-002**: The system MUST detect readable local image file references embedded anywhere in pasted text, including quoted paths with spaces and text before or after the path.
- **FR-003**: The system MUST copy each detected local image to an owner-scoped remote Matrix location before the rewritten prompt reaches the remote session.
- **FR-004**: The system MUST replace each uploaded local image reference with the corresponding remote Matrix path in the outgoing prompt.
- **FR-005**: The system MUST preserve user-authored text, line breaks, and ordering around rewritten image references unless minimal wording is needed to make image inspection explicit.
- **FR-006**: The system MUST support multiple detected image references in one paste transaction and avoid duplicate uploads for the same local image within that transaction.
- **FR-007**: The system MUST support image-only clipboard paste when the paste action is observable and an image can be read from the local operating system clipboard.
- **FR-008**: The system MUST avoid using stale clipboard images when the current paste transaction already contains text that does not indicate an image paste.
- **FR-009**: The system MUST reject unsupported, unreadable, missing, or oversized image assets with local feedback.
- **FR-010**: The system MUST NOT forward detected local-only image paths to the remote session when copying or rewriting fails.
- **FR-011**: The system MUST keep image paste assets scoped to the owning user's Matrix environment and unavailable to other users by default.
- **FR-012**: The system MUST avoid exposing original local filesystem paths, raw provider errors, or internal upload details in remote prompts or user-facing failure messages.
- **FR-013**: The system MUST complete successful rich paste transactions without requiring an additional manual upload command.
- **FR-014**: The system MUST leave ordinary non-image paste behavior unchanged.
- **FR-015**: The system MUST present retryable local feedback when a rich paste transaction fails after user input is captured.

### Key Entities

- **Paste Transaction**: One user paste action observed during an attached terminal session. Includes pasted text, optional clipboard image availability, detected image references, and the final rewritten prompt.
- **Local Image Reference**: A readable image file path or clipboard image available on the user's local machine during the paste transaction.
- **Remote Paste Asset**: An owner-scoped copy of the pasted image inside the user's Matrix environment, represented to the remote session by a remote path.
- **Rewrite Result**: The outcome of processing a paste transaction, including uploaded assets, replacement text, failure state, and safe local feedback if needed.

### Scope Boundaries

- This feature covers attached Matrix CLI terminal sessions.
- This feature does not add rich image paste to browser shell surfaces, mobile shells, or unrelated channel adapters.
- This feature does not upload arbitrary non-image files.
- This feature does not continuously monitor the clipboard outside a user-initiated paste transaction.
- This feature does not guarantee image-only paste support in terminals that provide no observable paste event or input.

### Assumptions

- Users expect pasted screenshots to become usable by the remote AI without learning a separate upload command.
- Remote paste assets are temporary working-session assets owned by the user and should follow the product's existing owner-data retention and cleanup policies.
- A clear local error is preferable to silently sending a prompt that contains unusable local image paths.
- macOS screenshot paths with spaces are the primary path-paste case, but the behavior should not be limited to one screenshot naming pattern.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 95% of valid pasted local image paths embedded in prompts are converted to remote Matrix references within 3 seconds for images up to the accepted size limit.
- **SC-002**: In validation tests, 100% of successfully handled image paste transactions reach the remote session without local-only image file paths.
- **SC-003**: Users can paste a screenshot path plus a natural language question into an attached session and receive a usable remote prompt in one paste action.
- **SC-004**: A single paste transaction can handle at least 5 image references while preserving surrounding user-authored text.
- **SC-005**: For unreadable, missing, unsupported, oversized, or failed-upload images, users receive local feedback within 2 seconds and no detected local image path is forwarded to the remote session.
- **SC-006**: At least 90% of user validation attempts for "paste screenshot and ask about it" succeed without requiring a separate manual upload step.
