import { colors, fonts, spacing, radius } from "../lib/theme";

describe("theme", () => {
  it("has light and dark color schemes", () => {
    expect(colors.light).toBeDefined();
    expect(colors.dark).toBeDefined();
  });

  it("light theme has required color tokens", () => {
    const { light } = colors;
    expect(light.background).toBe("#FAFAF9");
    expect(light.foreground).toBe("#1c1917");
    expect(light.primary).toBe("#8CC7BE");
    expect(light.card).toBe("#ffffff");
    expect(light.border).toBe("#E5E5E4");
  });

  it("dark theme has same primary color", () => {
    expect(colors.dark.primary).toBe("#8CC7BE");
  });

  it("dark theme has inverted background/foreground", () => {
    expect(colors.dark.background).toBe("#141614");
    expect(colors.dark.foreground).toBe("#EAECEA");
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
