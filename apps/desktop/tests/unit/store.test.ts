import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("electron-store", () => {
  return {
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

      has(key: keyof T): boolean {
        return key in this.data
      }

      delete(key: keyof T): void {
        delete this.data[key]
      }

      clear(): void {
        this.data = {} as T
      }

      get store(): T {
        return this.data
      }
    },
  }
})

import { createStore, storeDefaults } from "../../src/main/store.js"
import type { StoreSchema } from "../../src/main/store.js"

describe("store", () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  it("initializes with default values", () => {
    expect(store.get("tabs")).toEqual([])
    expect(store.get("activeTabId")).toBeNull()
    expect(store.get("sidebarPinned")).toEqual([
      "terminal",
      "chat",
      "files",
    ])
    expect(store.get("sidebarExpanded")).toBe(false)
  })

  it("returns default window bounds", () => {
    const bounds = store.get("windowBounds")
    expect(bounds).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      maximized: false,
    })
  })

  it("persists tabs", () => {
    const tabs = [
      {
        id: "tab-1",
        appSlug: "terminal",
        url: "https://app.matrix-os.com/?app=terminal&desktop=1",
        title: "Terminal",
      },
    ]
    store.set("tabs", tabs)
    expect(store.get("tabs")).toEqual(tabs)
  })

  it("persists activeTabId", () => {
    store.set("activeTabId", "tab-1")
    expect(store.get("activeTabId")).toBe("tab-1")
  })

  it("persists window bounds", () => {
    const bounds = {
      x: 100,
      y: 200,
      width: 1400,
      height: 900,
      maximized: true,
    }
    store.set("windowBounds", bounds)
    expect(store.get("windowBounds")).toEqual(bounds)
  })

  it("persists sidebar pinned order", () => {
    store.set("sidebarPinned", ["files", "chat"])
    expect(store.get("sidebarPinned")).toEqual(["files", "chat"])
  })

  it("persists sidebar expanded state", () => {
    store.set("sidebarExpanded", true)
    expect(store.get("sidebarExpanded")).toBe(true)
  })

  it("storeDefaults has correct shape", () => {
    expect(storeDefaults).toMatchObject({
      tabs: [],
      activeTabId: null,
      sidebarPinned: expect.any(Array),
      sidebarExpanded: false,
      windowBounds: expect.objectContaining({
        width: 1200,
        height: 800,
      }),
    })
  })
})
