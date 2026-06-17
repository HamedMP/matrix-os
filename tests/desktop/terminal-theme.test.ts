import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_THEME_ID,
  type TerminalFontFamily,
  type TerminalThemeId,
} from "../../desktop/src/renderer/src/lib/terminal/terminal-settings-types";
import { buildTerminalFontStack } from "../../desktop/src/renderer/src/lib/terminal/terminal-fonts";
import {
  getAnsiPalette,
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
  it("exposes the system option and the default concrete theme", () => {
    const ids = TERMINAL_THEME_OPTIONS.map((option) => option.id);

    expect(ids[0]).toBe("system");
    expect(ids).toContain(DEFAULT_TERMINAL_THEME_ID);
  });

  it("returns a complete ANSI palette for every concrete theme option", () => {
    for (const option of TERMINAL_THEME_OPTIONS) {
      if (option.id === "system") continue;
      const preset = getTerminalThemePreset(option.id);

      for (const key of REQUIRED_ANSI_KEYS) {
        expect(preset[key]).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(preset.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.foreground).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("maps known shell theme slugs and falls back by background luminance", () => {
    expect(getAnsiPalette("catppuccin", "#000000").brightWhite).toBe("#cdd6f4");
    expect(getAnsiPalette("missing-theme", "#101010").black).toBe("#282c34");
    expect(getAnsiPalette("missing-theme", "#ffffff").black).toBe("#383a42");
  });

  it("maps desktop-native theme ids without falling back by luminance", () => {
    expect(getAnsiPalette("one-dark", "#ffffff").black).toBe("#282c34");
    expect(getAnsiPalette("one-light", "#101010").black).toBe("#383a42");
    expect(getAnsiPalette("catppuccin-mocha", "#101010").brightWhite).toBe("#cdd6f4");
  });

  it("keeps solarized-light ANSI black distinct from white", () => {
    const palette = getTerminalThemePreset("solarized-light");

    expect(palette.black).toBe("#073642");
    expect(palette.black).not.toBe(palette.white);
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

    expect(ids).toContain("system");
    expect(ids).toContain("github-light");
  });
});
