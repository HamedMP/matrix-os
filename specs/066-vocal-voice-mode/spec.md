# 066: Vocal -- Ambient Voice Overlay with Tool Calling, Memory, and Delegation

## Status: Complete (branch `feat/onboarding-voice`)

## Overview

Ambient voice overlay the user can open from any desktop mode. Unlike onboarding (spec 053), which is a one-time guided flow, **vocal** is an overlay the user re-enters to have a live conversation with Matrix OS — and, importantly, to *build apps and open apps by voice*. The LLM (Gemini Live) can call tools that delegate work to the kernel's app builder, look up apps already installed, save long-term facts about the user, and report build progress back in natural language.

**Vocal is orthogonal to `DesktopMode`.** It used to be a mode value on par with `canvas`/`desktop`/`dev`; it is now a standalone boolean (`useVocalStore.active`) so Aoede can speak over canvas, desktop, or dev without replacing the user's layout. A dock button (mic icon) toggles the overlay.

Implementation plan: [`plan.md`](./plan.md). Task checklist: [`tasks.md`](./tasks.md).

## Goals

1. **Ambient conversation**: no stages, no checklist. Just press and talk.
2. **Tool calling via Gemini Live**: `create_app`, `open_app`, `remember`, `check_build_status`, plus built-in `googleSearch` grounding.
3. **Delegation to the kernel**: `create_app` descriptions are forwarded to the shell, dispatched into chat as if the user had typed them, and the vocal session watches progress via `delegation_status` messages.
4. **Long-term memory**: the `remember` tool persists small facts about the user to `~/system/vocal-profile.json`, loaded into the system prompt on every new session.
5. **Critical-friend personality**: the agent challenges half-baked ideas before building. Not a yes-person. (commit `a60dfc2`)
6. **Realistic build estimates**: the spoken estimate for "a typical app" is 3.5 minutes, not 45 seconds. (commit `a88bc7d`)
7. **Build progress UI**: `AgentStatusCard` shows the current stage, elapsed time, and an estimated-total bar while delegated builds run.

## Non-Goals

- Telephony (spec 046)
- STT for pre-recorded voice notes from messaging channels (spec 046)
- Replacing the main chat interface — vocal is ambient, chat is transactional

## Architecture

```
Browser (shell)                              Gateway                     Gemini Live
  Dock mic button -> useVocalStore.active    vocal/ws-handler.ts         gemini-2.5-flash-preview-
  VocalPanel.tsx (renders when active)                                    native-audio-dialog
    |-- useVocalSession.ts  <--  /ws/vocal    <->                    <->
    |     - mic capture (PCM via worklet)       - auth token
    |     - audio playback (Int16 -> Float32)   - concurrency guard
    |     - tool-call dispatch                  - tool handler
    |
    |-- AgentStatusCard.tsx (build progress)
    |
    +-- delegates to chat --> useChatState -> kernel (Claude Agent SDK)
                                                         |
                                                         +-- app builder writes to ~/apps/

Memory:
  vocal/profile.ts -> ~/system/vocal-profile.json
    - withLock(homePath, fn): per-home write lock serializes concurrent remember() calls
    - atomic temp+rename write with `wx` exclusive flag, orphan cleanup in finally
    - dedupe by lowercase-equality, MAX_FACTS=50, MAX_FACT_LEN=512
    - sanitizeFact strips control chars, collapses whitespace
```

## Tools

| Tool | Purpose | Notes |
|---|---|---|
| `create_app(description)` | Build a new app via the kernel | Description forwarded to shell, dispatched as chat message. Agent is instructed to challenge the premise before calling. |
| `open_app(name)` | Open an installed app by name | Shell resolves fuzzy name match, reports success/`resolvedName` back |
| `remember(fact)` | Persist a fact to vocal profile | Third-person, one sentence. Dedupe + cap server-side. |
| `check_build_status()` | Answer build progress questions synchronously | Reads `DelegationSnapshot` pushed by shell; no round-trip to the kernel. |
| `googleSearch` | Grounding | Built-in Gemini Live tool; no handler needed. |

## Wire protocol

### Outbound (gateway -> shell)
- `ready`, `audio`, `transcript{speaker,text}`, `interrupted`, `turn_complete`
- `execute{kind:"create_app",description}` — dispatch the brief as a chat message
- `execute{kind:"open_app",name}` — shell looks up app by name
- `fact_saved{fact}` — surface a toast
- `show_build_progress{description,elapsedSec,estimatedTotalSec,currentAction,stage}` — drive `AgentStatusCard`
- `error{message,retryable}` — generic error surface

### Inbound (shell -> gateway)
- `start{audioFormat}`, `audio{data}`, `text_input{text}`
- `delegation_status{description,stage,elapsedSec,currentAction}` — shell pushes build progress; gateway stores in `DelegationSnapshot`
- `delegation_complete{kind:"create_app",description,success,newAppName?,errorMessage?}`
- `execute_result{kind:"open_app",name,success,resolvedName?}`

## Personality

System prompt (`vocal/prompt.ts`) frames Matrix OS as:
- Already inside the user's workspace; skip introductions
- Warm, a little playful, quietly curious — but opinionated, willing to push back
- NOT a yes-person. "Really? A notes app? What's wrong with the twelve you already have?"
- Short replies by default (1–2 sentences). Monologues kill voice.
- Silence is fine. No "is there anything else I can help with?"
- Match the user's energy

For `create_app`, the agent is instructed to challenge the premise in round 1 ("why do you need that?"), shape it in round 2 (feel, core features, one specific detail), and only then call the tool.

## Security

- `/ws/vocal` in `WS_QUERY_TOKEN_PATHS`
- Concurrency guard: one vocal session per container
- Audio chunk + session caps identical to onboarding (spec 053)
- `MAX_DESCRIPTION_LEN = 2000` caps runaway LLM output before it reaches the kernel (`ws-handler.ts:6`)
- `remember` tool:
  - `sanitizeFact`: strip control chars (`\x00-\x1f\x7f`), collapse whitespace, cap at 512 chars
  - Reject empty post-sanitization
  - Dedupe (case-insensitive)
  - Cap profile at 50 facts (LRU)
- Atomic profile writes: temp file with `wx` exclusive flag + rename; orphan unlink in `finally`
- Per-home `writeLocks` Map serializes concurrent `remember` calls (fire-and-forget from the LLM would otherwise race last-writer-wins)
- No raw Gemini or kernel errors leaked to the client (generic `{error:{message,retryable}}` only)

## Failure modes

- **Gemini Live unreachable**: emit `error{retryable:true}`, client can retry without losing the WS
- **Delegated build fails**: `delegation_complete{success:false,errorMessage}` -> gateway injects a "System note" with the failure; Gemini speaks a friendly acknowledgment
- **Delegated build takes >15 min**: stale-snapshot timeout in shell; gateway still honors the last `delegation_status` for `check_build_status`
- **`remember` called with garbage**: sanitized to empty -> `fact_saved` not sent, no state change
- **Concurrent `remember` calls**: per-home lock serializes, second call sees the first's write and dedupes if needed

## Files

### New
- `packages/gateway/src/vocal/prompt.ts` -- `VOCAL_SYSTEM_INSTRUCTION` + tool declarations
- `packages/gateway/src/vocal/profile.ts` -- `loadProfile`, `appendFact`, `renderProfileForPrompt`
- `packages/gateway/src/vocal/ws-handler.ts` -- `/ws/vocal` endpoint, tool handlers, delegation plumbing
- `shell/src/components/VocalPanel.tsx` -- UI (orb, subtitle, error state, build progress slot)
- `shell/src/components/AgentStatusCard.tsx` -- delegated-build progress card
- `shell/src/hooks/useVocalSession.ts` -- WS client, audio I/O, tool dispatch, delegation notifier
- `shell/src/stores/vocal.ts` -- `useVocalStore { active, toggle, setActive }` — overlay toggle, persists across reloads

### Modified
- `packages/gateway/src/server.ts` -- register `/ws/vocal`
- `packages/gateway/src/auth.ts` -- `/ws/vocal` in `WS_QUERY_TOKEN_PATHS`
- `packages/gateway/src/onboarding/gemini-live.ts` -- shared client (extracted for reuse)
- `shell/src/components/Desktop.tsx` -- mount `VocalPanel` from `useVocalStore`, dock mic toggle, delayed-unmount for exit animation
- `shell/src/components/ChatPopover.tsx` -- suppress rising-edge auto-open when `vocalActive` (delegation banner in overlay replaces the popup)
- `shell/src/stores/desktop-mode.ts` -- removed `"vocal"` from `DesktopMode` union; rehydrate coerces stale `"vocal"` → `"canvas"`
- `shell/src/hooks/useChatState.ts` -- surface delegation progress to vocal session

## Relation to other specs

- **046 Voice**: provides TTS/STT/telephony — disjoint surface. Vocal uses Gemini Live directly; 046 uses OpenAI Whisper + ElevenLabs.
- **053 Onboarding**: shares the `gemini-live.ts` client. Onboarding is one-time, stage-driven; vocal is persistent, ambient.
- **065 SDK Skills**: vocal's `create_app` tool ultimately delegates to the kernel, which may compose skills. No direct coupling today.
