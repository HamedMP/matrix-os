# 046: Voice -- Implementation Plan

## Phase A: Voice Core (types, TTS, STT, audio utils)

Foundation layer. All other phases depend on this.

### A1: Types and interfaces

Adapt OpenClaw's type system to Matrix OS conventions. Define all shared types in a single `types.ts`.

**New files:**
- `packages/gateway/src/voice/types.ts`
- `packages/gateway/src/voice/providers/base.ts`
- `packages/gateway/src/voice/tts/base.ts`
- `packages/gateway/src/voice/stt/base.ts`

**Tests:**
- `tests/gateway/voice/types.test.ts` (Zod schema validation, state transition validation)

### A2: Audio conversion utilities

Pure TypeScript audio processing adapted from OpenClaw's `telephony-audio.ts`. No native dependencies.

**New files:**
- `packages/gateway/src/voice/audio/convert.ts` (PCM <-> mu-law, resampling)
- `packages/gateway/src/voice/audio/chunking.ts` (20ms frame chunking)

**Tests:**
- `tests/gateway/voice/audio/convert.test.ts` (round-trip PCM/mu-law, resampling accuracy, edge cases)

### A3: TTS providers + fallback chain

Three TTS providers behind a common interface, wired into a fallback chain with circuit breakers.

**New files:**
- `packages/gateway/src/voice/tts/elevenlabs.ts`
- `packages/gateway/src/voice/tts/openai.ts`
- `packages/gateway/src/voice/tts/edge-tts.ts`
- `packages/gateway/src/voice/tts/fallback.ts`

**Tests:**
- `tests/gateway/voice/tts/fallback.test.ts` (chain ordering, circuit breaker, timeout, recovery)

### A4: STT provider (Whisper)

OpenAI Whisper API client behind the SttProvider interface.

**New files:**
- `packages/gateway/src/voice/stt/whisper.ts`

**Tests:**
- `tests/gateway/voice/stt/whisper.test.ts` (transcription, language detection, error handling)

### A5: VoiceService entry point

Lifecycle management: initializes TTS/STT services from config, exposes them to gateway.

**New files:**
- `packages/gateway/src/voice/index.ts`

**Modified:**
- `packages/gateway/src/server.ts` (create and start VoiceService)
- `home/system/config.json` (add voice config section)

**Checkpoint:** `bun run test` passes. VoiceService starts with mock/no-key config. TTS fallback chain works with Edge TTS (no API key needed).

---

## Phase B: Shell Voice (mic button, recording, playback)

Browser-side voice UI. Depends on Phase A (needs TTS/STT services running in gateway).

### B1: useVoice hook

Browser mic recording via MediaRecorder, audio playback via Web Audio API.

**New files:**
- `shell/src/hooks/useVoice.ts`

**Tests:**
- `tests/shell/voice.test.ts` (state transitions, mock MediaRecorder)

### B2: VoiceButton + InputBar integration

Mic button in InputBar. Press to record, release to send.

**New files:**
- `shell/src/components/VoiceButton.tsx`

**Modified:**
- `shell/src/components/InputBar.tsx` (add VoiceButton)

### B3: Voice WebSocket messages

Add voice message types to existing `/ws` WebSocket. Client sends audio, server returns transcription + TTS audio.

**Modified:**
- `packages/gateway/src/server.ts` (handle `voice` message type on main WS)

### B4: Voice message rendering

Voice messages in ChatPanel show audio player + transcript.

**Modified:**
- `shell/src/components/ChatPanel.tsx` (voice message rendering)

**Checkpoint:** Click mic, speak, see transcription in chat, hear AI response spoken back. Voice disabled gracefully when no TTS key.

---

## Phase C: Telephony (CallManager, Twilio, webhooks)

Phone call infrastructure. Depends on Phase A. Can run in parallel with Phase B.

### C1: CallManager state machine

Core call lifecycle management adapted from OpenClaw's `manager.ts`. Handles state transitions, transcript tracking, conversation loop, timers.

**New files:**
- `packages/gateway/src/voice/call-manager.ts`

**Tests:**
- `tests/gateway/voice/call-manager.test.ts` (~25 tests: full lifecycle, invalid transitions, timers, concurrent calls, conversation loop, error recovery)

### C2: CallStore (JSONL persistence)

Append-only call log. Active call rehydration on restart.

**New files:**
- `packages/gateway/src/voice/call-store.ts`
- `home/system/voice/calls.jsonl`

**Tests:**
- `tests/gateway/voice/call-store.test.ts` (append, query, rehydrate, stale cleanup)

### C3: Mock provider

Testing-only provider that simulates Twilio's call lifecycle without API calls.

**New files:**
- `packages/gateway/src/voice/providers/mock.ts`

**Tests:**
- `tests/gateway/voice/providers/mock.test.ts` (full lifecycle simulation)

### C4: Twilio provider

Production Twilio integration: TwiML generation, HMAC-SHA1 webhook verification, Media Streams support.

**New files:**
- `packages/gateway/src/voice/providers/twilio.ts`

**Tests:**
- `tests/gateway/voice/providers/twilio.test.ts` (~15 tests: TwiML generation, signature verification, event parsing, call initiation, hangup, error handling)

### C5: Webhook router

Hono routes for `/voice/webhook/:provider`. Signature verification, event parsing, dispatch to CallManager.

**New files:**
- `packages/gateway/src/voice/webhook.ts`

**Tests:**
- `tests/gateway/voice/webhook.test.ts` (routing, signature valid/invalid, replay dedup, rate limiting)

### C6: Response generator

AI response generation during conversation-mode calls. Uses dispatcher to invoke kernel.

**New files:**
- `packages/gateway/src/voice/response-generator.ts`

### C7: Voice IPC tools

Add `speak`, `transcribe`, `call` tools to kernel IPC server.

**Modified:**
- `packages/kernel/src/ipc-server.ts`

**Tests:**
- `tests/kernel/voice-tools.test.ts` (~12 tests: each tool action, error cases, active call detection)

### C8: Voice REST endpoints

`/api/voice/health`, `/api/voice/calls`, `/api/voice/tts`, `/api/voice/stt`.

**Modified:**
- `packages/gateway/src/server.ts` (mount voice API routes)

**Checkpoint:** Outbound call works end-to-end with mock provider. Twilio webhook signature verification passes. CallManager handles full lifecycle. IPC tools functional. `bun run test` passes.

---

## Phase D: Platform Integration (managed mode, provisioning)

Zero-config voice for users. Depends on Phase C.

### D1: Twilio number provisioning

Platform allocates phone numbers from a Twilio pool on user creation. Stores number + SID mapping in platform DB.

**Modified:**
- `packages/platform/src/orchestrator.ts` (provision voice on user create)

### D2: Env var injection

Platform injects `TWILIO_*`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` into user gateway containers.

**Modified:**
- `packages/platform/src/orchestrator.ts` (env injection on container start)

### D3: Webhook URL configuration

Platform configures Twilio webhook URL to `https://{handle}.matrix-os.com/voice/webhook/twilio` using existing Cloudflare Tunnel subdomain.

### D4: Tunnel provider interface

Interface for future tunnel providers. Cloudflare Tunnel integration (leverages existing per-user tunnel).

**New files:**
- `packages/gateway/src/voice/tunnel/base.ts`
- `packages/gateway/src/voice/tunnel/cloudflare.ts`

### D5: Usage tracking

Voice usage (TTS chars, STT minutes, call minutes) tracked in JSONL. Platform aggregates for billing.

**Modified:**
- `packages/gateway/src/voice/index.ts` (usage logging on every TTS/STT/call action)

### D6: Voice knowledge file

AI knowledge file so the kernel understands voice capabilities and can guide users.

**New files:**
- `home/agents/knowledge/voice.md`

**Checkpoint:** New user provisioned via platform -> voice works immediately. No manual Twilio setup needed. Usage tracked.

---

## Phase E: Channel Voice Notes

Voice note handling for messaging channels. Depends on Phase A. Can run in parallel with B, C, D.

### E1: Telegram voice notes

Download OGG voice files, auto-transcribe with Whisper, dispatch text + audio path to kernel.

**Modified:**
- `packages/gateway/src/channels/telegram.ts`

### E2: Generic channel voice handling

Shared utility for channel adapters to download + transcribe voice notes.

**New files:**
- `packages/gateway/src/voice/channel-voice.ts`

**Checkpoint:** Send voice note in Telegram -> auto-transcribed -> kernel responds. Audio saved to ~/data/audio/.

---

## Dependency Graph

```
Phase A (core) ─┬─> Phase B (shell voice)
                ├─> Phase C (telephony) ──> Phase D (platform)
                └─> Phase E (channel voice notes)
```

A is prerequisite for everything. B, C, E are independent after A. D requires C. F requires A + audio infrastructure port.

## Phase F: Voice Conversation Mode (TODO)

Full duplex voice conversation with the AI agent. Two engines behind a common UI.

### F1: Audio infrastructure port

Port AudioCapture, AudioPlayback, pcm-encoder.worklet.js from finna-discovery. Provider-agnostic audio layer.

**New files:**
- `shell/src/lib/voice/audio-capture.ts`
- `shell/src/lib/voice/audio-playback.ts`
- `shell/public/pcm-encoder.worklet.js`
- `shell/src/components/ui/live-waveform.tsx`
- `shell/src/components/ui/audio-level-bars.tsx`

### F2: Kernel-routed voice conversation

useVoiceConversation hook: AudioCapture -> gateway STT -> kernel dispatch -> TTS -> AudioPlayback. Client-side VAD for auto-send. Auto-listen after AI response.

**New files:**
- `shell/src/hooks/useVoiceConversation.ts`
- `shell/src/components/VoiceConversation.tsx` (replaces current VoiceMode.tsx)

**Modified:**
- `packages/gateway/src/server.ts` (streaming voice WS mode)

### F3: Gemini Live quick voice (optional)

GeminiLiveClient adapted from finna-discovery. Direct WebSocket to Gemini Live API. Ephemeral token endpoint in gateway.

**New files:**
- `shell/src/lib/voice/gemini-live-client.ts`
- `shell/src/hooks/useGeminiVoice.ts`

**Modified:**
- `packages/gateway/src/server.ts` (Gemini token endpoint)

### F4: UX polish

Long-press mic for conversation mode, command palette entry, keyboard shortcuts, voice settings UI.

**Checkpoint:** Voice conversation works end-to-end with kernel agent. Orb shows correct states. Audio clean. Transcript auto-scrolls. Gemini Live mode toggleable.

---

## Estimated Test Count

| Phase | Tests | Status |
|-------|-------|--------|
| A: Core | 180 | DONE |
| B: Shell | 54 | DONE |
| C: Telephony | 95 | DONE |
| D: Platform | 42 | DONE |
| E: Channels | 18 | DONE |
| F: Voice Conversation | ~40 | TODO |
| **Total** | **~430** | |

**Actual tests as of Phase A-E: 2522 (580 new voice tests)**
