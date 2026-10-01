// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeOsViewPersistence } from "@desktop/renderer/src/features/desktop-shell/use-native-os-view-persistence";
import { resetNativeOsViewStateClientForTests } from "@desktop/renderer/src/lib/os-view-state-client";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { resetDesktopIconsRuntime, useDesktopIcons } from "@desktop/renderer/src/stores/desktop-icons";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const loadedState = {
  revision: 1,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("Electron OS-view persistence hook", () => {
  beforeEach(() => {
    resetNativeOsViewStateClientForTests();
    resetDesktopIconsRuntime();
    useDesktopIcons.setState(useDesktopIcons.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("preserves entry surfaces through Canvas hydration and resets for a new entry", async () => {
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__chat__", title: "Chat", state: "closed" }, { path: "__terminal__", title: "Terminal", state: "closed" }];
    const canonical = { x: 300, y: 200, width: 700, height: 400 };
    document.desktop.windows = document.apps.map(({ path }) => ({ path, ...canonical }));
    document.canvas.windows = document.apps.map(({ path }) => ({ path, ...canonical }));
    const state = { ...loadedState, document };
    const api = { get: vi.fn(async (path: string) => path === "/api/settings/desktop" ? { legacyDesktopImport: null } : state), post: vi.fn(async () => state) };
    const tabs = [
      { id: "chat", kind: "work" as const, title: "Chat", closable: false },
      { id: "terminal", kind: "terminals" as const, title: "Terminal", closable: true },
    ];
    const bounds = { x: 40, y: 60, width: 900, height: 640 };
    useTabs.setState({ tabs, activeTabId: "chat" });
    useDesktopSurfaces.setState({ surfaces: Object.fromEntries(tabs.map((tab, index) => [tab.id, {
      tabId: tab.id, mode: index === 0 ? "minimized" as const : "closed" as const,
      restoreMode: "window" as const, bounds, zIndex: index + 1,
    }])) });
    const defaultIconLayout: [] = [];
    const { result, rerender } = renderHook(({ mode, entryKey }: { mode: "desktop" | "canvas"; entryKey: string }) => useNativeOsViewPersistence({
      api: api as never, entryKey, tabs, surfaces: useDesktopSurfaces.getState().surfaces,
      installedApps: [], mode, viewport: { width: 1200, height: 800 }, defaultIconLayout,
    }), { initialProps: { mode: "desktop", entryKey: "first" } });
    await waitFor(() => expect(result.current.surfacesRestored).toBe(true));
    expect(useDesktopSurfaces.getState().surfaces.chat).toMatchObject({ mode: "minimized", bounds });
    expect(useDesktopSurfaces.getState().surfaces.terminal).toMatchObject({ mode: "closed", bounds: canonical });

    const reopenTerminal = () => useDesktopSurfaces.setState({ surfaces: {
      ...useDesktopSurfaces.getState().surfaces,
      terminal: { ...useDesktopSurfaces.getState().surfaces.terminal!, mode: "window", bounds },
    } });
    // Later owner writes must not replace the original entry snapshot before Canvas restores.
    act(reopenTerminal);
    rerender({ mode: "canvas", entryKey: "first" });
    await waitFor(() => expect(result.current.surfacesRestored).toBe(true));
    expect(useDesktopSurfaces.getState().surfaces.chat).toMatchObject({ mode: "minimized", bounds });
    expect(useDesktopSurfaces.getState().surfaces.terminal).toMatchObject({ mode: "closed", bounds: canonical });

    act(reopenTerminal);
    rerender({ mode: "desktop", entryKey: "second" });
    await waitFor(() => expect(result.current.surfacesRestored).toBe(true));
    expect(useDesktopSurfaces.getState().surfaces.terminal).toMatchObject({ mode: "window", bounds });
    expect(useTabs.getState().activeTabId).toBe("chat");
  });

  it("retries a fresh native snapshot after a persistence failure", async () => {
    const api = {
      get: vi.fn(async (path: string) => path === "/api/settings/desktop" ? {} : loadedState),
      post: vi.fn(async () => loadedState),
      patch: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ ...loadedState, revision: 2 }),
    };
    const tab = { id: "chat", kind: "work" as const, title: "Chat", closable: false };
    const surfaces = {
      chat: {
        tabId: "chat",
        mode: "window" as const,
        restoreMode: "window" as const,
        bounds: { x: 40, y: 60, width: 900, height: 640 },
        zIndex: 10,
      },
    };
    const tabs = [tab];
    const installedApps: [] = [];
    const viewport = { width: 1200, height: 800 };
    const defaultIconLayout: [] = [];
    useTabs.setState({ tabs, activeTabId: tab.id });
    useDesktopSurfaces.setState({ surfaces });
    const { result } = renderHook(() => useNativeOsViewPersistence({
      api: api as never,
      tabs,
      surfaces,
      installedApps,
      mode: "desktop",
      viewport,
      defaultIconLayout,
    }));
    await waitFor(() => expect(result.current.durableState).toEqual(loadedState));

    act(() => result.current.schedulePersist());
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(api.patch.mock.calls[1][1].patch.desktop.windows).toEqual([
      { path: "__chat__", x: 40, y: 60, width: 900, height: 640 },
    ]);
  });

  it("imports exact legacy fields once and hydrates icons from PostgreSQL", async () => {
    const document = createDefaultOsViewDocument();
    document.desktop.icons = [{ path: "__terminal__", x: 44, y: 55 }];
    const importedState = { ...loadedState, document };
    const api = {
      get: vi.fn(async (path: string) => path === "/api/settings/desktop"
        ? {
            background: { type: "solid", color: "#123456" },
            pinnedApps: ["__terminal__", "__file-browser__", "__chat__"],
            legacyDesktopImport: { pinnedApps: ["__chat__"] },
          }
        : importedState),
      post: vi.fn(async () => importedState),
    };
    const defaultIconLayout = createDefaultOsViewDocument().desktop.icons;

    const { result } = renderHook(() => useNativeOsViewPersistence({
      api: api as never,
      tabs: [],
      surfaces: {},
      installedApps: [],
      mode: "desktop",
      viewport: { width: 1200, height: 800 },
      defaultIconLayout,
    }));

    await waitFor(() => expect(result.current.durableState).toEqual(importedState));
    expect(useDesktopIcons.getState().icons).toEqual([{ path: "__terminal__", x: 44, y: 55 }]);
    expect(api.post).toHaveBeenCalledWith(
      "/api/os-view-state/import-legacy-desktop",
      { pinnedApps: ["__chat__"] },
    );
  });
});
