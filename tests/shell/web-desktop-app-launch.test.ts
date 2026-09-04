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
  it("routes the fallback Browser launcher to a public browser URL", () => {
    expect(resolveWebDesktopBuiltInLaunch("__browser__")).toEqual({
      kind: "external",
      url: "https://www.google.com",
    });
  });

  it("routes the installed Browser catalog entry through the dedicated Browser launch", () => {
    expect(resolveWebDesktopBuiltInLaunch("apps/browser/index.html")).toEqual({
      kind: "external",
      url: "https://www.google.com",
    });
    expect(resolveWebDesktopBuiltInLaunch("apps/browser/dist/index.html")).toEqual({
      kind: "external",
      url: "https://www.google.com",
    });
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
      { name: "Browser", path: "__browser__" },
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
      iconUrl: "/icons/canvas.svg",
    });
    expect(buildWebDesktopLauncherApps([], "canvas")[0]).toEqual({
      name: "Web Desktop",
      path: "__os-view-desktop__",
      iconUrl: "/icons/desktop.svg",
    });
    expect(buildWebDesktopIconApps([]).some((app) => app.path.startsWith("__os-view-"))).toBe(false);
  });

  it("uses canonical durable paths for all ten default Desktop icons", () => {
    expect(buildWebDesktopIconApps([]).slice(0, 10).map((app) => app.path)).toEqual(
      DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
    );
    expect(buildWebDesktopIconApps([
      { name: "Notes", path: "apps/notes/dist/index.html" },
      { name: "Whiteboard", path: "apps/whiteboard/dist/index.html" },
    ]).slice(0, 10).map((app) => normalizeOsViewDesktopAppPath(app.path))).toEqual(
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
