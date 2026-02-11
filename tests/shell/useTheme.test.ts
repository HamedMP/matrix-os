import { describe, it, expect } from "vitest";

interface Theme {
  name: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

const DEFAULT_THEME: Theme = {
  name: "default",
  colors: {
    bg: "#0a0a0a",
    fg: "#ededed",
    accent: "#3b82f6",
    surface: "#171717",
    border: "#262626",
    muted: "#737373",
    error: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
  },
  fonts: {
    mono: "JetBrains Mono, monospace",
    sans: "Inter, system-ui, sans-serif",
  },
  radius: "0.5rem",
};

function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    vars[`--color-${key}`] = value;
  }
  for (const [key, value] of Object.entries(theme.fonts)) {
    vars[`--font-${key}`] = value;
  }
  vars["--radius"] = theme.radius;
  return vars;
}

describe("theme system", () => {
  it("default theme has all required color keys", () => {
    const required = ["bg", "fg", "accent", "surface", "border", "muted", "error", "success", "warning"];
    for (const key of required) {
      expect(DEFAULT_THEME.colors[key]).toBeDefined();
    }
  });

  it("default theme has font keys", () => {
    expect(DEFAULT_THEME.fonts.mono).toBeDefined();
    expect(DEFAULT_THEME.fonts.sans).toBeDefined();
  });

  it("converts theme to CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    expect(vars["--color-bg"]).toBe("#0a0a0a");
    expect(vars["--color-accent"]).toBe("#3b82f6");
    expect(vars["--font-mono"]).toBe("JetBrains Mono, monospace");
    expect(vars["--radius"]).toBe("0.5rem");
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
    expect(Object.keys(vars).length).toBe(colorCount + fontCount + 1); // +1 for radius
  });

  it("custom theme overrides apply correctly", () => {
    const custom: Theme = {
      ...DEFAULT_THEME,
      name: "ocean",
      colors: { ...DEFAULT_THEME.colors, bg: "#001122", accent: "#00ccff" },
    };
    const vars = themeToCssVars(custom);
    expect(vars["--color-bg"]).toBe("#001122");
    expect(vars["--color-accent"]).toBe("#00ccff");
    expect(vars["--color-fg"]).toBe("#ededed"); // unchanged
  });
});
