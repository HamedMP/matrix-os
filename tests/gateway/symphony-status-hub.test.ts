import { describe, expect, it, vi } from "vitest";
import { createSymphonyStatusHub } from "../../packages/gateway/src/symphony/status-hub.js";

describe("Symphony status hub", () => {
  it("caps subscribers and evicts stale entries", () => {
    let now = 1_000;
    const hub = createSymphonyStatusHub({ maxSubscribers: 2, subscriberTtlMs: 100, now: () => now });

    expect(hub.subscribe({ id: "a", ownerId: "user_1", send: vi.fn() })).toEqual({ ok: true });
    expect(hub.subscribe({ id: "b", ownerId: "user_1", send: vi.fn() })).toEqual({ ok: true });
    expect(hub.subscribe({ id: "c", ownerId: "user_1", send: vi.fn() })).toEqual({ ok: false, code: "subscriber_limit" });

    now = 1_200;
    expect(hub.subscribe({ id: "c", ownerId: "user_1", send: vi.fn() })).toEqual({ ok: true });
    expect(hub.size()).toBe(1);
  });

  it("isolates failed subscriber sends and keeps delivering", async () => {
    const failing = vi.fn(async () => {
      throw new Error("closed");
    });
    const healthy = vi.fn();
    const hub = createSymphonyStatusHub();
    hub.subscribe({ id: "a", ownerId: "user_1", send: failing });
    hub.subscribe({ id: "b", ownerId: "user_1", send: healthy });

    await hub.publishOperatorEvent("user_1", {
      id: "evt_1",
      installationId: "sym_user_1",
      type: "symphony.run.updated",
      message: "running",
      severity: "info",
      createdAt: "2026-05-13T00:00:00.000Z",
    });

    expect(failing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(hub.size()).toBe(1);
  });

  it("keeps quiet touched subscribers alive for the next event", async () => {
    let now = 1_000;
    const send = vi.fn();
    const hub = createSymphonyStatusHub({ subscriberTtlMs: 100, now: () => now });
    hub.subscribe({ id: "a", ownerId: "user_1", send });

    now = 1_080;
    expect(hub.touch("a")).toBe(true);
    now = 1_160;

    await hub.publishOperatorEvent("user_1", {
      id: "evt_1",
      installationId: "sym_user_1",
      type: "symphony.run.updated",
      message: "running",
      severity: "info",
      createdAt: "2026-05-13T00:00:00.000Z",
    });

    expect(send).toHaveBeenCalledOnce();
  });

  it("drains subscribers on close", async () => {
    const close = vi.fn();
    const hub = createSymphonyStatusHub();
    hub.subscribe({ id: "a", ownerId: "user_1", send: vi.fn(), close });

    await hub.close();

    expect(close).toHaveBeenCalledOnce();
    expect(hub.size()).toBe(0);
  });
});
