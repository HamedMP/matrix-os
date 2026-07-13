import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PendingPersistQueue } from "../../packages/gateway/src/shell/output-pipeline.js";
import type { ScrollbackRecord } from "../../packages/gateway/src/shell/scrollback-store.js";

function outputRecord(seq: number, data: string): ScrollbackRecord {
  return { type: "output", seq, data };
}

describe("shell/output-pipeline PendingPersistQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStore() {
    const batches: ScrollbackRecord[][] = [];
    return {
      batches,
      append: vi.fn(async (_name: string, records: ScrollbackRecord[]) => {
        batches.push(records);
      }),
    };
  }

  it("coalesces enqueued records into one append per flush interval", async () => {
    const store = makeStore();
    const queue = new PendingPersistQueue({
      store,
      sessionName: "main",
      flushIntervalMs: 250,
      flushBytes: 64 * 1024,
      maxPendingBytes: 4 * 1024 * 1024,
    });

    queue.enqueue([outputRecord(0, "a")]);
    queue.enqueue([outputRecord(1, "b")]);
    queue.enqueue([outputRecord(2, "c")]);
    expect(store.append).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.batches[0]).toHaveLength(3);
    expect(store.batches[0]!.map((r) => r.seq)).toEqual([0, 1, 2]);
    await queue.dispose();
  });

  it("flushes early when the byte threshold is crossed", async () => {
    const store = makeStore();
    const queue = new PendingPersistQueue({
      store,
      sessionName: "main",
      flushIntervalMs: 60_000,
      flushBytes: 8,
      maxPendingBytes: 4 * 1024 * 1024,
    });

    queue.enqueue([outputRecord(0, "0123456789")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.append).toHaveBeenCalledTimes(1);
    await queue.dispose();
  });

  it("drops oldest pending data at the byte cap and reports the evicted seq range", async () => {
    const store = makeStore();
    const queue = new PendingPersistQueue({
      store,
      sessionName: "main",
      flushIntervalMs: 60_000,
      flushBytes: 1024 * 1024,
      maxPendingBytes: 30,
    });

    queue.enqueue([outputRecord(0, "x".repeat(20))]);
    queue.enqueue([outputRecord(1, "y".repeat(20))]);
    queue.enqueue([outputRecord(2, "z".repeat(20))]);

    // cap 30 bytes: seq 0 and 1 must have been dropped for persistence
    expect(queue.evictedThroughSeq).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.batches.flat().map((r) => r.seq)).toEqual([2]);
    await queue.dispose();
  });

  it("retries with backoff when the store fails and never throws", async () => {
    const append = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const queue = new PendingPersistQueue({
      store: { append },
      sessionName: "main",
      flushIntervalMs: 250,
      flushBytes: 64 * 1024,
      maxPendingBytes: 4 * 1024 * 1024,
    });

    queue.enqueue([outputRecord(0, "a")]);
    await vi.advanceTimersByTimeAsync(250);
    expect(append).toHaveBeenCalledTimes(1);

    // first retry is delayed by backoff (>= one interval), data retained
    await vi.advanceTimersByTimeAsync(2_000);
    expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(10_000);
    const lastBatch = append.mock.calls.at(-1)?.[1] as ScrollbackRecord[];
    expect(lastBatch.map((r) => r.seq)).toContain(0);
    expect(queue.pendingBytes).toBe(0);
    await queue.dispose();
  });

  it("dispose flushes remaining records", async () => {
    const store = makeStore();
    const queue = new PendingPersistQueue({
      store,
      sessionName: "main",
      flushIntervalMs: 60_000,
      flushBytes: 1024 * 1024,
      maxPendingBytes: 4 * 1024 * 1024,
    });

    queue.enqueue([outputRecord(0, "final")]);
    await queue.dispose();
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.batches[0]![0]!.seq).toBe(0);
  });

  it("tracks pendingBytes for telemetry", () => {
    const store = makeStore();
    const queue = new PendingPersistQueue({
      store,
      sessionName: "main",
      flushIntervalMs: 60_000,
      flushBytes: 1024 * 1024,
      maxPendingBytes: 4 * 1024 * 1024,
    });
    queue.enqueue([outputRecord(0, "abcde")]);
    expect(queue.pendingBytes).toBeGreaterThanOrEqual(5);
    void queue.dispose();
  });
});
