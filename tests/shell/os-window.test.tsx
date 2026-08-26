// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OSWindowTopBar } from "../../shell/src/components/window/OSWindow.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

const windowRecord: AppWindow = {
  id: "win-notes",
  title: "Notes",
  path: "apps/notes",
  x: 0,
  y: 0,
  width: 640,
  height: 420,
  minimized: false,
  zIndex: 1,
};

describe("OSWindowTopBar", () => {
  beforeEach(() => {
    useWindowManager.setState({
      windows: [windowRecord],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: windowRecord.id,
      fullscreenWindowId: null,
    });
  });

  it("owns the shared traffic-light lifecycle controls through the window manager", () => {
    const { rerender } = render(<OSWindowTopBar window={windowRecord} presentation="desktop" />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(useWindowManager.getState().getWindow(windowRecord.id)?.minimized).toBe(true);

    useWindowManager.getState().restoreWindow(windowRecord.id);
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(useWindowManager.getState().fullscreenWindowId).toBe(windowRecord.id);

    rerender(<OSWindowTopBar window={windowRecord} presentation="desktop" />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useWindowManager.getState().getWindow(windowRecord.id)).toBeUndefined();
  });
});
