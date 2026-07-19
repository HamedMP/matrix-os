import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
