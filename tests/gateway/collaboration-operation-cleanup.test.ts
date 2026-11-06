import { describe, expect, it, vi } from "vitest";
import { BoundedOperationCleanupScheduler } from "../../packages/gateway/src/collaboration/repository-shared.js";

describe("collaboration operation cleanup scheduling", () => {
  it("reserves database capacity by starting at most four cleanup transactions", async () => {
    const scheduler = new BoundedOperationCleanupScheduler(4, 16);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const tasks = Array.from({ length: 5 }, (_, index) => {
      const key = `cleanup-${index}`;
      return scheduler.run(key, async () => {
        started.push(key);
        await new Promise<void>((resolve) => releases.push(resolve));
      });
    });

    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started).toEqual(["cleanup-0", "cleanup-1", "cleanup-2", "cleanup-3"]);
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    for (const release of releases.splice(0)) release();
    await expect(Promise.all(tasks)).resolves.toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("joins the same cleanup without consuming another concurrency slot", async () => {
    const scheduler = new BoundedOperationCleanupScheduler(1, 2);
    let release!: () => void;
    const task = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));

    const first = scheduler.run("same", task);
    const replay = scheduler.run("same", task);
    expect(replay).toBe(first);
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([first, replay])).resolves.toEqual([undefined, undefined]);
  });
});
