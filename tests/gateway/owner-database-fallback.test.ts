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

  it("fences a collaboration runtime whose drain hangs, then still destroys dependencies", async () => {
    const warn = vi.fn();
    const order: string[] = [];
    const collaboration = {
      shutdown: vi.fn(() => new Promise<void>(() => {})),
      fence: vi.fn(() => { order.push("fence"); }),
    };
    const appDb = { destroy: vi.fn(async () => { order.push("pool"); }) };
    const chatRepository = { release: vi.fn(async () => { order.push("repository"); }) };
    await expect(teardownOwnerDatabaseServices({ collaboration, chatRepository, appDb }, {
      warn,
      collaborationDrainTimeoutMs: 20,
    })).resolves.toEqual(["collaborationFenced", "chatEventStream", "chatRepository", "canvasRepository", "appDb"]);
    expect(order).toEqual(["fence", "repository", "pool"]);
    expect(warn).toHaveBeenCalledWith("collaboration", expect.objectContaining({ message: "CollaborationDrainTimeout" }));
    expect(collaboration.fence).toHaveBeenCalledOnce();
  });

  it("fences a collaboration runtime whose drain throws and keeps going when the fence itself fails", async () => {
    const warn = vi.fn();
    const collaboration = {
      shutdown: vi.fn(async () => { throw new Error("drain failed"); }),
      fence: vi.fn(() => { throw new Error("fence failed"); }),
    };
    const appDb = { destroy: vi.fn(async () => undefined) };
    await expect(teardownOwnerDatabaseServices({ collaboration, appDb }, { warn }))
      .resolves.toEqual(["collaborationFenced", "chatEventStream", "chatRepository", "canvasRepository", "appDb"]);
    expect(appDb.destroy).toHaveBeenCalledOnce();
    expect(warn.mock.calls.map(([step]) => step)).toEqual(["collaboration", "collaborationFenced"]);
  });

  it("does not fence a runtime that drains within the bound", async () => {
    const collaboration = { shutdown: vi.fn(async () => undefined), fence: vi.fn() };
    await expect(teardownOwnerDatabaseServices({ collaboration }, { collaborationDrainTimeoutMs: 50 }))
      .resolves.toEqual(["collaboration", "chatEventStream", "chatRepository", "canvasRepository", "appDb"]);
    expect(collaboration.fence).not.toHaveBeenCalled();
  });

  it("closes the canvas hub and cancels cleanup before destroying its repository", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const sweep = vi.fn();
    const canvasCleanupTimer = setInterval(sweep, 1_000);
    try {
      await teardownOwnerDatabaseServices({
        canvasSubscriptionHub: { close: () => { order.push("hub"); } },
        canvasCleanupTimer,
        canvasRepository: { destroy: async () => { order.push("repository"); } },
        appDb: { destroy: async () => { order.push("pool"); } },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(order).toEqual(["hub", "repository", "pool"]);
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      clearInterval(canvasCleanupTimer);
      vi.useRealTimers();
    }
  });

  it("tolerates services that were never built", async () => {
    await expect(teardownOwnerDatabaseServices({})).resolves.toEqual([
      "collaboration", "chatEventStream", "chatRepository", "canvasRepository", "appDb",
    ]);
  });
});
