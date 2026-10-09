// @vitest-environment jsdom

import * as Tooltip from "@radix-ui/react-tooltip";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppearanceSection from "../../desktop/src/renderer/src/features/settings/sections/AppearanceSection";
import { DEFAULT_THEME_ID, unifiedThemes } from "../../desktop/src/renderer/src/design/themes";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";
import { desktopShortcutLabel } from "../../desktop/src/renderer/src/lib/platform-labels";

const ZOOM_IN_LABEL = `Zoom in (${desktopShortcutLabel("=")})`;
const ZOOM_OUT_LABEL = `Zoom out (${desktopShortcutLabel("-")})`;

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
    invoke.mockClear();
    useAppearance.setState({ mode: "light", themeId: DEFAULT_THEME_ID, zoom: 1, hydrated: true, pending: false, error: null, fontId: "geist", monoFontId: "jetbrains", customTheme: null });
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

  it("lists every unified theme as a selectable swatch", async () => {
    renderSection();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(unifiedThemes.length);
    expect(screen.getByRole("radio", { name: "Use Matrix theme" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Use Operator theme" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Use Matrix Neon theme" })).not.toBeNull();
  });

  it("selects the neon Matrix theme for the whole Desktop app", async () => {
    renderSection();

    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Use Matrix Neon theme" })); });

    expect(useAppearance.getState().themeId).toBe("matrix-neon");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("matrix-neon");
  });

  it("selects a theme, applies it, and persists it", async () => {
    renderSection();

    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Use Dracula theme" })); });

    expect(useAppearance.getState().themeId).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("dracula");
    expect(invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { fontId: "geist", monoFontId: "jetbrains", customTheme: null, theme: "light", themeId: "dracula", zoom: 1 },
    });
  });

  it("moves between theme swatches with arrow keys", async () => {
    renderSection();

    const selected = screen.getByRole("radio", { name: "Use Matrix theme" });
    expect(selected.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Use Operator theme" }).getAttribute("tabindex")).toBe("-1");

    // ArrowRight selects and focuses the next swatch (WAI-ARIA radio group).
    await act(async () => { fireEvent.keyDown(selected, { key: "ArrowRight" }); });
    expect(useAppearance.getState().themeId).toBe("operator");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Use Operator theme" }));

    // ArrowLeft wraps backwards from the first entry.
    await act(async () => { fireEvent.keyDown(screen.getByRole("radio", { name: "Use Operator theme" }), { key: "ArrowLeft" }); });
    expect(useAppearance.getState().themeId).toBe("matrix");
    await act(async () => { fireEvent.keyDown(screen.getByRole("radio", { name: "Use Matrix theme" }), { key: "ArrowUp" }); });
    expect(useAppearance.getState().themeId).toBe(unifiedThemes.at(-1)?.id);
  });

  it("keeps keyboard focus through a pending save and blocks extra selections", async () => {
    let finishSave!: (value: { ok: boolean }) => void;
    invoke.mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
    renderSection();
    const matrix = screen.getByRole("radio", { name: "Use Matrix theme" });
    matrix.focus();
    await act(async () => { fireEvent.keyDown(matrix, { key: "ArrowRight" }); });

    const operator = screen.getByRole("radio", { name: "Use Operator theme" });
    expect(useAppearance.getState().pending).toBe(true);
    expect(operator).toHaveProperty("disabled", false);
    expect(operator.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(operator);
    fireEvent.keyDown(operator, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("radio", { name: "Use Dracula theme" }));
    expect(document.activeElement).toBe(operator);
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => { finishSave({ ok: true }); });
    expect(document.activeElement).toBe(operator);
    expect(operator.getAttribute("aria-disabled")).toBe("false");
    await act(async () => { fireEvent.keyDown(operator, { key: "ArrowRight" }); });
    await act(async () => { finishSave({ ok: true }); });
    expect(useAppearance.getState().themeId).toBe("matrix-neon");
  });

  it("switches the mode through the store", async () => {
    renderSection();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dark" })); });

    expect(useAppearance.getState().mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("saves independent custom light and dark colors with the selected font", async () => {
    renderSection();
    await act(async () => { fireEvent.change(screen.getByLabelText("Interface font"), { target: { value: "inter" } }); });
    fireEvent.click(screen.getByRole("button", { name: "Create custom theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit light" }));
    fireEvent.change(screen.getByLabelText("Buttons color"), { target: { value: "#475926" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit dark" }));
    fireEvent.change(screen.getByLabelText("Buttons color"), { target: { value: "#bed77b" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save custom theme" })); });
    expect(useAppearance.getState().customTheme).toEqual({ baseThemeId: "matrix", light: { accent: "#475926" }, dark: { accent: "#bed77b" } });
    expect(useAppearance.getState().fontId).toBe("inter");
    expect(useAppearance.getState().themeId).toBe("custom");
  });

  it("renders the Zoom row at 100% with Reset disabled", async () => {
    renderSection();

    expect(screen.getByText("Zoom")).not.toBeNull();
    expect(screen.getByText("100%")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", true);
  });

  it("steps zoom through the store and applies it via IPC", async () => {
    renderSection();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: ZOOM_IN_LABEL })); });

    expect(useAppearance.getState().zoom).toBe(1.1);
    expect(screen.getByText("110%")).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 1.1 });
    expect(screen.getByRole("button", { name: "Reset" })).toHaveProperty("disabled", false);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: ZOOM_OUT_LABEL })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: ZOOM_OUT_LABEL })); });

    expect(useAppearance.getState().zoom).toBe(0.9);
    expect(screen.getByText("90%")).not.toBeNull();
  });

  it("resets zoom to 100% from the Reset button", async () => {
    useAppearance.getState().setZoom(1.3);
    renderSection();

    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset).toHaveProperty("disabled", false);

    await act(async () => { fireEvent.click(reset); });

    expect(useAppearance.getState().zoom).toBe(1);
    expect(invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 1 });
  });

  it("disables the steppers at the zoom bounds", async () => {
    useAppearance.getState().setZoom(2);
    renderSection();

    expect(screen.getByRole("button", { name: ZOOM_IN_LABEL })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: ZOOM_OUT_LABEL })).toHaveProperty("disabled", false);
  });
});
