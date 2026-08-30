// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeDesktopMode, useDesktopMode } from "@/stores/desktop-mode";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";

describe("web desktop mode parity", () => {
  beforeEach(() => {
    useDesktopMode.setState({
      mode: "desktop",
      previousMode: null,
      _hydrated: true,
    });
    useWindowManager.setState({
      windows: [],
      focusedWindowId: null,
      apps: [],
      closedPaths: new Set(),
      closedLayouts: new Map(),
      nextZ: 1,
    });
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0 });
  });

  it("keeps Canvas selectable while Desktop remains the canonical default", () => {
    expect(useDesktopMode.getState().visibleModes().map((mode) => mode.id)).toEqual([
      "canvas",
      "desktop",
    ]);
    expect(useDesktopMode.getState().allModes().map((mode) => mode.label)).toEqual([
      "Canvas",
      "Desktop",
    ]);
  });

  it("preserves Canvas preferences while migrating removed modes into Desktop", () => {
    expect(normalizeDesktopMode("dev")).toBe("desktop");
    expect(normalizeDesktopMode("canvas")).toBe("canvas");
    expect(normalizeDesktopMode("desktop")).toBe("desktop");
    expect(normalizeDesktopMode("something-else")).toBe("desktop");
  });

  it("switches presentation without replacing the shared app model or Canvas viewport", () => {
    useWindowManager.getState().openWindow("Terminal", "__terminal__", 80);
    useCanvasTransform.setState({ zoom: 0.72, panX: 280, panY: -140 });
    const windowBeforeSwitch = useWindowManager.getState().windows[0];

    useDesktopMode.getState().setMode("canvas");
    useDesktopMode.getState().setMode("desktop");
    useDesktopMode.getState().setMode("canvas");

    expect(useWindowManager.getState().windows[0]).toEqual(windowBeforeSwitch);
    expect(useCanvasTransform.getState()).toMatchObject({
      zoom: 0.72,
      panX: 280,
      panY: -140,
    });
  });
});
