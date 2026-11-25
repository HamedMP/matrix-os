import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "../../../../home/apps/_shared/office-engine/index";
import { columnWidthToPx, createAxis, gridExtent, pxToColumnWidth, pxToRowHeight, rangeRect, rowHeightToPx } from "../../../../home/apps/sheets/src/grid/geometry";
import {
  cellAtPoint,
  computeViewport,
  createScrollScale,
  maxScroll,
  pageRows,
  rangeOnScreen,
  scrollToReveal,
  shownIndexes,
  spanLength,
  type ViewportInput,
} from "../../../../home/apps/sheets/src/grid/viewport";
import type { GridLayout } from "../../../../home/apps/sheets/src/grid/context";
import { activeOnScreen, paneSpecs } from "../../../../home/apps/sheets/src/grid/render-model";

describe("axis", () => {
  it("places uniform rows and finds them again", () => {
    const axis = createAxis(100_000, 20);
    expect(axis.total).toBe(2_000_000);
    expect(axis.offsetOf(0)).toBe(0);
    expect(axis.offsetOf(71_234)).toBe(1_424_680);
    expect(axis.indexAt(1_424_680)).toBe(71_234);
    expect(axis.indexAt(1_424_699)).toBe(71_234);
    expect(axis.indexAt(1_424_700)).toBe(71_235);
    expect(axis.indexAt(-5)).toBe(0);
    expect(axis.indexAt(9e9)).toBe(99_999);
    expect(axis.offsetOf(100_000)).toBe(axis.total);
  });

  it("accounts for resized and hidden entries", () => {
    const axis = createAxis(50, 20, [
      [2, 50],
      [5, 0],
      [6, 0],
      [10, 5],
    ]);
    expect(axis.sizeOf(2)).toBe(50);
    expect(axis.sizeOf(5)).toBe(0);
    expect(axis.offsetOf(2)).toBe(40);
    expect(axis.offsetOf(3)).toBe(90);
    expect(axis.offsetOf(5)).toBe(130);
    expect(axis.offsetOf(7)).toBe(130);
    expect(axis.offsetOf(11)).toBe(130 + 60 + 5);
    expect(axis.total).toBe(50 * 20 + 30 - 40 - 15);
    expect(axis.indexAt(40)).toBe(2);
    expect(axis.indexAt(89)).toBe(2);
    expect(axis.indexAt(90)).toBe(3);
    // Hidden entries are never hit: the pixel belongs to the next visible one.
    expect(axis.indexAt(130)).toBe(7);
    expect(axis.indexAt(190)).toBe(10);
    expect(axis.indexAt(195)).toBe(11);
  });

  it("agrees with a plain sum for every index", () => {
    const overrides: Array<[number, number]> = [
      [0, 33],
      [3, 0],
      [4, 7],
      [9, 120],
      [10, 0],
      [19, 41],
    ];
    const axis = createAxis(20, 16, overrides);
    const sizes = Array.from({ length: 20 }, (_, i) => overrides.find((entry) => entry[0] === i)?.[1] ?? 16);
    let offset = 0;
    for (let index = 0; index < 20; index++) {
      expect(axis.offsetOf(index)).toBe(offset);
      for (let px = 0; px < (sizes[index] as number); px++) expect(axis.indexAt(offset + px)).toBe(index);
      offset += sizes[index] as number;
    }
    expect(axis.total).toBe(offset);
  });

  it("steps over a run of hidden entries at once", () => {
    const hidden: Array<[number, number]> = [];
    for (let index = 1; index < 999_999; index++) hidden.push([index, 0]);
    const axis = createAxis(1_000_000, 20, hidden);
    expect(axis.nextVisible(0)).toBe(0);
    expect(axis.nextVisible(1)).toBe(999_999);
    expect(axis.nextVisible(500_000)).toBe(999_999);
    expect(axis.nextVisible(1_000_000)).toBe(1_000_000);
    expect(createAxis(5, 20, [[4, 0]]).nextVisible(4)).toBe(5);
    // A filter that keeps two rows of a million: the rows on screen are those two, not every row between them.
    const viewport = computeViewport({ axes: { rows: axis, cols: createAxis(26, 80) }, frozenRows: 0, frozenCols: 0, scrollTop: 0, scrollLeft: 0, width: 800, height: 400 });
    expect(shownIndexes(axis, viewport.rows)).toEqual([0, 999_999]);
    expect(shownIndexes(createAxis(10, 20, [[3, 0], [4, 0]]), { start: 2, end: 6 })).toEqual([2, 5, 6]);
  });

  it("converts file units to pixels and back", () => {
    expect(columnWidthToPx(8.43)).toBe(64);
    expect(pxToColumnWidth(64)).toBeCloseTo(8.43, 2);
    expect(rowHeightToPx(15)).toBe(20);
    expect(pxToRowHeight(20)).toBe(15);
  });

  it("sizes the grid to the used area with room to grow, within a sheet", () => {
    expect(gridExtent(null)).toEqual({ rows: 200, cols: 26 });
    expect(gridExtent({ start: { row: 0, col: 0 }, end: { row: 99_999, col: 499 } })).toEqual({ rows: 100_100, cols: 513 });
    expect(gridExtent(null, [{ row: MAX_ROWS - 1, col: MAX_COLS - 1 }])).toEqual({ rows: MAX_ROWS, cols: MAX_COLS });
  });
});

function input(overrides: Partial<ViewportInput> = {}): ViewportInput {
  return {
    axes: { rows: createAxis(100_000, 20), cols: createAxis(500, 80) },
    frozenRows: 0,
    frozenCols: 0,
    scrollTop: 0,
    scrollLeft: 0,
    width: 800,
    height: 400,
    overscan: 2,
    ...overrides,
  };
}

describe("viewport", () => {
  it("renders only the cells on screen, whatever the sheet size", () => {
    const viewport = computeViewport(input({ scrollTop: 1_000_000, scrollLeft: 20_000 }));
    expect(viewport.visibleRows).toEqual({ start: 50_000, end: 50_019 });
    expect(viewport.visibleCols).toEqual({ start: 250, end: 259 });
    expect(viewport.rows).toEqual({ start: 49_998, end: 50_021 });
    expect(viewport.cols).toEqual({ start: 248, end: 261 });
    expect(spanLength(viewport.rows) * spanLength(viewport.cols)).toBeLessThan(400);
  });

  it("includes a partly visible last row and clamps the scroll to the sheet", () => {
    expect(computeViewport(input({ scrollTop: 10 })).visibleRows).toEqual({ start: 0, end: 20 });
    const end = computeViewport(input({ scrollTop: 9e9, scrollLeft: 9e9 }));
    expect(end.scrollTop).toBe(100_000 * 20 - 400);
    expect(end.visibleRows.end).toBe(99_999);
    expect(end.rows.end).toBe(99_999);
    expect(end.visibleCols.end).toBe(499);
    expect(maxScroll(input())).toEqual({ top: 1_999_600, left: 39_200 });
  });

  it("keeps frozen rows and columns out of the scrolling part", () => {
    const viewport = computeViewport(input({ frozenRows: 2, frozenCols: 1, scrollTop: 200, scrollLeft: 160 }));
    expect(viewport.frozenHeight).toBe(40);
    expect(viewport.frozenWidth).toBe(80);
    expect(viewport.frozenRows).toEqual({ start: 0, end: 1 });
    expect(viewport.frozenCols).toEqual({ start: 0, end: 0 });
    expect(viewport.visibleRows).toEqual({ start: 12, end: 29 });
    expect(viewport.visibleCols).toEqual({ start: 3, end: 11 });
    // Overscan never reaches back into the frozen part.
    expect(computeViewport(input({ frozenRows: 2 })).rows.start).toBe(2);
  });

  it("draws only the frozen rows and columns that fit, however many are frozen", () => {
    const viewport = computeViewport(input({ frozenRows: 99_999, frozenCols: 499 }));
    // Navigation still sees every frozen row and column.
    expect(viewport.frozenRows).toEqual({ start: 0, end: 99_998 });
    expect(viewport.frozenCols).toEqual({ start: 0, end: 498 });
    // 400px of 20px rows and 800px of 80px columns, plus the overscan.
    expect(viewport.drawnFrozenRows).toEqual({ start: 0, end: 21 });
    expect(viewport.drawnFrozenCols).toEqual({ start: 0, end: 11 });
    const layout = { viewport, viewportInput: input({ frozenRows: 99_999, frozenCols: 499 }) } as unknown as GridLayout;
    let cells = 0;
    for (const pane of paneSpecs(layout)) cells += spanLength(pane.rows) * spanLength(pane.cols);
    expect(cells).toBeLessThan(1_000);
    // A few frozen rows are all drawn.
    expect(computeViewport(input({ frozenRows: 2, frozenCols: 1 })).drawnFrozenRows).toEqual({ start: 0, end: 1 });
    expect(computeViewport(input()).drawnFrozenRows).toEqual({ start: 0, end: -1 });
  });

  it("counts a frozen cell past the drawn part as off screen", () => {
    const viewportInput = input({ frozenRows: 99_999, frozenCols: 1 });
    const layout = { viewport: computeViewport(viewportInput), viewportInput } as unknown as GridLayout;
    expect(activeOnScreen(layout, { row: 3, col: 0 })).toBe(true);
    expect(activeOnScreen(layout, { row: 50_000, col: 0 })).toBe(false);
  });

  it("finds the cell under a point in each pane", () => {
    const base = input({ frozenRows: 2, frozenCols: 1, scrollTop: 200, scrollLeft: 160 });
    const viewport = computeViewport(base);
    expect(cellAtPoint(base.axes, viewport, 10, 10)).toEqual({ row: 0, col: 0 });
    expect(cellAtPoint(base.axes, viewport, 90, 10)).toEqual({ row: 0, col: 3 });
    expect(cellAtPoint(base.axes, viewport, 10, 45)).toEqual({ row: 12, col: 0 });
    expect(cellAtPoint(base.axes, viewport, 90, 45)).toEqual({ row: 12, col: 3 });
    expect(cellAtPoint(base.axes, viewport, -50, -50)).toEqual({ row: 0, col: 0 });
  });

  it("places ranges on screen and hides what scrolled under the frozen part", () => {
    const base = input({ frozenRows: 2, frozenCols: 1, scrollTop: 200, scrollLeft: 160 });
    const viewport = computeViewport(base);
    expect(rangeOnScreen(base.axes, viewport, { start: { row: 12, col: 3 }, end: { row: 13, col: 4 } })).toEqual({ x: 80, y: 40, width: 160, height: 40 });
    expect(rangeOnScreen(base.axes, viewport, { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } })).toEqual({ x: 0, y: 0, width: 80, height: 20 });
    expect(rangeOnScreen(base.axes, viewport, { start: { row: 4, col: 3 }, end: { row: 5, col: 3 } })).toBeNull();
    // A range that starts under the frozen rows shows only the part still in view.
    expect(rangeOnScreen(base.axes, viewport, { start: { row: 10, col: 3 }, end: { row: 12, col: 3 } })).toEqual({ x: 80, y: 40, width: 80, height: 20 });
    expect(rangeRect(base.axes, { start: { row: 1, col: 1 }, end: { row: 2, col: 2 } })).toEqual({ x: 80, y: 20, width: 160, height: 40 });
  });

  it("scrolls the least needed to reveal a cell", () => {
    const base = input({ frozenRows: 1, frozenCols: 1 });
    expect(scrollToReveal(base, { row: 5, col: 2 })).toEqual({ scrollTop: 0, scrollLeft: 0 });
    expect(scrollToReveal(base, { row: 30, col: 2 })).toEqual({ scrollTop: 31 * 20 - 400, scrollLeft: 0 });
    expect(scrollToReveal(base, { row: 5, col: 20 })).toEqual({ scrollTop: 0, scrollLeft: 21 * 80 - 800 });
    const scrolled = { ...base, scrollTop: 1000, scrollLeft: 800 };
    expect(scrollToReveal(scrolled, { row: 10, col: 3 })).toEqual({ scrollTop: 10 * 20 - 20, scrollLeft: 3 * 80 - 80 });
    // A frozen cell needs no scrolling.
    expect(scrollToReveal(scrolled, { row: 0, col: 0 })).toEqual({ scrollTop: 1000, scrollLeft: 800 });
    expect(pageRows(computeViewport(base))).toBe(18);
  });

  it("scales the scrollbar for sheets taller than the browser can scroll", () => {
    const small = createScrollScale(2_000_000);
    expect(small.nativeMax).toBe(2_000_000);
    expect(small.toSheet(123_456)).toBe(123_456);
    const tall = createScrollScale(MAX_ROWS * 20 - 400, 8_000_000);
    expect(tall.nativeMax).toBe(8_000_000);
    expect(tall.toSheet(0)).toBe(0);
    expect(tall.toSheet(8_000_000)).toBe(MAX_ROWS * 20 - 400);
    expect(tall.toSheet(tall.toNative(10_000_000))).toBe(10_000_000);
  });
});
