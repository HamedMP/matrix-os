// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

const appViewerRender = vi.hoisted(() => vi.fn());
const terminalRender = vi.hoisted(() => vi.fn());

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: (props: unknown) => {
    terminalRender(props);
    return (
      <button
        type="button"
        onPointerDown={() => {
          const recorder = (globalThis as { __recordTerminalPointerFocus?: () => void }).__recordTerminalPointerFocus;
          recorder?.();
        }}
      >
        Terminal tab one
      </button>
    );
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

  afterEach(() => {
    delete (globalThis as { __recordTerminalPointerFocus?: () => void }).__recordTerminalPointerFocus;
    vi.useRealTimers();
  });

  it("does not render the iframe click shield over built-in terminal controls", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(screen.getByRole("button", { name: "Terminal tab one" })).toBeTruthy();
    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeNull();
  });

  it("focuses terminal Canvas windows during capture before terminal child handling", () => {
    useWindowManager.setState({
      windows: [terminalWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: null,
      fullscreenWindowId: null,
    });
    const childFocusStates: Array<string | null> = [];
    (globalThis as { __recordTerminalPointerFocus?: () => void }).__recordTerminalPointerFocus = () => {
      childFocusStates.push(useWindowManager.getState().focusedWindowId);
    };

    render(<CanvasWindow win={terminalWindow} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminal tab one" }), { button: 0 });

    expect(childFocusStates).toEqual(["win-terminal"]);
    expect(useWindowManager.getState().focusedWindowId).toBe("win-terminal");
  });

  it("does not draw the generic Canvas focus ring around terminal content", () => {
    useWindowManager.setState({
      windows: [terminalWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: "win-terminal",
      fullscreenWindowId: null,
    });

    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(container.innerHTML).not.toContain("ring-primary/30");
  });

  it("lets Terminal own Canvas chrome and passes window controls into it", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(container.textContent).toContain("Terminal tab one");
    expect(terminalRender).toHaveBeenCalledWith(expect.objectContaining({
      launchTargetId: "win-terminal",
      windowControls: expect.objectContaining({
        close: expect.any(Function),
        minimize: expect.any(Function),
        toggleFullscreen: expect.any(Function),
        dragHandleProps: expect.objectContaining({
          onPointerDown: expect.any(Function),
          onPointerMove: expect.any(Function),
          onPointerUp: expect.any(Function),
          onPointerCancel: expect.any(Function),
          onDoubleClick: expect.any(Function),
        }),
      }),
    }));
  });

  it("moves terminal Canvas windows through the delegated Terminal chrome drag handle", () => {
    useWindowManager.setState({
      windows: [terminalWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: null,
      fullscreenWindowId: null,
    });
    render(<CanvasWindow win={terminalWindow} />);

    const props = terminalRender.mock.lastCall?.[0] as {
      windowControls: {
        dragHandleProps: {
          onPointerDown: (event: unknown) => void;
          onPointerMove: (event: unknown) => void;
          onPointerUp: () => void;
        };
      };
    };
    const target = { setPointerCapture: vi.fn() };
    act(() => {
      props.windowControls.dragHandleProps.onPointerDown({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 100,
        clientY: 120,
        pointerId: 1,
        target,
      });
      props.windowControls.dragHandleProps.onPointerMove({
        clientX: 132,
        clientY: 148,
      });
      props.windowControls.dragHandleProps.onPointerUp();
    });

    expect(useWindowManager.getState().getWindow("win-terminal")).toMatchObject({
      x: 52,
      y: 58,
    });
  });

  it("animates Canvas terminal minimize before marking the window minimized", () => {
    vi.useFakeTimers();
    useWindowManager.setState({
      windows: [terminalWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: "win-terminal",
      fullscreenWindowId: null,
    });
    const { container } = render(<CanvasWindow win={terminalWindow} />);
    const props = terminalRender.mock.lastCall?.[0] as {
      windowControls: {
        minimize: () => void;
      };
    };

    act(() => {
      props.windowControls.minimize();
    });

    const wrapper = container.querySelector("[data-canvas-window]") as HTMLElement;
    expect(useWindowManager.getState().getWindow("win-terminal")?.minimized).toBe(false);
    expect(wrapper.style.transition).toContain("transform");
    expect(wrapper.style.opacity).toBe("0");

    act(() => {
      vi.advanceTimersByTime(280);
    });

    expect(useWindowManager.getState().getWindow("win-terminal")?.minimized).toBe(true);
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
