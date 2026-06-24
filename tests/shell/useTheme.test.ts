import { describe, it, expect, vi } from "vitest";
import { DEFAULT_THEME, getThemeFallback, normalizeTheme, type Theme } from "../../shell/src/hooks/useTheme";

vi.mock("../../shell/src/hooks/useFileWatcher", () => ({
  useFileWatcher: () => undefined,
}));

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

  it("uses the light default theme for first-run shell state", () => {
    const theme = getThemeFallback();

    expect(theme).toBe(DEFAULT_THEME);
    expect(theme.colors.background).toBe("#FAFAF9");
  });

  it("normalizes empty first-run theme responses against the light shell fallback", () => {
    const fallback = getThemeFallback();
    const theme = normalizeTheme({}, fallback);

    expect(theme.mode).toBeUndefined();
    expect(theme.colors.background).toBe(fallback.colors.background);
  });

  it("normalizes invalid theme responses against the selected fallback", () => {
    const fallback = getThemeFallback();

    expect(normalizeTheme(null, fallback)).toBe(fallback);
    expect(normalizeTheme([], fallback)).toBe(fallback);
  });

  it("preserves explicit saved light themes over the shell fallback", () => {
    const theme = normalizeTheme({
      name: "saved-light",
      mode: "light",
      colors: {
        background: "#ffffff",
        foreground: "#111111",
      },
    });

    expect(theme.mode).toBe("light");
    expect(theme.colors.background).toBe("#ffffff");
    expect(theme.colors.foreground).toBe("#111111");
  });

  it("preserves explicit saved dark themes over the shell fallback", () => {
    const theme = normalizeTheme({
      name: "saved-dark",
      mode: "dark",
      colors: {
        background: "#111111",
        foreground: "#ffffff",
      },
    });

    expect(theme.mode).toBe("dark");
    expect(theme.colors.background).toBe("#111111");
    expect(theme.colors.foreground).toBe("#ffffff");
  });

  it("preserves legacy saved light themes that omit mode", () => {
    const theme = normalizeTheme({
      name: "legacy-light",
      colors: {
        background: "#ffffff",
        foreground: "#111111",
      },
    });

    expect(theme.mode).toBeUndefined();
    expect(theme.colors.background).toBe("#ffffff");
    expect(theme.colors.foreground).toBe("#111111");
  });

  it("converts theme to CSS variables", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    expect(vars["--background"]).toBe("#FAFAF9");
    expect(vars["--primary"]).toBe("#434E3F");
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
    expect(vars["--foreground"]).toBe("#32352E");
  });

  it("normalizes missing persisted theme fields to defaults", () => {
    const theme = normalizeTheme({});
    const fallback = getThemeFallback();

    expect(theme.colors.background).toBe(fallback.colors.background);
    expect(theme.colors.foreground).toBe(fallback.colors.foreground);
    expect(theme.fonts.mono).toBe(fallback.fonts.mono);
    expect(theme.radius).toBe(fallback.radius);
  });

  it("normalizes partial persisted themes without dropping valid overrides", () => {
    const fallback = getThemeFallback();
    const theme = normalizeTheme({
      name: "custom",
      mode: "dark",
      colors: {
        background: "#001122",
        primary: "#00ccff",
        ignored: 42,
      },
      fonts: {
        sans: "system-ui, sans-serif",
        ignored: false,
      },
      radius: "1rem",
    });

    expect(theme.name).toBe("custom");
    expect(theme.mode).toBe("dark");
    expect(theme.colors.background).toBe("#001122");
    expect(theme.colors.primary).toBe("#00ccff");
    expect(theme.colors.foreground).toBe(fallback.colors.foreground);
    expect(theme.fonts.sans).toBe("system-ui, sans-serif");
    expect(theme.fonts.mono).toBe(fallback.fonts.mono);
    expect(theme.radius).toBe("1rem");
  });
});
