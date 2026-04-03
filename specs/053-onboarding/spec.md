# Spec 053: Simple Onboarding + Platform Routing

## Overview

Minimal onboarding: Clerk handles signup/username, first-run screen collects API key or directs to Terminal for Claude Code. All users access their instance via `app.matrix-os.com` with session-based routing (no per-user subdomains).

## Goals

- Clerk handles auth, username, and identity
- First-run screen: two paths (paste API key or use Claude Code in Terminal)
- BYOK: kernel reads API key from config.json per dispatch
- Single domain: `app.matrix-os.com` routes by Clerk session to correct container
- No voice, no Gemini, no interview -- ship fast, iterate later

## Non-Goals

- Voice onboarding (future -- spec preserved in git history)
- Profile extraction / persona matching (future)
- Credits/billing system (future)
- Per-user subdomains (replaced by session routing)

## User Flow

1. User signs up on `matrix-os.com/signup` via Clerk
2. Dashboard provisions container keyed by `clerkUserId`
3. Dashboard redirects to `app.matrix-os.com`
4. Platform routes by Clerk session cookie -> correct container
5. Shell detects first-run (no API key in config) -> shows setup screen
6. User chooses:
   - **"I have an API key"** -> paste, validate, store -> full kernel features enabled
   - **"Use Claude Code"** -> desktop loads, Terminal auto-opens with Claude Mode
7. Desktop loads

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

Shell checks if the kernel has an API key configured:

```
GET /api/settings/agent -> { identity, kernel: { anthropicApiKey?: string } }
```

If `kernel.anthropicApiKey` is falsy, show the setup screen. Cache in React ref on initial mount.

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

## Shell Setup Screen

Simple fullscreen component shown on first run. Two cards:

### Card 1: "Connect Your AI"
- Paste API key input (password-masked)
- Link to console.anthropic.com
- Validate button -> shows loading -> success/error feedback
- On success: dismiss screen, desktop loads with full features

### Card 2: "Use Claude Code"
- "Build apps with your existing Claude subscription"
- Opens Terminal in Claude Mode on click
- `CLAUDE.md` in home directory teaches Claude Code how to build Matrix OS apps
- Kernel features (chat, channels, heartbeat) disabled until API key added

### Design

- Centered layout with subtle background
- Matrix OS logo/name at top
- Two cards side by side (or stacked on mobile)
- Warm, simple copy -- not technical jargon
- Dismissible later via Settings if they want to add API key

## Security

- API key stored in `~/system/config.json` inside container volume (not accessible to other containers)
- API key validation server-side only (never sent to frontend after storage)
- Strip key from error logs
- Clerk session verification on platform routing (JWT signature check)
- Existing bearer token auth on gateway WebSocket unchanged

## Files

### New
- `packages/gateway/src/onboarding/api-key.ts` -- validate + store (already created)
- `shell/src/components/SetupScreen.tsx` -- first-run setup UI
- `tests/gateway/onboarding/api-key.test.ts`

### Modified
- `packages/gateway/src/routes/settings.ts` -- add `POST /api/settings/api-key`
- `packages/gateway/src/dispatcher.ts` -- BYOK key reading per dispatch
- `packages/platform/src/main.ts` -- session-based routing
- `distro/cloudflared.yml` -- add `app.matrix-os.com` route
- `www/src/app/dashboard/page.tsx` -- redirect to `app.matrix-os.com`
- `shell/src/components/Desktop.tsx` -- first-run detection
- `home/CLAUDE.md` -- add skills/knowledge references
