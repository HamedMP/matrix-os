import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import type { ConnectionState } from "../../src/main/types.js"

const {
  mockBuildFromTemplate,
  mockSetContextMenu,
  mockSetImage,
  mockSetToolTip,
  mockDestroy,
  mockOn,
  mockQuit,
} = vi.hoisted(() => ({
  mockBuildFromTemplate: vi.fn().mockReturnValue({ popup: vi.fn() }),
  mockSetContextMenu: vi.fn(),
  mockSetImage: vi.fn(),
  mockSetToolTip: vi.fn(),
  mockDestroy: vi.fn(),
  mockOn: vi.fn(),
  mockQuit: vi.fn(),
}))

vi.mock("electron", () => ({
  Tray: class MockTray {
    setContextMenu = mockSetContextMenu
    setImage = mockSetImage
    setToolTip = mockSetToolTip
    destroy = mockDestroy
    on = mockOn
    constructor(_iconPath: string) {}
  },
  Menu: {
    buildFromTemplate: mockBuildFromTemplate,
  },
  app: {
    quit: mockQuit,
    getVersion: () => "0.1.0",
  },
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({ isEmpty: () => false }),
  },
}))

import { TrayManager } from "../../src/main/tray.js"

describe("TrayManager", () => {
  let tray: TrayManager

  beforeEach(() => {
    mockBuildFromTemplate.mockClear()
    mockBuildFromTemplate.mockReturnValue({ popup: vi.fn() })
    mockSetContextMenu.mockClear()
    mockSetImage.mockClear()
    mockSetToolTip.mockClear()
    mockDestroy.mockClear()
    mockOn.mockClear()
    mockQuit.mockClear()
    tray = new TrayManager("/fake/icon.png")
  })

  afterEach(() => {
    tray.destroy()
    vi.restoreAllMocks()
  })

  it("creates tray with icon path", () => {
    expect(tray).toBeDefined()
  })

  describe("menu items reflect connection status", () => {
    it("shows Connected status text when connected", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      expect(mockBuildFromTemplate).toHaveBeenCalled()
      const template = mockBuildFromTemplate.mock.calls[0][0]
      const statusItem = template.find(
        (item: { label?: string }) =>
          item.label && item.label.includes("Connected"),
      )
      expect(statusItem).toBeDefined()
      expect(statusItem.enabled).toBe(false)
    })

    it("shows Starting status text when starting", () => {
      const state: ConnectionState = {
        status: "starting",
        lastConnected: null,
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const statusItem = template.find(
        (item: { label?: string }) =>
          item.label && item.label.includes("Starting"),
      )
      expect(statusItem).toBeDefined()
    })

    it("shows Unreachable status text when unreachable", () => {
      const state: ConnectionState = {
        status: "unreachable",
        lastConnected: Date.now() - 60_000,
        consecutiveFailures: 3,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const statusItem = template.find(
        (item: { label?: string }) =>
          item.label && item.label.includes("Unreachable"),
      )
      expect(statusItem).toBeDefined()
    })
  })

  describe("menu rebuild on state change", () => {
    it("rebuilds menu when updateMenu is called", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      expect(mockBuildFromTemplate).toHaveBeenCalledTimes(1)
      expect(mockSetContextMenu).toHaveBeenCalledTimes(1)
    })

    it("rebuilds menu each time state changes", () => {
      const connected: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      const unreachable: ConnectionState = {
        status: "unreachable",
        lastConnected: Date.now() - 60_000,
        consecutiveFailures: 2,
      }

      tray.updateMenu(connected)
      tray.updateMenu(unreachable)

      expect(mockBuildFromTemplate).toHaveBeenCalledTimes(2)
      expect(mockSetContextMenu).toHaveBeenCalledTimes(2)
    })
  })

  describe("container actions based on state", () => {
    it("shows Start Container when unreachable", () => {
      const state: ConnectionState = {
        status: "unreachable",
        lastConnected: null,
        consecutiveFailures: 3,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const startItem = template.find(
        (item: { label?: string }) => item.label === "Start Container",
      )
      expect(startItem).toBeDefined()
      expect(startItem.visible).toBe(true)
    })

    it("shows Stop Container when connected", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const stopItem = template.find(
        (item: { label?: string }) => item.label === "Stop Container",
      )
      expect(stopItem).toBeDefined()
      expect(stopItem.visible).toBe(true)
    })

    it("hides Stop Container when unreachable", () => {
      const state: ConnectionState = {
        status: "unreachable",
        lastConnected: null,
        consecutiveFailures: 3,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const stopItem = template.find(
        (item: { label?: string }) => item.label === "Stop Container",
      )
      expect(stopItem).toBeDefined()
      expect(stopItem.visible).toBe(false)
    })

    it("hides Start Container when connected", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const startItem = template.find(
        (item: { label?: string }) => item.label === "Start Container",
      )
      expect(startItem).toBeDefined()
      expect(startItem.visible).toBe(false)
    })

    it("hides both Start and Stop when starting", () => {
      const state: ConnectionState = {
        status: "starting",
        lastConnected: null,
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const startItem = template.find(
        (item: { label?: string }) => item.label === "Start Container",
      )
      const stopItem = template.find(
        (item: { label?: string }) => item.label === "Stop Container",
      )
      expect(startItem.visible).toBe(false)
      expect(stopItem.visible).toBe(false)
    })
  })

  describe("standard menu items", () => {
    it("includes Matrix OS header", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const header = template.find(
        (item: { label?: string }) => item.label === "Matrix OS",
      )
      expect(header).toBeDefined()
    })

    it("includes Quit item", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const quitItem = template.find(
        (item: { label?: string }) => item.label === "Quit",
      )
      expect(quitItem).toBeDefined()
    })

    it("includes About item", () => {
      const state: ConnectionState = {
        status: "connected",
        lastConnected: Date.now(),
        consecutiveFailures: 0,
      }
      tray.updateMenu(state)

      const template = mockBuildFromTemplate.mock.calls[0][0]
      const aboutItem = template.find(
        (item: { label?: string }) =>
          item.label && item.label.includes("About"),
      )
      expect(aboutItem).toBeDefined()
    })
  })

  describe("destroy", () => {
    it("calls destroy on the tray", () => {
      tray.destroy()
      expect(mockDestroy).toHaveBeenCalled()
    })
  })
})
