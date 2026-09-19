import { describe, expect, it } from "vitest";
import { terminalContentExtent } from "../../packages/ui/src/terminal/terminal-content-extent";
function terminal(lines: string[], cursorY = 0, cursorX = 0) {
  return { cols: 120, rows: 36, buffer: { active: { type: "normal", baseY: 0, viewportY: 0, cursorY, cursorX,
    getLine: (index: number) => ({ getCell: (column: number) => ({ getChars: () => lines[index]?.[column] ?? "", getWidth: () => 1, isBgDefault: () => true }) }) } } };
}
describe("terminal content extent", () => {
  it("omits unused rows and columns while retaining the cursor cell", () => {
    expect(terminalContentExtent(terminal(["prompt", "result", "prompt"], 2, 6))).toEqual({ cols: 7, rows: 3 });
  });
  it("retains long lines, blank rows before output, and full alternate-screen grids", () => {
    expect(terminalContentExtent(terminal(["", "", "x".repeat(100)]))).toEqual({ cols: 100, rows: 3 });
    const t = terminal([]); t.buffer.active.type = "alternate";
    expect(terminalContentExtent(t)).toEqual({ cols: 120, rows: 36 });
  });
  it("measures the visible history window and does not invent a cursor in history", () => {
    const t = terminal(["one", "two", "three"], 35, 119); t.buffer.active.baseY = 80;
    expect(terminalContentExtent(t)).toEqual({ cols: 5, rows: 3 });
  });
  it("preserves blank cells with a painted background", () => {
    const t = terminal([]);
    t.buffer.active.getLine = () => ({ getCell: (column: number) => ({ getChars: () => "", getWidth: () => 1, isBgDefault: () => column !== 99 }) });
    expect(terminalContentExtent(t)).toEqual({ cols: 100, rows: 36 });
  });
  it("retains a double-width glyph at the final used column", () => {
    const t = terminal([]);
    t.buffer.active.getLine = () => ({ getCell: (column: number) => ({
      getChars: () => column === 98 ? "界" : "", getWidth: () => column === 98 ? 2 : 1, isBgDefault: () => true,
    }) });
    expect(terminalContentExtent(t).cols).toBe(100);
  });

});
