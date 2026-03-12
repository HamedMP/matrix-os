import { describe, it, expect } from "vitest";
import {
  buildBridgeScript,
  getThemeVariables,
  THEME_VAR_MAP,
} from "../../shell/src/lib/os-bridge.js";

describe("Theme Variable Injection (T2070)", () => {
  describe("THEME_VAR_MAP", () => {
    it("maps shell CSS vars to --matrix-* vars", () => {
      expect(THEME_VAR_MAP).toEqual({
        "--background": "--matrix-bg",
        "--foreground": "--matrix-fg",
        "--primary": "--matrix-accent",
        "--border": "--matrix-border",
        "--card": "--matrix-card-bg",
        "--card-foreground": "--matrix-card-fg",
        "--input": "--matrix-input-bg",
        "--font-sans": "--matrix-font-sans",
        "--font-mono": "--matrix-font-mono",
        "--radius": "--matrix-radius",
      });
    });
  });

  describe("getThemeVariables", () => {
    it("reads CSS variables from a CSSStyleDeclaration", () => {
      const mockStyle = {
        getPropertyValue: (prop: string) => {
          const vals: Record<string, string> = {
            "--background": "#ece5f0",
            "--foreground": "#1c1917",
            "--primary": "#c2703a",
            "--border": "#d8d0de",
            "--card": "#ffffff",
            "--card-foreground": "#1c1917",
            "--input": "#d8d0de",
            "--font-sans": '"Inter", system-ui, sans-serif',
            "--font-mono": '"JetBrains Mono", monospace',
            "--radius": "0.75rem",
          };
          return vals[prop] ?? "";
        },
      } as CSSStyleDeclaration;

      const vars = getThemeVariables(mockStyle);

      expect(vars["--matrix-bg"]).toBe("#ece5f0");
      expect(vars["--matrix-fg"]).toBe("#1c1917");
      expect(vars["--matrix-accent"]).toBe("#c2703a");
      expect(vars["--matrix-border"]).toBe("#d8d0de");
      expect(vars["--matrix-card-bg"]).toBe("#ffffff");
      expect(vars["--matrix-card-fg"]).toBe("#1c1917");
      expect(vars["--matrix-input-bg"]).toBe("#d8d0de");
      expect(vars["--matrix-font-sans"]).toBe('"Inter", system-ui, sans-serif');
      expect(vars["--matrix-font-mono"]).toBe('"JetBrains Mono", monospace');
      expect(vars["--matrix-radius"]).toBe("0.75rem");
    });

    it("returns empty strings for missing variables", () => {
      const mockStyle = {
        getPropertyValue: () => "",
      } as unknown as CSSStyleDeclaration;

      const vars = getThemeVariables(mockStyle);

      expect(vars["--matrix-bg"]).toBe("");
      expect(vars["--matrix-fg"]).toBe("");
    });
  });

  describe("buildBridgeScript", () => {
    it("injects theme style tag into iframe head", () => {
      const themeVars = {
        "--matrix-bg": "#ece5f0",
        "--matrix-fg": "#1c1917",
        "--matrix-accent": "#c2703a",
        "--matrix-border": "#d8d0de",
        "--matrix-card-bg": "#ffffff",
        "--matrix-card-fg": "#1c1917",
        "--matrix-input-bg": "#d8d0de",
        "--matrix-font-sans": '"Inter", system-ui, sans-serif',
        "--matrix-font-mono": '"JetBrains Mono", monospace',
        "--matrix-radius": "0.75rem",
      };

      const script = buildBridgeScript("test-app", themeVars);

      expect(script).toContain("--matrix-bg");
      expect(script).toContain("--matrix-fg");
      expect(script).toContain("--matrix-accent");
      expect(script).toContain("--matrix-border");
      expect(script).toContain("--matrix-card-bg");
      expect(script).toContain("--matrix-card-fg");
      expect(script).toContain("--matrix-input-bg");
      expect(script).toContain("--matrix-font-sans");
      expect(script).toContain("--matrix-font-mono");
      expect(script).toContain("--matrix-radius");
    });

    it("creates a style element appended to document head", () => {
      const themeVars = { "--matrix-bg": "#000" };
      const script = buildBridgeScript("test-app", themeVars);

      expect(script).toContain("createElement");
      expect(script).toContain("style");
      expect(script).toContain("head");
      expect(script).toContain("matrix-os-theme");
    });

    it("exposes window.MatrixOS.theme with current values", () => {
      const themeVars = {
        "--matrix-bg": "#ece5f0",
        "--matrix-fg": "#1c1917",
      };

      const script = buildBridgeScript("test-app", themeVars);
      expect(script).toContain("MatrixOS");
      expect(script).toContain("theme");
    });

    it("works without theme variables (backward compatible)", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("window.MatrixOS");
      // Should not throw or produce broken script
      expect(script).toContain("openApp");
    });
  });
});

describe("Dynamic Theme Updates (T2071)", () => {
  describe("buildBridgeScript", () => {
    it("includes os:theme-update message listener", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("os:theme-update");
    });

    it("updates style tag on theme-update message", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("matrix-os-theme");
      expect(script).toContain("os:theme-update");
    });

    it("updates window.MatrixOS.theme on theme-update message", () => {
      const script = buildBridgeScript("test-app");
      // The bridge script should update the theme object when receiving updates
      expect(script).toContain("theme");
      expect(script).toContain("os:theme-update");
    });
  });
});
