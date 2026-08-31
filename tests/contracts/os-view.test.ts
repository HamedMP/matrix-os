import { describe, expect, it } from "vitest";
import {
  OS_VIEW_DESTINATION_PATHS,
  OS_VIEW_LABELS,
  isOsViewDestinationPath,
  normalizeOsViewMode,
  otherOsViewMode,
} from "@matrix-os/contracts";

describe("shared OS-view contract", () => {
  it("defines the same launcher destinations for Web and Electron clients", () => {
    expect(OS_VIEW_LABELS).toEqual({ desktop: "Desktop", canvas: "Canvas" });
    expect(OS_VIEW_DESTINATION_PATHS).toEqual({
      desktop: "__os-view-desktop__",
      canvas: "__os-view-canvas__",
    });
    expect(isOsViewDestinationPath(OS_VIEW_DESTINATION_PATHS.desktop)).toBe(true);
    expect(isOsViewDestinationPath(OS_VIEW_DESTINATION_PATHS.canvas)).toBe(true);
  });

  it("keeps Desktop as the fallback and returns the reciprocal destination", () => {
    expect(normalizeOsViewMode("canvas")).toBe("canvas");
    expect(normalizeOsViewMode("desktop")).toBe("desktop");
    expect(normalizeOsViewMode("removed-mode")).toBe("desktop");
    expect(otherOsViewMode("desktop")).toBe("canvas");
    expect(otherOsViewMode("canvas")).toBe("desktop");
  });
});
