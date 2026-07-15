// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  getThemeChrome,
  getThemeEditorColors,
  getThemeTerminalColors,
  getThemeVariant,
  getUnifiedTheme,
  isThemeId,
  unifiedThemes,
} from "../../desktop/src/renderer/src/design/themes";
import {
  applyUnifiedTheme,
  chromeToSemanticVars,
  resolveThemeMode,
} from "../../desktop/src/renderer/src/design/themes/apply";

const CHROME_KEY_COUNT = 37;
const TERMINAL_KEY_COUNT = 22;
const EDITOR_KEY_COUNT = 18;

describe("unified theme registry", () => {
  it("registers unique, complete themes", () => {
    const ids = unifiedThemes.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME_ID);
    expect(ids).toContain("matrix");

    for (const theme of unifiedThemes) {
      expect(theme.name.length).toBeGreaterThan(0);
      const variants = [theme.dark, theme.light].filter(Boolean);
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants) {
        expect(Object.keys(variant!.chrome)).toHaveLength(CHROME_KEY_COUNT);
        expect(Object.keys(variant!.terminal)).toHaveLength(TERMINAL_KEY_COUNT);
        expect(Object.keys(variant!.editor)).toHaveLength(EDITOR_KEY_COUNT);
        for (const layer of [variant!.chrome, variant!.terminal, variant!.editor]) {
          for (const [key, value] of Object.entries(layer)) {
            expect(typeof value, `${theme.id} ${key}`).toBe("string");
            expect((value as string).length, `${theme.id} ${key}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("uses the specified default dark palette", () => {
    const chrome = getThemeChrome(DEFAULT_THEME_ID, "dark");
    expect(chrome.background).toBe("#282c34");
    expect(chrome.card).toBe("#2c313c");
    expect(chrome.muted).toBe("#333842");
    expect(chrome.destructive).toBe("#e06c75");
    expect(chrome.ring).toBe("#61afef");

    const editor = getThemeEditorColors(DEFAULT_THEME_ID, "dark");
    expect(editor.keyword).toBe("#c678dd");
    expect(editor.string).toBe("#98c379");
    expect(editor.function).toBe("#61afef");
    expect(editor.type).toBe("#e5c07b");
    expect(editor.number).toBe("#d19a66");
    expect(editor.operator).toBe("#56b6c2");
  });

  it("falls back across variants and to the default theme", () => {
    // one-dark ships dark-only: light mode must still resolve its dark variant.
    const variant = getThemeVariant("one-dark", "light");
    expect(variant.chrome.background).toBe("#282c34");
    // Unknown ids resolve to the default theme.
    expect(getUnifiedTheme("does-not-exist").id).toBe(DEFAULT_THEME_ID);
    expect(isThemeId("does-not-exist")).toBe(false);
    expect(isThemeId("matrix")).toBe(true);
    expect(getThemeTerminalColors("matrix", "dark").background.length).toBeGreaterThan(0);
  });
});

describe("applyUnifiedTheme", () => {
  afterEach(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.removeAttribute("data-theme-id");
    root.removeAttribute("style");
  });

  it("maps every managed semantic variable from the chrome layer", () => {
    const vars = chromeToSemanticVars(getThemeChrome(DEFAULT_THEME_ID, "dark"));
    expect(vars["--bg-app"]).toBe("#282c34");
    expect(vars["--danger"]).toBe("#e06c75");
    expect(vars["--accent"]).toBe("#61afef");
    // Highlight and warning must stay distinguishable signals.
    expect(vars["--highlight"]).not.toBe(vars["--warning"]);
    for (const [name, value] of Object.entries(vars)) {
      expect(name.startsWith("--")).toBe(true);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("builds a valid focus ring for non-hex ring colors", () => {
    // The Operator light variant uses an oklch() ring; appending a hex alpha
    // suffix would produce an unparseable box-shadow that browsers discard.
    const vars = chromeToSemanticVars(getThemeChrome(DEFAULT_THEME_ID, "light"));
    expect(vars["--focus-ring"]).toBe("0 0 0 3px color-mix(in srgb, oklch(0.55 0 0) 33%, transparent)");
  });

  it("gives every sidebar primary pair readable contrast", () => {
    // WCAG relative luminance over hex pairs; non-hex values (oklch) are
    // exempt because they cannot be parsed here.
    const hexChannel = (value: string, offset: number) =>
      Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    const linear = (channel: number) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const luminance = (hex: string) =>
      0.2126 * linear(hexChannel(hex, 1))
      + 0.7152 * linear(hexChannel(hex, 3))
      + 0.0722 * linear(hexChannel(hex, 5));
    const contrastRatio = (a: string, b: string) => {
      const [bright, dim] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (bright! + 0.05) / (dim! + 0.05);
    };
    const HEX = /^#[0-9a-f]{6}$/i;
    // 3:1 is the WCAG threshold for user-interface components.
    const MIN_CONTRAST = 3;

    const violations: string[] = [];
    for (const theme of unifiedThemes) {
      for (const [mode, variant] of [["dark", theme.dark], ["light", theme.light]] as const) {
        if (!variant) continue;
        const { sidebarPrimary, sidebarPrimaryForeground } = variant.chrome;
        if (!HEX.test(sidebarPrimary) || !HEX.test(sidebarPrimaryForeground)) continue;
        const ratio = contrastRatio(sidebarPrimary, sidebarPrimaryForeground);
        if (ratio < MIN_CONTRAST) {
          violations.push(
            `${theme.id} (${mode}) ${sidebarPrimary} on ${sidebarPrimaryForeground} = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("applies non-default themes as inline variable overrides", () => {
    applyUnifiedTheme("dracula", "dark");
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-theme-id")).toBe("dracula");
    expect(root.style.getPropertyValue("--bg-app")).toBe(getThemeChrome("dracula", "dark").background);
  });

  it("clears overrides for the Matrix theme so the stylesheet wins", () => {
    applyUnifiedTheme("dracula", "dark");
    applyUnifiedTheme("matrix", "light");
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-theme-id")).toBe("matrix");
    expect(root.style.getPropertyValue("--bg-app")).toBe("");
  });

  it("keeps data-theme coherent for single-variant themes", () => {
    // one-dark is dark-only: even in light mode the document renders dark.
    applyUnifiedTheme("one-dark", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("resolves system mode from the media query", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    expect(resolveThemeMode("system")).toBe("dark");
    expect(resolveThemeMode("light")).toBe("light");
  });
});
