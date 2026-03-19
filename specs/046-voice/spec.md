# 046: Voice -- TTS, STT, and Telephony

## Status: Phase A-E Complete, Phase F (Voice Conversation) TODO

## Overview

Full voice capabilities for Matrix OS: text-to-speech, speech-to-text, and telephony (inbound/outbound phone calls). Users can talk to the OS via the shell mic button, send voice notes from messaging channels, and make/receive phone calls. The platform manages telephony infrastructure (Twilio accounts, phone numbers, webhook tunnels) so users get voice with zero configuration.

Architecture adapted from OpenClaw's production-hardened voice-call extension, with Matrix OS conventions (Everything Is a File, gateway service pattern, IPC tools).

## Task Range: T1300-T1349

## Goals

1. Shell voice: mic button in InputBar, voice playback for AI responses
2. Channel voice: transcribe voice notes from Telegram/WhatsApp/Discord
3. Telephony: inbound/outbound phone calls via Twilio (Telnyx follow-up)
4. TTS fallback chain: ElevenLabs > OpenAI TTS > Edge TTS (works with zero API keys)
5. STT: OpenAI Whisper API
6. Platform-managed: zero-config for users, BYOP escape hatch for power users
7. Production-ready: state machine, circuit breakers, webhook security, call persistence, error recovery

## Architecture

```
Browser (shell)                     Telegram / WhatsApp / Discord
  |-- VoiceButton (mic)               |-- Voice note received
  |-- MediaRecorder -> WebM/Opus      |-- Download audio file
  |-- /ws (voice message type)        |-- Save to ~/data/audio/
  |                                    |-- Auto-transcribe (Whisper)
  +------------- Gateway (:4000) ---------------------------------+
                  |
                  |-- VoiceService (lifecycle, wires everything)
                  |     |-- TtsService (FallbackChain: ElevenLabs > OpenAI > EdgeTTS)
                  |     |-- SttService (Whisper API)
                  |     |-- CallManager (state machine, active calls)
                  |     |-- CallStore (JSONL persistence)
                  |     |-- WebhookRouter (/voice/webhook/:provider)
                  |
                  |-- Providers:
                  |     |-- VoiceCallProvider interface (from OpenClaw)
                  |     |-- TwilioProvider (TwiML, HMAC-SHA1, Media Streams)
                  |     |-- MockProvider (testing)
                  |     |-- [Future: TelnyxProvider]
                  |
                  |-- IPC Tools: speak, transcribe, call
                  |
                  +---> Dispatcher ---> Kernel (uses voice IPC tools)

Phone Network (PSTN)
  |-- Twilio SIP -> webhook -> Gateway /voice/webhook/twilio
  |-- Cloudflare Tunnel (platform-managed) -> user gateway container
```

## Provider Abstractions

### VoiceCallProvider (adapted from OpenClaw)

```typescript
interface VoiceCallProvider {
  readonly name: ProviderName;
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;
  parseWebhookEvent(ctx: WebhookContext): NormalizedEvent | null;
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
  hangupCall(input: HangupCallInput): Promise<void>;
  playTts(input: PlayTtsInput): Promise<void>;
  startListening(input: StartListeningInput): Promise<void>;
  stopListening(input: StopListeningInput): Promise<void>;
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}
```

### TtsProvider

```typescript
interface TtsProvider {
  readonly name: string;
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
  isAvailable(): boolean;
}

type TtsResult = {
  audio: Buffer;
  format: "mp3" | "pcm" | "opus";
  sampleRate: number;
  durationMs: number;
  provider: string;
};
```

### SttProvider

```typescript
interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, options?: SttOptions): Promise<SttResult>;
  isAvailable(): boolean;
}

type SttResult = {
  text: string;
  language: string;
  durationMs: number;
  confidence?: number;
};
```

## Call State Machine (from OpenClaw)

```
initiated -> ringing -> answered -> active <-> speaking / listening
                                      |
                                      v
                  completed | hangup-user | hangup-bot | timeout | error
                  failed | no-answer | busy | voicemail
```

Invalid transitions are rejected. Each transition is logged and persisted.

### Call Modes

- **notify**: Speak a message, auto-hangup after configurable delay. For alerts and voicemails.
- **conversation**: Bidirectional. Speak, listen for response, dispatch to kernel, speak kernel's response, loop. For interactive calls.

### Call Record (adapted from OpenClaw)

```typescript
type CallRecord = {
  callId: string;
  providerCallId?: string;
  provider: ProviderName;
  direction: "inbound" | "outbound";
  state: CallState;
  from: string;              // E.164
  to: string;                // E.164
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  endReason?: EndReason;
  transcript: TranscriptEntry[];
  processedEventIds: string[];  // Idempotent event processing
  mode: CallMode;
  metadata?: Record<string, unknown>;
};
```

## Normalized Events (from OpenClaw)

All providers emit the same event format:

```typescript
type NormalizedEvent =
  | { type: "call.initiated" }
  | { type: "call.ringing" }
  | { type: "call.answered" }
  | { type: "call.active" }
  | { type: "call.speaking"; text: string }
  | { type: "call.speech"; transcript: string; isFinal: boolean; confidence?: number }
  | { type: "call.silence"; durationMs: number }
  | { type: "call.dtmf"; digits: string }
  | { type: "call.ended"; reason: EndReason }
  | { type: "call.error"; error: string; retryable?: boolean };
```

## Data Schemas

### Voice config in ~/system/config.json

```json
{
  "voice": {
    "enabled": true,
    "tts": {
      "provider": "auto",
      "elevenlabs": { "voiceId": "21m00Tcm4TlvDq8ikWAM", "model": "eleven_turbo_v2_5" },
      "openai": { "model": "tts-1", "voice": "alloy" }
    },
    "stt": {
      "provider": "whisper",
      "openai": { "model": "whisper-1" }
    },
    "telephony": {
      "mode": "managed",
      "provider": "twilio",
      "inboundPolicy": "pairing",
      "maxDurationSeconds": 600,
      "maxConcurrentCalls": 5,
      "silenceTimeoutMs": 30000,
      "outbound": {
        "defaultMode": "conversation",
        "notifyHangupDelaySec": 5
      }
    },
    "autoSpeakResponses": false
  }
}
```

**Managed mode**: Platform injects `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` as env vars. No secrets in user filesystem.

**BYOP mode**: User provides credentials via settings UI, stored in config.json inside their container (their keys, their filesystem).

### Call log at ~/system/voice/calls.jsonl

```json
{"callId":"abc-123","provider":"twilio","direction":"outbound","from":"+1234567890","to":"+0987654321","state":"completed","startedAt":1710000000,"answeredAt":1710000005,"endedAt":1710000120,"endReason":"hangup-bot","mode":"conversation","transcript":[{"speaker":"bot","text":"Hello!","ts":1710000006},{"speaker":"user","text":"Hi there","ts":1710000010}]}
```

### Voice usage in ~/system/logs/voice-usage.jsonl

```json
{"action":"tts","provider":"elevenlabs","chars":150,"cost":0.045,"durationMs":3200,"ts":1710000000}
{"action":"stt","provider":"whisper","durationMs":12500,"cost":0.006,"ts":1710000001}
{"action":"call","provider":"twilio","durationMs":115000,"cost":0.23,"direction":"outbound","ts":1710000002}
```

## IPC Tools

### speak

```typescript
tool("speak", "Convert text to speech audio", {
  text: z.string(),
  voice: z.string().optional(),
  provider: z.enum(["auto", "elevenlabs", "openai", "edge"]).optional(),
})
// Returns { audioUrl, durationMs, provider }
// During active call: speaks into the call instead of saving file
```

### transcribe

```typescript
tool("transcribe", "Transcribe audio file to text", {
  filePath: z.string(),
  language: z.string().optional(),
})
// Returns { text, language, durationMs }
```

### call

```typescript
tool("call", "Make or control a phone call", {
  action: z.enum(["initiate", "speak", "hangup", "status"]),
  to: z.string().optional(),
  callId: z.string().optional(),
  message: z.string().optional(),
  mode: z.enum(["conversation", "notify"]).optional(),
})
// initiate: { callId, status: "ringing" }
// speak: { spoken: true }
// hangup: { ended: true }
// status: { state, duration, transcript }
```

## Shell Voice

### Recording Flow

1. User taps mic button -> `MediaRecorder` captures WebM/Opus (native browser format)
2. On release, binary audio sent over existing `/ws` WebSocket as `{ type: "voice", audio: ArrayBuffer }`
3. Gateway receives -> SttService transcribes (Whisper) -> transcript text
4. Transcript dispatched to kernel as normal message with `source: "voice"` metadata
5. Kernel responds with text -> TtsService synthesizes -> audio streamed back over WebSocket
6. Shell plays via Web Audio API

### Voice Message Rendering

- Voice messages in ChatPanel show waveform + play button + transcript text
- AI voice responses show audio player + text
- Falls back to text-only if TTS disabled or fails

### Phone Call UI (VoiceCallPanel)

- Triggered by kernel `call` tool or command palette
- Shows: caller ID, duration timer, live transcript, mute/hangup buttons
- Call status events streamed over `/ws`

## Channel Voice Notes

When Telegram/WhatsApp/Discord sends a voice message:
1. Channel adapter downloads audio file
2. Saves to `~/data/audio/{channel}-{timestamp}.ogg`
3. Calls SttService.transcribe() to get text
4. Dispatches to kernel with both transcript and audio path
5. Kernel sees the text message and can re-transcribe via `transcribe` tool if needed

## Webhook Infrastructure

### Routing

```
Twilio PSTN -> https://{handle}.matrix-os.com/voice/webhook/twilio
               |
               Cloudflare Tunnel (existing per-user tunnel)
               |
               Platform reverse proxy -> Gateway :4000
               |
               /voice/webhook/twilio -> TwilioProvider.parseWebhookEvent()
               |
               NormalizedEvent -> CallManager.processEvent()
```

Voice webhooks ride on the existing per-user Cloudflare Tunnel subdomain. No new tunnel infrastructure needed.

### Webhook Security (from OpenClaw)

- Twilio: HMAC-SHA1 signature over reconstructed public URL + POST body
- Event deduplication by provider event ID (prevents replay)
- Request body size limit (1MB)
- Rate limiting on webhook endpoint

## Platform Responsibilities

### Managed Mode (zero-config)

- On user provisioning: allocate Twilio phone number from pool, store in platform DB
- Configure Twilio webhook URL to `https://{handle}.matrix-os.com/voice/webhook/twilio`
- Inject env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- Inject shared API keys: `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` (for TTS/STT)
- Track voice usage per tenant (minutes, chars, costs) for billing

### BYOP Mode

- User provides own Twilio/ElevenLabs/OpenAI credentials in settings
- Platform doesn't inject or track -- user manages their own costs
- Gateway reads from config.json fallback when env vars absent

## Production Hardening

### TTS Fallback Chain

```
ElevenLabs -> (fail) -> OpenAI TTS -> (fail) -> Edge TTS -> (fail) -> error
```

- Each provider: independent 5s timeout
- Circuit breaker: 3 consecutive failures -> skip provider for 60s
- Usage tracked per provider in voice-usage.jsonl

### Call Safety

- Invalid state transitions rejected
- Max duration timer per call (default 600s)
- Max concurrent calls limit (default 5)
- Silence timeout (default 30s)
- Idempotent event processing (dedup by processedEventIds)
- Stale call reaper: cleans up calls stuck in non-terminal state

### Error Recovery

- Gateway restart: rehydrate active calls from JSONL, verify with provider API
- Stale calls (provider says ended): auto-cleanup
- Provider API errors: exponential backoff (3 retries, 1s/2s/4s)
- Failed TTS during call: speak fallback text
- Failed STT: return error with partial transcript if available

### Audio Processing (from OpenClaw, pure TypeScript)

- PCM <-> mu-law G.711 conversion (no native deps)
- Linear interpolation resampling (any rate -> 8kHz for telephony)
- 20ms frame chunking (160 samples at 8kHz) for streaming
- Audio file size limits (10MB max per recording)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /voice/webhook/:provider | Telephony webhook (Twilio/Telnyx) |
| GET | /api/voice/health | Voice service health check |
| GET | /api/voice/calls | List recent calls (from JSONL) |
| GET | /api/voice/calls/:id | Get call record + transcript |
| POST | /api/voice/tts | REST TTS (text -> audio file) |
| POST | /api/voice/stt | REST STT (audio file -> text) |

WebSocket messages on existing `/ws`:
- Client -> Server: `{ type: "voice", audio: ArrayBuffer }`
- Server -> Client: `{ type: "voice_transcription", text: string }`
- Server -> Client: `{ type: "voice_audio", audio: ArrayBuffer }`
- Server -> Client: `{ type: "call_status", callId, state, transcript? }`

## Tunnel Architecture

```typescript
interface TunnelProvider {
  start(config: TunnelConfig): Promise<string>;  // returns public URL
  stop(): Promise<void>;
  health(): Promise<boolean>;
}
```

Only Cloudflare Tunnel shipped initially (already in platform stack). Interface allows future ngrok/Tailscale additions.

For managed mode, voice webhooks use the existing per-user subdomain tunnel. For BYOP/local dev, user configures `publicUrl` manually or uses ngrok.

## New Files (35)

| File | Purpose |
|------|---------|
| `packages/gateway/src/voice/index.ts` | VoiceService lifecycle |
| `packages/gateway/src/voice/types.ts` | CallRecord, CallState, NormalizedEvent, configs |
| `packages/gateway/src/voice/call-manager.ts` | State machine, active calls, conversation loop |
| `packages/gateway/src/voice/call-store.ts` | JSONL persistence |
| `packages/gateway/src/voice/response-generator.ts` | AI response during calls via dispatcher |
| `packages/gateway/src/voice/webhook.ts` | Hono routes /voice/webhook/:provider |
| `packages/gateway/src/voice/providers/base.ts` | VoiceCallProvider interface |
| `packages/gateway/src/voice/providers/twilio.ts` | Twilio provider |
| `packages/gateway/src/voice/providers/mock.ts` | Mock provider for testing |
| `packages/gateway/src/voice/tts/base.ts` | TtsProvider interface |
| `packages/gateway/src/voice/tts/elevenlabs.ts` | ElevenLabs TTS |
| `packages/gateway/src/voice/tts/openai.ts` | OpenAI TTS |
| `packages/gateway/src/voice/tts/edge-tts.ts` | Edge TTS (free) |
| `packages/gateway/src/voice/tts/fallback.ts` | FallbackTtsChain with circuit breaker |
| `packages/gateway/src/voice/stt/base.ts` | SttProvider interface |
| `packages/gateway/src/voice/stt/whisper.ts` | OpenAI Whisper STT |
| `packages/gateway/src/voice/audio/convert.ts` | PCM <-> mu-law, resampling |
| `packages/gateway/src/voice/audio/chunking.ts` | 20ms frame chunking |
| `packages/gateway/src/voice/tunnel/base.ts` | TunnelProvider interface |
| `packages/gateway/src/voice/tunnel/cloudflare.ts` | Cloudflare Tunnel |
| `shell/src/hooks/useVoice.ts` | Mic recording + audio playback |
| `shell/src/hooks/useVoiceCall.ts` | Phone call UI state |
| `shell/src/components/VoiceButton.tsx` | Mic toggle in InputBar |
| `shell/src/components/VoiceCallPanel.tsx` | Active call UI |
| `home/system/voice/calls.jsonl` | Empty call log template |
| `home/agents/knowledge/voice.md` | AI knowledge for voice features |
| `tests/gateway/voice/types.test.ts` | Type validation tests |
| `tests/gateway/voice/call-manager.test.ts` | Call state machine tests |
| `tests/gateway/voice/call-store.test.ts` | JSONL persistence tests |
| `tests/gateway/voice/webhook.test.ts` | Webhook security tests |
| `tests/gateway/voice/providers/twilio.test.ts` | Twilio provider tests |
| `tests/gateway/voice/providers/mock.test.ts` | Mock provider tests |
| `tests/gateway/voice/tts/fallback.test.ts` | TTS fallback chain tests |
| `tests/gateway/voice/stt/whisper.test.ts` | Whisper STT tests |
| `tests/gateway/voice/audio/convert.test.ts` | Audio conversion tests |
| `tests/kernel/voice-tools.test.ts` | IPC tool tests |

## Modified Files (8)

| File | Changes |
|------|---------|
| `packages/gateway/src/server.ts` | Mount voice routes, start VoiceService, handle voice WS messages |
| `packages/kernel/src/ipc-server.ts` | Add speak, transcribe, call IPC tools |
| `packages/gateway/src/channels/telegram.ts` | Voice note download + auto-transcribe |
| `shell/src/components/InputBar.tsx` | Add VoiceButton |
| `shell/src/components/ChatPanel.tsx` | Voice message rendering (waveform + player) |
| `home/system/config.json` | Voice config section |
| `packages/platform/src/orchestrator.ts` | Twilio provisioning, env var injection |
| `packages/gateway/package.json` | Add node-edge-tts dependency |

## Dependencies

- `node-edge-tts`: Edge TTS (free, no API key). Only new npm dependency.
- All other providers use native `fetch` -- no SDKs.
- Audio conversion is pure TypeScript (adapted from OpenClaw).

## Phases

- **A**: Voice core (types, TTS/STT providers, fallback chain, audio utils) -- DONE
- **B**: Shell voice (mic button, recording, playback, WS messages) -- DONE
- **C**: Telephony (CallManager, Twilio provider, webhooks, call IPC tools) -- DONE
- **D**: Platform integration (managed mode, provisioning, tunnel, usage tracking) -- DONE
- **E**: Channel voice notes (Telegram voice note handling) -- DONE
- **F**: Voice conversation mode (real-time voice with kernel agent) -- TODO

A-E complete. F is the next major milestone.

## Phase F: Voice Conversation Mode (TODO)

### Problem

The current mic button only transcribes. Users also need a full voice conversation mode where they talk naturally with their AI agent -- auto-listen, auto-respond, hands-free.

### Voice Mode Strategy

**Why not just use Gemini Live / OpenAI Realtime?**

These APIs give excellent real-time voice (200ms latency, native VAD, barge-in) but they bypass the Matrix OS kernel. The AI responding would be Gemini/OpenAI, not the user's Claude agent with its SOUL, skills, memory, tools, and file system. This defeats the purpose of Matrix OS.

**Strategy:**

1. **Default: Kernel-routed voice** -- Whisper STT -> kernel dispatch -> ElevenLabs TTS. Slower (~2-3s) but uses the actual agent. Improve UX with AudioWorklet encoding, client-side VAD, streaming TTS.

2. **Optional: Gemini Live quick voice** -- For casual conversation where kernel tools aren't needed. Fast (~200ms) but talks to Gemini, not the kernel agent.

3. **Endgame: Anthropic real-time voice API** -- When Anthropic releases their voice API, it replaces option 1 with native Claude voice at real-time latency. Same kernel, same tools, real-time speed.

### Audio Infrastructure

Port production-grade audio layer from `~/dev/finna/finna-discovery/packages/voice-interview/`:

- `AudioCapture` -- Web Audio API + AudioWorklet for real-time PCM encoding (16kHz capture, echo cancellation, noise suppression, auto gain, device selection)
- `AudioPlayback` -- Queue-based playback with lookahead scheduling (24kHz output, barge-in interrupt)
- `pcm-encoder.worklet.js` -- AudioWorklet processor (separate thread, zero main-thread jank)
- Client-side VAD via AnalyserNode RMS level detection
- All provider-agnostic -- works with any backend

### UI Components

- `Orb` -- ElevenLabs UI (already installed), wired with `agentState` + volume refs
- `LiveWaveform` -- Real-time frequency visualization for mic preview
- `AudioLevelBars` -- VU meter visualization
- Auto-scrolling transcript panel
- Fullscreen overlay with controls (mute, end, mode toggle)

### Reference Implementations

- **finna-discovery** (`~/dev/finna/finna-discovery/packages/voice-interview/`): Production voice-interview package with Gemini Live, AudioWorklet, Orb, transcript management
- **hackathon** (`~/dev/playgrounds/finna-deepmind-granola-hackathon/apps/web/src/components/voice/`): Simpler single-app version with same audio stack

Both use Gemini Live API with bidirectional WebSocket, AudioWorklet for PCM encoding, automatic VAD, event-driven architecture.

## Verification Checklist

### Phase A-E (DONE)

1. `bun run test` -- 2522 tests pass
2. Shell: click mic, speak -> text fills input, user sends manually
3. TTS fallback: ElevenLabs -> OpenAI -> Edge TTS (verified on Docker)
4. TTS REST endpoint: POST /api/voice/tts -> returns audio URL
5. STT REST endpoint: POST /api/voice/stt -> returns transcript
6. Round-trip: TTS audio -> STT -> exact text match (verified)
7. Voice health endpoint: GET /api/voice/health -> shows all providers
8. Telephony: CallManager state machine, Twilio provider, webhook router (unit tested)
9. Platform: Twilio provisioning, env var injection, tunnel interface (unit tested)
10. Telegram: voice note auto-transcription (unit tested)

### Phase F (TODO)

1. Voice conversation: click AudioLines button -> fullscreen Orb -> speak naturally -> AI responds with voice
2. Auto-listen: after AI finishes speaking, mic auto-activates for next turn
3. Barge-in: speaking while AI talks interrupts playback
4. Transcript: shows conversation history in real-time
5. Gemini Live mode: toggle available, fast response, distinct label
6. Settings: voice mode, engine, voice selection, VAD sensitivity
7. Telephony: max duration timer fires -> call auto-hangups
8. Telegram: send voice note -> auto-transcribed, kernel responds
9. Platform: new user provisioned -> voice works with zero config
10. Gateway restart: active calls recovered from JSONL, verified with provider
