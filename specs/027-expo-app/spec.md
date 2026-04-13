# 027: Expo Mobile App

**Status**: v2 — Phase A–D shipped (chat + mission control + settings + push), now expanding to Apps, Files, Integrations, Voice, and the post-053 auth model. **Cloud-only** — self-hosted gateway support is dropped.
**Created**: 2026-02 (hackathon)
**Last updated**: 2026-04-12
**Depends on**: 030 (settings), 034 (observability), 038 (app platform), 046 (voice), 048 (file browser), 049 (platform integrations), 050 (app data layer), 052 (memory), 053 (onboarding + single-domain routing), 057 (shell UI refactor), 058 (app gallery), 063 (react app runtime — blocks apps tab)
**Supersedes pieces of**: 027 v1 assumed per-handle subdomains, Expo SDK 52, 3-tab shell, push as an afterthought, and a dual cloud/self-hosted connect screen.

## Problem (restated)

Matrix OS is still only really reachable through the web shell. The hackathon version of this spec (v1) shipped a 3-tab Expo app (Chat / Mission Control / Settings) against the Expo SDK 52 gateway of Jan 2026. Since then the platform has moved fast:

1. **Auth moved to a single domain.** Spec 053 replaced per-handle subdomains (`hamedmp.matrix-os.com`) with `app.matrix-os.com` + Clerk session-based routing. The mobile v1 connection model (paste a subdomain URL) is obsolete for the cloud case.
2. **Apps became the primary surface.** Specs 038, 039, 058, 060, 063, 064 turned Matrix OS into an app platform with static / Vite / Node runtimes, an app gallery, and 11+ default apps. The mobile app has no way to see or launch them.
3. **Files are now a first-class citizen.** Spec 048 shipped a finder-grade file browser with preview, search, and trash — the mobile app has no file access at all.
4. **Platform integrations went live.** Spec 049 landed Pipedream Connect (Gmail, Calendar, Drive, GitHub, Slack, Discord, 3,000+ services). Users need to manage these from their phone.
5. **Terminal is real.** Specs 047 and 056 shipped a Warp-grade terminal with persistent PTY sessions. Mobile has none.
6. **Voice is half-shipped.** Spec 046 Phases A–E are complete (STT, TTS, Twilio telephony). Mobile v1 mentions voice input as a bullet but never wires it.
7. **Memory is Postgres-backed and queryable.** Spec 052 replaced flat files with a hybrid FTS + pgvector memory store. The mobile "Agent" settings row still points at a static `soul.md` preview.
8. **The shell got a visual overhaul.** Spec 057 added neumorphic/retro themes, mesh gradients, dock animations. The mobile design system should track at least the tokens so the two surfaces feel like one OS.
9. **Observability, kernel logging, and usage tracking exist.** Specs 034 and 037 expose `/api/usage`, `/api/system/info`, `/api/security/audit` and Prometheus metrics. Mobile can surface health and spend.
10. **Social is landing.** Spec 041 is turning Matrix OS into a federated social layer (Matrix protocol, feed, follows). Mobile is a natural feed reader.

v1 also under-specified failure handling (Constitution IV) and never had a real security architecture section — spec quality gates now require both.

## What's already shipped (do not re-do)

As of 2026-04-12 `main`, the mobile app already has:

- Expo **SDK 55** project in `apps/mobile/` (React 19.2, RN 0.83, Expo Router v5, NativeWind 5 preview, Tailwind 4)
- Clerk auth (`@clerk/clerk-expo` 2.10) with Google OAuth and SecureStore token cache
- Biometric gate via `expo-local-authentication`
- `lib/gateway-client.ts` — typed WebSocket + HTTP client with exponential-backoff reconnect, bearer-token headers, and typed `ServerMessage` union
- `lib/offline.ts` — AsyncStorage message cache + outbound queue with retry-on-reconnect
- `lib/push.ts` — Expo Push Notifications registration + tap router
- `lib/auth.ts`, `lib/storage.ts`, `lib/theme.ts`
- Tabs shell (`Chat`, `Mission Control`, `Settings`) with blur tab bar and connection dot header
- Chat screen: streaming text, tool start/end, typing indicator, empty-state suggestions, unread-tab-badge, infinite scroll stub, kernel:error handling
- Mission Control: task list, filter chips, swipeable complete/delete, cron section, pull-to-refresh
- Settings: gateway list, channel badges, biometric toggle, theme picker (system/light/dark), version, AI profile fetch
- Connect screen, welcome (`index.tsx`), sign-in modal
- Components: `ChatMessage`, `InputBar`, `ConnectionBanner`, `GatewayCard`, `ChannelBadge`, `TaskCard`, `TaskDetail`
- Gateway-side push adapter at `packages/gateway/src/channels/push.ts` with token store and Expo Push HTTP send
- EAS `eas.json` with development/preview/production profiles, bundle id `com.matrixos.mobile`
- Jest + `@testing-library/react-native` wired up with 7 component unit tests

Anything below that references these is a **modify**, not a **create**.

## Non-goals (v2)

- **Self-hosted gateway support.** Dropped in v2. The mobile app is cloud-only, targets `app.matrix-os.com`, and requires a Clerk account. Users who run their own gateway can still use the web shell. No manual URL entry, no bearer-token pasting, no QR pairing for LAN — these are all removed from the connect screen, storage layer, and gateway client. One of the v2 chores is to delete the v1 multi-gateway UI and schema.
- Full offline-first local kernel (no Agent SDK on device)
- Native Android/iOS widgets beyond the standard notification surface
- Background audio telephony handoff (route through gateway voice pipeline only)
- Replacing the shell's app runtime — mobile uses the gateway's reverse-proxied app URLs via in-app WebView, not a native runtime
- Matrix protocol client library in-app — federated messaging goes through the gateway's Matrix adapter, not a native SDK

## Solution (v2)

### Cloud-only auth flow

Aligns with spec 053. There is exactly one path to connect:

1. User signs in with Clerk (Google, email, Apple — whatever Clerk has configured)
2. App fetches `GET https://app.matrix-os.com/api/session/resolve` with the Clerk JWT in `Authorization: Bearer ...`
3. The gateway resolves the Clerk `userId` to the user's container and returns `{ wsUrl: "wss://app.matrix-os.com/ws", httpUrl: "https://app.matrix-os.com" }`. No secondary bearer token is returned — the Clerk JWT itself is the auth credential on every subsequent HTTP and WS call.
4. App caches the resolved URLs in memory (not SecureStore — the JWT is short-lived and Clerk already has its own secure token cache) and connects the WS
5. On background→foreground transitions, the JWT is refreshed via `useAuth().getToken()` and the WS reconnects with the new token

**There is no manual URL entry, no paste-a-token flow, and no multi-gateway list.** The old connect screen, `lib/storage.ts` gateway persistence, and `lib/auth.ts` bearer-token path are removed as part of Phase E.

**Auth header**: `Authorization: Bearer <clerkJwt>` on every HTTP request; `wss://.../ws?token=<clerkJwt>` on the WebSocket handshake. Gateway middleware verifies the JWT against Clerk's JWKS on every request (already implemented for the shell).

### Tab structure (v2)

Five tabs instead of three:

```
┌─ Chat ─────────────┐   (existing, extended)
├─ Apps ─────────────┤   (NEW — app launcher + gallery)
├─ Mission Control ──┤   (existing, extended with integrations + usage)
├─ Files ────────────┤   (NEW — finder-lite)
└─ Settings ─────────┘   (existing, extended)
```

Optional overflow drawer for `Terminal`, `Memory`, `Social`, and `Hermes` screens so the tab bar stays tight on smaller phones.

### New surface: Apps tab

Matches specs 038 / 039 / 058 / 060 / 063 / 064.

- **Data source**: `GET /api/apps` (already exposed) → list of installed apps with `slug`, `name`, `icon`, `runtime` (`static` | `vite` | `node`), `url`, `manifest`
- **Launch behavior**: tap an app → open inside an in-app WebView rooted at the gateway's app URL (`{gatewayUrl}/apps/{slug}/` or the proxied `node` runtime URL). WebView carries the session cookie / bearer token so `MatrixOS.*` bridge APIs work.
- **Bridge parity**: mobile exposes a `postMessage` shim for `MatrixOS.db.*`, `MatrixOS.openApp`, and theme injection (spec 050 bridge + spec 063 theme injection) via `RNWebView.onMessage` — same contract as the shell
- **Gallery**: secondary view "Install more apps" that renders the in-browser gallery URL (from spec 058) in the same WebView
- **Lifecycle**: `node`-runtime apps trigger a lazy start on the gateway on first open; the mobile app shows a spinner on the WebView until `/health` returns 200
- **Context menu**: long-press an app → rename, remove, share link (`share: 'matrix-os.com/apps/{slug}'`), regenerate icon
- **Default apps bootstrap**: on first run after connect, if `GET /api/apps` is empty and the gateway reports `defaultAppsSeeded=false`, show the spec-060 connected-life onboarding (Gmail + Calendar + Spotify) inline via WebView to the shell's `/onboarding/connect` route

### New surface: Files tab

Matches spec 048 scope but compressed for mobile:

- `GET /api/files/tree`, `/list`, `/stat`, `/search` (all already exposed)
- Views: list (default), grid (icons) — column view is shell-only
- Quick preview for markdown (rendered), code (syntax-highlighted via `react-native-syntax-highlighter`), images, PDF (via `expo-file-system` + `react-native-pdf`), audio/video (`expo-av`)
- Full-text search bar at top
- Create/rename/delete/trash via `POST /api/files/*`
- Share sheet integration (`expo-sharing`) for exporting files out of Matrix OS to native apps
- Upload from camera roll or Files provider into `~/downloads/` via `PUT /files/*`
- **No** inline editing in v2 (tap code file → "Open in Code Editor app" deep-links to the Apps tab)

### New surface: Terminal screen (overflow / Settings → Terminal)

Matches specs 047 + 056 for read-mostly use:

- WebView wrapping the shell's `/terminal` route (PTY session lives on the gateway, xterm.js renders in the embedded browser)
- Hardware keyboard passthrough, bottom key row (Esc / Tab / Ctrl / arrows) for on-screen typing
- Supports session reattach via URL param (`?sessionId=...`), so a Claude Code session started on desktop resumes on phone
- No native xterm reimplementation — the gateway is the source of truth

### New surface: Integrations (Settings subsection)

Matches spec 049:

- `GET /api/integrations` + `GET /api/integrations/catalog` (Pipedream Connect)
- List connected services (Gmail, Calendar, Drive, GitHub, etc.) with last-used timestamps and scopes
- Connect flow: tap a service → `WebBrowser.openAuthSessionAsync()` against the Pipedream OAuth URL from the gateway → callback → refresh list
- Disconnect with confirmation
- Deep link from default apps (Inbox, Calendar, Player) when auth lapses

### New surface: Memory viewer (Settings subsection)

Matches spec 052:

- `GET /api/memory/search?q=...` + `/api/memory/recent` (new routes — spec 052 has the DB, mobile needs the read surface; add them server-side as part of this spec's tasks)
- Shows top-N user facts / preferences / instructions pulled from the hybrid FTS+pgvector store
- Read-only in v2; "Forget this" action is a follow-up

### New surface: Usage + health (Settings → System)

Matches specs 034 + 037:

- `GET /api/usage` → rolling spend + token counts
- `GET /api/system/info` → container health, uptime, versions
- `GET /api/security/audit` → recent security events badge (non-zero = red dot on Settings tab)
- Small sparkline of daily usage via `react-native-svg`

### Voice (finish what v1 promised, integrate with spec 046)

- **STT**: mic button in `InputBar` → record via `expo-av` → `POST /api/voice/stt` (spec 046 Phase B route) → transcript fills input
- **TTS**: assistant message long-press → "Read aloud" → `POST /api/voice/tts` → stream mp3 → `expo-av` playback
- **Push-to-talk UX**: hold mic for continuous recording, release to send; haptic tick on start/stop (`expo-haptics`)
- **No local Whisper** — gateway handles STT/TTS provider fallback chain (ElevenLabs → OpenAI → Edge)

### Design system (track spec 057)

- Import token values from the shell's `globals.css` + `lib/theme-presets.ts` into `apps/mobile/lib/theme.ts` at build time (script: `scripts/sync-theme-tokens.ts`)
- Expose theme presets: `matrix-default`, `retro` (neumorphic + sage green), `win98`, `high-contrast`
- Dark-mode variants mirror shell
- `expo-blur` BlurView already used for tab bar; extend to InputBar background on iOS (Android falls back to solid `bg-card/95`)
- Mesh gradient backgrounds on empty states via `react-native-skia` or `expo-linear-gradient` fallback

### Push notifications (extend)

The push adapter in `packages/gateway/src/channels/push.ts` ships tokens today but only routes agent messages. Extend to:

- **Categories**: `message`, `task`, `cron`, `security`, `integration`, `app`, `voice`
- **Per-category opt-in** stored under `~/system/config.json` → `notifications.mobile.{category}: bool`
- **Server-side quiet hours** respected from user settings
- **Rate limit**: already exists, raise cap to 60/min/user and add per-category sub-caps
- **Notification tap** routes via `NotificationRouter` in `app/_layout.tsx`:
  - `message` → Chat (switch session if different)
  - `task` → Mission Control, open task detail
  - `cron` → Mission Control → Scheduled section
  - `security` → Settings → System → Security audit
  - `integration` → Settings → Integrations, scroll to broken one
  - `app` → Apps → deep-link to app slug

### Security architecture (required by quality gates)

| Surface | Threat | Control |
|---|---|---|
| Gateway connect | MITM / downgrade | TLS-only. The app hard-codes `https://app.matrix-os.com` and `wss://app.matrix-os.com/ws` — there is no way to point it at an arbitrary host, so there is nothing to validate at runtime. |
| Clerk JWT at rest | Device theft | Clerk token cache (SecureStore-backed) + biometric gate on app open. Nothing else is persisted. |
| WebView bridge | Token leak via injected JS | `injectedJavaScriptBeforeContentLoaded` sets origin allowlist to `app.matrix-os.com` only; `onShouldStartLoadWithRequest` blocks any non-matrix-os.com navigation. |
| File uploads | Oversized / traversal | Client caps (25 MB, 50 MB for audio); server `PUT /files/*` already has `fileBodyLimit` + `resolveWithinHome` |
| Push tokens | Stale per-device tokens | Gateway prunes tokens that return `DeviceNotRegistered` on Expo Push response |
| Voice uploads | Cost runaway | Client caps recording to 60 s, uses `AbortSignal.timeout(30_000)` on upload |
| Clerk JWT in transit | Token reuse after sign-out | `useAuth().signOut()` clears token cache + disconnects WS. No bearer-token pool to sweep since none is stored. |
| Integrations OAuth | Session fixation in `WebBrowser.openAuthSessionAsync` | Use PKCE, verify state param, reject if returned URL origin is not `app.matrix-os.com` |

No wildcard CORS (gateway already enforces); client only ever talks to `app.matrix-os.com`.

### Failure modes

| Condition | Behavior |
|---|---|
| WS dies silently (backgrounded app throttled) | `AppState` listener forces reconnect on foreground; heartbeat ping every 25 s while foreground |
| Clerk session expired mid-use | 401 on WS handshake or HTTP call → `useAuth().getToken()` refresh, one retry; still 401 → surface re-sign-in modal, keep outbound queue |
| Container cold-starting (`node` app runtime) | Spinner + "Waking up…" copy; retry `/health` with 500 ms jitter up to 30 s |
| No network on send | Queue via `lib/offline.ts` (already shipped); UI shows banner and badge count |
| Push token invalidated | Re-register on next foreground, gateway removes dead token |
| Large file upload on cellular | Warn + let user continue; use `expo-file-system` `uploadAsync` with progress |
| Biometric not enrolled | Fall back to passcode (`LocalAuthentication.AuthenticationType.PASSCODE`), then Clerk password re-auth |
| Clerk sign-out completed | Disconnect WS, clear in-memory gateway URLs, route to `/sign-in` |

### Resource management

- **AsyncStorage caps**: cap message cache at 500 messages (ring buffer in `lib/offline.ts`), outbound queue at 50
- **WebView pool**: at most 2 live WebViews (current app + previous); older get `webViewRef.stopLoading()` + unmount
- **Audio recording**: hard cap 60 s, release `Recording` on any error
- **FlatList windowing**: `windowSize={10}`, `removeClippedSubviews={true}`, `maxToRenderPerBatch={15}` on chat and file lists
- **Clerk token cache**: bounded by Clerk SDK (single active session), no per-gateway fan-out

### Integration wiring (this spec touches)

- `packages/gateway/src/server.ts` — add `/api/memory/*`, `/api/integrations/*` (mobile read path), `/api/session/resolve` (Clerk → `{wsUrl, httpUrl}`), ensure all existing routes accept Clerk JWT on both HTTP and WS
- `packages/gateway/src/channels/push.ts` — category + quiet hours + rate sub-caps
- `packages/kernel/src/hooks.ts` — emit push on task completion, cron result, security event
- `apps/mobile/lib/gateway-client.ts` — **constructor takes `getToken` closure instead of a static bearer**; add `getApps`, `listFiles`, `searchFiles`, `getUsage`, `getIntegrations`, `getMemory`, `getSystemInfo`, `voiceSttUpload`, `voiceTtsFetch`
- `apps/mobile/app/(tabs)/_layout.tsx` — 5 tabs
- `scripts/sync-theme-tokens.ts` — shell → mobile token sync

### File locations (delta from v1)

```
apps/mobile/
  app/
    _layout.tsx                       # MODIFY: Clerk-only gateway context; drop bearer path
    index.tsx                         # MODIFY: welcome → sign-in (no manual connect option)
    connect.tsx                       # DELETE
    sign-in.tsx                       # MODIFY: on success, resolve session and enter tabs
    (tabs)/
      _layout.tsx                     # MODIFY: 5 tabs
      chat.tsx                        # MODIFY: voice STT/TTS wiring, AppState reconnect
      apps.tsx                        # NEW: app grid + launch WebView
      mission-control.tsx             # MODIFY: integrations strip, usage sparkline
      files.tsx                       # NEW: file browser
      settings.tsx                    # MODIFY: drop Gateways section; add Integrations, Memory, System
    app/[slug].tsx                    # NEW: WebView host for a single app (dynamic route)
    terminal.tsx                      # NEW: WebView terminal host
    memory.tsx                        # NEW (overflow): memory viewer
  components/
    AppCard.tsx                       # NEW
    AppWebView.tsx                    # NEW (bridge shim, origin allowlist)
    FileRow.tsx                       # NEW
    FilePreview.tsx                   # NEW
    IntegrationRow.tsx                # NEW
    UsageSparkline.tsx                # NEW
    VoiceRecorder.tsx                 # NEW
    GatewayCard.tsx                   # DELETE
    InputBar.tsx                      # MODIFY: mic button wiring
  lib/
    gateway-client.ts                 # MODIFY: token-getter closure; new methods; drop multi-gateway
    session-resolver.ts               # NEW: Clerk JWT → { wsUrl, httpUrl }
    app-bridge.ts                     # NEW: RNWebView postMessage bridge for MatrixOS.*
    voice.ts                          # NEW: record, upload, playback helpers
    theme-tokens.ts                   # NEW: generated from shell tokens
    storage.ts                        # DELETE (gateway list is gone; per-app prefs move into a tiny prefs.ts if still needed)
    offline.ts                        # MODIFY: ring-buffer cap
    push.ts                           # MODIFY: category-aware routing
    auth.ts                           # MODIFY: biometric gate only; drop bearer helpers
  scripts/
    sync-theme-tokens.ts              # NEW
  __tests__/
    session-resolver.test.ts          # NEW
    app-bridge.test.ts                # NEW
    files.test.tsx                    # NEW
    voice.test.ts                     # NEW
```

## Success criteria

1. A fresh install: sign in with Clerk on device → lands in Chat tab connected to `app.matrix-os.com` without typing a URL
2. Apps tab shows the 11 default apps + any installed via gallery; tapping one launches a functional WebView with theme synced
3. Files tab browses `~/`, previews a markdown file, searches for a filename, restores a trashed file
4. Integrations tab: connect Gmail via OAuth in-app, see it listed, agent successfully uses it in a chat turn triggered from the phone
5. Hold-mic voice input transcribes via gateway and sends; assistant reply is read aloud
6. Push notification for a completed cron job taps through to the right Mission Control section
7. Offline for 5 minutes, type 3 messages, come back online — all three reach the agent in order
8. Security: revoke Clerk session on desktop → mobile surfaces a re-auth prompt within 30 seconds, outbound queue preserved
9. Biometric lock gate passes on cold start; no kernel data visible before unlock
10. All new gateway routes return typed errors (no string catches), enforce bodyLimit, and return generic error messages (spec 025 patterns)

## Open questions

1. **In-app WebView vs external browser for apps** — some `node` apps may want camera / mic. v2 uses in-app WebView for the bridge and defers cam/mic to a follow-up spec.
2. **Hermes chat surface** — spec 061 landed the sidecar; mobile could add a second chat tab. Deferred to v3 unless the Hermes kernel stabilizes.
3. **Background sync** — iOS `BGTaskScheduler` / Android `WorkManager` for silent push memory sync. Nice to have; not blocking.
4. **App Store submission** — v2 still ships via TestFlight / internal track. Public store needs a privacy manifest, data safety form, and age rating — separate spec.
5. **Social tab** — spec 041 is mid-flight; mobile social should wait for feed API stability and be a v3 tab.
