// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDesktopMode, type DesktopMode } from "../../shell/src/stores/desktop-mode.js";

// Fault detected: synchronous localStorage rehydration runs while the store is still
// being created, so `_hydrated` never turns true and `?launch=` and the startup Chat never open.
describe("Desktop Mode Store hydration", () => {
  it("marks the store hydrated after synchronous localStorage rehydration", async () => {
    vi.resetModules();
    window.localStorage.setItem("matrix-os-desktop-mode", JSON.stringify({ state: { mode: "canvas" }, version: 0 }));
    const fresh = await import("../../shell/src/stores/desktop-mode.js");
    await Promise.resolve();
    expect(fresh.useDesktopMode.getState().mode).toBe("canvas");
    expect(fresh.useDesktopMode.getState()._hydrated).toBe(true);
    expect(fresh.useDesktopMode.persist.hasHydrated()).toBe(true);
    window.localStorage.removeItem("matrix-os-desktop-mode");
  });
});

describe("Desktop Mode Store", () => {
  beforeEach(() => {
    useDesktopMode.setState({ mode: "desktop", previousMode: null });
  });

  it("defaults to the canonical desktop renderer", () => {
    expect(useDesktopMode.getState().mode).toBe("desktop");
  });

  it("setMode changes the active mode", () => {
    useDesktopMode.getState().setMode("canvas");
    expect(useDesktopMode.getState().mode).toBe("canvas");
  });

  it("supports the two live modes", () => {
    const modes: DesktopMode[] = ["canvas", "desktop"];
    for (const mode of modes) {
      useDesktopMode.getState().setMode(mode);
      expect(useDesktopMode.getState().mode).toBe(mode);
    }
  });

  it("allModes returns only live modes with canvas first", () => {
    const modes = useDesktopMode.getState().allModes();
    expect(modes).toHaveLength(2);
    expect(modes.map((m) => m.id)).toEqual(["canvas", "desktop"]);
  });

  it("visibleModes exposes Canvas and Desktop", () => {
    const modes = useDesktopMode.getState().visibleModes();
    expect(modes.map((m) => m.id)).toEqual(["canvas", "desktop"]);
  });

  it("setMode tracks previousMode", () => {
    expect(useDesktopMode.getState().previousMode).toBeNull();
    useDesktopMode.getState().setMode("canvas");
    expect(useDesktopMode.getState().previousMode).toBe("desktop");
    expect(useDesktopMode.getState().mode).toBe("canvas");
    useDesktopMode.getState().setMode("desktop");
    expect(useDesktopMode.getState().previousMode).toBe("canvas");
    expect(useDesktopMode.getState().mode).toBe("desktop");
  });
});
