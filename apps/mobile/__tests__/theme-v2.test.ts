import {
  appColors,
  borderWidth,
  designShadows,
  fonts,
  palette,
  radius,
  semanticColorsByMode,
  size,
  space,
  text,
} from "../lib/theme-v2";

describe("theme-v2 design tokens", () => {
  it("uses the warm paper surfaces for screens and cards in light mode", () => {
    const light = semanticColorsByMode.light;
    expect(light.background).toBe("#FFFEFC");
    expect(light.card).toBe("#FAF9F7");
    expect(appColors.light.canvas).toBe("#FFFEFC");
    expect(appColors.light.surface).toBe("#FAF9F7");
  });

  it("keeps the ink colors and adds a tertiary text color", () => {
    const light = semanticColorsByMode.light;
    expect(light.textDefault).toBe("#242323");
    expect(light.textSubtle).toBe("#635F5F");
    expect(light.textTertiary).toBe("#8A8686");
  });

  it("keeps the stronger border for existing outlines and adds a hairline", () => {
    const light = semanticColorsByMode.light;
    expect(light.borderSubtle).toBe("#C8C6C6");
    expect(light.borderHairline).toBe("#F3F2F2");
  });

  it("maps status and destructive roles onto the brand ramps", () => {
    const light = semanticColorsByMode.light;
    expect(light.danger).toBe(palette.coral[500]);
    expect(light.danger).toBe("#BA5236");
    expect(light.highlight).toBe("#E0AA52");
    expect(light.success).toBe("#288A5B");
  });

  it("defines the four button styles and the chip states", () => {
    const light = semanticColorsByMode.light;
    expect(light.controlPrimary).toBe("#171717");
    expect(light.onControlPrimary).toBe("#FAFAFA");
    expect(light.controlSecondary).toBe("#F5F5F5");
    expect(light.onControlSecondary).toBe("#171717");
    expect(light.controlOutline).toBe("#FFFFFF");
    expect(light.controlOutlineBorder).toBe("#E5E5E5");
    expect(light.onControl).toBe("#0A0A0A");
    expect(light.chipSelected).toBe("#0D0D0D");
    expect(light.onChipSelected).toBe("#FFFFFF");
    expect(light.chip).toBe("#F2F2F0");
  });

  it("defines the sheet grabber and scrim", () => {
    expect(semanticColorsByMode.light.grabber).toBe("#D6D3CF");
    expect(semanticColorsByMode.light.scrim).toBe("rgba(0, 0, 0, 0.3)");
  });

  it("gives dark mode a value for every light token", () => {
    const lightKeys = Object.keys(semanticColorsByMode.light).sort();
    const darkKeys = Object.keys(semanticColorsByMode.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
    for (const value of Object.values(semanticColorsByMode.dark)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("keeps dark surfaces dark and dark text light", () => {
    const dark = semanticColorsByMode.dark;
    expect(dark.background).toBe(palette.neutral[900]);
    expect(dark.card).toBe(palette.neutral[800]);
    expect(dark.textDefault).toBe(palette.neutral[100]);
    expect(dark.controlPrimary).toBe("#FAFAFA");
    expect(dark.onControlPrimary).toBe("#171717");
  });

  it("exposes one line height per text size", () => {
    const lineHeightBySize: Record<number, number> = {};
    for (const style of Object.values(text)) {
      const known = lineHeightBySize[style.fontSize];
      if (known !== undefined) expect(style.lineHeight).toBe(known);
      lineHeightBySize[style.fontSize] = style.lineHeight;
    }
    expect(lineHeightBySize).toEqual({
      30: 41, 24: 34, 18: 25, 17: 25, 16: 22, 15: 22, 14: 20, 13: 18, 12: 17, 11: 15,
    });
  });

  it("sets every text style in Geist", () => {
    const geist: string[] = [fonts.product, fonts.productMedium, fonts.productSemiBold];
    for (const style of Object.values(text)) {
      expect(geist).toContain(style.fontFamily);
    }
    expect(text.title).toEqual({ fontFamily: "Geist_600SemiBold", fontSize: 30, lineHeight: 41 });
    expect(text.bodyMedium).toEqual({ fontFamily: "Geist_500Medium", fontSize: 16, lineHeight: 22 });
    expect(text.caption).toEqual({ fontFamily: "Geist_400Regular", fontSize: 13, lineHeight: 18 });
  });

  it("adds the radii the design uses beside the existing ones", () => {
    expect(radius).toMatchObject({
      tag: 6, badge: 8, control: 10, card: 12, field: 14, modal: 16, bubble: 18,
      container: 20, composer: 22, sheet: 24, full: 9999,
    });
  });

  it("exposes the spacing steps, control sizes and border widths", () => {
    expect(space).toEqual({
      1: 1, 2: 2, 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 14: 14, 16: 16, 18: 18, 20: 20, 24: 24,
    });
    expect(size).toMatchObject({ tapTarget: 44, topBar: 52, control: 44, controlLarge: 48 });
    expect(borderWidth).toEqual({ hairline: 1, emphasis: 1.5 });
  });

  it("sizes the shared controls that have a fixed dimension", () => {
    expect(size).toMatchObject({
      chip: 36,
      field: 54,
      searchField: 45,
      grabberWidth: 36,
      grabberHeight: 5,
      statusDot: 8,
      badge: 16,
      tabItemWidth: 70,
      tabIcon: 24,
      sidePanel: 330,
    });
  });

  it("adds the composer and side panel shadows", () => {
    expect(designShadows.composer).toBe("0 4px 16px rgba(0, 0, 0, 0.06)");
    expect(designShadows.panel).toBe("8px 0 24px rgba(0, 0, 0, 0.12)");
  });
});
