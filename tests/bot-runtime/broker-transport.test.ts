import { createConnection } from "node:net";
import { BotBrokerRequestSchema } from "@matrix-os/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotBrokerError, createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { brokerRequest } from "../../packages/scope-runtime/src/inference-bridge.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function socketServer() {
  const dir = await mkdtemp(join(tmpdir(), "pi-transport-"));
  const socketPath = join(dir, "broker.sock");
  const server = createScopeRuntimeBrokerServer({
    socketPath,
    broker: { handle: vi.fn(), close: vi.fn() },
    routeFrame: async (raw) => {
      const frame = raw as { requestId: string; action: string };
      return frame.action === "bot.session.load"
        ? { version: 1, requestId: frame.requestId, ok: true, result: { revision: 0, needsRecompaction: false, messages: [] } }
        : { version: 1, requestId: frame.requestId, ok: true, status: 200, headers: {}, body: "data: READY\n\n" };
    },
  });
  await server.start();
  cleanup.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  return socketPath;
}

describe("Pi clients against the production broker socket protocol", () => {
  it("loads a bot session after terminating its single request frame", async () => {
    const socketPath = await socketServer();
    const client = createBotBrokerClient({ socketPath, runtimeHandle: `runtime_${"a".repeat(32)}`,
      executionGeneration: "3", runId: "run_abc", timeoutMs: 500 });
    await expect(client.loadSession()).resolves.toEqual({ revision: 0, needsRecompaction: false, messages: [] });
  });

  it("returns inference bytes over the same half-closed socket protocol", async () => {
    const socketPath = await socketServer();
    await expect(brokerRequest(socketPath, { requestId: "inference-qa", action: "inference.responses" }, undefined, 500))
      .resolves.toMatchObject({ ok: true, body: "data: READY\n\n" });
  });
});

it("routine transport abort reaches a waiting real server without a projector event or parent end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routine-live-")), socketPath = join(dir, "broker.sock");
  let observed: AbortSignal | undefined, calls = 0;
  const server = createScopeRuntimeBrokerServer({ socketPath, requestTimeoutMs: 10_000, routedRequestTimeoutMs: 10_000,
    broker: { handle: vi.fn(), close: vi.fn() },
    routeFrame: async (raw, signal) => {
      calls++; observed = signal;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { version: 1, requestId: (raw as { requestId: string }).requestId, ok: false, code: "stale_generation" };
    },
  });
  await server.start(); cleanup.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const control = new AbortController(), client = createBotBrokerClient({ socketPath, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "3", runId: "run_abc", timeoutMs: 10_000 });
  const pending = client.tool({ capability: "routine.cli", toolCallId: "call_transport_only", args: { operation: "list" } }, control.signal);
  void pending.catch((error: unknown) => {
    if (!(error instanceof BotBrokerError) || error.code !== "stale_generation") console.warn("[transport fixture] Unexpected call failure", error instanceof Error ? error.name : "UnknownError");
  });
  await expect.poll(() => observed, { timeout: 1000 }).toBeDefined();
  control.abort(); await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
  await expect.poll(() => observed?.aborted, { timeout: 1000 }).toBe(true);
  expect(calls).toBe(1);
});

const routineFrame = { version: 1, requestId: "de000000-0000-4000-8000-000000000b02", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "3", runId: "run_abc",
  action: "bot.tool", transport: "live", tool: { capability: "routine.cli", toolCallId: "call_live", args: { operation: "list" } } };
async function rawExchange(socketPath: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath }); let reply = "";
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Raw transport fixture timed out")); });
    socket.once("connect", () => socket.end(text));
    socket.on("data", chunk => { reply += chunk.toString("utf8"); if (Buffer.byteLength(reply) > 4096) { socket.destroy(); reject(new Error("Unexpected oversized fixture reply")); } });
    socket.once("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    socket.once("close", () => resolve(reply));
  });
}

it("requires live framing only for routine tools and drops missing/truncated/duplicate/oversize frames before routed work", async () => {
  expect(BotBrokerRequestSchema.safeParse(routineFrame).success).toBe(true);
  const missing: Omit<typeof routineFrame, "transport"> & { transport?: string } = { ...routineFrame }; delete missing.transport;
  expect(BotBrokerRequestSchema.safeParse(missing).success).toBe(false);
  const artifact = { ...routineFrame, tool: { capability: "artifact.read", toolCallId: "call_read", args: { relPath: "fixture.txt" } } };
  expect(BotBrokerRequestSchema.safeParse(artifact).success).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "routine-frames-")), socketPath = join(dir, "broker.sock");
  let admitted = 0;
  const server = createScopeRuntimeBrokerServer({ socketPath, broker: { handle: vi.fn(), close: vi.fn() },
    routeFrame: async raw => {
      const parsed = BotBrokerRequestSchema.safeParse(raw); if (!parsed.success) return undefined;
      admitted++; return { version: 1, requestId: parsed.data.requestId, ok: true, result: { ok: true, content: [{ type: "text", text: "observed" }] } };
    },
  });
  await server.start(); cleanup.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const json = JSON.stringify(routineFrame);
  for (const text of [JSON.stringify(missing) + "\n", JSON.stringify(artifact) + "\n", json, json + "\n" + json + "\n", json + "\ntrailing", "x".repeat(641 * 1024)]) {
    expect(await rawExchange(socketPath, text)).toBe("");
  }
  expect(admitted).toBe(0);
  // Existing non-routine tools retain their half-closed EOF behavior.
  const legacyArtifact = { ...artifact }; delete (legacyArtifact as { transport?: string }).transport;
  expect(JSON.parse(await rawExchange(socketPath, JSON.stringify(legacyArtifact) + "\n"))).toMatchObject({ ok: true });
  expect(admitted).toBe(1);
});

it.each(["extra frame", "shutdown", "deadline"])("live routine %s aborts the waiting consumer and settles one operation", async ending => {
  const dir = await mkdtemp(join(tmpdir(), "routine-end-")), socketPath = join(dir, "broker.sock");
  let observed: AbortSignal | undefined, dispatched = 0;
  const server = createScopeRuntimeBrokerServer({ socketPath, requestTimeoutMs: 5000, routedRequestTimeoutMs: ending === "deadline" ? 100 : 5000,
    broker: { handle: vi.fn(), close: vi.fn() }, routeFrame: async (raw, signal) => {
      const parsed = BotBrokerRequestSchema.parse(raw); observed = signal; dispatched++;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { version: 1, requestId: parsed.requestId, ok: false, code: "stale_generation" };
    },
  });
  await server.start(); cleanup.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = createConnection({ path: socketPath });
  const closed = new Promise<void>(resolve => { socket.once("close", () => resolve()); });
  socket.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error; });
  socket.once("connect", () => socket.write(JSON.stringify(routineFrame) + "\n"));
  await expect.poll(() => observed, { timeout: 1000 }).toBeDefined();
  if (ending === "extra frame") socket.write(JSON.stringify(routineFrame) + "\n");
  else if (ending === "shutdown") await server.close();
  await expect.poll(() => observed?.aborted, { timeout: 1000 }).toBe(true); await closed;
  expect(dispatched).toBe(1);
});

it("retains the socket capacity bound while a live routine is awaiting its consumer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routine-cap-")), socketPath = join(dir, "broker.sock");
  let observed: AbortSignal | undefined, dispatched = 0;
  const server = createScopeRuntimeBrokerServer({ socketPath, maxConnections: 1,
    broker: { handle: vi.fn(), close: vi.fn() }, routeFrame: async (raw, signal) => {
      observed = signal; dispatched++;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { version: 1, requestId: (raw as { requestId: string }).requestId, ok: false, code: "stale_generation" };
    },
  });
  await server.start(); cleanup.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const client = createBotBrokerClient({ socketPath, runtimeHandle: routineFrame.runtimeHandle, executionGeneration: "3", runId: "run_abc", timeoutMs: 5000 });
  const control = new AbortController(), request = { capability: "routine.cli" as const, toolCallId: "call_live", args: { operation: "list" as const } };
  const first = client.tool(request, control.signal);
  void first.catch((error: unknown) => {
    if (!(error instanceof BotBrokerError) || error.code !== "stale_generation") console.warn("[transport fixture] Unexpected call failure", error instanceof Error ? error.name : "UnknownError");
  });
  await expect.poll(() => observed, { timeout: 1000 }).toBeDefined();
  await expect(client.tool({ ...request, toolCallId: "call_over_capacity" })).rejects.toMatchObject({ code: "unavailable" });
  expect(dispatched).toBe(1);
  control.abort(); await expect(first).rejects.toMatchObject({ code: "stale_generation" });
  await expect.poll(() => observed?.aborted, { timeout: 1000 }).toBe(true);
});
