import { contextBridge, ipcRenderer } from "electron"

const electronAPI = {
  // Tab management
  "tab:create": (appSlug: string) => ipcRenderer.invoke("tab:create", appSlug),
  "tab:close": (tabId: string) => ipcRenderer.invoke("tab:close", tabId),
  "tab:switch": (tabId: string) => ipcRenderer.invoke("tab:switch", tabId),
  "tab:list": () => ipcRenderer.invoke("tab:list"),
  "tab:reload": (tabId: string) => ipcRenderer.invoke("tab:reload", tabId),
  "tab:duplicate": (tabId: string) =>
    ipcRenderer.invoke("tab:duplicate", tabId),

  // Sidebar
  "sidebar:getApps": () => ipcRenderer.invoke("sidebar:getApps"),
  "sidebar:setPinned": (slugs: string[]) =>
    ipcRenderer.invoke("sidebar:setPinned", slugs),
  "sidebar:setExpanded": (expanded: boolean) =>
    ipcRenderer.invoke("sidebar:setExpanded", expanded),

  // Container management
  "container:start": () => ipcRenderer.invoke("container:start"),
  "container:stop": () => ipcRenderer.invoke("container:stop"),
  "container:upgrade": () => ipcRenderer.invoke("container:upgrade"),
  "container:status": () => ipcRenderer.invoke("container:status"),

  // App updates
  "update:check": () => ipcRenderer.invoke("update:check"),
  "update:install": () => ipcRenderer.invoke("update:install"),

  // Events (main -> renderer)
  onConnectionChanged(cb: (state: unknown) => void): void {
    ipcRenderer.on("connection-changed", (_event, state) => cb(state))
  },
  onTabsChanged(cb: (tabs: unknown[]) => void): void {
    ipcRenderer.on("tabs-changed", (_event, tabs) => cb(tabs))
  },
  onAppsChanged(cb: (apps: unknown[]) => void): void {
    ipcRenderer.on("apps-changed", (_event, apps) => cb(apps))
  },
  onUpdateAvailable(cb: (version: string) => void): void {
    ipcRenderer.on("update-available", (_event, version) => cb(version))
  },
  onUpdateProgress(cb: (percent: number) => void): void {
    ipcRenderer.on("update-progress", (_event, percent) => cb(percent))
  },
  onUpdateDownloaded(cb: (version: string) => void): void {
    ipcRenderer.on("update-downloaded", (_event, version) => cb(version))
  },
  onUpgradeProgress(cb: (status: string) => void): void {
    ipcRenderer.on("upgrade-progress", (_event, status) => cb(status))
  },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)
