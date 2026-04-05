import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("electron", () => ({
  WebContentsView: class MockWebContentsView {
    webContents = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getUserAgent: vi.fn(() => "Mozilla/5.0 Chrome/141.0.0.0 Electron/41.1.1 Safari/537.36"),
      on: vi.fn(),
      setUserAgent: vi.fn(),
      send: vi.fn(),
      reload: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: {
        getUserAgent: vi.fn(() => "Mozilla/5.0 Chrome/141.0.0.0 Electron/41.1.1 Safari/537.36"),
        webRequest: {
          onBeforeSendHeaders: vi.fn(),
        },
      },
      id: Math.floor(Math.random() * 10000),
    }
    setBounds = vi.fn()
    constructor(_opts?: unknown) {}
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
}))

vi.mock("electron-store", () => ({
  default: class MockStore<T extends Record<string, unknown>> {
    private data: T
    constructor(opts?: { defaults?: T }) {
      this.data = structuredClone(opts?.defaults ?? ({} as T))
    }
    get<K extends keyof T>(key: K): T[K] {
      return this.data[key]
    }
    set<K extends keyof T>(key: K, value: T[K]): void
    set(key: Partial<T>): void
    set<K extends keyof T>(keyOrObj: K | Partial<T>, value?: T[K]): void {
      if (typeof keyOrObj === "string") {
        this.data[keyOrObj] = value!
      } else {
        Object.assign(this.data, keyOrObj)
      }
    }
    get store(): T {
      return this.data
    }
  },
}))

import { TabManager } from "../../src/main/tabs.js"

describe("tabs integration", () => {
  let manager: TabManager

  beforeEach(() => {
    manager = new TabManager()
  })

  it("open app from sidebar creates WebContentsView with correct URL", () => {
    const tab = manager.createTab("files", "Files")
    expect(tab.url).toBe(
      "https://app.matrix-os.com/?app=files&desktop=1",
    )
    expect(tab.view).not.toBeNull()
    expect(tab.view!.webContents.loadURL).toHaveBeenCalledWith(tab.url)
  })

  it("switch tabs updates active state", () => {
    const tab1 = manager.createTab("terminal", "Terminal")
    const tab2 = manager.createTab("chat", "Chat")

    manager.switchTab(tab1.id)
    let infos = manager.getTabInfos()
    expect(infos.find((t) => t.id === tab1.id)?.active).toBe(true)
    expect(infos.find((t) => t.id === tab2.id)?.active).toBe(false)

    manager.switchTab(tab2.id)
    infos = manager.getTabInfos()
    expect(infos.find((t) => t.id === tab1.id)?.active).toBe(false)
    expect(infos.find((t) => t.id === tab2.id)?.active).toBe(true)
  })

  it("close tab calls webContents.close to prevent memory leak", () => {
    const tab = manager.createTab("terminal", "Terminal")
    const closeFn = tab.view!.webContents.close
    manager.closeTab(tab.id)
    expect(closeFn).toHaveBeenCalled()
  })

  it("relaunch restores tabs from electron-store", () => {
    manager.createTab("terminal", "Terminal")
    manager.createTab("files", "Files")
    manager.createTab("chat", "Chat")
    manager.saveToStore()

    const manager2 = new TabManager()
    manager2.restoreFromStore()

    const tabs = manager2.getTabs()
    expect(tabs).toHaveLength(3)
    expect(tabs.map((t) => t.appSlug)).toEqual([
      "terminal",
      "files",
      "chat",
    ])
  })

  it("duplicate tab creates new entry with same slug", () => {
    const original = manager.createTab("terminal", "Terminal")
    const dup = manager.duplicateTab(original.id)

    expect(dup).toBeTruthy()
    expect(dup!.id).not.toBe(original.id)
    expect(dup!.appSlug).toBe("terminal")
    expect(manager.getTabs()).toHaveLength(2)
  })

  it("shortcut forwarding sends to active tab", () => {
    const tab1 = manager.createTab("terminal", "Terminal")
    manager.createTab("chat", "Chat")

    manager.switchTab(tab1.id)
    manager.forwardShortcut("cmd-k")

    expect(tab1.view!.webContents.send).toHaveBeenCalledWith(
      "shortcut",
      "cmd-k",
    )
  })

  it("reload all tabs reloads every view", () => {
    const tab1 = manager.createTab("terminal", "Terminal")
    const tab2 = manager.createTab("chat", "Chat")

    manager.reloadAllTabs()

    expect(tab1.view!.webContents.reload).toHaveBeenCalled()
    expect(tab2.view!.webContents.reload).toHaveBeenCalled()
  })
})
