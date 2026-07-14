import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawRpcClient } from "../../packages/gateway/src/agent-config/openclaw-rpc.js";

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 1;
  throwOnSend = false;

  send(data: string) {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  receive(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

async function beginCall(options: {
  maxPending?: number;
  timeoutMs?: number;
  now?: () => number;
  helloExtensions?: Record<string, unknown>;
} = {}) {
  const socket = new FakeSocket();
  const { helloExtensions, ...clientOptions } = options;
  const client = createOpenClawRpcClient({
    url: "ws://127.0.0.1:18789",
    token: "a".repeat(64),
    socketFactory: () => socket,
    ...clientOptions,
  });
  const call = client.call("health", {}, new AbortController().signal);
  socket.receive({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "nonce-1", ts: 1_736_000_000_000 },
  });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const connect = JSON.parse(socket.sent[0]!);
  socket.receive({
    type: "res",
    id: connect.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      server: { version: "2026.7.1", connId: "conn-1" },
      features: { methods: ["health", "models.list"], events: [] },
      snapshot: {},
      auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
      policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, tickIntervalMs: 15_000 },
      ...helloExtensions,
    },
  });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  return { client, socket, call, connect, request: JSON.parse(socket.sent[1]!) };
}

describe("OpenClaw gateway RPC", () => {
  it("performs the protocol-v4 backend handshake without device pairing", async () => {
    const { client, socket, call, connect, request } = await beginCall();

    expect(connect).toMatchObject({
      type: "req",
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: "gateway-client", mode: "backend" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        auth: { token: "a".repeat(64) },
      },
    });
    expect(connect.params).not.toHaveProperty("device");
    expect(request).toMatchObject({ type: "req", method: "health", params: {} });
    socket.receive({ type: "res", id: request.id, ok: true, payload: { ok: true } });
    await expect(call).resolves.toEqual({ ok: true });
    await client.close();
  });

  it("rejects methods outside the Matrix allowlist before connecting", async () => {
    const socketFactory = vi.fn(() => new FakeSocket());
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "b".repeat(64),
      socketFactory,
    });

    await expect(client.call("plugins.install", {}, new AbortController().signal))
      .rejects.toMatchObject({ kind: "agent_config_invalid" });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("rejects oversized and malformed method requests before connecting", async () => {
    const socketFactory = vi.fn(() => new FakeSocket());
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "f".repeat(64),
      socketFactory,
      timeoutMs: 100,
    });

    await expect(client.call("config.patch", {
      raw: "x".repeat(16 * 1024),
      baseHash: "hash-1",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_invalid",
    });
    await expect(client.call("config.patch", {
      arbitrary: true,
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_invalid",
    });
    expect(socketFactory).not.toHaveBeenCalled();
    await client.close();
  });

  it("enforces the published eight-correlation ceiling", () => {
    expect(() => createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "0".repeat(64),
      maxPending: 9,
    })).toThrowError("Invalid OpenClaw pending-call cap");
  });

  it("caps pending correlations and rejects all work on close", async () => {
    const { client, call } = await beginCall({ maxPending: 1 });
    const second = client.call("models.list", {}, new AbortController().signal);

    await expect(second).rejects.toMatchObject({ kind: "agent_config_conflict" });
    await client.close();
    await expect(call).rejects.toMatchObject({ kind: "runtime_unavailable" });
  });

  it("rejects oversized frames without logging frame or token content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, socket, call } = await beginCall();
    const canary = `sk-secret-${"x".repeat(1024 * 1024)}`;

    try {
      socket.emit("message", Buffer.from(canary));
      await expect(call).rejects.toMatchObject({ kind: "invalid_response" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-secret");
    } finally {
      warn.mockRestore();
      await client.close();
    }
  });

  it("bounds calls with a timeout and honors caller abort", async () => {
    const timed = await beginCall({ timeoutMs: 100 });
    await expect(timed.call).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(timed.socket.readyState).toBe(3);
    await timed.client.close();

    const active = await beginCall();
    const controller = new AbortController();
    const aborted = active.client.call("models.list", {}, controller.signal);
    await vi.waitFor(() => expect(active.socket.sent).toHaveLength(3));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(active.socket.readyState).toBe(3);
    const healthClosed = expect(active.call).rejects.toMatchObject({
      kind: "runtime_unavailable",
    });
    await active.client.close();
    await healthClosed;
  });

  it("honors caller abort while the initial handshake is pending", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "e".repeat(64),
      socketFactory: () => socket,
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const rejection = vi.fn();
    const observed = client.call("health", {}, controller.signal).catch(rejection);

    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(rejection).toHaveBeenCalledWith(expect.objectContaining({
        kind: "runtime_unavailable",
      }));
      expect(socket.readyState).toBe(1);
    } finally {
      await client.close();
      await observed;
      vi.useRealTimers();
    }
  });

  it("invalidates the connection when a socket send throws", async () => {
    const active = await beginCall({ maxPending: 2 });
    const healthOutcome = active.call.catch((error: unknown) => error);
    active.socket.throwOnSend = true;
    await expect(active.client.call(
      "models.list",
      {},
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(active.socket.readyState).toBe(3);
    await expect(active.client.call(
      "models.list",
      {},
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(healthOutcome).resolves.toMatchObject({
      kind: "runtime_unavailable",
    });
    await active.client.close();
  });

  it("ignores bounded server events and duplicate challenges after handshake", async () => {
    const active = await beginCall();

    active.socket.receive({
      type: "event",
      event: "health",
      payload: { ts: 1_789_000_000_000 },
      seq: 4,
      stateVersion: { presence: 2, health: 3 },
    });
    active.socket.receive({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "duplicate", ts: 1_789_000_000_001 },
    });

    expect(active.socket.sent).toHaveLength(2);
    active.socket.receive({
      type: "res",
      id: active.request.id,
      ok: true,
      payload: { ok: true },
    });
    await expect(active.call).resolves.toEqual({ ok: true });
    await active.client.close();
  });

  it("ignores bounded events with additive state-version counters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const active = await beginCall();
    try {
      active.socket.receive({
        type: "event",
        event: "catalog.changed",
        payload: { providerCount: 2 },
        stateVersion: { catalog: 7 },
      });
      active.socket.receive({
        type: "res",
        id: active.request.id,
        ok: true,
        payload: { ok: true },
      });
      await expect(active.call).resolves.toEqual({ ok: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await active.client.close();
    }
  });

  it("accepts documented additive hello metadata", async () => {
    const active = await beginCall({
      helloExtensions: {
        pluginSurfaceUrls: { canvas: "http://127.0.0.1:18789/plugins/canvas" },
      },
    });
    active.socket.receive({
      type: "res",
      id: active.request.id,
      ok: true,
      payload: { ok: true },
    });
    await expect(active.call).resolves.toEqual({ ok: true });
    await active.client.close();
  });

  it("backs off sequential reconnects and maps synchronous socket failures", async () => {
    let now = 1_000;
    const sockets: FakeSocket[] = [];
    const socketFactory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "c".repeat(64),
      socketFactory,
      timeoutMs: 100,
      now: () => now,
    });
    const first = client.call("health", {}, new AbortController().signal);
    sockets[0]!.emit("close");
    await expect(first).rejects.toMatchObject({ kind: "runtime_unavailable" });

    await expect(client.call("health", {}, new AbortController().signal))
      .rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(socketFactory).toHaveBeenCalledOnce();

    now += 101;
    const retry = client.call("health", {}, new AbortController().signal);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    const retryClosed = expect(retry).rejects.toMatchObject({
      kind: "runtime_unavailable",
    });
    await client.close();
    await retryClosed;

    const throwingFactory = vi.fn(() => {
      throw new Error("provider socket detail");
    });
    const throwing = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "d".repeat(64),
      socketFactory: throwingFactory,
      timeoutMs: 100,
    });
    await expect(throwing.call("health", {}, new AbortController().signal))
      .rejects.toMatchObject({ kind: "runtime_unavailable" });
    await throwing.close();
  });

  it("ignores delayed callbacks from a replaced socket", async () => {
    let now = 1_000;
    const sockets: FakeSocket[] = [];
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "1".repeat(64),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      timeoutMs: 100,
      now: () => now,
    });
    const first = client.call("health", {}, new AbortController().signal);
    sockets[0]!.emit("close");
    await expect(first).rejects.toMatchObject({ kind: "runtime_unavailable" });

    now += 101;
    const retry = client.call("health", {}, new AbortController().signal);
    const replacement = sockets[1]!;
    replacement.receive({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "retry", ts: 1_789_000_000_000 },
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
    const connect = JSON.parse(replacement.sent[0]!);
    replacement.receive({
      type: "res",
      id: connect.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        server: { version: "2026.7.1", connId: "conn-2" },
        features: { methods: ["health"], events: [] },
        snapshot: {},
        auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
        policy: { maxPayload: 1024, maxBufferedBytes: 2048, tickIntervalMs: 15_000 },
      },
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(2));
    sockets[0]!.emit("close");
    const request = JSON.parse(replacement.sent[1]!);
    replacement.receive({ type: "res", id: request.id, ok: true, payload: { ok: true } });

    await expect(retry).resolves.toEqual({ ok: true });
    await client.close();
  });

  it("retries startup-sidecar handshakes within the connection budget", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createOpenClawRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "2".repeat(64),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      timeoutMs: 500,
    });
    const call = client.call("health", {}, new AbortController().signal);
    const observed = call.catch(() => undefined);
    try {
      sockets[0]!.receive({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "first", ts: 1_789_000_000_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const firstConnect = JSON.parse(sockets[0]!.sent[0]!);
      sockets[0]!.receive({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          details: { reason: "startup-sidecars" },
          retryAfterMs: 50,
        },
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(sockets).toHaveLength(2);
      sockets[1]!.receive({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "second", ts: 1_789_000_000_050 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const secondConnect = JSON.parse(sockets[1]!.sent[0]!);
      sockets[1]!.receive({
        type: "res",
        id: secondConnect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "2026.7.1", connId: "conn-retry" },
          features: { methods: ["health"], events: [] },
          snapshot: {},
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
          policy: { maxPayload: 1024, maxBufferedBytes: 2048, tickIntervalMs: 15_000 },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const request = JSON.parse(sockets[1]!.sent[1]!);
      sockets[1]!.receive({ type: "res", id: request.id, ok: true, payload: { ok: true } });
      await expect(call).resolves.toEqual({ ok: true });
    } finally {
      await client.close();
      await observed;
      vi.useRealTimers();
    }
  });

  it("serializes and rate-limits config patches", async () => {
    let now = 10_000;
    const active = await beginCall({ now: () => now });
    const initialOutcome = active.call.catch((error: unknown) => error);
    const patch = active.client.call("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { model: { primary: "a/b" } } } }),
      baseHash: "hash-1",
    }, new AbortController().signal);
    await vi.waitFor(() => expect(active.socket.sent).toHaveLength(3));
    await expect(active.client.call("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { model: { primary: "a/c" } } } }),
      baseHash: "hash-1",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_conflict",
    });
    const firstPatch = JSON.parse(active.socket.sent[2]!);
    active.socket.receive({ type: "res", id: firstPatch.id, ok: true, payload: { ok: true } });
    await expect(patch).resolves.toEqual({ ok: true });

    for (let index = 2; index <= 3; index += 1) {
      const next = active.client.call("config.patch", {
        raw: JSON.stringify({ agents: { defaults: { model: { primary: `a/${index}` } } } }),
        baseHash: `hash-${index}`,
      }, new AbortController().signal);
      await vi.waitFor(() => expect(active.socket.sent).toHaveLength(index + 2));
      const request = JSON.parse(active.socket.sent[index + 1]!);
      active.socket.receive({ type: "res", id: request.id, ok: true, payload: { ok: true } });
      await expect(next).resolves.toEqual({ ok: true });
    }
    await expect(active.client.call("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { model: { primary: "a/4" } } } }),
      baseHash: "hash-4",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_conflict",
    });

    now += 60_001;
    const afterWindow = active.client.call("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { model: { primary: "a/5" } } } }),
      baseHash: "hash-5",
    }, new AbortController().signal);
    await vi.waitFor(() => expect(active.socket.sent).toHaveLength(6));
    const finalRequest = JSON.parse(active.socket.sent[5]!);
    active.socket.receive({ type: "res", id: finalRequest.id, ok: true, payload: { ok: true } });
    await expect(afterWindow).resolves.toEqual({ ok: true });
    await active.client.close();
    await expect(initialOutcome).resolves.toMatchObject({
      kind: "runtime_unavailable",
    });
  });
});
