# Speech consolidation research

Date: 2026-09-10. Baseline: fetched `origin/main` at `d80d821b2`. Findings concern repository wiring, not live production credentials or observed device behavior.

## Existing paths and migration disposition

| Existing path | Finding | Disposition |
|---|---|---|
| `packages/gateway/src/voice.ts` | Separate ElevenLabs STT/TTS service with its own config and cost estimates | Remove its direct STT implementation; migrate retained TTS behavior behind a single capability adapter when needed |
| `packages/gateway/src/voice/index.ts`, `voice/stt/whisper.ts` | Another voice service, selecting Whisper from runtime config/environment | Replace runtime provider construction with the managed speech client; migrate useful provider tests into the platform adapter |
| `packages/gateway/src/voice/routes.ts`, `voice/voice-ws.ts` | REST STT route factory and a voice flow that transcribes, dispatches to the kernel, and synthesizes a response; not registered in the current server bootstrap | Retire dead wiring. If an older supported client needs an alias, forward to canonical operations; never auto-dispatch dictation |
| `packages/kernel/src/ipc-server.ts`, tool `transcribe` | A third direct transcription call to ElevenLabs, reading runtime credentials and owner audio files | Extract the tool into a focused module, inject managed transcription at registration, validate owner-relative paths, preserve normal tool permissions |
| `packages/gateway/src/voice/channel-voice.ts`, `channels/telegram.ts` | Channel voice-note helper accepts an injected STT provider; adapter has `setVoiceContext`, but no call was found in current server bootstrap | Reuse channel preprocessing and inject canonical speech client. Add a registration-to-transcription test; do not claim currently enabled Telegram transcription |
| `shell/src/hooks/useVoice.ts`, `components/ChatApp.tsx` | Chat microphone uses the unregistered `/ws/voice` flow; final text replaces draft content | Replace with shared dictation controller and ordinary manual Send |
| `shell/src/components/ai-elements/speech-input.tsx` | Browser speech-recognition component exists, no external caller found | Remove unused direct browser transcription or make it a facade over the shared service; no independent browser-provider fallback |
| `packages/platform/src/voice-env.ts` | Helper can emit OpenAI/ElevenLabs keys into managed runtime env; current provisioning use was not established | Remove platform transcription-key propagation and test generated configuration; preserve unrelated owner-supplied credentials and telephony behavior |
| `packages/platform/src/gemini-live-proxy.ts` | Platform-held Gemini key and internal runtime proxy already exist | Migrate into the common speech-session service as a compatibility provider adapter; retire provider-specific route after consumers migrate |
| `packages/gateway/src/onboarding/gemini-live.ts`, `onboarding/ws-handler.ts`, `vocal/ws-handler.ts` | Shared Gemini transport but provider-coupled orchestration/protocol; `/ws/vocal` is registered | Keep onboarding/interview purpose-specific workflows, use the same capability/session engine and normalized events |
| `shell/src/hooks/useVocalSession.ts`, `components/VocalPanel.tsx` | Existing Web voice capture/playback and overlay, including a PCM worklet and delegation to chat | Extract reusable capture/playback and presentation. Validate Web Canvas parent-overlay wiring; add shared Electron Desktop presentation rather than duplicate the hook |
| `packages/proxy/src/funded-relay*.ts`, platform funded policy/metering | Existing managed AI admission, reservations and settlement; relay payload/model code is Anthropic text-specific | Reuse funding invariants and repositories, explicitly add speech capabilities/usage units; do not proxy audio through the Anthropic Messages implementation |
| Native Mobile canonical chat event source/detail query | Legacy metadata WebSocket and frequent snapshot polling; misses replay-gap handling; current HTTP stream supports content frames | Share content merge/recovery. Spike native HTTP streaming versus versioned WebSocket support before choosing transport |

The paused experimental implementation adds another runtime-local Whisper route. It is not the desired consolidation and is not part of this specification's release deliverable.

## Provider feasibility

### OpenAI

The current [file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) recommends `gpt-transcribe` for new general-purpose file transcription. It supports returning partial transcript events after an already-recorded file is submitted. The existing `whisper-1` implementation does not support that streaming mode. Proposed evaluation candidate: `gpt-transcribe`, with model selection retained in platform policy and verified using the actual account.

The [realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription) documents transcription-only sessions, incremental and finalized transcript events, and `gpt-live-transcribe`. It distinguishes microphone transcription from spoken assistant responses. Therefore live dictation is technically feasible but has a different audio/session lifecycle from uploaded recordings.

These are documentation findings, not completed integration spikes. Do not reuse Whisper-specific response-format or audio assumptions without checking the chosen model contract.

### Grok

The [speech-to-speech guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) documents realtime audio and tool use. It describes compatibility with OpenAI's event style but also event-name differences. An explicit adapter is required; changing only the URL/model is insufficient.

[Ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens) permit short-lived client connections without distributing the long-lived provider key. A short token lifetime alone does not establish enforceable limits for an already-open session; session control and usage verification still need a spike.

### Recommendation

One logical service, three capabilities: file transcription, live transcription, and voice conversation. Implement the OpenAI file adapter first. Evaluate streamed text after Stop as a small enhancement. Validate open-microphone transcription separately. Add OpenAI/Grok realtime conversation adapters for interviews without changing the client-facing lifecycle or tool authorization contract.

## Questions resolved by the user

- Credential ownership: platform, not per-user runtime.
- First release: record → stop → transcribe, editable before Send.
- Live dictation: desirable if feasible, not a blocker.
- Future direction: live interview and computer actions, with OpenAI or Grok selected at platform level.
- Consolidation: all old transcription paths must converge on one service.
- Previously proposed user stories: accepted.

## Validation still needed before implementation rollout

- Real platform account model access, pricing version, latency and usage response; no credential was read or tested for this research.
- Native Mobile's exact reported streaming symptom on a device, including fresh auth and foreground recovery.
- Supported recording formats on packaged Electron/macOS, Chromium, Safari, and Web Mobile.
- Provider live-session shutdown, interruption and verified usage; test direct WebRTC plus server control against platform-relayed WebSocket.
- Explicit bounded speech allowance defaults from operator policy; do not invent commercial prices.

## Deep self-review

[implementation.md](implementation.md) records source-backed gaps and their design corrections. In particular, the existing funded start receipt is replayable, the wallet is machine-scoped, the legacy channel helper persists owner audio before STT, and the mobile transport lifetime omits user identity from its effect dependencies. These details require explicit changes rather than direct reuse. The OpenAI file and realtime transcription guides were rechecked during review; no live provider call was made.
