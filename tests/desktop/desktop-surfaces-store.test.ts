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

  it("allows unbounded coordinates while arranging the infinite Canvas", () => {
    useDesktopSurfaces.getState().reconcileTabs(["files"], { width: 900, height: 620 });
    useDesktopSurfaces.getState().setSurfaceBounds(
      "files",
      { x: -4_000, y: 8_000, width: 700, height: 500 },
      { width: 900, height: 620 },
      false,
    );

    expect(useDesktopSurfaces.getState().surfaces.files?.bounds).toEqual({
      x: -4_000,
      y: 8_000,
      width: 700,
      height: 500,
    });
  });

  it("preserves unbounded Canvas coordinates while reconciling retained tabs", () => {
    useDesktopSurfaces.getState().reconcileTabs(["files"], { width: 900, height: 620 });
    useDesktopSurfaces.getState().setSurfaceBounds(
      "files",
      { x: -4_000, y: 8_000, width: 700, height: 500 },
      { width: 900, height: 620 },
      false,
    );

    useDesktopSurfaces.getState().reconcileTabs(
      ["files", "chat"],
      { width: 1_000, height: 700 },
      false,
    );

    expect(useDesktopSurfaces.getState().surfaces.files?.bounds).toEqual({
      x: -4_000,
      y: 8_000,
      width: 700,
      height: 500,
    });
    expect(useDesktopSurfaces.getState().surfaces.chat?.bounds.x).toBeGreaterThanOrEqual(12);
  });

  it("shows the Desktop workspace independently of retained maximized tabs", () => {
    useDesktopSurfaces.getState().reconcileTabs(["terminal"], { width: 1200, height: 760 });
    useDesktopSurfaces.getState().maximizeToTab("terminal");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");

    useDesktopSurfaces.getState().setWorkspaceView("desktop");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(useDesktopSurfaces.getState().surfaces.terminal?.mode).toBe("tab");

    useDesktopSurfaces.getState().activateSurface("terminal");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
  });

  it("toggles show desktop while preserving each surface's presentation", () => {
    useDesktopSurfaces.getState().reconcileTabs(["home", "chat"], { width: 1200, height: 760 });
    useDesktopSurfaces.getState().maximizeToTab("chat");

    useDesktopSurfaces.getState().showDesktop();
    expect(useDesktopSurfaces.getState().desktopHiddenSurfaceIds).toEqual(["home", "chat"]);
    expect(useDesktopSurfaces.getState().desktopTransition?.phase).toBe("hiding");
    expect(useDesktopSurfaces.getState().surfaces.home?.mode).toBe("window");
    expect(useDesktopSurfaces.getState().surfaces.chat?.mode).toBe("tab");

    useDesktopSurfaces.getState().showDesktop();
    expect(useDesktopSurfaces.getState().desktopHiddenSurfaceIds).toEqual([]);
    expect(useDesktopSurfaces.getState().desktopTransition?.phase).toBe("restoring");
    expect(useDesktopSurfaces.getState().surfaces.home?.mode).toBe("window");
    expect(useDesktopSurfaces.getState().surfaces.chat?.mode).toBe("tab");
  });

  it("returns to the desktop when a window is activated or the last tab surface disappears", () => {
    useDesktopSurfaces.getState().reconcileTabs(["terminal", "files"], { width: 1200, height: 760 });
    useDesktopSurfaces.getState().maximizeToTab("terminal");

    useDesktopSurfaces.getState().activateSurface("files");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");

    useDesktopSurfaces.getState().maximizeToTab("terminal");
    useDesktopSurfaces.getState().reconcileTabs(["files"], { width: 1200, height: 760 });
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
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
