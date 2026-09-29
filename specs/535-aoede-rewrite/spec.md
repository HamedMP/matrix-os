# Feature Specification: Matrix-Native Aoede Voice Mode

**Feature Branch**: `feat/aoede-rewrite`
**Created**: 2026-09-29
**Status**: Approved for planning
**Input**: Rewrite Aoede as a Matrix-native, provider-neutral voice mode over canonical Chat, with explicit session controls, trustworthy actions, recoverable sessions, and a lightweight local development path.

## Context

The current Aoede experience is a hidden, provider-specific overlay with its own conversation, memory, progress reporting, and failure behavior. It can converse, search, open apps, remember voice-only facts, and delegate app creation, but those capabilities do not share the durable transcript, action state, approvals, or recovery model of normal Matrix Chat. Its animated orb does not communicate enough state, its generic connection failure gives users no useful recovery path, and its delegated build progress can be inferred incorrectly.

Aoede will become voice mode for the active Matrix Chat. Speaking, typing, visual results, tool activity, approvals, and durable history will remain one conversation. The visual voice surface will make microphone use and system state explicit without replacing Chat or becoming a separate assistant product.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Continue One Chat by Voice or Text (Priority: P1)

As a Matrix user, I want to speak in the Chat I am already using and switch between speech and typing without losing context so voice feels like a faster interaction mode rather than a separate assistant.

**Why this priority**: A shared conversation is the central product correction. Without it, the rewrite preserves the current split transcript, memory, and action model.

**Independent Test**: Start voice from an existing Chat, alternate two spoken turns with a typed turn, end voice, reopen the Chat, and verify the complete ordered transcript and resulting artifacts remain available in that Chat.

**Acceptance Scenarios**:

1. **Given** a user has an active Chat, **when** they start voice mode and speak, **then** their finalized speech and Aoede's response appear in that same Chat.
2. **Given** voice mode is active, **when** the user types and sends a message, **then** Aoede continues from the combined spoken and typed context.
3. **Given** voice mode ends, **when** the user returns later, **then** the transcript, completed actions, and reviewable results remain in the Chat.
4. **Given** no Chat is active, **when** the user starts voice mode, **then** Matrix creates or selects a normal Chat and makes that destination visible before conversation begins.
5. **Given** the user changes to a different Chat, **when** voice mode is active, **then** Matrix clearly indicates which Chat owns the session and never silently writes speech to the newly focused Chat.

---

### User Story 2 - Know and Control What Voice Is Doing (Priority: P1)

As a user, I want clear, persistent controls and literal status so I always know whether Matrix can hear me, is thinking, is using a tool, or is speaking, and I can stop any of those activities immediately.

**Why this priority**: An always-listening interface without understandable state and interruption controls is unsafe and unusable, regardless of conversational quality.

**Independent Test**: Exercise connecting, listening, thinking, tool use, speaking, pause, reconnect, failure, and end states using a scripted session; verify each state has text, non-color feedback, accessible announcement, and the appropriate controls.

**Acceptance Scenarios**:

1. **Given** voice mode is visible, **when** its state changes, **then** it shows one literal state label from Connecting, Listening, Thinking, Using tool, Speaking, Paused, Reconnecting, Failed, or Ended.
2. **Given** the session is listening, **when** the user selects Mute or Hold, **then** microphone input stops and the paused state is unmistakable.
3. **Given** Aoede is speaking, **when** the user selects Stop speaking or begins a genuine interruption, **then** audible output stops promptly and unheard output does not become part of effective conversation history.
4. **Given** hands-free turn detection is unreliable, **when** the user enables push-to-talk, **then** only deliberately held input is treated as speech.
5. **Given** the user selects End, closes the owning Chat, signs out, or revokes microphone permission, **when** shutdown completes, **then** capture and playback stop and the session cannot continue invisibly.
6. **Given** reduced motion is enabled, **when** voice activity changes, **then** status remains understandable without pulsing, shimmering, or spatial animation.

---

### User Story 3 - Use Matrix Capabilities Safely by Voice (Priority: P1)

As a user, I want Aoede to discuss, create, open, and manage workspace apps using the same trustworthy actions and approvals as Chat so spoken requests cannot bypass Matrix safeguards or fabricate progress.

**Why this priority**: Voice is valuable to Matrix only when it can operate the workspace, but speech recognition and conversational ambiguity increase the risk of unintended actions.

**Independent Test**: Ask Aoede to inspect apps, open an app, propose a new app, start its approved creation, report progress, cancel an interruptible operation, and handle a failed operation; compare every state and result with the same action initiated through Chat.

**Acceptance Scenarios**:

1. **Given** the user makes a read-only request, **when** Aoede uses a capability, **then** the active tool and its result are visible in Chat.
2. **Given** a spoken request would send, publish, delete, spend, change permissions, or otherwise create a consequential side effect, **when** Aoede proposes it, **then** Matrix presents the exact action and arguments for normal approval before execution.
3. **Given** a proposed action's arguments change after approval, **when** execution is attempted, **then** the prior approval is invalid and a new approval is required.
4. **Given** an app build is running, **when** the user asks for progress, **then** Aoede reports canonical operation state rather than an elapsed-time guess.
5. **Given** an action fails or has an uncertain outcome, **when** Aoede responds, **then** it accurately distinguishes failed, cancelled, and outcome-unknown states and provides a safe next action.
6. **Given** the user interrupts speech while a tool runs, **when** the tool is cancellable, **then** cancellation is requested and visibly resolved; when it is not safely cancellable, Aoede explains that the action is still running rather than claiming it stopped.

---

### User Story 4 - Recover Without Losing Intent or Repeating Actions (Priority: P1)

As a user, I want temporary connection or provider failures to recover in place without losing my transcript, replaying side effects, or forcing me to restart the conversation.

**Why this priority**: Realtime sessions encounter ordinary network, device, and provider failures. Recovery is part of the core experience, not an exceptional enhancement.

**Independent Test**: Disconnect the active transport during user speech, assistant speech, a read-only tool, an approval wait, and a side-effecting action; verify each session restores or fails safely with one transcript and no duplicate action.

**Acceptance Scenarios**:

1. **Given** connectivity is lost, **when** automatic recovery is possible, **then** Matrix shows Reconnecting, preserves the Chat and pending intent, and resumes without creating a second visible conversation.
2. **Given** recovery succeeds, **when** the session becomes active, **then** late events from the old connection cannot add audio, transcript, or action results.
3. **Given** a non-idempotent action may have executed before disconnection, **when** recovery occurs, **then** Matrix reconciles its result or marks it outcome unknown and never silently repeats it.
4. **Given** automatic recovery expires, **when** the session fails, **then** the user can retry voice or continue by typing in the same Chat.
5. **Given** the input or output audio device changes or disappears, **when** Matrix detects it, **then** it pauses safely and offers an understandable device recovery path.
6. **Given** an interrupted response would otherwise remain inside a reusable agent checkpoint, **when** the next spoken or typed turn begins, **then** Matrix invalidates or reconstructs that checkpoint so unheard content cannot enter model context; voice fails closed when the selected agent cannot support this.

---

### User Story 5 - Control Privacy, Memory, and Shared Context (Priority: P2)

As a user, I want to understand what voice sends, shares, stores, and remembers so I can use Aoede around private work and other people without invisible collection.

**Why this priority**: An ambient microphone and provider-hosted processing require unusually legible privacy boundaries. Voice-only hidden memory is incompatible with Matrix's owner-controlled data model.

**Independent Test**: Start ordinary and session-only conversations, inspect the active microphone and optional shared context, review what was saved, then delete the Chat and verify owner-visible voice data follows the normal Chat lifecycle.

**Acceptance Scenarios**:

1. **Given** voice mode has not started, **when** the user views its entry point, **then** Matrix does not access the microphone.
2. **Given** microphone permission is required, **when** Matrix requests it, **then** it first explains why access is needed and provides recovery instructions if permission is denied.
3. **Given** a voice session is active, **when** the user inspects the surface, **then** it clearly identifies active microphone capture, any selected shared window or context, and whether new memory may be written.
4. **Given** session-only mode is selected, **when** the conversation proceeds, **then** no new durable memory is created beyond the user-visible Chat content and required bounded operational metadata.
5. **Given** Aoede proposes remembering information, **when** durable memory is available, **then** the memory is inspectable, attributed, editable or removable through the normal Matrix memory model rather than a voice-only file.
6. **Given** raw audio is not required for an active session or an explicitly selected recording feature, **when** processing completes, **then** raw audio is not retained by Matrix by default.
7. **Given** session-only mode is offered, **when** the user speaks, types in the owning Chat, invokes tools, reconnects, or restarts during that session, **then** Matrix enforces the policy across agent checkpoints, memory-capable tools, and provider retention rather than relying on prompt instructions.

---

### User Story 6 - Use a Consistent Experience Across Matrix Surfaces (Priority: P2)

As a user moving between Matrix surfaces, I want the same voice state, controls, Chat ownership, and action safety even when the presentation adapts to my device.

**Why this priority**: Voice cannot become another renderer-specific product. The headless capability and state contract must remain consistent even if native audio implementations differ.

**Independent Test**: Run the same scripted conversation and failure cases in Web Canvas, Web Desktop, and Electron Desktop, then verify equivalent information and controls on every released surface.

**Acceptance Scenarios**:

1. **Given** voice mode is available in Web Canvas, Web Desktop, or Electron Desktop, **when** the same session state occurs, **then** each surface exposes equivalent status, transcript, controls, approvals, and recovery.
2. **Given** voice mode is not yet supported on a surface, **when** a user encounters its entry point, **then** Matrix does not advertise a control that cannot work and clearly documents the platform limitation.
3. **Given** a keyboard is available, **when** the user navigates voice mode, **then** all controls are reachable, labeled, focus-visible, and operable without a pointer.
4. **Given** screen-reader use, large text, high contrast, or browser zoom, **when** voice mode changes state, **then** critical status and controls remain perceivable and usable without relying on the orb or waveform.

### Edge Cases

- The user speaks while microphone permission is pending, revoked, or granted to a different input device.
- The user interrupts before the first assistant audio frame, during a tool request, or exactly as a turn completes.
- Local playback stops before the provider acknowledges cancellation; late audio and transcript events arrive afterward.
- Two tabs or surfaces attempt to control voice for the same Chat or microphone.
- The active Chat is archived, deleted, shared, or loses write permission during a session.
- The user changes Chat, account, runtime, or selected project while voice is active.
- A transcript correction arrives after provisional text has already been shown.
- Connection loss occurs after an action commits but before Matrix receives acknowledgement.
- The provider session reaches a time, context, concurrency, rate, or spending limit.
- Speech finalization arrives out of order, duplicates a prior final, corrects text after admission, or races a typed turn and Chat revision change.
- Input queues fill because upstream processing or the network is slower than capture.
- The user locks the device, backgrounds the app, removes an audio device, or changes output route.
- Another person is audible; Matrix must not imply that consent was obtained.
- The selected provider does not support a capability such as direct realtime transport, native session resumption, or reliable tool cancellation.
- The visual activity indicator cannot initialize because advanced graphics are unavailable.
- Session creation succeeds but its response is lost before the client receives the one-time connection credential.
- Generation finishes before audio playback, or the Gateway crashes before, during, or after a playback acknowledgement.
- The selected agent supports conversation but cannot enforce exact action approval, selective cancellation, session-only memory, or delivery-aware resume.

## Requirements *(mandatory)*

### Functional Requirements

#### Canonical conversation and session ownership

- **FR-001**: Voice mode MUST belong to exactly one canonical Matrix Chat for its lifetime.
- **FR-002**: Spoken and typed turns MUST share one ordered transcript, context, action history, and recovery path.
- **FR-003**: Starting voice without an active Chat MUST create or select a normal Chat and disclose that selection before capture begins.
- **FR-004**: Changing visible Chat focus MUST NOT silently retarget an active voice session.
- **FR-005**: Ending voice MUST end realtime capture and playback without closing or deleting the owning Chat.
- **FR-006**: Voice mode MUST use the same canonical action, approval, operation, and memory authorities as ordinary Chat.
- **FR-007**: Voice mode MUST NOT maintain a separate durable transcript, hidden profile, guessed operation ledger, or provider-owned source of truth.

#### State and controls

- **FR-008**: The user-visible lifecycle MUST distinguish Connecting, Listening, Thinking, Using tool, Speaking, Paused, Reconnecting, Failed, and Ended.
- **FR-009**: Every active state MUST have a literal text label and non-color-only indication.
- **FR-010**: Mute or Hold, Stop speaking, End, and push-to-talk controls MUST remain reachable whenever relevant.
- **FR-011**: Entry controls MUST toggle consistently; transient voice surfaces MUST also support light dismiss and Escape without leaving an invisible active microphone.
- **FR-012**: Closing or dismissing presentation chrome MUST either keep an explicit persistent microphone indicator or end/pause the session; capture MUST never become undiscoverable.
- **FR-013**: Interruption MUST stop local audible output immediately, prevent unheard output from becoming effective history, invalidate any reusable agent checkpoint that retains the unheard suffix, and fence late output from the interrupted turn. Voice MUST fail closed for an agent that cannot reconstruct delivery-aware context safely.
- **FR-014**: Push-to-talk MUST provide a deterministic alternative to automatic turn detection.
- **FR-015**: Reduced-motion mode MUST preserve meaning while removing nonessential spatial, shimmer, waveform, and pulsing animation.

#### Transcript and multimodal interaction

- **FR-016**: Provisional user speech MUST be visually distinguishable from finalized transcript content.
- **FR-017**: Transcript corrections MUST update the provisional/final speech representation without duplicating a Chat turn.
- **FR-018**: Assistant transcript MUST distinguish generated content from content actually played when interruption makes them differ, and the durable context used by later spoken or typed turns MUST use the conservative acknowledged delivery boundary rather than assuming the full visible response was heard.
- **FR-019**: Tool activity, approvals, visual results, and failure states MUST use canonical Chat presentation rather than spoken-only summaries.
- **FR-020**: Users MUST be able to continue by typing before, during, and after a voice session.

#### Actions and approvals

- **FR-021**: Every requested action MUST have a stable canonical identity, normalized tool/schema identity, normalized argument digest, idempotency/reconciliation identity, and visible lifecycle from proposal through terminal outcome before it is eligible for voice execution.
- **FR-022**: Consequential actions MUST use canonical Matrix approval bound to the exact normalized argument digest before execution. Harnesses or tools that cannot enforce this MUST be unavailable for consequential voice actions.
- **FR-023**: Approval MUST be invalidated when the proposed action or arguments change.
- **FR-024**: Retried or recovered sessions MUST NOT repeat a non-idempotent action without reconciliation and renewed user intent.
- **FR-025**: Cancellation MUST distinguish stopping assistant speech, cancelling model generation, and cancelling an external action; the interface MUST report unsupported or non-cancellable actions truthfully rather than implying selective cancellation.
- **FR-026**: Progress statements MUST derive from canonical operation state and MUST NOT be inferred solely from elapsed time, Chat busy state, or newly appearing apps.
- **FR-027**: Failed, cancelled, timed-out, and outcome-unknown actions MUST remain distinct and provide safe recovery choices.

#### Failure recovery and limits

- **FR-028**: Voice mode MUST recover transport loss in the same Chat and preserve committed transcript and pending user intent.
- **FR-029**: Events from an obsolete or replaced connection MUST NOT mutate the active session.
- **FR-030**: Recovery MUST prefer provider-native continuation when trustworthy but MUST remain possible from Matrix-owned state when native continuation is unavailable.
- **FR-031**: Exhausted automatic recovery MUST offer retry voice and continue by text without discarding the Chat.
- **FR-032**: Session duration, idle time, audio volume, queued data, tool activity, context growth, concurrency, and cost MUST have enforced bounds and visible limit outcomes.
- **FR-033**: Provider or internal errors MUST produce safe actionable messages without exposing credentials, provider payloads, stack traces, owner paths, or internal topology.
- **FR-034**: Device loss or permission revocation MUST pause safely, stop affected media, and provide device-specific recovery.
- **FR-034A**: Before first playback Matrix MUST durably mark delivery pending, update only acknowledged synthesis-segment boundaries idempotently, and persist complete, interrupted, or unknown terminal delivery without requiring the canonical run to remain active. Missing acknowledgement after a crash MUST never mean fully heard.
- **FR-034B**: Finalized speech MUST enter canonical Chat through the normal revision, selection, permission, queue, steering, and active-run rules. Provider completion order MUST NOT determine canonical turn order, and a correction after admission MUST NOT create a second executable turn.

#### Privacy and owner control

- **FR-035**: Matrix MUST NOT request microphone access before an explicit user action and explanation.
- **FR-036**: The active microphone, output, optional shared context, and memory mode MUST remain inspectable during a session.
- **FR-037**: Session-only mode MUST be an immutable, auditable canonical execution policy for every spoken and typed turn submitted while the voice session owns the Chat. It MUST disable incompatible memory tools and reusable native checkpoints and MUST be hidden when the selected route cannot enforce it.
- **FR-038**: Durable memories proposed from voice MUST use the normal inspectable, editable, exportable, and deletable Matrix memory model.
- **FR-039**: Raw audio MUST NOT be retained by Matrix after active processing by default.
- **FR-040**: Provider data flow, retention behavior, capability limits, and any platform-specific differences MUST be disclosed before release.
- **FR-041**: Deleting or exporting the owning Chat and related memories MUST include the same voice-derived user data governed by those ordinary Matrix actions.

#### Surfaces and accessibility

- **FR-042**: Web Canvas, Web Desktop, and Electron Desktop MUST use one shared semantic state and behavior contract.
- **FR-043**: Applicable released surfaces MUST expose equivalent status, transcript, controls, approval behavior, and recovery even when physical presentation differs.
- **FR-044**: Unsupported surfaces MUST hide or explicitly disable voice entry rather than launch a nonfunctional experience.
- **FR-045**: Voice mode MUST support keyboard-only operation, visible focus, meaningful accessible names, state announcements, large text, high contrast, and screen-reader-readable transcripts.
- **FR-046**: The animated orb, waveform, audio cue, and haptic feedback MUST remain supplementary and MUST NOT be the sole representation of state.
- **FR-047**: Opening the voice surface MUST not shift existing Chat or OS-view layout.
- **FR-047A**: A voice media WebSocket MUST authenticate through a narrow one-time session credential bound to the trusted principal, Chat, session, path, and winning transport generation; credential replay, wrong origin, wrong path, and stale generations MUST fail before session mutation.

#### Migration and rollout

- **FR-048**: The legacy Aoede entry point MAY remain hidden during staged development but MUST be replaced by the canonical voice entry before general availability.
- **FR-049**: Existing useful capabilities—conversation, search, app lookup/open, app creation delegation, and truthful status—MUST have explicit parity decisions before legacy removal.
- **FR-050**: Legacy voice-only memory and guessed progress data MUST NOT be silently promoted into canonical state without validation and user-visible ownership.
- **FR-051**: The old provider-specific session path MUST be removed only after canonical voice mode passes contract, recovery, accessibility, real-provider, and production-parity acceptance.
- **FR-052**: Onboarding voice reuse is deferred; the Aoede rewrite MUST not change onboarding behavior unless a separately reviewed compatibility change is required.

### Key Entities

- **Voice Session**: A bounded realtime interaction attached to one Chat, including lifecycle state, active connection identity, selected devices, limits, and recovery status.
- **Voice Turn**: One user or assistant contribution with provisional and final transcript, timing, interruption, and played-audio information.
- **Transport Epoch**: The identity of one active connection attempt; only the current epoch may advance the session.
- **Playback Record**: The generated, delivered, played, and interrupted portions of assistant audio used to determine what the user actually heard.
- **Tool Invocation**: A canonical Matrix action proposal with exact arguments, approval state, execution state, cancellation state, and terminal outcome.
- **Session Projection**: The bounded context sent to a realtime provider from Matrix-owned Chat, memory, policy, and pending commitments.
- **Voice Preferences**: Owner-controlled input/output device choice, hands-free or push-to-talk mode, interruption behavior, voice selection, and accessibility preferences.
- **Voice Capability**: A truthful description of whether voice is available on the current surface/runtime and which transport, provider, device, and recovery capabilities are supported.

### Assumptions and Dependencies

- Canonical Chat, tool activity, approvals, and operation state remain authoritative and are extended only where a proven voice requirement cannot be represented.
- The initial product scope is an app and workspace copilot: discussion, search, app inspection/opening, app creation, and related canonical Matrix capabilities. Unrestricted desktop control is excluded.
- Web Canvas, Web Desktop, and Electron Desktop are the initial release surfaces. Native Mobile uses the same semantic contract but may ship in a separately reviewed follow-up.
- A provider-neutral Matrix session model is required even if the initial rollout uses one provider.
- Provider selection for general availability follows measured quality, latency, reliability, cost, privacy, and platform-support evidence rather than the visual component library selected for the client.
- Raw audio is transient by default. Any future recording, export, or training contribution requires a separate explicit user flow.
- A separate public documentation pull request will be created in the private `FinnaAI/matrix-os-site` repository under `content/docs/` before release.

### Explicitly Out of Scope

- Telephony and channel voice-note transcription.
- Rewriting the onboarding voice workflow in the first Aoede delivery.
- General autonomous desktop input, whole-screen control, or unrestricted shell-command execution.
- Emotion diagnosis, companion-style pseudo-intimacy, or behavioral claims based on inferred vocal emotion.
- Raw-audio history, call recording, voice cloning, or default audio retention.
- A provider-specific hosted widget as Matrix's primary voice interface.
- A separate Aoede conversation list, memory store, tool authority, or app-builder pipeline.
- Native Mobile visual implementation in the initial stack unless required to preserve an already released capability.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability validation, at least 9 of 10 participants can identify whether Matrix is listening, paused, thinking, using a tool, or speaking without instruction.
- **SC-002**: At least 9 of 10 participants can mute, stop assistant speech, and end the session on their first attempt.
- **SC-003**: A user can start voice from an existing Chat and complete the first spoken turn within 10 seconds, excluding an operating-system permission prompt they have not previously answered.
- **SC-004**: In measured supported environments, 95% of ordinary spoken turns begin audible response or a truthful named-operation status within 2 seconds after turn completion.
- **SC-005**: In the complete interruption test corpus, assistant audio stops within 250 milliseconds of local interruption detection and no unheard continuation appears as effective conversation history.
- **SC-006**: All scripted disconnect cases preserve committed transcript and produce zero duplicated consequential actions.
- **SC-006A**: All generation/playback crash-window tests reconstruct the next spoken and typed model context without any unacknowledged assistant suffix and never classify an unknown delivery as fully heard.
- **SC-007**: Every action presented by voice has the same terminal state and approval result as the equivalent action initiated through Chat.
- **SC-008**: All scripted permission, device, provider, quota, and network failures provide a specific recovery action; none terminate with only “Could not connect to voice service.”
- **SC-009**: Web Canvas, Web Desktop, and Electron Desktop pass the same state, control, transcript, approval, recovery, keyboard, screen-reader, reduced-motion, and high-contrast acceptance suite.
- **SC-010**: Routine development and the complete deterministic voice behavior suite run without a VM, production provider credential, or full production-parity stack.
- **SC-011**: A fresh contributor can launch the deterministic voice fixture and reproduce listening, interruption, approval, reconnect, and failure states in under five minutes after normal dependency installation.
- **SC-012**: Legacy Aoede is removed with no unresolved parity item, no voice-only durable memory authority, no guessed build progress, and no hidden active microphone path.
- **SC-013**: Every enabled agent/tool route passes canonical delivery-aware resume, argument-bound approval, action reconciliation, memory-policy, admission-ordering, and transport-auth conformance; unsupported capabilities remain visibly unavailable.
