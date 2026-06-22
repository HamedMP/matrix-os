// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Desktop } from "../../shell/src/components/Desktop.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager.js";

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

function resetStores(win: AppWindow, fullscreenWindowId: string | null = win.id) {
  useDesktopMode.setState({
    mode: "dev",
    previousMode: null,
    _hydrated: true,
  });
  useWindowManager.setState({
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
  beforeEach(() => {
    terminalRender.mockClear();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/layout")) return jsonResponse({ windows: [] });
      if (url.includes("/files/system/modules.json")) return jsonResponse([]);
      if (url.includes("/api/apps")) return jsonResponse([]);
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the global fullscreen exit pill when a terminal window owns fullscreen", async () => {
    resetStores(terminalWindow);

    render(<Desktop />);

    await screen.findByText("Terminal content");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
    });
  });

  it("keeps the global fullscreen exit pill for non-terminal fullscreen windows", async () => {
    resetStores(appWindow);

    render(<Desktop />);

    await screen.findByText("App content");
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();
  });

  it("lets the terminal-owned title bar double-click toggle window zoom", async () => {
    resetStores(terminalWindow, null);

    render(<Desktop />);

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

    expect(useWindowManager.getState().fullscreenWindowId).toBe("win-terminal");
  });
});
