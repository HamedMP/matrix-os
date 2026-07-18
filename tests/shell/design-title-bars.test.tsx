// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow.js";
import { DesignCaptionButtons } from "../../shell/src/components/window/DesignCaptionButtons.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
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

vi.mock("../../shell/src/components/system-activity/ActivityMonitorApp.js", () => ({
  ActivityMonitorApp: () => null,
}));

vi.mock("../../shell/src/lib/open-app-tab.js", () => ({
  openAppInStandaloneTab: vi.fn(),
}));

const appWindow: AppWindow = {
  id: "win-app",
  title: "Notes",
  path: "apps/notes",
  x: 20,
  y: 30,
  width: 640,
  height: 420,
  minimized: false,
  zIndex: 1,
};

describe("CanvasWindow design-system title bars", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme-style");
    document.getElementById("matrix-canvas-window-motion-styles")?.remove();
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false, isScrolling: false });
    useWindowManager.setState({
      windows: [appWindow],
      nextZ: 2,
      closedPaths: new Set(),
      closedLayouts: new Map(),
      apps: [],
      focusedWindowId: appWindow.id,
      fullscreenWindowId: null,
    });
  });

  // The useThemeStyle hook mirrors data-theme-style via an effect + a
  // MutationObserver whose callbacks are microtasks; flush both inside act.
  async function renderWindow() {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<CanvasWindow win={appWindow} />);
      await Promise.resolve();
    });
    return result;
  }

  it("keeps the default mac chrome with traffic lights when no design style is set", async () => {
    const { container } = await renderWindow();

    expect(container.querySelector("[data-title-bar]")).toBeNull();
    expect(container.querySelector("[data-caption-buttons]")).toBeNull();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
  });

  it("renders frosted glass chrome with traffic lights for macos-glass", async () => {
    document.documentElement.setAttribute("data-theme-style", "macos-glass");
    const { container } = await renderWindow();

    expect(container.querySelector('[data-title-bar="macos-glass"]')).toBeTruthy();
    expect(container.querySelector("[data-caption-buttons]")).toBeNull();
    // macos-glass keeps the mac traffic lights.
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
  });

  it("renders Luna caption buttons instead of traffic lights for winxp", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    const { container } = await renderWindow();

    expect(container.querySelector('[data-title-bar="winxp"]')).toBeTruthy();
    expect(container.querySelector('[data-caption-buttons="winxp"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    // No mac traffic lights in the Windows styles.
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
  });

  it("renders Fluent caption buttons instead of traffic lights for win11", async () => {
    document.documentElement.setAttribute("data-theme-style", "win11");
    const { container } = await renderWindow();

    expect(container.querySelector('[data-title-bar="win11"]')).toBeTruthy();
    expect(container.querySelector('[data-caption-buttons="win11"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
  });

  it("keeps the win98 chrome for neumorphic", async () => {
    document.documentElement.setAttribute("data-theme-style", "neumorphic");
    const { container } = await renderWindow();

    expect(container.querySelector("[data-title-bar]")).toBeNull();
    expect(container.querySelector("[data-caption-buttons]")).toBeNull();
    // The win98 close glyph is the multiplication sign, unlike the mac "x".
    expect(container.textContent).toContain("×");
  });

  it("wires the winxp caption close button to closeWindow", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderWindow();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useWindowManager.getState().getWindow("win-app")).toBeUndefined();
  });

  it("switches chrome when the theme style attribute changes after mount", async () => {
    const { container } = await renderWindow();
    expect(container.querySelector("[data-title-bar]")).toBeNull();

    // MutationObserver callbacks run as microtasks; flush them inside act.
    await act(async () => {
      document.documentElement.setAttribute("data-theme-style", "win11");
      await Promise.resolve();
    });

    expect(container.querySelector('[data-title-bar="win11"]')).toBeTruthy();
  });
});

describe("DesignCaptionButtons", () => {
  it("renders nothing for non-Windows variants", () => {
    for (const variant of ["mac", "win98", "macos-glass"] as const) {
      const { container, unmount } = render(
        <DesignCaptionButtons variant={variant} onClose={() => {}} />,
      );
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it("disables the close button for both Windows variants when closeDisabled is set", () => {
    for (const variant of ["winxp", "win11"] as const) {
      const { unmount } = render(
        <DesignCaptionButtons variant={variant} onClose={() => {}} closeDisabled />,
      );
      const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
      expect(close.disabled).toBe(true);
      unmount();
    }
  });

  it("keeps the close button enabled by default", () => {
    render(<DesignCaptionButtons variant="winxp" onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
  });
});
