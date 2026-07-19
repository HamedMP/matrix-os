// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDesktopConfigStore, type DockConfig } from "../../shell/src/stores/desktop-config";
import { DEFAULT_PINNED_APPS } from "../../shell/src/lib/builtin-apps";
import {
  buildMeshGradient,
  resetDesktopConfigRuntimeCacheForTests,
  saveDesktopConfig,
  saveDesktopConfigPatch,
  useDesktopConfig,
  type DesktopConfig,
} from "../../shell/src/hooks/useDesktopConfig";
import { createShellSnapshotScope, loadShellSnapshot, saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache";

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

describe("Desktop config", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    useDesktopConfigStore.setState({
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: [...DEFAULT_PINNED_APPS],
    });
    vi.restoreAllMocks();
    resetDesktopConfigRuntimeCacheForTests();
    window.history.replaceState({}, "", "/");
    document.body.removeAttribute("style");
  });

  it("default dock config has position left, size 56", () => {
    const { dock } = useDesktopConfigStore.getState();
    expect(dock.position).toBe("left");
    expect(dock.size).toBe(56);
  });

  it("setDock updates store state", () => {
    const newDock: DockConfig = {
      position: "bottom",
      size: 64,
      iconSize: 48,
      autoHide: true,
    };
    useDesktopConfigStore.getState().setDock(newDock);
    expect(useDesktopConfigStore.getState().dock).toEqual(newDock);
  });

  it("DesktopConfig type allows all background types", () => {
    const configs: DesktopConfig[] = [
      {
        background: { type: "pattern" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      },
      {
        background: { type: "solid", color: "#ff0000" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      },
      {
        background: { type: "gradient", from: "#000", to: "#fff" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      },
      {
        background: { type: "wallpaper", name: "forest.jpg" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      },
    ];
    expect(configs).toHaveLength(4);
  });

  it("buildMeshGradient returns a valid CSS background value", () => {
    const gradient = buildMeshGradient();
    expect(gradient).toMatch(/radial-gradient/);
    expect(gradient).toMatch(/var\(--gradient-/);
  });

  it("saveDesktopConfig calls fetch with PUT method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const config: DesktopConfig = {
      background: { type: "pattern" },
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
    };
    await saveDesktopConfig(config);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/settings/desktop");
    expect(opts.method).toBe("PUT");
  });

  it("saveDesktopConfigPatch preserves existing desktop metadata", async () => {
    const existingConfig = {
      background: { type: "wallpaper", name: "custom-family-photo.jpg" },
      dock: { position: "bottom", size: 64, iconSize: 48, autoHide: false },
      pinnedApps: ["apps/notes/index.html"],
      dockOrder: { userApps: ["apps/notes/index.html"], systemApps: ["__terminal__"] },
      iconStyle: "custom founder icon style",
      futureImportantField: { keep: true },
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(existingConfig),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await saveDesktopConfigPatch({
      background: { type: "wallpaper", name: "moraine-lake.jpg" },
      dock: { position: "left" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [putUrl, putOpts] = mockFetch.mock.calls[1];
    expect(putUrl).toContain("/api/settings/desktop");
    expect(putOpts.method).toBe("PUT");
    expect(JSON.parse(putOpts.body)).toEqual({
      ...existingConfig,
      background: { type: "wallpaper", name: "moraine-lake.jpg" },
      dock: { ...existingConfig.dock, position: "left" },
    });
  });

  it("applies a saved OS wallpaper immediately without waiting for the file watcher", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          background: { type: "wallpaper", name: "moraine-lake.jpg" },
          dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
          pinnedApps: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true }));

    await saveDesktopConfigPatch({
      background: { type: "wallpaper", name: "xp-bliss.jpg" },
    });

    expect(document.body.style.backgroundImage).toContain("xp-bliss.jpg");
  });

  it("keeps the saved dock auto-hide value in the live store", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          background: { type: "wallpaper", name: "moraine-lake.jpg" },
          dock: { position: "bottom", size: 64, iconSize: 48, autoHide: false },
          pinnedApps: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true }));

    await saveDesktopConfigPatch({
      dock: { position: "bottom", size: 64, iconSize: 48, autoHide: true },
    });

    expect(useDesktopConfigStore.getState().dock.autoHide).toBe(true);
  });

  it("saveDesktopConfigPatch refuses to overwrite preferences when the current config cannot be loaded", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", mockFetch);

    await expect(saveDesktopConfigPatch({
      background: { type: "wallpaper", name: "moraine-lake.jpg" },
    })).rejects.toThrow("GET /api/settings/desktop 503");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("hook exports are defined", () => {
    expect(saveDesktopConfig).toBeTypeOf("function");
    expect(saveDesktopConfigPatch).toBeTypeOf("function");
    expect(buildMeshGradient).toBeTypeOf("function");
  });

  it("default pinnedApps includes built-in launchers", () => {
    const { pinnedApps } = useDesktopConfigStore.getState();
    expect(pinnedApps).toEqual(DEFAULT_PINNED_APPS);
  });

  it("setPinnedApps updates store state", () => {
    useDesktopConfigStore.getState().setPinnedApps(["apps/calc.html", "apps/notes.html"]);
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual(["apps/calc.html", "apps/notes.html"]);
  });

  it("togglePin adds a new path", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ background: { type: "pattern" }, dock: {}, pinnedApps: [] }),
    }));

    useDesktopConfigStore.getState().setPinnedApps([]);
    useDesktopConfigStore.getState().togglePin("apps/calc.html");
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual(["apps/calc.html"]);
  });

  it("togglePin removes an existing path", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ background: { type: "pattern" }, dock: {}, pinnedApps: ["apps/calc.html"] }),
    }));

    useDesktopConfigStore.getState().setPinnedApps(["apps/calc.html", "apps/notes.html"]);
    useDesktopConfigStore.getState().togglePin("apps/calc.html");
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual(["apps/notes.html"]);
  });

  it("DesktopConfig type includes pinnedApps", () => {
    const config: DesktopConfig = {
      background: { type: "pattern" },
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: ["apps/test.html"],
    };
    expect(config.pinnedApps).toEqual(["apps/test.html"]);
  });

  it("initializes from the scoped shell snapshot before revalidating desktop config", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    saveShellSnapshot(scope, {
      desktopConfig: {
        background: { type: "wallpaper", name: "cached-wallpaper.jpg" },
        dock: { position: "bottom", size: 64, iconSize: 44, autoHide: false },
        pinnedApps: ["apps/cached/index.html"],
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        background: { type: "wallpaper", name: "fresh-wallpaper.jpg" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
        pinnedApps: ["apps/fresh/index.html"],
      }),
    }));

    const { result } = renderHook(() => useDesktopConfig({ cacheScope: scope }));

    expect(result.current.background).toEqual({ type: "wallpaper", name: "cached-wallpaper.jpg" });
    expect(useDesktopConfigStore.getState().dock.position).toBe("bottom");
    await waitFor(() => expect(result.current.background).toEqual({ type: "wallpaper", name: "fresh-wallpaper.jpg" }));
    expect(loadShellSnapshot(scope)?.desktopConfig?.pinnedApps).toEqual(["apps/fresh/index.html"]);
  });

  it("keeps the active OS wallpaper when a second desktop-config consumer mounts", async () => {
    let keepSecondFetchPending: ((value: never) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          background: { type: "wallpaper", name: "xp-bliss.jpg" },
          dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
          pinnedApps: [],
        }),
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        keepSecondFetchPending = resolve;
      })));

    const root = renderHook(() => useDesktopConfig());
    await waitFor(() => expect(root.result.current.background).toEqual({
      type: "wallpaper",
      name: "xp-bliss.jpg",
    }));
    expect(document.body.style.backgroundImage).toContain("xp-bliss.jpg");

    const settings = renderHook(() => useDesktopConfig());

    expect(settings.result.current.background).toEqual({ type: "wallpaper", name: "xp-bliss.jpg" });
    expect(document.body.style.backgroundImage).toContain("xp-bliss.jpg");
    settings.unmount();
    root.unmount();
    expect(keepSecondFetchPending).toBeTypeOf("function");
  });

  it("updates the scoped shell snapshot only after desktop config saves succeed", async () => {
    const scope = createShellSnapshotScope({ userId: "user_123", pathname: "/" });
    expect(scope).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const config: DesktopConfig = {
      background: { type: "pattern" },
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: ["apps/saved/index.html"],
    };

    await saveDesktopConfig(config, { cacheScope: scope });

    expect(loadShellSnapshot(scope)?.desktopConfig?.pinnedApps).toEqual(["apps/saved/index.html"]);
  });
});
