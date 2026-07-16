// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandPanel } from "../../desktop/src/renderer/src/design/BrandPanel";
import { applyUnifiedTheme } from "../../desktop/src/renderer/src/design/themes/apply";

afterEach(() => {
  cleanup();
  // Reset any inline overrides a test applied to <html>.
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-id");
});

function renderPanel() {
  return render(
    <BrandPanel
      title="Code on your cloud computer"
      subtitle="Every user gets a private VPS."
      bullets={[{ icon: <span />, label: "No local setup required" }]}
    />,
  );
}

describe("BrandPanel brand pinning", () => {
  it("paints the backdrop from pinned brand tokens, not theme-managed forest variables", () => {
    const { container } = renderPanel();
    const panel = container.firstElementChild as HTMLElement;
    const background = panel.style.background;

    // The sign-in brand panel is a pre-auth brand surface: it must keep the
    // Matrix forest + orange look in every workspace theme. Theme-managed
    // --forest* variables are repainted per theme (apply.ts), so the panel
    // may not consume them.
    expect(background).toContain("var(--brand-forest)");
    expect(background).toMatch(/var\(--brand-forest-deep\)/);
    expect(background).not.toMatch(/var\(--forest[)\-]/);
    expect(panel.style.color).toBe("var(--brand-forest-foreground)");
  });

  it("recolors the visible logo mark with the pinned brand foreground", () => {
    renderPanel();
    const mark = screen.getByTestId("matrix-brand-visible-mark");
    expect(mark.style.background).toBe("var(--brand-forest-foreground)");
  });

  it("keeps brand tokens unmanaged when a non-matrix theme is applied", () => {
    applyUnifiedTheme("solarized", "light");
    const inline = document.documentElement.style;

    // The theme engine repaints --forest* (used by themed chrome like
    // tooltips) but must never touch the pinned --brand-* tokens.
    expect(inline.getPropertyValue("--forest")).not.toBe("");
    expect(inline.getPropertyValue("--brand-forest")).toBe("");
    expect(inline.getPropertyValue("--brand-forest-deep")).toBe("");
    expect(inline.getPropertyValue("--brand-forest-foreground")).toBe("");
    expect(inline.getPropertyValue("--brand-forest-muted")).toBe("");
  });
});
