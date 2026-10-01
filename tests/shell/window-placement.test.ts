// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { constrainFloatingWindow, isPointNearWindow } from "../../packages/ui/src/window/window-placement";

describe("native outside resize clearance", () => {
  const options = { resizeTargetClearance: 16 };
  const viewport = { width: 1200, height: 700 };
  const minimum = { width: 440, height: 300 };
  it("keeps every external corner inside the work area for restored edge-flush bounds", () => {
    expect(constrainFloatingWindow({ x: 0, y: 0, width: 1200, height: 700 }, viewport, minimum, undefined, options))
      .toEqual({ x: 16, y: 16, width: 1168, height: 668 });
  });
  it("preserves the stationary edge while resizing up to the external clearance", () => {
    const previous = { x: 100, y: 100, width: 600, height: 400 };
    expect(constrainFloatingWindow({ ...previous, height: 700 }, viewport, minimum, previous, options))
      .toEqual({ ...previous, height: 584 });
    expect(constrainFloatingWindow({ x: -100, y: -100, width: 800, height: 600 }, viewport, minimum, previous, options))
      .toEqual({ x: 16, y: 16, width: 684, height: 484 });
  });
  it("fits small viewports without minimum dimensions hiding outside targets", () => {
    expect(constrainFloatingWindow({ x: -30, y: -30, width: 600, height: 400 }, { width: 300, height: 200 }, minimum, undefined, options))
      .toEqual({ x: 16, y: 16, width: 268, height: 168 });
  });
});

const viewport = { width: 900, height: 600 };
const minimum = { width: 320, height: 200 };
describe("floating window placement", () => {
  it("reserves the bottom boundary without changing side/top overflow", () => {
    expect(constrainFloatingWindow({ x: -100, y: -100, width: 1000, height: 900 }, viewport, minimum, undefined, { allowBottomOverflow: false }))
      .toEqual({ x: -32, y: -16, width: 964, height: 616 });
  });
  it("keeps the north edge stationary at a reserved bottom boundary", () => {
    const initial = { x: 100, y: 100, width: 600, height: 400 };
    expect(constrainFloatingWindow({ ...initial, height: 900 }, viewport, minimum, initial, { allowBottomOverflow: false }))
      .toEqual({ ...initial, height: 500 });
  });
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
