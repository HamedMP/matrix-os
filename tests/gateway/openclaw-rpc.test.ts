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

async function beginCall(options: { maxPending?: number; timeoutMs?: number } = {}) {
  const socket = new FakeSocket();
  const client = createOpenClawRpcClient({
    url: "ws://127.0.0.1:18789",
    token: "a".repeat(64),
    socketFactory: () => socket,
    ...options,
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
    await timed.client.close();

    const active = await beginCall();
    const controller = new AbortController();
    const aborted = active.client.call("models.list", {}, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ kind: "runtime_unavailable" });
    const healthClosed = expect(active.call).rejects.toMatchObject({
      kind: "runtime_unavailable",
    });
    await active.client.close();
    await healthClosed;
  });

  it("cleans up correlation state when a socket send throws", async () => {
    const active = await beginCall({ maxPending: 2 });
    active.socket.throwOnSend = true;
    await expect(active.client.call(
      "models.list",
      {},
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: "runtime_unavailable" });

    active.socket.throwOnSend = false;
    const retry = active.client.call("models.list", {}, new AbortController().signal);
    await vi.waitFor(() => expect(active.socket.sent).toHaveLength(3));
    const frame = JSON.parse(active.socket.sent[2]!);
    active.socket.receive({ type: "res", id: frame.id, ok: true, payload: [] });
    await expect(retry).resolves.toEqual([]);
    const healthClosed = expect(active.call).rejects.toMatchObject({
      kind: "runtime_unavailable",
    });
    await active.client.close();
    await healthClosed;
  });
});
