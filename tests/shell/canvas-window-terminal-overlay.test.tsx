// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering.js";

const appViewerRender = vi.hoisted(() => vi.fn());
const nativeAppViewerRender = vi.hoisted(() => vi.fn());
const terminalRender = vi.hoisted(() => vi.fn());
const terminalChildPointerFocusRecorder = vi.hoisted(() => vi.fn());
const originalFocusWindow = useWindowManager.getState().focusWindow;

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: (props: unknown) => {
    terminalRender(props);
    return (
      <>
        <button
          type="button"
          onPointerDown={() => {
            terminalChildPointerFocusRecorder();
          }}
        >
          Terminal tab one
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
        >
          Terminal row action
        </button>
      </>
    );
  },
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: (props: { path: string }) => {
    appViewerRender(props);
    return <iframe title="App iframe" />;
  },
}));

vi.mock("../../shell/src/components/NativeAppViewer.js", () => ({
  NativeAppViewer: (props: { appId: string; windowId: string }) => {
    nativeAppViewerRender(props);
    return <iframe title="Native app stream" />;
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

const nativeWindow: AppWindow = {
  ...terminalWindow,
  id: "win-native",
  title: "Xterm",
  path: "native:xterm",
};

describe("CanvasWindow terminal interactivity", () => {
  beforeEach(() => {
    appViewerRender.mockClear();
    nativeAppViewerRender.mockClear();
    terminalRender.mockClear();
    terminalChildPointerFocusRecorder.mockReset();
    document.getElementById("matrix-canvas-window-motion-styles")?.remove();
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false, isScrolling: false });
    useWindowManager.setState({
      windows: [],
      nextZ: 1,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: null,
      fullscreenWindowId: null,
      focusWindow: originalFocusWindow,
    });
  });

  afterEach(() => {
    useWindowManager.setState({ focusWindow: originalFocusWindow });
    vi.useRealTimers();
  });

  it("does not render the iframe click shield over built-in terminal controls", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    expect(screen.getByRole("button", { name: "Terminal tab one" })).toBeTruthy();
    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeNull();
  });

  it("keeps fullscreen Canvas windows below the settings layer", () => {
    useWindowManager.setState({
      windows: [terminalWindow],
      fullscreenWindowId: terminalWindow.id,
    });

    const { container } = render(<CanvasWindow win={terminalWindow} />);
    const wrapper = container.firstElementChild as HTMLElement;

    expect(wrapper.style.zIndex).toBe(String(SHELL_Z_INDEX.fullscreenWindow));
    expect(SHELL_Z_INDEX.fullscreenWindow).toBeLessThan(SHELL_Z_INDEX.settings);
  });

  it("focuses terminal Canvas windows during capture before terminal child handling", async () => {
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
    let focusedDuringPointer: string | null = null;
    terminalChildPointerFocusRecorder.mockImplementation(() => {
      childFocusStates.push(focusedDuringPointer);
    });
    const focusWindowSpy = vi.fn((id: string) => {
      focusedDuringPointer = id;
    });
    useWindowManager.setState({ focusWindow: focusWindowSpy });

    await act(async () => {
      render(<CanvasWindow win={terminalWindow} />);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Terminal tab one" }), { button: 0 });
      await Promise.resolve();
    });

    expect(childFocusStates).toEqual(["win-terminal"]);
    expect(focusWindowSpy).toHaveBeenCalledWith("win-terminal");
    expect(focusWindowSpy).toHaveBeenCalledTimes(1);
  });

  it("focuses terminal Canvas windows before child row actions stop mouse-down propagation", async () => {
    useWindowManager.setState({
      windows: [terminalWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: null,
      fullscreenWindowId: null,
    });
    const focusWindowSpy = vi.fn();
    useWindowManager.setState({ focusWindow: focusWindowSpy });

    await act(async () => {
      render(<CanvasWindow win={terminalWindow} />);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("button", { name: "Terminal row action" }), { button: 0 });
      await Promise.resolve();
    });

    expect(focusWindowSpy).toHaveBeenCalledWith("win-terminal");
    expect(focusWindowSpy).toHaveBeenCalledTimes(1);
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

  it("lets Terminal keep the Canvas title bar and passes window controls into it", () => {
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

  it("uses a zoom-aware dock target for Canvas terminal minimize animation", () => {
    useCanvasTransform.setState({ zoom: 2, panX: 10, panY: -4, isAnimating: false, isScrolling: false });
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
    expect(wrapper.style.getPropertyValue("--canvas-window-dock-dx")).toBe("-322px");
    expect(wrapper.style.getPropertyValue("--canvas-window-dock-dy")).toBe("22px");
  });

  it("does not run the restore animation on initial visible mount", () => {
    const { container } = render(<CanvasWindow win={terminalWindow} />);

    const wrapper = container.querySelector("[data-canvas-window]") as HTMLElement;
    expect(wrapper.style.animation).toBe("");
  });

  it("runs the restore animation only after a mounted window becomes visible again", () => {
    const { container, rerender } = render(<CanvasWindow win={terminalWindow} hidden />);

    rerender(<CanvasWindow win={terminalWindow} />);

    const wrapper = container.querySelector("[data-canvas-window]") as HTMLElement;
    expect(wrapper.style.animation).toContain("canvas-window-restore-from-dock");
  });

  it("injects Canvas window motion keyframes only once for multiple windows", () => {
    render(
      <>
        <CanvasWindow win={terminalWindow} />
        <CanvasWindow win={{ ...terminalWindow, id: "win-terminal-two", x: 120, y: 130 }} />
      </>,
    );

    expect(document.querySelectorAll("#matrix-canvas-window-motion-styles")).toHaveLength(1);
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

  it("does not mount NativeAppViewer when Canvas defers offscreen native app content", () => {
    const { container } = render(<CanvasWindow win={nativeWindow} deferAppContent />);

    expect(nativeAppViewerRender).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Native app stream")).toBeNull();
    expect(screen.getByLabelText("Xterm will load when visible")).toBeTruthy();
    expect(container.querySelector("[data-canvas-interaction-overlay]")).toBeTruthy();
  });
});
