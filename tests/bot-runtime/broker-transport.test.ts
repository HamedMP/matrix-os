import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
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
        ? { version: 1, requestId: frame.requestId, ok: true, result: { revision: 0, messages: [] } }
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
    await expect(client.loadSession()).resolves.toEqual({ revision: 0, messages: [] });
  });

  it("returns inference bytes over the same half-closed socket protocol", async () => {
    const socketPath = await socketServer();
    await expect(brokerRequest(socketPath, { requestId: "inference-qa", action: "inference.responses" }, undefined, 500))
      .resolves.toMatchObject({ ok: true, body: "data: READY\n\n" });
  });
});
