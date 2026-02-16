import { describe, it, expect } from "vitest";
import { DEFAULT_THEME, type Theme } from "../../shell/src/hooks/useTheme";

function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    vars[`--${key}`] = value;
  }
  for (const [key, value] of Object.entries(theme.fonts)) {
    vars[`--font-${key}`] = value;
  }
  vars["--radius"] = theme.radius;
  return vars;
}

describe("theme system", () => {
  const REQUIRED_COLOR_KEYS = [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "success",
    "warning",
    "border",
    "input",
    "ring",
  ];

  it("default theme has all required color keys", () => {
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(DEFAULT_THEME.colors[key]).toBeDefined();
    }
  });

  it("default theme has font keys", () => {
    expect(DEFAULT_THEME.fonts.mono).toBeDefined();
    expect(DEFAULT_THEME.fonts.sans).toBeDefined();
  });

  it("converts theme to CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    expect(vars["--background"]).toBe("#ece5f0");
    expect(vars["--primary"]).toBe("#c2703a");
    expect(vars["--font-mono"]).toBe("JetBrains Mono, monospace");
    expect(vars["--radius"]).toBe("0.75rem");
  });

  it("all color values are valid hex", () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    for (const [key, value] of Object.entries(DEFAULT_THEME.colors)) {
      expect(value).toMatch(hexRegex);
    }
  });

  it("generates correct number of CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    const colorCount = Object.keys(DEFAULT_THEME.colors).length;
    const fontCount = Object.keys(DEFAULT_THEME.fonts).length;
    expect(Object.keys(vars).length).toBe(colorCount + fontCount + 1);
  });

  it("custom theme overrides apply correctly", () => {
    const custom: Theme = {
      ...DEFAULT_THEME,
      name: "ocean",
      colors: { ...DEFAULT_THEME.colors, background: "#001122", primary: "#00ccff" },
    };
    const vars = themeToCssVars(custom);
    expect(vars["--background"]).toBe("#001122");
    expect(vars["--primary"]).toBe("#00ccff");
    expect(vars["--foreground"]).toBe("#1c1917");
  });
});
