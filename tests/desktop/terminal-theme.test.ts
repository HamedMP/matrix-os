import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_THEME_ID,
  type TerminalFontFamily,
  type TerminalThemeId,
} from "../../desktop/src/renderer/src/lib/terminal/terminal-settings-types";
import { buildTerminalFontStack } from "../../desktop/src/renderer/src/lib/terminal/terminal-fonts";
import {
  getTerminalThemePreset,
  TERMINAL_THEME_OPTIONS,
} from "../../desktop/src/renderer/src/lib/terminal/terminal-themes";

const REQUIRED_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("terminal theme presets", () => {
  it("keeps the existing Light, Matrix OS Dark, and Matrix shell choices", () => {
    const ids = TERMINAL_THEME_OPTIONS.map((option) => option.id);

    expect(ids.slice(0, 3)).toEqual(["light", "matrix-dark", "matrix"]);
    expect(ids).toContain(DEFAULT_TERMINAL_THEME_ID);
  });

  it("offers palettes inspired by every official Powerlevel10k prompt style family", () => {
    expect(TERMINAL_THEME_OPTIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "powerlevel10k-lean", label: "P10k Lean" }),
      expect.objectContaining({ id: "powerlevel10k-lean-8-colors", label: "P10k Lean · 8 colors" }),
      expect.objectContaining({ id: "powerlevel10k-classic", label: "P10k Classic" }),
      expect.objectContaining({ id: "powerlevel10k-rainbow", label: "P10k Rainbow" }),
      expect.objectContaining({ id: "powerlevel10k-pure", label: "P10k Pure" }),
    ]));
  });

  it("returns a complete ANSI palette for every concrete theme option", () => {
    for (const option of TERMINAL_THEME_OPTIONS) {
      const preset = getTerminalThemePreset(option.id);

      for (const key of REQUIRED_ANSI_KEYS) {
        expect(preset[key]).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(preset.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.foreground).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

});

describe("terminal font stacks", () => {
  it("keeps the selected terminal font first and preserves Nerd Font fallback", () => {
    const stack = buildTerminalFontStack("JetBrains Mono" satisfies TerminalFontFamily, "var(--mono)");

    expect(stack.startsWith('"JetBrains Mono"')).toBe(true);
    expect(stack).toContain('"Symbols Nerd Font Mono"');
    expect(stack).toContain("var(--mono)");
  });

  it("accepts every terminal theme id in option output", () => {
    const ids: TerminalThemeId[] = TERMINAL_THEME_OPTIONS.map((option) => option.id);

    expect(ids).toContain("matrix-dark");
    expect(ids).toContain("powerlevel10k-rainbow");
  });
});
