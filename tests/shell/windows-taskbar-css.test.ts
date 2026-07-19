import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows taskbar CSS", () => {
  it("keeps broad Win11 search results inside a scrollable viewport", async () => {
    const source = await readFile("shell/src/components/taskbar/taskbar.css", "utf8");
    const gridRule = source.match(/\.win11-start-grid\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(gridRule).toContain("max-height: min(336px, 45vh)");
    expect(gridRule).toContain("overflow-y: auto");
    expect(gridRule).toContain("overscroll-behavior: contain");
  });

  it("keeps keyboard focus visible in the Win11 power flyout", async () => {
    const source = await readFile("shell/src/components/taskbar/taskbar.css", "utf8");
    const focusRule = source.match(/\.win11-power-flyout-item:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(focusRule).toContain("outline:");
    expect(focusRule).toContain("outline-offset:");
  });
});
