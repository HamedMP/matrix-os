import { describe, expect, it } from "vitest";
import { createSyncActivity } from "../../src/daemon/sync-activity.js";

describe("sync activity", () => {
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
});
