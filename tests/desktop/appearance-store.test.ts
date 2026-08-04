// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID } from "../../desktop/src/renderer/src/design/themes";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";

describe("appearance store", () => {
  let eventListeners: Map<string, (payload: unknown) => void>;

  beforeEach(() => {
    useAppearance.setState({ mode: "system", themeId: DEFAULT_THEME_ID, zoom: 1, hydrated: false });
    eventListeners = new Map();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:get") return { value: { theme: "dark", themeId: "dracula" } };
        return { ok: true };
      }),
      on: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        eventListeners.set(channel, callback);
        return () => {
          eventListeners.delete(channel);
        };
      }),
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
      value: { theme: "system", themeId: "nord", zoom: 1 },
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
      value: { theme: "dark", themeId: "dracula", zoom: 1 },
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

  it("defaults zoom to 1 and applies the persisted factor once after hydration", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: { theme: "dark", themeId: "dracula", zoom: 1.4 } };
      return { ok: true };
    });

    expect(useAppearance.getState().zoom).toBe(1);

    await useAppearance.getState().load();

    expect(useAppearance.getState().zoom).toBe(1.4);
    expect(window.operator.invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 1.4 });
  });

  it("clamps persisted zoom values into the supported range", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: { theme: "dark", zoom: 9 } };
      return { ok: true };
    });

    await useAppearance.getState().load();

    expect(useAppearance.getState().zoom).toBe(2);
    expect(window.operator.invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 2 });
  });

  it("setZoom clamps, applies, and persists the factor", () => {
    useAppearance.getState().setZoom(5);

    expect(useAppearance.getState().zoom).toBe(2);
    expect(window.operator.invoke).toHaveBeenCalledWith("app:set-zoom", { factor: 2 });
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { theme: "system", themeId: DEFAULT_THEME_ID, zoom: 2 },
    });
  });

  it("setZoom snaps fractional steps onto the 0.1 grid", () => {
    useAppearance.getState().setZoom(1.26);

    expect(useAppearance.getState().zoom).toBe(1.3);
  });

  it("mirrors menu-driven zoom changes without re-applying them", async () => {
    await useAppearance.getState().load();
    const zoomChanged = eventListeners.get("app:zoom-changed");
    expect(zoomChanged).toBeTruthy();
    vi.mocked(window.operator.invoke).mockClear();

    zoomChanged?.({ factor: 0.8 });

    expect(useAppearance.getState().zoom).toBe(0.8);
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "appearance",
      value: { theme: "dark", themeId: "dracula", zoom: 0.8 },
    });
    // Main already applied the factor for a menu step; the renderer must not
    // echo it back through app:set-zoom.
    expect(window.operator.invoke).not.toHaveBeenCalledWith("app:set-zoom", expect.anything());
  });
});
