import { describe, it, expect } from "vitest";
import { MATRIX_OS_APP_THEME_OPTIONS, THEME_PRESETS, getPreset } from "../../shell/src/lib/theme-presets";

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

describe("theme presets", () => {
  it("includes the legacy presets plus the three Paper Matrix OS app themes", () => {
    expect(THEME_PRESETS).toHaveLength(10);
    expect(MATRIX_OS_APP_THEME_OPTIONS.map((option) => option.id)).toEqual([
      "light",
      "matrix-dark",
      "matrix",
    ]);
  });

  it.each(THEME_PRESETS.map((p) => [p.name, p]))(
    "%s has all 20 color keys",
    (_name, preset) => {
      for (const key of REQUIRED_COLOR_KEYS) {
        expect(preset.colors[key], `missing color key: ${key}`).toBeDefined();
      }
      expect(Object.keys(preset.colors).length).toBeGreaterThanOrEqual(20);
    },
  );

  it.each(THEME_PRESETS.map((p) => [p.name, p]))(
    "%s has fonts.mono and fonts.sans",
    (_name, preset) => {
      expect(preset.fonts.mono).toBeDefined();
      expect(preset.fonts.sans).toBeDefined();
    },
  );

  it.each(THEME_PRESETS.map((p) => [p.name, p]))(
    "%s has a radius",
    (_name, preset) => {
      expect(preset.radius).toBeDefined();
      expect(preset.radius).toMatch(/rem$/);
    },
  );

  it.each(THEME_PRESETS.map((p) => [p.name, p]))(
    "%s has valid hex color values",
    (_name, preset) => {
      const hexRegex = /^#[0-9a-fA-F]{6}$/;
      for (const key of REQUIRED_COLOR_KEYS) {
        expect(preset.colors[key], `${key} is not valid hex`).toMatch(hexRegex);
      }
    },
  );
});

describe("getPreset", () => {
  it("returns correct preset by name", () => {
    const dark = getPreset("dark");
    expect(dark).toBeDefined();
    expect(dark!.name).toBe("dark");
    expect(dark!.colors.background).toBe("#1a1a2e");
  });

  it("returns default preset", () => {
    const preset = getPreset("default");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("default");
    expect(preset!.colors.primary).toBe("#434E3F");
  });

  it("returns nord preset", () => {
    const preset = getPreset("nord");
    expect(preset).toBeDefined();
    expect(preset!.colors.primary).toBe("#88c0d0");
  });

  it("returns the Paper Matrix OS app themes", () => {
    expect(getPreset("light")).toMatchObject({
      name: "light",
      mode: "light",
      colors: expect.objectContaining({
        background: "#FAFAF9",
        primary: "#434E3F",
        ring: "#D06F25",
      }),
    });
    expect(getPreset("matrix-dark")).toMatchObject({
      name: "matrix-dark",
      mode: "dark",
      colors: expect.objectContaining({
        background: "#1C2019",
        primary: "#9CB77A",
        ring: "#CF7835",
      }),
    });
    expect(getPreset("matrix")).toMatchObject({
      name: "matrix",
      mode: "dark",
      colors: expect.objectContaining({
        background: "#020A02",
        primary: "#39FF6A",
        ring: "#39FF6A",
      }),
    });
  });

  it("returns undefined for unknown name", () => {
    expect(getPreset("nonexistent")).toBeUndefined();
    expect(getPreset("")).toBeUndefined();
  });
});
