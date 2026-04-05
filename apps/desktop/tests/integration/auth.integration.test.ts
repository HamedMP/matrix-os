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
      once: vi.fn(),
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

describe("auth integration", () => {
  let manager: TabManager

  beforeEach(() => {
    manager = new TabManager()
  })

  it("fresh launch creates initial tab targeting cloud shell", () => {
    const tab = manager.createTab("terminal", "Terminal")
    expect(tab.url).toBe(
      "https://app.matrix-os.com/?app=terminal&desktop=1",
    )
    expect(tab.view).toBeTruthy()
    expect(tab.view!.webContents.loadURL).toHaveBeenCalledWith(tab.url)
  })

  it("session persists across app restart via store", () => {
    manager.createTab("terminal", "Terminal")
    manager.createTab("chat", "Chat")
    manager.saveToStore()

    const manager2 = new TabManager()
    manager2.restoreFromStore()

    expect(manager2.getTabs()).toHaveLength(2)
    expect(manager2.getTabs()[0].appSlug).toBe("terminal")
    expect(manager2.getTabs()[1].appSlug).toBe("chat")
  })

  it("session expiration callback triggers on sign-in navigation", () => {
    const onExpired = vi.fn()
    manager.onSessionExpired = onExpired

    const tab = manager.createTab("terminal", "Terminal")

    // Simulate did-navigate to sign-in
    const didNavigateCall = tab.view!.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-navigate",
    )
    if (didNavigateCall) {
      const handler = didNavigateCall[1] as (event: unknown, url: string) => void
      handler({}, "https://app.matrix-os.com/sign-in")
      expect(onExpired).toHaveBeenCalled()
    }
  })
})
