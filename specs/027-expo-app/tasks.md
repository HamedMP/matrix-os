# Tasks: Expo Mobile App

**Spec**: spec.md (v2) | **Plan**: plan.md
**v1 task range**: T870-T899 (Phase A-D — shipped on main)
**v2 task range**: T2150-T2195 (Phase E-L — new scope)

## User Stories

### v1 (shipped)

- **US39**: "I can chat with my Matrix OS agent from my phone"
- **US40**: "I can manage tasks and see my dashboard on mobile"
- **US41**: "I get push notifications when my agent completes something important"
- **US42**: "The app looks and feels like Matrix OS -- same warmth, same design"
- **US43**: "I can connect to my local or cloud gateway securely"

### v2 (new)

- **US44**: "I sign in with Clerk on my phone and land in my Matrix OS — no URL to type, no token to paste, no self-hosted option"
- **US45**: "I can browse and launch my Matrix OS apps from my phone"
- **US46**: "I can open files in my home directory, preview them, and upload photos"
- **US47**: "I can connect Gmail or Calendar to my agent from my phone"
- **US48**: "I can hold the mic to talk to my agent and have it read answers aloud"
- **US49**: "I can attach to a running terminal session (like Claude Code) from my phone"
- **US50**: "I can see my token spend, system health, and recent memories on mobile"
- **US51**: "Push notifications for tasks, cron results, and security alerts route to the right screen"

### v1 stories retired in v2

- ~~**US43**: "I can connect to my local or cloud gateway securely"~~ — replaced by **US44**. Self-hosted support is removed; the app is cloud-only against `app.matrix-os.com`.

---

## Phase A: Project Setup (T870-T874) — SHIPPED

### T870 [US42] Expo project scaffold
- [x] Create `apps/mobile/` with `npx create-expo-app@latest --template tabs`
- [x] TypeScript strict mode (`tsconfig.json` strict: true)
- [x] Expo Router v5 (upgraded from v4), file-based routing
- [x] NativeWind v5 preview + Tailwind CSS v4 setup
- [x] ESLint + Prettier matching project conventions
- [x] Expo SDK upgraded 52 → 54 → 55
- **Output**: Clean Expo project that builds and runs ✓

### T871 [US42] Design system -- theme + fonts
- [x] Create `apps/mobile/lib/theme.ts` -- tokens from specs/design-guide.md
- [x] Colors: background (#ece5f0), card (#ffffff), primary (#c2703a), border (#d8d0de)
- [x] Load Inter via `@expo-google-fonts/inter`
- [x] Load JetBrains Mono via `@expo-google-fonts/jetbrains-mono`
- [x] Dark mode variant
- [x] Glass-morphism: `expo-blur` BlurView for tab bar backdrop
- [x] System theme detection (`useColorScheme()`)
- **Output**: Native design system matching the web shell ✓
- **Deferred to Phase K**: Full preset support (`retro`, `win98`) — see T2190

### T872 [US43] Gateway client library
- [x] WebSocket connection (`/ws` endpoint)
- [x] HTTP client for REST endpoints
- [x] Auto-reconnect with exponential backoff
- [x] Bearer token auth header injection
- [x] Connection state: connecting / connected / disconnected / error
- [x] Typed `ServerMessage` discriminated union
- **Output**: Reusable gateway client ✓

### T873 [US43] ~~Gateway connection screen~~ — REMOVED in v2
- [x] `apps/mobile/app/connect.tsx` (shipped in v1; **deleted in T2153**)
- Self-hosted support is dropped in v2. The connect screen, multi-gateway storage, and bearer-token path are all removed.
- **Migration**: see T2150-T2154 for the Clerk-only replacement.

### T874 [US43] Auth -- Clerk + biometric
- [x] `@clerk/clerk-expo` integration with Google OAuth
- [x] Biometric lock gate with `expo-local-authentication`
- [x] Setting to enable/disable biometric lock
- [x] Auth state persisted across app restarts (SecureStore token cache)
- **Output**: Secure app access ✓

---

## Phase B: Chat Screen (T875-T880) — MOSTLY SHIPPED

### T875 [US39] Chat message list
- [x] `apps/mobile/app/(tabs)/chat.tsx`
- [x] FlatList inverted (newest at bottom)
- [x] Message bubbles: user / assistant / tool / system
- [x] Timestamps
- [x] Scroll to bottom on new message
- [x] Pull to load older messages (`onEndReached` + `getMessages`)
- [x] Streaming chunk coalescing into the latest assistant bubble
- [x] Unread-tab-badge when app is backgrounded
- [x] Empty-state suggestions
- **Output**: Message list matching shell's ChatPanel ✓

### T876 [US39] Chat input bar
- [x] `apps/mobile/components/InputBar.tsx`
- [x] Matches shell design: rounded border, card bg, blur backdrop
- [x] TextInput with auto-grow
- [x] Send button (terracotta primary) -- disabled when empty
- [x] Keyboard avoiding view
- [ ] Mic button wiring (**moved to T2180**)
- **Output**: Chat input ✓

### T877 [US39] Streaming responses
- [x] WebSocket streaming: render chunks as they arrive
- [x] Typing indicator animation (three dots pulse via Reanimated)
- [x] Smooth scroll to latest chunk during streaming
- [x] Stream interruption handled via kernel:error
- **Output**: Real-time streaming chat ✓

### T878 [US39] Code blocks + syntax highlighting
- [x] Detect markdown code blocks
- [x] Render with JetBrains Mono, dark background
- [x] Language label badge
- [ ] Copy button (clipboard) (**moved to Phase G preview reuse**)
- [ ] Horizontal scroll for wide code (**deferred**)
- **Output**: Readable code in chat ✓ (basic)

### T879 [P] [US39] Image + file rendering
- [ ] Inline image rendering (from /files/* gateway endpoint)
- [ ] File attachment cards (name, size, download button)
- [ ] Image tap to full-screen view
- **Output**: Media in chat — **rolled into Phase G FilePreview component reuse (T2166)**

### T880 [P] [US39] Voice input
- [ ] Microphone button in InputBar
- [ ] Speech-to-text
- [ ] Hold-to-record pattern with haptic feedback
- [ ] Transcribed text auto-fills input
- **Output**: Hands-free input — **moved to Phase I (T2178-T2182)** against spec 046 routes

---

## Phase C: Mission Control + Settings (T881-T886) — MOSTLY SHIPPED

### T881 [US40] Task list screen
- [x] `apps/mobile/app/(tabs)/mission-control.tsx`
- [x] Fetch tasks from `GET /api/tasks`
- [x] Filter chips: All / Todo / In Progress / Done
- [x] Task cards: title, status badge
- [x] Pull to refresh
- [x] Swipe-to-complete / swipe-to-delete via Reanimated
- **Output**: Mobile task board ✓

### T882 [US40] Task detail bottom sheet
- [x] Tap task card → slide up detail sheet
- [x] Shows: title, description, status, assignee, created date
- [x] Mark complete / reopen actions
- [x] Swipe down to dismiss
- [ ] Full `@gorhom/bottom-sheet` refactor (current uses modal) — **optional polish**
- **Output**: Task detail ✓

### T883 [US40] Add task + cron overview
- [x] FAB → add task form
- [x] Task form: title, description, priority
- [x] POST `/api/tasks`
- [x] Cron section below tasks: `GET /api/cron`
- [x] Next run time parsing + status badges
- **Output**: Task creation and cron visibility ✓

### T884 [US42] Settings screen
- [x] `apps/mobile/app/(tabs)/settings.tsx`
- [x] ~~**Gateways**: list saved, add/remove/switch, connection status~~ — **removed in T2153** (self-hosted drop). Replaced by a single "Signed in as {email}" row and a sign-out button.
- [x] **Channels**: status badges from `/api/channels/status`
- [x] **Notifications**: toggle per notification type (category support → T2189)
- [x] **Security**: biometric lock toggle
- [x] **Appearance**: system/light/dark theme
- [x] **About**: version, link to matrix-os.com
- [ ] **Agent**: soul.md preview (replaced by Memory viewer in v2 → T2185)
- [ ] **Integrations** subsection (→ T2174)
- [ ] **Memory** subsection (→ T2174)
- [ ] **System** (usage + health + security audit) subsection (→ T2174)
- **Output**: Settings hub ✓ (expanding in v2)

### T885 [P] [US40] Channel status display
- [x] Fetch from `GET /api/channels/status`
- [x] Badge per channel: green/yellow/red/gray
- [ ] Tap channel → detail card with last message time, error details (**nice-to-have, deferred**)
- **Output**: Channel health ✓

### T886 [P] App navigation + tab bar
- [x] Bottom tab bar (3 tabs — expands to 5 in T2160)
- [x] Active tab: terracotta color, inactive: muted-foreground
- [x] Smooth transitions
- [x] Badge on Chat tab for unread messages
- **Output**: Polished navigation ✓ (expanding in v2)

---

## Phase D: Push Notifications + Polish (T887-T892) — MOSTLY SHIPPED

### T887 [US41] Expo Push Notifications -- mobile side
- [x] `expo-notifications` setup
- [x] Request notification permissions
- [x] Register Expo Push Token with gateway
- [x] Handle notification tap via `NotificationRouter`
- [ ] Category routing for task/cron/security/integration/app (**moved to T2188**)
- **Output**: Mobile receives push notifications ✓

### T888 [US41] Push notification channel adapter -- gateway side
- [x] `packages/gateway/src/channels/push.ts`
- [x] Implements ChannelAdapter interface
- [x] Stores push tokens per user
- [x] Sends via Expo Push API
- [x] Rate limiting
- [ ] Trigger on: task status change, cron result, security alert (**moved to T2187**)
- **Output**: Gateway can push to mobile ✓ (basic)

### T889 [P] App icon + splash screen
- [x] App icon: Matrix OS logo
- [x] Adaptive icon for Android
- [x] Splash screen: centered logo on lavender
- **Output**: Branded app presence ✓

### T890 [P] Build configuration (EAS Build)
- [x] `eas.json` with development, preview, and production profiles
- [x] iOS: bundle ID `com.matrixos.mobile`
- [x] Android: package name `com.matrixos.mobile`
- [ ] Preview → TestFlight workflow (**moved to T2193**)
- **Output**: Buildable app ✓ (ship workflow pending)

### T891 [P] Offline resilience
- [x] Cache last N messages locally (AsyncStorage)
- [x] Queue outbound messages when offline, send on reconnect
- [x] Show connection state in header (ConnectionBanner)
- [ ] Ring-buffer cap enforcement (**moved to Phase K polish, T2192**)
- **Output**: App usable with spotty connectivity ✓ (cap pending)

### T892 [P] Haptic feedback + animations
- [x] Haptic on send message (in InputBar)
- [x] Reanimated for smooth list animations and typing indicator
- [ ] Tab switch spring animation (**optional polish**)
- [ ] Bottom sheet spring gesture (**optional polish**)
- **Output**: Native-feeling interactions ✓

---

## Phase E: Clerk-only Auth Rewrite (T2150-T2154) — NEW, START HERE

This phase **deletes** self-hosted support. There is no migration path; users who run their own gateway use the web shell.

### T2150 [US44] Gateway session resolver route
- [ ] Add `GET /api/session/resolve` in `packages/gateway/src/server.ts`
- [ ] Verifies Clerk JWT via existing auth middleware (reuses the shell's verifier)
- [ ] Returns `{ wsUrl: "wss://app.matrix-os.com/ws", httpUrl: "https://app.matrix-os.com" }` — no secondary bearer token; the Clerk JWT itself is the auth credential on every subsequent call
- [ ] Confirm every other `/api/*` route (existing) accepts the Clerk JWT on both HTTP `Authorization` header and the WS `?token=` query param. Where it doesn't, add the middleware.
- [ ] Typed errors (not bare catch), `AbortSignal.timeout` on any upstream call, body limit
- [ ] Vitest integration test `tests/gateway/session-resolve.test.ts` (valid JWT → 200, missing JWT → 401, expired JWT → 401, unknown user → 404)
- **Output**: Server route + audited JWT acceptance across `/api/*`

### T2151 [US44] Mobile session resolver library
- [ ] `apps/mobile/lib/session-resolver.ts` — takes Clerk's `getToken()`, calls `GET https://app.matrix-os.com/api/session/resolve`, returns `{ wsUrl, httpUrl }`
- [ ] Retries with 500 ms backoff up to 3 attempts on transient network errors
- [ ] Typed error union (`NetworkError`, `AuthError`, `ContainerCold`)
- [ ] Jest test `apps/mobile/__tests__/session-resolver.test.ts` with mocked fetch (happy path, 401 flip, network failure, backoff exhaustion)
- **Output**: Pure function, fully tested

### T2152 [US44] Rewrite GatewayClient for Clerk-only
- [ ] `apps/mobile/lib/gateway-client.ts` — constructor signature becomes `new GatewayClient({ wsUrl, httpUrl, getToken })`
- [ ] Every HTTP call awaits `getToken()` and sets `Authorization: Bearer <jwt>` — no cached bearer
- [ ] WS reconnect path reads a fresh token before each attempt (append `?token=<jwt>` to the handshake URL)
- [ ] Drop all references to `baseUrl`, the old bearer constructor, and manual token injection
- [ ] Update Jest tests for new signature
- **Output**: Gateway client that pulls auth from Clerk on every call

### T2153 [US44] Delete self-hosted surfaces
- [ ] Delete `apps/mobile/app/connect.tsx`
- [ ] Delete `apps/mobile/components/GatewayCard.tsx`
- [ ] Delete `apps/mobile/lib/storage.ts` (or trim to `prefs.ts` if theme + biometric toggles still need local persistence — do **not** keep the `gateways[]` schema)
- [ ] Trim `apps/mobile/lib/auth.ts` to biometric helpers only; remove any bearer helpers
- [ ] `app/_layout.tsx` — `GatewayContext` shape becomes `{ client, connectionState, unreadCount, incrementUnread, clearUnread }`; remove `gateway` and `setGateway`
- [ ] `app/index.tsx` — unauthenticated users route directly to `/sign-in` (no welcome branch choice)
- [ ] `app/sign-in.tsx` — on successful Clerk sign-in, call `session-resolver`, instantiate `GatewayClient`, push to `(tabs)/chat`. On failure, show typed error.
- [ ] `app/(tabs)/settings.tsx` — delete the "Gateways" section; replace with a single "Signed in as {primaryEmail}" row + "Sign out" button. Sign-out calls `useAuth().signOut()`, disconnects WS, routes to `/sign-in`.
- [ ] Sweep for dead imports (`getActiveGateway`, `GatewayConnection`, `saveGateway`, etc.) — ESLint should catch these after the deletes
- [ ] Remove `Stack.Screen name="connect"` from `app/_layout.tsx`
- **Output**: No trace of self-hosted support in the app tree

### T2154 [US44] AppState reconnect + JWT refresh
- [ ] `app/_layout.tsx` — `AppState.addEventListener("change", ...)` → on `active`, check Clerk session validity; if the session is within 5 min of expiry, call `getToken({ skipCache: true })` and reconnect the WS with the fresh token
- [ ] Heartbeat ping every 25 s while foreground (send `{type: "ping"}` via WS, gateway ignores)
- [ ] On any HTTP 401, call `getToken({ skipCache: true })` once and retry; if still 401, route to `/sign-in` with an "expired" banner (outbound queue preserved)
- **Output**: No silent dead sockets, no stale JWTs

---

## Phase F: Apps Tab (T2155-T2163) — NEW

### T2155 [US45] Gateway apps route extensions
- [ ] Ensure `/api/apps` returns `runtime`, `url`, `icon`, `manifest`, `lastOpenedAt`
- [ ] Add `POST /api/apps/:slug/wake` — lazy-start for node runtime apps, returns `{ ready, url }`
- [ ] Add `POST /api/apps/:slug/last-opened` — touches timestamp (used by mobile sort-by-recent)
- [ ] Body limits + timeouts + typed errors
- **Output**: Mobile can list, sort, and wake apps

### T2156 [US45] App bridge (RN side)
- [ ] `apps/mobile/lib/app-bridge.ts` — RN implementation of `MatrixOS.*` postMessage bridge
- [ ] Methods: `db.query`, `db.read`, `db.write`, `openApp`, `setTitle`, `theme:update`
- [ ] Origin allowlist (compares `sourceURL` against active gateway origin)
- [ ] Serialization + error surfaces match shell bridge
- [ ] Jest test `__tests__/app-bridge.test.ts`
- **Output**: Apps inside WebView can talk to kernel like on desktop

### T2157 [US45] AppWebView component
- [ ] `components/AppWebView.tsx` using `react-native-webview`
- [ ] `injectedJavaScriptBeforeContentLoaded` installs the bridge shim + origin check
- [ ] `onShouldStartLoadWithRequest` blocks navigations outside the gateway origin
- [ ] Life cycle: `wake` → poll `/health` up to 30 s → load URL, spinner + "Waking up…" during wake
- [ ] Memory discipline: unmount previous WebView on navigation (pool of 2 max)
- **Output**: Reusable WebView host for apps, terminal, gallery

### T2158 [US45] AppCard component
- [ ] `components/AppCard.tsx` — icon, name, runtime badge, last-opened timestamp
- [ ] Long-press menu: rename, remove, share, regenerate icon
- [ ] Tap → navigate to `/app/[slug]`
- **Output**: Single-app card

### T2159 [US45] Apps tab screen
- [ ] `app/(tabs)/apps.tsx` — grid (default) + list toggle, sort by last-used, search
- [ ] Section "Install more" links to gallery WebView
- [ ] Pull-to-refresh from `/api/apps`
- **Output**: App launcher

### T2160 [US45] Five-tab navigation
- [ ] `app/(tabs)/_layout.tsx` — add `apps` and `files` Tabs.Screen entries
- [ ] Tab icons: `apps-outline`/`apps`, `folder-outline`/`folder`
- [ ] Chat / Apps / Mission Control / Files / Settings order
- **Output**: 5-tab bar

### T2161 [US45] Dynamic app route
- [ ] `app/app/[slug].tsx` — reads slug, renders `AppWebView` for that app
- [ ] Stack presentation (push), back gesture
- [ ] Deep link support: `matrixos://app/{slug}` + `https://app.matrix-os.com/apps/{slug}` via `expo-linking`
- **Output**: Single-app host, deep-linkable

### T2162 [US45] Connected-life first-run
- [ ] On first foreground after sign-in, if `/api/apps` is empty or `defaultAppsSeeded=false`, present a modal hosting the shell's `/onboarding/connect` inside `AppWebView`
- **Output**: Matches spec 060 expectation

### T2163 [US45] App bridge + WebView tests
- [ ] `__tests__/app-bridge.test.ts` — postMessage serialization, origin filter, method dispatch
- [ ] Smoke test for `AppWebView` render (uses `react-native-webview` mock)
- **Output**: Confidence in the bridge before shipping

---

## Phase G: Files Tab (T2164-T2170) — NEW

### T2164 [US46] Gateway client file helpers
- [ ] `lib/gateway-client.ts` — add `listFiles`, `fileTree`, `statFile`, `searchFiles`, `mkdirFile`, `touchFile`, `renameFile`, `trashFile`, `restoreFile`, `emptyTrash`, `readFile`, `writeFile`, `uploadFile`
- [ ] All fetches wrapped in `AbortSignal.timeout(10_000)` (30 s for uploads)
- [ ] Typed result union instead of raw JSON
- **Output**: Complete file API client

### T2165 [US46] FileRow component
- [ ] `components/FileRow.tsx` — icon by mime/ext, name, size, mtime
- [ ] Swipe-to-trash gesture (Reanimated)
- [ ] Long-press for rename / duplicate / share
- **Output**: Single-row renderer

### T2166 [US46] FilePreview component
- [ ] `components/FilePreview.tsx` — markdown, code, image, PDF, audio, video, text fallback
- [ ] Uses `react-native-markdown-display`, `react-native-syntax-highlighter`, `expo-av`, `react-native-pdf`
- [ ] Shared by Quick Preview sheet and chat inline media (replaces T879)
- **Output**: Universal preview

### T2167 [US46] Files tab screen
- [ ] `app/(tabs)/files.tsx` — breadcrumb, list, search bar, pull-to-refresh
- [ ] Tap row → bottom-sheet Quick Preview; long-press for actions
- [ ] Search uses `/api/files/search` (name + content)
- **Output**: Finder-lite

### T2168 [US46] Upload from camera roll
- [ ] `expo-image-picker` → photo/video → `PUT /files/{path}` via `expo-file-system.uploadAsync`
- [ ] Progress bar in row
- [ ] 50 MB client cap, aborts with clear error
- **Output**: Mobile can add files

### T2169 [US46] Trash view
- [ ] `app/files/trash.tsx` pushed from Files tab header button
- [ ] Lists `/api/files/trash`, restore one, empty all (with double confirm)
- **Output**: Recoverable deletion

### T2170 [US46] Files tests
- [ ] FileRow render cases (images, code, markdown, PDF, unknown)
- [ ] FilePreview markdown and code rendering
- [ ] gateway-client file helpers with mocked fetch
- **Output**: Green test suite

---

## Phase H: Integrations + Memory + Usage (T2171-T2177) — NEW

### T2171 [US50] Gateway memory read routes
- [ ] `GET /api/memory/recent?limit=N` — paginated recent user memories from spec 052 store
- [ ] `GET /api/memory/search?q=X` — FTS + pgvector hybrid search
- [ ] Body limits, timeouts, typed errors
- [ ] Vitest integration test
- **Output**: Mobile can read memory without direct DB access

### T2172 [US47] Gateway integrations list + disconnect
- [ ] Ensure `/api/integrations` returns catalog + connected with expiry
- [ ] Add `POST /api/integrations/:id/disconnect`
- [ ] Confirm origin + session ownership on disconnect
- **Output**: Mobile can manage integrations read-mostly

### T2173 [US47] IntegrationRow component
- [ ] `components/IntegrationRow.tsx` — logo, status, last-used, action button
- **Output**: Reusable row

### T2174 [US47/US50] Settings subsections
- [ ] Add **Integrations** section to `settings.tsx` — connected list, connect button, disconnect
- [ ] Add **Memory** section — recent memories list + search entry point
- [ ] Add **System** section — usage sparkline, system info, security audit red dot
- **Output**: Expanded settings

### T2175 [US50] Usage sparkline
- [ ] `components/UsageSparkline.tsx` — `react-native-svg` polyline from `/api/usage` rolling window
- [ ] Tap → full-screen detail with per-day breakdown
- **Output**: Visual spend at a glance

### T2176 [US47] Integrations connect flow
- [ ] `WebBrowser.openAuthSessionAsync` with PKCE
- [ ] Verify redirect origin is `app.matrix-os.com`
- [ ] On success, refetch `/api/integrations`
- [ ] Handle user-cancel cleanly
- **Output**: In-app OAuth

### T2177 [US47/US50] Phase H tests
- [ ] IntegrationRow render
- [ ] UsageSparkline snapshot
- [ ] Gateway memory + integration route tests
- **Output**: Green suite

---

## Phase I: Voice End-to-End (T2178-T2182) — NEW

### T2178 [US48] Voice library
- [ ] `lib/voice.ts` — start/stop recording via `expo-av`, 60 s cap, release on error
- [ ] `uploadStt(fileUri, gatewayClient)` → `POST /api/voice/stt` with `AbortSignal.timeout(30_000)`
- [ ] `playTts(text, gatewayClient)` → `POST /api/voice/tts` → stream playback via `Audio.Sound`
- [ ] Typed errors (`RecorderUnavailable`, `UploadFailed`, `PlaybackFailed`)
- [ ] Jest test with mocked recorder + fetch
- **Output**: Voice helpers

### T2179 [US48] VoiceRecorder component
- [ ] `components/VoiceRecorder.tsx` — hold-to-record button, waveform animation, haptic tick
- [ ] Cancel gesture (swipe left while holding)
- **Output**: UX for recording

### T2180 [US48] InputBar mic button
- [ ] `components/InputBar.tsx` — mic replaces send when text is empty
- [ ] Press-and-hold launches `VoiceRecorder`; on release uploads + inserts transcript + sends
- **Output**: One-tap voice

### T2181 [US48] TTS playback on assistant messages
- [ ] Long-press a `ChatMessage` with `role === "assistant"` → "Read aloud" option
- [ ] Playback controls (play/pause/stop) in a small sticky bar
- **Output**: Listen to answers

### T2182 [US48] Voice tests
- [ ] `voice.ts` — mocked recorder + fetch, error paths
- [ ] InputBar snapshot before/after mic press
- **Output**: Green suite

---

## Phase J: Terminal Host + Overflow Screens (T2183-T2186) — NEW

### T2183 [US49] Terminal screen
- [ ] `app/terminal.tsx` — `AppWebView` wrapping `{gatewayUrl}/terminal?sessionId={id}`
- [ ] `sessionId` read from storage or query param (deep-link: `matrixos://terminal?sessionId=X`)
- [ ] Bottom key row (Esc / Tab / Ctrl / arrows) — taps inject `term.input()` via postMessage
- **Output**: Reattach to desktop terminal sessions on phone

### T2184 [US49] Shell-side terminal key listener
- [ ] In shell's terminal route, add a tiny `window.addEventListener("message", ...)` that forwards keycodes from the RN bridge to the xterm.js instance
- [ ] Origin check against mobile origin list
- **Output**: Bottom key row actually types

### T2185 [US50] Memory viewer screen
- [ ] `app/memory.tsx` — list of user memories from `/api/memory/recent`, search bar hitting `/api/memory/search`
- [ ] Read-only; "Forget this" deferred
- **Output**: Agent memory at a glance

### T2186 [US45/US49/US50] Overflow drawer in Settings
- [ ] Settings → "More" links: Terminal, Memory, Social (placeholder for v3)
- **Output**: Access without crowding tab bar

---

## Phase K: Push Extension + Polish (T2187-T2192) — NEW

### T2187 [US51] Push adapter category + quiet hours
- [ ] `packages/gateway/src/channels/push.ts` — `category` field on send, per-category sub-cap, quiet-hours check from `~/system/config.json`
- [ ] Kernel hooks emit category metadata (task, cron, security, integration, app, voice)
- [ ] Unit tests for rate limiter sub-caps
- **Output**: Categorized push

### T2188 [US51] Notification tap routing
- [ ] `lib/push.ts` — routing table per category → navigate to right screen with params
- [ ] `NotificationRouter` consumes new routing table
- **Output**: Taps land the user in the right place

### T2189 [US51] Per-category notification settings
- [ ] Settings → Notifications has toggles per category
- [ ] Persist via `POST /api/settings/notifications` (new route or extend existing settings)
- **Output**: Users control the firehose

### T2190 [US42] Theme token sync script
- [ ] `scripts/sync-theme-tokens.ts` — reads shell `globals.css` + `lib/theme-presets.ts`, writes `lib/theme-tokens.ts`
- [ ] Run in CI pre-build and on pnpm install
- **Output**: Mobile + shell stay in lockstep on design

### T2191 [US42] Theme presets
- [ ] Add `matrix-default`, `retro`, `win98`, `high-contrast` preset options in Appearance settings
- [ ] Apply via `theme-tokens.ts` at runtime (re-read colors from context)
- **Output**: Mobile honors desktop theme choices

### T2192 [US43] Offline ring buffer cap + AppState heartbeat
- [ ] Enforce 500-message cap in `lib/offline.ts` (already shipped, needs trimming)
- [ ] 25 s heartbeat ping while foreground (from T2154)
- [ ] WebView pool cap of 2 enforced in `AppWebView`
- **Output**: No unbounded memory growth

---

## Phase L: Build + Ship (T2193-T2195) — NEW

### T2193 EAS preview → TestFlight workflow
- [ ] `eas.json` preview profile builds via GitHub Actions on PR merge
- [ ] Internal TestFlight group + Android internal track
- [ ] Release notes auto-generated from commit titles
- **Output**: Real devices get new builds without manual push

### T2194 Privacy + data-safety metadata
- [ ] `apps/mobile/privacy.json` — iOS privacy manifest
- [ ] Android data-safety questionnaire inputs captured in-repo
- [ ] Document in spec what categories of data the app handles
- **Output**: Store-ready metadata

### T2195 Smoke test checklist + docs
- [ ] Manual checklist in this file (Checkpoint section below) verified on iOS and Android
- [ ] Update `specs/execution-checklist.md` to mark 027 Phase E-L complete
- [ ] Run `/update-docs`
- **Output**: Shipped v2

---

## Checkpoint (v2)

After Phase E-L completes, a fresh install on a real device must pass:

1. Sign in with Clerk → lands in Chat, no manual URL typed
2. Send a message, receive a streaming reply, hit reconnect while reading
3. Open Apps tab → tap Inbox → Gmail data loads in-WebView
4. Open Files tab → preview a markdown note → search for it → restore from trash
5. Settings → Integrations → connect Gmail → see it listed with last-used timestamp
6. Hold mic on InputBar → say "what's on my calendar today" → transcript + agent reply + TTS playback
7. Close app → trigger a cron result from desktop → push notification arrives → tap → lands in Mission Control → Scheduled section
8. Revoke Clerk session on desktop → mobile shows re-auth prompt within 30 s, outbound queue preserved
9. Settings → System → usage sparkline shows today's tokens, security audit row is non-red
10. Open Terminal tab → attach to a running Claude Code session → type via bottom key row

When all 10 pass on both iOS and Android: spec 027 v2 is shipped.
