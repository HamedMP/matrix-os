// @vitest-environment jsdom
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Desktop } from "../../shell/src/components/Desktop.js";
import type { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import type { useDesktopConfigStore } from "../../shell/src/stores/desktop-config.js";
import type { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { createShellSnapshotScope, saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache.js";

const nativeAppFlag = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../shell/src/hooks/useNativeLinuxAppsEnabled.js", () => ({
  useNativeLinuxAppsEnabled: () => nativeAppFlag.enabled,
}));

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: () => undefined,
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => null,
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

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

type DesktopComponentType = typeof Desktop;
type DesktopModeStore = typeof useDesktopMode;
type DesktopConfigStore = typeof useDesktopConfigStore;
type WindowManagerStore = typeof useWindowManager;

let DesktopComponent: DesktopComponentType;
let desktopModeStore: DesktopModeStore;
let desktopConfigStore: DesktopConfigStore;
let windowManagerStore: WindowManagerStore;

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

function resetShellMode(mode: "canvas" | "dev", hydrated: boolean) {
  desktopModeStore.setState({
    mode,
    previousMode: null,
    _hydrated: hydrated,
  });
  desktopConfigStore.setState({
    dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
    pinnedApps: [],
  });
  windowManagerStore.setState({
    windows: [],
    apps: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    focusedWindowId: null,
    fullscreenWindowId: null,
  });
}

describe("Desktop launcher dock button by mode", () => {
  beforeEach(async () => {
    vi.resetModules();
    nativeAppFlag.enabled = false;
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) return jsonResponse({ layout: { windows: [] }, apps: [], modules: [] });
      return jsonResponse({});
    }));
    DesktopComponent = (await import("../../shell/src/components/Desktop.js")).Desktop;
    desktopModeStore = (await import("../../shell/src/stores/desktop-mode.js")).useDesktopMode;
    desktopConfigStore = (await import("../../shell/src/stores/desktop-config.js")).useDesktopConfigStore;
    windowManagerStore = (await import("../../shell/src/hooks/useWindowManager.js")).useWindowManager;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the launcher visible in canvas mode even before mode hydration completes", async () => {
    resetShellMode("canvas", false);

    render(<DesktopComponent />);

    expect(await screen.findByTestId("dock-tasks")).toBeTruthy();
  });

  it("keeps the launcher visible in developer mode", async () => {
    resetShellMode("dev", true);

    render(<DesktopComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("dock-tasks")).toBeTruthy();
      expect(screen.getByTestId("dock-settings")).toBeTruthy();
    });
  });

  it("leaves the loading screen when onboarding status fetch never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return new Promise<Response>(() => undefined);
      if (url.includes("/api/shell/bootstrap")) return jsonResponse({ layout: { windows: [] }, apps: [], modules: [] });
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    render(<DesktopComponent />);

    expect(screen.getByText("Loading Matrix")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.queryByText("Loading Matrix")).toBeNull();
    expect(screen.getByTestId("dock-tasks")).toBeTruthy();
  });

  it("registers apps from the scoped shell bootstrap snapshot before network bootstrap returns", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    saveShellSnapshot(scope, {
      bootstrap: {
        layout: { windows: [] },
        modules: [],
        apps: [{ name: "Cached Notes", path: "/files/apps/notes/index.html", icon: "notes", slug: "notes" }],
        icons: { notes: { url: "/icons/notes.png", etag: "\"abc\"", versionedUrl: "/icons/notes.png?v=abc" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) return new Promise(() => undefined);
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    render(<DesktopComponent cacheScope={scope} />);

    await waitFor(() => {
      expect(windowManagerStore.getState().apps.some((app) => app.path === "apps/notes/index.html")).toBe(true);
    });
  });

  it("restores saved native app windows after the native registry loads", async () => {
    nativeAppFlag.enabled = true;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) {
        return jsonResponse({
          layout: {
            windows: [{
              id: "native-window",
              title: "Xterm",
              path: "native:xterm",
              x: 80,
              y: 90,
              width: 900,
              height: 640,
              minimized: false,
              zIndex: 4,
            }],
          },
          apps: [],
          modules: [],
        });
      }
      if (url.includes("/api/native-apps")) {
        return jsonResponse({
          apps: [{
            id: "xterm",
            name: "Xterm",
            runtime: "linux-native",
            enabled: true,
            defaultWidth: 900,
            defaultHeight: 640,
            command: ["xterm"],
            permissions: { filesystem: "none", network: false, clipboard: false },
          }],
        });
      }
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    render(<DesktopComponent />);

    await waitFor(() => {
      expect(windowManagerStore.getState().apps.some((app) => app.path === "native:xterm")).toBe(true);
      expect(windowManagerStore.getState().windows.some((win) => win.path === "native:xterm")).toBe(true);
    });
  });

  it("does not discover or restore native apps when the rollout flag is disabled", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) {
        return jsonResponse({
          layout: {
            windows: [{
              id: "native-window",
              title: "Xterm",
              path: "native:xterm",
              x: 80,
              y: 90,
              width: 900,
              height: 640,
              minimized: false,
              zIndex: 4,
            }],
          },
          apps: [],
          modules: [],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    resetShellMode("dev", true);

    render(<DesktopComponent />);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/shell/bootstrap"))).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/native-apps"))).toBe(false);
    expect(windowManagerStore.getState().apps.some((app) => app.path.startsWith("native:"))).toBe(false);
    expect(windowManagerStore.getState().windows.some((win) => win.path.startsWith("native:"))).toBe(false);
  });

  it("ignores stale bootstrap responses after cache scope changes", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    const firstBootstrap = deferredResponse();
    const secondBootstrap = deferredResponse();
    const pendingBootstrap = [firstBootstrap, secondBootstrap];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) {
        const next = pendingBootstrap.shift();
        if (!next) return jsonResponse({ layout: { windows: [] }, apps: [], modules: [] });
        return next.promise;
      }
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    const { rerender } = render(<DesktopComponent />);
    await waitFor(() => {
      expect(pendingBootstrap).toHaveLength(1);
    });

    rerender(<DesktopComponent cacheScope={scope} />);
    await waitFor(() => {
      expect(pendingBootstrap).toHaveLength(0);
    });

    await act(async () => {
      secondBootstrap.resolve(new Response(JSON.stringify({
        layout: { windows: [] },
        apps: [{ name: "Fresh Notes", path: "/files/apps/fresh/index.html", icon: "fresh", slug: "fresh" }],
        modules: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });

    await waitFor(() => {
      expect(windowManagerStore.getState().apps.some((app) => app.path === "apps/fresh/index.html")).toBe(true);
    });

    await act(async () => {
      firstBootstrap.resolve(new Response(JSON.stringify({
        layout: { windows: [] },
        apps: [{ name: "Stale Notes", path: "/files/apps/stale/index.html", icon: "stale", slug: "stale" }],
        modules: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });

    await waitFor(() => {
      const appPaths = windowManagerStore.getState().apps.map((app) => app.path);
      expect(appPaths).toContain("apps/fresh/index.html");
      expect(appPaths).not.toContain("apps/stale/index.html");
    });
  });
});
