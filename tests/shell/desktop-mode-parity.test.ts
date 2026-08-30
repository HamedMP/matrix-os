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

  it("keeps Canvas selectable while Desktop remains the canonical default", () => {
    expect(useDesktopMode.getState().visibleModes().map((mode) => mode.id)).toEqual([
      "canvas",
      "desktop",
    ]);
    expect(useDesktopMode.getState().allModes().map((mode) => mode.label)).toEqual([
      "Canvas",
      "Desktop",
    ]);
  });

  it("preserves Canvas preferences while migrating removed modes into Desktop", () => {
    expect(normalizeDesktopMode("dev")).toBe("desktop");
    expect(normalizeDesktopMode("canvas")).toBe("canvas");
    expect(normalizeDesktopMode("desktop")).toBe("desktop");
    expect(normalizeDesktopMode("something-else")).toBe("desktop");
  });
});
