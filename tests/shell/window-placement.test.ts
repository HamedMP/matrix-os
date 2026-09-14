// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { constrainFloatingWindow, isPointNearWindow } from "../../packages/ui/src/window/window-placement";

const viewport = { width: 900, height: 600 };
const minimum = { width: 320, height: 200 };
describe("floating window placement", () => {
  it("stops an east resize at the overflow limit without shifting the left edge", () => {
    const initial = { x: 100, y: 100, width: 600, height: 400 };
    expect(constrainFloatingWindow({ ...initial, width: 1000 }, viewport, minimum, initial))
      .toEqual({ ...initial, width: 832 });
  });
  it("stops a northwest resize without moving the opposite corner", () => {
    const initial = { x: 100, y: 100, width: 600, height: 400 };
    expect(constrainFloatingWindow({ x: -100, y: -100, width: 800, height: 600 }, viewport, minimum, initial))
      .toEqual({ x: -32, y: -16, width: 732, height: 516 });
  });
  it.each([0, -8, -24])("preserves a window touching or crossing the side border at %s", (x) => {
    const bounds = { x, y: 0, width: 600, height: 400 };
    expect(constrainFloatingWindow(bounds, viewport, minimum)).toEqual(bounds);
  });
  it("allows small right and bottom overflow", () => {
    const bounds = { x: 312, y: 212, width: 600, height: 400 };
    expect(constrainFloatingWindow(bounds, viewport, minimum)).toEqual(bounds);
  });
  it("keeps an offscreen title bar recoverable", () => {
    expect(constrainFloatingWindow({ x: -5000, y: -5000, width: 600, height: 400 }, viewport, minimum))
      .toEqual({ x: -32, y: -16, width: 600, height: 400 });
  });
  it("sanitizes stale non-finite viewport and bounds", () => {
    const result = constrainFloatingWindow({ x: NaN, y: Infinity, width: NaN, height: Infinity }, { width: NaN, height: Infinity }, minimum);
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });
  it.each([
    [95, 150, true], [205, 150, true], [150, 95, true], [150, 205, true],
    [88, 88, true], [87, 150, false], [150, 213, false],
  ])("guards the 12px click buffer at %s,%s", (x, y, near) => {
    expect(isPointNearWindow({ x, y }, { x: 100, y: 100, width: 100, height: 100 })).toBe(near);
  });
});
