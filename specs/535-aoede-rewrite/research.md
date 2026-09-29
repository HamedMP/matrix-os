# Aoede Rewrite Research

**Date**: 2026-09-29
**Scope**: Product UX, realtime voice architecture, ElevenLabs UI primitives, current Matrix ownership boundaries, and local development strategy.

## Decision 1: Voice is a mode of canonical Chat

**Decision**: Aoede attaches to exactly one canonical Matrix Chat. The Chat repository, event journal, tool activity, approvals, and operation records remain durable truth. Voice transport, playback queues, provisional transcripts, and animated presentation are ephemeral projections.

**Rationale**:

- ChatGPT, Gemini, and Claude preserve voice and text in one thread; this is more understandable than a separate voice conversation.
- Matrix already has durable canonical Chat records, event replay, provider-neutral runs, approvals, and cross-surface presentation.
- The existing Aoede duplicates transcript, memory, delegation, and progress state and therefore cannot reliably reconcile with Chat.
- Matrix's constitutional model requires one headless authority shared by every shell.

**Alternatives considered**:

- **Keep Aoede standalone and improve its overlay**: smaller change, but preserves split memory, actions, transcript, and recovery.
- **Use an ElevenLabs hosted widget as the product**: fast demonstration, but provider-specific, web-only, difficult to audit, and disconnected from canonical Matrix actions.

## Decision 2: Compose the primary experience around Matrix's canonical agent

**Decision**: The primary architecture uses streaming speech recognition and synthesis around the existing canonical Chat run. The canonical Matrix agent remains the reasoning and tool authority. A native speech-to-speech provider may be used only through a compatibility adapter that proves equivalent canonical transcript, tool, approval, cancellation, and recovery behavior.

**Rationale**:

- A provider-owned speech-to-speech agent can respond quickly, but it becomes a second agent with its own context, tool execution, memory, and failure semantics.
- Streaming transcript admission into canonical Chat followed by streamed synthesis preserves the same model selection, project context, tools, approvals, and durable run state as typed Chat.
- Sentence- or clause-level synthesis can begin before the full response completes, preserving a low-latency feel without surrendering action authority.
- The architecture can still use direct provider media where a narrowly scoped adapter supports it; transport optimization does not become durable ownership.
- Current Claude and Hermes canonical adapters resume native provider sessions. Those checkpoints can retain a full assistant response even when Matrix later marks part unheard, so delivery-aware checkpoint invalidation/reconstruction is a canonical prerequisite rather than a voice-only context filter.

**Alternatives considered**:

- **Provider-native speech-to-speech as the default**: best theoretical latency, but duplicates the Matrix kernel unless every provider event and tool request is converted into canonical state.
- **Batch transcription then ordinary Chat**: safest integration but too slow and does not support natural interruption.
- **Keep Gemini Live as the permanent brain**: preserves current work but locks Aoede to one provider and the existing parallel behavior.

## Decision 3: Use a server-owned session engine with transport adapters

**Decision**: The Gateway owns a bounded voice session engine. It coordinates turns, current transport epoch, transcript finalization, canonical run admission, synthesis, played-audio accounting, interruption, reconnection, budgets, and shutdown. Provider adapters expose explicit capabilities instead of leaking provider-native events into clients.

**Rationale**:

- WebRTC offers strong browser media behavior; WebSocket is still required for Gemini compatibility, deterministic simulation, telephony-like relays, or providers without direct WebRTC.
- RFC 6455 does not provide application replay, recovery, or bounded backpressure; Matrix must own those policies.
- Provider session resumption differs materially: Gemini exposes resumable handles, while other providers do not guarantee equivalent transport-transparent recovery.
- A monotonically increasing transport epoch prevents late audio, transcript, and tool events from an obsolete connection mutating the active session.

**Transport policy**:

- Use a Gateway-relayed transport as the initial path across supported surfaces, including packaged Electron, so authentication, CSP, metering, budgets, and cancellation stay under Matrix control.
- Consider direct WebRTC only as a later capability-gated optimization when an evaluated adapter proves constrained ephemeral credentials, narrow signaling/origins, revocation, usage control, and the trusted Matrix control channel.
- Keep media and control ordering explicit; never assume separate channels share total ordering.
- Bound every audio/event queue and define drop, pause, or fail behavior.

## Decision 4: Treat interruption as a first-class consistency boundary

**Decision**: Matrix records generated, delivered, played, and interrupted assistant output separately. On barge-in it stops local playback, cancels generation, invalidates queued audio, records the played boundary, fences late events, and cancels only safely interruptible tools.

**Rationale**:

- A generated transcript may include words the user never heard.
- OpenAI's WebSocket flow requires clients to cancel and truncate from their playback position; Gemini tells clients to discard queued audio after interruption; LiveKit similarly truncates effective history.
- Existing Aoede does not have a durable played-audio ledger or reliable late-event fencing.
- Existing canonical run activities cannot be appended after a run becomes terminal, while synthesis commonly outlives generation. Voice therefore needs a dedicated idempotent canonical delivery record rather than a late ordinary run activity.
- A single terminal write is insufficient: a crash before that write would make fully heard, partly heard, unheard, and acknowledgement-lost indistinguishable. Persist pending before playback and acknowledged whole-segment boundaries during playback; unknown remains conservative after crash.

**Alternatives considered**:

- **Store the provider's final transcript as heard history**: simple but incorrect after interruption.
- **Stop local sound only**: leaves provider generation and late events alive and can corrupt the next turn.

## Decision 5: Route every action through canonical operations and approvals

**Decision**: Voice never executes a provider tool directly. It proposes a canonical Matrix action with stable identity and exact normalized arguments. Canonical Chat must first gain argument-digest-bound approval, enforceable pre-execution policy, idempotency/reconciliation identity, and truthful cancellation capabilities where they are absent. Voice fails closed for unsupported harness/tool combinations; it does not create a parallel approval system.

**Rationale**:

- Voice recognition increases ambiguity; action previews must be more explicit, not less.
- The existing Aoede infers build completion from Chat busy state and newly appearing apps, which can report false success or failure.
- Durable action states are needed to distinguish failed, cancelled, and outcome-unknown results after reconnect.
- Current canonical approval projections do not bind a normalized argument digest, generic cancellation stops a whole run rather than an individual tool, and Hermes full-access/yolo behavior cannot provide these guarantees. These are prerequisites, not existing universal capabilities.

**Tool lifecycle**:

`proposed → approval_pending → approved → running → succeeded | failed | cancelled | outcome_unknown`

Approval binds to tool identity, schema version, and canonical arguments. Any mutation invalidates it.

## Decision 6: Build Matrix-owned UI; selectively adapt ElevenLabs patterns

**Decision**: Matrix owns the voice session provider, status, controls, transcript, tool activity, approvals, errors, and device settings. Reuse the existing Matrix waveform and conversation presentation. Selectively adapt MIT-licensed ElevenLabs patterns only where they improve implementation quality.

**Adopt or adapt**:

- MicSelector device enumeration and device-change lifecycle patterns.
- Sticky conversation scrolling if it improves the existing transcript.
- Scrubber or waveform algorithms when Matrix needs playback review.
- The audio-reactive orb concept as optional supplementary presentation, with lazy loading, reduced-motion/static fallback, and a textual state beside it.

**Do not adopt unchanged**:

- Hosted conversational widget.
- `ConversationBar`, which is provider-coupled, has documentation/source drift, can create duplicate microphone streams, and lacks coherent recovery and approval UI.
- Provider-specific `Message`/`Response` primitives, because canonical Chat already supports richer roles, tools, approvals, and safe rendering.
- Microphone-owning waveform wrappers, because capture must have one owner.

**Licensing**: ElevenLabs UI is MIT licensed. Any vendored source must preserve attribution and license requirements.

## Decision 7: Make literal state and persistent controls the UX foundation

**Decision**: The surface always pairs any animation with literal state text. It keeps Mute/Hold, Stop speaking, End, and push-to-talk available when relevant. Tool names and approvals appear visually in Chat rather than being conveyed only through speech.

**Benchmark evidence**:

- Gemini Live's Hold/resume, captions, interruption control, visual results, and action undo are strong productivity patterns.
- Claude's hands-free plus push-to-talk fallback provides a practical noisy-environment recovery path.
- Copilot Vision's selected-window scope and persistent sharing outline are safer than invisible or whole-screen context.
- Sesame and Hume demonstrate strong turn timing, pauses, and backchannels, but emotional inference and companion-style pseudo-intimacy are inappropriate defaults for Matrix productivity work.

**Avoid**:

- Orb-only status.
- Hidden capability differences between similarly named voice modes.
- Automatic consequential actions inferred from casual speech.
- Unrequested emotion diagnosis.
- Whole-screen sharing by default.
- Filler speech that fabricates progress.

## Decision 8: Replace voice-only memory with canonical owner-controlled memory

**Decision**: `system/vocal-profile.json` is not carried forward as a voice-specific authority. Existing facts require an explicit migration policy before removal; new memory proposals use Matrix's inspectable, editable, exportable, and deletable memory model. Session-only mode creates no new durable memory outside visible Chat content and bounded operational metadata.

**Rationale**:

- Current voice memory is silent, difficult to inspect, and disconnected from normal Matrix ownership.
- Voice transcripts and inferred facts can contain bystander speech or recognition errors.
- Matrix data must remain owner-controlled and portable.
- Session-only is not enforceable as a voice request flag or prompt instruction. It requires an immutable policy on canonical turn admission, queued/steered turns, provider adapters, memory tools, native checkpoints, and provider retention. Routes unable to enforce it must not advertise it.

## Decision 9: Use a deterministic simulator as the default development loop

**Decision**: Implement a database-free UI/reducer fixture plus a deterministic canonical integration harness. The latter supplies fake speech/media, canonical harness, catalog, policy/funding, approvals/input, and virtual time, and uses PGlite where suitable. Disposable real PostgreSQL remains required for locking, concurrency, ticket-consumption, and crash recovery tests. None require provider credentials, QEMU, or OrbStack.

**Rationale**:

- `dev:full` has a large memory and startup cost and is unsuitable for ordinary UI/state iteration.
- Real realtime providers are non-deterministic and costly; they cannot be the base of correctness tests.
- Existing `dev:speech` fixtures prove the repository accepts fixture-driven speech workflows, but they currently target transcription rather than conversation.

**Validation layers**:

1. Database-free UI/reducer fixture.
2. Adapter contract fixtures with virtual audio/time and fake canonical harness/catalog/policy.
3. Canonical integration with PGlite where transactional behavior is representative.
4. Disposable PostgreSQL concurrency, ticket, and crash suites.
5. Optional real-provider smoke and conformance tests.
6. One production-parity run with bundle reuse before release.

## Decision 9A: Canonical admission owns ordering and busy behavior

**Decision**: Provider finalization is an observation, not ordering authority. Each captured turn receives a local monotonic order and provider item identity. Final text is immutable at one boundary and is admitted using canonical revision, selection, interaction, permission, memory, queue, and steering rules. Reordered/duplicate finals are reconciled by identity; post-admission corrections update presentation provenance but never create a second executable turn.

**Rationale**:

- Canonical Chat rejects stale revisions and ordinary send while an active run exists unless the caller deliberately queues or steers.
- Typed input can race speech and must share the same admission serializer rather than a voice-only fast path.
- OpenAI's official realtime transcription guidance states completion events across turns are not guaranteed to arrive in order.

## Decision 9B: Electron defaults to relayed media

**Decision**: Gateway-relayed media is the initial Electron transport. Direct WebRTC remains a capability-gated optimization until packaged CSP, narrowly scoped provider origins/signaling, trusted Matrix control, ephemeral credential revocation, budget enforcement, devices, suspend/resume, and network changes are proven.

**Rationale**:

- Packaged Electron currently limits `connect-src` to self and the configured Gateway origin/WebSocket equivalents.
- Broad provider-origin allowances would violate the repository's CSP guidance.
- Direct media can weaken active-session metering/control unless the Matrix control path is independently proven.

## Decision 10: Provider selection is an evidence gate, not a design-system choice

**Decision**: Keep the hidden legacy Gemini Live path unchanged only until the canonical replacement reaches parity; do not import its second-agent behavior into the new engine. Benchmark OpenAI Realtime, Gemini Live, and ElevenLabs' component services against the same Matrix conformance scenarios before selecting the general-availability route. Gemini qualifies as a new adapter only if it can preserve the canonical-agent and action invariants. ElevenLabs UI quality does not determine the speech provider.

**Evaluation criteria**:

- End-of-turn and barge-in quality.
- First-audio and recovery latency.
- Streaming transcript correction quality.
- Synthesis naturalness and controllability.
- Cancellation and reconnect semantics.
- Ephemeral credential and regional/privacy support.
- Verified usage/cost reporting.
- Web/Electron/mobile support and upstream stability.

## Authoritative sources

### Product and UX

- OpenAI ChatGPT Voice: https://help.openai.com/en/articles/20001274-chatgpt-voice
- Google Gemini Live: https://support.google.com/gemini/answer/15274899
- Microsoft Copilot Voice: https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-voice-with-microsoft-copilot
- Microsoft Copilot Vision: https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-vision-with-microsoft-copilot
- Anthropic Claude Voice: https://support.claude.com/en/articles/11101966-use-voice-mode
- Sesame voice research: https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice
- Hume EVI overview: https://dev.hume.ai/docs/speech-to-speech-evi/overview

### Realtime architecture

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime transcription ordering: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI WebSocket: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI VAD: https://developers.openai.com/api/docs/guides/realtime-vad
- Google Gemini Live: https://ai.google.dev/gemini-api/docs/live-api
- Google Live session management: https://ai.google.dev/gemini-api/docs/live-api/session-management
- ElevenLabs React SDK: https://elevenlabs.io/docs/eleven-agents/libraries/react
- ElevenLabs conversation flow: https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow
- LiveKit session logic: https://docs.livekit.io/agents/logic/sessions
- LiveKit turn handling: https://docs.livekit.io/agents/logic/turns
- WebRTC Recommendation: https://www.w3.org/TR/webrtc/
- WebSocket protocol: https://www.rfc-editor.org/rfc/rfc6455

### ElevenLabs UI

- Component catalog: https://ui.elevenlabs.io/docs/components
- Source registry: https://github.com/elevenlabs/ui
- MIT license: https://github.com/elevenlabs/ui/blob/main/LICENSE.md
- Agent blocks: https://ui.elevenlabs.io/blocks/agents
- Hosted widget: https://elevenlabs.io/docs/eleven-agents/customization/widget

## Relevant upstream issue evidence

These are implementation signals rather than normative specifications. They justify pinning adapter versions and running interruption/reconnect conformance tests:

- OpenAI Agents false truncation without interruption: https://github.com/openai/openai-agents-python/issues/2370
- Google ADK Live timeout: https://github.com/google/adk-python/issues/3035
- Google ADK resumption failure: https://github.com/google/adk-python/issues/4140
- Google ADK intermittent clean closure: https://github.com/google/adk-python/issues/4587
- ElevenLabs React Native WebRTC mismatch: https://github.com/elevenlabs/packages/issues/515
- ElevenLabs React Native WebSocket disconnect: https://github.com/elevenlabs/packages/issues/605
- ElevenLabs second iOS call silent microphone: https://github.com/elevenlabs/packages/issues/991
- LiveKit ElevenLabs STT reconnect failure: https://github.com/livekit/agents/issues/4609
- LiveKit Gemini interruption stall: https://github.com/livekit/agents/issues/3914
- LiveKit OpenAI cancellation receive-loop failure: https://github.com/livekit/agents/issues/4488
- LiveKit zero-length interruption truncation: https://github.com/livekit/agents/issues/6157
- LiveKit interruption/cancellation race: https://github.com/livekit/agents/issues/5642
- LiveKit tool interruption deadlock: https://github.com/livekit/agents/issues/4413

## Verified facts versus validation still required

### Verified from repository and current documentation

- Canonical Chat already owns durable messages, run activity, approvals, event replay, and cross-surface presentation.
- Current managed Platform Speech supports transcription, status, and cancellation, not full duplex playback.
- Gemini Live is the only existing full-duplex Matrix path, behind a platform proxy.
- Current Aoede uses a parallel Gateway handler, shell protocol, voice-only profile, and inferred delegation progress.
- ElevenLabs UI is an MIT shadcn-style source registry rather than a stable runtime design-system package.
- `dev:full` is unnecessary for deterministic component and session-engine testing.

### Must be validated by implementation spikes

- Which provider combination meets Matrix latency, quality, cost, privacy, and recovery thresholds.
- Whether direct WebRTC can qualify as a later optimization beyond the initial Gateway-relayed general-availability path.
- Exact provider retention and regional behavior for the production account.
- Packaged Electron microphone, output-device, suspend/resume, and network-transition behavior.
- Browser support for selected input/output device control across supported surfaces.
- Whether current canonical provider runs can stream text at a cadence suitable for clause-level synthesis without contract extension.
