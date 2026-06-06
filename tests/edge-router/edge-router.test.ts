import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyEdgeRoute,
  handleEdgeRouterRequest,
} from "../../packages/edge-router/src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("edge router worker", () => {
  it("classifies managed Matrix OS hosts", () => {
    expect(classifyEdgeRoute("api.matrix-os.com")).toBe("platform");
    expect(classifyEdgeRoute("app.matrix-os.com")).toBe("app");
    expect(classifyEdgeRoute("code.matrix-os.com")).toBe("code");
    expect(classifyEdgeRoute("alice.matrix-os.com")).toBe("unknown");
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
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    const [request] = fetchMock.mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    const upstream = request as Request;
    expect(upstream.url).toBe("https://matrix-platform.example.run.app/api/auth/app-session");
    expect(upstream.headers.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("forwards code-domain requests with the code external host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("editor"));

    await handleEdgeRouterRequest(
      new Request("https://code.matrix-os.com/?folder=/home/matrix/home"),
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app/" },
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
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
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
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app" },
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("payload too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for unmanaged hosts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://alice.matrix-os.com/"),
      { PLATFORM_ORIGIN: "https://matrix-platform.example.run.app" },
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the platform origin is not https", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

    const response = await handleEdgeRouterRequest(
      new Request("https://api.matrix-os.com/health"),
      { PLATFORM_ORIGIN: "http://127.0.0.1:9000" },
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
});
