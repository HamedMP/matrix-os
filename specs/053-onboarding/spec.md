# Spec 053: Voice-First Onboarding + Platform Routing

## Status: Voice-First Implementation Complete (branch `feat/onboarding-voice`)

## Overview

Voice-first onboarding: a conversational AI greets the user on landing, asks a few short questions, and collects the API key by voice. Falls back to text mode if the mic is denied or Gemini Live is unreachable. Clerk handles signup/username separately; platform routing uses the single `app.matrix-os.com` domain with session-based lookup (no per-user subdomains).

Implementation plan: [`plan.md`](./plan.md). Task checklist: [`tasks.md`](./tasks.md).

## Goals

- Voice-first conversation driven by Gemini Live (model `gemini-2.5-flash-preview-native-audio-dialog`)
- Voice agent asks questions *before* explaining — no monologue, no brochure tone
- Extract profile (interests, role, pain points) to personalize the desktop
- Collect API key in-conversation (paste or read out loud), validate server-side
- Text-mode fallback: if mic denied or Gemini unreachable, same state machine drives a text chat
- BYOK: kernel reads API key from `~/system/config.json` per dispatch (not cached)
- Single domain: `app.matrix-os.com` routes by Clerk session to the correct container
- Post-onboarding landing: Moraine Lake wallpaper + minimal desktop on first paint

## Non-Goals

- Telephony onboarding (Twilio) — covered by spec 046
- Profile extraction beyond what Gemini can infer from one conversation
- Credits/billing system (future)
- Per-user subdomains (replaced by session routing)

## User Flow

1. User signs up on `matrix-os.com/signup` via Clerk
2. Dashboard provisions container keyed by `clerkUserId`
3. Dashboard redirects to `app.matrix-os.com`
4. Platform routes by Clerk session cookie -> correct container
5. Shell detects first-run (no `~/system/onboarding-complete.json`) -> shows `OnboardingScreen`
6. **Landing** (`OnboardingScreen`): shimmer logo, fade, "Enter Matrix OS" button
7. **Mic permission** (`MicPermissionDialog`): request mic; on deny -> text mode
8. **Conversation** (`VoiceOrb` + `useOnboarding`): voice orb pulses with audio levels, Gemini Live asks questions, transcript streams below
9. **API key** (`ApiKeyInput`): voice agent prompts for key; user pastes or speaks it; validated server-side with a minimal Anthropic call
10. **Complete**: write `~/system/onboarding-complete.json` (exclusive create), desktop loads on Moraine Lake wallpaper

## Stages (state machine)

`landing -> permission -> greeting -> interview -> api_key -> done`

Per-stage timeouts: greeting 60s, interview 10min, api_key 5min. Max total session: 15 min. State persists to `~/system/onboarding-state.json` after each completed stage so refresh can resume.

## Platform Routing (app.matrix-os.com)

### Current Architecture (Per-User Subdomains)

```
alice.matrix-os.com -> platform:9000 -> extract "alice" from hostname -> matrixos-alice
bob.matrix-os.com   -> platform:9000 -> extract "bob" from hostname -> matrixos-bob
```

Problems: wildcard DNS, Clerk cookies broken across subdomains, container rename complexity.

### New Architecture (Single App Domain)

```
matrix-os.com       -> Vercel (www: landing, signup, dashboard)
app.matrix-os.com   -> platform:9000 -> Clerk session -> lookup container -> proxy
api.matrix-os.com   -> platform:9000 (admin API, unchanged)
```

### Routing Logic

When a request hits `app.matrix-os.com`:

1. Platform checks if host matches `app.matrix-os.com` or `app.localhost`
2. Extracts Clerk session from `__session` cookie (domain: `.matrix-os.com`)
3. Verifies JWT, gets `clerkUserId`
4. Looks up container via `getContainerByClerkId(db, clerkUserId)`
5. If no session: redirect to `matrix-os.com/signup`
6. If no container: redirect to `matrix-os.com/dashboard`
7. If container stopped: auto-wake
8. Route by path:
   - `/api/*`, `/ws/*`, `/files/*`, `/modules/*`, `/health` -> container gateway (port 4000)
   - Everything else -> container shell (port 3000)

### Changes Required

**`packages/platform/src/main.ts`:**
- Add session-based routing middleware BEFORE existing subdomain router
- Use `@clerk/backend` to verify `__session` cookie JWT
- Add `'app'` to the subdomain skip list so `app.matrix-os.com` doesn't match as a handle
- Keep existing subdomain routing as fallback (backward compat)

**`distro/cloudflared.yml`:**
- Add `app.matrix-os.com -> platform:9000` route before the wildcard

**`www/src/app/dashboard/page.tsx`:**
- Change "Open Matrix OS" link from `https://{handle}.matrix-os.com` to `https://app.matrix-os.com`

**Clerk Configuration:**
- Set cookie domain to `.matrix-os.com` so cookies are shared between `matrix-os.com` and `app.matrix-os.com`

### WebSocket Routing

WebSocket upgrades (`/ws`, `/ws/voice`, `/ws/terminal`) follow the same session-based routing. The platform:
1. Extracts Clerk session from cookie on the HTTP upgrade request
2. Looks up container
3. Proxies the WebSocket to the container's gateway port

## First-Run Detection

Shell calls `GET /api/files/stat?path=system/onboarding-complete.json` on initial mount. 404 -> render `OnboardingScreen`; 200 -> render desktop. Cache in a React ref so StrictMode double-mount doesn't re-check. Retry 3x with 1s delay if the gateway is unreachable (for the post-rename reconnect window).

An API key alone no longer gates the setup screen — onboarding may complete without a key (e.g., the Claude Code activation path). `GET /api/settings/agent` is still used later, from Settings, to show whether a key is set.

## API Key Collection

### Gateway Endpoint

Add to settings routes (`/api/settings/api-key`):

```
POST /api/settings/api-key
Body: { apiKey: "sk-ant-..." }
Response: { valid: true } or { valid: false, error: "Key validation failed" }
```

Steps:
1. Validate format: starts with `sk-ant-`
2. Test with minimal Anthropic API call (`AbortSignal.timeout(10_000)`)
3. Strip API key from errors before logging
4. If valid: store in `~/system/config.json` under `kernel.anthropicApiKey`
5. Return generic error on failure (never expose Anthropic's response)

### BYOK Kernel Support

Dispatcher reads `config.kernel.anthropicApiKey` from `~/system/config.json` on every dispatch call. If present, temporarily sets `process.env.ANTHROPIC_API_KEY` for the kernel subprocess, restores after.

## Shell Onboarding Screen

Fullscreen takeover, no dock/chrome. Stage-aware rendering via `OnboardingScreen.tsx`:

- **Landing**: shimmer-animated "Matrix OS" wordmark, single "Enter Matrix OS" button. Fades into the next stage.
- **Mic permission**: `MicPermissionDialog` explains why the mic is needed. Deny -> text mode, no dead-end.
- **Conversation**: `VoiceOrb` + `VoiceWave` pulse with real-time audio levels. Transcript fades in and out below the orb. No app-suggestion cards or persona panels (cut — the voice agent is enough).
- **API key**: `ApiKeyInput` appears when the agent reaches the key stage. Password-masked paste input, link to console.anthropic.com, generic error feedback.
- **Done**: `~/system/onboarding-complete.json` written, desktop loads on `moraine-lake` wallpaper preset.

### Design principles

- Warm, minimal, not technical. Conversational over instructional.
- Rework (commit `a7f1fbb`): voice agent asks questions *before* explaining. "What's bringing you here?" beats "Welcome to Matrix OS, the Web 4 operating system…"
- Silence is fine. No "is there anything else?" prompts.
- Transient UI only — no layout shift when the agent speaks or listens.

## Security

- `/ws/onboarding` requires a query-param token (in `WS_QUERY_TOKEN_PATHS`), same as other WS endpoints
- Concurrent onboarding connections rejected (one session per container)
- Audio chunks: reject > 256 KB, cumulative cap 50 MB per session
- JSON message size: reject > 64 KB
- API key stored in `~/system/config.json` inside container volume only
- API key validation server-side only; strip key from error logs (log HTTP status, never the key)
- Generic error to client (`"Key validation failed"`) — never surface Anthropic's response
- Clerk session verification on platform routing (JWT signature check)
- No raw error messages from Gemini or ffmpeg leaked to the client
- Existing bearer token auth on gateway WebSocket unchanged

## Failure modes

- **Gemini Live unreachable** (3 connection retries with exponential backoff fail): emit `mode_change` to text mode, continue with same state machine and Gemini REST
- **Mic permission denied**: switch to text mode immediately, no retry
- **ffmpeg spawn failure**: emit `mode_change` to text mode
- **Silence timeout**: 30s triggers gentle prompt, 60s closes Gemini Live (session remains; user can reconnect)
- **Stage timeout**: closes the session with error, state file preserved so refresh can resume
- **Crash mid-onboarding**: `onboarding-state.json` lets the gateway resume from the last completed stage

## Files

### New (onboarding)
- `packages/gateway/src/onboarding/types.ts` -- Zod schemas, stage enum, error codes
- `packages/gateway/src/onboarding/state-machine.ts` -- typed transitions + per-stage timeouts
- `packages/gateway/src/onboarding/gemini-live.ts` -- Gemini Live WS client (shared with vocal, spec 066)
- `packages/gateway/src/onboarding/audio-codec.ts` -- ffmpeg streaming transcoder
- `packages/gateway/src/onboarding/ws-handler.ts` -- `/ws/onboarding` endpoint
- `packages/gateway/src/onboarding/extract-profile.ts` -- post-interview profile extraction
- `packages/gateway/src/onboarding/api-key.ts` -- validate + store
- `shell/src/components/OnboardingScreen.tsx` -- stage orchestrator
- `shell/src/components/MicPermissionDialog.tsx` -- permission primer
- `shell/src/components/onboarding/VoiceOrb.tsx` -- pulsing orb
- `shell/src/components/onboarding/VoiceWave.tsx` -- audio-level waveform
- `shell/src/components/onboarding/ApiKeyInput.tsx` -- key input UI
- `shell/src/hooks/useOnboarding.ts` -- WS client + state management
- `shell/src/hooks/useMicPermission.ts` -- mic permission helper
- `shell/public/audio-worklet-processor.js` -- raw PCM capture (no `btoa` in worklet context)

### Modified
- `packages/gateway/src/server.ts` -- register `/ws/onboarding`
- `packages/gateway/src/auth.ts` -- add `/ws/onboarding` to `WS_QUERY_TOKEN_PATHS`
- `packages/gateway/src/routes/settings.ts` -- `POST /api/settings/api-key`
- `packages/gateway/src/dispatcher.ts` -- BYOK key reading per dispatch
- `packages/platform/src/main.ts` -- session-based routing
- `distro/cloudflared.yml` -- add `app.matrix-os.com` route
- `www/src/app/dashboard/page.tsx` -- redirect to `app.matrix-os.com`
- `shell/src/components/Desktop.tsx` -- first-run detection, post-onboarding wallpaper
- `home/CLAUDE.md` -- skills/knowledge references
