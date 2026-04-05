import { EventEmitter } from "node:events"
import type { ConnectionState, ConnectionStatus } from "./types.js"
import type { PlatformClient } from "./platform.js"

const POLL_INTERVAL = 30_000
const FLAP_THRESHOLD = 2

export class HealthMonitor extends EventEmitter {
  private state: ConnectionState = {
    status: "connected",
    lastConnected: null,
    consecutiveFailures: 0,
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private client: PlatformClient

  constructor(client: PlatformClient) {
    super()
    this.client = client
  }

  getState(): ConnectionState {
    return { ...this.state }
  }

  start(): void {
    this.check()
    this.timer = setInterval(() => this.check(), POLL_INTERVAL)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async check(): Promise<void> {
    const result = await this.client.fetchHealth()
    const prev = this.state.status

    if (result.ok && result.status === 200) {
      this.state.consecutiveFailures = 0
      this.state.lastConnected = Date.now()
      this.state.status = "connected"
    } else if (result.status === 503) {
      this.state.consecutiveFailures = 0
      this.state.status = "starting"
    } else {
      this.state.consecutiveFailures++
      if (this.state.consecutiveFailures >= FLAP_THRESHOLD) {
        this.state.status = "unreachable"
      }
    }

    if (prev !== this.state.status) {
      this.emit("state-change", this.getState())
    }
  }
}
