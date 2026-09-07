import {
  colors,
  fonts,
  palette,
  radius,
  semanticColors,
  spacing,
  typography,
} from "../lib/theme";

describe("theme", () => {
  it("has light and dark color schemes", () => {
    expect(colors.light).toBeDefined();
    expect(colors.dark).toBeDefined();
  });

  it("light theme has required color tokens", () => {
    const { light } = colors;
    expect(light.background).toBe("#FAFAF9");
    expect(light.foreground).toBe("#1c1917");
    expect(light.primary).toBe("#9AA48C");
    expect(light.card).toBe("#FFFFFF");
    expect(light.border).toBe("#E5E5E4");
  });

  it("exports the new Figma semantic colors independently of legacy auth styling", () => {
    expect(semanticColors.background).toBe("#F4F7ED");
    expect(semanticColors.textDefault).toBe("#242323");
    expect(semanticColors.brand).toBe("#748E59");
    expect(semanticColors.card).toBe("#F3F2F2");
    expect(semanticColors.borderSubtle).toBe("#C8C6C6");
  });

  it("exposes the complete Figma color ramps", () => {
    expect(palette.green[500]).toBe("#748E59");
    expect(palette.coral[500]).toBe("#BA5236");
    expect(palette.teal[500]).toBe("#288A5B");
    expect(palette.gold[400]).toBe("#E0AA52");
    expect(palette.blue[500]).toBe("#3B85BA");
    expect(palette.neutral[800]).toBe("#242323");
  });

  it("dark theme has inverted background/foreground", () => {
    expect(colors.dark.background).toBe("#141614");
    expect(colors.dark.foreground).toBe("#EAECEA");
  });

  it("exports font family names", () => {
    expect(fonts.sans).toBe("Inter");
    expect(fonts.product).toBe("Geist_400Regular");
    expect(fonts.productExtraBold).toBe("Geist_800ExtraBold");
    expect(fonts.mono).toBe("JetBrainsMono_400Regular");
  });

  it("exports the 4-point spacing scale from Figma", () => {
    expect(spacing.xs).toBe(4);
    expect(spacing.sm).toBe(8);
    expect(spacing.lg).toBe(16);
    expect(spacing.xl).toBe(24);
    expect(spacing["2xl"]).toBe(32);
    expect(spacing["3xl"]).toBe(48);
    expect(spacing["4xl"]).toBe(64);
  });

  it("exports border radius scale", () => {
    expect(radius.tag).toBe(6);
    expect(radius.control).toBe(10);
    expect(radius.card).toBe(12);
    expect(radius.modal).toBe(16);
    expect(radius.container).toBe(20);
    expect(radius.xl).toBe(16);
    expect(radius.full).toBe(9999);
  });

  it("exports the Figma typography scale", () => {
    expect(typography.h1).toMatchObject({ fontSize: 36, fontFamily: "Geist_800ExtraBold" });
    expect(typography.h2).toMatchObject({ fontSize: 30, fontFamily: "Geist_600SemiBold" });
    expect(typography.h3).toMatchObject({ fontSize: 24, fontFamily: "Geist_600SemiBold" });
    expect(typography.large).toMatchObject({ fontSize: 18, fontFamily: "Geist_600SemiBold" });
    expect(typography.body).toMatchObject({ fontSize: 16, lineHeight: 28 });
    expect(typography.muted).toMatchObject({ fontSize: 14 });
    expect(typography.overline).toMatchObject({ fontSize: 11, textTransform: "uppercase" });
  });
});
