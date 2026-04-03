# Plan 053: Voice-First Onboarding Implementation

## Phase 0: Spikes (Must Complete Before Implementation)

### 0.1 Gemini Live Model Spike
- Connect to Gemini Multimodal Live API with candidate model names
- Confirm which model supports `BidiGenerateContent` with audio
- Document the correct model ID and endpoint
- Test audio format requirements (PCM 16-bit 16kHz confirmed?)

### 0.2 ffmpeg in Docker Spike
- Check if `ffmpeg` is in the production Dockerfile (`Dockerfile`)
- If not, add `apk add ffmpeg` to the Alpine build stage
- Test streaming transcoding: `WebM Opus -> PCM 16kHz` and `PCM 16kHz -> MP3`
- Measure latency for real-time audio relay (target: <100ms per chunk)

## Phase 1: Gateway Onboarding WebSocket

### 1.0 Shared Protocol Types
- Create `packages/gateway/src/onboarding/types.ts`
- Define all WS message types (shell->gateway, gateway->shell) with Zod 4 schemas
- Export for use by both `ws-handler.ts` and shell hook
- Include error codes enum, stage enum, audio source enum

### 1.1 Onboarding State Machine
- Create `packages/gateway/src/onboarding/state-machine.ts`
- States: `greeting`, `interview`, `extract_profile`, `suggest_apps`, `claim_username`, `api_key`, `provisioning`, `done`
- Typed transitions with event payloads
- Per-stage timeouts: greeting 60s, interview 10min, extract_profile 30s, suggest_apps 120s, claim_username 5min, api_key 5min, provisioning 10min
- Max total session: 15 min
- State persistence: write `~/system/onboarding-state.json` after each completed stage (async `fs/promises.writeFile`)
- Resume: on init, check for existing state file and restore

### 1.2 Gemini Live Client
- Create `packages/gateway/src/onboarding/gemini-live.ts`
- WebSocket connection to Gemini Multimodal Live API
- Connection timeout: 10s (`AbortSignal.timeout(10_000)`)
- Reconnect: max 3 attempts with exponential backoff (1s, 2s, 4s)
- After 3 failures: emit `mode_change` to text, fall back to Gemini REST API
- System instruction injection for interviewer persona
- Audio relay: receive PCM from Gemini, forward to shell
- Buffer transcript server-side for extraction and resume
- Handle absent `GEMINI_API_KEY`: immediate text-mode fallback

### 1.3 Audio Transcoding
- Create `packages/gateway/src/onboarding/audio-codec.ts`
- Use ffmpeg subprocess with stdio pipes (streaming, no temp files)
- Inbound: WebM Opus -> PCM 16-bit 16kHz
- Outbound: PCM 16kHz -> MP3
- Input validation: reject chunks >256 KB, reject non-audio binary data
- Cumulative buffer cap: 50 MB per session (reject beyond)
- Fallback: if ffmpeg spawn fails, emit `mode_change` to text mode

### 1.4 Onboarding WebSocket Endpoint
- Create `packages/gateway/src/onboarding/ws-handler.ts`
- Register `/ws/onboarding` on the gateway Hono app in `server.ts`
- Add `/ws/onboarding` to `WS_QUERY_TOKEN_PATHS` in `packages/gateway/src/auth.ts`
- Wire up: browser audio -> validate chunk size -> transcode -> Gemini Live
- Wire up: Gemini audio -> transcode -> browser
- Emit stage transition events with `audioSource` field
- Concurrency: boolean flag, reject concurrent connections with error
- On connect: check `onboarding-complete.json` exists -> send `onboarding_already_complete`
- On connect: check `onboarding-state.json` exists -> resume from cached stage
- JSON message size validation: max 64 KB
- Silence detection: 30s triggers gentle prompt, 60s closes Gemini Live

### 1.5 Profile Extraction
- Create `packages/gateway/src/onboarding/extract-profile.ts`
- After interview: send transcript to Gemini API (non-streaming)
- `AbortSignal.timeout(30_000)` on the extraction call
- Zod 4 schema matching `SetupPlanSchema` field names: `apps`, `skills`, `personality`, `role`
- Additional fields for `profile.md`: `name`, `interests`, `painPoints`, `workStyle`
- Fallback: if extraction fails, use `getPersonaSuggestions(role)` from existing persona engine
- Write extracted profile to `~/system/profile.md` (human-readable Markdown, async)

### 1.6 Text-Mode Gateway Path
- In `ws-handler.ts`: if `audioFormat: "text"` in start message, skip Gemini Live
- Use Gemini REST API (standard chat) with same system instruction
- Receive `text_input` messages from shell instead of audio
- Send AI responses as `{ type: "transcript" }` only (no audio)
- Same state machine, same extraction, same stages

## Phase 2: Username, Activation & API Key

### 2.1 Username (Display Name)
- Create `packages/gateway/src/onboarding/username.ts`
- Validation: 3+ chars, lowercase alphanumeric + hyphens
- Storage: write to `~/system/handle.json` (cosmetic only, not used for routing)
- No platform API call, no container rename, no availability check
- Default: derived from Clerk profile (first name or email prefix) if user skips

### 2.2 Activation Path Handling
- In `ws-handler.ts`: handle `choose_activation` message
- Path A (`api_key`): transition to `api_key` stage
- Path B (`claude_code`): write `~/system/onboarding-complete.json` (with `{ flag: 'wx' }`), skip provisioning, emit `done` with `{ openTerminal: true }` hint
- Path C (`credits`): emit `done` with `{ creditsComingSoon: true }` message (future)
- Store chosen path in `onboarding-state.json` for resume

### 2.5 API Key Validation & Storage
- Create `packages/gateway/src/onboarding/api-key.ts`
- Format check: starts with `sk-ant-`
- Validation: `POST https://api.anthropic.com/v1/messages` with minimal prompt, `AbortSignal.timeout(10_000)`
- Strip API key from any caught exception before logging (log only HTTP status code)
- Return only generic error to client: `"Key validation failed"` (never Anthropic's response)
- Storage: async `fs/promises.writeFile` to `~/system/config.json` under `kernel.anthropicApiKey`

### 2.6 Kernel BYOK Support
- Modify `packages/kernel/src/options.ts` to accept optional `anthropicApiKey` in `KernelConfig`
- Modify `packages/gateway/src/dispatcher.ts`:
  - Read `config.kernel.anthropicApiKey` from `~/system/config.json` on every `dispatch()` call (not cached)
  - If present, set `process.env.ANTHROPIC_API_KEY` before `query()`, restore after
  - If absent, use existing `process.env.ANTHROPIC_API_KEY` (proxy key for future grace period)
- **Must be complete before Phase 5.1** (provisioning uses the kernel)

## Phase 3: Session-Based Routing (Can Parallel with Phase 1/2)

### 3.1 Platform Routing Update
- Modify `packages/platform/src/main.ts`: replace subdomain matching with session-based routing
- Extract `clerkUserId` from Clerk session cookie on `app.matrix-os.com` requests
- Look up container by `clerkUserId` (existing `getContainerByClerkId()` in db.ts)
- If no container: redirect to `matrix-os.com/dashboard` to provision
- Rest of routing (auto-wake, path-based port selection) stays the same

### 3.2 Cloudflare & Dashboard Update
- Update `distro/cloudflared.yml`: add `app.matrix-os.com` -> `platform:9000` route
- Modify `www/src/app/dashboard/actions.ts`: redirect to `app.matrix-os.com` after provisioning
- Configure Clerk cookie domain to `.matrix-os.com` (covers both www and app subdomains)

## Phase 4: Shell Onboarding UI

### 4.1 First-Run Detection (Do This First)
- Modify `shell/src/components/Desktop.tsx`
- Check `GET /api/files/stat?path=system/onboarding-complete.json` on initial mount
- Cache in React ref (don't re-check on re-render or strict mode double-mount)
- Retry 3x with 1s delay if gateway unreachable
- If 404: render `OnboardingScreen`
- If 200: render normal desktop

### 4.2 Onboarding WebSocket Hook
- Create `shell/src/hooks/useOnboarding.ts`
- Connect to `/ws/onboarding?token={authToken}`
- Import types from shared types package (or duplicate -- shell can't import gateway code)
- Handle all message types: stage, audio, transcript, mode_change, error, redirect, onboarding_already_complete
- Audio playback via Web Audio API (reuse patterns from `useVoice.ts`)
- Microphone capture and streaming (reuse from `useVoice.ts`)
- Support re-initialization without full page reload (for post-rename reconnect)
- Reconnect with backoff: retry every 2s, max 30s (for post-rename)
- Expose state: currentStage, audioSource, transcript, apps, errors, isTextMode

### 4.3 OnboardingScreen Component
- Create `shell/src/components/OnboardingScreen.tsx`
- Fullscreen takeover, no dock/chrome
- Stage-aware rendering (different UI per stage)
- Orchestrates sub-components based on `useOnboarding` state

### 4.4 Voice Orb Component
- Create `shell/src/components/onboarding/VoiceOrb.tsx`
- CSS/canvas animation that pulses with audio levels
- States: listening, speaking, thinking, idle
- Subtle transcript display with fade-out below the orb

### 4.5 App Suggestion Cards
- Create `shell/src/components/onboarding/AppSuggestionCards.tsx`
- Display extracted app suggestions as cards
- Allow user to toggle apps on/off (deselect ones they don't want)
- Max 10 apps (enforced server-side, reflected in UI)
- Confirm button to proceed

### 4.6 Username Input
- Create `shell/src/components/onboarding/UsernameInput.tsx`
- Text input with real-time availability checking (debounced 300ms)
- Shows `@{username}:matrix-os.com` preview
- Validation feedback: too short, invalid chars, reserved word, taken (with suggestion)
- Enter to confirm

### 4.7 Activation Choice UI
- Create `shell/src/components/onboarding/ActivationChoice.tsx`
- Three option cards:
  - "I have an API key" -- icon: key, description: "Full AI features"
  - "I have a Claude subscription" -- icon: terminal, description: "Build apps with Claude Code"
  - "Buy credits" -- icon: coins, description: "Coming soon", disabled
- Click sends `{ type: "choose_activation", path: "..." }` via WS
- Path A -> shows ApiKeyInput
- Path B -> completes onboarding, opens Terminal app

### 4.8 API Key Input
- Create `shell/src/components/onboarding/ApiKeyInput.tsx`
- Paste-friendly text input (password-masked)
- Link to "Get your API key at console.anthropic.com"
- Validation feedback: invalid format, key doesn't work (generic message)
- Enter to confirm

### 4.9 Microphone Fallback
- If mic permission denied, switch to text-based input mode
- Send `{ type: "start", audioFormat: "text" }` to gateway
- Show text input for user responses instead of voice orb
- Same stages, same flow, user types instead of speaks

## Phase 5: Integration & Polish

## Phase 5: Claude Code Integration (Terminal Already Exists)

Terminal app is fully implemented: `TerminalApp.tsx` (multi-tab, split panes, Claude Mode via `Ctrl+Shift+C`), `pty.ts` gateway endpoint, full test coverage. No new Terminal code needed.

### 5.1 CLAUDE.md Enhancement
- Update `home/CLAUDE.md` to reference skills and knowledge:
  - "Skills are in `~/agents/skills/` -- read them for specialized capabilities"
  - "Knowledge files are in `~/agents/knowledge/` -- domain context for the OS"
- Optionally create `home/.claude/settings.json` with allowed directories
- Verify Claude Code discovers and uses skills when working in the home directory

### 5.2 Path B Desktop Behavior
- When onboarding completes via Path B (Claude Code): auto-open Terminal in Claude Mode on first desktop load
- Check `~/system/onboarding-complete.json` for `{ activationPath: "claude_code" }`
- If so, Desktop opens a Terminal window with Claude Mode (`Ctrl+Shift+C` equivalent) automatically
- Pin Terminal to dock if not already there

## Phase 6: Integration & Polish

### 6.1 Post-Onboarding Provisioning
- **Prerequisite: Phase 2.6 (BYOK kernel support) must be complete**
- Wire `confirm_apps` to existing provisioner pipeline
- Migrate `writeSetupPlan` in `packages/kernel/src/onboarding.ts` from `writeFileSync` to async `fs/promises.writeFile`
- Write `~/system/setup-plan.json` with extracted data (mapped to `SetupPlanSchema`)
- Subscribe onboarding WS handler to provisioner events via event emitter (not main `/ws` broadcast)
- Relay progress events through onboarding WebSocket
- Write `~/system/onboarding-complete.json` with `{ flag: 'wx' }` (exclusive create)
- Delete `~/system/onboarding-state.json` on completion

### 6.2 Handle Redirect
- After username claim + container rename, gateway emits `{ type: "redirect", url: "..." }`
- Shell navigates to `{newHandle}.matrix-os.com`
- Shell reconnects onboarding WS with backoff (retry every 2s, max 30s)
- New gateway reads `onboarding-state.json` and resumes from `activation` stage
- During rename window (container restarting), platform proxy returns 502 -- shell retries

### 6.3 Error Recovery
- Gemini Live connection failure: emit `mode_change` to text, use Gemini REST API
- ffmpeg spawn failure: emit `mode_change` to text
- Platform API unavailable during rename: retry with exponential backoff, max 3 attempts
- API key validation timeout: let user retry
- Provisioner hang: stage timeout (10 min) closes session with error

## Phase 7: Testing

### 7.1 Unit Tests
- `tests/gateway/onboarding/state-machine.test.ts` -- transitions, timeouts, edge cases, resume from state file
- `tests/gateway/onboarding/username.test.ts` -- display name validation
- `tests/gateway/onboarding/api-key.test.ts` -- format validation, key stripping from errors, storage
- `tests/gateway/onboarding/extract-profile.test.ts` -- schema parsing, mapping to SetupPlanSchema, fallback to persona engine
- `tests/gateway/onboarding/types.test.ts` -- Zod schema validation for all message types

### 7.2 Integration Tests
- `tests/gateway/onboarding/ws-handler.test.ts` -- full WS flow with mocked Gemini Live
- `tests/gateway/onboarding/ws-handler-text-mode.test.ts` -- text-mode fallback flow
- `tests/gateway/onboarding/ws-handler-resume.test.ts` -- resume after disconnect
- `tests/gateway/onboarding/ws-handler-auth.test.ts` -- verify token auth required
- `tests/gateway/onboarding/ws-handler-concurrency.test.ts` -- reject concurrent sessions
- API key validation against mock Anthropic endpoint
- Provisioner pipeline with onboarding-generated setup plan
- BYOK: dispatcher reads config key and passes to kernel

### 7.3 Shell Tests
- `tests/shell/onboarding-screen.test.ts` -- renders on first-run, not on subsequent loads
- `tests/shell/onboarding-desktop.test.ts` -- desktop renders when onboarding complete
- `tests/shell/onboarding-stages.test.ts` -- stage transitions update UI correctly
- `tests/shell/onboarding-username.test.ts` -- validation feedback, availability check
- `tests/shell/onboarding-activation.test.ts` -- three-path activation choice
- `tests/shell/onboarding-apikey.test.ts` -- masking, validation feedback
- `tests/shell/terminal-app.test.ts` -- xterm renders, connects to WS, sends keystrokes

### 7.4 Playwright Screenshot Tests
- Onboarding screen initial state (voice orb)
- App suggestion cards stage
- Username input stage with validation
- Activation choice stage (three paths)
- API key input stage
- Provisioning progress
- Transition to desktop
### 7.5 Auth Tests
- Add to `tests/gateway/auth-hardening.test.ts`: verify `/ws/onboarding` accepts query-param token, rejects missing token

## File Summary

### New Files
- `packages/gateway/src/onboarding/types.ts`
- `packages/gateway/src/onboarding/state-machine.ts`
- `packages/gateway/src/onboarding/gemini-live.ts`
- `packages/gateway/src/onboarding/audio-codec.ts`
- `packages/gateway/src/onboarding/ws-handler.ts`
- `packages/gateway/src/onboarding/extract-profile.ts`
- `packages/gateway/src/onboarding/username.ts`
- `packages/gateway/src/onboarding/api-key.ts`
- `shell/src/components/OnboardingScreen.tsx`
- `shell/src/components/onboarding/VoiceOrb.tsx`
- `shell/src/components/onboarding/AppSuggestionCards.tsx`
- `shell/src/components/onboarding/UsernameInput.tsx`
- `shell/src/components/onboarding/ActivationChoice.tsx`
- `shell/src/components/onboarding/ApiKeyInput.tsx`
- `shell/src/hooks/useOnboarding.ts`
- `tests/gateway/onboarding/state-machine.test.ts`
- `tests/gateway/onboarding/username.test.ts`
- `tests/gateway/onboarding/api-key.test.ts`
- `tests/gateway/onboarding/extract-profile.test.ts`
- `tests/gateway/onboarding/types.test.ts`
- `tests/gateway/onboarding/ws-handler.test.ts`
- `tests/gateway/onboarding/ws-handler-text-mode.test.ts`
- `tests/gateway/onboarding/ws-handler-resume.test.ts`
- `tests/gateway/onboarding/ws-handler-auth.test.ts`
- `tests/gateway/onboarding/ws-handler-concurrency.test.ts`

### Modified Files
- `packages/gateway/src/server.ts` -- register `/ws/onboarding`
- `packages/gateway/src/auth.ts` -- add `/ws/onboarding` to `WS_QUERY_TOKEN_PATHS`
- `packages/kernel/src/onboarding.ts` -- migrate `writeSetupPlan` to async
- `packages/gateway/src/dispatcher.ts` -- read BYOK key from config on each dispatch
- `packages/platform/src/main.ts` -- session-based routing for `app.matrix-os.com`
- `www/src/app/dashboard/actions.ts` -- redirect to `app.matrix-os.com`
- `shell/src/components/Desktop.tsx` -- first-run detection
- `home/CLAUDE.md` -- add skills/knowledge references
- `distro/cloudflared.yml` -- add `app.matrix-os.com` route
- `tests/gateway/auth-hardening.test.ts` -- add `/ws/onboarding` token test

