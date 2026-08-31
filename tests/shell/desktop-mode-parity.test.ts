// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeDesktopMode, useDesktopMode } from "@/stores/desktop-mode";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { OS_VIEW_CORE_APP_FIXTURE } from "../fixtures/os-view-parity";

describe("Web Canvas and Web Desktop mode parity", () => {
  beforeEach(() => {
    useDesktopMode.setState({
      mode: "desktop",
      previousMode: null,
      _hydrated: true,
    });
    useWindowManager.setState({
      windows: [],
      focusedWindowId: null,
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

  it("keeps the shared Chat, Settings, Terminal, and Files fixture through presentation switches", () => {
    for (const [index, app] of OS_VIEW_CORE_APP_FIXTURE.entries()) {
      useWindowManager.getState().openWindow(app.name, app.path, 80 + index);
    }
    useCanvasTransform.setState({ zoom: 0.72, panX: 280, panY: -140 });
    const windowsBeforeSwitch = useWindowManager.getState().windows;

    useDesktopMode.getState().setMode("canvas");
    useDesktopMode.getState().setMode("desktop");
    useDesktopMode.getState().setMode("canvas");

    expect(useWindowManager.getState().windows).toEqual(windowsBeforeSwitch);
    expect(useWindowManager.getState().windows.map((window) => window.path)).toEqual(
      OS_VIEW_CORE_APP_FIXTURE.map((app) => app.path),
    );
    expect(useCanvasTransform.getState()).toMatchObject({
      zoom: 0.72,
      panX: 280,
      panY: -140,
    });
  });
});
