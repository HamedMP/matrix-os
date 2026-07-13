import { describe, expect, it } from "vitest";
import { ShellReplayBuffer } from "../../packages/gateway/src/shell/replay-buffer.js";
import type { ScrollbackStore } from "../../packages/gateway/src/shell/scrollback-store.js";

describe("shell replay buffer", () => {
  it("assigns monotonically increasing output sequence numbers", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 100 });

    expect(replay.write("one")).toEqual({ seq: 0, stored: true });
    expect(replay.write("two")).toEqual({ seq: 1, stored: true });
    expect(replay.lastSeq).toBe(1);
  });

  it("returns replay start, available output, and replay end markers", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 100 });
    replay.write("one");
    replay.write("two");

    expect(replay.replayFrom(0)).toEqual([
      { type: "replay-start", fromSeq: 0 },
      { type: "output", seq: 0, data: "one" },
      { type: "output", seq: 1, data: "two" },
      { type: "replay-end", toSeq: 1 },
    ]);
  });

  it("emits an eviction marker when requested output is no longer available", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 6 });
    replay.write("aaa");
    replay.write("bbb");
    replay.write("ccc");

    expect(replay.replayFrom(0)[1]).toEqual({
      type: "replay-evicted",
      fromSeq: 0,
      nextSeq: 1,
    });
  });

  it("does not store oversized chunks", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 2 });

    expect(replay.write("toolong")).toEqual({ seq: null, stored: false });
    expect(replay.replayFrom(0)).toEqual([
      { type: "replay-start", fromSeq: 0 },
      { type: "replay-end", toSeq: null },
    ]);
  });

  it("preserves sixel bytes in replay output", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 4096 });
    const sixel = "\x1bPq#0;2;0;0;0#1;2;100;100;100!10~\x1b\\";

    replay.write(sixel);

    expect(replay.replayFrom(0)).toContainEqual({ type: "output", seq: 0, data: sixel });
  });

  it("preserves iTerm2 inline image bytes in replay output", () => {
    const replay = new ShellReplayBuffer({ maxBytes: 4096 });
    const image = "\x1b]1337;File=name=dGVzdC5wbmc=;inline=1:aW1hZ2U=\x07";

    replay.write(image);

    expect(replay.replayFrom(0)).toContainEqual({ type: "output", seq: 0, data: image });
  });

  it("writeLive assigns the seq synchronously and returns persistable records", async () => {
    const appended: Array<{ type: string; seq: number }> = [];
    const store = {
      latestSeq: async () => null,
      append: async (_name: string, records: Array<{ type: string; seq: number }>) => {
        appended.push(...records);
      },
    } as unknown as ScrollbackStore;
    const replay = new ShellReplayBuffer({
      maxBytes: 4096,
      scrollbackStore: store,
      sessionName: "main",
    });
    await replay.ensureSeeded();

    const result = replay.writeLive("hello \x1b]133;A\x07world");
    expect(result.seq).toBe(0);
    expect(result.records[0]).toMatchObject({ type: "output", seq: 0 });
    expect(result.records.some((r) => r.type === "block-mark")).toBe(true);
    expect(replay.lastSeq).toBe(0);
  });

  it("writeLive persists a durable seq reservation ahead of assignment", async () => {
    const appended: Array<{ type: string; seq: number }> = [];
    const store = {
      latestSeq: async () => null,
      append: async (_name: string, records: Array<{ type: string; seq: number }>) => {
        appended.push(...records);
      },
    } as unknown as ScrollbackStore;
    const replay = new ShellReplayBuffer({
      maxBytes: 4096,
      scrollbackStore: store,
      sessionName: "main",
      reserveWindow: 100,
    });
    await replay.ensureSeeded();

    replay.writeLive("one");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reservation = appended.find((r) => r.type === "seq-reserve");
    expect(reservation).toBeDefined();
    expect(reservation!.seq).toBeGreaterThanOrEqual(100);
  });

  it("retries a failed seq reservation on a timer even when output stops", async () => {
    vi.useFakeTimers();
    try {
      const reserves: number[] = [];
      let failFirst = true;
      const store = {
        latestSeq: async () => null,
        append: async (_name: string, records: Array<{ type: string; seq: number }>) => {
          const reserve = records.find((r) => r.type === "seq-reserve");
          if (reserve) {
            if (failFirst) {
              failFirst = false;
              throw new Error("disk full");
            }
            reserves.push(reserve.seq);
          }
        },
      } as unknown as ScrollbackStore;
      const replay = new ShellReplayBuffer({
        maxBytes: 4096,
        scrollbackStore: store,
        sessionName: "main",
        reserveWindow: 100,
      });
      await replay.ensureSeeded();

      replay.writeLive("one");
      await vi.advanceTimersByTimeAsync(0);
      expect(reserves).toEqual([]); // first attempt failed

      await vi.advanceTimersByTimeAsync(1_100); // retry timer, no new output
      expect(reserves.length).toBe(1);
      expect(reserves[0]).toBeGreaterThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds numbering above a persisted reservation so delivered seqs are never reused", async () => {
    const store = {
      // scrollback holds outputs up to seq 5 plus a reservation through 10000
      latestSeq: async () => 10_000,
      append: async () => undefined,
    } as unknown as ScrollbackStore;
    const replay = new ShellReplayBuffer({
      maxBytes: 4096,
      scrollbackStore: store,
      sessionName: "main",
    });
    await replay.ensureSeeded();

    expect(replay.writeLive("after-restart").seq).toBe(10_001);
  });

  it("serializes persistent writes for a session", async () => {
    const events: string[] = [];
    let releaseFirstAppend: (() => void) | null = null;
    const store = {
      latestSeq: async () => null,
      readSince: async () => [],
      append: async (_name: string, records: Array<{ seq: number }>) => {
        events.push(`start:${records[0]!.seq}`);
        if (records[0]!.seq === 0) {
          await new Promise<void>((resolve) => {
            releaseFirstAppend = resolve;
          });
        }
        events.push(`end:${records[0]!.seq}`);
      },
      cleanup: async () => undefined,
      pathForSession: () => "",
    } as unknown as ScrollbackStore;
    const replay = new ShellReplayBuffer({
      maxBytes: 4096,
      scrollbackStore: store,
      sessionName: "main",
    });

    const first = replay.writePersistent("one");
    const second = replay.writePersistent("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start:0"]);

    releaseFirstAppend?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { seq: 0, stored: true },
      { seq: 1, stored: true },
    ]);
    expect(events).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  });
});
