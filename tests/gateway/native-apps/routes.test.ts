import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const wsMock = vi.hoisted(() => {
  const instances: Array<{ close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; url: string }> = [];
  const WebSocket = vi.fn(function MockWebSocket(this: { close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; url: string }, url: string) {
    this.url = url;
    this.close = vi.fn();
    this.send = vi.fn();
    this.on = vi.fn(() => this);
    instances.push(this);
    return this;
  });
  return { instances, WebSocket };
});

vi.mock("ws", () => ({
  default: wsMock.WebSocket,
}));

import {
  createNativeAppRoutes,
  NativeAppSessionService,
  createDefaultNativeAppRegistry,
  type NativeAppChildProcess,
} from "../../../packages/gateway/src/native-apps/index.js";
import { createNativeWebSocketHandler } from "../../../packages/gateway/src/native-apps/routes.js";
import { JWT_CLAIMS_CONTEXT_KEY, markAuthContextReady } from "../../../packages/gateway/src/request-principal.js";

function createChild(): NativeAppChildProcess {
  return {
    pid: 1234,
    stderr: { on: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(() => true),
  };
}

function createApp(ownerId?: string) {
  const service = new NativeAppSessionService({
    registry: createDefaultNativeAppRegistry(),
    commandExists: vi.fn(async () => true),
    getuid: () => 1000,
    randomId: vi.fn()
      .mockReturnValueOnce("session_aaaaaaaaaaaaaaaaaaaaaaaa")
      .mockReturnValueOnce("stream_bbbbbbbbbbbbbbbbbbbbbbbb"),
    readinessProbe: vi.fn(async () => true),
    reaperIntervalMs: 0,
    spawn: vi.fn(() => createChild()),
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    markAuthContextReady(c);
    if (ownerId) {
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: ownerId } as never);
    }
    await next();
  });
  app.route("/api/native-apps", createNativeAppRoutes({ service }));
  return { app, service };
}

describe("native app routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    wsMock.instances.splice(0);
    wsMock.WebSocket.mockClear();
  });

  it("requires auth for listing native apps", async () => {
    const { app } = createApp();

    const response = await app.request("/api/native-apps");

    expect(response.status).toBe(401);
  });

  it("uses the configured VPS handle as the single-user native app principal", async () => {
    const previousHandle = process.env.MATRIX_HANDLE;
    const previousUserId = process.env.MATRIX_USER_ID;
    process.env.MATRIX_HANDLE = "alice";
    delete process.env.MATRIX_USER_ID;
    try {
      const { app } = createApp();

      const response = await app.request("/api/native-apps");

      expect(response.status).toBe(200);
    } finally {
      if (previousHandle === undefined) delete process.env.MATRIX_HANDLE;
      else process.env.MATRIX_HANDLE = previousHandle;
      if (previousUserId === undefined) delete process.env.MATRIX_USER_ID;
      else process.env.MATRIX_USER_ID = previousUserId;
    }
  });

  it("lists curated native apps for an authenticated owner", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.apps).toEqual([
      expect.objectContaining({ id: "xterm", runtime: "linux-native", command: ["xterm"] }),
      expect.objectContaining({ id: "xcalc", runtime: "linux-native", command: ["xcalc"] }),
    ]);
  });

  it("rejects invalid app IDs at the route boundary", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps/INVALID/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
  });

  it("rejects arbitrary command payloads instead of casting them", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({ command: ["rm", "-rf", "/"], width: 800 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
  });

  it("launches a session and sets a scoped stream cookie", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({ width: 900, height: 700 }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.session).toMatchObject({
      id: "session_aaaaaaaaaaaaaaaaaaaaaaaa",
      appId: "xterm",
      status: "running",
      streamUrl: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    });
    expect(body.session).not.toHaveProperty("port");
    expect(body.session).not.toHaveProperty("display");
    expect(body.session).not.toHaveProperty("pid");
    expect(response.headers.get("set-cookie")).toContain("matrix_native_session__session_aaaaaaaaaaaaaaaaaaaaaaaa=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("returns a handle-qualified stream capability for a platform-routed launch", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Prefix": "/vm/alice",
      },
    });
    const body = await response.json() as { session: { streamUrl: string } };

    expect(response.status).toBe(201);
    expect(body.session.streamUrl).toBe(
      "/vm/alice/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "Path=/vm/alice/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
    );
  });

  it("keeps stream capabilities on the local route when only MATRIX_HANDLE is configured", async () => {
    const previousHandle = process.env.MATRIX_HANDLE;
    process.env.MATRIX_HANDLE = "dev";
    try {
      const { app } = createApp("dev");

      const response = await app.request("/api/native-apps/xterm/sessions", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const body = await response.json() as { session: { streamUrl: string } };

      expect(response.status).toBe(201);
      expect(body.session.streamUrl).toBe(
        "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
      );
      expect(response.headers.get("set-cookie")).toContain(
        "Path=/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
      );
    } finally {
      if (previousHandle === undefined) delete process.env.MATRIX_HANDLE;
      else process.env.MATRIX_HANDLE = previousHandle;
    }
  });

  it("scopes stream cookies to the forwarded explicit VM route", async () => {
    const { app } = createApp("alice");

    const response = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Prefix": "/vm/7a",
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(
      "Path=/vm/7a/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
    );
  });

  it("bootstraps the stream cookie from the launch stream URL when the launch Set-Cookie is unavailable", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const body = await launch.json() as { session: { streamUrl: string } };

    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.searchParams.has("nativeStreamToken")).toBe(false);
      return new Response("<html>xpra</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await app.request(body.session.streamUrl, {
      headers: { Accept: "text/html" },
    });

    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe("<html>xpra</html>");
    expect(stream.headers.get("set-cookie")).toContain("matrix_native_session__session_aaaaaaaaaaaaaaaaaaaaaaaa=");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes the xpra worker probe fall back inside an opaque iframe sandbox", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const body = await launch.json() as { session: { streamUrl: string } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<html><head><script src="js/Client.js"></script></head><body></body></html>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    )));

    const stream = await app.request(body.session.streamUrl, {
      headers: { Accept: "text/html" },
    });
    const html = await stream.text();

    expect(stream.status).toBe(200);
    expect(html).toContain("matrix-xpra-worker-fallback");
    expect(html.indexOf("matrix-xpra-worker-fallback")).toBeLessThan(html.indexOf('src="js/Client.js"'));
    expect(html).not.toContain("allow-same-origin");
  });

  it("authenticates opaque iframe assets through the stream capability path", async () => {
    const { app, service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/css/client.css");
      return new Response("body { color: black; }", {
        status: 200,
        headers: { "Content-Type": "text/css" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await app.request(
      `/api/native-apps/sessions/${session.id}/stream/${streamToken}/css/client.css`,
    );

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/css");
    expect(await stream.text()).toBe("body { color: black; }");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed native stream bootstrap tokens at the route boundary", async () => {
    const { app } = createApp("alice");
    await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const stream = await app.request(
      "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/?nativeStreamToken=../../etc/passwd",
    );

    expect(stream.status).toBe(400);
    expect(await stream.json()).toEqual({ error: "Invalid request" });
  });

  it("sets an HTTPS stream cookie that survives an opaque iframe sandbox", async () => {
    const { app } = createApp("alice");

    const response = await app.request("https://matrix.local/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("SameSite=None");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("sets a secure stream cookie when the public app URL is HTTPS behind an internal gateway URL", async () => {
    const previous = process.env.MATRIX_PUBLIC_APP_URL;
    process.env.MATRIX_PUBLIC_APP_URL = "https://app.matrix-os.com";
    try {
      const { app } = createApp("alice");

      const response = await app.request("/api/native-apps/xterm/sessions", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("set-cookie")).toContain("SameSite=None");
      expect(response.headers.get("set-cookie")).toContain("Secure");
    } finally {
      if (previous === undefined) delete process.env.MATRIX_PUBLIC_APP_URL;
      else process.env.MATRIX_PUBLIC_APP_URL = previous;
    }
  });

  it("sets a secure stream cookie when the public gateway URL is HTTPS", async () => {
    const previous = process.env.NEXT_PUBLIC_GATEWAY_URL;
    process.env.NEXT_PUBLIC_GATEWAY_URL = "https://matrix-tunnel.example";
    try {
      const { app } = createApp("alice");

      const response = await app.request("/api/native-apps/xterm/sessions", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("set-cookie")).toContain("SameSite=None");
      expect(response.headers.get("set-cookie")).toContain("Secure");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_GATEWAY_URL;
      else process.env.NEXT_PUBLIC_GATEWAY_URL = previous;
    }
  });

  it("keeps production stream cookies secure when the configured gateway URL is loopback HTTP", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousGatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_GATEWAY_URL = "http://127.0.0.1:4000";
    try {
      const { app } = createApp("alice");

      const response = await app.request("/api/native-apps/xterm/sessions", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("set-cookie")).toContain("SameSite=None");
      expect(response.headers.get("set-cookie")).toContain("Secure");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousGatewayUrl === undefined) delete process.env.NEXT_PUBLIC_GATEWAY_URL;
      else process.env.NEXT_PUBLIC_GATEWAY_URL = previousGatewayUrl;
    }
  });

  it("does not let another owner inspect or terminate a session", async () => {
    const { app, service } = createApp("bob");
    await service.launchSession({ ownerId: "alice", appId: "xterm" });

    const inspect = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(inspect.status).toBe(404);

    const terminate = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa", {
      method: "DELETE",
    });
    expect(terminate.status).toBe(404);
  });

  it("clears the scoped stream cookie when its session terminates", async () => {
    const { app } = createApp("alice");
    await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const response = await app.request(
      "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "matrix_native_session__session_aaaaaaaaaaaaaaaaaaaaaaaa=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain(
      "Path=/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
    );
  });

  it("does not forward Matrix credentials to the xpra stream proxy", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const scopedCookie = launch.headers.get("set-cookie")?.split(";")[0];
    expect(scopedCookie).toContain("matrix_native_session__session_aaaaaaaaaaaaaaaaaaaaaaaa=");

    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("accept")).toBe("text/html");
      return new Response("<html>xpra</html>", {
        status: 200,
        headers: { "Content-Type": "text/html", "Set-Cookie": "xpra=leak" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/", {
      headers: {
        Accept: "text/html",
        Authorization: "Bearer matrix-secret",
        Cookie: `${scopedCookie}; __session=clerk-secret`,
      },
    });

    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe("<html>xpra</html>");
    expect(stream.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not truncate decoded xpra responses with stale compression headers", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const scopedCookie = launch.headers.get("set-cookie")?.split(";")[0];
    const completeHtml = "<html>" + "x".repeat(20_000) + "</html>";
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
      return new Response(completeHtml, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Content-Encoding": "gzip",
          "Content-Length": "9450",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/", {
      headers: { Cookie: scopedCookie ?? "" },
    });

    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe(completeHtml);
    expect(stream.headers.get("content-encoding")).toBeNull();
    expect(stream.headers.get("content-length")).toBeNull();
  });

  it("fully consumes xpra responses before handing them to the downstream client", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const scopedCookie = launch.headers.get("set-cookie")?.split(";")[0];
    let pulls = 0;
    const chunks = Array.from({ length: 32 }, (_, index) => `chunk-${index}\n`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunks[pulls]));
        pulls++;
      },
    }))));

    const stream = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/js/client.js", {
      headers: { Cookie: scopedCookie ?? "" },
    });

    expect(pulls).toBe(chunks.length);
    expect(await stream.text()).toBe(chunks.join(""));
  });

  it("caps proxied stream request bodies before forwarding to xpra", async () => {
    const { app } = createApp("alice");
    const launch = await app.request("/api/native-apps/xterm/sessions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const scopedCookie = launch.headers.get("set-cookie")?.split(";")[0];
    const fetchMock = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", fetchMock);

    const stream = await app.request("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/upload", {
      method: "POST",
      headers: {
        Cookie: scopedCookie ?? "",
        "Content-Type": "application/octet-stream",
      },
      body: "x".repeat(4096),
    });

    expect(stream.status).toBe(400);
    await expect(stream.json()).resolves.toEqual({ error: "Invalid request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buffers early websocket frames before the upstream ws import resolves", async () => {
    const { service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const context = {
      req: {
        param: (name: string) => name === "sessionId" ? session.id : "",
        path: `/api/native-apps/sessions/${session.id}/stream/websocket`,
        raw: { headers: new Headers({ Cookie: `${service.streamCookieName(session.id)}=${streamToken}` }) },
        url: `http://matrix.local/api/native-apps/sessions/${session.id}/stream/websocket`,
      },
    };
    const handler = createNativeWebSocketHandler(context as never, service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    } as {
      close: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      _nativePending?: unknown[];
      _nativePendingBytes?: () => number;
    };

    handler.onOpen(null, ws);
    handler.onMessage({ data: "hello" }, ws);

    expect(ws.close).not.toHaveBeenCalled();
    expect(ws._nativePending).toEqual(["hello"]);
    expect(ws._nativePendingBytes?.()).toBe(5);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    handler.onClose(null, ws);
  });

  it("creates the upstream websocket using the ws default export", async () => {
    const { service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const context = {
      req: {
        param: (name: string) => name === "sessionId" ? session.id : "",
        path: `/api/native-apps/sessions/${session.id}/stream/websocket`,
        raw: { headers: new Headers({ Cookie: `${service.streamCookieName(session.id)}=${streamToken}` }) },
        url: `http://matrix.local/api/native-apps/sessions/${session.id}/stream/websocket`,
      },
    };
    const handler = createNativeWebSocketHandler(context as never, service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    };

    handler.onOpen(null, ws);
    await vi.waitFor(() => expect(wsMock.WebSocket).toHaveBeenCalledTimes(1));

    expect(wsMock.instances[0]?.url).toBe("ws://127.0.0.1:46000/websocket");
    handler.onClose(null, ws);
  });

  it("authenticates opaque iframe websockets through the stream capability path", async () => {
    const { service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const context = {
      req: {
        param: (name: string) => name === "sessionId" ? session.id : "",
        path: `/api/native-apps/sessions/${session.id}/stream/${streamToken}/`,
        raw: { headers: new Headers() },
        url: `http://matrix.local/api/native-apps/sessions/${session.id}/stream/${streamToken}/`,
      },
    };
    const handler = createNativeWebSocketHandler(context as never, service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    };

    handler.onOpen(null, ws);
    await vi.waitFor(() => expect(wsMock.WebSocket).toHaveBeenCalledTimes(1));

    expect(wsMock.instances[0]?.url).toBe("ws://127.0.0.1:46000/");
    handler.onClose(null, ws);
  });

  it("does not create an upstream websocket after the downstream socket closes during setup", async () => {
    const { service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const context = {
      req: {
        param: (name: string) => name === "sessionId" ? session.id : "",
        path: `/api/native-apps/sessions/${session.id}/stream/websocket`,
        raw: { headers: new Headers({ Cookie: `${service.streamCookieName(session.id)}=${streamToken}` }) },
        url: `http://matrix.local/api/native-apps/sessions/${session.id}/stream/websocket`,
      },
    };
    const handler = createNativeWebSocketHandler(context as never, service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    };

    handler.onOpen(null, ws);
    handler.onClose(null, ws);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(wsMock.WebSocket).not.toHaveBeenCalled();
  });

  it("closes oversized websocket frames before opening an upstream socket", async () => {
    const { service } = createApp("alice");
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const streamToken = service.streamCookieValue(session.id);
    const context = {
      req: {
        param: (name: string) => name === "sessionId" ? session.id : "",
        path: `/api/native-apps/sessions/${session.id}/stream/websocket`,
        raw: { headers: new Headers({ Cookie: `${service.streamCookieName(session.id)}=${streamToken}` }) },
        url: `http://matrix.local/api/native-apps/sessions/${session.id}/stream/websocket`,
      },
    };
    const handler = createNativeWebSocketHandler(context as never, service);
    const ws = { close: vi.fn(), send: vi.fn() };

    handler.onOpen(null, ws);
    handler.onMessage({ data: new Uint8Array(4 * 1024 * 1024 + 1) }, ws);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(wsMock.WebSocket).not.toHaveBeenCalled();
  });
});
