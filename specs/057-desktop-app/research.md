# Research: 057 Desktop App

## 1. Electron Window Architecture: BaseWindow + WebContentsView

**Decision**: Use `BaseWindow` + `WebContentsView` (not BrowserWindow + BrowserView)

**Rationale**: BrowserView is deprecated since Electron 30. WebContentsView is the official replacement with better lifecycle management, proper z-ordering, and explicit `addChildView`/`removeChildView` for tab switching.

**Alternatives considered**:
- BrowserWindow with webviews: Deprecated, security concerns with `<webview>` tag
- BrowserView: Deprecated in Electron 30+, will be removed
- Multiple BrowserWindows: No tab-like UX, excessive resource usage

**Key patterns**:
- Tab switching: `removeChildView(old)` + `addChildView(new)` + `setBounds()`
- Memory safety: Must call `view.webContents.close()` when destroying a tab
- Layout: sidebar WebContentsView (local HTML) + content WebContentsView (cloud URL), manually sized via `setBounds()` on window resize

## 2. electron-vite Build System

**Decision**: electron-vite 5.0.x with three-target builds (main/preload/renderer)

**Rationale**: Purpose-built for Electron. Handles the three process targets (main=Node, preload=sandboxed Node, renderer=browser) with proper HMR for renderer, externalized deps for main/preload.

**Alternatives considered**:
- Vite + manual Electron config: More boilerplate, no built-in Electron dev server
- Webpack (electron-forge): Heavier, slower builds, more config
- esbuild only: No HMR for renderer, manual orchestration

**Config**: `externalizeDepsPlugin()` for main/preload, standard Vite for renderer. Environment variables: `MAIN_VITE_*`, `PRELOAD_VITE_*`, `RENDERER_VITE_*`.

## 3. Authentication: Session Cookie Sharing

**Decision**: Use `ses.fetch()` from the default session for main process API calls

**Rationale**: WebContentsViews loading `app.matrix-os.com` get Clerk session cookies via normal browser auth flow. `ses.fetch()` on the same session automatically includes those cookies — no manual extraction needed.

**Alternatives considered**:
- Manual cookie extraction via `session.cookies.get()` + attach as header: Works but redundant when `ses.fetch()` handles it
- Separate auth token stored in electron-store: Adds complexity, token refresh logic needed
- OAuth device flow: Unnecessary — browser-based Clerk auth works natively in WebContentsView

**Known issue**: `ses.fetch()` may always use default session cookies even when called on a non-default session (Electron #44456). Mitigation: Use default session for all WebContentsViews (no custom partition needed — single user app).

## 4. Tab Persistence

**Decision**: electron-store 10.x with typed schema

**Rationale**: Lightweight JSON persistence (~100KB). Schema validation built-in. ESM-only (matches our ES modules requirement). Stores: open tabs, active tab, sidebar order, window bounds, preferences.

**Alternatives considered**:
- SQLite: Overkill for ~100KB of UI state
- localStorage in renderer: Not accessible from main process
- Custom JSON file: No schema validation, no migration support

**Storage location**: `~/Library/Application Support/Matrix OS/config.json` (Electron's `app.getPath('userData')`)

## 5. Container Management Proxy

**Decision**: 4 new gateway endpoints that proxy to platform API using self-upgrade HMAC token

**Rationale**: The desktop app authenticates to the gateway via Clerk cookie (same path as browser). The gateway then relays container management requests to the platform using the container's HMAC self-upgrade token (already implemented). This avoids exposing the platform secret to clients.

**Alternatives considered**:
- Direct platform API calls from desktop app: Would require exposing platform URL and HMAC token to client. Security risk.
- WebSocket-based container management: Adds complexity, REST is simpler for request-response operations
- Separate management API: Unnecessary — gateway already has auth and is the natural proxy point

**New endpoints**:
- `POST /api/container/start` → platform `POST /containers/:handle/start`
- `POST /api/container/stop` → platform `POST /containers/:handle/stop`
- `POST /api/container/upgrade` → platform `POST /containers/:handle/self-upgrade`
- `GET /api/container/status` → platform `GET /containers/:handle`

## 6. Auto-Update Distribution

**Decision**: electron-builder 26.8.x + electron-updater 6.x with GitHub Releases

**Rationale**: Standard Electron distribution path. macOS universal binary (Intel + Apple Silicon). DMG + ZIP artifacts. Notarization via `notarytool`. Auto-update checks every 4 hours, downloads in background, installs on quit.

**Alternatives considered**:
- Mac App Store: Rejected per spec (no MAS, direct download only)
- Sparkle (native macOS updater): Not TypeScript-native, electron-updater is standard
- Manual download page only: No auto-update, poor UX

**CI secrets needed**: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `GH_TOKEN`

## 7. Shell Embedded Mode Detection

**Decision**: Query param `?desktop=1` + `window.matrixDesktop` API check

**Rationale**: Two-layer detection. The URL param tells the server-rendered shell to skip chrome on first render (no flash of shell UI). The `window.matrixDesktop` API (via preload contextBridge) provides runtime detection and IPC for shortcuts, upgrade requests.

**Alternatives considered**:
- User-Agent string detection: Fragile, not available server-side in Next.js
- Custom HTTP header: WebContentsView doesn't easily set custom headers on navigation
- PostMessage only: Requires shell to load first, then negotiate — causes flash of shell chrome

**Shell changes needed**:
- Read `desktop` query param in page component
- If `desktop=1`: hide sidebar, hide tab bar, hide dock — render only the app content
- Listen for `window.matrixDesktop.onShortcut()` to handle forwarded keybindings

## 8. Health Check State Machine

**Decision**: 3-state machine (connected/starting/unreachable) with flap prevention

**Rationale**: Simple state machine driven by health check responses. 2 consecutive failures required before transitioning to unreachable (prevents notification flapping on transient network issues).

**States**:
- `connected` (green): health returns 200
- `starting` (yellow): health returns 503 "Failed to wake"
- `unreachable` (red): 2+ consecutive health failures or network errors

**Transitions trigger**: tray icon update, tray menu text update, macOS notification (on state change only), offline overlay show/hide

## 9. Patterns from SlayZone Reference

**Source**: `/Users/hamed/dev/claude-tools/slayzone/packages/apps/app/`

SlayZone is a production Electron 41 + electron-vite 5.0 app with near-identical architecture needs. Key patterns to adopt:

### WebContentsView Tab Management (browser-view-manager.ts)
- **LRU eviction**: Max 6 active WebContentsViews per partition. When limit hit, oldest inactive view is destroyed. Adopt this with our max 20 tab limit.
- **Separate sessions**: Browser tabs use `session.fromPartition(partition)` for isolation. For Matrix OS, all tabs share the default session (single cloud instance, need shared Clerk cookies).
- **Chrome extension support**: Not needed for Matrix OS (cloud-rendered content), but the WebContentsView lifecycle patterns are directly applicable.

### Window Setup Patterns (index.ts)
- **Splash screen**: Show inline SVG logo + animation while renderer loads, dismiss after readiness or 5s timeout. Adopt for Matrix OS branding during cold start.
- **Custom frame**: `titleBarStyle: 'hiddenInset'` on macOS for native-feeling traffic lights with custom chrome. The sidebar + tab bar fill the custom frame area.
- **Crash recovery**: Monitor renderer process, show recovery UI if it crashes. Adopt for reconnect-after-crash.
- **Before-input-event**: Intercept keyboard events at the window level before they reach the renderer. Better than Electron Menu accelerators for shortcuts that need conditional routing (e.g., Cmd+K should go to the active WebContentsView, not the native chrome).

### IPC Architecture (preload/index.ts)
- **Namespaced channels**: `db:tasks:get`, `pty:create`, `app:update-status`. Adopt: `tab:create`, `container:start`, `sidebar:get-apps`.
- **invoke for request-response**: Always use `ipcRenderer.invoke()` (returns Promise), not `send`/`on` pairs. Cleaner error handling.
- **send for one-way events**: Main→renderer events use `webContents.send()`. Status updates, shortcut forwarding, etc.
- **Separate preload bundles**: Main preload (native chrome), browser-chrome-preload (WebContentsViews). For Matrix OS: one preload for native chrome renderer, one for WebContentsViews (the matrixDesktop API).

### Build & Distribution (electron-builder.yml)
- **`asarUnpack`**: Native modules (better-sqlite3, node-pty) need unpacking. Matrix OS has no native modules (no local DB, no local PTY), so asar stays packed.
- **`afterPack` hook**: Custom post-build script. Useful for cleanup or verification.
- **macOS entitlements**: Camera/mic/folders access descriptions. Matrix OS only needs network client access.

### Dependencies to Adopt
- `@electron-toolkit/utils` (v4.0.0): Platform detection (`is.dev`, `is.macOS`), optimizer helpers
- `@electron-toolkit/preload` (v3.0.2): Preload script helpers, exposeInMainWorld utilities
- `electron-updater` (v6.7.3): Same auto-update pattern (check on launch + every 4h)

### Patterns to NOT Adopt
- **SQLite for UI state**: SlayZone uses better-sqlite3 for full task management. Matrix OS desktop is a thin client — electron-store (JSON) is sufficient for tab state + preferences.
- **node-pty**: SlayZone has local terminals. Matrix OS terminal is cloud-only (WebSocket to container).
- **Convex sync**: SlayZone syncs to Convex backend. Matrix OS syncs nothing locally — all state is cloud.
- **Chrome extensions**: Not applicable for cloud-rendered WebContentsViews.
- **MCP server**: SlayZone exposes local MCP tools. Matrix OS runs all AI in the cloud container.
