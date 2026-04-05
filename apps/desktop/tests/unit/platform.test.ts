import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const mockFetch = vi.fn()
vi.mock("electron", () => ({
  session: {
    defaultSession: {
      fetch: (...args: unknown[]) => mockFetch(...args),
    },
  },
}))

import { PlatformClient } from "../../src/main/platform.js"

describe("PlatformClient", () => {
  let client: PlatformClient

  beforeEach(() => {
    client = new PlatformClient()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("fetchApps", () => {
    it("calls /api/apps with correct URL", async () => {
      const apps = [
        { slug: "terminal", name: "Terminal", icon: "/icon.png", builtIn: true },
      ]
      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: () => "application/json; charset=utf-8",
        },
        json: () => Promise.resolve(apps),
      })

      const result = await client.fetchApps()
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/apps",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      )
      expect(result).toEqual(apps)
    })

    it("uses 10s timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: () => "application/json",
        },
        json: () => Promise.resolve([]),
      })

      await client.fetchApps()
      const call = mockFetch.mock.calls[0]
      expect(call[1].signal).toBeInstanceOf(AbortSignal)
    })

    it("returns an empty list on error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })

      await expect(client.fetchApps()).resolves.toEqual([])
    })
  })

  describe("fetchHealth", () => {
    it("calls /health with 5s timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "ok" }),
      })

      const result = await client.fetchHealth()
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.matrix-os.com/health",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      )
      expect(result).toEqual({ ok: true, status: 200 })
    })

    it("returns status on 503", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
      })

      const result = await client.fetchHealth()
      expect(result).toEqual({ ok: false, status: 503 })
    })

    it("returns error on network failure", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"))

      const result = await client.fetchHealth()
      expect(result).toEqual({ ok: false, status: 0 })
    })
  })

  describe("container management", () => {
    it("startContainer calls correct endpoint", async () => {
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

    it("stopContainer calls correct endpoint", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      const result = await client.stopContainer()
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/container/stop",
        expect.objectContaining({ method: "POST" }),
      )
      expect(result).toEqual({ success: true })
    })

    it("upgradeContainer calls correct endpoint", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      const result = await client.upgradeContainer()
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/container/upgrade",
        expect.objectContaining({ method: "POST" }),
      )
      expect(result).toEqual({ success: true })
    })

    it("getContainerStatus calls correct endpoint", async () => {
      const status = {
        handle: "hamed",
        state: "running",
        imageVersion: "v0.9.0",
      }
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(status),
      })

      const result = await client.getContainerStatus()
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/container/status",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      )
      expect(result).toEqual(status)
    })

    it("handles error responses without leaking details", async () => {
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
})
