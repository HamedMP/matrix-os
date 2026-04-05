import { Hono } from "hono"

const PLATFORM_TIMEOUT = 10_000

export function createContainerRoutes() {
  const router = new Hono()

  function getPlatformConfig() {
    const handle = process.env.MATRIX_HANDLE
    const token = process.env.UPGRADE_TOKEN
    const platformUrl = process.env.PLATFORM_INTERNAL_URL
    return { handle, token, platformUrl }
  }

  async function proxyToPlatform(
    method: "GET" | "POST",
    path: string,
  ): Promise<Response> {
    const { handle, token, platformUrl } = getPlatformConfig()
    if (!handle || !token || !platformUrl) {
      return Response.json({ error: "Container management not configured" }, { status: 503 })
    }

    const url = `${platformUrl}/containers/${handle}${path}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT),
    })

    if (!res.ok) {
      const status = res.status as 400 | 409 | 500 | 502
      return Response.json(
        { success: false, error: "Container operation failed" },
        { status },
      )
    }

    const data = await res.json()
    return Response.json(data)
  }

  router.get("/status", async (c) => {
    try {
      const { handle, token, platformUrl } = getPlatformConfig()
      if (!handle || !token || !platformUrl) {
        return c.json({ error: "Not configured" }, 503)
      }

      const res = await fetch(`${platformUrl}/containers/${handle}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT),
      })

      if (!res.ok) {
        return c.json({ error: "Platform unreachable" }, 502)
      }

      const data = await res.json()
      return c.json(data)
    } catch {
      return c.json({ error: "Platform unreachable" }, 502)
    }
  })

  router.post("/start", async (c) => {
    try {
      const res = await proxyToPlatform("POST", "/start")
      const data = await res.json()
      return c.json(data, res.status as 200)
    } catch {
      return c.json({ error: "Platform unreachable" }, 502)
    }
  })

  router.post("/stop", async (c) => {
    try {
      const res = await proxyToPlatform("POST", "/stop")
      const data = await res.json()
      return c.json(data, res.status as 200)
    } catch {
      return c.json({ error: "Platform unreachable" }, 502)
    }
  })

  router.post("/upgrade", async (c) => {
    try {
      const res = await proxyToPlatform("POST", "/self-upgrade")
      const data = await res.json()
      return c.json(data, res.status as 200)
    } catch {
      return c.json({ success: true })
    }
  })

  return router
}
