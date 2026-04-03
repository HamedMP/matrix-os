# Data Model: 057 Desktop App

## Main Process Types

### Tab

```typescript
interface Tab {
  id: string                    // UUID, generated on creation
  appSlug: string               // e.g. "terminal", "chat", "files"
  title: string                 // Display title (from app manifest)
  url: string                   // Full URL: https://app.matrix-os.com/?app={slug}&desktop=1
  view: WebContentsView | null  // Electron WebContentsView instance (null when serialized)
}
```

### AppEntry (from gateway `/api/apps`)

```typescript
interface AppEntry {
  slug: string          // e.g. "terminal"
  name: string          // e.g. "Terminal"
  icon: string          // URL path: /files/system/icons/terminal.png
  category?: string     // e.g. "system", "productivity"
  description?: string
  builtIn: boolean      // System app vs user-installed
}
```

### ConnectionState

```typescript
type ConnectionStatus = "connected" | "starting" | "unreachable"

interface ConnectionState {
  status: ConnectionStatus
  lastConnected: number | null   // Unix timestamp ms
  consecutiveFailures: number    // Reset to 0 on success
  containerVersion?: string      // From /api/container/status
  updateAvailable?: boolean      // True if newer image exists
}
```

### ContainerStatus (from gateway `/api/container/status`)

```typescript
interface ContainerStatus {
  handle: string
  state: "running" | "stopped" | "starting" | "upgrading"
  imageVersion: string          // Current image tag
  latestVersion?: string        // Latest available tag (if different)
  uptime?: number               // Seconds since container start
}
```

## Persistence Schema (electron-store)

```typescript
interface StoreSchema {
  tabs: Array<{
    id: string
    appSlug: string
    url: string
    title: string
  }>
  activeTabId: string | null
  sidebarPinned: string[]       // Ordered list of pinned app slugs
  sidebarExpanded: boolean       // true = 200px, false = 64px
  windowBounds: {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
  }
}
```

## IPC Bridge (preload → renderer ← main)

### matrixDesktop API (exposed to WebContentsViews)

```typescript
interface MatrixDesktopAPI {
  isDesktop: true
  version: string
  onShortcut: (cb: (action: string) => void) => void
  getConnectionInfo: () => Promise<{ status: ConnectionStatus; handle: string }>
  requestUpgrade: () => Promise<{ success: boolean; error?: string }>
}
```

### Internal IPC (native chrome renderer ↔ main)

```typescript
// Renderer → Main (invoke channels)
type IPCInvokeChannels = {
  "tab:create": (appSlug: string) => string          // Returns tab ID
  "tab:close": (tabId: string) => void
  "tab:switch": (tabId: string) => void
  "tab:list": () => Array<{ id: string; appSlug: string; title: string; active: boolean }>
  "sidebar:get-apps": () => AppEntry[]
  "sidebar:set-pinned": (slugs: string[]) => void
  "sidebar:set-expanded": (expanded: boolean) => void
  "container:start": () => { success: boolean; error?: string }
  "container:stop": () => { success: boolean; error?: string }
  "container:upgrade": () => { success: boolean; error?: string }
  "container:status": () => ContainerStatus
  "update:install": () => void
}

// Main → Renderer (send channels)
type IPCSendChannels = {
  "connection-changed": ConnectionState
  "tabs-changed": Array<{ id: string; appSlug: string; title: string; active: boolean }>
  "apps-changed": AppEntry[]
  "update-available": string        // version
  "update-progress": number         // percent
  "update-downloaded": string       // version
  "upgrade-progress": string        // status message
}
```

## State Machines

### Connection Health

```
                 200 OK
    ┌──────── connected ◄────────┐
    │              │              │
    │       502/503/error        │
    │              ▼              │
    │     consecutiveFailures++  │
    │              │              │
    │    failures < 2?           │
    │      │           │         │
    │     yes          no        │
    │      │           │         │
    │      ▼           ▼         │
    │  (stay)    unreachable ────┘
    │                    200 OK
    │
    │   503 "wake"
    └──► starting ──────────────┘
              200 OK
```

### Tab Lifecycle

```
  sidebar click / Cmd+T
         │
         ▼
    [create tab]
    - Generate UUID
    - Create WebContentsView
    - Load URL: https://app.matrix-os.com/?app={slug}&desktop=1
    - Add to tabs array
    - Show (addChildView + setBounds)
    - Save to electron-store
         │
    ┌────┴────┐
    │ active  │◄── tab:switch (show this, hide others)
    └────┬────┘
         │
    Cmd+W / click X
         │
         ▼
    [close tab]
    - removeChildView
    - webContents.close()  // IMPORTANT: prevents memory leak
    - Remove from tabs array
    - Save to electron-store
    - If last tab: open default (terminal)
```
