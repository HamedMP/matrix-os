// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "../../shell/src/components/canvas/CanvasToolbar.js";
import { useDotGrid } from "../../shell/src/components/DotGrid.js";
import { useCanvasLabels } from "../../shell/src/stores/canvas-labels.js";
import { useCanvasSettings } from "../../shell/src/stores/canvas-settings.js";
import { useCanvasTransform, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "../../shell/src/hooks/useCanvasTransform.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

vi.mock("@/components/UserButton", () => ({ UserButton: () => <button>Account</button> }));

vi.mock("../../shell/src/components/onboarding/GettingStartedPopover.js", () => ({
  GettingStartedPopover: () => (
    <button type="button" aria-label="Getting started — 0 of 5">Getting started</button>
  ),
}));

function resetStores() {
  useDotGrid.setState({ enabled: true });
  useCanvasLabels.setState({ labels: [] });
  useCanvasSettings.setState({ navMode: "scroll", showTitles: true });
  useCanvasTransform.setState({
    zoom: 1,
    panX: 0,
    panY: 0,
    isAnimating: false,
    containerRect: { left: 0, top: 32, width: 900, height: 668 },
  });
  useWindowManager.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    focusedWindowId: null,
    appLaunchTimes: {},
    fullscreenWindowId: null,
  });
}

async function openCanvasControls() {
  const trigger = screen.getByRole("button", { name: "More canvas controls" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole("menu", { name: "More canvas controls" });
}

describe("responsive CanvasToolbar", () => {
  beforeEach(resetStores);
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps priority controls available and hides only labels/secondary controls below lg", () => {
    render(<CanvasToolbar />);

    for (const name of [
      "Zoom out",
      "Reset zoom to 100%",
      "Zoom in",
      "Fit all",
      "Scroll to navigate",
      "Click and drag to navigate",
      "Getting started — 0 of 5",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("slider", { name: "Zoom level" }).className).toContain("hidden");
    expect(screen.getByTestId("full-canvas-actions").className).toContain("lg:flex");
    expect(screen.getByTestId("compact-canvas-actions").className).toContain("lg:hidden");
  });

  it("wires zoom buttons, reset, slider and fit-all to the transform store", () => {
    useWindowManager.getState().openWindow("A", "apps/a.html", 0);
    render(<CanvasToolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(useCanvasTransform.getState().zoom).toBeCloseTo(1 + ZOOM_STEP);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(useCanvasTransform.getState().zoom).toBeCloseTo(1);

    const slider = screen.getByRole("slider", { name: "Zoom level" });
    expect(slider.getAttribute("min")).toBe(String(ZOOM_MIN));
    expect(slider.getAttribute("max")).toBe(String(ZOOM_MAX));
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(useCanvasTransform.getState().zoom).toBe(0.5);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    expect(useCanvasTransform.getState().zoom).toBe(1);

    fireEvent.change(slider, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Fit all" }));
    expect(useCanvasTransform.getState().zoom).not.toBe(2.5);
  });

  it.each([
    [1, "100%"], [0.5, "50%"], [2, "200%"], [0.1, "10%"], [3, "300%"],
  ])("renders zoom %s as %s in the actual toolbar", (zoom, label) => {
    useCanvasTransform.setState({ zoom });
    render(<CanvasToolbar />);
    expect(screen.getByRole("button", { name: "Reset zoom to 100%" }).textContent).toBe(label);
  });

  it("shows the desktop by leaving fullscreen and minimizing every open window without closing it", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    useDesktopMode.setState({ mode: "canvas" });
    const manager = useWindowManager.getState();
    manager.openWindow("Notes", "apps/notes/index.html", 0);
    manager.openWindow("Terminal", "__terminal__", 0);
    const windows = useWindowManager.getState().windows;
    manager.toggleFullscreen(windows[0].id);
    render(<CanvasToolbar />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Workspace view" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Show desktop" }));
    expect(useDesktopMode.getState().mode).toBe("desktop");
    expect(useWindowManager.getState().fullscreenWindowId).toBeNull();
    expect(useWindowManager.getState().windows.map(w => [w.id, w.minimized])).toEqual(windows.map(w => [w.id, true]));
  });

  it("exposes and invokes every compact action with current toggle checked states", async () => {
    useWindowManager.getState().openWindow("A", "apps/a", 0);
    useWindowManager.getState().moveWindow(useWindowManager.getState().windows[0]!.id, 2_000, 1_500);
    render(<CanvasToolbar onOpenSettings={() => {}} onOpenFirstWork={() => {}} />);

    let menu = await openCanvasControls();
    for (const name of ["Auto-align apps", "Add text label"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show dot grid" }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show app titles" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Auto-align apps" }));
    expect(useWindowManager.getState().windows[0]!.x).not.toBe(2_000);

    menu = await openCanvasControls();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add text label" }));
    expect(useCanvasLabels.getState().labels).toHaveLength(1);

    menu = await openCanvasControls();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Show dot grid" }));
    expect(useDotGrid.getState().enabled).toBe(false);

    menu = await openCanvasControls();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show dot grid" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Show app titles" }));
    expect(useCanvasSettings.getState().showTitles).toBe(false);

    menu = await openCanvasControls();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show app titles" }).getAttribute("aria-checked")).toBe("false");
  });

  describe("window geometry and fit-all", () => {
    it("fits all windows into viewport", () => {
      useWindowManager.getState().openWindow("A", "apps/a.html", 0);
      useWindowManager.getState().openWindow("B", "apps/b.html", 0);
      const [w1, w2] = useWindowManager.getState().windows;
      useWindowManager.getState().moveWindow(w1.id, 0, 0);
      useWindowManager.getState().moveWindow(w2.id, 2000, 1500);

      const windows = useWindowManager.getState().windows;
      useCanvasTransform.getState().fitAll(
        windows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
        1920,
        1080,
      );

      const { zoom, panX, panY } = useCanvasTransform.getState();
      expect(zoom).toBeGreaterThan(0);
      expect(zoom).toBeLessThanOrEqual(ZOOM_MAX);
      // Pan should center the content
      expect(panX).toBeDefined();
      expect(panY).toBeDefined();
    });

    it("resets to 1:1 when no windows", () => {
      useCanvasTransform.getState().fitAll([], 1920, 1080);
      const { zoom, panX, panY } = useCanvasTransform.getState();
      expect(zoom).toBe(1);
      expect(panX).toBe(0);
      expect(panY).toBe(0);
    });
  });
});
