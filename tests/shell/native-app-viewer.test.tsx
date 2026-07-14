// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { DesktopWindow } from "../../shell/src/components/desktop/DesktopWindow.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

const appViewerRender = vi.hoisted(() => vi.fn());
const nativeViewerRender = vi.hoisted(() => vi.fn());

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: (props: { path: string }) => {
    appViewerRender(props);
    return <iframe title="regular app viewer" />;
  },
}));

vi.mock("../../shell/src/components/NativeAppViewer.js", () => ({
  NativeAppViewer: (props: { appId: string; windowId: string }) => {
    nativeViewerRender(props);
    return <iframe title="native app viewer" />;
  },
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
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

const nativeWindow: AppWindow = {
  id: "win-native",
  title: "Xterm",
  path: "native:xterm",
  x: 20,
  y: 30,
  width: 900,
  height: 640,
  minimized: false,
  zIndex: 1,
};

describe("Native Linux app shell routing", () => {
  beforeEach(() => {
    appViewerRender.mockClear();
    nativeViewerRender.mockClear();
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

  it("renders NativeAppViewer for native app paths in Canvas instead of AppViewer", async () => {
    render(<CanvasWindow win={nativeWindow} />);

    expect(await screen.findByTitle("native app viewer")).toBeTruthy();
    await waitFor(() => {
      expect(nativeViewerRender).toHaveBeenCalledWith({ appId: "xterm", windowId: "win-native" });
    });
    expect(appViewerRender).not.toHaveBeenCalled();
  });

  it("renders NativeAppViewer for native app paths in Desktop instead of AppViewer", async () => {
    render(
      <DesktopWindow
        win={nativeWindow}
        dockPosition="bottom"
        fullscreenWindowId={null}
        interacting={false}
        minimizingIds={new Set()}
        onAnimateMinimize={vi.fn()}
        onCloseWindow={vi.fn()}
        onDragEnd={vi.fn()}
        onDragMove={vi.fn()}
        onDragStart={vi.fn()}
        onFocusWindow={vi.fn()}
        onOpenWindow={vi.fn()}
        onResizeEnd={vi.fn()}
        onResizeMove={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(await screen.findByTitle("native app viewer")).toBeTruthy();
    await waitFor(() => {
      expect(nativeViewerRender).toHaveBeenCalledWith({ appId: "xterm", windowId: "win-native" });
    });
    expect(appViewerRender).not.toHaveBeenCalled();
  });

  it("defers an initially minimized Desktop native app but preserves it after first visibility", async () => {
    const callbacks = {
      onAnimateMinimize: vi.fn(),
      onCloseWindow: vi.fn(),
      onDragEnd: vi.fn(),
      onDragMove: vi.fn(),
      onDragStart: vi.fn(),
      onFocusWindow: vi.fn(),
      onOpenWindow: vi.fn(),
      onResizeEnd: vi.fn(),
      onResizeMove: vi.fn(),
      onResizeStart: vi.fn(),
      onToggleFullscreen: vi.fn(),
    };
    const renderWindow = (minimized: boolean) => (
      <DesktopWindow
        win={{ ...nativeWindow, minimized }}
        dockPosition="bottom"
        fullscreenWindowId={null}
        interacting={false}
        minimizingIds={new Set()}
        {...callbacks}
      />
    );
    const view = render(renderWindow(true));

    expect(screen.queryByTitle("native app viewer")).toBeNull();
    expect(nativeViewerRender).not.toHaveBeenCalled();

    view.rerender(renderWindow(false));
    expect(await screen.findByTitle("native app viewer")).toBeTruthy();

    view.rerender(renderWindow(true));
    expect(screen.getByTitle("native app viewer")).toBeTruthy();
  });
});
