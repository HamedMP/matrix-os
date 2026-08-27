import { beforeEach, describe, expect, it } from "vitest";
import { normalizeDesktopMode, useDesktopMode } from "@/stores/desktop-mode";

describe("web desktop mode parity", () => {
  beforeEach(() => {
    useDesktopMode.setState({
      mode: "desktop",
      previousMode: null,
      _hydrated: true,
    });
  });

  it("exposes Desktop as the sole primary OS view while legacy renderers remain internal", () => {
    expect(useDesktopMode.getState().visibleModes().map((mode) => mode.id)).toEqual([
      "desktop",
    ]);
    expect(useDesktopMode.getState().getModeConfig("desktop")).toMatchObject({
      hidden: false,
      showDock: true,
      showWindows: true,
      showLauncher: true,
    });
  });

  it("migrates removed Developer and Canvas modes into Desktop", () => {
    expect(normalizeDesktopMode("dev")).toBe("desktop");
    expect(normalizeDesktopMode("canvas")).toBe("desktop");
    expect(normalizeDesktopMode("desktop")).toBe("desktop");
    expect(normalizeDesktopMode("something-else")).toBe("desktop");
  });
});
