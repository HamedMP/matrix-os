import { describe, it, expect } from "vitest";
import { THEME_PRESETS, getPreset } from "../../shell/src/lib/theme-presets";

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
  it("has 6 presets", () => {
    expect(THEME_PRESETS).toHaveLength(6);
  });

  it.each(THEME_PRESETS.map((p) => [p.name, p]))(
    "%s has all 20 color keys",
    (_name, preset) => {
      for (const key of REQUIRED_COLOR_KEYS) {
        expect(preset.colors[key], `missing color key: ${key}`).toBeDefined();
      }
      expect(Object.keys(preset.colors)).toHaveLength(20);
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
      for (const [key, value] of Object.entries(preset.colors)) {
        expect(value, `${key} is not valid hex`).toMatch(hexRegex);
      }
    },
  );
});

describe("getPreset", () => {
  it("returns correct preset by name", () => {
    const dark = getPreset("dark");
    expect(dark).toBeDefined();
    expect(dark!.name).toBe("dark");
    expect(dark!.colors.background).toBe("#0a0a0a");
  });

  it("returns default preset", () => {
    const preset = getPreset("default");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("default");
    expect(preset!.colors.primary).toBe("#c2703a");
  });

  it("returns nord preset", () => {
    const preset = getPreset("nord");
    expect(preset).toBeDefined();
    expect(preset!.colors.primary).toBe("#88c0d0");
  });

  it("returns undefined for unknown name", () => {
    expect(getPreset("nonexistent")).toBeUndefined();
    expect(getPreset("")).toBeUndefined();
  });
});
