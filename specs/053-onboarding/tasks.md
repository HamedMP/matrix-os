# 053: Voice-First Onboarding Tasks

**Spec**: spec.md
**Plan**: plan.md
**Branch**: `feat/onboarding-voice`

---

## Phase 0: Spikes

### T0530: Gemini Live model + audio format
- [x] Confirm `gemini-2.5-flash-preview-native-audio-dialog` supports `BidiGenerateContent` with audio
- [x] Confirm PCM 16-bit 16kHz input / 24kHz output
- [x] Document API shape change: `realtimeInput: { audio: { data, mimeType } }` replaces deprecated `mediaChunks`
- [x] Document `realtimeInput: { text: "..." }` replaces rejected `clientContent { turns }`

### T0531: ffmpeg in Docker
- [x] Verify `ffmpeg` present in Dockerfile Alpine stage
- [x] Streaming transcode: WebM Opus <-> PCM 16kHz (no temp files)

---

## Phase 1: Gateway Onboarding WebSocket (T0532-T0537)

### T0532: Shared protocol types
- [x] `packages/gateway/src/onboarding/types.ts`: Zod 4 schemas for all messages, stage enum, error codes

### T0533: State machine
- [x] `state-machine.ts`: transitions `landing -> permission -> greeting -> interview -> api_key -> done`
- [x] Per-stage timeouts and max-total (15 min)
- [x] Persist to `~/system/onboarding-state.json` after each completed stage
- [x] Resume on reconnect

### T0534: Gemini Live client
- [x] `gemini-live.ts`: WS connection, 10s connect timeout, 3 retries w/ exponential backoff
- [x] System-instruction injection, audio relay
- [x] Transcript buffering server-side
- [x] Missing `GEMINI_API_KEY` -> immediate text mode

### T0535: Audio codec
- [x] `audio-codec.ts`: ffmpeg streaming subprocess
- [x] Chunk cap 256 KB, session cap 50 MB
- [x] Spawn-failure -> `mode_change` to text

### T0536: WebSocket endpoint
- [x] `ws-handler.ts` registered in `server.ts`
- [x] `/ws/onboarding` added to `WS_QUERY_TOKEN_PATHS`
- [x] Concurrency flag (reject second connection)
- [x] Silence detection 30s/60s
- [x] JSON size cap 64 KB

### T0537: Text-mode path
- [x] `audioFormat: "text"` skips Gemini Live, uses Gemini REST
- [x] Same state machine, same stages, text I/O only

---

## Phase 2: API Key Collection (T0538-T0539)

### T0538: API key validation + storage
- [x] `api-key.ts`: format check, minimal Anthropic call with `AbortSignal.timeout(10_000)`
- [x] Strip key from caught exceptions; log only HTTP status
- [x] Return generic error to client
- [x] Async write to `~/system/config.json`

### T0539: BYOK kernel support
- [x] Dispatcher reads `config.kernel.anthropicApiKey` per dispatch (not cached)
- [x] Sets `process.env.ANTHROPIC_API_KEY` for the kernel subprocess, restores after

---

## Phase 3: Session-Based Platform Routing (T0540)

### T0540: `app.matrix-os.com` routing
- [x] `packages/platform/src/main.ts`: session-based routing before subdomain fallback
- [x] `distro/cloudflared.yml`: add `app.matrix-os.com` route
- [x] `www/src/app/dashboard/actions.ts`: redirect to `app.matrix-os.com`
- [x] Clerk cookie domain `.matrix-os.com`

---

## Phase 4: Shell UI (T0541-T0546)

### T0541: First-run detection
- [x] Check `system/onboarding-complete.json`; 404 -> `OnboardingScreen`
- [x] Cache in ref (StrictMode-safe); 3 retries w/ 1s delay

### T0542: `useOnboarding` hook
- [x] WS client for `/ws/onboarding?token=...`
- [x] Audio playback via Web Audio API
- [x] Mic capture + PCM streaming via worklet (worklet emits raw ArrayBuffer; main thread converts to base64 because AudioWorklet has no `btoa`)
- [x] Reconnect with backoff (2s, max 30s) for post-rename window

### T0543: `OnboardingScreen` + landing
- [x] Fullscreen, no dock/chrome
- [x] Landing: shimmer wordmark + "Enter Matrix OS" button with fade transition (commits `4b1e40f`, `f30e74c`)

### T0544: Voice visualizer
- [x] `VoiceOrb.tsx`: pulsing orb keyed on audio levels
- [x] `VoiceWave.tsx`: waveform bars (commit `e023082`)

### T0545: Mic permission flow
- [x] `useMicPermission.ts` + `MicPermissionDialog.tsx`
- [x] Deny -> text mode with no dead-end (commit `bd1fb73`)

### T0546: `ApiKeyInput`
- [x] Password-masked input, console.anthropic.com link
- [x] Generic validation feedback

### T0547: Voice agent rework
- [x] Prompt rewritten: ask questions before explaining; short turns (commit `a7f1fbb`)
- [x] Remove contextual content display from conversation screen (commit `b9c22aa`)

### T0548: Post-onboarding landing
- [x] Desktop loads on `moraine-lake` wallpaper preset (commit `e082829`)

---

## Phase 5: Testing (T0549-T0551)

### T0549: Gateway unit + integration
- [x] `tests/gateway/onboarding/state-machine.test.ts`
- [x] `tests/gateway/onboarding/api-key.test.ts`
- [x] `tests/gateway/onboarding/extract-profile.test.ts`
- [x] `tests/gateway/onboarding/types.test.ts`
- [x] `tests/gateway/onboarding/ws-handler.test.ts` (happy path, text mode, resume, auth, concurrency)

### T0550: Shell tests
- [x] `tests/shell/onboarding-*.test.ts`

### T0551: Auth hardening
- [x] `tests/gateway/auth-hardening.test.ts`: `/ws/onboarding` token requirement

---

## Deferred / Cut

- App-suggestion cards (`AppSuggestionCards.tsx` kept in repo but removed from the flow — commit `b9c22aa`)
- Username claim stage (Clerk username is used directly; no separate rename)
- Profile-info panel inside conversation (visual noise, cut)
- Activation-choice three-path UI (simplified to API-key-only; Claude Code path deferred)

---

## Known follow-ups

- Duplicated `TAIL_TO_DONE` lookup in `onboarding/ws-handler.ts` vs. state machine — single source of truth
- Shared types package between gateway and shell so `VocalWireMessage` / onboarding messages aren't manually mirrored
