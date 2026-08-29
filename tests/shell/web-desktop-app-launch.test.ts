import { describe, expect, it } from "vitest";
import { resolveWebDesktopBuiltInLaunch } from "../../shell/src/lib/web-desktop-app-launch.js";

describe("web Desktop built-in app launch routing", () => {
  it("routes the fallback Browser launcher to a public browser URL", () => {
    expect(resolveWebDesktopBuiltInLaunch("__browser__")).toEqual({
      kind: "external",
      url: "https://www.google.com",
    });
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
    expect(resolveWebDesktopBuiltInLaunch("apps/browser/index.html")).toBeNull();
    expect(resolveWebDesktopBuiltInLaunch("__chat__")).toBeNull();
  });
});
