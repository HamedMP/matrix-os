import { describe, expect, it } from "vitest";
import {
  clampZoomFactor,
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  nextZoomFactor,
} from "../../desktop/src/main/platform/zoom";

describe("zoom factor math", () => {
  it("steps in 0.1 increments without floating-point drift", () => {
    expect(nextZoomFactor(1, "in")).toBe(1.1);
    expect(nextZoomFactor(1.1, "in")).toBe(1.2);
    expect(nextZoomFactor(1.1, "out")).toBe(1);
    expect(nextZoomFactor(0.7, "out")).toBe(0.6);
    // Drifted inputs (e.g. 0.7000000000000001) snap back onto the grid.
    expect(nextZoomFactor(0.7000000000000001, "in")).toBe(0.8);
  });

  it("clamps steps to the 0.5–2.0 range", () => {
    expect(nextZoomFactor(MAX_ZOOM_FACTOR, "in")).toBe(MAX_ZOOM_FACTOR);
    expect(nextZoomFactor(1.99, "in")).toBe(MAX_ZOOM_FACTOR);
    expect(nextZoomFactor(MIN_ZOOM_FACTOR, "out")).toBe(MIN_ZOOM_FACTOR);
    expect(nextZoomFactor(0.51, "out")).toBe(MIN_ZOOM_FACTOR);
  });

  it("resets to 100% from any factor", () => {
    expect(nextZoomFactor(1.7, "reset")).toBe(DEFAULT_ZOOM_FACTOR);
    expect(nextZoomFactor(0.5, "reset")).toBe(DEFAULT_ZOOM_FACTOR);
  });

  it("clamps arbitrary factors and falls back on non-finite input", () => {
    expect(clampZoomFactor(3)).toBe(MAX_ZOOM_FACTOR);
    expect(clampZoomFactor(0.1)).toBe(MIN_ZOOM_FACTOR);
    expect(clampZoomFactor(1.25)).toBe(1.3);
    expect(clampZoomFactor(Number.NaN)).toBe(DEFAULT_ZOOM_FACTOR);
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM_FACTOR);
  });
});
