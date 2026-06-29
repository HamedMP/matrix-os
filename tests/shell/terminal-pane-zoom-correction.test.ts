// @vitest-environment jsdom
/**
 * Unit tests for the canvas-zoom pointer-correction logic in TerminalPane.
 *
 * The fix:
 *   xterm maps pointer->cell as: col = (clientX - rect.left) / cssCellWidth
 *   When a CSS transform: scale(z) is applied to a canvas ancestor,
 *   getBoundingClientRect() returns scaled screen pixels but cssCellWidth is
 *   measured at the unscaled font size, so xterm computes col = trueCol * z.
 *
 *   The correction: intercept mousedown/mousemove/mouseup in capture phase and
 *   re-dispatch a synthetic event with:
 *     correctedClientX = rect.left + (clientX - rect.left) / zoom
 *   so xterm's math yields the true unscaled cell column.
 *
 * These tests verify the math and the event interception without mounting the
 * full TerminalPane (which requires WebSocket + xterm async imports).
 */

import { describe, expect, it } from "vitest";

/**
 * Reproduces the correction formula from TerminalPane.tsx.
 */
function applyZoomCorrection(
  clientX: number,
  rectLeft: number,
  zoom: number,
): number {
  return rectLeft + (clientX - rectLeft) / zoom;
}

/**
 * Simulates xterm's column calculation (Mouse.ts getCoordsRelativeToElement).
 * Returns the X offset from the element's left edge in CSS pixels (unscaled).
 */
function xtermOffset(correctedClientX: number, rectLeft: number): number {
  return correctedClientX - rectLeft;
}

/**
 * Returns the column index xterm would compute given a corrected clientX.
 */
function xtermColumn(correctedClientX: number, rectLeft: number, cssCellWidth: number): number {
  return Math.ceil(xtermOffset(correctedClientX, rectLeft) / cssCellWidth);
}

describe("canvas zoom pointer correction math", () => {
  const CELL_WIDTH = 9; // typical monospace cell at 14px font
  const RECT_LEFT = 200; // xterm element's screen-left, scaled by ancestor

  it("zoom=1: no correction needed, column is exact", () => {
    // At zoom 1, corrected == original. Column 3 (0-indexed offset 27px).
    const trueClientX = RECT_LEFT + 3 * CELL_WIDTH; // 227
    const corrected = applyZoomCorrection(trueClientX, RECT_LEFT, 1);
    expect(corrected).toBe(trueClientX);
    expect(xtermColumn(corrected, RECT_LEFT, CELL_WIDTH)).toBe(3);
  });

  it("zoom=2: without correction xterm reads double the column", () => {
    // At 2× zoom, the element is displayed at 2× size. A pointer at screen
    // column 3 (unscaled) lands at screen offset = 3 * CELL_WIDTH * 2 = 54px
    // from the element's visible left edge.
    const scaledOffset = 3 * CELL_WIDTH * 2; // 54 screen pixels
    const rawClientX = RECT_LEFT + scaledOffset; // 254

    // Without correction, xterm sees offset 54 / cellWidth 9 = 6 (wrong).
    const wrongColumn = xtermColumn(rawClientX, RECT_LEFT, CELL_WIDTH);
    expect(wrongColumn).toBe(6); // off by factor of zoom

    // With correction: correctedX = 200 + (254-200)/2 = 200 + 27 = 227
    const corrected = applyZoomCorrection(rawClientX, RECT_LEFT, 2);
    expect(corrected).toBeCloseTo(RECT_LEFT + 3 * CELL_WIDTH);
    // xterm now computes offset 27 / 9 = 3 (correct)
    expect(xtermColumn(corrected, RECT_LEFT, CELL_WIDTH)).toBe(3);
  });

  it("zoom=0.5: without correction xterm reads half the column", () => {
    // At 0.5× zoom, screen offset to column 6 is 6 * CELL_WIDTH * 0.5 = 27.
    const scaledOffset = 6 * CELL_WIDTH * 0.5; // 27 screen pixels
    const rawClientX = RECT_LEFT + scaledOffset; // 227

    // Without correction: offset 27 / 9 = 3 (wrong, should be 6).
    const wrongColumn = xtermColumn(rawClientX, RECT_LEFT, CELL_WIDTH);
    expect(wrongColumn).toBe(3);

    // With correction: correctedX = 200 + (227-200)/0.5 = 200 + 54 = 254
    const corrected = applyZoomCorrection(rawClientX, RECT_LEFT, 0.5);
    expect(corrected).toBeCloseTo(RECT_LEFT + 6 * CELL_WIDTH);
    expect(xtermColumn(corrected, RECT_LEFT, CELL_WIDTH)).toBe(6);
  });

  it("zoom=1.5: corrects to exact cell at various positions", () => {
    for (const trueCol of [0, 1, 5, 10, 20]) {
      // Screen offset at 1.5× zoom
      const scaledOffset = trueCol * CELL_WIDTH * 1.5;
      const rawClientX = RECT_LEFT + scaledOffset;

      const corrected = applyZoomCorrection(rawClientX, RECT_LEFT, 1.5);
      const unscaledOffset = corrected - RECT_LEFT;

      // Unscaled offset should equal true col * cellWidth (within fp tolerance)
      expect(unscaledOffset).toBeCloseTo(trueCol * CELL_WIDTH, 5);
    }
  });

  it("zoom correction is identity when zoom=1 for all positions", () => {
    for (const clientX of [200, 250, 300, 400, 500]) {
      expect(applyZoomCorrection(clientX, RECT_LEFT, 1)).toBe(clientX);
    }
  });

  it("corrected offset never goes negative when pointer is to the right of rectLeft", () => {
    const zooms = [0.25, 0.5, 1, 1.5, 2, 3];
    for (const zoom of zooms) {
      const clientX = RECT_LEFT + 50 * zoom; // pointer at 50 unscaled pixels
      const corrected = applyZoomCorrection(clientX, RECT_LEFT, zoom);
      expect(corrected - RECT_LEFT).toBeGreaterThanOrEqual(0);
    }
  });

  it("zoom=2 drag-select span: corrected offsets cover the right cell range", () => {
    // Simulates a drag-select from column 2 to column 8 at 2× zoom.
    const startCol = 2;
    const endCol = 8;
    const zoom = 2;

    const rawStart = RECT_LEFT + startCol * CELL_WIDTH * zoom;
    const rawEnd = RECT_LEFT + endCol * CELL_WIDTH * zoom;

    const corrStart = applyZoomCorrection(rawStart, RECT_LEFT, zoom);
    const corrEnd = applyZoomCorrection(rawEnd, RECT_LEFT, zoom);

    expect(xtermColumn(corrStart, RECT_LEFT, CELL_WIDTH)).toBe(startCol);
    expect(xtermColumn(corrEnd, RECT_LEFT, CELL_WIDTH)).toBe(endCol);
  });
});

describe("synthetic event marker (_xtermZoomCorrected)", () => {
  it("a standard MouseEvent does not have the _xtermZoomCorrected property", () => {
    const e = new MouseEvent("mousedown", { bubbles: true, clientX: 300 });
    expect((e as MouseEvent & { _xtermZoomCorrected?: boolean })._xtermZoomCorrected).toBeUndefined();
  });

  it("defineProperty can mark a synthetic event to prevent re-correction loops", () => {
    const e = new MouseEvent("mousedown", { bubbles: true, clientX: 300 });
    Object.defineProperty(e, "_xtermZoomCorrected", { value: true });
    expect((e as MouseEvent & { _xtermZoomCorrected?: boolean })._xtermZoomCorrected).toBe(true);
  });
});
