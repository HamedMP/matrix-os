// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Desktop } from "../../shell/src/components/Desktop.js";
import type { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import type { useWindowManager, AppWindow } from "../../shell/src/hooks/useWindowManager.js";

const { terminalRender } = vi.hoisted(() => ({
  terminalRender: vi.fn(() => <div>Terminal content</div>),
}));

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: () => undefined,
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: terminalRender,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => <div>App content</div>,
}));

vi.mock("../../shell/src/components/workspace/WorkspaceApp.js", () => ({
  WorkspaceApp: () => null,
}));

vi.mock("../../shell/src/components/file-browser/FileBrowser.js", () => ({
  FileBrowser: () => null,
}));

vi.mock("../../shell/src/components/preview-window/PreviewWindow.js", () => ({
  PreviewWindow: () => null,
}));

vi.mock("../../shell/src/components/system-activity/ActivityMonitorApp.js", () => ({
  ActivityMonitorApp: () => null,
}));

vi.mock("../../shell/src/components/AIButton.js", () => ({
  AIButton: () => null,
}));

vi.mock("../../shell/src/components/MissionControl.js", () => ({
  MissionControl: () => null,
}));

vi.mock("../../shell/src/components/DotGrid.js", () => ({
  DotGrid: () => null,
}));

vi.mock("../../shell/src/components/Settings.js", () => ({
  Settings: () => null,
}));

vi.mock("../../shell/src/components/canvas/CanvasRenderer.js", () => ({
  CanvasRenderer: () => null,
}));

vi.mock("../../shell/src/components/canvas/CanvasToolbar.js", () => ({
  CanvasToolbar: () => null,
}));

vi.mock("../../shell/src/components/VocalPanel.js", () => ({
  VocalPanel: () => null,
}));

vi.mock("../../shell/src/components/UserButton.js", () => ({
  UserButton: () => null,
}));

vi.mock("../../shell/src/components/ConnectionIndicator.js", () => ({
  ConnectionIndicator: () => null,
}));

vi.mock("../../shell/src/components/AmbientClock.js", () => ({
  AmbientClock: () => null,
}));

vi.mock("../../shell/src/components/MenuBar.js", () => ({
  MenuBar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../shell/src/components/ChatApp.js", () => ({
  ChatApp: () => null,
}));

vi.mock("../../shell/src/components/ChatPopover.js", () => ({
  ChatPopover: () => null,
}));

vi.mock("../../shell/src/components/onboarding/ManualSetupStickers.js", () => ({
  ManualSetupStickers: () => null,
}));

vi.mock("../../shell/src/components/RuntimeIdentityBanner.js", () => ({
  RuntimeIdentityBanner: () => null,
}));

vi.mock("../../shell/src/components/developer/DeveloperModeDashboard.js", () => ({
  DeveloperModeDashboard: () => null,
}));

const terminalWindow: AppWindow = {
  id: "win-terminal",
  title: "Terminal",
  path: "__terminal__",
  x: 40,
  y: 50,
  width: 900,
  height: 620,
  minimized: false,
  zIndex: 10,
};

const appWindow: AppWindow = {
  ...terminalWindow,
  id: "win-app",
  title: "Notes",
  path: "apps/notes/index.html",
};

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

type DesktopComponentType = typeof Desktop;
type DesktopModeStore = typeof useDesktopMode;
type WindowManagerStore = typeof useWindowManager;

let DesktopComponent: DesktopComponentType;
let desktopModeStore: DesktopModeStore;
let windowManagerStore: WindowManagerStore;

function resetStores(win: AppWindow, fullscreenWindowId: string | null = win.id) {
  desktopModeStore.setState({
    mode: "dev",
    previousMode: null,
    _hydrated: true,
  });
  windowManagerStore.setState({
    windows: [win],
    nextZ: 11,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    apps: [],
    focusedWindowId: win.id,
    fullscreenWindowId,
  });
}

describe("Desktop terminal fullscreen chrome", () => {
  beforeEach(async () => {
    vi.resetModules();
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    terminalRender.mockClear();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/layout")) return jsonResponse({ windows: [] });
      if (url.includes("/files/system/modules.json")) return jsonResponse([]);
      if (url.includes("/api/apps")) return jsonResponse([]);
      return jsonResponse({});
    }));
    DesktopComponent = (await import("../../shell/src/components/Desktop.js")).Desktop;
    desktopModeStore = (await import("../../shell/src/stores/desktop-mode.js")).useDesktopMode;
    windowManagerStore = (await import("../../shell/src/hooks/useWindowManager.js")).useWindowManager;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows no exit pill for a fullscreen terminal in Developer mode (header stays instead)", async () => {
    resetStores(terminalWindow);

    render(<DesktopComponent />);

    await screen.findByText("Terminal content");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
    });
  });

  it("shows no exit pill for a fullscreen app window in Developer mode (header stays instead)", async () => {
    resetStores(appWindow);

    render(<DesktopComponent />);

    await screen.findByText("App content");
    // Developer-mode windows keep their header (with traffic lights) when
    // maximized, so the floating exit pill is gone.
    expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
  });

  it("keeps a windowed Terminal on the main-branch terminal header chrome", async () => {
    resetStores(terminalWindow, null);

    const { container } = render(<DesktopComponent />);

    await screen.findByText("Terminal content");
    const terminalWindowEl = container.querySelector(".app-window") as HTMLElement | null;
    const header = container.querySelector(".app-window .border-b-0") as HTMLElement | null;

    expect(terminalWindowEl?.className).toContain("border-0");
    expect(header).toBeTruthy();
    expect(header?.className).not.toContain("border-border");
    expect(header?.style.background).toBe("var(--terminal-drawer-bg)");
    expect(header?.style.color).toBe("var(--terminal-drawer-fg)");
  });

  it("shows no global exit pill in Canvas mode (the window's own header handles exit)", async () => {
    resetStores(appWindow);
    desktopModeStore.setState({ mode: "canvas", previousMode: null, _hydrated: true });

    render(<DesktopComponent />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
    });
  });

  it("lets the terminal-owned title bar double-click toggle window zoom", async () => {
    resetStores(terminalWindow, null);

    render(<DesktopComponent />);

    await screen.findByText("Terminal content");
    const props = terminalRender.mock.lastCall?.[0] as {
      windowControls?: {
        dragHandleProps?: {
          onDoubleClick?: () => void;
        };
      };
    };

    expect(props.windowControls?.dragHandleProps?.onDoubleClick).toEqual(expect.any(Function));

    act(() => {
      props.windowControls!.dragHandleProps!.onDoubleClick!();
    });

    expect(windowManagerStore.getState().fullscreenWindowId).toBe("win-terminal");
  });
});
