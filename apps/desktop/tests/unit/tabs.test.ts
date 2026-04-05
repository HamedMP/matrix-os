import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("electron", () => ({
  WebContentsView: class MockWebContentsView {
    webContents = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getUserAgent: vi.fn(() => "Mozilla/5.0 Chrome/141.0.0.0 Electron/41.1.1 Safari/537.36"),
      on: vi.fn(),
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      reload: vi.fn(),
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
import type { TabInfo } from "../../src/main/types.js"

describe("TabManager", () => {
  let manager: TabManager

  beforeEach(() => {
    manager = new TabManager()
  })

  describe("createTab", () => {
    it("creates a tab with correct URL pattern", () => {
      const tab = manager.createTab("terminal", "Terminal")
      expect(tab.url).toBe(
        "https://app.matrix-os.com/?app=terminal&desktop=1",
      )
      expect(tab.appSlug).toBe("terminal")
      expect(tab.title).toBe("Terminal")
      expect(tab.id).toBeTruthy()
    })

    it("uses a browser-like user agent for auth flows", () => {
      const tab = manager.createTab("terminal", "Terminal")

      expect(tab.view!.webContents.setUserAgent).toHaveBeenCalledWith(
        "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      )
    })

    it("generates unique IDs", () => {
      const tab1 = manager.createTab("terminal", "Terminal")
      const tab2 = manager.createTab("chat", "Chat")
      expect(tab1.id).not.toBe(tab2.id)
    })

    it("allows duplicate slugs with separate tabs", () => {
      const tab1 = manager.createTab("terminal", "Terminal")
      const tab2 = manager.createTab("terminal", "Terminal")
      expect(tab1.id).not.toBe(tab2.id)
      expect(manager.getTabs()).toHaveLength(2)
    })

    it("enforces max 20 tab limit", () => {
      for (let i = 0; i < 20; i++) {
        manager.createTab("terminal", `Terminal ${i}`)
      }
      expect(manager.getTabs()).toHaveLength(20)
      expect(() => manager.createTab("terminal", "Terminal 21")).toThrow(
        /maximum/i,
      )
    })
  })

  describe("closeTab", () => {
    it("removes tab from list", () => {
      const tab = manager.createTab("terminal", "Terminal")
      manager.closeTab(tab.id)
      expect(manager.getTabs()).toHaveLength(0)
    })

    it("calls webContents.close on the view", () => {
      const tab = manager.createTab("terminal", "Terminal")
      const closeFn = tab.view!.webContents.close
      manager.closeTab(tab.id)
      expect(closeFn).toHaveBeenCalled()
    })

    it("does nothing for unknown tab ID", () => {
      manager.createTab("terminal", "Terminal")
      manager.closeTab("nonexistent")
      expect(manager.getTabs()).toHaveLength(1)
    })
  })

  describe("switchTab", () => {
    it("updates active tab ID", () => {
      const tab1 = manager.createTab("terminal", "Terminal")
      const tab2 = manager.createTab("chat", "Chat")
      manager.switchTab(tab2.id)
      const tabs = manager.getTabInfos()
      expect(tabs.find((t) => t.id === tab2.id)?.active).toBe(true)
      expect(tabs.find((t) => t.id === tab1.id)?.active).toBe(false)
    })
  })

  describe("getTabs", () => {
    it("returns all tabs", () => {
      manager.createTab("terminal", "Terminal")
      manager.createTab("chat", "Chat")
      expect(manager.getTabs()).toHaveLength(2)
    })
  })

  describe("getTabInfos", () => {
    it("returns serializable tab info", () => {
      const tab = manager.createTab("terminal", "Terminal")
      manager.switchTab(tab.id)
      const infos = manager.getTabInfos()
      expect(infos[0]).toEqual({
        id: tab.id,
        appSlug: "terminal",
        title: "Terminal",
        active: true,
      })
    })
  })

  describe("URL validation", () => {
    it("rejects invalid slugs", () => {
      expect(() =>
        manager.createTab("../../../etc/passwd", "Hack"),
      ).toThrow(/invalid/i)
      expect(() =>
        manager.createTab("<script>alert(1)</script>", "XSS"),
      ).toThrow(/invalid/i)
      expect(() => manager.createTab("", "Empty")).toThrow(/invalid/i)
    })

    it("accepts valid slugs", () => {
      expect(() => manager.createTab("terminal", "Terminal")).not.toThrow()
      expect(() =>
        manager.createTab("my-cool-app", "My Cool App"),
      ).not.toThrow()
      expect(() => manager.createTab("app123", "App 123")).not.toThrow()
    })
  })
})
