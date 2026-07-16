// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID } from "../../desktop/src/renderer/src/design/themes";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";

describe("appearance store", () => {
  beforeEach(() => {
    useAppearance.setState({ mode: "system", themeId: DEFAULT_THEME_ID, hydrated: false });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:get") return { value: { theme: "dark", themeId: "dracula" } };
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.removeAttribute("data-theme-id");
    root.removeAttribute("style");
    vi.restoreAllMocks();
  });

  it("loads the persisted theme and applies it to the document", async () => {
    await useAppearance.getState().load();

    expect(useAppearance.getState()).toMatchObject({ mode: "dark", themeId: "dracula", hydrated: true });
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg-app").length).toBeGreaterThan(0);
  });

  it("falls back to defaults for unknown persisted values", async () => {
    window.operator.invoke = vi.fn(async () => ({ value: { theme: "neon", themeId: "not-a-theme" } }));

    await useAppearance.getState().load();

    expect(useAppearance.getState()).toMatchObject({ mode: "system", themeId: DEFAULT_THEME_ID, hydrated: true });
  });

  it("applies and persists theme changes", () => {
    useAppearance.getState().setThemeId("nord");

    expect(document.documentElement.getAttribute("data-theme-id")).toBe("nord");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { theme: "system", themeId: "nord" },
    });
  });

  it("ignores unknown theme ids from callers", () => {
    useAppearance.getState().setThemeId("garbage");

    expect(useAppearance.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(window.operator.invoke).not.toHaveBeenCalledWith("state:set", expect.anything());
  });

  it("applies mode changes and keeps the theme", () => {
    useAppearance.getState().setThemeId("dracula");
    useAppearance.getState().setMode("dark");

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.operator.invoke).toHaveBeenLastCalledWith("state:set", {
      key: "appearance",
      value: { theme: "dark", themeId: "dracula" },
    });
  });

  it("hydrates and applies the default when loading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.operator.invoke = vi.fn(async () => {
      throw new Error("state unavailable");
    });
    try {
      await useAppearance.getState().load();
    } finally {
      warn.mockRestore();
    }

    expect(useAppearance.getState().hydrated).toBe(true);
    expect(document.documentElement.getAttribute("data-theme-id")).toBe(DEFAULT_THEME_ID);
  });
});
