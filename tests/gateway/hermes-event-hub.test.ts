import { describe, expect, it, vi } from "vitest";
import { createHermesEventHub } from "../../packages/gateway/src/hermes/event-hub.js";

describe("Hermes event hub", () => {
  it("caps subscribers and closes the oldest entry", () => {
    const closeA = vi.fn();
    const hub = createHermesEventHub({ maxSubscribers: 2 });

    hub.subscribe({ id: "a", ownerId: "user_1", send: vi.fn(), close: closeA });
    hub.subscribe({ id: "b", ownerId: "user_1", send: vi.fn() });
    hub.subscribe({ id: "c", ownerId: "user_1", send: vi.fn() });

    expect(closeA).toHaveBeenCalledOnce();
    expect(hub.size()).toBe(2);
  });

  it("isolates failed sends and keeps retained events bounded", async () => {
    const failing = vi.fn(async () => {
      throw new Error("closed");
    });
    const closeFailing = vi.fn();
    const healthy = vi.fn();
    const hub = createHermesEventHub({ maxEvents: 1 });
    hub.subscribe({ id: "a", ownerId: "user_1", send: failing, close: closeFailing });
    hub.subscribe({ id: "b", ownerId: "user_1", send: healthy });

    await hub.publish("user_1", { type: "operator.event", payload: { message: "one" } });
    await hub.publish("user_1", { type: "operator.event", payload: { message: "two" } });

    expect(failing).toHaveBeenCalledOnce();
    expect(closeFailing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(hub.size()).toBe(1);
    expect(hub.retained("user_1")).toHaveLength(1);
  });

  it("continues failed-subscriber cleanup when close throws", async () => {
    const failingSend = vi.fn(async () => {
      throw new Error("send failed");
    });
    const throwingClose = vi.fn(async () => {
      throw new Error("close failed");
    });
    const laterClose = vi.fn();
    const hub = createHermesEventHub();
    hub.subscribe({ id: "a", ownerId: "user_1", send: failingSend, close: throwingClose });
    hub.subscribe({ id: "b", ownerId: "user_1", send: failingSend, close: laterClose });

    await expect(hub.publish("user_1", { type: "operator.event", payload: { message: "one" } })).resolves.toMatchObject({ type: "operator.event" });

    expect(throwingClose).toHaveBeenCalledOnce();
    expect(laterClose).toHaveBeenCalledOnce();
    expect(hub.size()).toBe(0);
  });

  it("caps retained owner buckets", async () => {
    const hub = createHermesEventHub({ maxEvents: 2, maxRetainedOwners: 1 });

    await hub.publish("user_1", { type: "operator.event", payload: { message: "one" } });
    await hub.publish("user_2", { type: "operator.event", payload: { message: "two" } });

    expect(hub.retained("user_1")).toEqual([]);
    expect(hub.retained("user_2")).toHaveLength(1);
  });
});
