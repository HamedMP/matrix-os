# Feature Specification: Aoede Live Voice Assistant

**Feature Branch**: `548-aoede-live`
**Created**: 2026-10-07
**Status**: Draft
**Input**: Replace the non-functional Gemini Live assistant and the abandoned `feat/aoede-product-rebuild` branch with a Siri-style full-screen voice assistant that holds a natural full-duplex conversation, performs tasks and builds apps through the same execution path as Chat, and remembers the user. Research: [research.md](./research.md).

## Background

Matrix OS has had two voice assistants. The first ("Vocal", spec 066) had the right features: personality, greeting, memory, search, open-app, build-app with progress. It no longer connects. Its tool execution ran through the browser: the gateway told the shell to type into the Chat panel and the shell guessed completion from UI state. The second (`feat/aoede-product-rebuild`, spec 535) moved execution server-side but replaced the conversational voice model with a chained transcribe → reason → synthesize pipeline it built itself; it was slow and unreliable and never reached one minute of conversation.

This feature keeps the first assistant's features and the second's server-side execution, and lets a full-duplex voice model own listening, speaking, and interruption.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Talk to Aoede (Priority: P1)

The user invokes Aoede from the launcher, command palette, or a keyboard shortcut. A full-screen translucent overlay appears over the desktop with an animated presence and live captions. After one-time microphone consent, Aoede greets the user and the user talks naturally: pauses mid-sentence, interrupts, changes topic, asks general questions. Aoede responds in a consistent warm, concise spoken character. The user dismisses with Escape, a button, or by saying goodbye; focus returns to where it was.

**Why this priority**: Without a reliable conversation nothing else matters. Both prior assistants failed here.

**Independent Test**: Open Aoede, converse for five minutes including at least three interruptions and one 60-second silence, dismiss. Delivers a working voice companion with no actions.

**Acceptance Scenarios**:

1. **Given** the desktop is open, **When** the user invokes Aoede, **Then** the overlay appears within one second, the microphone is requested (first time only), and Aoede speaks a greeting within three seconds of the session starting.
2. **Given** Aoede is speaking, **When** the user starts talking, **Then** Aoede stops within one second and responds to the new input.
3. **Given** the user pauses for up to two seconds mid-sentence, **When** they continue, **Then** Aoede treats it as one utterance.
4. **Given** the user says nothing for 60 seconds, **When** they speak again, **Then** the conversation continues normally.
5. **Given** the overlay is open, **When** the user presses Escape, **Then** the session ends, the overlay closes, audio stops, and keyboard focus returns to the previously focused element.
6. **Given** microphone permission is denied, **When** the user invokes Aoede, **Then** the overlay explains how to grant it and offers to retry; no session is billed.

---

### User Story 2 - Do things on the desktop by voice (Priority: P1)

The user asks Aoede to open or close an app, create or edit a note, or remember a fact. Aoede acknowledges immediately, the action happens on the desktop behind the overlay, and Aoede confirms in its own words. Facts persist across sessions and shape future greetings.

**Why this priority**: The minimum "assistant" behaviour; cheap to deliver once the conversation works.

**Independent Test**: Say "open my notes", "add milk to my grocery note", "remember I prefer dark themes", close and reopen Aoede, hear a greeting that reflects the fact.

**Acceptance Scenarios**:

1. **Given** an app named "Notes" is installed, **When** the user says "open my notes app", **Then** a Notes window opens within three seconds and Aoede confirms.
2. **Given** several apps match loosely, **When** the user asks to open one ambiguously, **Then** Aoede asks which one rather than guessing.
3. **Given** no app matches, **When** the user asks to open it, **Then** Aoede says so and offers to list installed apps.
4. **Given** the user says "remember my name is Arian", **When** a new session starts later, **Then** the greeting uses the name.
5. **Given** a stored fact, **When** the user asks "what do you know about me" or "forget that", **Then** Aoede lists or removes facts accordingly.
6. **Given** a note with existing text and formatting, **When** the user asks to append an item, **Then** the item is persisted and visible in Notes without losing the existing content or formatting.
7. **Given** a window action fails or its result is unavailable, **When** Aoede reports the outcome, **Then** it does not claim the app opened or closed successfully.

---

### User Story 3 - Delegate building an app and keep talking (Priority: P2)

The user describes an app. Aoede acknowledges and hands the work to Matrix OS's builder, which runs with the same tools, history, and approvals as Chat. The overlay shows a compact progress card. The user keeps conversing; they can ask "how's it going?", "stop that", or approve a requested permission by voice or click. When the build finishes, Aoede announces it and offers to open the result; failures are reported honestly.

**Why this priority**: The headline capability of the original assistant and the stated product goal.

**Independent Test**: Say "build me a pomodoro timer with a dark theme", chat about something else for two minutes, ask for progress, hear the completion announcement, say "open it".

**Acceptance Scenarios**:

1. **Given** the user describes an app, **When** Aoede delegates, **Then** a run appears in the owner's Chat titled "Aoede", authored by the real user with explicit voice context, and a progress card appears within three seconds.
2. **Given** a build is running, **When** the user asks about progress, **Then** Aoede reports the current stage and elapsed time from the actual run, not an estimate.
3. **Given** a build is running, **When** the user says "stop", **Then** the run is cancelled and Aoede confirms.
4. **Given** the builder needs an approval, **When** it asks, **Then** the overlay shows an approve/deny card and Aoede asks aloud. A clear spoken decision may resolve a sole presented low-risk approval through the same authenticated route as a click; medium/high/unknown-risk or destructive approvals require a click. Stale or ambiguous speech grants nothing.
5. **Given** a build completes while the user is mid-conversation, **When** it finishes, **Then** Aoede announces it at the next natural moment without cutting the user off, and the result opens on request.
6. **Given** a build fails, **When** it fails, **Then** Aoede says so plainly and the card links to the Chat run.
7. **Given** the user closes the overlay during a build, **When** they return later, **Then** the build has continued and its outcome is available in Chat and announced on the next session.

---

### User Story 4 - Ask about the world and the workspace (Priority: P3)

The user asks factual questions needing current information, or about their own workspace ("what apps do I have", "what was I working on"). Aoede answers using Matrix OS's search and workspace knowledge, grounded and brief.

**Why this priority**: Parity with the first assistant's search grounding; depends on Story 3's execution path.

**Independent Test**: Ask "what's the weather in Lisbon right now" and "which apps do I have installed"; receive correct spoken answers.

**Acceptance Scenarios**:

1. **Given** a question needing current information, **When** asked, **Then** Aoede answers within ten seconds with information it actually retrieved, or says it couldn't.
2. **Given** a question about installed apps or recent work, **When** asked, **Then** the answer reflects the real workspace state.

---

### Edge Cases

- Backend result that does not answer the question: the voice model speaks whatever it is given verbatim (research finding 1). Results must be correct and self-describing; placeholder or speculative results are never sent.
- Second user utterance referencing an earlier one ("I asked something else"): the delegated request includes recent conversation turns, not only the last utterance.
- Delegation arrives before the last transcript fragment: a short grace period precedes building the request.
- Slow backend (>10 s): Aoede may say it is still working if asked; long tasks (builds) report "started" immediately and announce completion later.
- Server component restarts mid-conversation: the overlay reports interruption and offers a fresh session with bounded saved context and current Chat outcomes. Recent uncheckpointed speech may be lost; completed or uncertain mutations are not automatically replayed. Existing Chat recovery governs builds, not the voice transport.
- Session expiry or provider outage: the overlay states the conversation ended and offers to start again; no partial action is silently lost (in-flight builds continue in Chat).
- Two Aoede invocations (two tabs/devices): one active session per user; the newer takes over and the older overlay states so.
- Microphone/output device changes mid-session: handled by the browser; the overlay shows current devices and allows switching in settings.
- Reduced-motion preference: the presence animation is static or minimal.
- Voice-triggered destructive actions (deleting files, spending money): always route through the existing Chat approval flow; never auto-approved by voice.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Aoede MUST be invocable from launcher, command palette, and a keyboard shortcut on Web Desktop and Web Canvas, and MUST render as a single full-screen overlay above the current layout without changing it.
- **FR-002**: Aoede MUST request microphone consent explicitly on first use and MUST NOT start a billable session before consent.
- **FR-003**: Aoede MUST greet the user after the session starts, using remembered facts when present.
- **FR-004**: Aoede MUST support full-duplex conversation: the user can interrupt at any time and Aoede stops speaking within one second.
- **FR-005**: Aoede MUST show live captions of both sides of the conversation.
- **FR-006**: Aoede MUST maintain a consistent spoken persona (warm, concise, no technical narration, no markdown) defined in one place.
- **FR-007**: Aoede MUST authorize actions and perform data/execution mutations server-side with the user's existing authorization. The shell may render authorized window effects and submit explicit owner decisions; it MUST NOT grant itself backend authority, fabricate work or bypass approval policy.
- **FR-008**: Supported direct actions: open app, close app, list apps, create note, append/edit note, remember fact, list facts, forget fact. Each MUST validate its input against a strict schema.
- **FR-009**: Any request beyond direct actions (building, editing files, research, workspace questions) MUST run through the canonical Chat execution path so it appears in Chat history, uses Chat's tools, and is subject to Chat's approvals and cancellation.
- **FR-010**: Aoede MUST relay build/run progress, approval requests, completion, and failure to the user both visually (card) and spoken (at a natural moment), using the run's real state.
- **FR-011**: Aoede MUST let the user cancel a delegated run by voice or click.
- **FR-012**: Aoede MUST support click approval/denial through existing authenticated Chat approvals. Voice decisions MUST use that same route and only resolve a sole current, presented low-risk approval with an explicit unambiguous utterance. Medium/high/unknown-risk and destructive approvals MUST require a click; voice MUST NOT grant session-wide permission or weaken approval provenance.
- **FR-013**: Remembered facts MUST persist per user across sessions, be inspectable and deletable, be capped in count and length, and MUST NOT be silently lost on upgrade (existing `vocal-profile.json` facts are preserved).
- **FR-014**: Delegated requests MUST include recent conversation context (bounded) so follow-ups and corrections resolve correctly.
- **FR-015**: Aoede MUST NOT speak results that were not produced by a completed, verified action.
- **FR-016**: Speech credentials MUST remain with the platform. Billable sessions MUST be runtime-authenticated and funded before creation through the existing wallet; final provider usage MUST settle once. Missing final usage MUST remain explicitly unconfirmed with conservative accounting, not be recorded as an exact zero or accepted from the browser.
- **FR-017**: Exactly one active Aoede session per user; a new session supersedes the old one, which is told so.
- **FR-018**: Dismissal MUST stop audio, end the session, release the microphone, and restore keyboard focus. Escape and an on-screen control MUST both work.
- **FR-019**: The overlay MUST respect reduced-motion preferences and be operable with keyboard and screen reader for its controls and cards.
- **FR-020**: After gateway restart, Aoede MUST report the interrupted conversation and offer explicit fresh-session recovery using bounded owner-controlled text and current durable Chat state. Recovery MUST NOT rerun completed work, automatically replay uncertain mutations or claim that missing provider events were recovered. Seamless live-session continuation is not guaranteed.
- **FR-021**: Provider or internal error messages MUST never be shown to the user; the overlay shows a generic message and offers retry.

### Authentication matrix

All application routes are private; provider transport credentials never leave the platform. Exact payload limits and planned internal routes are specified in [plan.md](./plan.md#auth-matrix-and-boundary-contracts).

| Interface | Auth source and authorization | Public? |
|---|---|---|
| `POST/DELETE /api/aoede/session` | Existing owner request identity plus runtime/current-session binding | No |
| Existing `/ws`, including Aoede frames | Existing authenticated owner socket; matched session/correlation IDs for UI results | No |
| Chat approval POST `/api/chats/:chatId/runs/:runId/approvals/:approvalId` | Authenticated shell through platform approval proof; canonical owner/run checks | No |
| Planned internal Aoede session mint | Current machine/slot/epoch speech runtime token; platform-derived owner and funded operation | No |
| Planned internal provider sideband attach | Same runtime token plus owned provider-session/reservation binding | No |

### Key Entities

- **Aoede Session**: an owner/runtime-bound voice conversation with invocation/provider IDs, start/end/available expiry, lifecycle state and a platform funded-operation binding. Interrupted sessions require an explicit new invocation.
- **Transcript Buffer and Recovery Checkpoint**: bounded recent text/roles/timing for delegation, captions and explicit recovery. Recovery text lives in owner Postgres, is inspectable/exportable/deletable and expires after 24 hours; raw audio is not stored. Uncheckpointed speech is not promised to survive a crash.
- **Delegation**: a persisted session/provider-delegation binding with stable admission request ID, intent, outcome and run/queued-turn ID. Duplicate delivery must not start work twice; an uncertain mutation outcome is exposed rather than automatically retried.
- **Direct Action**: a validated, schema-typed command (open/close/list app, note create/edit, remember/list/forget fact).
- **Aoede Chat**: a Chat conversation owned by the user that receives Aoede-delegated runs, visible in normal Chat history.
- **Profile Facts**: the user's remembered facts (existing `vocal-profile.json`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

These are qualification targets. The short spike in research.md does not establish any production success rate.

- **SC-001**: 95% of sessions in a 20-session manual test run reach five minutes of conversation without an unexpected disconnect.
- **SC-002**: Aoede begins speaking within 1.5 seconds of the user finishing an utterance for 90% of conversational turns.
- **SC-003**: When interrupted, Aoede stops within one second in 95% of attempts.
- **SC-004**: Direct actions (open app, note edit, remember) complete and are confirmed within three seconds in 95% of attempts.
- **SC-005**: A delegated app build started by voice appears in Chat history 100% of the time and its completion is announced in the session 100% of the time the session is still open.
- **SC-006**: Zero actions executed without server-side authorization; zero destructive actions without an explicit approval.
- **SC-007**: Facts remembered in one session are reflected in the next session's greeting 100% of the time.
- **SC-008**: Implementation footprint stays under roughly 2,000 lines of product code and 1,500 lines of tests; no custom audio transport, voice activity detection, or reconnect protocol is written.

## Out of Scope

- Electron desktop and native mobile surfaces (follow-up; the design does not preclude them).
- Telephony (spec 046).
- Screen or selection context beyond open windows and the active app.
- Provider choice for the voice layer; one provider is used.
- Merging any code from `feat/aoede-product-rebuild` beyond the orb visual styling.

## Assumptions

- The short client-delegation spike supports feasibility only. Duration, restart, delayed completion, ordering and finalization require the qualification gates in [plan.md](./plan.md#provider-qualification-gates-not-executed-by-this-plan-update).
- Platform proxy transport and speech funding primitives exist; Live-specific runtime policy, minting and trusted usage finalization must be integrated and verified, not assumed to exist.
- Canonical Chat exposes admission, events and cancellation. Kernel approval provenance requires the authenticated platform-routed shell HTTP path, not arbitrary in-process callers.
- A per-user "Aoede" Chat conversation is acceptable as the home for voice-initiated runs.
