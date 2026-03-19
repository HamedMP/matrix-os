# 046: Voice Tasks

**Task range**: T1300-T1349
**Parallel**: YES -- Phases B, C, E are independent after Phase A completes.
**Deps**: Phase A: none. Phase B: A. Phase C: A. Phase D: C. Phase E: A.

---

## Phase A: Voice Core

### T1300: Types, interfaces, Zod schemas

Tests first:
- [ ] T1300a [P] Write `tests/gateway/voice/types.test.ts`:
  - CallState enum validation (all 14 states)
  - NormalizedEvent discriminated union validation (all 10 event types)
  - CallRecord schema validation (required + optional fields)
  - E164 phone number regex validation (+1234567890 valid, "abc" invalid)
  - VoiceConfig schema validation with defaults
  - State transition validation (valid transitions accepted, invalid rejected)

Implementation:
- [ ] T1300b Create `packages/gateway/src/voice/types.ts`:
  - Adapt OpenClaw types: ProviderName, CallState, CallMode, EndReason
  - NormalizedEvent discriminated union
  - CallRecord with transcript, processedEventIds
  - WebhookContext, InitiateCallInput, HangupCallInput, PlayTtsInput
  - StartListeningInput, StopListeningInput, GetCallStatusInput/Result
  - VoiceConfig Zod schema with defaults
  - E164 Zod schema
  - VALID_TRANSITIONS map for state machine validation

- [ ] T1300c Create `packages/gateway/src/voice/providers/base.ts`:
  - VoiceCallProvider interface (from OpenClaw)

- [ ] T1300d Create `packages/gateway/src/voice/tts/base.ts`:
  - TtsProvider interface: synthesize(), isAvailable()
  - TtsOptions: voice, model, format
  - TtsResult: audio Buffer, format, sampleRate, durationMs, provider

- [ ] T1300e Create `packages/gateway/src/voice/stt/base.ts`:
  - SttProvider interface: transcribe(), isAvailable()
  - SttOptions: language, model
  - SttResult: text, language, durationMs, confidence

### T1301: Audio conversion utilities

Tests first:
- [ ] T1301a [P] Write `tests/gateway/voice/audio/convert.test.ts`:
  - PCM to mu-law conversion (known sample -> expected output)
  - mu-law to PCM conversion (round-trip accuracy within 1 LSB)
  - Resampling 44100Hz -> 8000Hz (length correct, no artifacts)
  - Resampling 16000Hz -> 8000Hz
  - Resampling 8000Hz -> 8000Hz (passthrough)
  - Edge cases: empty buffer, single sample, very large buffer
  - Frame chunking: 160-sample frames at 8kHz (20ms)
  - Chunking remainder handling (last frame padded or dropped)

Implementation:
- [ ] T1301b Create `packages/gateway/src/voice/audio/convert.ts`:
  - `pcmToMulaw(pcm: Buffer, bitDepth?: number): Buffer` -- ITU G.711 mu-law encoding
  - `mulawToPcm(mulaw: Buffer): Buffer` -- mu-law decoding to 16-bit PCM
  - `resample(pcm: Buffer, fromRate: number, toRate: number): Buffer` -- linear interpolation
  - `convertToTelephony(pcm: Buffer, sampleRate: number): Buffer` -- resample to 8kHz + mu-law
  - Adapted from OpenClaw telephony-audio.ts (pure TypeScript, no native deps)

- [ ] T1301c Create `packages/gateway/src/voice/audio/chunking.ts`:
  - `chunkAudio(audio: Buffer, frameSizeMs: number, sampleRate: number): Buffer[]`
  - Default: 20ms frames (160 samples at 8kHz)
  - `reassemble(chunks: Buffer[]): Buffer`

### T1302: TTS providers + fallback chain

Tests first:
- [ ] T1302a [P] Write `tests/gateway/voice/tts/fallback.test.ts`:
  - FallbackTtsChain tries providers in order (ElevenLabs -> OpenAI -> EdgeTTS)
  - First provider succeeds -> returns result, others not called
  - First provider fails -> second tried
  - All providers fail -> throws with combined error info
  - Circuit breaker: 3 failures -> provider skipped for 60s
  - Circuit breaker recovery: after 60s, provider retried
  - Provider timeout (5s default, configurable)
  - isAvailable() false -> provider skipped (no API key configured)
  - Usage tracking callback called with provider + cost on success
  - Empty text input -> throws validation error

Implementation:
- [ ] T1302b Create `packages/gateway/src/voice/tts/elevenlabs.ts`:
  - `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
  - Headers: `xi-api-key`, `Content-Type: application/json`
  - Body: `{ text, model_id, voice_settings? }`
  - Returns MP3 audio buffer
  - isAvailable(): checks ELEVENLABS_API_KEY env var or config
  - Configurable: voiceId, model (eleven_turbo_v2_5 default)

- [ ] T1302c Create `packages/gateway/src/voice/tts/openai.ts`:
  - `POST https://api.openai.com/v1/audio/speech`
  - Headers: `Authorization: Bearer {key}`
  - Body: `{ model: "tts-1", input: text, voice: "alloy", response_format: "mp3" }`
  - Returns MP3 audio buffer
  - isAvailable(): checks OPENAI_API_KEY env var or config

- [ ] T1302d Create `packages/gateway/src/voice/tts/edge-tts.ts`:
  - Uses `node-edge-tts` package (free Microsoft Edge TTS, no API key)
  - Default voice: `en-US-AriaNeural`
  - Returns MP3 audio buffer
  - isAvailable(): always true (no key needed)

- [ ] T1302e Create `packages/gateway/src/voice/tts/fallback.ts`:
  - FallbackTtsChain class
  - Constructor: `providers: TtsProvider[]`, `options: { timeoutMs, circuitBreakerThreshold, circuitBreakerResetMs }`
  - `synthesize(text, options)`: try each provider in order, skip unavailable/circuit-broken
  - Circuit breaker state per provider: `{ failures: number, openUntil: number }`
  - `getStatus()`: returns provider health map (available, circuit state, last error)

- [ ] T1302f Add `node-edge-tts` to `packages/gateway/package.json`

### T1303: STT provider (Whisper)

Tests first:
- [ ] T1303a [P] Write `tests/gateway/voice/stt/whisper.test.ts`:
  - Transcribe audio buffer (mock Whisper API response)
  - Language detection (returns ISO 639-1 code)
  - Handle API errors (rate limit 429, auth 401, server 500)
  - Timeout handling (30s default)
  - isAvailable() checks OPENAI_API_KEY
  - Large file handling (25MB Whisper limit -- chunk or reject)
  - Supports WebM, OGG, MP3, WAV, M4A input formats

Implementation:
- [ ] T1303b Create `packages/gateway/src/voice/stt/whisper.ts`:
  - `POST https://api.openai.com/v1/audio/transcriptions`
  - Multipart form: `file` (audio), `model` ("whisper-1"), `language` (optional hint)
  - Returns `{ text, language }`
  - File size validation (reject > 25MB with clear error)
  - isAvailable(): checks OPENAI_API_KEY env var or config

### T1304: VoiceService entry point + gateway wiring

- [ ] T1304a Create `packages/gateway/src/voice/index.ts`:
  - VoiceService class: `start(config, dispatcher)`, `stop()`, `health()`
  - Initializes TtsService (FallbackTtsChain from config)
  - Initializes SttService (Whisper from config)
  - Exposes `tts`, `stt` for use by other gateway components
  - Graceful degradation: if no API keys, voice disabled with clear log message
  - Config from `~/system/config.json` voice section + env var overrides

- [ ] T1304b Modify `packages/gateway/src/server.ts`:
  - Create VoiceService on startup, pass config
  - Start VoiceService after gateway ready
  - Stop VoiceService on shutdown
  - No new routes yet (added in later tasks)

- [ ] T1304c Modify `home/system/config.json`:
  - Add `"voice": { "enabled": true, "tts": { "provider": "auto" }, "stt": { "provider": "whisper" }, "telephony": { "mode": "managed" } }`

**Phase A Checkpoint:** `bun run test` passes. VoiceService starts. TTS fallback works with Edge TTS (no keys). Audio conversion round-trips correctly.

---

## Phase B: Shell Voice

### T1305: useVoice hook

Tests first:
- [ ] T1305a [P] Write `tests/shell/voice.test.ts`:
  - startRecording() requests mic permission, creates MediaRecorder
  - stopRecording() stops recording, returns audio Blob
  - playAudio(buffer) creates AudioContext, decodes, plays
  - isRecording state toggles correctly
  - isPlaying state toggles correctly
  - Error handling: mic permission denied -> clear error state
  - Cleanup: unmount stops active recording/playback

Implementation:
- [ ] T1305b Create `shell/src/hooks/useVoice.ts`:
  - `startRecording()`: `navigator.mediaDevices.getUserMedia({ audio: true })`, create MediaRecorder (WebM/Opus)
  - `stopRecording()`: stop recorder, collect chunks into Blob, return ArrayBuffer
  - `playAudio(buffer: ArrayBuffer)`: AudioContext.decodeAudioData -> createBufferSource -> connect -> start
  - State: `isRecording`, `isPlaying`, `error`
  - Cleanup on unmount

### T1306: VoiceButton component + InputBar

- [ ] T1306a Create `shell/src/components/VoiceButton.tsx`:
  - Mic icon (lucide MicIcon)
  - Press-and-hold: start recording, show pulsing animation
  - Release: stop recording, return audio
  - Toggle mode alternative: tap to start, tap to stop
  - Visual states: idle, recording (pulse), processing (spinner)
  - Disabled state when voice not enabled

- [ ] T1306b Modify `shell/src/components/InputBar.tsx`:
  - Add VoiceButton next to send button
  - On voice recorded: send `{ type: "voice", audio }` over WebSocket
  - Show "Transcribing..." placeholder while waiting for transcription
  - On transcription received: display text in chat

### T1307: Voice WebSocket messages

- [ ] T1307a Modify `packages/gateway/src/server.ts`:
  - Handle `type: "voice"` messages on main `/ws`
  - Receive binary audio -> call SttService.transcribe()
  - Send `{ type: "voice_transcription", text }` back to client
  - Dispatch transcript to kernel as normal message (source: "voice")
  - On kernel response: if voice mode, call TtsService.synthesize()
  - Send `{ type: "voice_audio", audio }` back to client

### T1308: Voice message rendering in ChatPanel

- [ ] T1308a Modify `shell/src/components/ChatPanel.tsx`:
  - Detect voice messages (source: "voice" metadata)
  - Render audio player component (play/pause, duration, waveform placeholder)
  - Show transcript text below audio player
  - AI voice responses: show text + audio player

**Phase B Checkpoint:** Click mic, speak, see transcription, hear AI response. Works end-to-end through shell.

---

## Phase C: Telephony

### T1309: CallManager state machine

Tests first:
- [ ] T1309a [P] Write `tests/gateway/voice/call-manager.test.ts`:
  - initiateCall() creates CallRecord in "initiated" state
  - processEvent("call.ringing") transitions initiated -> ringing
  - processEvent("call.answered") transitions ringing -> answered -> active
  - processEvent("call.ended") transitions any -> terminal state
  - Invalid transition (e.g., ringing -> speaking) throws/rejects
  - Max concurrent calls enforced (6th call rejected when limit is 5)
  - Max duration timer fires -> auto-hangup
  - Silence timeout fires -> auto-hangup
  - Idempotent: duplicate event ID ignored
  - Conversation mode: speech event -> generate response -> speak -> listen
  - Notify mode: answered -> speak greeting -> wait -> hangup
  - getCall(callId) returns current CallRecord
  - getActiveCalls() returns all non-terminal calls
  - Call transcript accumulates speaker entries
  - endCall(callId) sends hangup to provider
  - Provider call ID mapping (providerCallId -> callId lookup)
  - Rehydrate from CallStore on startup
  - Stale call reaper cleans up after staleCallReaperSeconds
  - Error during provider call -> state transitions to "error"

Implementation:
- [ ] T1309b Create `packages/gateway/src/voice/call-manager.ts`:
  - CallManager class
  - `activeCalls: Map<string, CallRecord>`
  - `providerCallIdMap: Map<string, string>`
  - `maxDurationTimers: Map<string, NodeJS.Timeout>`
  - `silenceTimers: Map<string, NodeJS.Timeout>`
  - `initialize(provider, callStore, config)`: load active calls from store, verify with provider
  - `initiateCall(to, options)`: validate limits, create record, call provider.initiateCall()
  - `processEvent(callId, event)`: validate transition, update state, trigger side effects
  - `endCall(callId)`: call provider.hangupCall(), transition to hangup-bot
  - `speak(callId, text)`: call provider.playTts()
  - `getCall(callId)`, `getActiveCalls()`
  - Conversation loop: on speech event -> responseGenerator -> speak -> startListening
  - Timers: max duration, silence timeout
  - Stale reaper: setInterval checks for stuck calls
  - Adapted from OpenClaw manager.ts

### T1310: CallStore (JSONL persistence)

Tests first:
- [ ] T1310a [P] Write `tests/gateway/voice/call-store.test.ts`:
  - append(callRecord) writes to JSONL file
  - getAll() reads and parses all records
  - getActive() returns only non-terminal state records
  - getById(callId) returns specific record
  - update(callId, partial) updates in-place (rewrite line)
  - File created on first write if not exists
  - Handles corrupted lines gracefully (skip, log warning)
  - getRecent(limit) returns last N calls

Implementation:
- [ ] T1310b Create `packages/gateway/src/voice/call-store.ts`:
  - CallStore class
  - JSONL append-only at `~/system/voice/calls.jsonl`
  - `append(record)`: appendFile with JSON.stringify + newline
  - `getAll()`: read file, parse lines, skip invalid
  - `getActive()`: filter non-terminal states
  - `update(callId, partial)`: read all, find, merge, rewrite file
  - `getRecent(limit)`: last N records

- [ ] T1310c Create `home/system/voice/calls.jsonl` (empty template)

### T1311: Mock provider

Tests first:
- [ ] T1311a [P] Write `tests/gateway/voice/providers/mock.test.ts`:
  - initiateCall() returns mock callId
  - Simulates lifecycle: initiated -> ringing -> answered -> active
  - playTts() succeeds silently
  - startListening/stopListening() succeed silently
  - hangupCall() transitions to ended
  - getCallStatus() returns current mock state
  - verifyWebhook() always passes
  - parseWebhookEvent() returns provided mock events

Implementation:
- [ ] T1311b Create `packages/gateway/src/voice/providers/mock.ts`:
  - MockProvider implements VoiceCallProvider
  - Simulates call lifecycle with configurable delays
  - Records all method calls for test assertions
  - Can inject mock events for webhook testing

### T1312: Twilio provider

Tests first:
- [ ] T1312a [P] Write `tests/gateway/voice/providers/twilio.test.ts`:
  - verifyWebhook(): valid HMAC-SHA1 signature passes
  - verifyWebhook(): invalid signature rejected
  - verifyWebhook(): reconstructs URL from forwarding headers
  - parseWebhookEvent(): maps Twilio StatusCallback to NormalizedEvent
  - parseWebhookEvent(): handles all Twilio call statuses (queued, ringing, in-progress, completed, busy, no-answer, canceled, failed)
  - initiateCall(): constructs correct Twilio API request
  - initiateCall(): includes TwiML callback URL
  - hangupCall(): calls Twilio REST API to end call
  - playTts(): generates TwiML <Say> or streams audio
  - TwiML generation for notify mode (Say + Hangup)
  - TwiML generation for conversation mode (Gather + Say)
  - Error handling: Twilio API errors (401, 404, 429, 500)
  - fromNumber validation (E.164 format)

Implementation:
- [ ] T1312b Create `packages/gateway/src/voice/providers/twilio.ts`:
  - TwilioProvider implements VoiceCallProvider
  - Config: accountSid, authToken, fromNumber (from env vars or config)
  - `initiateCall()`: `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json`
  - `hangupCall()`: `POST .../Calls/{sid}.json` with Status=completed
  - `verifyWebhook()`: HMAC-SHA1(authToken, url + sorted params)
  - `parseWebhookEvent()`: map CallStatus/CallSid/Direction to NormalizedEvent
  - `playTts()`: generate TwiML with <Say> verb or <Play> for audio URL
  - `startListening()`: TwiML <Gather input="speech"> with webhook
  - `getCallStatus()`: `GET .../Calls/{sid}.json`
  - URL reconstruction from X-Forwarded-* headers for webhook verification
  - Adapted from OpenClaw twilio.ts

### T1313: Webhook router

Tests first:
- [ ] T1313a [P] Write `tests/gateway/voice/webhook.test.ts`:
  - POST /voice/webhook/twilio routes to Twilio provider
  - POST /voice/webhook/unknown returns 404
  - Invalid signature returns 403
  - Valid signature + valid event -> dispatched to CallManager
  - Duplicate event ID -> 200 OK but no processing (idempotent)
  - Request body > 1MB -> 413 rejected
  - Rate limiting: > 100 req/min from same IP -> 429

Implementation:
- [ ] T1313b Create `packages/gateway/src/voice/webhook.ts`:
  - Hono router with `/voice/webhook/:provider` route
  - Lookup provider by name
  - Call provider.verifyWebhook() -> 403 on failure
  - Call provider.parseWebhookEvent() -> NormalizedEvent
  - Call callManager.processEvent() with normalized event
  - Return provider-specific response (TwiML for Twilio, JSON for Telnyx)
  - Body size limit middleware (1MB)
  - Rate limiting middleware

### T1314: Response generator

- [ ] T1314a Create `packages/gateway/src/voice/response-generator.ts`:
  - `generateVoiceResponse(params)`: called by CallManager during conversation loop
  - Params: callId, callerNumber, transcript, latestUserMessage
  - Creates session key: `voice:{normalizedPhone}`
  - Dispatches to kernel via gateway dispatcher
  - Adds voice-specific system context (keep responses brief, conversational)
  - Returns response text
  - Timeout: 30s (configurable), falls back to "I'm still thinking..."
  - Adapted from OpenClaw response-generator.ts

### T1315: Voice IPC tools (speak, transcribe, call)

Tests first:
- [ ] T1315a [P] Write `tests/kernel/voice-tools.test.ts`:
  - speak({ text: "Hello" }) returns audioUrl + durationMs
  - speak({ text: "Hello", provider: "edge" }) forces specific provider
  - speak() with empty text returns error
  - transcribe({ filePath: "audio.webm" }) returns text + language
  - transcribe() with non-existent file returns error
  - call({ action: "initiate", to: "+1234567890" }) returns callId
  - call({ action: "initiate" }) without `to` returns error
  - call({ action: "speak", callId: "abc", message: "Hi" }) speaks into call
  - call({ action: "hangup", callId: "abc" }) ends call
  - call({ action: "status", callId: "abc" }) returns call state
  - call({ action: "status", callId: "nonexistent" }) returns error
  - Voice disabled -> all tools return "Voice not enabled" error

Implementation:
- [ ] T1315b Modify `packages/kernel/src/ipc-server.ts`:
  - Add `speak` tool: calls VoiceService.tts.synthesize(), saves to ~/data/audio/{id}.mp3
  - Add `transcribe` tool: reads file, calls VoiceService.stt.transcribe()
  - Add `call` tool: delegates to CallManager (initiate/speak/hangup/status)
  - Tools check VoiceService availability before proceeding
  - During active call, `speak` pipes audio to call instead of saving file

### T1316: Voice REST endpoints

- [ ] T1316a Modify `packages/gateway/src/server.ts`:
  - Mount webhook router at `/voice/webhook`
  - `GET /api/voice/health`: returns { enabled, tts: { providers, activeProvider }, stt: { provider }, telephony: { provider, connected } }
  - `GET /api/voice/calls`: returns recent calls from CallStore (last 50)
  - `GET /api/voice/calls/:id`: returns specific call record + transcript
  - `POST /api/voice/tts`: REST TTS endpoint ({ text, voice?, provider? } -> audio file URL)
  - `POST /api/voice/stt`: REST STT endpoint (multipart audio -> { text, language })
  - All endpoints behind auth middleware

**Phase C Checkpoint:** Full call lifecycle with mock provider. Twilio webhook verification. IPC tools work. REST endpoints functional. `bun run test` passes.

---

## Phase D: Platform Integration

### T1317: Twilio number provisioning

- [ ] T1317a Modify `packages/platform/src/orchestrator.ts`:
  - On user provisioning: call Twilio API to allocate phone number from pool
  - `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json`
  - Store number + SID in platform DB (new column on users table)
  - Configure webhook URL: `https://{handle}.matrix-os.com/voice/webhook/twilio`
  - On user deletion: release phone number back to pool
  - Graceful: if Twilio provisioning fails, user still created (voice disabled)

### T1318: Env var injection for managed mode

- [ ] T1318a Modify `packages/platform/src/orchestrator.ts`:
  - On container start: inject TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
  - Also inject shared ELEVENLABS_API_KEY, OPENAI_API_KEY for TTS/STT
  - Keys stored in platform config/secrets (not user filesystem)
  - BYOP mode: skip injection, gateway reads from user's config.json

### T1319: Tunnel integration

- [ ] T1319a Create `packages/gateway/src/voice/tunnel/base.ts`:
  - TunnelProvider interface: start(), stop(), health()
  - TunnelConfig type: provider name, credentials

- [ ] T1319b Create `packages/gateway/src/voice/tunnel/cloudflare.ts`:
  - CloudflareTunnel implements TunnelProvider
  - For managed mode: no-op (tunnel already exists per-user via platform)
  - For BYOP/local dev: optional cloudflared sidecar management
  - health(): verify tunnel connectivity

### T1320: Usage tracking

- [ ] T1320a Voice usage logging in VoiceService:
  - On TTS: log { action: "tts", provider, chars, cost, durationMs }
  - On STT: log { action: "stt", provider, durationMs, cost }
  - On call: log { action: "call", provider, durationMs, cost, direction }
  - Written to ~/system/logs/voice-usage.jsonl
  - Cost estimation per provider (ElevenLabs: ~$0.30/1K chars, Whisper: ~$0.006/min, Twilio: ~$0.02/min)

### T1321: Voice knowledge file

- [ ] T1321a Create `home/agents/knowledge/voice.md`:
  - Documents voice capabilities for the AI
  - How to use speak, transcribe, call tools
  - Voice config options
  - Troubleshooting (no API key, provider down)

**Phase D Checkpoint:** New user gets voice automatically. Usage tracked. Platform manages everything.

---

## Phase E: Channel Voice Notes

### T1322: Channel voice note utility

- [ ] T1322a Create `packages/gateway/src/voice/channel-voice.ts`:
  - `handleVoiceNote(audioUrl, channel, metadata)`:
    1. Download audio from channel-provided URL
    2. Save to `~/data/audio/{channel}-{timestamp}.{ext}`
    3. Transcribe via SttService
    4. Return { filePath, transcript, durationMs }
  - Handles OGG (Telegram), M4A (WhatsApp), WebM (Discord)
  - File size limit check before download (10MB max)

### T1323: Telegram voice note handling

- [ ] T1323a Modify `packages/gateway/src/channels/telegram.ts`:
  - Detect voice messages (message.voice) and audio messages (message.audio)
  - Download file via Telegram Bot API: getFile() -> download
  - Call handleVoiceNote() utility
  - Dispatch to kernel with text transcript + audio path in metadata
  - If STT fails: dispatch with "[Voice message - transcription failed]" + audio path

**Phase E Checkpoint:** Send Telegram voice note -> auto-transcribed -> kernel responds.

---

## Phase F: Voice Conversation Mode (Future)

### Analysis: Real-Time Voice Architecture

Matrix OS needs two voice modes with distinct architectures:

**Mode 1: Transcribe-only (DONE)** -- Mic transcribes, fills input, user sends manually. Uses Whisper STT. No auto-reply audio.

**Mode 2: Voice conversation** -- Full duplex voice conversation with the AI agent. This is the complex one. Options analyzed:

| Approach | Latency | Uses Kernel | Tools/Skills/Memory | Status |
|----------|---------|-------------|---------------------|--------|
| Gemini Live | ~200ms | No (bypasses kernel) | No | Available now |
| OpenAI Realtime | ~300ms | No (bypasses kernel) | No | Available now |
| Custom pipeline (STT -> Kernel -> TTS) | ~2-3s | Yes | Yes | Built (Phase A-E) |
| Anthropic Voice API | ~200ms (est.) | Yes (native) | Yes | Not yet released |

**Decision: Custom pipeline as default, Gemini Live as optional "quick voice".**

Gemini Live gives the best voice UX (instant, natural, barge-in) but bypasses the Claude kernel entirely. The user would talk to Gemini, not their Matrix OS agent with SOUL, skills, memory, tools, and file system. This is unacceptable as the default.

The custom pipeline (Whisper -> kernel dispatch -> ElevenLabs TTS) is slower but routes through the actual kernel agent. When Anthropic ships their real-time voice API, it replaces the pipeline with native Claude voice at real-time latency.

**Recommended architecture:**
1. **Default voice mode**: Custom pipeline with improved UX (AudioWorklet, client-side VAD, streaming TTS)
2. **Quick voice mode** (optional): Gemini Live for casual conversation without kernel tools
3. **Endgame**: Anthropic real-time voice API when available (same kernel, real-time latency)

### Audio Infrastructure (port from finna-discovery)

Port the production-grade audio layer from `~/dev/finna/finna-discovery/packages/voice-interview/`:
- `AudioCapture` -- Web Audio API + AudioWorklet for real-time PCM encoding (16kHz)
- `AudioPlayback` -- Queue-based playback with lookahead scheduling (24kHz)
- `pcm-encoder.worklet.js` -- AudioWorklet processor (separate thread, no main-thread jank)
- Client-side VAD using AnalyserNode RMS level detection
- These are provider-agnostic and work with any backend

Also port UI components:
- `Orb` -- Already installed (ElevenLabs UI). Wire `agentState` + volume refs properly.
- `LiveWaveform` -- Real-time frequency visualization for mic preview
- `AudioLevelBars` -- VU meter visualization
- `Conversation` -- Auto-scrolling transcript display

### T1330: Port audio infrastructure from finna-discovery

- [ ] T1330a Copy and adapt `AudioCapture.ts` to `shell/src/lib/voice/audio-capture.ts`
  - Web Audio API + AudioWorklet
  - Mic with echo cancellation, noise suppression, auto gain
  - 16kHz PCM16 encoding in AudioWorklet thread
  - Audio level monitoring via AnalyserNode RMS
  - Device selection support
- [ ] T1330b Copy and adapt `AudioPlayback.ts` to `shell/src/lib/voice/audio-playback.ts`
  - Queue-based scheduling with lookahead
  - Base64 PCM -> Float32 -> AudioBuffer
  - 24kHz output, GainNode volume control
  - Interrupt support (clear queue on barge-in)
- [ ] T1330c Copy `pcm-encoder.worklet.js` to `shell/public/pcm-encoder.worklet.js`
  - Float32 -> Int16 -> Base64 encoding
  - 50ms chunk buffering
  - RMS level calculation
- [ ] T1330d Port `LiveWaveform` component to `shell/src/components/ui/live-waveform.tsx`
- [ ] T1330e Port `AudioLevelBars` component to `shell/src/components/ui/audio-level-bars.tsx`

### T1331: Voice conversation mode (kernel-routed)

- [ ] T1331a Create `shell/src/hooks/useVoiceConversation.ts`:
  - State machine: idle -> connecting -> active -> completed/error
  - Uses AudioCapture for mic input
  - Uses AudioPlayback for TTS output
  - Sends audio chunks to gateway `/ws/voice` for STT
  - Receives transcription -> dispatches to kernel
  - Receives kernel response -> sends to TTS -> plays audio
  - Client-side VAD: detect silence (configurable threshold) -> auto-send
  - Transcript management (merge consecutive segments from same speaker)
  - Auto-listen after AI finishes speaking (conversation loop)
- [ ] T1331b Create `shell/src/components/VoiceConversation.tsx`:
  - Fullscreen overlay (replaces current VoiceMode.tsx)
  - Orb with proper agentState (listening/thinking/talking) + volume refs
  - LiveWaveform for mic preview
  - Auto-scrolling transcript panel
  - Controls: mute, end conversation
  - Status indicators (connected, duration timer)
- [ ] T1331c Modify gateway `/ws/voice` to support streaming mode:
  - Accept continuous audio chunks (not just single recording)
  - Stream STT results back as partials
  - Stream TTS audio chunks back (not wait for full synthesis)

### T1332: Gemini Live quick voice mode (optional)

- [ ] T1332a Create `shell/src/lib/voice/gemini-live-client.ts`:
  - Adapt from finna-discovery's GeminiLiveClient
  - WebSocket to Gemini Live API
  - Bidirectional audio streaming (16kHz in, 24kHz out)
  - Input/output transcription
  - VAD with configurable silence duration
  - Barge-in support
- [ ] T1332b Add Gemini token endpoint to gateway:
  - `POST /api/voice/gemini-token` -> ephemeral token via Google GenAI SDK
  - Requires `GOOGLE_API_KEY` env var
  - Token: 5 uses, 30 min expiry
- [ ] T1332c Create `shell/src/hooks/useGeminiVoice.ts`:
  - Wraps GeminiLiveClient + AudioCapture + AudioPlayback
  - Same interface as useVoiceConversation (agentState, transcript, start/end)
  - System prompt injected from kernel SOUL + active conversation context
- [ ] T1332d Add mode toggle in VoiceConversation UI:
  - Default: kernel-routed (shows "Matrix OS" label)
  - Quick: Gemini Live (shows "Quick Voice" label)
  - Configurable default in ~/system/config.json

### T1333: UX polish

- [ ] T1333a Mic button behavior:
  - Default: transcribe-only, fill input, user sends manually (DONE)
  - Long-press (>500ms): enter voice conversation mode directly
- [ ] T1333b Voice conversation entry points:
  - AudioLines button in InputBar (DONE)
  - Command palette: "Start voice conversation"
  - Keyboard shortcut: Cmd+Shift+V
- [ ] T1333c Voice settings in Settings UI:
  - Default voice mode (transcribe / conversation)
  - Default conversation engine (kernel / gemini)
  - TTS voice selection (ElevenLabs voice picker)
  - VAD sensitivity slider
  - Auto-speak responses toggle

---

**Phase F Checkpoint:** Voice conversation works end-to-end with kernel agent. Orb shows correct states. Audio is clean with no echo/feedback. Transcript auto-scrolls. Gemini Live mode available as optional toggle.

---

**Phase F Checkpoint:** Send Telegram voice note -> auto-transcribed -> kernel responds.

---

## Summary

| Task | Description | Phase | Deps |
|------|-------------|-------|------|
| T1300 | Types, interfaces, Zod schemas | A | - |
| T1301 | Audio conversion utilities | A | - |
| T1302 | TTS providers + fallback chain | A | T1300 |
| T1303 | STT provider (Whisper) | A | T1300 |
| T1304 | VoiceService + gateway wiring | A | T1302, T1303 |
| T1305 | useVoice hook | B | T1304 |
| T1306 | VoiceButton + InputBar | B | T1305 |
| T1307 | Voice WebSocket messages | B | T1304, T1306 |
| T1308 | Voice message rendering | B | T1307 |
| T1309 | CallManager state machine | C | T1300 |
| T1310 | CallStore (JSONL) | C | T1300 |
| T1311 | Mock provider | C | T1300 |
| T1312 | Twilio provider | C | T1300 |
| T1313 | Webhook router | C | T1309, T1312 |
| T1314 | Response generator | C | T1309 |
| T1315 | Voice IPC tools | C | T1304, T1309 |
| T1316 | Voice REST endpoints | C | T1309, T1310, T1313 |
| T1317 | Twilio number provisioning | D | T1312 |
| T1318 | Env var injection | D | T1317 |
| T1319 | Tunnel integration | D | T1313 |
| T1320 | Usage tracking | D | T1304 |
| T1321 | Voice knowledge file | D | - |
| T1322 | Channel voice note utility | E | T1303 |
| T1323 | Telegram voice notes | E | T1322 |
| T1330 | Port audio infrastructure from finna-discovery | F | - |
| T1331 | Voice conversation mode (kernel-routed) | F | T1304, T1330 |
| T1332 | Gemini Live quick voice mode | F | T1330 |
| T1333 | UX polish (long-press, shortcuts, settings) | F | T1331 |
