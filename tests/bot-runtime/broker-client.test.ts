import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotBrokerError, createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";

const RUNTIME = `runtime_${"a".repeat(32)}`;
const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function broker(reply: (frame: Record<string, unknown>) => string | null, responseDelayMs = 0): { socketPath: string; frames: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "bot-broker-"));
  const socketPath = join(dir, "broker.sock");
  const frames: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      frames.push(frame);
      const response = reply(frame);
      if (response === null) return;
      const send = () => socket.end(`${response}\n`);
      if (responseDelayMs) setTimeout(send, responseDelayMs);
      else send();
    });
  });
  server.listen(socketPath);
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, frames };
}

const client = (socketPath: string, timeoutMs = 2_000) => createBotBrokerClient({
  socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", timeoutMs, requestIdFactory: () => REQUEST_ID,
});

describe("bot broker client", () => {
  it("keeps a real GitHub broker socket alive beyond thirty seconds and validates its reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-broker-wait-"));
    const socketPath = join(dir, "broker.sock");
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.on("data", () => {
        const timer = setTimeout(() => socket.end(`${JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
          result: { ok: true, content: [{ type: "text", text: "approved and confirmed" }] } })}\n`), 31_000);
        timers.add(timer);
      });
    });
    server.listen(socketPath);
    cleanups.push(() => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    const defaultClient = createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", requestIdFactory: () => REQUEST_ID });
    await expect(defaultClient.tool({ toolCallId: "call_github", capability: "github.developer", args: { action: "clone", path: "repo", repository: "owner/repo" } }))
      .resolves.toMatchObject({ ok: true, content: [{ text: "approved and confirmed" }] });
  }, 40_000);

  it("cancels a pending GitHub socket and retains explicit timeout overrides", async () => {
    const { socketPath } = broker(() => null);
    const controller = new AbortController();
    const sockets: Socket[] = [];
    const options = { socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
      connectFn: (path: string) => { const socket = connect({ path }); sockets.push(socket); return socket; } };
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = createBotBrokerClient(options)
      .tool({ toolCallId: "call_github", capability: "github.developer", args: { action: "status" } }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
    expect(sockets[0]?.destroyed).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(createBotBrokerClient({ ...options, timeoutMs: 25 }).tool({ toolCallId: "call_override", capability: "github.developer", args: { action: "status" } }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(sockets[1]?.destroyed).toBe(true);
  });
  it("observes cancellation that occurs while the socket is being created", async () => {
    const controller = new AbortController();
    const socket = new Socket();
    const request = createBotBrokerClient({ socketPath: "unused", runtimeHandle: RUNTIME,
      executionGeneration: "3", runId: "run_abc", timeoutMs: 25,
      connectFn: () => { controller.abort(); return socket; } })
      .tool({ toolCallId: "call_cancel_connect", capability: "github.developer", args: { action: "status" } }, controller.signal);
    await expect(request).rejects.toMatchObject({ code: "stale_generation" });
    expect(socket.destroyed).toBe(true);
  });
  it("bounds total GitHub reply time even if a peer keeps sending partial data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-broker-drip-"));
    const socketPath = join(dir, "broker.sock");
    const sockets = new Set<Socket>();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        intervals.push(setInterval(() => socket.write(" "), 15));
        timers.push(setTimeout(() => socket.end(`${JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
          result: { ok: true, content: [{ type: "text", text: "late" }] } })}\n`), 200));
      });
    });
    server.listen(socketPath);
    cleanups.push(() => { for (const timer of timers) clearTimeout(timer); for (const interval of intervals) clearInterval(interval);
      for (const socket of sockets) socket.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    await expect(createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
      timeoutMs: 80, requestIdFactory: () => REQUEST_ID }).tool({ toolCallId: "call_drip", capability: "github.developer", args: { action: "status" } }))
      .rejects.toMatchObject({ code: "timeout" });
  });
  it("clears the GitHub absolute deadline and abort listener after a valid reply", async () => {
    const { socketPath } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
      result: { ok: true, content: [{ type: "text", text: "ready" }] } }));
    const controller = new AbortController();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    try {
      await createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
        requestIdFactory: () => REQUEST_ID }).tool({ toolCallId: "call_cleanup", capability: "github.developer", args: { action: "status" } }, controller.signal);
      const timerIndex = scheduled.mock.calls.findIndex(call => call[1] === 725_000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[timerIndex]?.value);
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally { scheduled.mockRestore(); cleared.mockRestore(); removed.mockRestore(); }
  });
  it("allows a bounded browser pause without widening ordinary tools or explicit timeouts", async () => {
    const { socketPath } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
      result: { ok: true, content: [{ type: "text", text: "resumed; observe again" }] } }));
    const timeout = vi.spyOn(Socket.prototype, "setTimeout");
    try {
      const defaultClient = createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", requestIdFactory: () => REQUEST_ID });
      await defaultClient.tool({ toolCallId: "call_browser", capability: "browser.action", args: { action: "snapshot" } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(390_000);
      await defaultClient.tool({ toolCallId: "call_read", capability: "artifact.read", args: { relPath: "fixture.txt" } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(30_000);
      await client(socketPath, 1000).tool({ toolCallId: "call_override", capability: "browser.action", args: { action: "status" } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(1000);
    } finally { timeout.mockRestore(); }
  });
  it("waits for the delegated task reply beyond the ordinary socket deadline", async () => {
    const { socketPath } = broker(frame => (frame.tool as { toolCallId: string }).toolCallId === "call_task"
      ? JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
        result: { ok: true, content: [{ type: "text", text: "native task completed" }] } })
      : null, 40);
    const setTimeout = Socket.prototype.setTimeout;
    const timeout = vi.spyOn(Socket.prototype, "setTimeout").mockImplementation(function (this: Socket, ms, callback) {
      return setTimeout.call(this, ms === 30_000 ? 10 : ms, callback);
    });
    try {
      const worker = createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", requestIdFactory: () => REQUEST_ID });
      const task = { toolCallId: "call_task", capability: "agent.task", args: { prompt: "Use the delegated native task" } } as const;
      await expect(worker.tool(task)).resolves.toMatchObject({ ok: true });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(150_000);
      await expect(worker.tool({ toolCallId: "call_read", capability: "artifact.read", args: { relPath: "fixture.txt" } }))
        .rejects.toMatchObject({ code: "timeout" });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(30_000);
      await expect(client(socketPath, 10).tool({ ...task, toolCallId: "call_override" })).rejects.toMatchObject({ code: "timeout" });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(10);
    } finally { timeout.mockRestore(); }
  });
  it("allows the bounded Jev evaluation deadline without widening ordinary reads or explicit overrides", async () => {
    const { socketPath } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
      result: { ok: true, content: [{ type: "text", text: "confirmed" }] } }));
    const timeout = vi.spyOn(Socket.prototype, "setTimeout");
    try {
      const defaultClient = createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", requestIdFactory: () => REQUEST_ID });
      await defaultClient.tool({ toolCallId: "call_long", capability: "jev.inbox", args: { operation: "evaluate", receipt: "a".repeat(64) } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(635_000);
      await defaultClient.tool({ toolCallId: "call_read", capability: "jev.inbox", args: { operation: "discover" } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(30_000);
      await client(socketPath, 1000).tool({ toolCallId: "call_override", capability: "jev.inbox", args: { operation: "evaluate", receipt: "a".repeat(64) } });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(1000);
    } finally { timeout.mockRestore(); }
  });
  it("sends one authenticated frame per request and validates the typed result", async () => {
    const { socketPath, frames } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true, result: { ok: true, content: [{ type: "text", text: "2 accounts" }] } }));
    const result = await client(socketPath).tool({ toolCallId: "call_1", capability: "integration.inventory", args: {} });
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "2 accounts" }] });
    expect(frames).toEqual([{
      version: 1, requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
      action: "bot.tool", tool: { toolCallId: "call_1", capability: "integration.inventory", args: {} },
    }]);
  });

  it("maps broker refusals to allowlisted codes and rejects mismatched or malformed replies", async () => {
    const refused = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: false, code: "not_granted" }));
    await expect(client(refused.socketPath).tool({ toolCallId: "call_1", capability: "integration.inventory", args: {} }))
      .rejects.toEqual(new BotBrokerError("not_granted"));
    const mismatched = broker(() => JSON.stringify({ version: 1, requestId: "018f0ce5-0000-7f95-a7c8-acae0dc5c5d1", ok: true, result: { accepted: true } }));
    await expect(client(mismatched.socketPath).event({ seq: 0, event: { type: "assistant_delta", text: "hi" } }))
      .rejects.toMatchObject({ code: "unavailable" });
    const garbage = broker(() => "not json");
    await expect(client(garbage.socketPath).loadSession()).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([
    { configured: true, perCall: false, abort: "configured" },
    { configured: false, perCall: true, abort: "per-call" },
    { configured: true, perCall: true, abort: "configured" },
    { configured: true, perCall: true, abort: "per-call" },
  ])("cancels a live socket from the $abort signal (configured $configured, per-call $perCall)", async ({ configured, perCall, abort }) => {
    const lifetime = new AbortController(), invocation = new AbortController();
    const received = Promise.withResolvers<void>();
    const { socketPath, frames } = broker(() => { received.resolve(); return null; });
    const worker = createBotBrokerClient({
      socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
      timeoutMs: 150, signal: configured ? lifetime.signal : undefined, requestIdFactory: () => REQUEST_ID,
    });
    const outcome = worker.tool({ capability: "routine.cli", toolCallId: "call_cancel", args: { operation: "list" } },
      perCall ? invocation.signal : undefined).catch(error => error);
    await received.promise;
    (abort === "configured" ? lifetime : invocation).abort();
    expect(await outcome).toMatchObject({ code: "stale_generation" });
    expect(frames).toHaveLength(1);
  });

  it("honors an already-aborted configured signal for operations without a per-call signal", async () => {
    const { socketPath, frames } = broker(frame => JSON.stringify({ version: 1, requestId: frame.requestId, ok: true, result: {
      revision: 0, needsRecompaction: false, messages: [],
    } }));
    const worker = createBotBrokerClient({
      socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", signal: AbortSignal.abort(),
    });
    await expect(worker.loadSession()).rejects.toMatchObject({ code: "stale_generation" });
    expect(frames).toHaveLength(0);
  });

  it("times out a silent broker and refuses invalid frames before sending", async () => {
    const silent = broker(() => null);
    await expect(client(silent.socketPath, 50).loadSession()).rejects.toMatchObject({ code: "timeout" });
    const unused = broker(() => null);
    await expect(client(unused.socketPath).tool({ toolCallId: "call_1", capability: "artifact.read", args: { relPath: "../x" } } as never))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(unused.frames).toEqual([]);
  });

  it("loads and saves sessions with revision results", async () => {
    const { socketPath } = broker((frame) => JSON.stringify(frame.action === "bot.session.load"
      ? { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 4, needsRecompaction: false, messages: [{ role: "user", content: "hi", timestamp: 1 }] } }
      : { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 5 } }));
    const broker1 = client(socketPath);
    await expect(broker1.loadSession()).resolves.toEqual({ revision: 4, needsRecompaction: false, messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    await expect(broker1.saveSession({ baseRevision: 4, messages: [] })).resolves.toEqual({ revision: 5 });
  });

  it("fails closed when a session reply omits invalidation metadata", async () => {
    const { socketPath } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true,
      result: { revision: 4, messages: [] } }));
    await expect(client(socketPath).loadSession()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("carries a whole session larger than the shared 256 KiB request cap in both directions", async () => {
    const large = [{ role: "user", content: "x".repeat(400 * 1024), timestamp: 1 }];
    const { socketPath, frames } = broker((frame) => JSON.stringify(frame.action === "bot.session.load"
      ? { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 4, needsRecompaction: false, messages: large } }
      : { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 5 } }));
    const broker1 = client(socketPath);
    await expect(broker1.loadSession()).resolves.toMatchObject({ revision: 4 });
    await expect(broker1.saveSession({ baseRevision: 4, messages: large })).resolves.toEqual({ revision: 5 });
    expect(JSON.stringify(frames[1]).length).toBeGreaterThan(256 * 1024);
  });
});

it("selects live framing only for strict routine calls, retaining ordinary tool framing/deadlines", async () => {
  const { socketPath, frames } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true, result: { ok: true, content: [{ type: "text", text: "observed" }] } }));
  await client(socketPath).tool({ capability: "routine.cli", toolCallId: "call_routine", args: { operation: "list" } });
  await client(socketPath).tool({ capability: "artifact.read", toolCallId: "call_artifact", args: { relPath: "fixture.txt" } });
  expect(frames[0]).toMatchObject({ action: "bot.tool", transport: "live", tool: { capability: "routine.cli", args: { operation: "list" } } });
  expect(frames[1]).not.toHaveProperty("transport");
});
