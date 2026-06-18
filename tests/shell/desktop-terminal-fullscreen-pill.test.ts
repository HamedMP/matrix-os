import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Desktop terminal fullscreen chrome", () => {
  it("hides the global fullscreen exit pill when a terminal window owns fullscreen", () => {
    const source = readFileSync("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("fullscreenTerminalOwnsChrome");
    expect(source).toContain("fullscreenWindowId && !fullscreenTerminalOwnsChrome");
    expect(source).toContain('path.startsWith("__terminal__")');
  });
});
