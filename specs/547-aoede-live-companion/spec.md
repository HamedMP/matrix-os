# Aoede: a live companion for Matrix OS

Status: native Gemini 3.8 Live development slice implemented; production policy and full app/Terminal acceptance remain gated. Research and provider spike checked 2026-10-05.

## Experience

Bring back the Aoede experience from `specs/066-vocal-voice-mode`: the desktop remains usable, an edge halo signals live voice, and readable serif captions show both sides of the conversation as they happen. Aoede is warm, curious, concise, and comfortable with silence. Ask one useful clarification when needed; act on clear instructions without a mandatory interview.

The user can interrupt, refer to what is open, find earlier conversations, open an app, work in Terminal, and ask for an app to be built through Chat. Long work continues while the conversation continues. Aoede reports verified outcomes, not guesses about what finished.

## Provider decision

Use **`gemini-3.8-live` with the Aoede voice**, as requested. Declare each tool `behavior: NON_BLOCKING`; dispatch bounded tool promises independently from media, and return results with `scheduling: WHEN_IDLE`. Omit `thinkingLevel`. Restore history through ordered `clientContent` with explicit user/model roles and `turnComplete: false`, so restoring context does not interrupt or trigger a response. Keep the voice transport replaceable while Matrix owns execution, permissions, history, and context. Add GPT-Live through client delegation after the initial spike; evaluate Grok against the same scenarios. This recommendation reflects the user's preferred existing experience and integration reuse, not an unmeasured voice-quality ranking.

| Option | Fit | Important constraint | Published voice pricing snapshot |
|---|---|---|---|
| Gemini Live | Existing Aoede integration; native audio, input/output transcripts, interruption, image input, custom functions | Gemini 3.8 Live supports async tools by default and result scheduling. The legacy 3.1 Flash Live model supports synchronous calls only. | Listed 3.8 Live/3.1 audio: $0.005/input audio minute and $0.018/output audio minute; text/context and other services extra. |
| GPT-Live 1 | Explicit full-duplex conversation and a separate backend agent; client delegation can retain Matrix's existing kernel | Delegation events contain IDs/timing, not the task text. Assemble intent from bounded transcripts and current application state. No native image/video input; screen understanding belongs in the delegated backend. | $0.05/session minute, billed per second; backend and tools extra. |
| Grok Speech-to-Speech | Native live voice, custom functions, transcripts and interruption; useful challenger | Implement the same Matrix task bridge. Evaluate language/code recognition, task updates, and supported residency before enabling. Published voice region is US East. | $0.08/minute plus $0.004/text input event; server VAD bills session duration. Tool-result exceptions apply. |

Pricing is not directly comparable: measure a reproducible 10-minute session including silence, overlapping speech, context updates, transcription, and builder costs. Do not enable a paid service or choose a new default from this preview alone.

Sources: [Gemini Live overview](https://ai.google.dev/gemini-api/docs/live-api), [tools and scheduling](https://ai.google.dev/gemini-api/docs/live-api/tools), [transcription](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [GPT-Live model](https://developers.openai.com/api/docs/models/gpt-live-1), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [Grok voice guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech), [Grok voice pricing](https://docs.x.ai/developers/models/speech-to-speech).

## Architecture and authority

```text
Microphone / playback / two live caption lanes
                    ↕
Shared voice-session coordinator → selected native Live adapter
                    ↕
Owner-scoped canonical Chat + kernel task broker
        ↙             ↓                 ↘
App builder       App / Terminal       Context retrieval
        ↘             ↓                 ↙
Verified task events → Chat + captions + spoken updates
```

Native Live handles speech and conversational timing. Matrix's gateway/kernel remains the sole action authority. Do not send every casual reply through a second STT → agent → TTS cycle; do journal normalized final conversation turns into canonical Chat. A provider function/delegation is an intent, never permission to execute arbitrary code.

Reuse the earlier presentation and audio plumbing (`VocalPanel`, `useVocalSession`, `vocal/ws-handler`, `onboarding/gemini-live`). Replace the old browser `chatRef.submitMessage`, `Chat.busy`, and app-list polling as action/progress authorities. A mounted Chat window must not be necessary for a build to run.

The current voice work in PR 2162 is a reference for canonical Chat integration. Reconcile against its final merged contracts before implementation; this spec does not change that PR or create a competing execution store.

## Requirements

| Capability | Required behavior |
|---|---|
| Live conversation | Explicit start; continuous streaming audio; interruption flushes queued playback. Stop/mute immediately stops capture. Ending voice leaves authorized background tasks running; cancel task is a separate explicit action. |
| Always-visible text | Separate user and assistant lanes show provisional chunks during speech, then final turns. Expandable history links to Chat. Preserve corrections and mark interrupted assistant output; do not treat unheard queued words as heard context. Text remains available with audio disabled. |
| App building | “Build me an app” creates one canonical Chat task, routed to the existing builder agent and `matrix-app-builder` skill. Open Chat to follow it. Speak useful verified progress; completion requires build/manifest validation and a real launcher-open check. Offer “Open app.” |
| Opening and using apps | Resolve installed app IDs through the existing launcher. Use typed, permission-checked app actions first. Let the user inspect the selected app/context. Unsupported app interactions explain the limitation and offer an available path. |
| Terminal | Attach to a real authorized Terminal session and show task/command scope. Existing permission policy governs command execution. Sensitive/destructive or externally consequential actions need the existing explicit approval flow. Do not grant an entire shell through a broad voice tool. |
| Previous chats and context | Owner/workspace-scoped search through canonical Chat retrieval; return bounded snippets with source links. Include the active app, selection, and task only as needed. Reauthorize sources on every read; never blend personal and org scopes. |
| Upcoming memory | Use the shared memory service when available: source attribution, explicit remember/correct/forget, export/delete. Until then show “Memory coming soon” and use chat retrieval. Preserve legacy vocal profile facts; propose a reviewed, explicit import rather than silently copying them or maintaining a second memory store. |
| Work while talking | Task events survive voice reconnect and app changes. Progress never invents a percentage or claims completion from client UI state. The user can ask about an existing task without restarting it. |
| Provider choice | One shared event/schema/action layer. Provider changes create a new voice session, restore bounded context, and retain task IDs. Unsupported features fail visibly; no silent STT/TTS substitution or unannounced provider switch. |

## Session and task contract

The existing voice envelope carries `session.state`, `companion.caption` (both speaker lanes, provisional/final/interrupted), `companion.task`, `companion.sources`, `companion.response.started`, `companion.capture.completed`, `response.audio`, `response.audio_end`, and `response.interrupted`. Canonical task details, approvals, and completion remain existing Chat events. Include owner scope, voice session ID, canonical chat ID, sequence and turn IDs; action events also include a durable task ID. Schemas are bounded Zod discriminated unions, not generic payload records.

Deduplicate effects with a durable unique key scoped to owner + conversation + semantic action ID. Map provider call/delegation IDs onto that action. Retries/reconnects select the existing task in a transaction; never repeat the effect merely because the provider has reissued a call. Incomplete user phrases cannot trigger irreversible actions. Persist intent/approval state before dispatch; reconcile accepted-but-not-dispatched work after restart.

Gemini/Grok: return a verified accepted task handle promptly, then inject bounded task facts using the selected model's supported update mechanism. GPT-Live: use `delegation.type=client`, assemble the request from timestamped transcript context, bind the delegation ID to the Matrix task, and return relevant updates. Spike later-update and interruption behavior before committing to these adapters.

Canonical final transcript/history and task state live in owner-controlled Postgres via Kysely. Provider session context is transient. Raw audio is not retained by Matrix by default. Transcript export/delete follows Chat; deletion invalidates retrieval caches and restored sessions.

## Presentation and surface parity

Restore a quiet edge halo and bottom serif captions; no modal that hides the OS. Use `@matrix-os/brand` tokens: forest #0E3422, deep forest #092417, paper #FCFCF8, gold #F1C379, coral #D06E53, blue #C5D6E2. Georgia/Instrument Serif carries the spoken text; the existing UI sans carries app chrome. The halo is the single expressive element. Captions get a contrast scrim and do not obscure interactive content.

Web Canvas, Web Desktop, and Electron Desktop share the same voice controls, captions, task semantics, context drawer, Chat handoff, and approvals. Surface adapters supply placement/navigation, never duplicate business logic. Validate Web Canvas, then Web Desktop, then Electron Desktop. Web Mobile and Native Mobile share transcript/history/tasks with adapted placement; native-device app automation requires its own platform bridge and is deferred explicitly, not represented as universally available.

“Any app” is a coverage goal: instrumented Matrix apps first; authorized desktop UI automation later through an existing scoped computer-use bridge. No global background screen recording, OS-wide access, or browser claim to control arbitrary native apps. Selected surface/app permission is visible and revocable.

## Auth, limits, and failure behavior

The native slice reuses canonical Chat voice tickets and the existing relayed WebSocket contract; it does not revive `/ws/vocal`. WebRTC needs a separately reviewed signaling contract.

| Boundary | Auth and scope | Public? |
|---|---|---|
| `GET /api/chats/:chatId/voice/capabilities` | Gateway principal, canonical Chat access and trusted capability policy. | No |
| `POST /api/chats/:chatId/voice/sessions`, `POST /api/chats/:chatId/voice/sessions/:sessionId/reconnect` | Gateway principal, owner Chat access, bounded body, session epoch and single-use transport ticket. | No |
| `DELETE /api/chats/:chatId/voice/sessions/:sessionId` | Gateway principal, bounded body, session ownership. | No |
| `GET /ws/chats/:chatId/voice/:sessionId` upgrade | Single-use short-lived transport ticket, bound owner/Chat/session/epoch and allowed origin. Reauthorize task reads/subscriptions. | No |
| Voice action/approval frames | Same authenticated socket; per-action schema, resource access and existing permission policy; approvals bound to exact action ID and arguments. | No |
| Existing Chat/build/Terminal/app services | Existing service auth and owner scope; server invokes them through typed injected dependencies, not forged browser requests. | No |
| Live provider connection | Server-held credential or scoped ephemeral credential; never ship long-lived keys. Provider config/account readiness comes from existing settings. | No |

Validate all path/app/task IDs and enums at boundaries. External setup/API calls time out after 10s; downloads after 30s. Initial limits: one active voice session per owner, 64KB control frames, 256KB audio frames, 256KB queued audio (backpressure/drop with visible recovery), 32KB provisional text per turn, 20 recent turns/16KB restored context, five retrieved snippets/8KB, three concurrent delegated tasks, 30-minute voice lease, 60s idle-connection TTL. Limits are configurable only within reviewed bounds.

Bound registries with cap/TTL eviction, stale subscriber sweep, isolated send failures, and shutdown drains. Close sockets/timers/audio devices on stop; only resource owners destroy shared DB pools. Provider disconnect stops playback and capture, shows Retry and keeps canonical tasks accessible. Log details server-side; return safe generic errors. No transcript/audio in analytics by default. Provider sessions require the configured policy, billing budget, and data-residency acceptance; do not infer funded access from a legacy Gemini key.

## Small delivery plan and acceptance

1. **Spike (tests first):** real selected Gemini model/Aoede availability; both caption streams; barge-in; accept-task + later progress while talking; reconnect dedup. Run identical GPT-Live/Grok scenarios with explicit test funding. Capture model IDs and SDK results; undocumented behavior remains gated until verified.
2. **Vertical slice:** shared coordinator plus Gemini adapter, restored halo/captions, canonical Chat history, builder delegation, task reattach, app launch, safe failures. Include Web Canvas/Web Desktop/Electron Desktop evidence.
3. **Context/actions:** previous-chat sources, existing typed app/Terminal tools and approvals. Add the shared memory-service adapter only after its contract ships.
4. **Provider expansion:** GPT-Live client delegation and Grok adapters after capability/evaluation gates. No automatic default swap.
5. **Release artifacts:** implementation PR from a manual worktree with required invariants and Greptile 5/5; separate public-safe docs PR in `FinnaAI/matrix-os-site/content/docs/` explaining voice, permissions, supported apps, and memory behavior.

Acceptance integration path: authenticated microphone session → live input captions → one canonical Chat builder task → verified build event → spoken/live text update → authorized launcher open. Repeat with Chat unmounted, voice stopped, reconnect, and duplicate provider events; exactly one app is built and task state remains readable. Rejected approvals cause no command/effect. Cross-owner chat/terminal/task IDs are denied. Expired credentials, provider startup failure, DB failure, transcript overflow, and dead subscribers fail safely.

Benchmark goals (not measured claims): p95 first caption under 500ms after provider chunk receipt, interruption stops audible playback under 200ms, first spoken acknowledgement under 1s after turn end, delegated-task acknowledgement under 1s excluding permission wait. Evaluate English/Swedish switching, names, code, overlapping speech, corrections and references to earlier chats. Report latency, task success, duplicate effects (must be zero), transcript accuracy, and actual end-to-end cost separately from subjective voice preference.

## Preview

`preview/` is a Vite + React interaction study using Matrix brand tokens and wallpaper. It simulates app building in Chat, source-linked context, terminal approval, live caption reveal, mute/end/rejoin, and opening the resulting app. It requests no microphone, connects to no provider, performs no real task, and writes no user data. Provider selection changes the displayed option only; this is not a voice comparison or proof that integration works.

## Development evidence and release gates

The real operator-funded transport spike connected to `gemini-3.8-live` with Aoede and a delayed NON_BLOCKING tool: 6 audio chunks, 2 output-caption chunks, 1 tool call, 3 completed turns, 1 interruption, and no provider errors. A separate run with Google's public PCM sample produced 20 audio chunks, 5 output-caption chunks, 1 input-caption chunk, 3 completed turns, 1 interruption, and no provider errors. No live microphone, real builder, real Terminal command, or launcher effect was exercised by these spikes. Do not infer voice quality or end-to-end latency from these counts.

A composed test uses the real canonical repository/orchestrator, ownership, transport tickets, outbox and admission paths; only external speech/execution models are substituted. An accepted supervised child Chat continues after voice ends, completes once, survives 22 subsequent conversation turns, and replays its admission without a second model invocation. This is durable task evidence, not a real app-build acceptance result.

Native development requires `MATRIX_AOEDE_NATIVE_LIVE=1`, a valid operator connection, and existing gateway machine/runtime identity. Requested native voice fails visibly without policy/configuration; production is closed even if a legacy Gemini key exists. Existing onboarding model selection is unaffected. One active native lease is allowed per owner; three unresolved task reservations are enforced under an owner advisory transaction lock. Failed-admission linked Chats retain their reservation for explicit retry/removal. Only three in-flight admissions are retained locally; durable admission owns replay and actual run state, including failed/cancelled terminal runs.

Task admission requires explicit `inputTranscription.finished === true`; a tool call, model output or `turnComplete` cannot finalize independently streamed input. Missing completion fails closed, and a later correction is retained. Model output does not rotate the user utterance; explicit input completion/interruption does. Input completion must be qualified on the exact model/endpoint before production.

Interrupted native output persists the acknowledged playback duration atomically as a status part beside the failed generated transcript. Restore includes an explicit playback note and excludes the unverified words. Duration alone cannot identify a heard word prefix. Exact partial-word restoration and real-provider finality/word-alignment qualification are deferred release gates in [#2174](https://github.com/HamedMP/matrix-os/issues/2174); this is the precise remaining scope of the partial-heard-context review finding. A fixed-public-text timing check failed before WebSocket setup with a network error, so it supplies no evidence about timestamp support.

The implementation is stacked on open PR #2162 (`feat/aoede-product-rebuild`). Root voice remains conversation-only; effects run in linked ordinary supervised Chats with the root's captured runnable route. Canonical source messages alone authorize instructions, never a provider-added prompt. End/mute/interruption do not cancel admitted tasks.

Production release still requires the selected owner funding/entitlement/residency policy, owner-budget admission and settlement if Matrix-funded, real microphone/barge-in evidence across Web Canvas/Web Desktop/Electron Desktop, actual builder + manifest + launcher acceptance, direct child approval/result projection, selected app context, and a real scoped Terminal attachment. Until those gates pass, public docs describe a development preview and do not advertise universal app or Terminal control. Provider expansion and shared memory remain deferred.

Large-file plan: server composition was extracted into `server/canonical-voice.ts` before adding native registration. Further voice dispatch behavior should extract native session dispatch from `voice-session/session-pipeline.ts`; further child-task controls should extract a linked-task controller from `ui/aoede/controller.ts` before adding behavior.

Selected API source: [Google Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [Google async tool use](https://ai.google.dev/gemini-api/docs/live-api/tools).
