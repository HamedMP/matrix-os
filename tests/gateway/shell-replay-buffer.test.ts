import { describe, expect, it } from "vitest";
import { ShellReplayBuffer } from "../../packages/gateway/src/shell/replay-buffer.js";

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
});
