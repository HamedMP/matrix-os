import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ScopeRuntimeBrokerRequest,
  ScopeRuntimeBrokerResponse,
} from "../../packages/scope-runtime/src/broker-protocol.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";

const REQUEST: ScopeRuntimeBrokerRequest = {
  version: 1,
  action: "egress.fetch",
  requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: "runtime_22222222222222222222222222222222",
  executionGeneration: "7",
  method: "GET",
  url: "https://api.example.dev/v1/items",
  accept: "application/json",
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function exchange(socketPath: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("close", () => resolve(output));
    socket.once("connect", () => socket.end(frame));
  });
}

describe("scope runtime broker socket server", () => {
  it("exposes the bounded action protocol to dynamic workloads and drains its owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-scope-broker-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "broker.sock");
    const broker = {
      handle: vi.fn(async (request: ScopeRuntimeBrokerRequest): Promise<ScopeRuntimeBrokerResponse> => ({
        version: 1,
        requestId: request.requestId,
        ok: false,
        error: "action_denied",
      })),
      close: vi.fn(async () => undefined),
    };
    const server = createScopeRuntimeBrokerServer({ socketPath, broker, requestTimeoutMs: 1_000 });
    await server.start();
    cleanup.push(() => server.close());

    expect((await stat(socketPath)).mode & 0o777).toBe(0o666);
    const response = await exchange(socketPath, `${JSON.stringify(REQUEST)}\n`);
    expect(JSON.parse(response)).toEqual(expect.objectContaining({
      requestId: REQUEST.requestId,
      ok: false,
      error: "action_denied",
    }));
    expect(broker.handle).toHaveBeenCalledTimes(1);

    await expect(exchange(socketPath, `${JSON.stringify({ ...REQUEST, command: "/bin/sh" })}\n`))
      .resolves.toBe("");
    await expect(exchange(socketPath, `${"x".repeat(513 * 1024)}\n`)).resolves.toBe("");
    expect(broker.handle).toHaveBeenCalledTimes(1);

    await server.close();
    expect(broker.close).toHaveBeenCalledTimes(1);
  });
});
