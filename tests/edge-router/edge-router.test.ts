import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEdgeResponseInit,
  classifyEdgeRoute,
  handleEdgeRouterRequest,
  UPSTREAM_TIMEOUT_MS,
} from "../../packages/edge-router/src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const EDGE_ENV = {
  EDGE_ROUTER_SECRET: "edge-secret",
  PLATFORM_ORIGIN: "https://matrix-platform.example.run.app",
};

describe("edge router worker", () => {
  it("classifies managed Matrix OS hosts", () => {
    expect(classifyEdgeRoute("api.matrix-os.com")).toBe("platform");
    expect(classifyEdgeRoute("app.matrix-os.com")).toBe("app");
    expect(classifyEdgeRoute("code.matrix-os.com")).toBe("code");
    expect(classifyEdgeRoute("alice.matrix-os.com")).toBe("unknown");
  });

  it("keeps the edge timeout budget above the platform auth-shell proxy budget", () => {
    const root = process.cwd();
    const platformMain = readFileSync(join(root, "packages/platform/src/main.ts"), "utf8");
    const match = platformMain.match(/AUTH_SHELL_PROXY_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(match?.[1]).toBeDefined();
    const authShellProxyTimeoutMs = Number(match![1].replace(/_/g, ""));

    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(authShellProxyTimeoutMs);
  });

  it("forwards app-domain requests to Cloud Run with external host preserved", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        headers: {
          "cache-control": "private, max-age=60",
        },
      }),
    );

    const response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/api/auth/app-session", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.7",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      EDGE_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    const [request] = fetchMock.mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    const upstream = request as Request;
    expect(upstream.url).toBe("https://matrix-platform.example.run.app/api/auth/app-session");
    expect(upstream.headers.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(upstream.headers.get("x-matrix-edge-secret")).toBe("edge-secret");
  });

  it("forwards code-domain requests with the code external host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("editor"));

    await handleEdgeRouterRequest(
      new Request("https://code.matrix-os.com/?folder=/home/matrix/home"),
      { ...EDGE_ENV, PLATFORM_ORIGIN: "https://matrix-platform.example.run.app/" },
    );

    const [request] = fetchMock.mock.calls[0]!;
    const upstream = request as Request;
    expect(upstream.url).toBe("https://matrix-platform.example.run.app/?folder=/home/matrix/home");
    expect(upstream.headers.get("x-forwarded-host")).toBe("code.matrix-os.com");
  });

  it("marks platform API responses as no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        headers: {
          "cache-control": "public, max-age=3600",
        },
      }),
    );

    const response = await handleEdgeRouterRequest(
      new Request("https://api.matrix-os.com/health"),
      EDGE_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("preserves browser cache headers for safe app-domain static assets while keeping CDN caches disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "cdn-cache-control": "public, max-age=31536000",
        },
      }),
    );

    const response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/_next/static/chunks/app.js"),
      EDGE_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("does not preserve browser cache headers for app-domain API responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("api", {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
    );

    const response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/api/shell/bootstrap"),
      EDGE_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("rejects oversized bodies before forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/api/upload", {
        method: "POST",
        headers: {
          "content-length": String(10 * 1024 * 1024 + 1),
        },
        body: "too large",
      }),
      EDGE_ENV,
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("payload too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Cloudflare WebSocket tunnel handles on upgrade responses", () => {
    const webSocket = {} as WebSocket;
    const response = {
      status: 101,
      statusText: "Switching Protocols",
      headers: new Headers({
        upgrade: "websocket",
      }),
      webSocket,
    } as Response & { webSocket: WebSocket };

    const init = buildEdgeResponseInit(response, new Headers(response.headers));

    expect(init.status).toBe(101);
    expect(init.webSocket).toBe(webSocket);
  });

  it("returns 404 for unmanaged hosts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://alice.matrix-os.com/"),
      EDGE_ENV,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the platform origin is not https", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://api.matrix-os.com/health"),
      { ...EDGE_ENV, PLATFORM_ORIGIN: "http://127.0.0.1:9000" },
    );

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the platform origin is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://api.matrix-os.com/health"),
      {},
    );

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the edge secret is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://api.matrix-os.com/health"),
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app" },
    );

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
