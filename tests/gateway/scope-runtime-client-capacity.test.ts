import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { createScopeRuntimeClient } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import type { ScopeRuntimeRequest, ScopeRuntimeResponse } from "../../packages/scope-runtime/src/protocol.js";

const identity = { runtimeHandle: `runtime_${"2".repeat(32)}`, executionGeneration: "4" };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(maxConnections?: number) {
  const root = await createUnixSocketTempDir();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let enteredStops = 0;
  const controller = {
    async handle(request: ScopeRuntimeRequest): Promise<ScopeRuntimeResponse> {
      if (request.type === "runtime.stop" || (request.type === "runtime.bot" && request.command.kind === "bot.cancel")) enteredStops++;
      await gate;
      return request.type === "runtime.bot"
        ? { version: 1, type: "runtime.bot.result", requestId: request.requestId, ok: true, ...identity, reply: { acknowledged: true } }
        : { version: 1, type: "runtime.result", requestId: request.requestId, ok: true, ...identity, state: request.type === "runtime.stop" ? "stopped" : "running" };
    },
    async close() { release(); },
  };
  const socketPath = join(root, "supervisor.sock");
  const server = createScopeRuntimeServer({ socketPath, controller, maxConnections });
  await server.start();
  const client = createScopeRuntimeClient({ socketPath: join(root, "supervisor.sock"), profileCatalog: {} });
  cleanup.push(async () => { release(); await client.close(); await server.close(); });
  const run = (signal?: AbortSignal) => client.runBot({ ...identity, command: { version: 1, kind: "bot.run", runId: "run_capacity" }, signal });
  const renew = () => client.renewRuntime(identity);
  const stop = () => client.stopRuntime(identity);
  const cancel = () => client.runBot({ ...identity, command: { version: 1, kind: "bot.cancel", runId: "run_capacity" } });
  return { client, server, socketPath, release, run, renew, stop, cancel, enteredStops: () => enteredStops };
}

describe("scope runtime control capacity", () => {
  it("reclaims every busy request slot on caller abort without a worker reply or hard Stop", async () => {
    const test = await fixture();
    const controller = new AbortController();
    const pending = Array.from({ length: 32 }, () => test.run(controller.signal).catch(error => error));
    await vi.waitFor(() => expect(test.server.connectionCount()).toBe(32));
    await expect(test.run()).rejects.toMatchObject({ code: "client_capacity" });
    controller.abort();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ code: "runtime_unavailable" })));
    await vi.waitFor(() => expect(test.server.connectionCount()).toBe(0));
    expect(test.enteredStops()).toBe(0);
    const replacement = test.run();
    await vi.waitFor(() => expect(test.server.connectionCount()).toBe(1));
    test.release();
    await expect(replacement).resolves.toMatchObject({ ok: true });
  });

  it("holds 32 turns, 32 renewals and 32 cancels while preserving all 32 hard Stop slots", async () => {
    const test = await fixture();
    const work = Array.from({ length: 32 }, () => test.run().catch(error => error));
    const renewals = Array.from({ length: 32 }, () => test.renew().catch(error => error));
    const cancels = Array.from({ length: 32 }, () => test.cancel().catch(error => error));
    const stops = Array.from({ length: 32 }, () => test.stop().catch(error => error));
    await vi.waitFor(() => expect(test.enteredStops()).toBe(64), { timeout: 500 });
    test.release();
    await expect(Promise.all(stops)).resolves.toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ state: "stopped" })));
    await expect(Promise.all(work)).resolves.toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ ok: true })));
    await expect(Promise.all(renewals)).resolves.toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ state: "running" })));
    await expect(Promise.all(cancels)).resolves.toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ ok: true })));
  });

  it.each(["run", "renew", "stop", "cancel"] as const)("caps and releases the %s lane independently", async lane => {
    const test = await fixture();
    const pending = Array.from({ length: 32 }, () => test[lane]().catch(error => error));
    await expect(test[lane]()).rejects.toMatchObject({ code: "client_capacity" });
    if (lane === "run") {
      // Choosing an ordinary method/command cannot consume the reserved control lane.
      await expect(test.client.runBot({ ...identity, command: { version: 1, kind: "bot.steer", runId: "run_capacity", text: "continue" } }))
        .rejects.toMatchObject({ code: "client_capacity" });
    }
    test.release();
    await Promise.all(pending);
    await expect(test[lane]()).resolves.toBeDefined();
  });

  it("never lets cancellation occupy a hard Stop slot", async () => {
    const test = await fixture();
    const pending = Array.from({ length: 32 }, () => test.cancel().catch(error => error));
    await expect(test.cancel()).rejects.toMatchObject({ code: "client_capacity" });
    const hardStop = test.stop().catch(error => error);
    test.release();
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ ok: true })));
    await expect(hardStop).resolves.toMatchObject({ state: "stopped" });
  });

  it("never accepts more than 128 supervisor sockets even with an oversized option", async () => {
    const test = await fixture(1_000);
    const sockets: Socket[] = [];
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); });
    for (let index = 0; index < 128; index++) {
      const socket = createConnection({ path: test.socketPath });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    }
    expect(test.server.connectionCount()).toBe(128);
    const overflow = createConnection({ path: test.socketPath });
    sockets.push(overflow);
    await new Promise<void>(resolve => { overflow.once("close", () => resolve()); });
    expect(test.server.connectionCount()).toBe(128);
  });
});
