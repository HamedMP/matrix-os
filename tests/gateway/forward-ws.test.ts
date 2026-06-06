import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForwardOpenMessageSchema,
  createForwardTunnelHub,
  normalizeForwardTarget,
  type ForwardDialer,
} from "../../packages/gateway/src/forward-ws.js";

class FakeGatewayWebSocket {
  sent: unknown[] = [];
  closed = false;
  closeCount = 0;

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closeCount += 1;
    this.closed = true;
  }
}

class FakeDuplexSocket {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  writes: Buffer[] = [];
  writeResults: boolean[] = [];
  destroyed = false;

  on(event: string, handler: (...args: unknown[]) => void) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
    return this;
  }

  removeAllListeners() {
    this.handlers.clear();
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  write(chunk: Buffer) {
    this.writes.push(Buffer.from(chunk));
    return this.writeResults.shift() ?? true;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe("forward websocket protocol", () => {
  it("validates open control messages", () => {
    expect(ForwardOpenMessageSchema.parse({ type: "open", host: "127.0.0.1", port: 3000 })).toEqual({
      type: "open",
      host: "127.0.0.1",
      port: 3000,
    });
    expect(() => ForwardOpenMessageSchema.parse({ type: "open", host: "example.com", port: 3000 })).toThrow();
    expect(() => ForwardOpenMessageSchema.parse({ type: "open", host: "127.0.0.1", port: 0 })).toThrow();
  });

  it("normalizes localhost targets to loopback and rejects non-loopback hosts", () => {
    expect(normalizeForwardTarget("localhost", 3000)).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(normalizeForwardTarget("::1", 3000)).toEqual({ host: "::1", port: 3000 });
    expect(() => normalizeForwardTarget("10.0.0.1", 3000)).toThrowError(
      expect.objectContaining({ code: "target_forbidden" }),
    );
  });

  it("rejects invalid control frames before dialing", () => {
    const dial = vi.fn();
    const hub = createForwardTunnelHub({ dial: dial as never });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "example.com", port: 3000 }) } as never, ws as never);

    expect(dial).not.toHaveBeenCalled();
    expect(JSON.parse(String(ws.sent[0]))).toEqual({
      type: "error",
      code: "target_forbidden",
      message: "Request failed",
    });
    expect(ws.closed).toBe(true);
  });

  it("counts pre-open websocket connections against the cap and times them out", async () => {
    const hub = createForwardTunnelHub({ maxConnections: 1, idleTimeoutMs: 5 });
    const firstWs = new FakeGatewayWebSocket();
    const secondWs = new FakeGatewayWebSocket();
    const first = hub.createHandler();
    const second = hub.createHandler();

    first.onOpen?.({} as never, firstWs as never);
    second.onOpen?.({} as never, secondWs as never);

    expect(JSON.parse(String(secondWs.sent[0]))).toEqual({
      type: "error",
      code: "connection_limit",
      message: "Request failed",
    });
    expect(secondWs.closed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(JSON.parse(String(firstWs.sent[0]))).toEqual({
      type: "error",
      code: "idle_timeout",
      message: "Request failed",
    });
    expect(firstWs.closed).toBe(true);
  });

  it("closes pre-open websocket close frames", () => {
    const hub = createForwardTunnelHub();
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "close" }) } as never, ws as never);

    expect(JSON.parse(String(ws.sent[0]))).toEqual({ type: "close" });
    expect(ws.closeCount).toBe(1);
  });

  it("clears pending handler state after hub shutdown", async () => {
    const hub = createForwardTunnelHub();
    const firstWs = new FakeGatewayWebSocket();
    const secondWs = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, firstWs as never);
    await hub.close();
    handler.onClose?.();
    handler.onOpen?.({} as never, secondWs as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "close" }) } as never, secondWs as never);

    expect(secondWs.closeCount).toBe(1);
  });

  it("bridges bytes in both directions after ready", () => {
    const socket = new FakeDuplexSocket();
    const dial: ForwardDialer = vi.fn(() => socket as never);
    const hub = createForwardTunnelHub({ dial });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("connect");
    handler.onMessage?.({ data: Buffer.from("from-client") } as never, ws as never);
    socket.emit("data", Buffer.from("from-remote"));

    expect(dial).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3000 });
    expect(JSON.parse(String(ws.sent[0]))).toEqual({ type: "ready" });
    expect(socket.writes).toEqual([Buffer.from("from-client")]);
    expect(Buffer.from(ws.sent[1] as Uint8Array)).toEqual(Buffer.from("from-remote"));
  });

  it("rejects oversized websocket binary frames", () => {
    const socket = new FakeDuplexSocket();
    const hub = createForwardTunnelHub({ dial: () => socket as never, maxFrameBytes: 4 });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("connect");
    handler.onMessage?.({ data: Buffer.from("too-large") } as never, ws as never);

    expect(JSON.parse(String(ws.sent[1]))).toEqual({
      type: "error",
      code: "frame_too_large",
      message: "Request failed",
    });
    expect(socket.destroyed).toBe(true);
    expect(ws.closed).toBe(true);
  });

  it("closes active websocket failures once", () => {
    const socket = new FakeDuplexSocket();
    const hub = createForwardTunnelHub({ dial: () => socket as never });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("connect");
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);

    expect(ws.closeCount).toBe(1);
  });

  it("queues websocket binary writes until the loopback socket drains", () => {
    const socket = new FakeDuplexSocket();
    socket.writeResults = [false, true];
    const hub = createForwardTunnelHub({ dial: () => socket as never });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("connect");
    handler.onMessage?.({ data: Buffer.from("first") } as never, ws as never);
    handler.onMessage?.({ data: Buffer.from("second") } as never, ws as never);

    expect(socket.writes).toEqual([Buffer.from("first")]);

    socket.emit("drain");

    expect(socket.writes).toEqual([Buffer.from("first"), Buffer.from("second")]);
  });

  it("closes active hub connections once on shutdown", async () => {
    const socket = new FakeDuplexSocket();
    const hub = createForwardTunnelHub({ dial: () => socket as never });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("connect");

    await hub.close();
    socket.emit("close");

    expect(ws.closeCount).toBe(1);
    expect(hub.activeConnectionsForTest()).toEqual([]);
  });

  it("returns generic client errors while logging dial failures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = new FakeDuplexSocket();
    const hub = createForwardTunnelHub({ dial: () => socket as never });
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();

    handler.onOpen?.({} as never, ws as never);
    handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, ws as never);
    socket.emit("error", new Error("ECONNREFUSED /private/path"));

    expect(JSON.parse(String(ws.sent[0]))).toEqual({
      type: "error",
      code: "dial_failed",
      message: "Request failed",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("isolates per-connection failures", () => {
    const sockets = [new FakeDuplexSocket(), new FakeDuplexSocket()];
    const hub = createForwardTunnelHub({
      dial: vi.fn(() => sockets.shift() as never),
    });
    const firstWs = new FakeGatewayWebSocket();
    const secondWs = new FakeGatewayWebSocket();
    const first = hub.createHandler();
    const second = hub.createHandler();

    first.onOpen?.({} as never, firstWs as never);
    second.onOpen?.({} as never, secondWs as never);
    first.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3000 }) } as never, firstWs as never);
    second.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: 3001 }) } as never, secondWs as never);

    const firstSocket = sockets.length === 0 ? null : undefined;
    expect(firstSocket).toBeNull();
    // The first emitted error should not close the second websocket.
    (hub.activeConnectionsForTest()[0]!.socket as unknown as FakeDuplexSocket).emit("error", new Error("boom"));
    expect(firstWs.closed).toBe(true);
    expect(secondWs.closed).toBe(false);
  });

  it("proxies bytes to a loopback TCP server", async () => {
    const tcp = createServer((socket) => {
      socket.on("data", (chunk) => {
        socket.write(Buffer.from(`echo:${chunk.toString("utf8")}`));
      });
    });
    servers.push(tcp);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    if (!address || typeof address === "string") throw new Error("missing tcp port");

    const hub = createForwardTunnelHub();
    const ws = new FakeGatewayWebSocket();
    const handler = hub.createHandler();
    try {
      handler.onOpen?.({} as never, ws as never);
      handler.onMessage?.({ data: JSON.stringify({ type: "open", host: "127.0.0.1", port: address.port }) } as never, ws as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      handler.onMessage?.({ data: Buffer.from("hello") } as never, ws as never);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(JSON.parse(String(ws.sent[0]))).toEqual({ type: "ready" });
      expect(ws.sent.some((value) =>
        value instanceof Uint8Array && Buffer.from(value).toString("utf8") === "echo:hello",
      )).toBe(true);
    } finally {
      await hub.close();
    }
  });
});
