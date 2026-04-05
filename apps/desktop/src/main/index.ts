import {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from "electron"
import { join } from "node:path"
import { TabManager } from "./tabs.js"
import { PlatformClient } from "./platform.js"
import { getStore } from "./store.js"

const SIDEBAR_COLLAPSED_WIDTH = 64
const SIDEBAR_EXPANDED_WIDTH = 200
const TAB_BAR_HEIGHT = 36

let mainWindow: BaseWindow | null = null
let chromeView: WebContentsView | null = null
let tabManager: TabManager | null = null
let platform: PlatformClient | null = null
let chromeVisible = false

function getSidebarWidth(): number {
  const store = getStore()
  return store.get("sidebarExpanded")
    ? SIDEBAR_EXPANDED_WIDTH
    : SIDEBAR_COLLAPSED_WIDTH
}

function layoutViews(): void {
  if (!mainWindow) return
  const [width, height] = mainWindow.getContentSize()

  // Tab bar strip at top
  if (chromeView) {
    chromeView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT })
  }

  // Tab content below the tab bar
  const activeTab = tabManager?.getActiveTab()
  if (activeTab?.view) {
    activeTab.view.setBounds({
      x: 0,
      y: TAB_BAR_HEIGHT,
      width,
      height: height - TAB_BAR_HEIGHT,
    })
  }
}

function showChrome(): void {
  if (chromeVisible || !mainWindow) return

  // Lazily create chrome view on first use
  if (!chromeView) {
    const preloadChrome = join(__dirname, "../preload/chrome-preload.js")
    chromeView = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadChrome,
      },
    })
    const rendererUrl = join(__dirname, "../renderer/index.html")
    chromeView.webContents.loadFile(rendererUrl)
  }

  chromeVisible = true
  mainWindow.contentView.addChildView(chromeView)
  layoutViews()
}

function hideChrome(): void {
  if (!chromeVisible || !mainWindow || !chromeView) return
  chromeVisible = false
  mainWindow.contentView.removeChildView(chromeView)
  layoutViews()
}

function showTab(tabId: string): void {
  if (!mainWindow || !tabManager) return

  const prevTab = tabManager.getActiveTab()
  if (prevTab?.view) {
    mainWindow.contentView.removeChildView(prevTab.view)
  }

  tabManager.switchTab(tabId)
  const newTab = tabManager.getActiveTab()
  if (newTab?.view) {
    mainWindow.contentView.addChildView(newTab.view)
    layoutViews()
  }

  tabManager.saveToStore()
  sendTabsChanged()
}

function sendTabsChanged(): void {
  if (!tabManager || !chromeView) return
  chromeView.webContents.send("tabs-changed", tabManager.getTabInfos())
}

function registerIPC(): void {
  ipcMain.handle("tab:create", async (_event, appSlug: string) => {
    if (!tabManager || !mainWindow) return null
    const tab = tabManager.createTab(appSlug, appSlug)
    mainWindow.contentView.addChildView(tab.view!)
    showTab(tab.id)
    return tab.id
  })

  ipcMain.handle("tab:close", async (_event, tabId: string) => {
    if (!tabManager || !mainWindow) return
    const tab = tabManager.getTabs().find((t) => t.id === tabId)
    if (tab?.view) {
      mainWindow.contentView.removeChildView(tab.view)
    }
    tabManager.closeTab(tabId)
    tabManager.saveToStore()

    if (tabManager.getTabs().length === 0) {
      const defaultTab = tabManager.createTab("terminal", "Terminal")
      mainWindow.contentView.addChildView(defaultTab.view!)
      showTab(defaultTab.id)
    } else {
      const active = tabManager.getActiveTab()
      if (active) showTab(active.id)
    }
    sendTabsChanged()
  })

  ipcMain.handle("tab:switch", async (_event, tabId: string) => {
    showTab(tabId)
  })

  ipcMain.handle("tab:list", async () => {
    return tabManager?.getTabInfos() ?? []
  })

  ipcMain.handle("tab:reload", async (_event, tabId: string) => {
    tabManager?.reloadTab(tabId)
  })

  ipcMain.handle("tab:duplicate", async (_event, tabId: string) => {
    if (!tabManager || !mainWindow) return null
    const newTab = tabManager.duplicateTab(tabId)
    if (newTab?.view) {
      mainWindow.contentView.addChildView(newTab.view)
      showTab(newTab.id)
    }
    return newTab?.id ?? null
  })

  ipcMain.handle("sidebar:getApps", async () => {
    return platform?.fetchApps() ?? []
  })

  ipcMain.handle("sidebar:setPinned", async (_event, slugs: string[]) => {
    getStore().set("sidebarPinned", slugs)
  })

  ipcMain.handle("sidebar:setExpanded", async (_event, expanded: boolean) => {
    getStore().set("sidebarExpanded", expanded)
    layoutViews()
  })

  ipcMain.handle("container:start", async () => {
    return platform?.startContainer() ?? { success: false, error: "Not ready" }
  })

  ipcMain.handle("container:stop", async () => {
    return platform?.stopContainer() ?? { success: false, error: "Not ready" }
  })

  ipcMain.handle("container:upgrade", async () => {
    return (
      platform?.upgradeContainer() ?? { success: false, error: "Not ready" }
    )
  })

  ipcMain.handle("container:status", async () => {
    return platform?.getContainerStatus() ?? null
  })

  ipcMain.handle("update:check", async () => {
    // Wired in Phase 8 (updater.ts)
  })

  ipcMain.handle("update:install", async () => {
    // Wired in Phase 8 (updater.ts)
  })
}

function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            if (!tabManager || !mainWindow) return
            const tab = tabManager.createTab("settings", "Settings")
            mainWindow.contentView.addChildView(tab.view!)
            showTab(tab.id)
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Tab",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => {
            if (!tabManager || !mainWindow) return
            const tab = tabManager.createTab("terminal", "Terminal")
            mainWindow.contentView.addChildView(tab.view!)
            showTab(tab.id)
          },
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            if (!tabManager || !mainWindow) return
            const active = tabManager.getActiveTab()
            if (active) {
              ipcMain.emit("tab:close", null, active.id)
            }
          },
        },
        { type: "separator" },
        {
          label: "Reload Tab",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            tabManager?.getActiveTab()?.view?.webContents.reload()
          },
        },
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => {
            const tabs = tabManager?.getTabs()
            if (tabs && tabs[i]) showTab(tabs[i].id)
          },
        })),
        { type: "separator" },
        {
          label: "Next Tab",
          accelerator: "CmdOrCtrl+Shift+]",
          click: () => {
            if (!tabManager) return
            const tabs = tabManager.getTabs()
            const active = tabManager.getActiveTab()
            if (!active || tabs.length < 2) return
            const idx = tabs.findIndex((t) => t.id === active.id)
            showTab(tabs[(idx + 1) % tabs.length].id)
          },
        },
        {
          label: "Previous Tab",
          accelerator: "CmdOrCtrl+Shift+[",
          click: () => {
            if (!tabManager) return
            const tabs = tabManager.getTabs()
            const active = tabManager.getActiveTab()
            if (!active || tabs.length < 2) return
            const idx = tabs.findIndex((t) => t.id === active.id)
            showTab(tabs[(idx - 1 + tabs.length) % tabs.length].id)
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Tab DevTools",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => {
            const active = tabManager?.getActiveTab()
            if (active?.view?.webContents) {
              active.view.webContents.toggleDevTools()
            }
          },
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function saveBoundsDebounced(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const handler = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!mainWindow) return
      const bounds = mainWindow.getBounds()
      getStore().set("windowBounds", {
        ...bounds,
        maximized: mainWindow.isMaximized(),
      })
    }, 500)
  }
  mainWindow!.on("move", handler)
  mainWindow!.on("resize", handler)
}

async function createWindow(): Promise<void> {
  const store = getStore()
  const bounds = store.get("windowBounds")

  mainWindow = new BaseWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x || undefined,
    y: bounds.y || undefined,
    titleBarStyle: "hiddenInset",
    title: "Matrix OS",
    minWidth: 800,
    minHeight: 600,
    show: false,
  })

  if (bounds.maximized) {
    mainWindow.maximize()
  }

  // Tab bar chrome view — thin strip at top, no sidebar
  const preloadChrome = join(__dirname, "../preload/chrome-preload.js")
  chromeView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadChrome,
    },
  })
  const rendererUrl = join(__dirname, "../renderer/index.html")
  chromeView.webContents.loadFile(rendererUrl)
  mainWindow.contentView.addChildView(chromeView)

  const preloadWcv = join(__dirname, "../preload/index.js")
  tabManager = new TabManager(preloadWcv)
  platform = new PlatformClient()

  // Detect auth completion: when a tab navigates AWAY from /sign-in, show chrome
  tabManager.onSessionExpired = () => hideChrome()

  const savedTabs = store.get("tabs")
  if (savedTabs.length > 0) {
    for (const saved of savedTabs) {
      const tab = tabManager.createTab(saved.appSlug, saved.title)
      mainWindow.contentView.addChildView(tab.view!)
    }
    const activeId = store.get("activeTabId")
    const tabs = tabManager.getTabs()
    const target = tabs.find((t) => t.id === activeId) ?? tabs[0]
    if (target) showTab(target.id)
  } else {
    const tab = tabManager.createTab("terminal", "Terminal")
    mainWindow.contentView.addChildView(tab.view!)
    showTab(tab.id)
  }

  // The shell handles its own UI (dock, windows, tabs). The native chrome sidebar
  // is disabled — the tab always fills the full window. Native chrome (sidebar + tab bar)
  // can be enabled in a future version when the shell supports deferring to it.
  // For now, just prevent the WebContentsView from changing the window title.
  const activeWc = tabManager?.getActiveTab()?.view?.webContents
  if (activeWc) {
    activeWc.on("page-title-updated", (event: Event) => {
      (event as Event & { preventDefault: () => void }).preventDefault()
    })
  }

  mainWindow.on("resize", layoutViews)
  saveBoundsDebounced()

  // No splash screen — tab fills window directly

  mainWindow.on("close", () => {
    tabManager?.saveToStore()
  })

  // Shortcut forwarding via before-input-event
  mainWindow.on(
    "before-input-event" as string,
    (_event: unknown, input: { key: string; meta: boolean; shift: boolean; type: string }) => {
      if (input.type !== "keyDown" || !input.meta) return
      if (input.key === "k") {
        tabManager?.forwardShortcut("cmd-k")
      } else if (input.shift && input.key === "f") {
        tabManager?.forwardShortcut("cmd-shift-f")
      }
    },
  )

  mainWindow.show()
}

app.whenReady().then(async () => {
  registerIPC()
  buildAppMenu()
  await createWindow()

  // Auto-wake container on launch
  try {
    const status = await platform!.getContainerStatus()
    if (status.state === "stopped") {
      await platform!.startContainer()
    }
  } catch {
    // Container status check failed — health monitor will handle
  }

  // Periodic app list refresh (60s)
  setInterval(async () => {
    try {
      const apps = await platform!.fetchApps()
      chromeView?.webContents.send("apps-changed", apps)
    } catch {
      // Silent — health monitor handles connection state
    }
  }, 60_000)
})

app.on("window-all-closed", () => {
  app.quit()
})

app.on("activate", () => {
  if (!mainWindow) {
    createWindow()
  }
})
