// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => <button type="button">Terminal tab one</button>,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => <iframe title="App iframe" />,
}));

vi.mock("../../shell/src/components/file-browser/FileBrowser.js", () => ({
  FileBrowser: () => null,
}));

vi.mock("../../shell/src/components/preview-window/PreviewWindow.js", () => ({
  PreviewWindow: () => null,
}));

vi.mock("../../shell/src/components/workspace/WorkspaceApp.js", () => ({
  WorkspaceApp: () => null,
}));

vi.mock("../../shell/src/components/ChatApp.js", () => ({
  ChatApp: () => null,
}));

vi.mock("../../shell/src/lib/open-app-tab.js", () => ({
  openAppInStandaloneTab: vi.fn(),
}));

const terminalWindow: AppWindow = {
  id: "win-terminal",
  title: "Terminal",
  path: "__terminal__:test",
  x: 20,
  y: 30,
  width: 640,
  height: 420,
  minimized: false,
  zIndex: 1,
};

const iframeWindow: AppWindow = {
  ...terminalWindow,
  id: "win-app",
  title: "Notes",
  path: "apps/notes",
};

describe("CanvasWindow terminal interactivity", () => {
  beforeEach(() => {
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false, isScrolling: false });
    useWindowManager.setState({
      windows: [],
      nextZ: 1,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: null,
      fullscreenWindowId: null,
    });
  });

  it("does not render the iframe click shield over built-in terminal controls", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(screen.getByRole("button", { name: "Terminal tab one" })).toBeTruthy();
    expect(container.querySelector("[data-canvas-interaction-overlay], .absolute.inset-0.z-10")).toBeNull();
  });

  it("keeps the click shield for iframe app windows", () => {
    const { container } = render(<CanvasWindow win={iframeWindow} />);

    expect(container.querySelector("[data-canvas-interaction-overlay], .absolute.inset-0.z-10")).toBeTruthy();
  });
});
