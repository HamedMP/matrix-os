import { describe, expect, it } from "vitest";
import {
  getDesktopAppAffordance,
  getDesktopRuntimeKind,
  isDesktopDefaultApp,
} from "../../shell/src/lib/desktop-runtime";

describe("desktop app launcher affordances", () => {
  it("detects Electron desktop runtime through the preload bridge", () => {
    expect(getDesktopRuntimeKind({ matrixDesktop: undefined })).toBe("browser");
    expect(getDesktopRuntimeKind({ matrixDesktop: { getRuntimePolicy: async () => null, openExternal: async () => ({ ok: true }) } })).toBe(
      "desktop",
    );
  });

  it("marks default Matrix apps as native-feeling desktop tabs", () => {
    for (const path of ["__workspace__", "__terminal__", "__file-browser__", "symphony"]) {
      expect(isDesktopDefaultApp(path)).toBe(true);
      expect(getDesktopAppAffordance(path, "desktop")).toEqual({
        launchSurface: "native-tab",
        defaultApp: true,
      });
    }
  });

  it("keeps installed third-party apps in shell windows", () => {
    expect(isDesktopDefaultApp("apps/notes/index.html")).toBe(false);
    expect(getDesktopAppAffordance("apps/notes/index.html", "desktop")).toEqual({
      launchSurface: "shell-window",
      defaultApp: false,
    });
  });
});
