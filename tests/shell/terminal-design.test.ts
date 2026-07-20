import { describe, expect, it } from "vitest";
import {
  applyTerminalDesignTheme,
  resolveTerminalDesign,
} from "../../shell/src/components/terminal/terminal-design.js";
import { buildXtermTheme } from "../../shell/src/components/terminal/terminal-themes.js";
import type { Theme } from "../../shell/src/hooks/useTheme.js";

const WINXP_SHELL_THEME: Theme = {
  name: "winxp",
  mode: "light",
  style: "winxp",
  colors: {
    background: "#ECE9D8",
    foreground: "#1F1F1F",
    primary: "#0058E6",
  },
  fonts: {
    mono: "Courier New, monospace",
    sans: 'Tahoma, Geneva, "Segoe UI", sans-serif',
  },
  radius: "0.1875rem",
};

const MACOS_GLASS_SHELL_THEME: Theme = {
  name: "macos-glass",
  mode: "light",
  style: "macos-glass",
  colors: {
    background: "#F5F5F7",
    foreground: "#1D1D1F",
    primary: "#0A84FF",
  },
  fonts: {
    mono: "SF Mono, Menlo, monospace",
    sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  },
  radius: "0.875rem",
};

describe("resolveTerminalDesign", () => {
  it("maps OS design styles to terminal design ids", () => {
    expect(resolveTerminalDesign("winxp")).toBe("winxp");
    expect(resolveTerminalDesign("win11")).toBe("win11");
    expect(resolveTerminalDesign("macos-glass")).toBe("macos-glass");
  });

  it("keeps flat, neumorphic, and unknown styles on the default terminal chrome", () => {
    expect(resolveTerminalDesign("flat")).toBeNull();
    expect(resolveTerminalDesign("neumorphic")).toBeNull();
    expect(resolveTerminalDesign("something-else")).toBeNull();
    expect(resolveTerminalDesign("")).toBeNull();
    expect(resolveTerminalDesign(undefined)).toBeNull();
    expect(resolveTerminalDesign(null)).toBeNull();
  });
});

describe("applyTerminalDesignTheme", () => {
  it("returns the theme untouched for the default design", () => {
    expect(applyTerminalDesignTheme(WINXP_SHELL_THEME, null)).toBe(WINXP_SHELL_THEME);
  });

  it("keeps Windows 11 terminal content rendering unchanged", () => {
    expect(applyTerminalDesignTheme(WINXP_SHELL_THEME, "win11")).toBe(WINXP_SHELL_THEME);
  });

  it("switches the winxp terminal content to classic cmd.exe colors", () => {
    const adjusted = applyTerminalDesignTheme(WINXP_SHELL_THEME, "winxp");

    expect(adjusted.colors.background).toBe("#0C0C0C");
    expect(adjusted.colors.foreground).toBe("#CCCCCC");
    // The XP accent stays intact for cursor/selection and banner accents.
    expect(adjusted.colors.primary).toBe("#0058E6");
    // Lucida Console leads the themed mono fallback; the sans stack is preserved.
    expect(adjusted.fonts.mono).toBe('"Lucida Console", monospace');
    expect(adjusted.fonts.sans).toBe(WINXP_SHELL_THEME.fonts.sans);
    // Pure transform: the input theme object is not mutated.
    expect(WINXP_SHELL_THEME.colors.background).toBe("#ECE9D8");
    expect(WINXP_SHELL_THEME.fonts.mono).toBe("Courier New, monospace");
  });

  it("switches the macos-glass terminal content to a light translucent background", () => {
    const adjusted = applyTerminalDesignTheme(MACOS_GLASS_SHELL_THEME, "macos-glass");

    expect(adjusted.colors.background).toBe("rgba(245, 245, 247, 0.78)");
    expect(adjusted.colors.foreground).toBe("#1D1D1F");
    expect(adjusted.fonts.mono).toBe("SF Mono, Menlo, monospace");
    expect(MACOS_GLASS_SHELL_THEME.colors.background).toBe("#F5F5F7");
  });
});

describe("buildXtermTheme with design-adjusted backgrounds", () => {
  it("infers a light ANSI palette for translucent light rgba backgrounds", () => {
    const xtermTheme = buildXtermTheme(
      applyTerminalDesignTheme(MACOS_GLASS_SHELL_THEME, "macos-glass"),
      "system",
    );

    // one-light palette values: a wrong (dark) inference would hide dim text.
    expect(xtermTheme.brightWhite).toBe("#dcdcdc");
    expect(xtermTheme.white).toBe("#a0a1a7");
  });

  it("infers a dark ANSI palette for translucent dark rgba backgrounds", () => {
    const darkRgbaTheme: Theme = {
      ...MACOS_GLASS_SHELL_THEME,
      colors: { ...MACOS_GLASS_SHELL_THEME.colors, background: "rgba(12, 12, 12, 0.8)" },
    };
    const xtermTheme = buildXtermTheme(darkRgbaTheme, "system");

    // one-dark palette values.
    expect(xtermTheme.brightWhite).toBe("#ffffff");
    expect(xtermTheme.white).toBe("#abb2bf");
  });
});
