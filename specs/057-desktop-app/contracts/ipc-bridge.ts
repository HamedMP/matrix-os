/**
 * IPC Bridge Contract — Desktop App ↔ Main Process
 *
 * Two preload scripts expose two different APIs:
 * 1. Native chrome preload (sidebar, tab bar) → ElectronAPI (full tab/container control)
 * 2. WebContentsView preload (cloud shell) → MatrixDesktopAPI (minimal: detection + shortcuts)
 */

// ─── Types shared across IPC boundary ────────────────────────────

export interface AppEntry {
  slug: string
  name: string
  icon: string
  category?: string
  description?: string
  builtIn: boolean
}

export type ConnectionStatus = "connected" | "starting" | "unreachable"

export interface ConnectionState {
  status: ConnectionStatus
  lastConnected: number | null
  consecutiveFailures: number
  containerVersion?: string
  updateAvailable?: boolean
}

export interface ContainerStatus {
  handle: string
  state: "running" | "stopped" | "starting" | "upgrading"
  imageVersion: string
  latestVersion?: string
  uptime?: number
}

export interface TabInfo {
  id: string
  appSlug: string
  title: string
  active: boolean
}

// ─── Preload 1: Native Chrome Renderer (sidebar + tab bar) ──────

/** Exposed as window.electronAPI in the native chrome renderer */
export interface ElectronAPI {
  // Tab management
  "tab:create": (appSlug: string) => Promise<string>
  "tab:close": (tabId: string) => Promise<void>
  "tab:switch": (tabId: string) => Promise<void>
  "tab:list": () => Promise<TabInfo[]>
  "tab:reload": (tabId: string) => Promise<void>
  "tab:duplicate": (tabId: string) => Promise<string>

  // Sidebar
  "sidebar:getApps": () => Promise<AppEntry[]>
  "sidebar:setPinned": (slugs: string[]) => Promise<void>
  "sidebar:setExpanded": (expanded: boolean) => Promise<void>

  // Container management
  "container:start": () => Promise<{ success: boolean; error?: string }>
  "container:stop": () => Promise<{ success: boolean; error?: string }>
  "container:upgrade": () => Promise<{ success: boolean; error?: string }>
  "container:status": () => Promise<ContainerStatus>

  // App updates
  "update:check": () => Promise<void>
  "update:install": () => Promise<void>

  // Events (main → renderer)
  onConnectionChanged: (cb: (state: ConnectionState) => void) => void
  onTabsChanged: (cb: (tabs: TabInfo[]) => void) => void
  onAppsChanged: (cb: (apps: AppEntry[]) => void) => void
  onUpdateAvailable: (cb: (version: string) => void) => void
  onUpdateProgress: (cb: (percent: number) => void) => void
  onUpdateDownloaded: (cb: (version: string) => void) => void
  onUpgradeProgress: (cb: (status: string) => void) => void
}

// ─── Preload 2: WebContentsView (cloud shell pages) ─────────────

/** Exposed as window.matrixDesktop in WebContentsViews loading cloud shell */
export interface MatrixDesktopAPI {
  isDesktop: true
  version: string
  onShortcut: (cb: (action: string) => void) => void
  getConnectionInfo: () => Promise<{ status: ConnectionStatus; handle: string }>
  requestUpgrade: () => Promise<{ success: boolean; error?: string }>
}

// ─── Shortcut actions forwarded to WebContentsViews ─────────────

export type ShortcutAction =
  | "cmd-k"           // Command palette
  | "cmd-shift-f"     // Search in terminal
  | "cmd-r"           // Reload (handled at WebContentsView level, but shell may want to know)

// ─── IPC Channel Registry ───────────────────────────────────────

/** All invoke channels (renderer → main, returns Promise) */
export const INVOKE_CHANNELS = [
  "tab:create",
  "tab:close",
  "tab:switch",
  "tab:list",
  "tab:reload",
  "tab:duplicate",
  "sidebar:getApps",
  "sidebar:setPinned",
  "sidebar:setExpanded",
  "container:start",
  "container:stop",
  "container:upgrade",
  "container:status",
  "update:check",
  "update:install",
  // WebContentsView preload channels
  "desktop:getConnectionInfo",
  "desktop:requestUpgrade",
] as const

/** All send channels (main → renderer, one-way) */
export const SEND_CHANNELS = [
  "connection-changed",
  "tabs-changed",
  "apps-changed",
  "update-available",
  "update-progress",
  "update-downloaded",
  "upgrade-progress",
  // WebContentsView channels
  "shortcut",
] as const
