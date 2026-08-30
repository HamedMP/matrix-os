import { describe, expect, it } from "vitest";
import {
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

  it("leaves installed and other built-ins to normal app handling", () => {
    expect(resolveWebDesktopBuiltInLaunch("apps/browser-clone/index.html")).toBeNull();
    expect(resolveWebDesktopBuiltInLaunch("__chat__")).toBeNull();
  });
});
