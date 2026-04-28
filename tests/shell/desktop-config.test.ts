import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDesktopConfigStore, type DockConfig } from "../../shell/src/stores/desktop-config";
import { DEFAULT_PINNED_APPS } from "../../shell/src/lib/builtin-apps";
import {
  buildMeshGradient,
  saveDesktopConfig,
  type DesktopConfig,
} from "../../shell/src/hooks/useDesktopConfig";

describe("Desktop config", () => {
  beforeEach(() => {
    useDesktopConfigStore.setState({
      dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      pinnedApps: [...DEFAULT_PINNED_APPS],
    });
    vi.restoreAllMocks();
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

  it("hook exports are defined", () => {
    expect(saveDesktopConfig).toBeTypeOf("function");
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
});
