import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

const PREVIEW_CHAT_ENV = {
  ...EDGE_ENV,
  PREVIEW_CHAT_CANDIDATE_ORIGIN: "https://pr2045-ai---matrix-platform.example.run.app",
  PREVIEW_CHAT_CANDIDATE_HANDLE: "pr-2045",
  PREVIEW_CHAT_CANDIDATE_CHAT_ID: "chat_my_drive_test",
  PREVIEW_CHAT_CANDIDATE_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
};

function previewChatRequest(path: string, method = "POST", headers?: HeadersInit): Request {
  return new Request(`https://app.matrix-os.com${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

describe("edge router worker", () => {
  it.each([
    "/vm/pr-2045/api/chats/chat_my_drive_test/turns?version=2",
    "/vm/pr-2045/~runtime/pr-2045/api/chats/chat_my_drive_test/turns?version=2",
    "/vm/pr-2045/~runtime/pr-2045/api/chats/chat_my_drive_test/runs/run_one/approvals/approval_one",
  ])("sends one configured Preview Chat mutation to the tagged Platform candidate: %s", async (path) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const response = await handleEdgeRouterRequest(previewChatRequest(path, "POST", {
      "x-matrix-edge-secret": "forged", "x-forwarded-host": "evil.example",
    }), PREVIEW_CHAT_ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-matrix-preview-platform-route")).toBe("candidate");
    const [upstream] = fetchMock.mock.calls[0]!;
    expect((upstream as Request).url).toBe(`https://pr2045-ai---matrix-platform.example.run.app${path}`);
    expect((upstream as Request).headers.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect((upstream as Request).headers.get("x-matrix-edge-secret")).toBe("edge-secret");
  });

  it.each([
    ["other chat", "/vm/pr-2045/api/chats/chat_other/turns", "POST"],
    ["other Preview", "/vm/pr-2046/api/chats/chat_my_drive_test/turns", "POST"],
    ["other runtime", "/vm/pr-2045/~runtime/primary/api/chats/chat_my_drive_test/turns", "POST"],
    ["other query runtime", "/vm/pr-2045/api/chats/chat_my_drive_test/turns?runtime=primary", "POST"],
    ["mixed query runtimes", "/vm/pr-2045/api/chats/chat_my_drive_test/turns?runtime=pr-2045&runtime=primary", "POST"],
    ["queued turn", "/vm/pr-2045/api/chats/chat_my_drive_test/queued-turns", "POST"],
    ["turn read", "/vm/pr-2045/api/chats/chat_my_drive_test/turns", "GET"],
    ["approval read", "/vm/pr-2045/api/chats/chat_my_drive_test/runs/run_one/approvals/approval_one", "GET"],
    ["other mutation", "/vm/pr-2045/api/chats/chat_my_drive_test/runs/run_one/cancel", "POST"],
    ["prefix trick", "/vm/pr-2045/api/chats/chat_my_drive_test_extra/turns", "POST"],
  ])("keeps %s on the production Platform", async (_reason, path, method) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const response = await handleEdgeRouterRequest(previewChatRequest(path, method), PREVIEW_CHAT_ENV);
    expect(response.headers.get("x-matrix-preview-platform-route")).toBeNull();
    expect((fetchMock.mock.calls[0]![0] as Request).url)
      .toBe(`https://matrix-platform.example.run.app${path}`);
  });

  it.each([
    ["expired", { PREVIEW_CHAT_CANDIDATE_EXPIRES_AT: new Date(Date.now() - 60_000).toISOString() }],
    ["far future", { PREVIEW_CHAT_CANDIDATE_EXPIRES_AT: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }],
    ["wrong service", { PREVIEW_CHAT_CANDIDATE_ORIGIN: "https://pr2045-ai---other.example.run.app" }],
    ["wrong tag", { PREVIEW_CHAT_CANDIDATE_ORIGIN: "https://pr2046-ai---matrix-platform.example.run.app" }],
    ["credentialed URL", { PREVIEW_CHAT_CANDIDATE_ORIGIN: "https://user:pass@pr2045-ai---matrix-platform.example.run.app" }],
    ["URL path", { PREVIEW_CHAT_CANDIDATE_ORIGIN: "https://pr2045-ai---matrix-platform.example.run.app/sneak" }],
    ["missing chat", { PREVIEW_CHAT_CANDIDATE_CHAT_ID: "" }],
  ])("keeps the turn on production when candidate config is %s", async (_reason, override) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await handleEdgeRouterRequest(previewChatRequest("/vm/pr-2045/api/chats/chat_my_drive_test/turns"),
      { ...PREVIEW_CHAT_ENV, ...override });
    expect((fetchMock.mock.calls[0]![0] as Request).url)
      .toBe("https://matrix-platform.example.run.app/vm/pr-2045/api/chats/chat_my_drive_test/turns");
  });

  it("never sends API-domain or code-domain requests to the candidate", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    for (const host of ["api.matrix-os.com", "code.matrix-os.com"]) {
      await handleEdgeRouterRequest(new Request(`https://${host}/vm/pr-2045/api/chats/chat_my_drive_test/turns`, {
        method: "POST", body: "{}",
      }), PREVIEW_CHAT_ENV);
    }
    expect(fetchMock.mock.calls.every(([request]) => (request as Request).url.startsWith(EDGE_ENV.PLATFORM_ORIGIN))).toBe(true);
  });
  it("strips a forged upstream candidate marker from ordinary traffic", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      headers: { "x-matrix-preview-platform-route": "candidate" },
    }));
    const response = await handleEdgeRouterRequest(
      previewChatRequest("/vm/pr-2045/api/chats/chat_other/turns"), PREVIEW_CHAT_ENV);
    expect(response.headers.get("x-matrix-preview-platform-route")).toBeNull();
  });
  it("classifies managed Matrix OS hosts", () => {
    expect(classifyEdgeRoute("api.matrix-os.com")).toBe("platform");
    expect(classifyEdgeRoute("app.matrix-os.com")).toBe("app");
    expect(classifyEdgeRoute("code.matrix-os.com")).toBe("code");
    expect(classifyEdgeRoute("alice.matrix-os.com")).toBe("unknown");
  });

  it("keeps the edge timeout budget above the platform auth-shell proxy budget", () => {
    const platformMain = readFileSync(new URL("../../packages/platform/src/main.ts", import.meta.url), "utf8");
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

  it("respects upstream no-store headers for static-looking app-domain assets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        headers: {
          "cache-control": "no-store",
        },
      }),
    );

    const response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/icons/private.svg"),
      EDGE_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("does not classify API or v1 paths as static assets by extension", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("api", {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
    );

    const apiResponse = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/api/theme.css"),
      EDGE_ENV,
    );
    const v1Response = await handleEdgeRouterRequest(
      new Request("https://app.matrix-os.com/v1/widget.js"),
      EDGE_ENV,
    );

    expect(apiResponse.headers.get("cache-control")).toBe("no-store");
    expect(v1Response.headers.get("cache-control")).toBe("no-store");
    expect(apiResponse.headers.get("cdn-cache-control")).toBe("no-store");
    expect(v1Response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
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
