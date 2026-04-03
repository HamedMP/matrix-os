import { describe, it, expect } from "vitest";
import { getAnsiPalette, type AnsiPalette } from "../../shell/src/components/terminal/terminal-themes.js";

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

describe("Terminal Themes", () => {
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
});
