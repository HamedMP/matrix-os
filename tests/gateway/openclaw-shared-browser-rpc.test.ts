import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createOpenClawRpcClient } from "../../packages/gateway/src/agent-config/openclaw-rpc.js";
import { BROWSER_AUTHORITY_TIMEOUT_MS } from "../../packages/gateway/src/chat/openclaw-shared-browser-rpc.js";
class Socket extends EventEmitter {
  readyState = 1; sent: any[] = [];
  send(value: string) {
    const request = JSON.parse(value); this.sent.push(request);
    if (request.method === "connect") queueMicrotask(() => this.receive({ type: "res", id: request.id, ok: true, payload: {
      type: "hello-ok", protocol: 4, server: { version: "2026.7.1", connId: "synthetic" },
      features: { methods: ["matrix.browser.before", "matrix.browser.execute", "matrix.browser.cancel", "matrix.browser.end"], events: [] },
      snapshot: {}, auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
      policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, tickIntervalMs: 15000 },
    } }));
  }
  receive(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  close() { this.readyState = 3; this.emit("close"); }
}
const invocation = { sessionKey: "agent:main:synthetic", toolCallId: "call_synthetic", callId: "b".repeat(32), ticketId: "b".repeat(32), action: { action: "status" } };
function setup(maxPending = 8) {
  const socket = new Socket();
  const client = createOpenClawRpcClient({ url: "ws://127.0.0.1:18789/", token: "c".repeat(64), maxPending,
    socketFactory: () => { queueMicrotask(() => socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "synthetic", ts: Date.now() } })); return socket; },
  }); return { socket, client };
}
it("uses the existing authenticated protocol-v4 connection for the fixed browser methods", async () => {
  const { socket, client } = setup();
  try {
    const call = client.call("matrix.browser.execute", invocation, AbortSignal.timeout(1000), { timeoutMs: BROWSER_AUTHORITY_TIMEOUT_MS });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[0]).toMatchObject({ method: "connect", params: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"], auth: { token: "c".repeat(64) } } });
    expect(socket.sent[1]).toMatchObject({ method: "matrix.browser.execute", params: invocation });
    socket.receive({ type: "res", id: socket.sent[1].id, ok: true, payload: { content: [{ type: "text", text: "synthetic" }] } });
    await expect(call).resolves.toMatchObject({ content: [{ text: "synthetic" }] });
  } finally { await client.close(); }
});
it("reserves bounded cancellation correlation capacity while an action uses the normal cap", async () => {
  const { socket, client } = setup(1); const controller = new AbortController();
  try {
    const action = client.call("matrix.browser.execute", invocation, controller.signal); const rejected = expect(action).rejects.toThrow();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const { action: _action, ...params } = invocation;
    const cancel = client.call("matrix.browser.cancel", params, AbortSignal.timeout(1000));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    socket.receive({ type: "res", id: socket.sent[2].id, ok: true, payload: { cancelled: true, settled: true } });
    await expect(cancel).resolves.toMatchObject({ settled: true }); controller.abort(); await rejected;
  } finally { controller.abort(); await client.close(); }
});
it("rejects extra cancellation fields and wrong action shapes before opening a socket", async () => {
  const socketFactory = vi.fn(() => new Socket()),client = createOpenClawRpcClient({ url: "ws://127.0.0.1:18789/", token: "c".repeat(64), socketFactory });
  const { action: _action, ...params } = invocation;
  await expect(client.call("matrix.browser.cancel", { ...params, token: "foreign" }, AbortSignal.timeout(1000))).rejects.toMatchObject({ kind: "agent_config_invalid" });
  await expect(client.call("matrix.browser.execute", { ...invocation, action: { action: "status", url: "foreign" } }, AbortSignal.timeout(1000))).rejects.toMatchObject({ kind: "agent_config_invalid" });
  expect(socketFactory).not.toHaveBeenCalled(); await client.close();
});
it("preserves escaped text actions beyond the unrelated 16KB request cap within the fixed browser cap", async () => {
  const { socket, client } = setup();
  try {
    const action = { action: "type", observationId: "observation", ref: "reference", text: "\u0001".repeat(4000) };
    const call = client.call("matrix.browser.execute", { ...invocation, action }, AbortSignal.timeout(1000));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(Buffer.byteLength(JSON.stringify(socket.sent[1]))).toBeGreaterThan(16 * 1024);
    socket.receive({ type: "res", id: socket.sent[1].id, ok: true, payload: { content: [] } }); await call;
  } finally { await client.close(); }
});
it("rejects a browser deadline above the qualified bounded action timeout", async () => {
  const { socket, client } = setup();
  try {
    await expect(client.call("matrix.browser.execute", invocation, AbortSignal.timeout(1000), { timeoutMs: BROWSER_AUTHORITY_TIMEOUT_MS + 1 })).rejects.toMatchObject({ kind: "agent_config_invalid" });
    expect(socket.sent.every(r => r.method === "connect")).toBe(true);
  } finally { await client.close(); }
});
it("keeps the qualified browser call alive beyond generic RPC timeouts and expires it at its own deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { socket, client } = setup(); let settled = false;
  try {
    const call = client.call("matrix.browser.execute", invocation, new AbortController().signal, { timeoutMs: BROWSER_AUTHORITY_TIMEOUT_MS });
    void call.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(call).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await vi.advanceTimersByTimeAsync(1); expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(BROWSER_AUTHORITY_TIMEOUT_MS - 10_001); await rejected;
    expect(settled).toBe(true);
  } finally { await client.close(); vi.useRealTimers(); }
});
