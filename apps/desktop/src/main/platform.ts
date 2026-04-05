import { session } from "electron"
import type { AppEntry, ContainerStatus } from "./types.js"

const BASE_URL = "https://app.matrix-os.com"
const API_TIMEOUT = 10_000
const HEALTH_TIMEOUT = 5_000

export class PlatformClient {
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BASE_URL
  }

  async fetchApps(): Promise<AppEntry[]> {
    const res = await this.fetch(`${this.baseUrl}/api/apps`, {
      signal: AbortSignal.timeout(API_TIMEOUT),
    })
    if (!res.ok) {
      return []
    }
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) {
      return [] // HTML redirect (not authenticated yet)
    }
    return res.json()
  }

  async fetchHealth(): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await this.fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      })
      return { ok: res.ok, status: res.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  async startContainer(): Promise<{ success: boolean; error?: string }> {
    return this.containerAction("start")
  }

  async stopContainer(): Promise<{ success: boolean; error?: string }> {
    return this.containerAction("stop")
  }

  async upgradeContainer(): Promise<{ success: boolean; error?: string }> {
    return this.containerAction("upgrade")
  }

  async getContainerStatus(): Promise<ContainerStatus> {
    const res = await this.fetch(`${this.baseUrl}/api/container/status`, {
      signal: AbortSignal.timeout(API_TIMEOUT),
    })
    if (!res.ok) {
      throw new Error("Container operation failed")
    }
    return res.json()
  }

  private async containerAction(
    action: string,
  ): Promise<{ success: boolean; error?: string }> {
    const res = await this.fetch(`${this.baseUrl}/api/container/${action}`, {
      method: "POST",
      signal: AbortSignal.timeout(API_TIMEOUT),
    })
    if (!res.ok) {
      throw new Error("Container operation failed")
    }
    return res.json()
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return session.defaultSession.fetch(url, init)
  }
}
