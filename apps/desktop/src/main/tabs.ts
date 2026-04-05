import { WebContentsView } from "electron"
import { randomUUID } from "node:crypto"
import type { Tab, TabInfo, SerializedTab } from "./types.js"
import { getStore } from "./store.js"

const SAFE_SLUG = /^[a-z0-9-]+$/
const MAX_TABS = 20
const BASE_URL = "https://app.matrix-os.com"
const patchedSessions = new WeakSet<object>()

function toBrowserLikeUserAgent(userAgent: string): string {
  const sanitized = userAgent
    .replace(/(?:^|\s)Electron\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  return sanitized || "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

export class TabManager {
  private tabs: Tab[] = []
  private activeTabId: string | null = null
  private preloadPath: string | undefined
  onSessionExpired: (() => void) | undefined

  constructor(preloadPath?: string) {
    this.preloadPath = preloadPath
  }

  createTab(appSlug: string, title: string): Tab {
    if (!SAFE_SLUG.test(appSlug)) {
      throw new Error(`Invalid app slug: "${appSlug}"`)
    }
    if (this.tabs.length >= MAX_TABS) {
      throw new Error(`Maximum ${MAX_TABS} tabs allowed`)
    }

    const id = randomUUID()
    const url = `${BASE_URL}/?app=${appSlug}&desktop=1`

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...(this.preloadPath ? { preload: this.preloadPath } : {}),
      },
    })

    const tabSession = view.webContents.session
    const browserUserAgent = toBrowserLikeUserAgent(tabSession.getUserAgent())
    view.webContents.setUserAgent(browserUserAgent)

    // Allow navigation to matrix-os.com + OAuth providers (Google, Clerk)
    view.webContents.on("will-navigate" as string, (event: Event & { url?: string }, navUrl: string) => {
      const target = navUrl ?? (event as unknown as { url: string }).url
      if (target && !this.isAllowedNavigation(target)) {
        (event as Event & { preventDefault: () => void }).preventDefault()
      }
    })

    // Allow OAuth popups to open as new windows in-app
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (this.isAllowedNavigation(openUrl)) {
        return {
          action: "allow" as const,
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            show: true,
            width: 520,
            height: 760,
            titleBarStyle: "default",
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        }
      }
      return { action: "deny" as const }
    })

    // Keep Google OAuth requests aligned with the browser-like navigator.userAgent.
    if (!patchedSessions.has(tabSession as object)) {
      tabSession.webRequest.onBeforeSendHeaders(
        { urls: ["https://accounts.google.com/*", "https://*.google.com/*"] },
        (details, callback) => {
          details.requestHeaders["User-Agent"] = browserUserAgent
          callback({ requestHeaders: details.requestHeaders })
        },
      )
      patchedSessions.add(tabSession as object)
    }

    view.webContents.on("did-navigate" as string, (_event: unknown, navUrl: string) => {
      if (navUrl && navUrl.includes("/sign-in")) {
        this.onSessionExpired?.()
      }
    })

    view.webContents.loadURL(url)

    const tab: Tab = { id, appSlug, title, url, view }
    this.tabs.push(tab)
    this.activeTabId = id

    return tab
  }

  closeTab(tabId: string): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return

    const tab = this.tabs[idx]
    tab.view?.webContents.close()
    this.tabs.splice(idx, 1)

    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[this.tabs.length - 1]?.id ?? null
    }
  }

  switchTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (tab) {
      this.activeTabId = tabId
    }
  }

  getActiveTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId)
  }

  getTabs(): Tab[] {
    return this.tabs
  }

  getTabInfos(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      appSlug: t.appSlug,
      title: t.title,
      active: t.id === this.activeTabId,
    }))
  }

  reloadTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId)
    tab?.view?.webContents.reload()
  }

  duplicateTab(tabId: string): Tab | undefined {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return undefined
    return this.createTab(tab.appSlug, tab.title)
  }

  forwardShortcut(action: string): void {
    const activeTab = this.getActiveTab()
    activeTab?.view?.webContents.send("shortcut", action)
  }

  saveToStore(): void {
    const store = getStore()
    const serialized: SerializedTab[] = this.tabs.map((t) => ({
      id: t.id,
      appSlug: t.appSlug,
      url: t.url,
      title: t.title,
    }))
    store.set("tabs", serialized)
    store.set("activeTabId", this.activeTabId)
  }

  restoreFromStore(): void {
    const store = getStore()
    const saved = store.get("tabs")
    const activeId = store.get("activeTabId")

    for (const s of saved) {
      const tab = this.createTab(s.appSlug, s.title)
      if (s.id === activeId) {
        this.activeTabId = tab.id
      }
    }
  }

  reloadAllTabs(): void {
    for (const tab of this.tabs) {
      tab.view?.webContents.reload()
    }
  }

  private isAllowedNavigation(url: string): boolean {
    try {
      const parsed = new URL(url)
      const allowed = [
        "matrix-os.com",
        "accounts.google.com",
        "google.com",
        "clerk.com",
        "clerk.dev",
        "clerk.accounts.dev",
        "accounts.dev",
        "clerkjs.com",
      ]
      return allowed.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith("." + d),
      )
    } catch {
      return false
    }
  }
}
