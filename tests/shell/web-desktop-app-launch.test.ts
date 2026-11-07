import { describe, expect, it } from "vitest";
import {
  DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
  normalizeOsViewDesktopAppPath,
} from "@matrix-os/contracts";
import {
  buildWebDesktopIconApps,
  buildWebDesktopLauncherApps,
  resolveWebDesktopBuiltInLaunch,
} from "../../shell/src/lib/web-desktop-app-launch.js";

describe("web Desktop built-in app launch routing", () => {
  it("routes the Browser launcher to the persistent Chrome app", () => {
    expect(resolveWebDesktopBuiltInLaunch("__browser__")).toEqual({
      kind: "app",
      name: "Browser",
      path: "__browser__",
    });
  });

  it("routes the installed Browser catalog entry through the dedicated Browser launch", () => {
    expect(resolveWebDesktopBuiltInLaunch("apps/browser/index.html")).toEqual({
      kind: "app",
      name: "Browser",
      path: "__browser__",
    });
    expect(resolveWebDesktopBuiltInLaunch("apps/browser/dist/index.html")).toEqual({
      kind: "app",
      name: "Browser",
      path: "__browser__",
    });
  });

  it("keeps Cloud desktop available as a distinct launcher destination", () => {
    expect(resolveWebDesktopBuiltInLaunch("__cloud-desktop__")).toEqual({ kind: "app", name: "Cloud desktop", path: "__cloud-desktop__" });
    expect(buildWebDesktopLauncherApps([])).toContainEqual(expect.objectContaining({ name: "Cloud desktop", path: "__cloud-desktop__" }));
  });

  it("does not hijack a user app that is merely named Browser", () => {
    expect(resolveWebDesktopBuiltInLaunch("apps/custom-browser/dist/index.html")).toBeNull();
  });

  it("keeps a dedicated Browser slot alongside a same-named custom app", () => {
    const customBrowser = {
      name: "Browser",
      path: "apps/browser-clone/index.html",
      iconUrl: "/icons/browser-clone.svg",
    };

    const launcherApps = buildWebDesktopLauncherApps([customBrowser]);

    expect(launcherApps.filter((app) => app.name === "Browser")).toEqual([
      expect.objectContaining({ name: "Browser", path: "__browser__" }),
      customBrowser,
    ]);
  });

  it("routes VS Code externally and Editor to Files", () => {
    expect(resolveWebDesktopBuiltInLaunch("__vscode__")?.kind).toBe("external-code");
    expect(resolveWebDesktopBuiltInLaunch("__editor__")).toEqual({
      kind: "app",
      name: "Files",
      path: "__file-browser__",
    });
  });

  it("exposes the other OS view in the launcher without turning it into a desktop icon", () => {
    expect(buildWebDesktopLauncherApps([], "desktop")[0]).toEqual({
      name: "Web Canvas",
      path: "__os-view-canvas__",
      iconUrl: "/system-app-icons/v3/canvas.png",
    });
    expect(buildWebDesktopLauncherApps([], "canvas")[0]).toEqual({
      name: "Web Desktop",
      path: "__os-view-desktop__",
      iconUrl: "/system-app-icons/v3/desktop.png",
    });
    expect(buildWebDesktopIconApps([]).some((app) => app.path.startsWith("__os-view-"))).toBe(false);
  });

  it("uses canonical durable paths for all default Desktop icons", () => {
    expect(buildWebDesktopIconApps([]).slice(0, DEFAULT_OS_VIEW_DESKTOP_APP_PATHS.length).map((app) => app.path)).toEqual(
      DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
    );
    expect(buildWebDesktopIconApps([
      { name: "Notes", path: "apps/notes/dist/index.html" },
      { name: "Whiteboard", path: "apps/whiteboard/dist/index.html" },
    ]).slice(0, DEFAULT_OS_VIEW_DESKTOP_APP_PATHS.length).map((app) => normalizeOsViewDesktopAppPath(app.path))).toEqual(
      DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
    );
  });

  it("routes launcher OS-view destinations as presentation switches", () => {
    expect(resolveWebDesktopBuiltInLaunch("__os-view-canvas__")).toEqual({
      kind: "os-view",
      mode: "canvas",
    });
    expect(resolveWebDesktopBuiltInLaunch("__os-view-desktop__")).toEqual({
      kind: "os-view",
      mode: "desktop",
    });
  });

  it("leaves installed and other built-ins to normal app handling", () => {
    expect(resolveWebDesktopBuiltInLaunch("apps/browser-clone/index.html")).toBeNull();
    expect(resolveWebDesktopBuiltInLaunch("__chat__")).toBeNull();
  });
});

describe("Getting started app launcher entry (spec 639)", () => {
  it("adds Getting started only while the computer serves it", () => {
    const paths = (enabled: boolean) => buildWebDesktopLauncherApps([], "desktop", { gettingStartedApp: enabled }).map((app) => app.path);
    expect(paths(false)).not.toContain("__getting-started__");
    expect(paths(true)).toContain("__getting-started__");
    // Saved desktop placements only render for paths in this catalog.
    expect(buildWebDesktopIconApps([], { gettingStartedApp: true }).map((app) => app.path)).toContain("__getting-started__");
    expect(buildWebDesktopIconApps([]).map((app) => app.path)).not.toContain("__getting-started__");
    expect(buildWebDesktopLauncherApps([], "desktop", { gettingStartedApp: true })).toContainEqual(
      expect.objectContaining({ name: "Getting started", iconUrl: expect.stringContaining("/system-app-icons/v2/getting-started.png") }),
    );
  });
});
