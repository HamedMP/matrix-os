import { describe, it, expect } from "vitest";

interface LayoutWindow {
  path: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "open" | "minimized" | "closed";
}

/**
 * Extracts terminal windows from saved layout.
 * This is the logic we're fixing in Desktop.tsx.
 */
function getTerminalWindows(savedWindows: LayoutWindow[]): LayoutWindow[] {
  return savedWindows.filter((w) => w.path.startsWith("__terminal__"));
}

describe("Terminal window restoration", () => {
  it("matches single terminal with exact __terminal__ path", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(1);
  });

  it("matches terminal with unique suffix path", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__:1712345678-a3bc", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(1);
  });

  it("matches multiple terminal instances", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__:1712345678-a3bc", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
      { path: "__terminal__:claude-1712345679", title: "Claude Code", x: 100, y: 100, width: 800, height: 600, state: "open" },
      { path: "apps/notes.html", title: "Notes", x: 200, y: 200, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(2);
  });

  it("returns empty array when no terminals in layout", () => {
    const saved: LayoutWindow[] = [
      { path: "apps/notes.html", title: "Notes", x: 0, y: 0, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(0);
  });

  it("does not match paths that contain terminal but don't start with __terminal__", () => {
    const saved: LayoutWindow[] = [
      { path: "apps/terminal-emulator.html", title: "Term Emu", x: 0, y: 0, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(0);
  });
});
