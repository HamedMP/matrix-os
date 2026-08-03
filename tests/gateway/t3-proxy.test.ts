import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildT3ProxyTarget,
  createT3WebSocketProxyHub,
  proxyT3HttpRequest,
  T3_PROXY_PREFIX,
} from "../../packages/gateway/src/t3-proxy.js";

describe("T3 direct proxy", () => {
  it("maps only bounded T3 protocol paths to the loopback server", () => {
    expect(
      buildT3ProxyTarget(
        `https://gateway.invalid${T3_PROXY_PREFIX}/.well-known/t3/environment`,
      ),
    ).toBe("http://127.0.0.1:3773/.well-known/t3/environment");
    expect(
      buildT3ProxyTarget(
        `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=short-lived-ticket`,
        "ws:",
      ),
    ).toBe("ws://127.0.0.1:3773/ws?wsTicket=short-lived-ticket");
    expect(
      buildT3ProxyTarget(`https://gateway.invalid${T3_PROXY_PREFIX}/../health`),
    ).toBeNull();
    expect(
      buildT3ProxyTarget(`https://gateway.invalid${T3_PROXY_PREFIX}-evil/api/auth/session`),
    ).toBeNull();
  });

  it("rejects methods outside the bounded proxy contract", async () => {
    const fetchFn = vi.fn();
    const response = await proxyT3HttpRequest(
      new Request(`https://gateway.invalid${T3_PROXY_PREFIX}/api/auth/session`, {
        method: "PROPFIND",
      }),
      { fetchFn },
    );

    expect(response.status).toBe(405);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("forwards T3 credentials but strips Matrix and hop-by-hop credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json(
        { ok: true },
        {
          headers: {
            "access-control-allow-origin": "https://app.t3.codes",
            "set-cookie": "should-not-leave-loopback=1",
          },
        },
      ),
    );
    const request = new Request(
      `https://gateway.invalid${T3_PROXY_PREFIX}/api/auth/session`,
      {
        headers: {
          authorization: "Bearer t3-session",
          dpop: "proof",
          origin: "https://app.t3.codes",
          cookie: "matrix_session=secret",
          connection: "keep-alive",
          "x-platform-verified": "internal-proof",
        },
      },
    );

    const response = await proxyT3HttpRequest(request, { fetchFn });

    expect(response.status).toBe(200);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3773/api/auth/session");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer t3-session");
    expect(headers.get("dpop")).toBe("proof");
    expect(headers.get("origin")).toBe("https://app.t3.codes");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("x-platform-verified")).toBeNull();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.t3.codes",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns a generic unavailable response when the local server is offline", async () => {
    const response = await proxyT3HttpRequest(
      new Request(`https://gateway.invalid${T3_PROXY_PREFIX}/oauth/token`, {
        method: "POST",
        body: "grant_type=test",
      }),
      { fetchFn: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3773")) },
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "T3 Code is not running" });
    expect(body).not.toContain("127.0.0.1");
  });

  it("preserves text websocket frames in both directions", () => {
    class FakeUpstream extends EventEmitter {
      readonly readyState = 1;
      close = vi.fn();
      send = vi.fn();
    }
    const upstream = new FakeUpstream();
    const connect = vi.fn(() => upstream);
    const hub = createT3WebSocketProxyHub({ connect });
    const client = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const handler = hub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=short-lived-ticket`,
      "https://app.t3.codes",
    );

    handler.onOpen?.({}, client);
    expect(connect).toHaveBeenCalledWith(
      "ws://127.0.0.1:3773/ws?wsTicket=short-lived-ticket",
      "https://app.t3.codes",
      1024 * 1024,
    );
    handler.onMessage?.({ data: '{"type":"request"}' });
    upstream.emit("message", Buffer.from('{"type":"response"}'), false);

    expect(upstream.send).toHaveBeenCalledWith('{"type":"request"}');
    expect(client.send).toHaveBeenCalledWith('{"type":"response"}');
    hub.close();
  });

  it("evicts a websocket connection when the loopback send fails", () => {
    class FakeUpstream extends EventEmitter {
      readonly readyState = 1;
      close = vi.fn();
      send = vi.fn(() => { throw new Error("write failed"); });
    }
    const hub = createT3WebSocketProxyHub({ connect: () => new FakeUpstream() });
    const client = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const handler = hub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=ticket`,
    );

    handler.onOpen?.({}, client);
    handler.onMessage?.({ data: "request" });

    expect(client.close).toHaveBeenCalled();
    expect(hub.activeConnectionsForTest()).toBe(0);
  });

  it("caps websocket connections and drains them during gateway shutdown", () => {
    class FakeUpstream extends EventEmitter {
      readonly readyState = 0;
      close = vi.fn();
      send = vi.fn();
    }
    const upstreams: FakeUpstream[] = [];
    const hub = createT3WebSocketProxyHub({
      maxConnections: 1,
      connect: () => {
        const upstream = new FakeUpstream();
        upstreams.push(upstream);
        return upstream;
      },
    });
    const client = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };

    const first = hub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=one`,
    );
    first.onOpen?.({}, client);
    const second = hub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=two`,
    );
    second.onOpen?.({}, client);

    expect(upstreams).toHaveLength(1);
    expect(client.close).toHaveBeenCalled();
    hub.close();
    expect(upstreams[0]!.close).toHaveBeenCalled();
    expect(hub.activeConnectionsForTest()).toBe(0);
  });

  it("closes oversized and over-buffered websocket traffic", () => {
    class FakeUpstream extends EventEmitter {
      readonly readyState = 1;
      readonly bufferedAmount = 9;
      close = vi.fn();
      send = vi.fn();
    }
    const upstream = new FakeUpstream();
    const hub = createT3WebSocketProxyHub({
      maxFrameBytes: 8,
      maxPendingBytes: 10,
      connect: () => upstream,
    });
    const client = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const handler = hub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=ticket`,
    );

    handler.onOpen?.({}, client);
    handler.onMessage?.({ data: "ab" });

    expect(client.close).toHaveBeenCalledWith(1009, "Outbound data limit exceeded");
    expect(upstream.close).toHaveBeenCalled();
    expect(hub.activeConnectionsForTest()).toBe(0);

    const nextUpstream = new FakeUpstream();
    const nextHub = createT3WebSocketProxyHub({
      maxFrameBytes: 4,
      connect: () => nextUpstream,
    });
    const nextClient = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const nextHandler = nextHub.createHandler(
      `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=ticket`,
    );
    nextHandler.onOpen?.({}, nextClient);
    nextUpstream.emit("message", Buffer.from("oversized"), true);

    expect(nextClient.close).toHaveBeenCalledWith(1009, "Frame too large");
    expect(nextHub.activeConnectionsForTest()).toBe(0);
  });

  it("bounds pre-open data and times out stalled websocket handshakes", () => {
    vi.useFakeTimers();
    try {
      class PendingUpstream extends EventEmitter {
        readonly readyState = 0;
        close = vi.fn();
        send = vi.fn();
      }
      const pending = new PendingUpstream();
      const hub = createT3WebSocketProxyHub({
        maxPendingBytes: 3,
        handshakeTimeoutMs: 50,
        connect: () => pending,
      });
      const client = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
      const handler = hub.createHandler(
        `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=ticket`,
      );
      handler.onOpen?.({}, client);
      handler.onMessage?.({ data: "ab" });
      handler.onMessage?.({ data: "cd" });

      expect(client.close).toHaveBeenCalledWith(1009, "Pending data limit exceeded");
      expect(hub.activeConnectionsForTest()).toBe(0);

      const stalled = new PendingUpstream();
      const stalledHub = createT3WebSocketProxyHub({
        handshakeTimeoutMs: 50,
        connect: () => stalled,
      });
      const stalledClient = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
      stalledHub.createHandler(
        `https://gateway.invalid${T3_PROXY_PREFIX}/ws?wsTicket=stalled`,
      ).onOpen?.({}, stalledClient);
      vi.advanceTimersByTime(50);

      expect(stalledClient.close).toHaveBeenCalledWith(1013, "T3 connection timed out");
      expect(stalled.close).toHaveBeenCalled();
      expect(stalledHub.activeConnectionsForTest()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
