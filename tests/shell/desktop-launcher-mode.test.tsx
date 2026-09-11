// @vitest-environment jsdom
import React from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Desktop } from "../../shell/src/components/Desktop.js";
import type { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import type { useDesktopConfigStore } from "../../shell/src/stores/desktop-config.js";
import type { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import { createShellSnapshotScope, saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache.js";
import { createShellQueryClient } from "../../shell/src/api/query-client.js";
import { appKeys, type ApiAppEntry } from "../../shell/src/api/apps.js";

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: () => undefined,
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => null,
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
  MissionControl: ({
    open,
    apps,
    onOpenApp,
    onClose,
    onAddToDesktop,
  }: {
    open: boolean;
    apps: Array<{ name: string; path: string }>;
    onOpenApp: (name: string, path: string) => void;
    onClose: () => void;
    onAddToDesktop: (path: string, bounds: { width: number; height: number }) => Promise<string>;
  }) => {
    const [contextApp, setContextApp] = React.useState<{ name: string; path: string } | null>(null);
    if (!open) return null;
    return (
      <div data-testid="launcher-destinations">
        {apps.map((app) => (
          <button
            key={app.path}
            type="button"
            onClick={() => onOpenApp(app.name, app.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextApp(app);
            }}
          >
            {app.name}
          </button>
        ))}
        {contextApp ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void onAddToDesktop(contextApp.path, { width: window.innerWidth, height: window.innerHeight })
                .then((result) => {
                  if (result === "added" || result === "already-present") onClose();
                });
            }}
          >
            Add {contextApp.name} to Desktop
          </button>
        ) : null}
      </div>
    );
  },
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
  CanvasToolbar: () => (
    <>
      <button type="button" data-testid="canvas-zoom-control">Zoom</button>
      <input data-testid="canvas-zoom-slider" aria-label="Canvas zoom" type="range" />
    </>
  ),
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

vi.mock("../../shell/src/components/onboarding/ManualSetupStickers.js", () => ({
  ManualSetupStickers: () => null,
}));

vi.mock("../../shell/src/components/onboarding/GettingStartedPopover.js", () => ({
  GettingStartedPopover: () => null,
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
let resetLayoutPersistence: () => void;
let queryClient: QueryClient;

function renderDesktop(props: React.ComponentProps<DesktopComponentType> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DesktopComponent {...props} />
    </QueryClientProvider>,
  );
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

function resetShellMode(mode: "canvas" | "desktop" | "dev", hydrated: boolean) {
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
    (await import("../../shell/src/stores/desktop-config.js")).resetWebDesktopIconsRuntime();
    const windowManagerModule = await import("../../shell/src/hooks/useWindowManager.js");
    windowManagerStore = windowManagerModule.useWindowManager;
    resetLayoutPersistence = windowManagerModule.resetWindowManagerLayoutPersistenceForTests;
    queryClient = createShellQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  afterEach(() => {
    // A module reset does not cancel the previous store's debounced save.
    resetLayoutPersistence();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the launcher visible in canvas mode even before mode hydration completes", async () => {
    resetShellMode("canvas", false);

    renderDesktop();

    expect(await screen.findByTestId("dock-tasks")).toBeTruthy();
  });

  it("contains Canvas controls in one non-shrinking toolbar row", async () => {
    resetShellMode("canvas", true);

    renderDesktop();

    const toolbar = await screen.findByTestId("canvas-toolbar");
    expect(toolbar.className).toContain("shrink-0");
    expect(toolbar.className).toContain("items-center");
    expect(screen.getByTestId("canvas-zoom-control").parentElement).toBe(toolbar);
    expect(screen.getByTestId("canvas-zoom-slider").parentElement).toBe(toolbar);
  });

  it("keeps the launcher visible in developer mode", async () => {
    resetShellMode("dev", true);

    renderDesktop();

    await waitFor(() => {
      expect(screen.getByTestId("dock-tasks")).toBeTruthy();
      expect(screen.getByTestId("dock-settings")).toBeTruthy();
    });
  });

  it("shows and launches Chat as the first canonical app in Desktop mode", async () => {
    resetShellMode("desktop", true);

    renderDesktop();

    const desktopApps = await screen.findByRole("navigation", { name: "Desktop apps" });
    await waitFor(() => {
      expect(Array.from(desktopApps.querySelectorAll("button")).map(
        (button) => button.getAttribute("aria-label"),
      ).slice(0, 4)).toEqual(["Chat", "Terminal", "Files", "Editor"]);
    });
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    expect(windowManagerStore.getState().windows.find((windowRecord) => windowRecord.path === "__chat__"))
      .toMatchObject({ title: "Chat", path: "__chat__" });
  });

  it("switches Web Desktop to Web Canvas and back from the app launcher without closing apps", async () => {
    resetShellMode("desktop", true);
    renderDesktop();

    fireEvent.doubleClick(await screen.findByRole("button", { name: "Chat" }));
    const chatWindow = windowManagerStore.getState().windows.find(
      (windowRecord) => windowRecord.path === "__chat__",
    );
    expect(chatWindow).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Open App Launcher" }));
    fireEvent.click(await screen.findByRole("button", { name: "Web Canvas" }));
    expect(desktopModeStore.getState().mode).toBe("canvas");
    expect(windowManagerStore.getState().windows.find(
      (windowRecord) => windowRecord.path === "__chat__",
    )).toEqual(chatWindow);

    fireEvent.click(screen.getByTestId("dock-tasks"));
    fireEvent.click(await screen.findByRole("button", { name: "Web Desktop" }));
    expect(desktopModeStore.getState().mode).toBe("desktop");
    expect(windowManagerStore.getState().windows.find(
      (windowRecord) => windowRecord.path === "__chat__",
    )).toEqual(chatWindow);
  });

  it("adds an existing generated app from the launcher and renders its persisted Web Desktop icon", async () => {
    const sushi = {
      name: "Sushi Counter",
      path: "/files/apps/sushi-counter/index.html",
      icon: "sushi-counter",
      slug: "sushi-counter",
    };
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return await jsonResponse({ complete: true });
      if (url.includes("/api/apps")) return await jsonResponse([sushi]);
      if (url.includes("/api/shell/bootstrap")) {
        return await jsonResponse({ layout: { windows: [] }, apps: [sushi], modules: [] });
      }
      if (url.includes("/api/os-view-state") && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return await jsonResponse({
          revision: 2,
          document: {
            version: 1,
            apps: [],
            pinnedApps: [],
            desktop: { windows: [], icons: [{ path: "apps/sushi-counter/index.html", x: 24, y: 24 }] },
            canvas: { windows: [], transform: { zoom: 1, panX: 0, panY: 0 } },
          },
          updatedAt: "2026-09-08T00:00:00.000Z",
        });
      }
      if (url.includes("/api/os-view-state")) {
        return await jsonResponse({
          revision: 1,
          document: {
            version: 1,
            apps: [],
            pinnedApps: [],
            desktop: { windows: [], icons: [] },
            canvas: { windows: [], transform: { zoom: 1, panX: 0, panY: 0 } },
          },
          updatedAt: "2026-09-08T00:00:00.000Z",
        });
      }
      return await jsonResponse({});
    }));
    resetShellMode("desktop", true);

    renderDesktop();

    fireEvent.click(await screen.findByRole("button", { name: "Open App Launcher" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Sushi Counter" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Sushi Counter to Desktop" }));

    await waitFor(() => expect(screen.queryByTestId("launcher-destinations")).toBeNull());
    expect(screen.getByRole("button", { name: "Sushi Counter" })).toBeTruthy();
    expect(patches).toEqual([expect.objectContaining({
      baseRevision: 1,
      patch: expect.objectContaining({
        desktop: expect.objectContaining({
          icons: expect.arrayContaining([
            expect.objectContaining({ path: "apps/sushi-counter/index.html" }),
          ]),
        }),
      }),
    })]);
  });

  it("routes an installed Browser command through the dedicated public browser launch", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/apps")) return jsonResponse([{
        name: "Browser", path: "/files/apps/browser/dist/index.html", icon: "browser", slug: "browser",
      }]);
      if (url.includes("/api/shell/bootstrap")) {
        return jsonResponse({
          layout: { windows: [] },
          apps: [{
            name: "Browser",
            path: "/files/apps/browser/dist/index.html",
            icon: "browser",
            slug: "browser",
          }],
          modules: [],
        });
      }
      return jsonResponse({});
    }));
    const openExternal = vi.spyOn(window, "open").mockImplementation(() => null);
    const commandStore = (await import("../../shell/src/stores/commands.js")).useCommandStore;
    resetShellMode("desktop", true);

    renderDesktop();

    const browserCommand = await waitFor(() => {
      const command = commandStore.getState().commands.get("app:__browser__");
      expect(command).toBeDefined();
      return command!;
    });
    act(() => browserCommand.execute());

    expect(openExternal).toHaveBeenCalledWith("https://www.google.com", "_blank", "noopener,noreferrer");
    expect(windowManagerStore.getState().windows.some(
      (windowRecord) => windowRecord.path === "apps/browser/dist/index.html",
    )).toBe(false);
  });

  it("routes a mobile pinned Browser through the dedicated public browser launch", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/apps")) return jsonResponse([{
        name: "Browser", path: "/files/apps/browser/dist/index.html", icon: "browser", slug: "browser",
      }]);
      if (url.includes("/api/shell/bootstrap")) {
        return jsonResponse({
          layout: { windows: [] },
          apps: [{
            name: "Browser",
            path: "/files/apps/browser/dist/index.html",
            icon: "browser",
            slug: "browser",
          }],
          modules: [],
        });
      }
      return jsonResponse({});
    }));
    const openExternal = vi.spyOn(window, "open").mockImplementation(() => null);
    resetShellMode("canvas", true);

    renderDesktop();

    await waitFor(() => {
      expect(queryClient.getQueryData<ApiAppEntry[]>(appKeys.list())).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "__browser__" }),
      ]));
    });
    act(() => desktopConfigStore.setState({ pinnedApps: ["__browser__"] }));
    const browserButtons = await screen.findAllByRole("button", { name: "Browser" });
    fireEvent.click(browserButtons.at(-1)!);

    expect(openExternal).toHaveBeenCalledWith("https://www.google.com", "_blank", "noopener,noreferrer");
    expect(windowManagerStore.getState().windows.some(
      (windowRecord) => windowRecord.path === "apps/browser/dist/index.html",
    )).toBe(false);
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
      if (url.includes("/api/apps")) return new Promise(() => undefined);
      if (url.includes("/api/shell/bootstrap")) return new Promise(() => undefined);
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    renderDesktop({ cacheScope: scope });

    await waitFor(() => {
      expect(queryClient.getQueryData(appKeys.list())).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "/files/apps/notes/index.html",
          iconUrl: "http://localhost:3000/icons/notes.png?v=abc",
        }),
      ]));
    });
  });

  it("preserves a versioned snapshot icon when the apps query refetches", async () => {
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
    const appsResponse = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/apps")) return appsResponse.promise;
      if (url.includes("/api/shell/bootstrap")) return new Promise(() => undefined);
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    renderDesktop({ cacheScope: scope });

    await waitFor(() => {
      expect(queryClient.getQueryData<ApiAppEntry[]>(appKeys.list())).toEqual([
        expect.objectContaining({
          name: "Cached Notes",
          iconUrl: "http://localhost:3000/icons/notes.png?v=abc",
        }),
      ]);
    });

    await act(async () => {
      appsResponse.resolve(new Response(JSON.stringify([{
        name: "Fresh Notes",
        path: "/files/apps/notes/index.html",
        icon: "notes",
        slug: "notes",
      }]), { status: 200, headers: { "Content-Type": "application/json" } }));
      await appsResponse.promise;
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<ApiAppEntry[]>(appKeys.list())).toEqual([
        expect.objectContaining({
          name: "Fresh Notes",
          iconUrl: "http://localhost:3000/icons/notes.png?v=abc",
        }),
      ]);
    });
  });

  it("replaces cached apps with the fresh apps query result", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    saveShellSnapshot(scope, {
      bootstrap: {
        layout: { windows: [] },
        modules: [],
        apps: [{
          name: "Minesweeper",
          path: "/files/apps/winxp-minesweeper/index.html",
          icon: "winxp-minesweeper",
          slug: "winxp-minesweeper",
        }],
      },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/apps")) return jsonResponse([{
        name: "Stickies", path: "/files/apps/stickies/dist/index.html", icon: "stickies", slug: "stickies",
      }]);
      if (url.includes("/api/shell/bootstrap")) {
        return jsonResponse({
          layout: { windows: [] },
          modules: [],
          apps: [{
            name: "Stickies",
            path: "/files/apps/stickies/dist/index.html",
            icon: "stickies",
            slug: "stickies",
          }],
        });
      }
      return jsonResponse({});
    }));
    resetShellMode("dev", true);

    renderDesktop({ cacheScope: scope });

    await waitFor(() => {
      const paths = (queryClient.getQueryData<ApiAppEntry[]>(appKeys.list()) ?? []).map((app) => app.path);
      expect(paths).toContain("apps/stickies/dist/index.html");
      expect(paths).not.toContain("apps/winxp-minesweeper/index.html");
    });
  });

});
