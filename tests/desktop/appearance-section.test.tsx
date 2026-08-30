// @vitest-environment jsdom

import * as Tooltip from "@radix-ui/react-tooltip";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppearanceSection from "../../desktop/src/renderer/src/features/settings/sections/AppearanceSection";
import { DEFAULT_THEME_ID, unifiedThemes } from "../../desktop/src/renderer/src/design/themes";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";

// IconButton uses Radix tooltips; App.tsx provides the Tooltip.Provider in
// production, so tests wrap the section the same way.
function renderSection() {
  return render(
    <Tooltip.Provider>
      <AppearanceSection />
    </Tooltip.Provider>,
  );
}

describe("AppearanceSection", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    useAppearance.setState({ mode: "system", themeId: DEFAULT_THEME_ID, zoom: 1, hydrated: true });
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn(),
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    invoke.mockImplementation(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.removeAttribute("data-theme-id");
    root.removeAttribute("style");
  });

  it("lists every unified theme as a selectable swatch", () => {
    renderSection();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(unifiedThemes.length);
    expect(screen.getByRole("radio", { name: "Use Operator theme" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Use Matrix theme" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Use Matrix Neon theme" })).not.toBeNull();
  });

  it("selects the neon Matrix theme for the whole Desktop app", () => {
    renderSection();

    fireEvent.click(screen.getByRole("radio", { name: "Use Matrix Neon theme" }));

    expect(useAppearance.getState().themeId).toBe("matrix-neon");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("matrix-neon");
  });

  it("selects a theme, applies it, and persists it", () => {
    renderSection();

    fireEvent.click(screen.getByRole("radio", { name: "Use Dracula theme" }));

    expect(useAppearance.getState().themeId).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("dracula");
    expect(invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { theme: "system", themeId: "dracula", zoom: 1 },
    });
  });

  it("moves between theme swatches with arrow keys", () => {
    renderSection();

    const selected = screen.getByRole("radio", { name: "Use Operator theme" });
    expect(selected.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Use Matrix theme" }).getAttribute("tabindex")).toBe("-1");

    // ArrowRight selects and focuses the next swatch (WAI-ARIA radio group).
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(useAppearance.getState().themeId).toBe("matrix");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Use Matrix theme" }));

    // ArrowLeft wraps backwards from the first entry.
    fireEvent.keyDown(screen.getByRole("radio", { name: "Use Matrix theme" }), { key: "ArrowLeft" });
    expect(useAppearance.getState().themeId).toBe("operator");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Use Operator theme" }), { key: "ArrowUp" });
    expect(useAppearance.getState().themeId).toBe(unifiedThemes.at(-1)?.id);
  });

  it("switches the mode through the store", () => {
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(useAppearance.getState().mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("renders the Zoom row at 100% with Reset disabled", () => {
    renderSection();

    expect(screen.getByText("Zoom")).not.toBeNull();
    expect(screen.getByText("100%")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", true);
  });

  it("steps zoom through the store and applies it via IPC", () => {
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in (⌘=)" }));

    expect(useAppearance.getState().zoom).toBe(1.1);
    expect(screen.getByText("110%")).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 1.1 });
    expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Zoom out (⌘-)" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out (⌘-)" }));

    expect(useAppearance.getState().zoom).toBe(0.9);
    expect(screen.getByText("90%")).not.toBeNull();
  });

  it("resets zoom to 100% from the Reset button", () => {
    useAppearance.getState().setZoom(1.3);
    renderSection();

    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset).toHaveProperty("disabled", false);

    fireEvent.click(reset);

    expect(useAppearance.getState().zoom).toBe(1);
    expect(invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 1 });
  });

  it("disables the steppers at the zoom bounds", () => {
    useAppearance.getState().setZoom(2);
    renderSection();

    expect(screen.getByRole("button", { name: "Zoom in (⌘=)" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Zoom out (⌘-)" })).toHaveProperty("disabled", false);
  });
});
