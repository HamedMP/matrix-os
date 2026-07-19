import { describe, it, expect } from "vitest";
import {
  DESIGN_SYSTEM_PRESETS,
  MATRIX_OS_APP_THEME_OPTIONS,
  THEME_PRESETS,
  getPreset,
} from "../../shell/src/lib/theme-presets";

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
  it("includes the legacy presets, the Paper Matrix OS app themes, and the design systems", () => {
    expect(THEME_PRESETS).toHaveLength(13);
    expect(MATRIX_OS_APP_THEME_OPTIONS.map((option) => option.id)).toEqual([
      "light",
      "matrix-dark",
      "matrix",
    ]);
    expect(DESIGN_SYSTEM_PRESETS.map((preset) => preset.name)).toEqual([
      "macos-glass",
      "winxp",
      "win11",
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

describe("design system presets", () => {
  const DESIGN_SYSTEMS = [
    {
      name: "macos-glass",
      style: "macos-glass",
      mode: "light",
      radius: "0.875rem",
      fontFragment: "SF Pro Text",
      primary: "#0A84FF",
    },
    {
      name: "winxp",
      style: "winxp",
      mode: "light",
      radius: "0.1875rem",
      fontFragment: "Tahoma",
      primary: "#0058E6",
    },
    {
      name: "win11",
      style: "win11",
      mode: "light",
      radius: "0.5rem",
      fontFragment: "Segoe UI",
      primary: "#0067C0",
    },
  ] as const;

  it.each(DESIGN_SYSTEMS)(
    "$name is registered with its design-system style, mode, fonts, and radius",
    ({ name, style, mode, radius, fontFragment, primary }) => {
      const preset = getPreset(name);
      expect(preset).toBeDefined();
      expect(preset!.style).toBe(style);
      expect(preset!.mode).toBe(mode);
      expect(preset!.radius).toBe(radius);
      expect(preset!.fonts.sans).toContain(fontFragment);
      expect(preset!.colors.primary).toBe(primary);
    },
  );

  it.each(DESIGN_SYSTEMS)("$name has all required color keys", ({ name }) => {
    const preset = getPreset(name);
    expect(preset).toBeDefined();
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(preset!.colors[key], `missing color key: ${key}`).toBeDefined();
    }
  });

  it("exposes exactly the three design-system presets in DESIGN_SYSTEM_PRESETS", () => {
    expect(DESIGN_SYSTEM_PRESETS).toHaveLength(3);
    for (const preset of DESIGN_SYSTEM_PRESETS) {
      expect(THEME_PRESETS).toContain(preset);
    }
  });

  it("macos-glass is a faithful light macOS theme", () => {
    const preset = getPreset("macos-glass");
    expect(preset).toBeDefined();
    expect(preset!.mode).toBe("light");
    expect(preset!.colors).toMatchObject({
      background: "#F5F5F7",
      foreground: "#1D1D1F",
      card: "#FFFFFF",
      popover: "#FFFFFF",
      primary: "#0A84FF",
      "primary-foreground": "#FFFFFF",
      "muted-foreground": "#6E6E73",
      border: "#D1D1D6",
      input: "#D1D1D6",
      ring: "#0A84FF",
    });
  });
});
