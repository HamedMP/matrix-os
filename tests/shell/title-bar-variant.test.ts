import { describe, expect, it } from "vitest";
import {
  resolveTitleBarVariant,
  usesCaptionButtons,
  designTitleBarContainerStyle,
} from "../../shell/src/components/window/title-bar-variant.js";

describe("resolveTitleBarVariant", () => {
  it("keeps the default mac title bar for flat and unknown styles", () => {
    expect(resolveTitleBarVariant("flat")).toBe("mac");
    expect(resolveTitleBarVariant(undefined)).toBe("mac");
    expect(resolveTitleBarVariant(null)).toBe("mac");
    expect(resolveTitleBarVariant("")).toBe("mac");
    expect(resolveTitleBarVariant("something-else")).toBe("mac");
  });

  it("keeps the win98 title bar for neumorphic", () => {
    expect(resolveTitleBarVariant("neumorphic")).toBe("win98");
  });

  it("maps each design-system style id to its own title bar", () => {
    expect(resolveTitleBarVariant("macos-glass")).toBe("macos-glass");
    expect(resolveTitleBarVariant("winxp")).toBe("winxp");
    expect(resolveTitleBarVariant("win11")).toBe("win11");
  });
});

describe("usesCaptionButtons", () => {
  it("uses right-aligned caption buttons for the Windows styles only", () => {
    expect(usesCaptionButtons("winxp")).toBe(true);
    expect(usesCaptionButtons("win11")).toBe(true);
    expect(usesCaptionButtons("mac")).toBe(false);
    expect(usesCaptionButtons("win98")).toBe(false);
    expect(usesCaptionButtons("macos-glass")).toBe(false);
  });
});

describe("designTitleBarContainerStyle", () => {
  it("returns undefined for the default mac/win98 variants so existing headers are untouched", () => {
    expect(designTitleBarContainerStyle("mac")).toBeUndefined();
    expect(designTitleBarContainerStyle("win98")).toBeUndefined();
  });

  it("uses the glass tokens for macos-glass", () => {
    const style = designTitleBarContainerStyle("macos-glass");
    expect(style?.background).toBe("var(--glass-surface-strong)");
    expect(style?.backdropFilter).toBe("var(--glass-blur)");
  });

  it("uses the Luna gradient for winxp", () => {
    const style = designTitleBarContainerStyle("winxp");
    expect(style?.background).toBe("var(--xp-titlebar)");
  });

  it("uses the acrylic tokens for win11", () => {
    const style = designTitleBarContainerStyle("win11");
    expect(style?.background).toBe("var(--win11-acrylic-strong)");
    expect(style?.backdropFilter).toBe("var(--win11-blur)");
  });
});
