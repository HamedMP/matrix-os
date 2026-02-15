# Tasks: Media -- Image Generation + Voice

**Task range**: T660-T678
**Parallel**: YES -- Image gen (T660-T667) and Voice (T668-T678) are independent of each other. Both can run in parallel with other specs.
**Deps**: Image gen: none. Voice: none for core, but shell audio UI needs WebSocket changes in gateway.

## Part A: Image Generation (fal.ai)

### User Story

- **US-IMG1**: "The OS can generate images from text descriptions, create app icons, and track usage for cost control"

### Architecture

- fal.ai REST API for image generation (FLUX models)
- API key provided by platform service (not per-user) via env var or config
- Generated images saved to `~/data/images/` (Everything Is a File)
- Usage tracking: per-user daily totals stored in SQLite or JSONL log
- Platform-level usage aggregation for billing

Key files:
- `packages/kernel/src/image-gen.ts` (new -- fal.ai client)
- `packages/kernel/src/usage.ts` (new -- usage tracking)
- `packages/kernel/src/ipc-server.ts` (add generate_image tool)
- `packages/gateway/src/server.ts` (usage endpoint)

### Tests (TDD -- write FIRST)

- [ ] T660a [P] [US-IMG1] Write `tests/kernel/image-gen.test.ts`:
  - `createImageClient(apiKey)` initializes client
  - `generateImage(prompt, opts)` calls fal.ai API, returns image URL + local path
  - Handles API errors (rate limit, invalid key, timeout)
  - `opts.model` selects model (default: flux-schnell for speed)
  - `opts.size` controls dimensions (default: 1024x1024)
  - Saves image to specified directory

- [ ] T660b [P] [US-IMG1] Write `tests/kernel/usage.test.ts`:
  - `createUsageTracker(homePath)` initializes tracker
  - `track(action, cost)` records usage entry
  - `getDaily(date?)` returns daily totals
  - `getMonthly(month?)` returns monthly totals
  - Usage persisted to JSONL file in `~/system/logs/usage.jsonl`
  - Respects daily/monthly limits if configured

### Implementation

- [ ] T661 [US-IMG1] Implement `createImageClient()` in `packages/kernel/src/image-gen.ts`:
  - fal.ai REST API: `POST https://fal.run/{model}` with `{ prompt, image_size, num_images }`
  - Models: `fal-ai/flux/schnell` (fast, cheap), `fal-ai/flux/dev` (quality)
  - Download result image, save to `~/data/images/{timestamp}-{slug}.png`
  - Return `{ url, localPath, model, cost }` -- cost estimated from model pricing
  - Error handling: retry once on timeout, clear error messages on auth failure

- [ ] T662 [US-IMG1] Implement `createUsageTracker()` in `packages/kernel/src/usage.ts`:
  - JSONL append-only log: `~/system/logs/usage.jsonl`
  - Entry format: `{ action, model?, cost, timestamp, metadata? }`
  - `track(action, cost, metadata?)`: append entry
  - `getDaily(date?)`: sum costs for date (default today)
  - `getMonthly(month?)`: sum costs for month
  - `checkLimit(action, policy?)`: returns `{ allowed, remaining, limit }`. Policy from config.json.
  - Actions: `image_gen`, `voice_tts`, `voice_stt`, `browser`, `api_call`

- [ ] T663 [US-IMG1] Add `generate_image` IPC tool to `ipc-server.ts`:
  - Params: `{ prompt, model?, size?, save_as? }`
  - Calls image client, tracks usage, returns local file path
  - If usage limit exceeded, return error with limit info
  - Response includes cost estimate

- [ ] T664 [US-IMG1] Platform API key injection:
  - `FAL_API_KEY` env var or `config.json` -> `"media": { "fal_api_key": "..." }`
  - Platform service injects key into container env on provision
  - If no key: tool returns "Image generation not configured. Contact your platform admin."

- [ ] T665 [US-IMG1] Usage API endpoint:
  - `GET /api/usage` -- returns daily/monthly totals by action type
  - `GET /api/usage?period=daily&date=2026-02-15` -- specific date
  - Protected by auth middleware (same as other /api endpoints)

- [ ] T666 [US-IMG1] Add image serving:
  - Generated images in `~/data/images/` already served via `/files/data/images/*`
  - Ensure content-type headers correct for PNG/JPEG/WebP
  - Shell: when kernel response includes image path, render inline (img tag or RichContent block)

- [ ] T667 [US-IMG1] Shell image rendering:
  - Update `RichContent` in `shell/src/components/ui-blocks/` to detect image paths in assistant responses
  - Render as `<img>` with `/files/` prefix, clickable to open full-size
  - Image paths pattern: `~/data/images/*.{png,jpg,webp}` or `/files/data/images/*`

---

## Part B: Voice (ElevenLabs)

### User Story

- **US-VOC1**: "I can talk to the OS and hear it speak back -- voice input and output"

### Architecture

- **TTS**: ElevenLabs API (text-to-speech). High quality, low latency.
- **STT**: ElevenLabs STT API or OpenAI Whisper API. Either works.
- **Flow**: User speaks (browser mic) -> STT -> text -> kernel -> response text -> TTS -> audio -> browser playback
- **WebSocket**: New audio endpoint `/ws/voice` for streaming audio data
- **Shell**: Mic button on InputBar, audio playback on responses

Key files:
- `packages/gateway/src/voice.ts` (new -- voice service)
- `packages/kernel/src/ipc-server.ts` (speak/transcribe tools)
- `packages/gateway/src/server.ts` (voice WebSocket endpoint)
- `shell/src/hooks/useVoice.ts` (new -- mic recording + playback)
- `shell/src/components/InputBar.tsx` (mic button)

### Tests (TDD -- write FIRST)

- [ ] T668a [P] [US-VOC1] Write `tests/gateway/voice.test.ts`:
  - `createVoiceService(config)` initializes with API keys
  - `textToSpeech(text, opts)` returns audio buffer (mock API)
  - `speechToText(audioBuffer)` returns transcription (mock API)
  - Handles API errors (rate limit, invalid key)
  - Respects usage tracking (voice actions)
  - Voice disabled gracefully when no API key configured

### Implementation

- [ ] T669 [US-VOC1] Implement `createVoiceService()` in `packages/gateway/src/voice.ts`:
  - **TTS**: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
  - Configurable voice: `config.json` -> `"voice": { "elevenlabs_key": "...", "voice_id": "...", "model": "eleven_turbo_v2_5" }`
  - Returns audio buffer (MP3 or PCM)
  - **STT**: `POST https://api.elevenlabs.io/v1/speech-to-text` (or Whisper fallback: `POST https://api.openai.com/v1/audio/transcriptions`)
  - Returns `{ text, confidence }`
  - Usage tracking via `usageTracker.track("voice_tts", cost)` and `track("voice_stt", cost)`

- [ ] T670 [US-VOC1] Voice WebSocket endpoint in `packages/gateway/src/server.ts`:
  - `/ws/voice` endpoint (alongside existing `/ws` and `/ws/terminal`)
  - Protocol:
    - Client sends: `{ type: "audio_start" }`, then binary audio frames, then `{ type: "audio_end" }`
    - Server transcribes, dispatches to kernel, streams TTS response back
    - Server sends: `{ type: "transcription", text }`, then `{ type: "audio_response" }` + binary audio, then `{ type: "audio_done" }`
  - Reuses existing auth (same token as main WS)

- [ ] T671 [US-VOC1] Add voice IPC tools to `ipc-server.ts`:
  - `speak` -- `{ text, voice_id? }`. Converts text to speech. Returns audio path saved to `~/data/audio/`. Useful for proactive audio (cron job reads aloud).
  - `transcribe` -- `{ audio_path }`. Converts audio file to text. Returns transcription.

- [ ] T672 [US-VOC1] Shell `useVoice` hook in `shell/src/hooks/useVoice.ts`:
  - `startRecording()`: request mic permission, start MediaRecorder (WebM/opus)
  - `stopRecording()`: stop recording, send audio to `/ws/voice`
  - `playAudio(buffer)`: play audio response using Web Audio API
  - `isRecording`, `isPlaying`, `isSpeaking` state
  - Handle browser permissions (show prompt, handle denial)

- [ ] T673 [US-VOC1] Shell InputBar mic button:
  - Add mic icon button (MicIcon from lucide) next to send button
  - Press-and-hold or toggle to record
  - Visual feedback: pulsing animation while recording
  - Release/toggle: sends audio, shows "Transcribing..." state
  - After transcription: text appears in input, auto-submits to kernel
  - Response: if voice mode active, auto-plays TTS of response

- [ ] T674 [US-VOC1] Voice config in `home/system/config.json`:
  - ```json
    "voice": {
      "enabled": false,
      "elevenlabs_key": "",
      "voice_id": "21m00Tcm4TlvDq8ikWAM",
      "model": "eleven_turbo_v2_5",
      "stt_provider": "elevenlabs",
      "auto_speak_responses": false
    }
    ```

## Implications

- **Image gen cost**: fal.ai FLUX Schnell is ~$0.003/image. Track usage to prevent abuse. Platform can set daily limits.
- **Voice cost**: ElevenLabs is ~$0.30/1K chars TTS, ~$0.10/min STT. More expensive than image gen. Usage limits more important.
- **Usage tracker (T662)** is shared between image and voice -- single module, multiple action types. Also useful for future browser automation tracking.
- **Browser audio**: Requires HTTPS in production for mic access. Localhost works without HTTPS.
- **Mobile PWA**: Web Audio API and MediaRecorder work in mobile browsers. PWA supports mic.
- **Token budget**: Voice interactions tend to be shorter (conversational). System prompt stays the same.
- **Streaming TTS**: For long responses, ideally stream TTS chunk-by-chunk. V1: generate full audio then send. V2: streaming (future).

## Checkpoint

- [ ] "Generate an image of a sunset over mountains" -- image appears inline in chat, saved to ~/data/images/.
- [ ] Usage endpoint shows image generation count and cost.
- [ ] Click mic, speak "What's the weather?" -- transcribed, kernel responds, audio plays back.
- [ ] Voice disabled when no API key -- mic button hidden or disabled.
- [ ] `bun run test` passes.
