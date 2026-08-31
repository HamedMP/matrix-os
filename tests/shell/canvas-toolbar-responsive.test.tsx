// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "../../shell/src/components/canvas/CanvasToolbar.js";
import { useDotGrid } from "../../shell/src/components/DotGrid.js";
import { useCanvasLabels } from "../../shell/src/stores/canvas-labels.js";
import { useCanvasSettings } from "../../shell/src/stores/canvas-settings.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

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

  it("keeps priority controls available and hides only labels/secondary controls below lg", () => {
    render(<CanvasToolbar />);

    for (const name of [
      "Zoom out",
      "Reset zoom to 100%",
      "Zoom in",
      "Fit all",
      "Scroll to navigate",
      "Click and drag to navigate",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("slider", { name: "Zoom level" }).className).toContain("hidden");
    expect(screen.getByTestId("full-canvas-actions").className).toContain("lg:flex");
    expect(screen.getByTestId("compact-canvas-actions").className).toContain("lg:hidden");
  });

  it("exposes and invokes every compact action with current toggle checked states", async () => {
    const onOpenGuide = vi.fn();
    useWindowManager.getState().openWindow("A", "apps/a", 0);
    useWindowManager.getState().moveWindow(useWindowManager.getState().windows[0]!.id, 2_000, 1_500);
    render(<CanvasToolbar guideVisible onOpenGuide={onOpenGuide} />);

    let menu = await openCanvasControls();
    for (const name of ["Auto-align apps", "Add text label", "Show get started guide"]) {
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
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Show get started guide" }));
    expect(onOpenGuide).toHaveBeenCalledOnce();
  });
});
