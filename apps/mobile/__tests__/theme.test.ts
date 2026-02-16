import { colors, fonts, spacing, radius } from "../lib/theme";

describe("theme", () => {
  it("has light and dark color schemes", () => {
    expect(colors.light).toBeDefined();
    expect(colors.dark).toBeDefined();
  });

  it("light theme has required color tokens", () => {
    const { light } = colors;
    expect(light.background).toBe("#ece5f0");
    expect(light.foreground).toBe("#1c1917");
    expect(light.primary).toBe("#c2703a");
    expect(light.card).toBe("#ffffff");
    expect(light.border).toBe("#d8d0de");
  });

  it("dark theme has same primary color", () => {
    expect(colors.dark.primary).toBe("#c2703a");
  });

  it("dark theme has inverted background/foreground", () => {
    expect(colors.dark.background).toBe("#1c1917");
    expect(colors.dark.foreground).toBe("#ece5f0");
  });

  it("exports font family names", () => {
    expect(fonts.sans).toBe("Inter");
    expect(fonts.mono).toBe("JetBrainsMono_400Regular");
  });

  it("exports spacing scale", () => {
    expect(spacing.xs).toBe(4);
    expect(spacing.sm).toBe(8);
    expect(spacing.lg).toBe(16);
    expect(spacing.xl).toBe(24);
  });

  it("exports border radius scale", () => {
    expect(radius.sm).toBe(8);
    expect(radius.xl).toBe(16);
    expect(radius.full).toBe(9999);
  });
});
