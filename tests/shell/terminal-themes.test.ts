import { describe, it, expect } from "vitest";
import {
  buildXtermTheme,
  getAnsiPalette,
  getTerminalMinimumContrastRatio,
  getTerminalThemePreset,
  TERMINAL_THEME_OPTIONS,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  type AnsiPalette,
} from "../../shell/src/components/terminal/terminal-themes.js";
import type { Theme } from "../../shell/src/hooks/useTheme.js";

const ANSI_KEYS: (keyof AnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function assertCompleteAnsiPalette(palette: AnsiPalette) {
  for (const key of ANSI_KEYS) {
    expect(palette[key]).toBeDefined();
    expect(palette[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Terminal Themes", () => {
  it("offers the three existing shell themes followed by Powerlevel10k palettes", () => {
    expect(TERMINAL_THEME_OPTIONS).toEqual([
      { id: "light", label: "Light" },
      { id: "dark", label: "Matrix OS Dark" },
      { id: "matrix", label: "Matrix" },
      { id: "powerlevel10k-lean", label: "P10k Lean" },
      { id: "powerlevel10k-lean-8-colors", label: "P10k Lean · 8 colors" },
      { id: "powerlevel10k-classic", label: "P10k Classic" },
      { id: "powerlevel10k-rainbow", label: "P10k Rainbow" },
      { id: "powerlevel10k-pure", label: "P10k Pure" },
    ]);
    for (const option of TERMINAL_THEME_OPTIONS) {
      assertCompleteAnsiPalette(getTerminalThemePreset(option.id));
    }
  });

  it("uses the original dark shell theme as the default terminal palette", () => {
    const preset = getTerminalThemePreset("dark");

    expect(preset).toMatchObject({
      label: "Matrix OS Dark",
      background: "#0C0C0C",
      foreground: "#BFBFBF",
      cursor: "#0AD18B",
      selectionBackground: "#00E5C033",
      cyan: "#00E5C0",
      blue: "#6AA0FF",
    });
    assertCompleteAnsiPalette(preset);
  });

  it("uses the Paper Light shell theme colors", () => {
    const preset = getTerminalThemePreset("light");

    expect(preset).toMatchObject({
      label: "Light",
      background: "#FBF1C7",
      foreground: "#3C3836",
      cursor: "#79740E",
      blue: "#458588",
      black: "#282828",
    });
    expect(preset.black).not.toBe(preset.background);
    expect(contrastRatio(preset.black, preset.background)).toBeGreaterThanOrEqual(4.5);
    assertCompleteAnsiPalette(preset);
  });

  it("protects every standard and bright ANSI foreground in every light preset", () => {
    const lightThemes: Array<Theme & { slug: string }> = [
      {
        name: "One Light",
        slug: "default-light",
        mode: "light",
        colors: { background: "#fafafa", foreground: "#383a42", primary: "#4078f2" },
        fonts: {},
        radius: "8px",
      },
      {
        name: "Solarized Light",
        slug: "solarized-light",
        mode: "light",
        colors: { background: "#fdf6e3", foreground: "#657b83", primary: "#268bd2" },
        fonts: {},
        radius: "8px",
      },
      {
        name: "GitHub Light",
        slug: "github-light",
        mode: "light",
        colors: { background: "#ffffff", foreground: "#24292f", primary: "#0969da" },
        fonts: {},
        radius: "8px",
      },
    ];
    const themes = [getTerminalThemePreset("light"), ...lightThemes.map((theme) => buildXtermTheme(theme, "system"))];

    for (const theme of themes) {
      const enforcedRatio = getTerminalMinimumContrastRatio(theme);
      expect(enforcedRatio).toBe(TERMINAL_MINIMUM_CONTRAST_RATIO);
      for (const key of ANSI_KEYS) {
        expect(Math.max(contrastRatio(theme[key], theme.background), enforcedRatio)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("leaves dark terminal rendering at xterm's default contrast behavior", () => {
    expect(getTerminalMinimumContrastRatio(getTerminalThemePreset("dark"))).toBe(1);
    expect(getTerminalMinimumContrastRatio(getTerminalThemePreset("matrix"))).toBe(1);
  });

  it("uses the Paper Matrix shell theme colors", () => {
    const preset = getTerminalThemePreset("matrix");

    expect(preset).toMatchObject({
      label: "Matrix",
      background: "#020A02",
      foreground: "#2FBF55",
      cursor: "#39FF6A",
      green: "#2FBF55",
      brightGreen: "#39FF6A",
    });
    assertCompleteAnsiPalette(preset);
  });

  it("returns one-dark palette for 'default-dark' theme slug", () => {
    const palette = getAnsiPalette("default-dark", "#1a1a2e");
    expect(palette.black).toBe("#282c34");
    expect(palette.red).toBe("#e06c75");
    expect(palette.green).toBe("#98c379");
    assertCompleteAnsiPalette(palette);
  });

  it("returns one-light palette for 'default-light' theme slug", () => {
    const palette = getAnsiPalette("default-light", "#fafafa");
    expect(palette.black).toBe("#383a42");
    expect(palette.red).toBe("#e45649");
    expect(palette.green).toBe("#50a14f");
    assertCompleteAnsiPalette(palette);
  });

  it("returns catppuccin-mocha palette for 'catppuccin' theme slug", () => {
    const palette = getAnsiPalette("catppuccin", "#1e1e2e");
    expect(palette.black).toBe("#45475a");
    expect(palette.red).toBe("#f38ba8");
    assertCompleteAnsiPalette(palette);
  });

  it("returns dracula palette for 'dracula' theme slug", () => {
    const palette = getAnsiPalette("dracula", "#282a36");
    expect(palette.black).toBe("#21222c");
    expect(palette.red).toBe("#ff5555");
    assertCompleteAnsiPalette(palette);
  });

  it("returns nord palette for 'nord' theme slug", () => {
    const palette = getAnsiPalette("nord", "#2e3440");
    expect(palette.black).toBe("#3b4252");
    expect(palette.red).toBe("#bf616a");
    assertCompleteAnsiPalette(palette);
  });

  it("returns solarized-dark palette for 'solarized-dark' slug", () => {
    const palette = getAnsiPalette("solarized-dark", "#002b36");
    expect(palette.black).toBe("#073642");
    assertCompleteAnsiPalette(palette);
  });

  it("returns solarized-light palette for 'solarized-light' slug", () => {
    const palette = getAnsiPalette("solarized-light", "#fdf6e3");
    expect(palette.black).toBe("#eee8d5");
    expect(palette.black).not.toBe(getAnsiPalette("solarized-dark", "#002b36").black);
    assertCompleteAnsiPalette(palette);
  });

  it("returns github-dark palette for 'github-dark' slug", () => {
    const palette = getAnsiPalette("github-dark", "#0d1117");
    expect(palette.red).toBe("#ff7b72");
    assertCompleteAnsiPalette(palette);
  });

  it("returns github-light palette for 'github-light' slug", () => {
    const palette = getAnsiPalette("github-light", "#ffffff");
    expect(palette.red).toBe("#cf222e");
    assertCompleteAnsiPalette(palette);
  });

  it("returns a dark palette for unknown theme with dark background (#1a1a2e)", () => {
    const palette = getAnsiPalette("unknown-theme", "#1a1a2e");
    // Should fall back to one-dark
    expect(palette.black).toBe("#282c34");
    assertCompleteAnsiPalette(palette);
  });

  it("returns a light palette for unknown theme with light background (#fafafa)", () => {
    const palette = getAnsiPalette("unknown-theme", "#fafafa");
    // Should fall back to one-light
    expect(palette.black).toBe("#383a42");
    assertCompleteAnsiPalette(palette);
  });

  it("falls back to dark for unknown theme with no background provided", () => {
    const palette = getAnsiPalette("unknown-theme", "");
    expect(palette.black).toBe("#282c34");
    assertCompleteAnsiPalette(palette);
  });

  it("all palettes have complete 16-color set", () => {
    const slugs = [
      "default-dark", "default-light", "catppuccin", "dracula",
      "nord", "solarized-dark", "solarized-light", "github-dark", "github-light",
    ];
    for (const slug of slugs) {
      const palette = getAnsiPalette(slug, "#000000");
      assertCompleteAnsiPalette(palette);
    }
  });

  it("builds a dark-safe xterm theme for dark system shell themes", () => {
    const shellTheme: Theme & { slug: string } = {
      name: "Custom Dark",
      slug: "custom-dark",
      mode: "dark",
      colors: {
        background: "#101418",
        foreground: "#E6E8EC",
        primary: "#F8F8F2",
      },
      fonts: {},
      radius: "8px",
    };

    const xtermTheme = buildXtermTheme(shellTheme, "system");

    expect(xtermTheme).toMatchObject({
      background: "#101418",
      foreground: "#E6E8EC",
      cursor: "#F8F8F2",
      selectionBackground: "#F8F8F244",
    });
    assertCompleteAnsiPalette(xtermTheme);
  });
});
