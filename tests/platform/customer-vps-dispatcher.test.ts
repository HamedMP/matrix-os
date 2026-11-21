import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS,
  createCustomerVpsProxyDispatcher,
  fetchWithStaleConnectionRetry,
  isStaleConnectionError,
} from "../../packages/platform/src/customer-vps-dispatcher.js";

// Outcome: platform -> customer VPS requests reuse warm connections instead of
// paying a TCP + TLS handshake on every proxied request, without turning a
// stale pooled socket into a user-visible failure.
// Faults: keep-alive disabled again (handshake per request), an idle window
// that outlives the VPS edge's own keep-alive, a stale socket surfacing as a
// 502 for an idempotent GET, and a non-idempotent request being replayed.

type Handler = (req: IncomingMessage, res: ServerResponse, requestIndex: number) => void;

const servers: Server[] = [];
const dispatchers: Array<{ close(): Promise<void> }> = [];

async function startServer(handler: Handler) {
  let requests = 0;
  let connections = 0;
  const server = createServer((req, res) => handler(req, res, ++requests));
  server.on("connection", () => { connections += 1; });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, connections: () => connections, requests: () => requests };
}

function dispatcher() {
  const created = createCustomerVpsProxyDispatcher({ verifyTls: true });
  dispatchers.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((entry) => entry.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  vi.restoreAllMocks();
});

describe("customer VPS proxy dispatcher", () => {
  it("keeps idle connections well inside the VPS nginx keep-alive window", () => {
    // nginx's default keepalive_timeout is 75s; staying far below it means the
    // edge never closes a socket the platform is about to reuse.
    expect(CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("reuses one upstream connection for sequential requests", async () => {
    const upstream = await startServer((_req, res) => { res.end("ok"); });
    const agent = dispatcher();
    for (let index = 0; index < 6; index++) {
      const response = await fetch(`${upstream.origin}/api/health`, {
        dispatcher: agent, signal: AbortSignal.timeout(5_000),
      } as RequestInit & { dispatcher: typeof agent });
      expect(await response.text()).toBe("ok");
    }
    expect(upstream.requests()).toBe(6);
    // A handshake per request (the old behaviour) opens six; a warm pool opens one or two.
    expect(upstream.connections()).toBeLessThanOrEqual(2);
  });

  it("retries an idempotent GET once on a fresh connection when the pooled socket was dropped", async () => {
    const served = new WeakMap<object, number>();
    let dropped = 0;
    const upstream = await startServer((req, res, index) => {
      const onSocket = (served.get(req.socket) ?? 0) + 1;
      served.set(req.socket, onSocket);
      // The first request that arrives on a reused socket finds the edge gone.
      if (onSocket > 1 && dropped === 0) { dropped += 1; req.socket.destroy(); return; }
      res.end(`ok-${index}`);
    });
    const agent = dispatcher();
    const get = () => fetchWithStaleConnectionRetry(fetch, `${upstream.origin}/assets/app.js`, {
      dispatcher: agent, signal: AbortSignal.timeout(5_000),
    } as RequestInit & { dispatcher: typeof agent });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let index = 0; index < 6; index++) {
      expect(await (await get()).text()).toMatch(/^ok-\d+$/);
    }
    expect(dropped).toBe(1);
  });
});

describe("stale connection retry", () => {
  const stale = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code }) });

  it.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])("classifies %s as a stale connection", (code) => {
    expect(isStaleConnectionError(stale(code))).toBe(true);
  });

  it.each([
    stale("ECONNREFUSED"),
    stale("UND_ERR_CONNECT_TIMEOUT"),
    new DOMException("aborted", "AbortError"),
    new Error("ECONNRESET"),
  ])("does not classify %s as stale", (error) => {
    expect(isStaleConnectionError(error)).toBe(false);
  });

  it("retries a GET and a HEAD exactly once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const method of ["GET", "HEAD", undefined]) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(stale("ECONNRESET"))
        .mockResolvedValueOnce(new Response("ok"));
      const response = await fetchWithStaleConnectionRetry(fetchImpl, "https://203.0.113.1/x", method ? { method } : {});
      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("surfaces the second failure instead of retrying forever", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(stale("ECONNRESET"));
    await expect(fetchWithStaleConnectionRetry(fetchImpl, "https://203.0.113.1/x", { method: "GET" })).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never replays a non-idempotent request, a request with a body, or an aborted request", async () => {
    const aborted = new AbortController();
    aborted.abort();
    for (const init of [
      { method: "POST" },
      { method: "DELETE" },
      { method: "GET", body: "x" },
      { method: "GET", signal: aborted.signal },
    ] as RequestInit[]) {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(stale("ECONNRESET"));
      await expect(fetchWithStaleConnectionRetry(fetchImpl, "https://203.0.113.1/x", init)).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("never replays a Request object, whose body the first attempt may have consumed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(stale("ECONNRESET"));
    await expect(fetchWithStaleConnectionRetry(fetchImpl, new Request("https://203.0.113.1/x"))).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors that are not stale connections", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(stale("ECONNREFUSED"));
    await expect(fetchWithStaleConnectionRetry(fetchImpl, "https://203.0.113.1/x", { method: "GET" })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
