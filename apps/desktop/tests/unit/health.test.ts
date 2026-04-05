import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { ConnectionState } from "../../src/main/types.js"

const { mockFetchHealth } = vi.hoisted(() => ({
  mockFetchHealth: vi.fn(),
}))

vi.mock("../../src/main/platform.js", () => ({
  PlatformClient: class MockPlatformClient {
    fetchHealth = mockFetchHealth
  },
}))

import { HealthMonitor } from "../../src/main/health.js"
import { PlatformClient } from "../../src/main/platform.js"

describe("HealthMonitor", () => {
  let monitor: HealthMonitor
  let client: PlatformClient

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetchHealth.mockReset()
    client = new PlatformClient()
    monitor = new HealthMonitor(client)
  })

  afterEach(() => {
    monitor.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("extends EventEmitter", () => {
    expect(monitor).toBeInstanceOf(EventEmitter)
  })

  it("starts with connected state", () => {
    const state = monitor.getState()
    expect(state.status).toBe("connected")
    expect(state.consecutiveFailures).toBe(0)
    expect(state.lastConnected).toBeNull()
  })

  describe("state transitions", () => {
    it("stays connected on successful health check", async () => {
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      monitor.start()

      // Flush the immediate check
      await vi.advanceTimersByTimeAsync(0)

      const state = monitor.getState()
      expect(state.status).toBe("connected")
      expect(state.consecutiveFailures).toBe(0)
    })

    it("updates lastConnected timestamp on success", async () => {
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      vi.setSystemTime(new Date("2026-04-03T12:00:00Z"))
      monitor.start()

      await vi.advanceTimersByTimeAsync(0)

      const state = monitor.getState()
      expect(state.lastConnected).toBe(Date.now())
    })

    it("transitions to starting on 503 response", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 503 })
      monitor.start()

      await vi.advanceTimersByTimeAsync(0)

      const state = monitor.getState()
      expect(state.status).toBe("starting")
    })

    it("does not transition to unreachable on single failure (flap prevention)", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()

      // Only the immediate check fires -- single failure
      await vi.advanceTimersByTimeAsync(0)

      const state = monitor.getState()
      expect(state.status).not.toBe("unreachable")
      expect(state.consecutiveFailures).toBe(1)
    })

    it("transitions to unreachable after 2 consecutive failures", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()

      // Immediate check = 1st failure
      await vi.advanceTimersByTimeAsync(0)
      expect(monitor.getState().consecutiveFailures).toBe(1)

      // Timer tick = 2nd failure
      await vi.advanceTimersByTimeAsync(30_000)
      expect(monitor.getState().status).toBe("unreachable")
      expect(monitor.getState().consecutiveFailures).toBe(2)
    })

    it("transitions from unreachable back to connected on success", async () => {
      // Drive to unreachable: immediate + 1 timer tick = 2 failures
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(monitor.getState().status).toBe("unreachable")

      // Now succeed
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      await vi.advanceTimersByTimeAsync(30_000)

      const state = monitor.getState()
      expect(state.status).toBe("connected")
      expect(state.consecutiveFailures).toBe(0)
    })

    it("resets consecutiveFailures on success", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()

      // Immediate check = 1 failure
      await vi.advanceTimersByTimeAsync(0)
      expect(monitor.getState().consecutiveFailures).toBe(1)

      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(monitor.getState().consecutiveFailures).toBe(0)
    })
  })

  describe("events", () => {
    it("emits state-change when status transitions", async () => {
      const handler = vi.fn()
      monitor.on("state-change", handler)

      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()

      // Immediate check = 1st failure (no transition yet, flap prevention)
      await vi.advanceTimersByTimeAsync(0)

      // Timer tick = 2nd failure, transitions to unreachable
      await vi.advanceTimersByTimeAsync(30_000)

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ status: "unreachable" }),
      )
    })

    it("emits state-change on recovery", async () => {
      const handler = vi.fn()
      monitor.on("state-change", handler)

      // Drive to unreachable
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)

      handler.mockClear()

      // Recover
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ status: "connected" }),
      )
    })

    it("does not emit state-change when status stays the same", async () => {
      const handler = vi.fn()
      monitor.on("state-change", handler)

      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      monitor.start()

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)

      // Status stays "connected" so no events emitted
      expect(handler).not.toHaveBeenCalled()
    })

    it("emits state-change for starting status (503)", async () => {
      const handler = vi.fn()
      monitor.on("state-change", handler)

      mockFetchHealth.mockResolvedValue({ ok: false, status: 503 })
      monitor.start()

      await vi.advanceTimersByTimeAsync(0)

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ status: "starting" }),
      )
    })
  })

  describe("consecutiveFailures counter", () => {
    it("increments on each failed check", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 0 })
      monitor.start()

      // Immediate check
      await vi.advanceTimersByTimeAsync(0)
      expect(monitor.getState().consecutiveFailures).toBe(1)

      // 1st timer tick
      await vi.advanceTimersByTimeAsync(30_000)
      expect(monitor.getState().consecutiveFailures).toBe(2)

      // 2nd timer tick
      await vi.advanceTimersByTimeAsync(30_000)
      expect(monitor.getState().consecutiveFailures).toBe(3)
    })

    it("does not increment on 503 (starting state)", async () => {
      mockFetchHealth.mockResolvedValue({ ok: false, status: 503 })
      monitor.start()

      await vi.advanceTimersByTimeAsync(0)
      expect(monitor.getState().consecutiveFailures).toBe(0)
    })
  })

  describe("start/stop", () => {
    it("stop prevents further polling", async () => {
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      monitor.start()

      // Immediate check fires
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetchHealth).toHaveBeenCalledTimes(1)

      monitor.stop()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockFetchHealth).toHaveBeenCalledTimes(1)
    })

    it("runs an immediate check on start", async () => {
      mockFetchHealth.mockResolvedValue({ ok: true, status: 200 })
      monitor.start()

      // Flush the microtask queue for the immediate check
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetchHealth).toHaveBeenCalledTimes(1)
    })
  })
})
