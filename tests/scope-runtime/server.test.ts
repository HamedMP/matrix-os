import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeRequest, ScopeRuntimeResponse } from "../../packages/scope-runtime/src/protocol.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";

const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function pathForSocket(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "matrix-scope-server-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "supervisor.sock");
}

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

function response(request: ScopeRuntimeRequest): ScopeRuntimeResponse {
  return {
    version: 1,
    type: "capability.result",
    requestId: request.requestId,
    ok: false,
    error: "runtime_unavailable",
  };
}

describe("scope runtime supervisor server", () => {
  it("serves exactly one bounded request per Unix-socket connection", async () => {
    const socketPath = await pathForSocket();
    const controller = { handle: vi.fn(async (request: ScopeRuntimeRequest) => response(request)), close: vi.fn() };
    const server = createScopeRuntimeServer({ socketPath, controller });
    await server.start();
    cleanup.push(() => server.close());

    const output = await exchange(socketPath, `${JSON.stringify({
      version: 1,
      type: "capability.get",
      requestId: REQUEST_ID,
    })}\n`);
    expect(JSON.parse(output)).toEqual(expect.objectContaining({ requestId: REQUEST_ID }));
    expect(controller.handle).toHaveBeenCalledTimes(1);
  });

  it("drops malformed, injected, multiple, and oversized frames before dispatch", async () => {
    const socketPath = await pathForSocket();
    const controller = { handle: vi.fn(async (request: ScopeRuntimeRequest) => response(request)), close: vi.fn() };
    const server = createScopeRuntimeServer({ socketPath, controller });
    await server.start();
    cleanup.push(() => server.close());

    for (const frame of [
      "not-json\n",
      `${JSON.stringify({ version: 1, type: "capability.get", requestId: REQUEST_ID, command: "/bin/sh" })}\n`,
      `${JSON.stringify({ version: 1, type: "capability.get", requestId: REQUEST_ID })}\n${JSON.stringify({ version: 1, type: "capability.get", requestId: REQUEST_ID })}\n`,
      `${"x".repeat(65 * 1024)}\n`,
    ]) {
      await expect(exchange(socketPath, frame)).resolves.toBe("");
    }
    expect(controller.handle).not.toHaveBeenCalled();
  });

  it("caps connections, times out stale clients, and drains on shutdown", async () => {
    const socketPath = await pathForSocket();
    const controller = { handle: vi.fn(async (request: ScopeRuntimeRequest) => response(request)), close: vi.fn() };
    const server = createScopeRuntimeServer({
      socketPath,
      controller,
      maxConnections: 1,
      requestTimeoutMs: 20,
    });
    await server.start();

    const first = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      first.once("connect", resolve);
      first.once("error", reject);
    });
    const second = createConnection({ path: socketPath });
    await new Promise<void>((resolve) => second.once("close", resolve));
    expect(server.connectionCount()).toBe(1);
    await new Promise<void>((resolve) => first.once("close", resolve));
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0));

    const third: Socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      third.once("connect", resolve);
      third.once("error", reject);
    });
    await server.close();
    expect(third.destroyed).toBe(true);
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("uses a separate bounded deadline after a complete frame is dispatched", async () => {
    const socketPath = await pathForSocket();
    const controller = {
      handle: vi.fn(async (request: ScopeRuntimeRequest) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return response(request);
      }),
      close: vi.fn(),
    };
    const server = createScopeRuntimeServer({
      socketPath,
      controller,
      requestTimeoutMs: 20,
      operationTimeoutMs: 100,
    });
    await server.start();
    cleanup.push(() => server.close());

    const output = await exchange(socketPath, `${JSON.stringify({
      version: 1,
      type: "capability.get",
      requestId: REQUEST_ID,
    })}\n`);

    expect(JSON.parse(output)).toEqual(expect.objectContaining({ requestId: REQUEST_ID }));
    expect(controller.handle).toHaveBeenCalledTimes(1);
  });
});
