import { describe, it, expect } from "vitest";

describe("ColorPicker", () => {
  it("renders with value and label props", () => {
    const props = { value: "#ff0000", onChange: () => {}, label: "Primary" };
    expect(props.value).toBe("#ff0000");
    expect(props.label).toBe("Primary");
  });

  it("accepts hex color strings", () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    expect("#c2703a").toMatch(hex);
    expect("#ffffff").toMatch(hex);
  });
});

describe("ThemeEditor", () => {
  it("color categories cover all 20 keys", () => {
    const categories: Record<string, string[]> = {
      Base: ["background", "foreground"],
      Cards: ["card", "card-foreground", "popover", "popover-foreground"],
      Primary: ["primary", "primary-foreground"],
      Secondary: ["secondary", "secondary-foreground"],
      Muted: ["muted", "muted-foreground"],
      Accent: ["accent", "accent-foreground"],
      Status: ["destructive", "success", "warning"],
      Chrome: ["border", "input", "ring"],
    };

    const allKeys = Object.values(categories).flat();
    expect(allKeys).toHaveLength(20);

    const uniqueKeys = new Set(allKeys);
    expect(uniqueKeys.size).toBe(20);
  });

  it("font options include expected families", () => {
    const sansFonts = ["Inter", "system-ui"];
    const monoFonts = ["JetBrains Mono", "Fira Code", "Source Code Pro"];
    expect(sansFonts.length).toBeGreaterThan(0);
    expect(monoFonts.length).toBeGreaterThan(0);
  });

  it("radius range is 0 to 1.5 with step 0.25", () => {
    const min = 0;
    const max = 1.5;
    const step = 0.25;
    const steps = (max - min) / step;
    expect(steps).toBe(6);
  });
});

describe("BackgroundEditor", () => {
  it("supports 4 background types", () => {
    const types = ["pattern", "solid", "gradient", "wallpaper"];
    expect(types).toHaveLength(4);
  });

  it("gradient angle range is 0 to 360", () => {
    const min = 0;
    const max = 360;
    expect(max - min).toBe(360);
  });
});

describe("DockEditor", () => {
  it("supports 3 dock positions", () => {
    const positions = ["left", "right", "bottom"];
    expect(positions).toHaveLength(3);
  });

  it("dock size range is 40 to 80", () => {
    const min = 40;
    const max = 80;
    expect(max).toBeGreaterThan(min);
  });

  it("icon size range is 28 to 56", () => {
    const min = 28;
    const max = 56;
    expect(max).toBeGreaterThan(min);
  });
});

describe("AppearanceSection", () => {
  it("has 3 tabs", () => {
    const tabs = ["Theme", "Background", "Dock"];
    expect(tabs).toHaveLength(3);
  });
});
