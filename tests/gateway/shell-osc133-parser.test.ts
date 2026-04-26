import { describe, expect, it } from "vitest";
import { Osc133Parser } from "../../packages/gateway/src/shell/osc133.js";

describe("OSC 133 parser", () => {
  it("detects semantic marks A/B/C/D and preserves bytes", () => {
    const parser = new Osc133Parser();
    const data = "\x1b]133;A\x07$ echo hi\r\n\x1b]133;B\x07echo hi\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07";

    const result = parser.write(data);

    expect(result.data).toBe(data);
    expect(result.marks).toEqual([
      { code: "A", kind: "prompt-start" },
      { code: "B", kind: "command-start" },
      { code: "C", kind: "command-executed" },
      { code: "D", kind: "command-finished", exitCode: 0 },
    ]);
  });

  it("reassembles partial chunks across writes", () => {
    const parser = new Osc133Parser();

    expect(parser.write("\x1b]133;").marks).toEqual([]);
    expect(parser.write("D;7").marks).toEqual([]);
    expect(parser.write("\x1b\\").marks).toEqual([
      { code: "D", kind: "command-finished", exitCode: 7 },
    ]);
  });

  it("ignores malformed sequences safely", () => {
    const parser = new Osc133Parser();

    expect(parser.write("\x1b]133;Z\x07still here").marks).toEqual([]);
    expect(parser.write("plain text").data).toBe("plain text");
  });

  it("bounds pending partial data", () => {
    const parser = new Osc133Parser({ maxPendingBytes: 8 });

    parser.write("\x1b]133;D");
    expect(parser.write(";0 but never terminated").marks).toEqual([]);
    expect(parser.pendingBytes).toBeLessThanOrEqual(8);
  });
});
