import { describe, expect, it, vi } from "vitest";
import { createOrderedRunControls } from "../../packages/gateway/src/chat/ordered-run-controls.js";
const owner = { type: "personal" as const, ownerId: "owner" };

describe("canonical run control admission", () => {
  it("orders different controls before their asynchronous repository work", async () => {
    const controls = createOrderedRunControls();
    let release!: () => void;
    const slowRead = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const answer = controls.wrap(async () => { seen.push("answer admission"); await slowRead; seen.push("answer delivery"); });
    const steer = controls.wrap(async () => { seen.push("steer admission"); seen.push("steer delivery"); });
    const a = answer(owner, "chat", "run");
    const s = steer(owner, "chat", "run");
    await vi.waitFor(() => expect(seen).toEqual(["answer admission"]));
    release(); await Promise.all([a, s]);
    expect(seen).toEqual(["answer admission", "answer delivery", "steer admission", "steer delivery"]);
    controls.close();
  });

  it("does not serialize independent Runs or poison the queue after a rejection", async () => {
    const controls = createOrderedRunControls();
    const fail = controls.wrap(async () => { throw new Error("admission failed"); });
    const success = controls.wrap(async () => "ok");
    let release!: () => void;
    const slow = controls.wrap(async () => await new Promise<void>(resolve => { release = resolve; }));
    const running = slow(owner, "chat", "run");
    await expect(success(owner, "chat", "other")).resolves.toBe("ok");
    const failure = expect(fail(owner, "chat", "run")).rejects.toThrow("admission failed");
    const later = success(owner, "chat", "run");
    release(); await running; await failure;
    await expect(later).resolves.toBe("ok");
    controls.close();
  });

  it("bounds pending controls and rejects queued operations at shutdown", async () => {
    const controls = createOrderedRunControls();
    let release!: () => void;
    const slow = controls.wrap(async () => await new Promise<void>(resolve => { release = resolve; }));
    const first = slow(owner, "chat", "run");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = Array.from({ length: 15 }, () => slow(owner, "chat", "run"));
    const settled = Promise.allSettled(queued);
    await expect(slow(owner, "chat", "run")).rejects.toThrow();
    controls.close();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    release(); await first;
    await expect(slow(owner, "chat", "run")).rejects.toThrow();
  });
});
