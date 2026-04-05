import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockFetch = vi.fn()
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
      fetch: (...args: unknown[]) => mockFetch(...args),
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

import { PlatformClient } from "../../src/main/platform.js"
import { TabManager } from "../../src/main/tabs.js"

describe("container integration", () => {
  let client: PlatformClient
  let tabManager: TabManager

  beforeEach(() => {
    client = new PlatformClient()
    tabManager = new TabManager()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("start container via IPC calls gateway POST /api/container/start", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    })

    const result = await client.startContainer()
    expect(mockFetch).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/container/start",
      expect.objectContaining({ method: "POST" }),
    )
    expect(result).toEqual({ success: true })
  })

  it("stop container transitions status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    })

    const result = await client.stopContainer()
    expect(result.success).toBe(true)
  })

  it("upgrade triggers reload of all WebContentsViews", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, previousVersion: "v0.8.0", newVersion: "v0.9.0" }),
    })

    const tab1 = tabManager.createTab("terminal", "Terminal")
    const tab2 = tabManager.createTab("chat", "Chat")

    await client.upgradeContainer()
    tabManager.reloadAllTabs()

    expect(tab1.view!.webContents.reload).toHaveBeenCalled()
    expect(tab2.view!.webContents.reload).toHaveBeenCalled()
  })

  it("getContainerStatus returns container info", async () => {
    const status = {
      handle: "hamed",
      state: "running",
      imageVersion: "v0.9.0",
      latestVersion: "v0.9.0",
      uptime: 3600,
    }
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    })

    const result = await client.getContainerStatus()
    expect(result).toEqual(status)
  })

  it("platform unreachable throws descriptive error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    })

    await expect(client.startContainer()).rejects.toThrow(
      /container operation failed/i,
    )
  })
})
