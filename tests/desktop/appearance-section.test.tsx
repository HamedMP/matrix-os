// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppearanceSection from "../../desktop/src/renderer/src/features/settings/sections/AppearanceSection";
import { DEFAULT_THEME_ID, unifiedThemes } from "../../desktop/src/renderer/src/design/themes";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";

describe("AppearanceSection", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    useAppearance.setState({ mode: "system", themeId: DEFAULT_THEME_ID, hydrated: true });
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
    render(<AppearanceSection />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(unifiedThemes.length);
    expect(screen.getByRole("radio", { name: "Use Operator theme" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Use Matrix theme" })).not.toBeNull();
  });

  it("selects a theme, applies it, and persists it", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("radio", { name: "Use Dracula theme" }));

    expect(useAppearance.getState().themeId).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("dracula");
    expect(invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { theme: "system", themeId: "dracula" },
    });
  });

  it("moves between theme swatches with arrow keys", () => {
    render(<AppearanceSection />);

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
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(useAppearance.getState().mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
