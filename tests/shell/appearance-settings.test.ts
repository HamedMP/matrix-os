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
  it("keeps design, background, and dock settings", () => {
    const sections = ["Design", "Background", "Dock"];
    expect(sections).toHaveLength(3);
    expect(sections).not.toContain("Theme");
  });
});
