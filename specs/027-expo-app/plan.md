# Plan: Expo Mobile App v2

**Spec**: `specs/027-expo-app/spec.md` (v2 — 2026-04-12)
**Status**: v1 (T870–T892) shipped on `main`. v2 extends scope **and drops self-hosted gateway support**.
**Depends on**:
  - Shipped: Gateway HTTP/WS + auth (004, 008A), Tasks + Cron (012), Push adapter (v1), Pipedream Connect (049), App data layer (050), Terminal + PTY (047/056), File browser (048), Voice STT/TTS (046 Phases A–E), Memory store (052), Kernel logging + usage (037), Observability (034)
  - Blocking: **React App Runtime (063)** — Apps tab depends on Vite/Node runtimes being catalogued in `/api/apps` with stable URLs. If 063 is still mid-flight, ship Apps tab with static-only filter first, unlock the rest when 063 lands.
  - Blocking: **Onboarding 053** — mobile requires `/api/session/resolve` and Clerk-JWT acceptance on the WS handshake. Since self-hosted support is dropped, there is no fallback; Phase E cannot ship until 053's route lands on `main`.
**Estimated effort**: Large (~30 new tasks; 8 modify-existing; a handful of delete-existing in Phase E)
**Branch strategy**: continue on `main` per project convention (no feature branches for mobile work). Commit after each phase.

## Guiding principles

1. **Don't break what ships.** Phase A–D in tasks.md v1 are mostly `[x]`. Treat the existing code as source of truth and only touch what the new scope requires.
2. **Gateway first, mobile second.** Every new mobile surface has a server-side prerequisite. Land the route, test it, then wire the screen. This avoids the `bridge-sql`/bridge data layer mistake from spec 050 where the client got ahead of the server.
3. **TDD on bridges, integration tests on routes.** `lib/session-resolver.ts`, `lib/app-bridge.ts`, `lib/voice.ts` are pure logic and get Jest tests first. Gateway routes get Vitest integration tests in `tests/gateway/`.
4. **One WebView component, many hosts.** `AppWebView`, Terminal host, and Gallery all use the same base component with different src + allowlist.
5. **Respect mandatory patterns** from CLAUDE.md: `AbortSignal.timeout` on every fetch, typed catch blocks, body limits, no wildcard CORS, LRU caps on all caches.

## Phase ordering

### Phase E: Clerk-only auth rewrite (T2150–T2154) — do this first

The biggest user-visible breakage is v1's subdomain assumption. Fix auth before any new tabs. This phase also **deletes** the self-hosted connect flow, multi-gateway storage, and bearer-token path — they are not migrated, they are removed.

1. **T2150** Add `GET /api/session/resolve` to gateway (verifies Clerk JWT via existing middleware, returns `{ wsUrl, httpUrl }` for the user's container). Also confirm every other `/api/*` route accepts the Clerk JWT on both HTTP and the WS `?token=` query param.
2. **T2151** `lib/session-resolver.ts` — takes Clerk's `getToken()`, calls the resolve route, returns `{ wsUrl, httpUrl }`. Typed error union, Jest test with mocked fetch.
3. **T2152** Rewrite `lib/gateway-client.ts` so its constructor takes `{ wsUrl, httpUrl, getToken }` instead of `(baseUrl, bearer)`. Every HTTP call awaits `getToken()` and sets `Authorization: Bearer <jwt>`; the WS reconnect path does the same on the handshake URL. No persistent token is stored.
4. **T2153** Delete `app/connect.tsx`, `components/GatewayCard.tsx`, `lib/storage.ts` (and its `AppSettings.gateways` schema), and the `lib/auth.ts` bearer helpers. Update `app/_layout.tsx` so `GatewayContext` only holds `{ client, connectionState }` — no `gateway`, `setGateway`, or multi-gateway list. Update `app/sign-in.tsx` to call the resolver and drop into the tabs on success. Update `app/index.tsx` to route unauthenticated users straight to `/sign-in`.
5. **T2154** AppState foreground listener → `getToken()` refresh, reconnect WS if JWT is within 5 min of expiry. Heartbeat ping every 25 s while foreground. Sign-out handler disconnects WS, clears in-memory URLs, routes to `/sign-in`.

### Phase F: Apps tab (T2155–T2163)

Blocks on 063's catalog stability. Start with static-runtime apps only; add vite/node when ready.

1. **T2155** Gateway: ensure `/api/apps` returns `runtime`, `url`, `icon`, `manifest`; add `POST /api/apps/:slug/wake` for node apps
2. **T2156** `lib/app-bridge.ts` — RN side of `MatrixOS.*` postMessage bridge: `db.query`, `db.read`, `db.write`, `openApp`, `setTitle`, `theme:update`
3. **T2157** `components/AppWebView.tsx` — WebView host with origin allowlist (`injectedJavaScriptBeforeContentLoaded`), message handler, lifecycle (wake → health poll → load)
4. **T2158** `components/AppCard.tsx` — icon, name, runtime badge, last-opened timestamp, long-press menu
5. **T2159** `app/(tabs)/apps.tsx` — grid + list toggle, sort by last-used, search
6. **T2160** `app/app/[slug].tsx` — dynamic route hosting `AppWebView` for a single app, deep-linkable
7. **T2161** Apps tab also renders "Install from Gallery" → embeds `app.matrix-os.com/gallery` in the same WebView (spec 058)
8. **T2162** First-run hook: if `/api/apps` is empty, show spec 060's connected-life onboarding inline
9. **T2163** Component test for `app-bridge.ts` (postMessage serialization, origin filter)

### Phase G: Files tab (T2164–T2170)

All gateway routes already exist (`/api/files/*`). Pure client work except for one addition.

1. **T2164** `lib/gateway-client.ts` — add `listFiles`, `fileTree`, `statFile`, `searchFiles`, `mkdirFile`, `touchFile`, `renameFile`, `trashFile`, `restoreFile`, `readFile` helpers (all with `AbortSignal.timeout(10_000)` and typed errors)
2. **T2165** `components/FileRow.tsx` — icon by mime/ext, name, size, mtime, swipe-to-trash
3. **T2166** `components/FilePreview.tsx` — markdown (via `react-native-markdown-display`), code (`react-native-syntax-highlighter`), image, PDF, audio/video (`expo-av`)
4. **T2167** `app/(tabs)/files.tsx` — tree view, breadcrumb, search bar, pull-to-refresh, Quick Preview sheet
5. **T2168** Create / upload path: camera roll picker via `expo-image-picker` → `PUT /files/{path}` with progress
6. **T2169** Trash view (`/api/files/trash`), restore, empty with confirm
7. **T2170** Component tests: FileRow, FilePreview render cases, gateway-client mock

### Phase H: Integrations + Memory + Usage (T2171–T2177)

Needs small server additions, then Settings screen extensions.

1. **T2171** Gateway: add `/api/memory/recent` and `/api/memory/search?q=` read routes wrapping the 052 memory store. Use typed errors, body limits, 10s timeout.
2. **T2172** Gateway: ensure `/api/integrations` (already in spec 049 on main) returns `{ catalog, connected[] }` with last-used + token expiry timestamps; add `/api/integrations/:id/disconnect`
3. **T2173** `components/IntegrationRow.tsx` — logo, status badge, connect/disconnect
4. **T2174** Settings subsections: **Integrations**, **Memory**, **System** (health + usage + security audit)
5. **T2175** `components/UsageSparkline.tsx` — `react-native-svg` sparkline from `/api/usage` rolling window
6. **T2176** Integrations connect flow: `WebBrowser.openAuthSessionAsync` with PKCE + origin verification
7. **T2177** Tests: integration row, sparkline, route mocks

### Phase I: Voice end-to-end (T2178–T2182)

v1 marked voice input `[ ]`. Finish it against spec 046's shipped routes.

1. **T2178** `lib/voice.ts` — record via `expo-av`, 60 s cap, release on error, upload to `/api/voice/stt` with abort timeout
2. **T2179** `components/VoiceRecorder.tsx` — hold-to-record button with haptics + waveform animation
3. **T2180** Wire into `InputBar.tsx`: mic button replaces send when empty, becomes record-to-send
4. **T2181** TTS playback: long-press assistant message → `/api/voice/tts` → `Audio.Sound` playback with playback controls sheet
5. **T2182** Tests: voice.ts (mock recorder + fetch)

### Phase J: Terminal host + overflow screens (T2183–T2186)

1. **T2183** `app/terminal.tsx` — WebView hosting `{gatewayUrl}/terminal?sessionId={id}` with bottom key row (Esc/Tab/Ctrl/arrows)
2. **T2184** Bottom key row injects keystrokes via WebView postMessage → xterm.js `term.input()` bridge (needs a tiny shell-side listener in the terminal app route)
3. **T2185** `app/memory.tsx` — read-only list of user memories with search
4. **T2186** Settings → "More" drawer links Terminal, Memory (and Social placeholder for v3)

### Phase K: Push extension + polish (T2187–T2192)

1. **T2187** Gateway push adapter: category field + quiet hours + per-category rate sub-caps; kernel hook emits category metadata
2. **T2188** `lib/push.ts` routing table: tap handlers for `task`, `cron`, `security`, `integration`, `app`, `voice`
3. **T2189** Settings → Notifications: per-category toggles persisted server-side via `/api/settings/notifications`
4. **T2190** `scripts/sync-theme-tokens.ts` — read shell `globals.css` tokens → emit `lib/theme-tokens.ts` — run in CI + pre-build hook
5. **T2191** Theme presets (`matrix-default`, `retro`, `win98`, `high-contrast`) selectable from Settings → Appearance
6. **T2192** AppState + heartbeat ping every 25s while foreground; reconnect on background→foreground transitions

### Phase L: Build + ship (T2193–T2195)

1. **T2193** EAS config: add preview → TestFlight workflow; Android internal track
2. **T2194** Privacy manifest (iOS), data safety (Android) — required metadata lives in `apps/mobile/privacy.json`
3. **T2195** Smoke test checklist + release notes + update `specs/execution-checklist.md`

## Files to create

See spec §File locations. New files total ~22; modified ~10.

## Files to modify (high-risk)

- `packages/gateway/src/server.ts` — new routes, order matters because of the catch-all `/files/*` handler
- `packages/gateway/src/channels/push.ts` — category sub-caps must not regress existing rate limit tests
- `packages/kernel/src/hooks.ts` — push emit hooks should be idempotent if the push channel is disabled
- `apps/mobile/app/_layout.tsx` — the `GatewayContext` shape changes (drops `gateway`, `setGateway`); every screen consuming it needs a sweep in the same commit
- `apps/mobile/lib/gateway-client.ts` — constructor signature changes from `(baseUrl, bearer)` to `({ wsUrl, httpUrl, getToken })`; every call site updates together. Consider splitting into `gateway-http.ts` + `gateway-ws.ts` at end of Phase H.

## Files to delete (Phase E)

- `apps/mobile/app/connect.tsx`
- `apps/mobile/components/GatewayCard.tsx`
- `apps/mobile/lib/storage.ts` (or trimmed to a non-gateway prefs store if the Notifications toggle state needs local persistence)
- Self-hosted branches inside `apps/mobile/app/sign-in.tsx`, `app/_layout.tsx`, `app/(tabs)/settings.tsx` (Gateways section), and `app/(tabs)/chat.tsx` (connect-banner empty state)

## New dependencies (apps/mobile)

Already present: `expo-blur`, `expo-local-authentication`, `expo-secure-store`, `expo-notifications`, `expo-camera`, `expo-haptics`, `expo-clipboard`, `@clerk/clerk-expo`, `@gorhom/bottom-sheet`, `@react-native-async-storage/async-storage`, `react-native-reanimated`, `react-native-gesture-handler`.

To add:
- `react-native-webview` — apps + terminal hosts
- `react-native-markdown-display` — file previews
- `react-native-syntax-highlighter` + `react-syntax-highlighter` — code preview
- `react-native-pdf` + `react-native-blob-util` — PDF preview
- `expo-av` — recording, TTS playback, video preview
- `expo-image-picker` — uploads
- `expo-sharing` — export files
- `expo-file-system` — uploadAsync progress
- `expo-web-browser` — OAuth integration connect flow
- `react-native-skia` (optional) — mesh gradients; fallback `expo-linear-gradient` if Skia bundle size is an issue
- `react-native-svg` — sparklines

No new kernel / gateway dependencies.

## Test strategy

- **Unit (Jest)**: `session-resolver`, `app-bridge`, `voice`, `offline`, `gateway-client` HTTP helpers — all pure, mock `fetch`
- **Component (React Native Testing Library)**: `AppCard`, `AppWebView` (smoke), `FileRow`, `FilePreview`, `IntegrationRow`, `UsageSparkline`, `VoiceRecorder`, extended `InputBar`
- **Gateway integration (Vitest)**: `/api/session/resolve`, `/api/memory/*`, `/api/integrations/*` read path, `/api/apps/:slug/wake`. Hits a real SQLite + mocked Postgres.
- **E2E manual checklist** in tasks.md — no Detox yet (too heavy for current CI budget)
- **Screenshot tests**: add Playwright screenshot coverage in the shell for any shared WebView routes mobile hosts (per user feedback about always adding Playwright screenshots)

## Deployment + quality gates

Before shipping Phase F–L:

- [ ] `bun run lint` clean
- [ ] `bun run test` passes (gateway + kernel + mobile)
- [ ] `bun run build` succeeds (including mobile TypeScript `tsc --noEmit`)
- [ ] `pnpm install` at repo root, commit lockfile with every new dep
- [ ] User tests on Docker dev (`bun run docker`) before push to main
- [ ] EAS preview build installed on a real device — never merge a mobile phase without this step
