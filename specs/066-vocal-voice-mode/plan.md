# Plan 066: Vocal Voice Mode Implementation

## Phase 0: Reuse Audit

### 0.1 Extract `gemini-live.ts` for reuse
- Onboarding already has a working Gemini Live WS client. Move it to a location both `onboarding/` and `vocal/` can import without circular deps.
- Decision: keep it in `packages/gateway/src/onboarding/gemini-live.ts` and import from `vocal/`. The module is stateless w.r.t. onboarding concerns (no state machine, no stage types) so cross-import is clean.
- Verify: both consumers share the same `GeminiLiveClient`, `GeminiEvent` types.

### 0.2 AudioWorklet path from onboarding
- `shell/public/audio-worklet-processor.js` already emits raw PCM ArrayBuffers (no `btoa` in worklet context — convert to base64 in the main thread).
- Vocal reuses this worklet; no new worklet file.

## Phase 1: Gateway Vocal WebSocket

### 1.1 Prompt + tool declarations (`vocal/prompt.ts`)
- `VOCAL_SYSTEM_INSTRUCTION`: ambient-conversation persona, critical-friend guidance, challenge-the-premise flow for `create_app`, short-reply bias, silence-is-fine rule.
- `VOCAL_TOOLS`: function declarations for `create_app`, `open_app`, `remember`, `check_build_status`. `googleSearch` is built-in.
- Keep the prompt under ~150 lines; long prompts hurt first-token latency on live audio.

### 1.2 Profile memory (`vocal/profile.ts`)
- `loadProfile(homePath)`: read `~/system/vocal-profile.json`, tolerate missing file (ENOENT) silently, log other errors.
- `appendFact(homePath, rawFact)`:
  - `sanitizeFact`: strip control chars, collapse whitespace, cap 512 chars, reject empty
  - Per-home `writeLocks: Map<string, Promise<unknown>>` serializes concurrent writes (Gemini can fire parallel `remember` calls)
  - Dedupe (case-insensitive)
  - Cap profile at 50 facts (LRU slice)
  - Atomic write: `${path}.tmp-${randomBytes(8).hex()}` with `{ flag: 'wx' }`, then `rename`; unlink tmp in `finally` if rename failed
- `renderProfileForPrompt(profile)`: returns a plain-text "what you already know" block appended to the system instruction, with guidance: "don't recite it, don't list it back".

### 1.3 WS handler (`vocal/ws-handler.ts`)
- Register `/ws/vocal` in `server.ts`; add to `WS_QUERY_TOKEN_PATHS`.
- Boot sequence per connection:
  1. Load profile, render into system prompt
  2. Open Gemini Live client with that prompt + tools
  3. Emit `ready` to shell
- Message dispatch (inbound from shell):
  - `audio`, `text_input` -> forward to Gemini Live via `realtimeInput`
  - `delegation_status`/`delegation_complete` -> update in-memory `DelegationSnapshot`, inject a "System note" into the Gemini conversation
  - `execute_result` -> inject a "System note"
- Tool handlers (from Gemini Live events):
  - `create_app` -> validate description length (`MAX_DESCRIPTION_LEN = 2000`), emit `execute{kind:"create_app",...}` to shell
  - `open_app` -> emit `execute{kind:"open_app",name}` to shell
  - `remember` -> `appendFact`, emit `fact_saved{fact}` on success
  - `check_build_status` -> answer synchronously from `DelegationSnapshot`; no round-trip
- Concurrency guard: reject second connection for the same home.
- `deriveBuildStage(elapsedSec, currentAction)`: map raw action to a spoken stage (`Planning`, `Writing code`, `Testing`).
- Estimate helper: `estimatedTotalSec = 210` (3.5 min) — replaces the earlier 45s placeholder that was too optimistic for the median app build.

## Phase 2: Shell Vocal UI

### 2.1 `useVocalSession.ts`
- Connect to `/ws/vocal?token=...`, reuse auth-token plumbing from onboarding.
- `VocalSession` exposes: `voiceState` ("listening"/"speaking"/"idle"/"thinking"), `subtitle`, `error`, `connected`, plus delegation notifiers.
- Audio playback: decode base64 -> Int16 -> Float32 (note: current implementation has a per-sample ternary that can be collapsed to `/32768`; see follow-ups).
- Audio capture: mic -> AudioWorklet (raw PCM ArrayBuffer) -> main-thread base64 -> WS `audio`.
- Tool dispatch callbacks:
  - `onExecute({kind:"create_app",description})` -> call `chat.submitMessage(description)`, capture `requestId`
  - `onExecute({kind:"open_app",name})` -> `useWindowManager.openByName(name)`, send `execute_result`
  - `onFactSaved(fact)` -> optional toast
  - `onShowBuildProgress(snapshot)` -> state for `AgentStatusCard`

### 2.2 `VocalPanel.tsx`
- Large pulsing orb (reuse `VoiceOrb` style from onboarding), subtitle below, error banner.
- Mount `AgentStatusCard` whenever a delegation is active.
- Timers for transient UI states (flash, pending). TODO: extract `useManagedTimers()` to replace the current three separate `useRef`/`setTimeout`/cleanup patterns.

### 2.3 `AgentStatusCard.tsx`
- Props: `{ description, elapsedSec, estimatedTotalSec, currentAction, stage }`
- Progress bar clamped 0..1 = `elapsedSec / estimatedTotalSec`
- Single shared font stack on the wrapper div (TODO: currently repeated per `<span>`)

### 2.4 Delegation wiring
- `useChatState.ts` exposes a `busy` flag and `requestId` that vocal subscribes to.
- On `busy` true -> push `delegation_status{stage:"running", elapsedSec, currentAction}` every second
- On `busy` false + request completed -> push `delegation_complete{success,newAppName?,errorMessage?}`
- `useVocalSession` forwards these to gateway so `check_build_status` can answer

## Phase 3: Personality + UX polish

### 3.1 Critical-friend rewrite (commit `a60dfc2`)
- Prompt rewrite: ambient conversation, short turns, challenge-the-premise for `create_app`, explicit "not a yes-person" framing, one-specific-detail shaping pass.

### 3.2 Build-estimate fix (commit `a88bc7d`)
- `estimatedTotalSec: 210` in the first `show_build_progress` payload. Verified against median build time — 45s caused users to doubt the agent when the build took its actual time.

### 3.3 Error reporting
- `delegation_complete{success:false,errorMessage}` -> gateway injects "System note (not from the user)" prompt so Gemini speaks a graceful acknowledgement without hallucinating a cause.

## Phase 4: Testing

- Gateway: tests for `profile.ts` (sanitize, dedupe, lock serialization, atomic-write crash), `ws-handler.ts` tool dispatch (mocked Gemini Live), concurrency guard, `MAX_DESCRIPTION_LEN` enforcement.
- Shell: tests for `useVocalSession` (tool callback wiring, delegation status push, audio dispatch), `AgentStatusCard` render states.
- Auth: `/ws/vocal` token requirement in `tests/gateway/auth-hardening.test.ts`.

## Known follow-ups (carried forward from simplify review)

1. Extract shared atomic-write helper (`profile.ts`, `session-registry.ts`, `trash.ts` duplicate this pattern — `packages/gateway/src/file-ops.ts` is the right home)
2. `sanitizeFact` regex duplicates patterns in `packages/kernel/src/security/external-content.ts` — co-locate in a shared sanitizer module
3. `VocalWireMessage` type in `useVocalSession.ts` is hand-mirrored from gateway's `VocalOutbound` — extract to a shared types package when a second consumer appears
4. `writeLocks` Map is unbounded across homes (CLAUDE.md requires size cap + eviction); fine for single-user container, flag for multi-tenant
5. Audio decode: collapse per-sample ternary to `float32[i] = int16[i] / 32768`
6. Three `useRef`+`setTimeout`+cleanup blocks in `VocalPanel.tsx` -> one `useManagedTimers()` hook
7. Two near-identical "System note" templates in `ws-handler.ts:447-448` -> template helper
