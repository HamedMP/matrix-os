import { describe, expect, it } from "vitest";
import { ShellReplayBuffer } from "../../packages/gateway/src/shell/replay-buffer.js";

describe("terminal image protocol passthrough", () => {
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
});
