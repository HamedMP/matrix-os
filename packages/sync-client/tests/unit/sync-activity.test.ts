import { describe, expect, it } from "vitest";
import { createSyncActivity } from "../../src/daemon/sync-activity.js";

describe("sync activity", () => {
  it("clears an operation failure only when that operation successfully retries", async () => {
    const activity = createSyncActivity();
    await expect(activity.run("startup", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(activity.pendingFailureCount()).toBe(1);
    await activity.run("startup", async () => {});
    expect(activity.pendingFailureCount()).toBe(0);
    expect(activity.activeTransferCount()).toBe(0);
  });
  it("keeps bounded real activity records", () => {
    const activity = createSyncActivity();
    for (let i = 0; i < 200; i++) activity.record(String(i), "update", "peer");
    expect(activity.recent()).toHaveLength(100);
    expect(activity.recent()[0]).toMatchObject({ path: "199", action: "update", peerId: "peer" });
  });
  it("counts queued and active work until completion", async () => {
    const activity = createSyncActivity();
    const done = activity.begin();
    expect(activity.activeTransferCount()).toBe(1);
    done();
    expect(activity.activeTransferCount()).toBe(0);
  });
  it("retains errors until that same path succeeds", () => {
    const activity = createSyncActivity();
    activity.failed("a");
    activity.succeeded("b");
    expect(activity.pendingFailureCount()).toBe(1);
    activity.succeeded("a");
    expect(activity.pendingFailureCount()).toBe(0);
  });
  it("bounds the failure registry without falsely claiming full recovery", () => {
    const activity = createSyncActivity();
    for (let i = 0; i < 2000; i++) activity.failed(String(i));
    expect(activity.pendingFailureCount()).toBe(1001);
  });
  it("evicts the oldest failure while keeping newer failures recoverable", () => {
    const activity = createSyncActivity();
    for (let i = 0; i < 1001; i++) activity.failed(String(i));
    activity.succeeded("0");
    expect(activity.pendingFailureCount()).toBe(1001);
    activity.succeeded("1000");
    expect(activity.pendingFailureCount()).toBe(1000);
  });
});
