# Spec 057: Desktop App — Native Cloud Client

## Overview

A native macOS desktop app (Electron) that connects to the user's cloud Matrix OS instance. The app provides a native app launcher sidebar, tabbed app views, native keybindings (Cmd+T/W/K), system tray with connection status, container management (start/stop/upgrade), and auto-update. The terminal in the desktop app is the cloud terminal — same WebSocket connection to the container gateway, but with native keyboard shortcuts that browsers can't intercept.

This is not a browser wrapper. It's a purpose-built client with native chrome (sidebar, tabs, tray) that loads the cloud shell's web UI inside managed WebContentsViews.

## Goals

1. Native macOS app distributed via GitHub Releases (DMG + auto-update)
2. App launcher sidebar showing the user's installed Matrix OS apps
3. Tabbed interface — each app opens in its own tab (WebContentsView)
4. Native keybindings: Cmd+T, Cmd+W, Cmd+K, Cmd+1-9 work properly
5. System tray with connection status, quick actions, and container management
6. Container lifecycle management: start, stop, upgrade from the app
7. Auto-update via electron-updater (GitHub Releases)
8. Offline screen when cloud is unreachable

## Non-Goals

- No local terminal (node-pty) in this spec — the terminal connects to the cloud container
- No Windows/Linux builds (macOS only, cross-platform later)
- No Mac App Store distribution (direct download + notarization only)
- No file sync between cloud and local (future spec — Google Drive-style bidirectional sync is planned so users can work offline and see everything built for them)
- No custom renderer — the web shell renders inside WebContentsViews as-is
- No local AI/agent execution — all AI runs in the cloud container

## Dependencies

- Spec 056 (Terminal Upgrade) — the cloud terminal uses the session registry + ring buffer
- Platform API — container management endpoints (already exist)
- Clerk auth — session-based auth at `app.matrix-os.com` (already works)
- Gateway API — app listing, health check (already exist)

---

## Architecture

### Monorepo Location

```
apps/desktop/
├── src/
│   ├── main/              # Electron main process
│   │   ├── index.ts       # Entry point, window creation, IPC registration
│   │   ├── tray.ts        # System tray + menu
│   │   ├── updater.ts     # Auto-update via electron-updater
│   │   ├── tabs.ts        # Tab/WebContentsView management
│   │   └── platform.ts    # Platform API client (container management)
│   ├── preload/
│   │   └── index.ts       # Context bridge (IPC exposed to renderer)
│   └── renderer/          # Native chrome (sidebar, tab bar, offline screen)
│       ├── index.html     # App shell
│       ├── index.ts       # Renderer entry
│       ├── sidebar.ts     # App launcher sidebar
│       ├── tab-bar.ts     # Tab bar UI
│       └── offline.ts     # Offline screen
├── build/
│   ├── icon.icns          # macOS app icon
│   └── entitlements.mac.plist
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json
└── tsconfig.json
```

### Window Model

```
┌──────────────────────────────────────────────────────┐
│  Traffic lights       Matrix OS          ─ □ ✕       │
├────────┬─────────────────────────────────────────────┤
│        │  [Terminal] [Chat] [Files]              [+]  │
│  App   │─────────────────────────────────────────────│
│ Launch │                                              │
│  bar   │   WebContentsView (active tab)                   │
│        │                                              │
│ ────── │   Loads: https://app.matrix-os.com/?app=...  │
│  Term  │   Renders the shell's app component          │
│  Chat  │   inside a managed Electron WebContentsView      │
│  Files │                                              │
│  Music │                                              │
│ ────── │                                              │
│   ⚙    │                                              │
│   ↑    │                                              │
│   ●    │                                              │
└────────┴─────────────────────────────────────────────┘
```

**Three layers**:

1. **Main process** — owns the BrowserWindow, manages WebContentsViews (one per tab), handles IPC, tray, auto-update, platform API calls
2. **Native renderer** — the app's own UI: sidebar and tab bar. This is local HTML/CSS/JS bundled with the app (not loaded from cloud). Lightweight — just the chrome around the WebContentsViews.
3. **WebContentsViews** — one per tab, each loading a URL on the user's cloud instance. The web shell renders inside these. The terminal, chat, file browser, etc. are all cloud-rendered.

### Data Flow

```
User clicks "Terminal" in sidebar
  → Main process creates WebContentsView
  → WebContentsView loads https://app.matrix-os.com/?app=terminal
  → Platform proxy authenticates via Clerk cookie (persisted in Electron session)
  → Proxy routes to user's container shell (:3000)
  → Shell renders TerminalApp component
  → TerminalApp connects to /ws/terminal (proxied to container gateway :4000)
  → Session registry (spec 056) manages the PTY session
```

---

## 1. App Launcher Sidebar

### App Discovery

On launch and periodically (every 60s), the main process fetches the user's app list:

```
GET https://app.matrix-os.com/api/apps
→ [
    { slug: "terminal", title: "Terminal", icon: "/files/system/icons/terminal.png", builtIn: true },
    { slug: "chat", title: "Chat", icon: "/files/system/icons/chat.png", builtIn: true },
    { slug: "files", title: "Files", icon: "/files/system/icons/files.png", builtIn: true },
    ...
  ]
```

Icons are fetched from the container and cached locally (Electron's session cache handles this automatically via the WebContentsView's web session).

### Sidebar UI

Native renderer (local HTML, not cloud-loaded):

- App icons in a vertical list, with labels below each icon
- Click: opens that app in a new tab (or focuses existing tab if already open)
- Drag to reorder (persisted locally via `electron-store`)
- Divider between pinned apps (top) and unpinned (bottom)
- Bottom section:
  - Settings gear — opens settings tab
  - Upgrade arrow — visible when container has an update available, triggers upgrade
  - Connection dot — green (connected), yellow (starting), red (unreachable)

### Sidebar Width

- Default: 64px (icon-only mode)
- Hover or pin to expand: 200px (icon + label)
- Persisted preference via `electron-store`

---

## 2. Tab Management

### WebContentsView Per Tab

Each tab is a separate Electron `WebContentsView` attached to the main `BrowserWindow`. (Using `WebContentsView` over the deprecated `BrowserView` — Electron 30+ recommends this.) Only the active tab's WebContentsView is visible (others are hidden but stay alive — preserving WebSocket connections, scroll position, state).

```typescript
interface Tab {
  id: string
  appSlug: string
  title: string
  browserView: WebContentsView
  url: string
}
```

### Tab Operations

| Action | Trigger | Behavior |
|--------|---------|----------|
| Open tab | Click app in sidebar | Create WebContentsView, load app URL, add to tab bar |
| Close tab | Cmd+W or click X | Destroy WebContentsView, remove from tab bar |
| Switch tab | Click tab or Cmd+1-9 | Show target WebContentsView, hide current |
| Reorder | Drag tab in tab bar | Reorder array, persist |
| Reload | Cmd+R | Reload active WebContentsView |
| Duplicate | Right-click → Duplicate | New WebContentsView with same URL |

### Tab Bar UI

Native renderer, rendered above the WebContentsView area:

- Horizontal tab strip with app icon + title per tab
- Active tab highlighted
- Close button (x) per tab
- "+" button opens a tab picker (shows available apps)
- Drag to reorder
- Right-click context menu: Close, Close Others, Duplicate, Reload

### Tab Persistence

Open tabs saved to `electron-store` on change:

```json
{
  "tabs": [
    { "appSlug": "terminal", "url": "https://app.matrix-os.com/?app=terminal" },
    { "appSlug": "chat", "url": "https://app.matrix-os.com/?app=chat" }
  ],
  "activeTabIndex": 0
}
```

On relaunch, tabs are restored. WebContentsViews reload their URLs — the cloud shell restores state (terminal sessions survive via spec 056, chat restores from message history, etc.).

---

## 3. Native Keybindings

Electron's `Menu` with `accelerator` properties intercepts keys before Chromium. These are forwarded to the active WebContentsView via IPC when the shell needs to handle them.

### Keybinding Map

| Shortcut | Action | Implementation |
|----------|--------|----------------|
| Cmd+T | New tab (app picker or default terminal) | Electron Menu accelerator |
| Cmd+W | Close active tab | Electron Menu accelerator |
| Cmd+K | Command palette (forward to shell) | `webContents.send("shortcut", "cmd-k")` |
| Cmd+1 through Cmd+9 | Switch to tab N | Electron Menu accelerator |
| Cmd+Shift+] | Next tab | Electron Menu accelerator |
| Cmd+Shift+[ | Previous tab | Electron Menu accelerator |
| Cmd+, | Settings | Opens settings tab |
| Cmd+R | Reload active tab | WebContentsView reload |
| Cmd+Q | Quit app | Standard Electron quit |
| Cmd+Shift+F | Search in terminal (forward to shell) | `webContents.send("shortcut", "cmd-shift-f")` |

### IPC Bridge

The preload script exposes a bridge so the web shell can detect it's running inside the desktop app:

```typescript
// preload/index.ts
contextBridge.exposeInMainWorld("matrixDesktop", {
  isDesktop: true,
  version: app.getVersion(),
  onShortcut: (cb: (action: string) => void) =>
    ipcRenderer.on("shortcut", (_, action) => cb(action)),
  getConnectionInfo: () => ipcRenderer.invoke("get-connection-info"),
  requestUpgrade: () => ipcRenderer.invoke("request-upgrade"),
})
```

The web shell checks `window.matrixDesktop?.isDesktop` to detect the desktop environment. If present, it:
- Listens for forwarded shortcuts via `onShortcut`
- Hides its own tab bar and sidebar (the desktop app provides native versions)
- Can trigger container upgrades via `requestUpgrade()`

### Shell Detection

The shell needs to know it's in a desktop app so it can hide redundant UI (its own tab bar, sidebar). The WebContentsView URL includes a query param:

```
https://app.matrix-os.com/?app=terminal&desktop=1
```

The shell reads `desktop=1` and renders in "embedded" mode — just the app content, no shell chrome.

---

## 4. System Tray

### Tray Icon

Persistent macOS menu bar icon. Shows a template image (monochrome, adapts to dark/light menu bar).

### Tray Menu

```
Matrix OS
{handle}.matrix-os.com
──────────────────────
● Connected (Running)          [or: ○ Stopped / ✕ Unreachable]
──────────────────────
Open Matrix OS                 Cmd+Shift+M
New Terminal Tab
──────────────────────
Start Container
Stop Container
Upgrade Container              [visible when update available]
──────────────────────
Check for App Updates...
About Matrix OS
──────────────────────
Quit                           Cmd+Q
```

### Connection Health

Main process pings the container every 30 seconds:

```
GET https://app.matrix-os.com/health
```

- Response 200: connected, running (green dot)
- Response 502 "Container unreachable": container stopped or crashed (red dot)
- Response 503 "Failed to wake": container starting (yellow dot)
- Network error: platform unreachable (red dot)

Tray icon and menu update to reflect status. macOS notification sent on state transitions:
- "Your Matrix OS instance is now running" (on wake)
- "Connection lost to Matrix OS" (on disconnect, after 2 consecutive failures to avoid flapping)

---

## 5. Container Management

### Platform API Integration

The desktop app calls the platform API through the shell's existing proxy. Since the Clerk session cookie is shared across WebContentsViews, API calls from the main process reuse the same auth.

For container management, the main process extracts the Clerk session cookie from the active WebContentsView's web session (`session.cookies.get()`) and uses it to make authenticated fetch requests:

| Action | Request | Auth |
|--------|---------|------|
| Start | `POST /api/container/start` | Clerk session cookie (extracted from WebContentsView session) |
| Stop | `POST /api/container/stop` | Clerk session cookie |
| Upgrade | `POST /api/container/upgrade` | Clerk session cookie |
| Health | `GET /health` | None (public) |

These endpoints don't exist yet on the shell/gateway — they need to be added as thin proxies that call the platform API with the user's container handle.

**Recommended approach**: Add gateway endpoints that proxy container management requests to the platform API using the container's self-upgrade token (HMAC of handle + platform secret, already implemented for `self-upgrade`). This way the desktop app calls the gateway through the normal Clerk-authenticated path, and the gateway relays to the platform.

### New Gateway Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/container/start` | Existing gateway auth | Proxy to platform start |
| POST | `/api/container/stop` | Existing gateway auth | Proxy to platform stop |
| POST | `/api/container/upgrade` | Existing gateway auth | Proxy to platform upgrade |
| GET | `/api/container/status` | Existing gateway auth | Container state + version info |

These are thin proxies. The gateway uses its self-upgrade HMAC token to authenticate with the platform.

### Upgrade Flow

1. Desktop app checks for container updates: `GET /api/container/status` returns current image version
2. If update available, upgrade arrow appears in sidebar
3. User clicks upgrade (or tray menu → Upgrade Container)
4. Desktop app calls `POST /api/container/upgrade`
5. Shows progress indicator: "Upgrading your instance..."
6. Container restarts with new image
7. All WebContentsViews reconnect (spec 056's session registry preserves terminal sessions)
8. "Upgrade complete" notification

---

## 6. Auto-Update & Distribution

### Build Configuration

**electron-builder.yml**:

```yaml
appId: com.matrix-os.desktop
productName: Matrix OS
executableName: matrix-os

publish:
  provider: github
  owner: HamedMP
  repo: matrix-os  # or a dedicated matrix-os-desktop repo

mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true
  target:
    - target: dmg
      arch: [universal]
    - target: zip
      arch: [universal]

nsis:
  # Windows config placeholder for future

dmg:
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications
```

**entitlements.mac.plist**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>
```

No `com.apple.security.cs.allow-dyld-environment-variables` needed (no node-pty native modules).

### Auto-Update

**electron-updater** with GitHub Releases:

```typescript
// main/updater.ts
import { autoUpdater } from "electron-updater"

export function initAutoUpdater(tray: Tray) {
  if (is.dev) return

  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.checkForUpdates()

  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)

  autoUpdater.on("update-available", (info) => {
    updateTrayMenu(tray, `Update available: v${info.version}`)
  })

  autoUpdater.on("download-progress", (progress) => {
    updateTrayMenu(tray, `Downloading: ${Math.round(progress.percent)}%`)
  })

  autoUpdater.on("update-downloaded", () => {
    updateTrayMenu(tray, "Update ready — restart to install")
    new Notification({ title: "Matrix OS", body: "Update ready. Restart to install." }).show()
  })
}
```

### CI Build

GitHub Action on tag push (`v*`):

1. Checkout code
2. Install deps (`pnpm install`)
3. Build (`electron-vite build`)
4. Package + sign + notarize (`electron-builder --mac --publish always`)
5. GitHub Release created with DMG + ZIP artifacts

Requires CI secrets:
- `APPLE_ID` — Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD` — for notarization
- `APPLE_TEAM_ID` — Developer team ID
- `CSC_LINK` — Base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD` — Certificate password
- `GH_TOKEN` — GitHub token for release publishing

### Download Page

The matrix-os.com website gets a `/download` page linking to the latest GitHub Release. Detects OS (macOS only for now, shows "coming soon" for Windows/Linux).

---

## 7. Offline Mode

### Behavior

When the cloud container is unreachable:

- Tray shows red dot, "Unreachable"
- Active WebContentsViews show loading error (Chromium's default)
- The native renderer overlays an offline screen on top:

```
    ┌──────────────────────────────────────┐
    │                                      │
    │     [Matrix OS logo]                 │
    │                                      │
    │     Your instance is unreachable     │
    │                                      │
    │     Last connected: 2 minutes ago    │
    │                                      │
    │     [ Retry ]  [ Open Status Page ]  │
    │                                      │
    └──────────────────────────────────────┘
```

- WebContentsViews are preserved in memory (not destroyed)
- When connection restores (health check succeeds), overlay dismissed, WebContentsViews reload
- macOS notification: "Connected to Matrix OS" on reconnect

### No Offline Features

The desktop app is a cloud client. If the cloud is unreachable, it waits. This is honest and matches user expectations for a cloud-connected app (similar to how Notion desktop works).

Future: file sync (Google Drive-style) would enable offline access to files and apps. That's a separate spec.

---

## Security Architecture

### Auth Matrix

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/apps` | Clerk session cookie (via WebContentsView) | App list for sidebar |
| GET | `/health` | None | Connection health check |
| POST | `/api/container/start` | Clerk session cookie | New gateway endpoint |
| POST | `/api/container/stop` | Clerk session cookie | New gateway endpoint |
| POST | `/api/container/upgrade` | Clerk session cookie | New gateway endpoint |
| GET | `/api/container/status` | Clerk session cookie | New gateway endpoint |

### Session Security

- Electron's session storage persists Clerk cookies encrypted on disk (Electron uses OS keychain)
- Context isolation: enabled (`contextIsolation: true` in BrowserWindow)
- Sandbox: enabled
- Preload script: minimal surface — only `matrixDesktop` API exposed via `contextBridge`
- No `nodeIntegration` in renderer (default off, keep it off)
- WebContentsViews restricted to `*.matrix-os.com` origins — no arbitrary URL loading

### Input Validation

- App slugs from `/api/apps`: validated against `[a-z0-9-]+` regex before constructing URLs
- URLs constructed for WebContentsViews: always `https://app.matrix-os.com/...` — never user-controlled
- IPC messages: typed and validated (no arbitrary execution)

---

## Resource Management

| Resource | Limit | Notes |
|----------|-------|-------|
| WebContentsViews | Max 20 open tabs | Beyond 20, prompt user to close tabs |
| Health check interval | 30 seconds | Single fetch, aborted after 5s timeout |
| Auto-update check | Every 4 hours | Non-blocking |
| App list refresh | Every 60 seconds | Cached locally, stale data OK |
| electron-store | ~100KB | Tab state, sidebar order, preferences |

---

## Failure Modes

### Cloud unreachable (no internet)
- Health check fails → tray goes red → offline overlay shown
- Health checks continue every 30 seconds
- On recovery: overlay dismissed, WebContentsViews reload, tray goes green
- Notification on reconnect

### Container stopped
- Platform proxy returns 503 → desktop app shows "Waking up..." screen
- Auto-start is already handled by the platform (same as browser)
- If start fails: show error with manual start button

### Clerk session expired
- WebContentsView navigates to sign-in page
- Desktop app detects navigation to `/sign-in` → shows login view
- After login, restores tabs

### App update while running
- electron-updater downloads in background
- Notification when ready
- Installs on quit + relaunch (no forced restart)

### Container upgrade while tabs open
- Upgrade triggers container restart (10-30 seconds)
- WebContentsViews show loading/reconnecting
- Terminal sessions survive via spec 056 session registry
- After restart, WebContentsViews reload, sessions reattach

---

## Testing Strategy

### Unit Tests

**Tab Manager** (`tabs.test.ts`):
- Create tab returns valid WebContentsView
- Close tab destroys WebContentsView
- Switch tab shows correct WebContentsView, hides others
- Tab persistence: save and restore from electron-store
- Max tab limit enforcement
- Duplicate tab creates new WebContentsView with same URL

**Platform Client** (`platform.test.ts`):
- Start/stop/upgrade call correct endpoints
- Health check returns correct status
- Timeout handling (5s abort)
- Error response parsing

**Tray** (`tray.test.ts`):
- Menu items update based on connection status
- State transitions trigger correct notifications
- Flap prevention: notification only after 2 consecutive failures

**Updater** (`updater.test.ts`):
- Check interval is 4 hours
- Dev mode skips update checks
- Tray menu updates on update stages

### Integration Tests

**Auth flow** (`auth.integration.test.ts`):
- Fresh launch shows sign-in page
- After sign-in, tabs load with Clerk cookie
- Session persists across app restart

**Tab lifecycle** (`tabs.integration.test.ts`):
- Open app from sidebar → WebContentsView created with correct URL
- Switch tabs → correct WebContentsView visible
- Close tab → WebContentsView destroyed
- Relaunch → tabs restored from persistence

**Container management** (`container.integration.test.ts`):
- Start container → status transitions to running
- Stop container → status transitions to stopped
- Upgrade → container restarts, tabs reconnect

### Manual Verification

1. Launch app → sign in → see sidebar with apps
2. Click Terminal → terminal opens in tab, connects to cloud PTY
3. Cmd+T → new tab opens. Cmd+W → tab closes. Cmd+1/2/3 → switches tabs.
4. Cmd+K → command palette opens in the shell
5. Quit app, relaunch → tabs restored, terminal session preserved (spec 056)
6. Disconnect wifi → offline screen shown. Reconnect → auto-recovers.
7. Tray → Stop Container → container stops. Start → wakes up.
8. Tray → Upgrade → container upgrades, terminal sessions survive.
9. New version published → auto-update downloads, installs on restart.

---

## Implementation Phases

### Phase 1: Electron Scaffold + Cloud Shell

- `apps/desktop/` package with electron-vite config
- BrowserWindow loading `app.matrix-os.com`
- Clerk auth flow (sign-in, session persistence)
- Basic tab management (open, close, switch)
- electron-builder config for macOS (unsigned dev builds)

**Checkpoint**: App launches, user signs in, shell loads in a tab. Cmd+W closes it.

### Phase 2: Native Chrome (Sidebar + Tab Bar)

- App launcher sidebar with app list from `/api/apps`
- Tab bar with icons, close buttons, reorder
- WebContentsView-per-tab architecture
- Shell "embedded mode" detection (`?desktop=1`)
- Tab persistence across restarts

**Checkpoint**: Sidebar shows apps, clicking opens tabs, Cmd+1-9 switches, tabs survive relaunch.

### Phase 3: Keybindings + Tray

- Electron Menu with all accelerators
- IPC bridge for forwarding shortcuts to shell
- System tray with connection status
- Health check polling (30s)
- Notifications on state transitions

**Checkpoint**: Cmd+T/W/K work natively. Tray shows green dot. Disconnect wifi → red dot + notification.

### Phase 4: Container Management

- New gateway endpoints: `/api/container/{start,stop,upgrade,status}`
- Desktop app calls these from tray menu and sidebar
- Upgrade flow with progress indicator
- Auto-wake on launch

**Checkpoint**: Stop container from tray → stops. Start → wakes. Upgrade → restarts with new image.

### Phase 5: Distribution

- Code signing + notarization setup
- GitHub Actions CI pipeline
- electron-updater integration
- Download page on matrix-os.com
- Offline mode screen

**Checkpoint**: Tagged release → CI builds + signs + publishes DMG. Users download, auto-update works.
