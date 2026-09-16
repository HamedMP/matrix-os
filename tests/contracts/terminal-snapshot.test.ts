import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { normalizeTerminalSnapshot } from "../../packages/contracts/src/terminal-snapshot.js";

describe("terminal screen snapshot", () => {
  it("restores multiline ANSI at column zero without retaining the old prompt", async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    try {
      // Queue old output too: reset must be ordered with writes, not synchronous clear().
      terminal.write("old prompt");
      await new Promise<void>((resolve) => terminal.write("\x1bc" + normalizeTerminalSnapshot("\x1b[31mTOP banner\nMID model\r\nLOW folder"), resolve));
      expect([0, 1, 2].map((row) => terminal.buffer.active.getLine(row)?.translateToString(true)))
        .toEqual(["TOP banner", "MID model", "LOW folder"]);
    } finally { terminal.dispose(); }
  });

  it("preserves existing CRLF and standalone carriage returns", () => {
    expect(normalizeTerminalSnapshot("a\r\nb\nc\rrewritten")).toBe("a\r\nb\r\nc\rrewritten");
  });
});
