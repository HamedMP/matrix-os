import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

// Keep source contracts together to avoid a worker/module setup per small suite.
describe("design-tooltip-css", () => {
  const globalsCss = readFileSync("shell/src/app/globals.css", "utf8");

  describe("OS design tooltip contrast", () => {
    it("uses readable foreground text and a matching arrow on macOS glass tooltips", () => {
      expect(globalsCss).toMatch(
        /\[data-theme-style="macos-glass"\] \[data-slot="tooltip-content"\]\s*\{[^}]*color:\s*var\(--foreground\)/s,
      );
      expect(globalsCss).toMatch(
        /\[data-theme-style="macos-glass"\] \[data-slot="tooltip-content"\] > svg\s*\{[^}]*background:\s*var\(--glass-surface-strong\)[^}]*fill:\s*var\(--glass-surface-strong\)/s,
      );
    });
  });
});

describe("windows-taskbar-css", () => {
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
});
