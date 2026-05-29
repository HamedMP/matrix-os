# Feature Specification: Mobile Shell

**Feature Branch**: `075-mobile-shell`
**Created**: 2026-05-12
**Status**: Draft
**Input**: User description: "Users will not have SSH keys to their Matrix VPS. Make Matrix shell easy on mobile: a phone-first shell that shows an app launcher instead of the canvas, opens selected apps full-screen like iOS, keeps Canvas working where appropriate, and provides a first-party mobile terminal experience comparable to Termius inside Matrix."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Launch Apps From Mobile Home (Priority: P1)

As a Matrix user on a phone, I want Matrix to open to a familiar app launcher so I can choose an app without navigating a desktop canvas.

**Why this priority**: This is the primary mobile entry point. If users land on a spatial desktop that is hard to pan, zoom, or inspect on a phone, every mobile workflow starts with friction.

**Independent Test**: Can be tested by signing in on a phone-sized viewport, verifying the launcher is the first usable shell surface, selecting any app, and confirming it opens as the active full-screen experience.

**Acceptance Scenarios**:

1. **Given** an authenticated user opens Matrix on a phone-sized screen with no active app selected, **When** the shell loads, **Then** the user sees a launcher with available system and user apps.
2. **Given** the launcher is visible, **When** the user selects an app, **Then** the launcher closes and the selected app fills the usable screen.
3. **Given** an app is open full-screen, **When** the user returns home, **Then** the launcher appears without losing the app's recoverable state.

---

### User Story 2 - Use Terminal Without SSH Keys (Priority: P1)

As a Matrix user on a phone, I want to open a terminal through Matrix using my normal Matrix session so I can run commands on my VPS without managing SSH keys.

**Why this priority**: The mobile terminal is the power-user path and the alternative to third-party SSH apps. It must be useful without exposing SSH as a user-facing requirement.

**Independent Test**: Can be tested by signing in on a phone-sized viewport, opening Terminal from the launcher, running a command, backgrounding or reloading the page, and confirming the session can be reattached.

**Acceptance Scenarios**:

1. **Given** an authenticated user opens Terminal from the mobile launcher, **When** the terminal starts, **Then** the user can type commands into a persistent shell session without providing an SSH key.
2. **Given** a terminal command is still running, **When** the mobile browser disconnects, sleeps, or reloads, **Then** reopening Terminal offers to resume the running session instead of silently killing it.
3. **Given** the user needs non-letter terminal input, **When** they use the terminal controls, **Then** they can send common keys such as Escape, Control combinations, Tab, arrows, and paste.

---

### User Story 3 - Resume Recent Mobile Work (Priority: P2)

As a Matrix user who switches apps often on mobile, I want Matrix to remember my last active app and terminal sessions so I can return to work quickly.

**Why this priority**: Mobile sessions are frequently interrupted by app switching, browser tab eviction, network changes, and screen lock.

**Independent Test**: Can be tested by opening an app and a terminal session, leaving Matrix, returning later, and confirming Matrix presents the most relevant resume choices.

**Acceptance Scenarios**:

1. **Given** the user had an app open, **When** they return to Matrix on the same phone, **Then** Matrix restores or offers the last active app before making the user search the launcher again.
2. **Given** the user has multiple terminal sessions, **When** they open Terminal, **Then** they can choose an existing session or create a new one.
3. **Given** a restored app is no longer available, **When** Matrix attempts to resume it, **Then** the user sees a safe fallback that returns them to the launcher.

---

### User Story 4 - Access Canvas When It Helps (Priority: P3)

As a Matrix user, I want Canvas to remain available on mobile when I explicitly choose it, while the default phone experience stays launcher-and-app focused.

**Why this priority**: Canvas is a core Matrix shell, but it is not the best default for small screens. Keeping it accessible preserves power-user workflows without making every mobile user manage spatial navigation.

**Independent Test**: Can be tested by switching from the mobile launcher into Canvas on a phone-sized viewport and confirming the user can return to the launcher.

**Acceptance Scenarios**:

1. **Given** the user is on the mobile launcher, **When** they explicitly open Canvas, **Then** Canvas appears as a selectable shell surface rather than the default mobile home.
2. **Given** Canvas is open on mobile, **When** the user chooses to return home, **Then** Matrix returns to the launcher without losing open app records.

### Edge Cases

- Phone viewport rotates while an app or terminal is open; the active surface must resize without forcing a reload or losing typed-but-unsent terminal input.
- Browser address bar, safe areas, and virtual keyboard reduce usable height; the active app and terminal controls must remain reachable.
- Network disconnects during terminal use; the user must see reconnect or resume state without duplicate command submission.
- A terminal session exits while the phone is asleep; returning to Terminal must show the exited state and offer a new session path.
- The user opens a desktop-sized viewport on a tablet or foldable device; Matrix may use Canvas by default when there is enough room, but phone-sized layouts must remain launcher-first.
- An app cannot be loaded, is missing, or requires a refreshed session; the shell must show a generic recovery path and return to the launcher.
- Multiple browser tabs open Matrix on the same phone; session state must avoid confusing duplicate active-app or terminal ownership messages.
- The same user opens Matrix through the browser shell and the native mobile app; both surfaces must use the same owner-scoped app and terminal inventory without corrupting each other's resume state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST provide a phone-first shell surface that uses a launcher as the default home on phone-sized screens.
- **FR-002**: The launcher MUST show system apps and user-created apps in a tappable, scan-friendly layout with clear app identity and open-state indication.
- **FR-003**: Selecting an app from the mobile launcher MUST open that app as a single active full-screen surface.
- **FR-004**: The mobile shell MUST provide a home/back path from any full-screen app back to the launcher.
- **FR-005**: The mobile shell MUST preserve recoverable app state when switching between launcher and full-screen app surfaces.
- **FR-006**: Terminal MUST be available from the mobile launcher as a first-party Matrix app.
- **FR-007**: Mobile Terminal MUST allow authenticated users to create, list, resume, detach from, and intentionally end terminal sessions without requiring SSH keys.
- **FR-008**: Mobile Terminal MUST keep server-side terminal sessions running across mobile browser reloads, sleep, short network interruptions, and app switching unless the user explicitly ends the session.
- **FR-009**: Mobile Terminal MUST provide phone-friendly controls for Escape, Tab, arrow keys, Control-key combinations, paste, session switching, and font sizing.
- **FR-010**: Mobile Terminal MUST show clear connection, reconnecting, resumed, exited, and failed-to-attach states using user-safe messages.
- **FR-011**: The mobile shell MUST avoid using Canvas as the default phone home while still allowing users to explicitly open Canvas.
- **FR-012**: Canvas on mobile MUST provide a reliable return path to the launcher and must not trap users in a zoomed or panned state.
- **FR-013**: The mobile shell MUST adapt to portrait, landscape, safe-area insets, browser chrome changes, and virtual keyboard visibility without hiding primary controls.
- **FR-014**: The mobile shell MUST remember the user's last active mobile app and recent terminal sessions for resume.
- **FR-015**: The mobile shell MUST prevent unauthenticated access to apps, terminal sessions, and shell state.
- **FR-016**: Terminal access MUST be scoped to the authenticated owner's Matrix VPS environment and must not expose SSH credentials, private keys, provider tokens, internal paths, or raw upstream errors to the user.
- **FR-017**: Realtime terminal communication MUST validate message shape, size, session ownership, and allowed actions before input reaches a session.
- **FR-018**: Terminal and shell session collections MUST have clear limits, stale-session handling, and explicit cleanup behavior for ended sessions.
- **FR-019**: Mobile shell errors MUST provide safe recovery actions, such as retry, resume, new session, return home, or reopen app.
- **FR-020**: Mobile shell behavior MUST be testable independently from desktop Canvas behavior so regressions in one shell do not mask regressions in the other.
- **FR-021**: The phone-first shell behavior MUST apply to phone-sized browser shell sessions and to the native mobile app runtime where that runtime is available.
- **FR-022**: App runtime launch from mobile MUST use short-lived, owner-scoped session bootstrap tokens or equivalent authenticated session handoff, without exposing reusable credentials to embedded apps.
- **FR-023**: Terminal resume MUST distinguish server terminal process state from mobile attachment state so a browser/app disconnect detaches the client without implying that the shell process exited.

### Key Entities

- **Mobile Shell State**: The user's phone-oriented shell preferences, active surface, last active app, and launcher/home state.
- **Mobile App Surface**: A full-screen instance of a system or user app opened from the mobile launcher, including its title, identity, loading state, and recoverable open state.
- **Terminal Session**: A user-owned shell process record that may be running or exited and can be intentionally destroyed by the owner.
- **Terminal Attachment State**: The current mobile client's relationship to a terminal session, including attached, detached, reconnecting, failed-to-attach, and intentionally ended states.
- **Terminal Control Bar**: The mobile-only control set for special keys, paste, session switching, and display adjustments.
- **Canvas Access State**: Whether the user has explicitly entered Canvas on mobile and the route back to the mobile launcher.

### Assumptions

- Phone-sized screens should default to launcher-and-full-screen app behavior; larger tablet and desktop screens may keep Canvas as the primary shell.
- Users authenticate through the existing Matrix sign-in path; no SSH credential setup is part of the user-facing mobile terminal flow.
- A short mobile disconnect should be treated as an expected interruption, not as intent to end a terminal session.
- The launcher should reuse the same app inventory users already see elsewhere in Matrix, rather than introducing a separate mobile-only app list.
- Canvas remains a first-class shell, but mobile defaults optimize for repeated daily use on small screens.
- The existing gateway terminal protocol may remain the server contract; mobile-specific controls can translate to the existing validated terminal frame shapes.

## Security Architecture *(mandatory for endpoints/WebSockets)*

### Auth Matrix

| Surface | Operation | Auth requirement | Public? | Notes |
|---------|-----------|------------------|---------|-------|
| Phone browser shell | Load mobile launcher, app surfaces, Canvas entry | Existing Matrix shell authentication | No | Phone-sized layout changes must not bypass normal shell auth. |
| Native mobile app | Connect to owner's gateway | Existing Matrix mobile authentication and gateway token handling | No | Mobile app stores only user-session material required by existing auth flow. |
| `GET /api/apps` and app manifest reads | List/open owner-visible apps | Authenticated owner session | No | App inventory remains owner-scoped and safe for mobile display. |
| App runtime session bootstrap | Launch embedded runtime apps | Authenticated owner session plus short-lived app-scoped handoff | No | Handoff token/cookie must be scoped to app slug and owner session. |
| `GET /api/terminal/sessions` | List resumable terminal sessions | Authenticated owner session | No | Response must be bounded and owner-scoped. |
| `DELETE /api/terminal/sessions/:id` | Intentionally end a terminal session | Authenticated owner session | No | DELETE is mutating and still needs body limits and session ID validation. |
| `/ws/terminal` | Attach/create/resume/detach terminal streams | Authenticated owner session; query-token path allowed for browser/mobile WebSocket APIs | No | Setup/auth must complete before success frames are sent. |

### Input Validation And Resource Limits

- Phone shell route state MUST validate app slugs, terminal session IDs, shell modes, query params, and resume targets before use.
- Terminal WebSocket frames MUST use the existing Zod-validated gateway protocol or a stricter mobile adapter that maps to it.
- Terminal input and paste payloads MUST remain bounded; resize values MUST stay within gateway bounds.
- Mobile terminal UX MUST respect the gateway's current terminal caps unless the implementation deliberately changes and tests them: 10 live sessions per owner runtime, 10 subscribers per terminal session, 64KB maximum input frame, 500 maximum columns, and 200 maximum rows.
- Mutating HTTP endpoints, including DELETE, MUST use `bodyLimit` even when no body is expected.
- App/session collections exposed to mobile MUST be capped, stable-sorted, and safe under multiple tabs or reconnects.

### Error Policy And Failure Modes

- Client-visible errors MUST be generic and recovery-oriented; raw provider errors, internal paths, database errors, tokens, or process details must stay in server logs.
- App runtime launch failure MUST offer retry and return-home paths.
- Terminal attach failure MUST leave the session list recoverable and must not imply that the underlying terminal process was destroyed unless the user intentionally ended it.
- Browser sleep, tab eviction, and short network loss are treated as detach/reconnect events, not destructive terminal events.
- Canvas exit on mobile MUST return to the launcher even if Canvas pan/zoom state is stale.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of users testing on phone-sized screens can open Matrix, find Terminal, and reach a usable terminal session in under 20 seconds after sign-in.
- **SC-002**: 90% of users can open any listed app from the mobile launcher and return to the launcher without using browser navigation.
- **SC-003**: Terminal sessions survive at least 10 minutes of phone sleep or browser backgrounding in 95% of test runs where the VPS remains healthy.
- **SC-004**: 95% of common terminal actions in the mobile usability script can be completed without an external keyboard.
- **SC-005**: No tested mobile terminal flow requires users to create, paste, upload, or understand SSH keys.
- **SC-006**: Phone-sized viewport checks show no primary launcher, app, terminal, or return-home control hidden behind browser chrome, safe areas, or the virtual keyboard.
- **SC-007**: Mobile shell validation catches regressions where phone-sized users land directly on Canvas by default instead of the launcher.
- **SC-008**: User-safe error handling prevents raw internal errors, provider names, filesystem paths, or secret-looking values from appearing in mobile shell and terminal error states during validation.
