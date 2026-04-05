import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const { mockAutoUpdater, mockIs } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  },
  mockIs: { dev: false },
}))

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}))

vi.mock("@electron-toolkit/utils", () => ({
  is: mockIs,
}))

import { initAutoUpdater, installUpdate } from "../../src/main/updater.js"

describe("updater", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockIs.dev = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("skips update check in dev mode", () => {
    mockIs.dev = true

    initAutoUpdater({})

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mockAutoUpdater.on).not.toHaveBeenCalled()
  })

  it("checks for updates on launch in production", () => {
    initAutoUpdater({})

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("sets autoInstallOnAppQuit to true", () => {
    initAutoUpdater({})

    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it("checks for updates every 4 hours (14400000ms)", () => {
    initAutoUpdater({})

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it("calls onUpdateAvailable when update-available fires", () => {
    const onUpdateAvailable = vi.fn()
    initAutoUpdater({ onUpdateAvailable })

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      ([event]: [string]) => event === "update-available",
    )?.[1]

    expect(updateAvailableHandler).toBeDefined()
    updateAvailableHandler({ version: "2.0.0" })
    expect(onUpdateAvailable).toHaveBeenCalledWith("2.0.0")
  })

  it("calls onDownloadProgress when download-progress fires", () => {
    const onDownloadProgress = vi.fn()
    initAutoUpdater({ onDownloadProgress })

    const progressHandler = mockAutoUpdater.on.mock.calls.find(
      ([event]: [string]) => event === "download-progress",
    )?.[1]

    expect(progressHandler).toBeDefined()
    progressHandler({ percent: 42.5 })
    expect(onDownloadProgress).toHaveBeenCalledWith(42.5)
  })

  it("calls onUpdateDownloaded when update-downloaded fires", () => {
    const onUpdateDownloaded = vi.fn()
    initAutoUpdater({ onUpdateDownloaded })

    const downloadedHandler = mockAutoUpdater.on.mock.calls.find(
      ([event]: [string]) => event === "update-downloaded",
    )?.[1]

    expect(downloadedHandler).toBeDefined()
    downloadedHandler({ version: "2.0.0" })
    expect(onUpdateDownloaded).toHaveBeenCalledWith("2.0.0")
  })

  it("registers all three event listeners", () => {
    initAutoUpdater({})

    const events = mockAutoUpdater.on.mock.calls.map(
      ([event]: [string]) => event,
    )
    expect(events).toContain("update-available")
    expect(events).toContain("download-progress")
    expect(events).toContain("update-downloaded")
  })

  it("calls quitAndInstall on installUpdate", () => {
    installUpdate()

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
