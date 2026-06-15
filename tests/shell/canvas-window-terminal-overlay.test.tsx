// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

const appViewerRender = vi.hoisted(() => vi.fn());
const terminalRender = vi.hoisted(() => vi.fn());

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: (props: unknown) => {
    terminalRender(props);
    return <button type="button">Terminal tab one</button>;
  },
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: (props: { path: string }) => {
    appViewerRender(props);
    return <iframe title="App iframe" />;
  },
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
    appViewerRender.mockClear();
    terminalRender.mockClear();
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
    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeNull();
  });

  it("lets Terminal own Canvas chrome and passes window controls into it", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(container.textContent).toBe("Terminal tab one");
    expect(terminalRender).toHaveBeenCalledWith(expect.objectContaining({
      launchTargetId: "win-terminal",
      windowControls: expect.objectContaining({
        close: expect.any(Function),
        minimize: expect.any(Function),
        toggleFullscreen: expect.any(Function),
      }),
    }));
  });

  it("keeps the click shield for iframe app windows", () => {
    const { container } = render(<CanvasWindow win={iframeWindow} />);

    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeTruthy();
  });

  it("does not mount AppViewer when Canvas defers offscreen app content", () => {
    const { container } = render(<CanvasWindow win={iframeWindow} deferAppContent />);

    expect(appViewerRender).not.toHaveBeenCalled();
    expect(screen.queryByTitle("App iframe")).toBeNull();
    expect(screen.getByLabelText("Notes will load when visible")).toBeTruthy();
    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeTruthy();
  });
});
