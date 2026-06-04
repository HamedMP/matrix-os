import { describe, expect, it, vi } from "vitest";
import { classifyPostHogProxyPath, handlePostHogProxyRequest } from "../../packages/neo-worker/src/index";

function createContext() {
  return {
    waitUntil: vi.fn(),
  };
}

describe("Neo Worker", () => {
  it("classifies PostHog asset, ingest, and health routes", () => {
    expect(classifyPostHogProxyPath("/health")).toBe("health");
    expect(classifyPostHogProxyPath("/static/posthog.js")).toBe("asset");
    expect(classifyPostHogProxyPath("/array/config")).toBe("asset");
    expect(classifyPostHogProxyPath("/i/v0/e")).toBe("ingest");
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
    expect(upstreamRequest.url).toBe("https://eu-assets.i.posthog.com/static/posthog.js?v=1");
    expect(upstreamRequest.headers.get("cookie")).toBeNull();
    expect(upstreamRequest.headers.get("X-Forwarded-For")).toBe("203.0.113.10");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

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

  it("serves a local health check without touching PostHog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await handlePostHogProxyRequest(
      new Request("https://neo.matrix-os.com/health"),
      {},
      createContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
