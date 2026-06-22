// @vitest-environment jsdom

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Desktop } from "../../shell/src/components/Desktop.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import { useDesktopConfigStore } from "../../shell/src/stores/desktop-config.js";
import { useVocalStore } from "../../shell/src/stores/vocal.js";

const originalConsoleError = console.error;

function isStyledJsxAttributeWarning(message: unknown, args: unknown[]): boolean {
  if (typeof message !== "string") return false;
  return (
    (message.includes("non-boolean attribute `jsx`") || message.includes("non-boolean attribute `global`")) ||
    (message.includes("non-boolean attribute `%s`") && (args.includes("jsx") || args.includes("global")))
  );
}

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: () => undefined,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => null,
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
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
  CanvasRenderer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../shell/src/components/canvas/CanvasToolbar.js", () => ({
  CanvasToolbar: () => null,
}));

vi.mock("@/hooks/useVocalSession", () => ({
  useVocalSession: () => ({
    voiceState: "idle",
    subtitle: "",
    error: "Aoede could not connect",
    connected: false,
    notifyDelegationComplete: vi.fn(),
    notifyExecuteResult: vi.fn(),
    pushDelegationStatus: vi.fn(),
  }),
}));

vi.mock("../../shell/src/components/UserButton.js", () => ({
  UserButton: () => null,
}));

vi.mock("../../shell/src/components/ConnectionIndicator.js", () => ({
  ConnectionIndicator: () => <div data-testid="connection-indicator" data-variant="toast" />,
}));

vi.mock("../../shell/src/components/AmbientClock.js", () => ({
  AmbientClock: () => null,
}));

vi.mock("../../shell/src/components/MenuBar.js", () => ({
  MenuBar: ({ children }: { children?: React.ReactNode }) => <div data-menu-bar>{children}</div>,
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
  RuntimeIdentityBanner: () => <div data-testid="runtime-identity-banner" />,
}));

vi.mock("../../shell/src/components/developer/DeveloperModeDashboard.js", () => ({
  DeveloperModeDashboard: () => null,
}));

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("Desktop shell notifications", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation((message: unknown, ...args: unknown[]) => {
      if (isStyledJsxAttributeWarning(message, args)) return;
      Reflect.apply(originalConsoleError, console, [message, ...args]);
    });
    act(() => {
      useDesktopMode.setState({
        mode: "dev",
        previousMode: null,
        _hydrated: true,
      });
      useDesktopConfigStore.setState({
        dock: { position: "bottom", size: 64, iconSize: 48, autoHide: false },
        pinnedApps: [],
      });
      useWindowManager.setState({
        windows: [],
        apps: [],
        nextZ: 1,
        closedPaths: new Set(),
        closedLayouts: new Map(),
        focusedWindowId: null,
        fullscreenWindowId: null,
      });
      useVocalStore.setState({ active: true });
    });
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
    act(() => {
      useVocalStore.setState({ active: false });
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders connection, runtime, and vocal notices in the shared top-right stack outside the dock", async () => {
    render(<Desktop />);

    const indicator = await screen.findByTestId("connection-indicator");
    const banner = screen.getByTestId("runtime-identity-banner");
    const stack = screen.getByTestId("shell-notification-stack");
    const vocalError = await screen.findByRole("alert");

    await waitFor(() => {
      expect(stack.contains(indicator)).toBe(true);
      expect(stack.contains(banner)).toBe(true);
      expect(stack.contains(vocalError)).toBe(true);
    });

    const dock = document.querySelector("[data-dock]");
    expect(dock).toBeTruthy();
    expect(dock?.contains(indicator)).toBe(false);
    expect(vocalError.textContent).toContain("Aoede could not connect");
  });
});
