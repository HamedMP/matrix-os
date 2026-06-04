import { describe, expect, it } from "vitest";
import { buildTerminalFontStack } from "../../shell/src/components/terminal/terminal-fonts.js";

describe("terminal font stacks", () => {
  it("uses MesloLGS NF as the default selectable terminal font", () => {
    expect(buildTerminalFontStack("MesloLGS NF", undefined)).toContain('"MesloLGS NF"');
  });

  it("keeps MesloLGS NF as a glyph fallback for every selectable terminal font", () => {
    expect(buildTerminalFontStack("JetBrains Mono", "JetBrains Mono, monospace")).toBe(
      '"JetBrains Mono", "MesloLGS NF", JetBrains Mono, monospace, "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    );
  });

  it("does not duplicate MesloLGS NF when Meslo is selected", () => {
    expect(buildTerminalFontStack("MesloLGS NF", undefined)).toBe(
      '"MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    );
  });
});
