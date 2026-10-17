import { afterEach, expect, it, vi } from "vitest";
import type { SharedBrowserAction, SharedBrowserActionResult } from "@matrix-os/contracts";
import { createSharedBrowserBroker, type SharedBrowserBinding } from "../../packages/gateway/src/shared-browser/broker.js";

const binding: SharedBrowserBinding = { ownerId: "owner", chatId: "chat", runId: "run", harness: "codex" };
const brokers: ReturnType<typeof createSharedBrowserBroker>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(brokers.splice(0).map(broker => broker.close())); });
interface Policy { mode: "supervised"; authorizeAction(request: { binding: SharedBrowserBinding; action: SharedBrowserAction; signal: AbortSignal }): Promise<void> }
function setup(authorizeAction: Policy["authorizeAction"]) {
  const driver = { execute: vi.fn(async (): Promise<SharedBrowserActionResult> => ({ success: true, observationId: "fresh" })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
  const broker = createSharedBrowserBroker({ ownerId: "owner", driver, setHumanControl: async () => {} });
  brokers.push(broker);
  const open = broker.openRun as (binding: SharedBrowserBinding, signal: AbortSignal, policy: Policy) => ReturnType<typeof broker.openRun>;
  const controller = new AbortController();
  const policy: Policy = { mode: "supervised", authorizeAction };
  const lease = open(binding, controller.signal, policy);
  return { broker, driver, controller, lease, policy };
}
it("a direct bearer cannot bypass a denied server-created supervised policy", async () => {
  const authorize = vi.fn(async () => { throw new Error("Owner declined"); });
  const s = setup(authorize);
  await expect(s.broker.execute(s.broker.resolveCapability(s.lease.token)!, { action: "snapshot" }, s.controller.signal)).rejects.toThrow();
  expect(authorize).toHaveBeenCalledOnce(); expect(s.driver.execute).not.toHaveBeenCalled();
});
it("an expired owner prompt leaves Chrome usable for a fresh request", async () => {
  const expiry = new AbortController(); const original = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 5 * 60_000 ? expiry.signal : original(ms));
  let entered!: () => void; const asking = new Promise<void>(yes => { entered = yes; }); let calls = 0;
  const s = setup(async () => { if (++calls === 1) { entered(); await new Promise<void>(() => {}); } });
  const pending = s.broker.execute(binding, { action: "snapshot" }, s.controller.signal).catch(error => error);
  await asking; expiry.abort(new DOMException("Expired", "TimeoutError"));
  expect(await pending).toHaveProperty("code", "browser_changed");
  expect(s.broker.status().phase).toBe("agent"); expect(s.driver.execute).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await expect(s.broker.execute(binding, { action: "snapshot" }, s.controller.signal)).resolves.toMatchObject({ success: true });
});
it("captures the policy at registration and never exposes mutable authority or action arguments", async () => {
  const authorize = vi.fn<Policy["authorizeAction"]>(async request => {
    expect(Object.isFrozen(request.binding)).toBe(true); expect(Object.isFrozen(request.action)).toBe(true);
    expect(request.binding).toEqual(binding); expect(request.action).toEqual({ action: "snapshot" });
  });
  const s = setup(authorize); s.policy.authorizeAction = async () => { throw new Error("Replaced"); };
  expect(await s.broker.execute(binding, { action: "snapshot" }, s.controller.signal)).toMatchObject({ success: true });
  expect(authorize).toHaveBeenCalledOnce(); expect(s.driver.execute).toHaveBeenCalledOnce();
});
it("Stop cancels a pending decision even if its callback never cooperates", async () => {
  let entered!: () => void; const asking = new Promise<void>(resolve => { entered = resolve; });
  const s = setup(async () => { entered(); await new Promise<void>(() => {}); });
  const result = s.broker.execute(binding, { action: "snapshot" }, s.controller.signal).catch(error => error);
  await asking; await s.broker.control("owner", { action: "stop" });
  expect(await result).toHaveProperty("code", "browser_changed");
  expect(s.driver.execute).not.toHaveBeenCalled(); expect(s.broker.resolveCapability(s.lease.token)).toBeNull();
});
it("a temporary approval-service failure leaves Chrome usable for the next request", async () => {
  const authorize = vi.fn<Policy["authorizeAction"]>().mockRejectedValueOnce(new Error("Database temporarily unavailable")).mockResolvedValue(undefined);
  const s = setup(authorize);
  await expect(s.broker.execute(binding, { action: "snapshot" }, s.controller.signal)).rejects.toHaveProperty("code", "browser_changed");
  expect(s.driver.execute).not.toHaveBeenCalled(); expect(s.broker.status().phase).toBe("agent");
  await expect(s.broker.execute(binding, { action: "snapshot" }, s.controller.signal)).resolves.toMatchObject({ success: true });
});
it("still marks an actual driver failure unavailable after authorization succeeds", async () => {
  const s = setup(async () => {}); s.driver.execute.mockRejectedValueOnce(new Error("Driver failed"));
  await expect(s.broker.execute(binding, { action: "snapshot" }, s.controller.signal)).rejects.toHaveProperty("code", "browser_unavailable");
  expect(s.broker.status().phase).toBe("unavailable");
});
