# 066: Vocal Voice Mode Tasks

**Spec**: spec.md
**Plan**: plan.md
**Branch**: `feat/onboarding-voice`

---

## Phase 0: Reuse Audit (T0660)

### T0660: Reuse Gemini Live client and AudioWorklet
- [x] Import `GeminiLiveClient`/`GeminiEvent` from `packages/gateway/src/onboarding/gemini-live.js` in vocal module
- [x] Reuse `shell/public/audio-worklet-processor.js` (raw PCM ArrayBuffer -> main-thread base64)

---

## Phase 1: Gateway Vocal WebSocket (T0661-T0663)

### T0661: Prompt + tools (`vocal/prompt.ts`)
- [x] `VOCAL_SYSTEM_INSTRUCTION` — ambient persona, critical-friend rules, challenge-the-premise guidance
- [x] `VOCAL_TOOLS` function declarations: `create_app`, `open_app`, `remember`, `check_build_status`
- [x] Rely on built-in `googleSearch` grounding

### T0662: Profile memory (`vocal/profile.ts`)
- [x] `loadProfile`, `appendFact`, `renderProfileForPrompt`
- [x] `sanitizeFact`: strip control chars, collapse whitespace, cap 512, reject empty
- [x] Per-home `writeLocks` Map to serialize concurrent `remember` calls
- [x] Dedupe (case-insensitive) + cap 50 facts
- [x] Atomic write: temp file with `wx` flag + rename, orphan cleanup in finally

### T0663: WebSocket handler (`vocal/ws-handler.ts`)
- [x] Register `/ws/vocal` in `server.ts`
- [x] Add to `WS_QUERY_TOKEN_PATHS`
- [x] Boot: load profile -> inject into system prompt -> open Gemini Live
- [x] Tool dispatch: `create_app`, `open_app`, `remember`, `check_build_status`
- [x] Inbound relay: `audio`, `text_input`, `delegation_status`, `delegation_complete`, `execute_result`
- [x] Concurrency guard (one session per container)
- [x] `MAX_DESCRIPTION_LEN = 2000` cap on outbound create_app descriptions
- [x] `deriveBuildStage(elapsedSec, currentAction)` helper
- [x] `estimatedTotalSec` base 210 (3.5 min) — commit `a88bc7d`

---

## Phase 2: Shell Vocal UI (T0664-T0667)

### T0664: `useVocalSession.ts`
- [x] WS client w/ auth-token query param
- [x] Audio playback (base64 -> Int16 -> Float32)
- [x] Audio capture via AudioWorklet -> base64 -> WS `audio`
- [x] Tool-dispatch callbacks: `onExecute`, `onFactSaved`, `onShowBuildProgress`
- [x] Notifier API: `notifyDelegationComplete`, `notifyExecuteResult`, `pushDelegationStatus`

### T0665: `VocalPanel.tsx`
- [x] Voice orb + subtitle + error banner
- [x] Mount point for `AgentStatusCard`
- [ ] Extract `useManagedTimers()` to replace three duplicated timer-ref patterns (follow-up)

### T0666: `AgentStatusCard.tsx`
- [x] Progress bar: `elapsedSec / estimatedTotalSec` clamped
- [x] Stage + current-action labels
- [ ] Move font-stack to wrapper; remove per-span repetition (follow-up)

### T0667: Delegation wiring
- [x] `useChatState` surfaces `busy` + `requestId` changes
- [x] Vocal session pushes `delegation_status` during active builds
- [x] Vocal session pushes `delegation_complete` on finish (success + error paths)

---

## Phase 3: Personality + Polish (T0668-T0669)

### T0668: Critical-friend rewrite (commit `a60dfc2`)
- [x] Prompt rewrite: ambient conversation, challenge-the-premise flow, "not a yes-person" framing, shaping pass with one-specific-detail

### T0669: Build estimate correction (commit `a88bc7d`)
- [x] Replace 45s estimate with 210s (3.5 min) median

### T0672: Overlay architecture (detach from DesktopMode)
- [x] New `shell/src/stores/vocal.ts` — `useVocalStore { active, toggle, setActive }` (persisted)
- [x] Remove `"vocal"` from `DesktopMode` union; rehydrate coerces stale persisted value → `"canvas"`
- [x] `Desktop.tsx`: mount `VocalPanel` from `useVocalStore.active`; drop `desktopMode === "vocal"` from `CanvasRenderer`/`CanvasToolbar`/windows gating; cascade on `canvas` exits only
- [x] Dock button (mic icon) toggles overlay — desktop + mobile; command-palette entry `action:toggle-vocal`
- [x] `ChatPopover.tsx`: suppress rising-edge auto-open when `vocalActive` — delegation banner in overlay replaces the popup

---

## Phase 4: Testing (T0670-T0671)

### T0670: Gateway tests
- [ ] `tests/gateway/vocal/profile.test.ts` — sanitize, dedupe, lock serialization, atomic write
- [ ] `tests/gateway/vocal/ws-handler.test.ts` — tool dispatch with mocked Gemini Live
- [ ] Auth hardening: `/ws/vocal` token requirement

### T0671: Shell tests
- [ ] `tests/shell/vocal-session.test.tsx` — tool callback wiring, delegation push
- [ ] `tests/shell/agent-status-card.test.tsx` — render states

---

## Follow-ups (carried forward from simplify review)

1. **Extract shared `atomicWriteJSON` helper** — `profile.ts`, `session-registry.ts`, `trash.ts` each have a slightly different version. Home: `packages/gateway/src/file-ops.ts`.
2. **Co-locate `sanitizeFact` with existing sanitizer** in `packages/kernel/src/security/external-content.ts` or a new shared module.
3. **Shared types package** — `VocalWireMessage` in `useVocalSession.ts` is hand-mirrored from gateway's `VocalOutbound`.
4. **Size cap on `writeLocks` Map** — CLAUDE.md requires cap + eviction for in-memory Maps. Fine for single-user container today, flag for multi-tenant.
5. **Simplify audio decode** — collapse per-sample ternary to single division.
6. **`useManagedTimers()`** hook to replace duplicated `useRef`+`setTimeout`+cleanup blocks in `VocalPanel.tsx` (also applicable to `useVocalSession.ts` and `useOnboarding.ts`).
7. **Template helper for "System note" strings** in `ws-handler.ts:447-448`.
8. **Stable `onAction` reference in `ChatPopover`** — current `useCallback` identity defeats `MessageItem` memo on every `busy` flip (from efficiency review).
9. **Don't invoke `send()` from inside a `setQueue(updater)`** — move side effects out of the pure updater to avoid StrictMode double-send (`useChatState.ts:122-134`).
10. **Debounce `reorderDockSection` fetch** — currently fires per drag event (`stores/desktop-config.ts:58-69`).
