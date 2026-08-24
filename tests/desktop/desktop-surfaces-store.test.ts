import { beforeEach, describe, expect, it } from "vitest";
import {
  desktopSurfaceBounds,
  useDesktopSurfaces,
} from "@desktop/renderer/src/stores/desktop-surfaces";
import { DESKTOP_Z_INDEX } from "@desktop/renderer/src/design/layering";

beforeEach(() => {
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
});

describe("desktop surfaces store", () => {
  it("reconciles tabs into bounded cascading windows", () => {
    useDesktopSurfaces.getState().reconcileTabs(
      ["home", "chat", "terminal"],
      { width: 1200, height: 760 },
    );

    const state = useDesktopSurfaces.getState();
    expect(Object.keys(state.surfaces)).toEqual(["home", "chat", "terminal"]);
    expect(state.surfaces.home).toMatchObject({ mode: "window", restoreMode: "window" });
    expect(state.surfaces.chat!.bounds.x).toBeGreaterThan(state.surfaces.home!.bounds.x);
    expect(state.surfaces.terminal!.bounds.y).toBeGreaterThan(state.surfaces.chat!.bounds.y);
    for (const surface of Object.values(state.surfaces)) {
      expect(surface.bounds.x).toBeGreaterThanOrEqual(12);
      expect(surface.bounds.y).toBeGreaterThanOrEqual(12);
      expect(surface.bounds.x + surface.bounds.width).toBeLessThanOrEqual(1200 - 12);
      expect(surface.bounds.y + surface.bounds.height).toBeLessThanOrEqual(760 - 12);
    }
  });

  it("minimizes and restores windows without losing their previous presentation", () => {
    useDesktopSurfaces.getState().reconcileTabs(["chat"], { width: 1200, height: 760 });
    useDesktopSurfaces.getState().maximizeToTab("chat");
    useDesktopSurfaces.getState().minimizeSurface("chat");

    expect(useDesktopSurfaces.getState().surfaces.chat).toMatchObject({
      mode: "minimized",
      restoreMode: "tab",
    });

    useDesktopSurfaces.getState().restoreSurface("chat");
    expect(useDesktopSurfaces.getState().surfaces.chat?.mode).toBe("tab");
  });

  it("restores a maximized tab to its last floating bounds", () => {
    useDesktopSurfaces.getState().reconcileTabs(["chat"], { width: 1200, height: 760 });
    const originalBounds = useDesktopSurfaces.getState().surfaces.chat!.bounds;

    useDesktopSurfaces.getState().maximizeToTab("chat");
    useDesktopSurfaces.getState().restoreAsWindow("chat");

    expect(useDesktopSurfaces.getState().surfaces.chat).toMatchObject({
      mode: "window",
      bounds: originalBounds,
    });
  });

  it("closes retained roots, reopens them, and removes deleted tabs", () => {
    useDesktopSurfaces.getState().reconcileTabs(["home", "chat"], { width: 1200, height: 760 });
    useDesktopSurfaces.getState().closeSurface("home");
    expect(useDesktopSurfaces.getState().surfaces.home?.mode).toBe("closed");

    useDesktopSurfaces.getState().activateSurface("home");
    expect(useDesktopSurfaces.getState().surfaces.home?.mode).toBe("window");

    useDesktopSurfaces.getState().reconcileTabs(["home"], { width: 1200, height: 760 });
    expect(useDesktopSurfaces.getState().surfaces.chat).toBeUndefined();
  });

  it("clamps moved and resized windows to the available desktop", () => {
    useDesktopSurfaces.getState().reconcileTabs(["files"], { width: 900, height: 620 });
    useDesktopSurfaces.getState().setSurfaceBounds(
      "files",
      { x: -500, y: -400, width: 2_000, height: 1_500 },
      { width: 900, height: 620 },
    );

    expect(useDesktopSurfaces.getState().surfaces.files?.bounds).toEqual(
      desktopSurfaceBounds({ x: -500, y: -400, width: 2_000, height: 1_500 }, { width: 900, height: 620 }),
    );
  });

  it("keeps every ordinary window and the taskbar below renderer dialogs", () => {
    useDesktopSurfaces.getState().reconcileTabs(["home", "chat"], { width: 1200, height: 760 });
    for (let index = 0; index < 80; index += 1) {
      useDesktopSurfaces.getState().focusSurface(index % 2 === 0 ? "home" : "chat");
    }

    expect(Math.max(...Object.values(useDesktopSurfaces.getState().surfaces).map((surface) => surface.zIndex)))
      .toBeLessThanOrEqual(DESKTOP_Z_INDEX.nativeDesktopWindowMax);
    expect(DESKTOP_Z_INDEX.nativeDesktopWindowMax).toBeLessThan(DESKTOP_Z_INDEX.nativeDesktopTaskbar);
    expect(DESKTOP_Z_INDEX.nativeDesktopTaskbar).toBeLessThan(DESKTOP_Z_INDEX.dialog);
    expect(DESKTOP_Z_INDEX.dialog).toBeLessThan(DESKTOP_Z_INDEX.popover);
  });

  it("keeps normalized window layers as valid integer z-index values", () => {
    const tabIds = Array.from({ length: 40 }, (_, index) => `tab-${index}`);
    useDesktopSurfaces.getState().reconcileTabs(tabIds, { width: 1200, height: 760 });
    useDesktopSurfaces.getState().focusSurface(tabIds[0]!);

    for (const surface of Object.values(useDesktopSurfaces.getState().surfaces)) {
      expect(Number.isInteger(surface.zIndex)).toBe(true);
      expect(surface.zIndex).toBeLessThanOrEqual(DESKTOP_Z_INDEX.nativeDesktopWindowMax);
    }
  });
});
