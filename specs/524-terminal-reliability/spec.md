# Feature Specification: Terminal Reliability

**Feature Branch**: `codex/524-terminal-reliability`  
**Created**: 2026-09-17  
**Status**: Draft for review; complete Terminal reliability scope confirmed by the user  
**Input**: Investigate reported Terminal startup reconnecting and flicker, preserve existing features, and define Terminal reliability and a staged implementation plan using Speckit.

## User Scenarios & Testing

### User Story 1 — Open and use a new terminal (Priority: P1)

An owner opens a terminal, sees a usable prompt, and types without an avoidable reconnect or repeated clearing of the screen.

**Independent Test**: Create 20 fresh terminals sequentially on a healthy test computer, type a unique command in each, and verify each result once.

**Acceptance Scenarios**:
1. Given a healthy computer and network, when a terminal performs startup capability negotiation, then it remains connected and preserves subsequent user input in order.
2. Given startup is still in progress, when a user types, then input is delivered once after authorization and readiness, or a clear failure is shown; it is never silently replayed into a different session.
3. Given the window is closed during startup, when initialization completes later, then no abandoned viewer or pending input remains active.

### User Story 2 — Return to work after an interruption (Priority: P1)

A user switches tabs, hides a window, changes presentation, or briefly loses connectivity without losing an existing session or being misled about its state.

**Independent Test**: Run a counter, switch away and back, interrupt the network, reconnect, and confirm the same session and continuous counter progress.

**Acceptance Scenarios**:
1. Given a running command, when its view is hidden or detached, then the command continues and reattachment shows current output.
2. Given a recoverable transport interruption, when the first automatic retry succeeds, then no persistent reconnect warning remains.
3. Given retries fail, when the connection cannot recover, then the view shows an actionable connection state and does not appear ready for input.
4. Given a session has exited or was explicitly deleted, when an old view is restored, then it is not silently recreated or represented as running.
5. Given deletion is still pending, the row explicitly shows `Deleting…` until the server confirms success. Older list responses cannot restore it afterward; failure keeps the session available with an error.

### User Story 3 — Use the same terminal from multiple devices (Priority: P1)

The user can observe a terminal from another device and deliberately take control without simultaneous competing input or unexpected resizing.

**Independent Test**: Attach two clients, attempt input from the observer, take control, and verify the previous writer can no longer mutate the terminal.

**Acceptance Scenarios**:
1. Given one device controls a terminal, when another device observes it, then only the controller can send input and establish canonical dimensions.
2. Given the user chooses to continue on the second device, when ownership changes, then the previous device becomes read-only and pending work respects the current authority.
3. Given a different account or an unauthorized project member attempts access, then terminal content and input remain inaccessible.

### User Story 4 — Read output and retain everyday terminal features (Priority: P1)

The user sees the prompt and final output lines, can scroll deliberately, paste text, use keyboard shortcuts and terminal applications, and resize the window predictably.

**Independent Test**: Produce numbered output, scroll to both ends, resize, switch clients with different dimensions, and test ordinary shell input plus a full-screen terminal application.

**Acceptance Scenarios**:
1. Given output exceeds the viewport, when the user scrolls to the end, then the final line and prompt are visible.
2. Given content changes or the cursor moves, then the viewport does not unexpectedly pan horizontally.
3. Given a narrow observing device cannot preserve both readable text and the controller's width, then explicit horizontal panning may remain available; this does not grant resize authority.
4. Given valid text, Unicode, binary input, paste, or shortcuts, then ordering and existing meanings are preserved.
5. Given history and clipped live rows, then one viewport-edge vertical scrollbar reaches both ends; no floating inner scrollbar competes with it. Trackpad input reaches the same content without requiring a scrollbar drag, including gestures over the blank area beside short text.
6. Given a short normal-shell prompt, unused canonical rows/columns do not create scrollable blank margins. Real long lines, cursor cells, painted backgrounds and alternate-screen applications remain accessible.
7. Given a deliberate scroll position, native redraws do not pull it back to a cursor outside the viewport. History navigation alone does not change the scrollbar range.

8. Given a terminal has unused viewport space, clicking that space focuses its input; text selection and context clicks keep their existing behavior.

### Edge Cases

Startup output bursts; slow authorization; disconnect during attach; ownership revocation with queued input; idle connections; gateway/runtime restart; stale saved references; rapid tab changes; narrow windows; large pastes; full-screen applications; malformed messages; excessive input; deleted project access; unavailable runtime; provider-auth temporary terminals.

## Requirements

### Functional Requirements

- **FR-001**: Legitimate startup replies MUST NOT cause a healthy terminal to disconnect.
- **FR-002**: Input MUST retain its byte meaning and ordering across startup and ordinary operation; it MUST NOT be duplicated or sent to another terminal.
- **FR-003**: Input and resize MUST respect current account, project, attachment, and controller authority.
- **FR-004**: Backgrounding, presentation changes, or ordinary window close MUST NOT implicitly terminate durable sessions.
- **FR-005**: Explicit deletion and process exit MUST remain authoritative; restoring a view MUST NOT create a replacement process.
- **FR-006**: Reconnect state MUST reflect connection progress and eventual failure without recurring warnings during successful startup.
- **FR-007**: Reattachment MUST reconcile dimensions and current output so the final line remains reachable.
- **FR-008**: Content updates MUST NOT move the viewport horizontally without user action.
- **FR-009**: Startup/disconnect failures MUST release viewer resources and discard work that can no longer be authorized.
- **FR-010**: Resource use MUST remain bounded, and invalid or excessive input MUST fail without affecting other sessions.
- **FR-011**: Existing text/binary input, paste, shortcuts, themes, links, provider setup terminals, and full-screen applications MUST retain their supported behavior.
- **FR-012**: Web Desktop, Web Canvas, and Electron Desktop MUST share the same terminal state semantics. Web Mobile and Native Mobile MUST retain equivalent semantics wherever the capability already exists.
- **FR-013**: Diagnostics MUST allow connection events to be correlated without retaining terminal content, credentials, or private owner paths.

### Key Entities

Terminal identity; runtime incarnation; viewer attachment; controller lease; canonical dimensions; output position; presentation state. A saved view is a reference to a terminal, not authority to create a process.

## Success Criteria

- **SC-001**: Twenty consecutive fresh-terminal trials per desktop presentation show zero avoidable reconnects, no repeated screen reset after readiness, and exactly one expected command result each on a healthy test computer.
- **SC-002**: Twenty switch/reattach cycles preserve session identity, current output, and command continuity.
- **SC-003**: Ten controlled network interruption/recovery trials either return to the same session or show the expected actionable failure, with no duplicate input.
- **SC-004**: All tested controller/observer/account/project cases admit only authorized operations, including queued input after authority changes.
- **SC-005**: Numbered-output and resize trials expose the final line and prompt; output alone never causes horizontal panning.
- **SC-006**: The documented regression matrix passes on the exact release under review, with every untested platform or failing baseline case explicitly identified. Human review is required before landing user-visible changes.

## Assumptions and Scope

This is a reliability audit and staged repair plan, not a terminal redesign or a claim that all reported defects share one cause. Existing intentional readable-width panning and single-controller semantics are retained unless separately approved. PR #1736 addresses reproduced startup-input overflow, snapshot row alignment, and the explicitly approved scrolling follow-up; other acceptance criteria remain open until measured. Performance trials use a healthy disposable VPS and documented network conditions; no universal latency guarantee is inferred from those trials. Production users' commands and data are not altered for testing.
