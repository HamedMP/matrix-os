import { describe, expect, it, vi } from "vitest";
import { teardownOwnerDatabaseServices } from "../../packages/gateway/src/startup/owner-database-fallback.js";

describe("owner database fallback teardown (S20 / T099)", () => {
  it("stops the Chat event stream before releasing its repository and destroys the pool last", async () => {
    const order: string[] = [];
    const services = {
      collaboration: { shutdown: vi.fn(async () => { order.push("collaboration"); }) },
      chatEventStream: { shutdown: vi.fn(() => { order.push("stream"); }) },
      chatRepository: { release: vi.fn(async () => { order.push("repository"); }) },
      canvasRepository: { destroy: vi.fn(async () => { order.push("canvas"); }) },
      appDb: { destroy: vi.fn(async () => { order.push("pool"); }) },
    };
    await expect(teardownOwnerDatabaseServices(services)).resolves.toEqual([
      "collaboration", "chatEventStream", "chatRepository", "canvasRepository", "appDb",
    ]);
    expect(order).toEqual(["collaboration", "stream", "repository", "canvas", "pool"]);
  });

  it("isolates a failing step, keeps tearing down the rest and still destroys the pool", async () => {
    const warn = vi.fn();
    const appDb = { destroy: vi.fn(async () => undefined) };
    const chatRepository = { release: vi.fn(async () => { throw new Error("release failed: password=secret"); }) };
    await expect(teardownOwnerDatabaseServices({
      chatEventStream: { shutdown: () => { throw new Error("stream already closed"); } },
      chatRepository,
      appDb,
    }, { warn })).resolves.toEqual(["collaboration", "canvasRepository", "appDb"]);
    expect(appDb.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([step]) => step)).toEqual(["chatEventStream", "chatRepository"]);
  });

  it("tolerates services that were never built", async () => {
    await expect(teardownOwnerDatabaseServices({})).resolves.toEqual([
      "collaboration", "chatEventStream", "chatRepository", "canvasRepository", "appDb",
    ]);
  });
});
