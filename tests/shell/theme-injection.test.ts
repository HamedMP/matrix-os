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
        "--card": "--matrix-card",
        "--card-foreground": "--matrix-card-fg",
        "--popover": "--matrix-popover",
        "--popover-foreground": "--matrix-popover-fg",
        "--secondary": "--matrix-secondary",
        "--secondary-foreground": "--matrix-secondary-fg",
        "--muted": "--matrix-muted",
        "--muted-foreground": "--matrix-muted-fg",
        "--primary": "--matrix-primary",
        "--primary-foreground": "--matrix-primary-fg",
        "--forest": "--matrix-brand-primary",
        "--deep": "--matrix-brand-deep",
        "--ember": "--matrix-accent",
        "--ember-foreground": "--matrix-accent-fg",
        "--destructive": "--matrix-destructive",
        "--success": "--matrix-success",
        "--warning": "--matrix-warning",
        "--border": "--matrix-border",
        "--input": "--matrix-input",
        "--ring": "--matrix-ring",
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
            "--background": "#FAFAF9",
            "--foreground": "#32352E",
            "--card": "#FCFCF8",
            "--card-foreground": "#32352E",
            "--popover": "#FCFCF8",
            "--popover-foreground": "#32352E",
            "--secondary": "#F1F0E3",
            "--secondary-foreground": "#3E4339",
            "--muted": "#E1E1D0",
            "--muted-foreground": "#747668",
            "--primary": "#434E3F",
            "--primary-foreground": "#FAFAF5",
            "--forest": "#434E3F",
            "--deep": "#32352E",
            "--ember": "#D06F25",
            "--ember-foreground": "#FAFAF5",
            "--destructive": "#D74A3A",
            "--success": "#3A7D44",
            "--warning": "#E0A12E",
            "--border": "#D8D6C7",
            "--input": "#D8D6C7",
            "--ring": "#D06F25",
            "--font-sans": '"Inter", system-ui, sans-serif',
            "--font-mono": '"JetBrains Mono", monospace',
            "--radius": "0.75rem",
          };
          return vals[prop] ?? "";
        },
      } as CSSStyleDeclaration;

      const vars = getThemeVariables(mockStyle);

      expect(vars["--matrix-bg"]).toBe("#FAFAF9");
      expect(vars["--matrix-fg"]).toBe("#32352E");
      expect(vars["--matrix-card"]).toBe("#FCFCF8");
      expect(vars["--matrix-card-fg"]).toBe("#32352E");
      expect(vars["--matrix-popover"]).toBe("#FCFCF8");
      expect(vars["--matrix-popover-fg"]).toBe("#32352E");
      expect(vars["--matrix-secondary"]).toBe("#F1F0E3");
      expect(vars["--matrix-secondary-fg"]).toBe("#3E4339");
      expect(vars["--matrix-muted"]).toBe("#E1E1D0");
      expect(vars["--matrix-muted-fg"]).toBe("#747668");
      expect(vars["--matrix-primary"]).toBe("#434E3F");
      expect(vars["--matrix-primary-fg"]).toBe("#FAFAF5");
      expect(vars["--matrix-brand-primary"]).toBe("#434E3F");
      expect(vars["--matrix-brand-deep"]).toBe("#32352E");
      expect(vars["--matrix-accent"]).toBe("#D06F25");
      expect(vars["--matrix-accent-fg"]).toBe("#FAFAF5");
      expect(vars["--matrix-destructive"]).toBe("#D74A3A");
      expect(vars["--matrix-success"]).toBe("#3A7D44");
      expect(vars["--matrix-warning"]).toBe("#E0A12E");
      expect(vars["--matrix-border"]).toBe("#D8D6C7");
      expect(vars["--matrix-input"]).toBe("#D8D6C7");
      expect(vars["--matrix-ring"]).toBe("#D06F25");
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
        "--matrix-bg": "#FAFAF9",
        "--matrix-fg": "#32352E",
        "--matrix-card": "#FCFCF8",
        "--matrix-card-fg": "#32352E",
        "--matrix-primary": "#434E3F",
        "--matrix-primary-fg": "#FAFAF5",
        "--matrix-accent": "#D06F25",
        "--matrix-accent-fg": "#FAFAF5",
        "--matrix-border": "#D8D6C7",
        "--matrix-input": "#D8D6C7",
        "--matrix-font-sans": '"Inter", system-ui, sans-serif',
        "--matrix-font-mono": '"JetBrains Mono", monospace',
        "--matrix-radius": "0.75rem",
      };

      const script = buildBridgeScript("test-app", themeVars);

      expect(script).toContain("--matrix-bg");
      expect(script).toContain("--matrix-fg");
      expect(script).toContain("--matrix-primary");
      expect(script).toContain("--matrix-primary-fg");
      expect(script).toContain("--matrix-accent");
      expect(script).toContain("--matrix-accent-fg");
      expect(script).toContain("--matrix-border");
      expect(script).toContain("--matrix-card");
      expect(script).toContain("--matrix-card-fg");
      expect(script).toContain("--matrix-input");
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

describe("Design System Propagation (T2072)", () => {
  describe("buildBridgeScript design id", () => {
    it("tags the iframe document with the design id at bootstrap", () => {
      const script = buildBridgeScript("test-app", { "--matrix-bg": "#fff" }, "winxp");
      expect(script).toContain("dataset.matrixDesign");
      expect(script).toContain("winxp");
    });

    it("exposes the design id on window.MatrixOS.design", () => {
      const script = buildBridgeScript("test-app", { "--matrix-bg": "#fff" }, "macos-glass");
      expect(script).toContain("design: currentDesign");
    });

    it("includes --matrix-design in the injected theme style block", () => {
      const script = buildBridgeScript("test-app", { "--matrix-bg": "#fff" }, "win11");
      expect(script).toContain("--matrix-design: win11");
    });

    it("defaults to the flat design when no design id is passed", () => {
      const script = buildBridgeScript("test-app", { "--matrix-bg": "#fff" });
      expect(script).toContain("--matrix-design: flat");
      expect(script).toContain('"flat"');
    });

    it("sanitizes unsafe design ids to flat", () => {
      const script = buildBridgeScript("test-app", { "--matrix-bg": "#fff" }, 'x";alert(1);//');
      expect(script).toContain('"flat"');
      expect(script).not.toContain('x";alert(1);//');
    });
  });

  describe("os:theme-update design handling", () => {
    it("re-reads the design id from theme-update messages", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("e.data.design");
    });

    it("updates the data-matrix-design attribute on theme-update", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("os:theme-update");
      expect(script).toContain("dataset.matrixDesign");
    });

    it("updates MatrixOS.design on theme-update", () => {
      const script = buildBridgeScript("test-app");
      expect(script).toContain("window.MatrixOS.design = currentDesign");
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
