import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPostHogProxyPath, handlePostHogProxyRequest } from "../../packages/neo-worker/src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

function createContext() {
  return {
    waitUntil: vi.fn(),
  };
}

function stubWorkerCache() {
  const put = vi.fn(() => Promise.resolve());
  const original = Reflect.get(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: { put },
    },
  });

  return {
    put,
    restore() {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "caches");
        return;
      }
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: original,
      });
    },
  };
}

describe("Neo Worker", () => {
  it("classifies PostHog asset, ingest, and health routes", () => {
    expect(classifyPostHogProxyPath("/health")).toBe("health");
    expect(classifyPostHogProxyPath("/service-worker.js")).toBe("service-worker");
    expect(classifyPostHogProxyPath("/static/posthog.js")).toBe("asset");
    expect(classifyPostHogProxyPath("/array/config")).toBe("asset");
    expect(classifyPostHogProxyPath("/i/v0/e")).toBe("ingest");
  });

  it("serves a cleanup service worker for browsers that previously loaded the shell from neo", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/service-worker.js"),
      {},
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    await expect(response.text()).resolves.toContain("registration.unregister()");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("forwards static assets to the EU asset host without cookies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("asset"));
    const ctx = createContext();

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/static/posthog.js?v=1", {
        headers: {
          cookie: "session=secret",
          "CF-Connecting-IP": "203.0.113.10",
        },
      }),
      {},
      ctx,
    );

    expect(response.status).toBe(200);
    const upstream = fetchMock.mock.calls[0]?.[0];
    expect(upstream).toBeInstanceOf(Request);
    const upstreamRequest = upstream as Request;
    expect(upstreamRequest.url).toBe("https://eu-assets.i.posthog.com/static/array.js?v=1");
    expect(upstreamRequest.headers.get("cookie")).toBeNull();
    expect(upstreamRequest.headers.get("X-Forwarded-For")).toBe("203.0.113.10");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("aliases the legacy PostHog loader path to the current array.js asset", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("asset"));

    await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/static/posthog.js?v=1.376.0"),
      {},
      createContext(),
    );

    const upstream = fetchMock.mock.calls[0]?.[0];
    expect(upstream).toBeInstanceOf(Request);
    expect((upstream as Request).url).toBe("https://eu-assets.i.posthog.com/static/array.js?v=1.376.0");
  });

  it("caches successful GET asset responses through the Worker cache", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("asset"));
    const cache = stubWorkerCache();
    const ctx = createContext();

    await handlePostHogProxyRequest(new Request("https://neo.matrix-os.com/static/posthog.js"), {}, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await ctx.waitUntil.mock.calls[0]?.[0];
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(cache.put.mock.calls[0]?.[1]).toBeInstanceOf(Response);

    cache.restore();
    fetchMock.mockRestore();
  });

  it("does not cache non-GET or failed asset responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }));
    const cache = stubWorkerCache();
    const ctx = createContext();

    await handlePostHogProxyRequest(new Request("https://neo.matrix-os.com/static/posthog.js"), {}, ctx);
    await ctx.waitUntil.mock.calls[0]?.[0];
    expect(cache.put).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response("ok"));
    await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/static/posthog.js", { method: "POST", body: "{}" }),
      {},
      ctx,
    );
    await ctx.waitUntil.mock.calls[1]?.[0];
    expect(cache.put).not.toHaveBeenCalled();

    cache.restore();
    fetchMock.mockRestore();
  });

  it("forwards ingest events to the EU API host with no-store response headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/i/v0/e?ip=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=secret",
          "CF-Connecting-IP": "203.0.113.11",
        },
        body: JSON.stringify({ token: "phc_test", event: "matrix_test" }),
      }),
      {},
      createContext(),
    );

    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    const upstream = fetchMock.mock.calls[0]?.[0];
    expect(upstream).toBeInstanceOf(Request);
    const upstreamRequest = upstream as Request;
    expect(upstreamRequest.url).toBe("https://eu.i.posthog.com/i/v0/e?ip=1");
    expect(upstreamRequest.method).toBe("POST");
    expect(upstreamRequest.headers.get("cookie")).toBeNull();
    expect(upstreamRequest.headers.get("X-Forwarded-For")).toBe("203.0.113.11");
    await expect(upstreamRequest.json()).resolves.toEqual({ token: "phc_test", event: "matrix_test" });

    fetchMock.mockRestore();
  });

  it("drops malformed forwarded IP values before sending to PostHog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/i/v0/e", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.10, 198.51.100.2",
        },
        body: JSON.stringify({ token: "phc_test", event: "matrix_test" }),
      }),
      {},
      createContext(),
    );

    const upstream = fetchMock.mock.calls[0]?.[0];
    expect(upstream).toBeInstanceOf(Request);
    expect((upstream as Request).headers.get("X-Forwarded-For")).toBeNull();

    fetchMock.mockRestore();
  });

  it("returns an explicit no-store upstream error when forwarding fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failure"));
    const consoleMock = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/i/v0/e", {
        method: "POST",
        body: JSON.stringify({ token: "phc_test", event: "matrix_test" }),
      }),
      {},
      createContext(),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(consoleMock).toHaveBeenCalledWith("[neo-worker] upstream_failure");

    consoleMock.mockRestore();
    fetchMock.mockRestore();
  });

  it("serves a local health check without touching PostHog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/health"),
      {},
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
