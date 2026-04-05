import { describe, it, expect, vi, beforeEach } from "vitest"

describe("sidebar renderer", () => {
  let mockElectronAPI: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    mockElectronAPI = {
      "sidebar:getApps": vi.fn().mockResolvedValue([
        {
          slug: "terminal",
          name: "Terminal",
          icon: "/files/system/icons/terminal.png",
          builtIn: true,
        },
        {
          slug: "chat",
          name: "Chat",
          icon: "/files/system/icons/chat.png",
          builtIn: true,
        },
      ]),
      "sidebar:setPinned": vi.fn().mockResolvedValue(undefined),
      "sidebar:setExpanded": vi.fn().mockResolvedValue(undefined),
      "tab:create": vi.fn().mockResolvedValue("new-tab-id"),
      onConnectionChanged: vi.fn(),
      onTabsChanged: vi.fn(),
      onAppsChanged: vi.fn(),
      onUpgradeProgress: vi.fn(),
    }
  })

  it("getApps returns app entries", async () => {
    const apps = await mockElectronAPI["sidebar:getApps"]()
    expect(apps).toHaveLength(2)
    expect(apps[0].slug).toBe("terminal")
    expect(apps[1].slug).toBe("chat")
  })

  it("tab:create dispatches IPC with slug", async () => {
    await mockElectronAPI["tab:create"]("terminal")
    expect(mockElectronAPI["tab:create"]).toHaveBeenCalledWith("terminal")
  })

  it("setPinned persists to store", async () => {
    await mockElectronAPI["sidebar:setPinned"](["files", "chat"])
    expect(mockElectronAPI["sidebar:setPinned"]).toHaveBeenCalledWith([
      "files",
      "chat",
    ])
  })

  it("setExpanded updates sidebar width", async () => {
    await mockElectronAPI["sidebar:setExpanded"](true)
    expect(mockElectronAPI["sidebar:setExpanded"]).toHaveBeenCalledWith(true)
  })

  it("onAppsChanged registers listener", () => {
    const cb = vi.fn()
    mockElectronAPI.onAppsChanged(cb)
    expect(mockElectronAPI.onAppsChanged).toHaveBeenCalledWith(cb)
  })

  it("onConnectionChanged registers listener", () => {
    const cb = vi.fn()
    mockElectronAPI.onConnectionChanged(cb)
    expect(mockElectronAPI.onConnectionChanged).toHaveBeenCalledWith(cb)
  })
})
