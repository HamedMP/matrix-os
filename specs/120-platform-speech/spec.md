# Feature Specification: Platform Speech and Voice Interviews

**Feature Branch**: `codex/platform-speech-design`  
**Created**: 2026-09-10  
**Status**: Design proposal; user stories and product direction accepted, implementation paused  
**Input**: Consolidate speech into one platform-managed service. Use a platform-hosted OpenAI credential for record → stop → transcribe first. Support interchangeable platform-selected providers, explore live dictation, and plan live interviews and computer actions with OpenAI or Grok. Retain all previously accepted stories and Native Mobile chat streaming repair.

## User Scenarios & Testing

### US-01 — Speak an editable message (P0, first release)

As a chat user, I can record a message, stop, and review the transcript before sending it.

**Why**: This is the explicitly selected first experience. Speech is another way to compose a normal chat message.

**Independent test**: Dictate a short prompt, correct one word, then send it to the selected chat/harness.

**Acceptance**:
1. Given a ready computer, pressing the microphone requests permission when needed and shows a recording indicator and elapsed time.
2. Stop releases the microphone and starts transcription. Cancel releases the microphone and discards this recording.
3. The resulting text is editable. No chat turn or tool action starts until Send is pressed.
4. The same flow is available in a new chat and an existing chat on Web Canvas, Web Desktop, and Electron Desktop. Web Mobile uses the same behavior where chat is available.
5. The microphone is visually and semantically distinct from the later “Talk to computer” action.

### US-02 — Keep my draft and attachments (P0, first release)

As a user, I can mix typing and speech without losing work.

**Independent test**: Start with text and a file, dictate more text, and inspect the draft and attachment.

**Acceptance**:
1. Dictation appends to the existing draft, preserving text, structured references, and attachments. It does not silently replace a selected region.
2. Typed edits made while transcription is pending survive. The result is added once to the current revision of the same draft.
3. Duplicate delivery never inserts text twice. A length limit leaves existing text intact and reports that the transcript cannot fit; it does not silently truncate speech.
4. Sending during recording/transcription requires stopping or cancelling it first. A later result cannot populate a newly cleared draft.

### US-03 — Cancel, navigate, or switch computers safely (P0, first release)

As a user, I can leave a chat without recording continuing or its transcript appearing elsewhere.

**Independent test**: Change chat, presentation, or computer while microphone permission or transcription is pending.

**Acceptance**:
1. Cancel, sign-out, computer switch, chat/draft switch, and closing the owning surface stop capture and cancel pending work.
2. Late microphone permission results release their tracks immediately.
3. Late transcription results cannot alter another chat, account, runtime, or draft generation.
4. A supported presentation change may preserve the explicitly owned draft; it must not create a second recording session.

### US-04 — Read progressive replies on Native Mobile (P0, companion workstream)

As a Native Mobile user, I see assistant text and activity as they arrive.

**Independent test**: Run the same prompt on Native Mobile and Electron Desktop against one gateway, comparing ordered text, activity, and terminal outcome.

**Acceptance**:
1. Text appears progressively, without replacing accumulated output with stale snapshots.
2. Tool activity, approvals, failures, cancellation, and completion match the gateway's canonical state.
3. The selected chat and runtime retain isolation during streaming.

### US-05 — Resume after interruption (P0, companion workstream)

As a Native Mobile user, I can background the app or lose connectivity and recover the correct conversation.

**Independent test**: Background during a run, disconnect networking, and return after completion.

**Acceptance**:
1. Reconnection refreshes authentication and catches up from a valid cursor.
2. A missing replay window triggers snapshot recovery. Duplicate or out-of-order delivery does not duplicate or lose text.
3. A stalled connection becomes recoverable; completion does not leave a permanent spinner.
4. Background/foreground transitions release and re-establish transport resources deliberately.

### US-06 — Speak naturally (P1, first release quality)

As a multilingual user, I can dictate ordinary language and technical terms.

**Independent test**: Evaluate representative recordings with names, product terms, mixed-language phrases, punctuation, and background noise.

**Acceptance**:
1. Automatic language detection is the default; a supported language hint can be selected without requiring provider setup.
2. Speech is transcribed, not silently translated, rewritten, summarized, or interpreted as a tool instruction.
3. Silence and unintelligible recordings produce an understandable empty/failure state, not an invented message.
4. Technical vocabulary hints are optional and bounded; full private chat history is not sent just to improve recognition.

### US-07 — Understand readiness and failures (P0, first release)

As a user, I know when speech is available and how to recover when it fails.

**Independent test**: Exercise permission denial, unsupported device, missing service configuration, timeout, and exhausted allowance.

**Acceptance**:
1. There is no requirement for the user to paste an OpenAI key into their computer.
2. The composer shows accurate unavailable, requesting permission, recording, transcribing, ready, cancelled, and failed states.
3. Failure preserves the draft. Retry is deliberate and does not silently create repeated billable requests.
4. User errors are understandable and do not expose provider responses, credentials, or filesystem paths.

### US-08 — Understand recording and retention (P0, first release)

As a user, I know when my microphone is active and what is retained.

**Independent test**: Cancel before and after upload; inspect persisted application state and operational logs.

**Acceptance**:
1. Capture begins only after an explicit action. No hidden or automatic background recording occurs.
2. Matrix does not persist raw dictation audio by default. Temporary buffers are bounded and released on completion, cancellation, timeout, and shutdown.
3. Dictation text stays in the draft until ordinary Send. Operational records contain usage metadata, not audio or transcript text.
4. Product copy distinguishes Matrix retention from the upstream provider's applicable processing/retention terms; it does not promise unverified zero retention.

### US-09 — Change speech providers centrally (P0 architecture, first release)

As a platform operator, I can change the transcription provider/model without changing clients or distributing credentials.

**Independent test**: Run the same client against two test adapters and then a configured OpenAI adapter.

**Acceptance**:
1. Platform policy selects the provider, model, capability availability, and funding/limits.
2. Long-lived provider credentials remain in platform-controlled infrastructure, never client bundles, per-user VPS environment files, or owner home files.
3. Existing speech entry points use the same service. Legacy endpoints, if retained for compatibility, only delegate to it.
4. A provider change applies to new requests/sessions. Existing sessions retain their configuration until they end; they are not silently restarted with another provider.
5. Rejected or unsupported capabilities fail explicitly. A fallback cannot change provider/data-processing destination invisibly.

### US-10 — See live dictation (P1, follow-on enhancement)

As a user, I can see words while speaking and correct the final transcript before sending.

**Independent test**: Speak across several pauses, observe provisional text, stop, and compare the finalized draft.

**Acceptance**:
1. Provisional text is visibly distinct from finalized text and never becomes a submitted message by itself.
2. Provider revisions replace the relevant provisional segment, rather than append duplicates.
3. Cancel removes only this recording's pending text and preserves pre-existing draft content.
4. Live session failure preserves finalized segments and explains whether re-recording is necessary. It never presents a partial result as a complete transcript.
5. This enhancement is not a blocker for record → stop → transcribe. Showing partial text after Stop is a useful first enhancement, but is not called live dictation.

### US-11 — Interview me by voice (P2, later phase)

As a user, I can start an interview about an idea, answer follow-up questions, and turn it into an editable brief.

**Independent test**: Start an interview on Web Canvas and Electron Desktop, interrupt an answer, then finish and review a brief.

**Acceptance**:
1. Web Canvas, Web Desktop, and Electron Desktop offer the same entry point, transcript, mute, interrupt, end, and error behavior through shared presentation components.
2. The interview follows the chosen topic, asks follow-up questions, and tolerates pauses. The user can interrupt spoken playback.
3. Ending presents a reviewable summary/brief and an explicit save/start-work action.
4. Interview answers are not automatically promoted into identity or long-term memory; saving such facts is a deliberate action.
5. OpenAI and Grok are platform adapter candidates. Provider switching does not require a new interview UI. A new provider session may resume from confirmed text context, not assumed audio-state portability.

### US-12 — Ask the computer to act by voice (P2, later phase)

As a user, I can ask the computer to open an app or perform a task during a voice session.

**Independent test**: Request an allowed action, a denied action, and an action requiring approval while observing canonical chat activity.

**Acceptance**:
1. Voice requests use the same ownership, tool permissions, approvals, and execution state as typed requests.
2. Interview mode does not start work merely because the user describes an idea. Execution is a distinct intent.
3. A request that needs approval remains pending until the normal approval is given; spoken provider output cannot bypass that decision.
4. Tool requests have stable identities so retries/reconnections cannot execute them twice.
5. Progress and errors are visible in chat and the voice session. The voice model does not become a second independent execution engine.

### Edge Cases

- Permission resolves after cancellation; device removed mid-recording; another app owns the microphone.
- No speech, unsupported encoding, large recording, extremely long transcript, or upload cut off partway.
- User types, sends, navigates, signs out, or changes runtime while audio is in flight.
- A paid provider request succeeds but the response connection is lost; a retry must not invisibly double-charge/repeat it.
- Language changes mid-sentence; punctuation and names need correction; partial live transcripts revise prior text.
- User speaks over playback; an interrupted output must not continue playing from a queued audio buffer.
- Platform restart leaves a usage reservation uncertain; preserve its bounded hold for reconciliation rather than assume free usage.
- Native Mobile returns to a chat that completed in the background; replay cursor is missing or expired.

## Requirements

### Functional Requirements

- **FR-001**: Implement US-01–09 before enabling the first speech release, with US-04–05 tracked as a separately shippable mobile repair.
- **FR-002**: There is one platform speech service with capability-specific adapters for completed recording transcription, optional live transcription, and later voice conversation.
- **FR-003**: All active transcription entry points, including chat, channel voice notes, and the kernel transcription tool, delegate to that service. Remove redundant provider integrations after migration verification.
- **FR-004**: The initial transcription provider is OpenAI using a platform-held credential. End-user provider accounts and selected chat harnesses do not determine dictation availability.
- **FR-005**: Initial recording limits are proposed as 120 seconds and 10 MiB, enforced by the service as well as the client. Availability exposes effective limits. Longer imported recordings are explicitly unsupported until separately designed.
- **FR-006**: Every request/session is associated with an authenticated owner, computer, runtime, capability, and unique request identity.
- **FR-007**: Platform speech allowance and concurrency admission occur before provider work. Usage settlement is idempotent and based on verified usage, never solely client-claimed duration.
- **FR-008**: Speech credits/eligibility are an explicit capability policy. Do not infer eligibility from an unrelated chat model or accidentally require an Anthropic account to use OpenAI dictation.
- **FR-009**: Transcription is available independently of which chat harness is selected, while message sending continues to honor chat readiness.
- **FR-010**: Keyboard, screen-reader labels, microphone state, cancellation, and failure recovery are included on every applicable surface.
- **FR-011**: US-10 is an enhancement gated by device, latency, recovery, and metering validation. US-11–12 are later delivery phases using the same service boundaries.
- **FR-012**: Existing telephony and standalone text-to-speech must remain functional during migration; their STT dependencies must use the canonical service. They are not prerequisites for releasing chat dictation.
- **FR-013**: Maintain one source of truth for chat stream merging and terminal outcomes across clients; do not create a separate speech-specific chat ledger.

### Surface Scope

| Capability | Web Canvas | Web Desktop | Electron Desktop | Web Mobile | Native Mobile |
|---|---|---|---|---|---|
| Record/stop/transcribe | First release | First release | First release | Same shared chat feature | Follow-on native capture adapter |
| Live dictation | Enhancement | Enhancement | Enhancement | Where capture supported | Later native validation |
| Voice interview and actions | Later, required | Later, required | Later, required | Adapt after primary validation | Later |
| Chat streaming repair | Shared contract regression coverage | Shared contract regression coverage | Reference behavior | Shared contract regression coverage | First companion workstream |

Native Mobile microphone capture is explicitly outside the initial recording scope; the original Native Mobile request concerns reply streaming. Its future capture adapter must reuse the platform service and shared contracts.

### Key Entities

- **Speech capability policy**: enabled operations, operator-selected adapter/model, language/encoding support, effective limits, budget and readiness.
- **Dictation attempt**: request identity, owner/computer/runtime, destination draft generation, lifecycle, ephemeral audio and transcript.
- **Usage reservation**: bounded cost hold, operation/provider identity, settlement state, idempotency reference; no audio or transcript.
- **Voice session**: topic/mode, owner/computer, pinned provider configuration, transcript segments, audio state, tool requests, end reason.
- **Interview brief**: owner-controlled text produced for review and explicit save or task creation.

## Assumptions and Dependencies

- This document records a design, not a claim that live speech or platform funding is deployed.
- Platform operators provide and enable the transcription credential in platform infrastructure. No credential value is needed in this document.
- Speech is platform-funded within an explicit bounded allowance. Commercial pricing and allowance amounts remain operator policy; no new paid SKU or arbitrary customer charge is introduced by this specification.
- Existing owner-controlled chat/draft persistence is reused. Interviews require an explicit decision to save the final brief.
- API/model availability must be tested in the actual platform account before rollout. Documentation feasibility is not a live credential check.
- A separate public documentation PR in `FinnaAI/matrix-os-site`, under `content/docs/`, is a required implementation deliverable.
- The design intentionally supersedes the paused runtime-local transcription prototype. It must not be shipped unchanged.

## Success Criteria

- **SC-001**: All cancellation/navigation/draft-preservation acceptance scenarios pass on Web Canvas, Web Desktop, and Electron Desktop, with zero wrong-chat insertion or automatic sends.
- **SC-002**: A 30-second reference recording yields an editable final transcript within 5 seconds of Stop at p95 on the agreed healthy-network test setup. This is a release target to measure, not a provider guarantee.
- **SC-003**: Manual cancellation releases microphone tracks within one second; automated tests detect no remaining capture, timers, or playback after teardown.
- **SC-004**: Every active transcription caller uses the canonical service, and no platform speech key is present in generated runtime configuration or renderer assets.
- **SC-005**: The multilingual evaluation set has at least 30 consented/synthetic recordings spanning selected languages, mixed speech, and technical vocabulary. At least 90% need no correction that changes intended meaning; publish measured results before rollout.
- **SC-006**: Native Mobile matches final text and terminal state after every tested disconnect, replay gap, duplicate event, and background/foreground scenario; streamed updates do not regress visible text.
- **SC-007**: A provider adapter swap passes the same contract fixtures without UI changes. OpenAI/Grok live prototypes separately demonstrate interruption and one correctly authorized tool call before interview rollout.
- **SC-008**: No raw audio/transcript appears in platform operational logs, usage records, or analytics in the privacy validation suite.

## Technical Design and Evidence

See [research.md](research.md) for the current implementation inventory and provider feasibility, and [plan.md](plan.md) for service boundaries, endpoint authentication, migration, tests, and delivery phases.
