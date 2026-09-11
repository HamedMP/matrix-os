# Feature Specification: Reliable Terminal Clipboard and Selection

**Feature Branch**: `118-fix-terminal-clipboard`
**Created**: 2026-08-29
**Status**: Draft
**Input**: User description: "Make terminal copy, paste, right-click Copy, and Select All work reliably on macOS. Command+C, Command+V, and Command+Shift+C must work; multi-word and multi-row selections must copy exactly; right-click must not replace a larger selection with one word; and selections must not disappear when the mouse moves, including while Codex or another mouse-aware terminal application is running."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Copy and Paste with Mac Shortcuts (Priority: P1)

As a macOS user working in a Matrix terminal, I can copy the exact text I selected and paste clipboard text using familiar Command-key shortcuts, without losing terminal focus or triggering an unrelated shell action.

**Why this priority**: Copy and paste are foundational terminal operations. When the primary platform shortcuts do nothing, users cannot reliably move commands, errors, code, or agent output between Matrix and other applications.

**Independent Test**: Open a terminal on macOS, select known text, copy it with each supported copy shortcut, paste it into an external plain-text field, then paste known external text back into the focused terminal. The copied and pasted values must match exactly and each action must occur once.

**Acceptance Scenarios**:

1. **Given** a focused terminal with a non-empty text selection, **When** the user presses Command+C, **Then** the clipboard contains the entire selected text exactly once.
2. **Given** a focused terminal with a non-empty text selection, **When** the user presses Command+Shift+C, **Then** the clipboard contains the entire selected text exactly once.
3. **Given** a focused terminal and a clipboard containing plain text, **When** the user presses Command+V, **Then** the clipboard text is inserted into that terminal exactly once without being submitted automatically.
4. **Given** more than one terminal pane is open, **When** the user copies or pastes using a terminal shortcut, **Then** the action applies only to the focused terminal pane.
5. **Given** focus is outside a terminal, **When** the user presses a terminal clipboard shortcut, **Then** existing non-terminal shortcut behavior is preserved.

---

### User Story 2 - Preserve the Intended Selection on Right-Click (Priority: P1)

As a user who selected several words, wrapped text, or multiple terminal rows, I can right-click the selected region and choose Copy without the selection being replaced by the single word beneath the pointer.

**Why this priority**: The current behavior silently copies different content from what the highlight communicates. Silent clipboard corruption is more damaging than an explicit failure because users may paste incomplete commands or misleading diagnostic output without noticing.

**Independent Test**: Select a known multi-word and multi-row passage, right-click at multiple positions inside the highlighted region, choose Copy, and compare the clipboard with the visibly selected passage.

**Acceptance Scenarios**:

1. **Given** a multi-word terminal selection, **When** the user right-clicks anywhere inside the highlighted region, **Then** the existing selection remains unchanged and Copy is available.
2. **Given** a multi-row terminal selection, **When** the user chooses Copy from the right-click menu, **Then** the clipboard contains the complete selection rather than only the word under the pointer.
3. **Given** a selection that includes wrapped lines, whitespace, punctuation, or Unicode characters, **When** it is copied from the right-click menu, **Then** the clipboard preserves the selection's textual content and line boundaries.
4. **Given** a valid terminal selection, **When** the context menu opens, **Then** Copy is enabled and remains associated with that selection until the user completes or dismisses the menu action.

---

### User Story 3 - Keep Selection Stable in Mouse-Aware Terminal Apps (Priority: P1)

As a user running Codex or another mouse-aware terminal application, I can select output and move the pointer toward a shortcut or context menu without passive mouse movement clearing or changing my selection.

**Why this priority**: Coding-agent sessions are a primary Matrix workflow. A selection that disappears while the user moves toward Copy is functionally impossible to use.

**Independent Test**: Run a mouse-aware full-screen terminal application, create a multi-row selection, move the pointer across and outside the selected area without clicking or typing, wait ten seconds, and verify that the same range remains selected and copyable.

**Acceptance Scenarios**:

1. **Given** a selection in a mouse-aware terminal application, **When** the user moves the pointer without pressing a button, **Then** the selection remains unchanged and copyable.
2. **Given** a selection in a mouse-aware terminal application, **When** the application continues ordinary background rendering, **Then** the selection remains stable unless the selected content is no longer available.
3. **Given** a retained selection, **When** the user deliberately types, pastes, starts a new selection, or changes terminal buffers, **Then** the terminal may clear the selection according to normal terminal behavior.
4. **Given** terminal mouse interactions are active, **When** the user is not selecting text, **Then** existing application mouse behavior continues to work.

---

### User Story 4 - Select All Remains Usable (Priority: P2)

As a user, I can select all available terminal text and then copy it without the selection disappearing merely because I move the mouse.

**Why this priority**: Select All is the recovery path when manual drag selection is difficult or the output is long. It must remain stable long enough for the user to copy it.

**Independent Test**: Populate terminal output and scrollback, invoke Select All, move the pointer for ten seconds without clicking or typing, then copy and verify that all available text was captured.

**Acceptance Scenarios**:

1. **Given** a terminal with visible output and scrollback, **When** the user invokes Select All while the terminal is focused, **Then** all available terminal text becomes selected.
2. **Given** Select All is active, **When** the user only moves the pointer, **Then** the full selection remains active.
3. **Given** Select All is active, **When** the user copies through a keyboard shortcut or the right-click menu, **Then** both paths copy the same complete text.
4. **Given** the terminal has no copyable text, **When** the user invokes Select All, **Then** the terminal remains stable and no misleading Copy availability is shown.

---

### User Story 5 - Consistent Behavior Across Shell Layouts (Priority: P2)

As a Matrix user, I receive the same reliable terminal selection and clipboard behavior in the primary Canvas experience and the compatibility Desktop experience, including at every supported Canvas zoom level.

**Why this priority**: Users should not need to change shell modes or reset zoom to make a foundational editing operation work.

**Independent Test**: Repeat the keyboard, right-click, drag-selection, and Select All journeys in Canvas and Desktop. In Canvas, repeat at minimum, default, fitted, and maximum supported zoom levels.

**Acceptance Scenarios**:

1. **Given** a terminal in Canvas at any supported zoom level, **When** the user selects and copies text, **Then** pointer location and copied boundaries match the visible selection.
2. **Given** the same terminal content in Canvas and Desktop, **When** the same clipboard journey is performed, **Then** both modes produce the same clipboard text.
3. **Given** the user changes Canvas zoom after making a selection, **When** the selected content remains visible and available, **Then** subsequent right-click and copy actions still target the intended selection.
4. **Given** a terminal window is focused, unfocused, and focused again, **When** the selection is still visibly present, **Then** the next copy action uses that visible selection.

---

### User Story 6 - Recover Safely from Clipboard Failure (Priority: P3)

As a user whose clipboard access is unavailable or denied, I receive clear feedback and keep my selection so I can retry or use another method.

**Why this priority**: Clipboard restrictions vary by environment. A failed operation must not destroy the user's work or appear to succeed.

**Independent Test**: Deny clipboard access, attempt copy and paste, and verify that the user receives safe feedback, the selected text remains selected, and no content is duplicated or submitted.

**Acceptance Scenarios**:

1. **Given** clipboard writing is unavailable, **When** the user attempts to copy, **Then** the terminal reports that Copy failed and preserves the selection.
2. **Given** clipboard reading is unavailable, **When** the user attempts to paste, **Then** the terminal reports that Paste failed and inserts nothing.
3. **Given** a copy or paste failure, **When** the user retries after clipboard access becomes available, **Then** the operation succeeds exactly once.
4. **Given** any clipboard failure, **When** feedback is shown, **Then** it contains no terminal content, filesystem paths, provider details, or raw internal errors.

### Edge Cases

- Copy is invoked with no terminal selection.
- The selected range is a single character, a single word, a complete row, multiple rows, or the entire available buffer.
- The selected range begins or ends on a wrapped line or contains blank lines, tabs, trailing spaces, punctuation, emoji, combining characters, or wide characters.
- The terminal is displaying rapidly updating output while the user selects and copies older output.
- A full-screen terminal application enables hover, drag, or click reporting while the user is selecting text.
- The user right-clicks inside the selection, on its first or last character, or immediately next to its visible boundary.
- The user opens and dismisses the context menu without choosing an action.
- Canvas zoom changes before selection, during selection, or after selection but before Copy.
- The pointer leaves the terminal or browser window during a drag and returns before or after release.
- Multiple terminal panes, tabs, or windows are open and their selections differ.
- The clipboard is empty, unavailable, denied, or contains a large multiline value.
- Copy or paste shortcuts are pressed repeatedly or held down.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The terminal MUST treat Command+C as Copy on macOS when the focused terminal has a non-empty selection.
- **FR-002**: The terminal MUST treat Command+Shift+C as an alternate Copy shortcut on macOS when the focused terminal has a non-empty selection.
- **FR-003**: The terminal MUST treat Command+V as Paste on macOS and insert clipboard content exactly once into the focused terminal without automatic submission.
- **FR-004**: Existing supported copy and paste shortcuts on non-macOS platforms MUST continue to work.
- **FR-005**: A clipboard shortcut handled by the focused terminal MUST take precedence over conflicting shell-level actions for that interaction only.
- **FR-006**: Copy MUST use the terminal's complete active selection as the authoritative content, including multi-word, multi-row, wrapped, and Select All ranges.
- **FR-007**: Opening a context menu within an existing selection MUST preserve that selection and MUST NOT replace it with the word under the pointer.
- **FR-008**: The context-menu Copy action MUST be enabled whenever the focused terminal has a non-empty copyable selection.
- **FR-009**: Passive pointer movement MUST NOT clear, shorten, expand, or otherwise change a completed terminal selection.
- **FR-010**: Terminal applications that receive mouse interactions MUST retain their normal mouse behavior whenever no terminal text selection is active.
- **FR-011**: Select All MUST select all text currently available to the user in the focused terminal, including retained scrollback.
- **FR-012**: Keyboard Copy and context-menu Copy MUST produce identical content for the same selection.
- **FR-013**: Selection and clipboard behavior MUST be consistent in Canvas and Desktop modes.
- **FR-014**: Selection boundaries and context-menu targeting MUST remain accurate at every supported Canvas zoom level.
- **FR-015**: Clipboard actions MUST affect only the focused terminal pane and MUST NOT read from or write to another pane's selection.
- **FR-016**: A failed Copy MUST preserve the active selection and present clear, safe feedback rather than silently reporting success.
- **FR-017**: A failed Paste MUST insert no partial or duplicate content and present clear, safe feedback.
- **FR-018**: Clipboard contents MUST remain local to the user-requested copy or paste operation and MUST NOT be included in telemetry, diagnostics, or error feedback.
- **FR-019**: The feature MUST preserve established non-terminal selection and clipboard behavior when terminal focus is absent.
- **FR-020**: Automated coverage MUST exercise macOS Command shortcuts, mouse-aware applications, right-click preservation, Select All stability, multiple panes, Canvas zoom boundaries, Desktop parity, and clipboard failure paths before implementation is considered complete.

### Scope

**In scope**:

- Terminal text selection and clipboard actions initiated from keyboard shortcuts, the terminal context menu, and Select All.
- macOS behavior as the primary reported platform, with regression protection for existing Windows and Linux shortcuts.
- Matrix Canvas and Desktop renderers, including supported Canvas zoom levels.
- Plain shells and interactive mouse-aware terminal applications such as coding agents.

**Out of scope**:

- General clipboard behavior inside arbitrary sandboxed apps or non-terminal shell surfaces.
- Rich-text, image, or file clipboard formats beyond preserving existing behavior.
- Changing terminal scrollback retention limits or the content produced by terminal applications.
- Adding clipboard history, synchronization, or persistence.

### Assumptions and Dependencies

- Command+C is the primary macOS Copy shortcut; Command+Shift+C is supported as an explicit alternate because users reasonably try the terminal-style shifted shortcut on macOS.
- Copy operates on textual terminal content, not visual styling, colors, or cursor state.
- Passive pointer movement is not a deliberate request to discard a selection, even when the running terminal application accepts mouse input.
- Typing, pasting, beginning a new selection, switching terminal buffers, or losing the selected content from retention may deliberately invalidate a selection.
- The operating environment may deny clipboard access; the terminal must handle that state without requiring additional permissions or sending clipboard data elsewhere.
- Delivery includes a separate documentation pull request to the private Matrix OS documentation repository describing supported terminal clipboard shortcuts and selection behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of acceptance tests, Command+C and Command+Shift+C copy the exact selected terminal text on macOS, and Command+V inserts the clipboard value exactly once.
- **SC-002**: In 50 consecutive right-click Copy trials spanning single-line, multi-line, wrapped, Unicode, and Select All selections, zero trials replace the intended selection with only the word beneath the pointer.
- **SC-003**: A completed selection remains unchanged through at least 10 seconds of passive pointer movement in both a plain shell and a mouse-aware coding-agent session.
- **SC-004**: Copy and paste journeys pass at 100% of supported Canvas zoom levels included in the product test matrix and in Desktop mode.
- **SC-005**: Keyboard Copy and context-menu Copy produce identical text for the same selection in 100% of test cases.
- **SC-006**: Clipboard success or failure feedback appears within one second of the user's action, and failures preserve the selection with zero partial or duplicate paste events.
- **SC-007**: At least 95% of representative users can select multiple terminal rows and copy the intended text successfully on their first attempt without changing zoom or shell mode.
