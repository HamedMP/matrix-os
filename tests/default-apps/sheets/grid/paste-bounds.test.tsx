// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "../../../../home/apps/sheets/src/session/engine";
import { type GridHarness, renderGrid } from "./harness";

afterEach(cleanup);

const value = (h: GridHarness, row: number, col: number) => h.session.workbook.getCell(h.sheet, { row, col }).value;
const notice = (h: GridHarness) => h.container.querySelector(".sg-notice")?.textContent ?? "";

function paste(h: GridHarness, data: { text: string; html: string }): boolean {
  let pasted = false;
  act(() => {
    pasted = h.controller.paste(data);
  });
  return pasted;
}

function copy(h: GridHarness, cut: boolean): { text: string; html: string } {
  let payload: { text: string; html: string } | null = null;
  act(() => {
    payload = cut ? h.controller.cut() : h.controller.copy();
  });
  if (payload === null) throw new Error("nothing was copied");
  return payload;
}

// Outcome: a paste that does not fit on the sheet is refused as a whole, and the owner is told why.
// Fault: cells past the last column or row were skipped without a word and the paste counted as done.
describe("a paste that would go past the edge of the sheet", () => {
  it("refuses text pasted into the last column when it has more than one field", async () => {
    const h = await renderGrid();
    act(() => h.controller.select({ row: 0, col: MAX_COLS - 1 }));
    expect(paste(h, { text: "left\tright", html: "" })).toBe(false);
    expect(value(h, 0, MAX_COLS - 1)).toBeNull();
    expect(notice(h)).toContain("past the last column");
    h.unmount();
  });

  it("refuses text pasted into the last row when it has more than one line", async () => {
    const h = await renderGrid();
    act(() => h.controller.select({ row: MAX_ROWS - 1, col: 0 }));
    expect(paste(h, { text: "top\nbottom", html: "" })).toBe(false);
    expect(value(h, MAX_ROWS - 1, 0)).toBeNull();
    expect(notice(h)).toContain("past the last row");
    h.unmount();
  });

  it("refuses cells copied in the app when they would go past the last column", async () => {
    const h = await renderGrid((workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a", "b"]]);
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }));
    const payload = copy(h, false);
    act(() => h.controller.select({ row: 3, col: MAX_COLS - 1 }));
    expect(paste(h, payload)).toBe(false);
    expect(value(h, 3, MAX_COLS - 1)).toBeNull();
    expect(notice(h)).toContain("past the last column");
    h.unmount();
  });

  it("refuses cells copied in the app when they would go past the last row", async () => {
    const h = await renderGrid((workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a"], ["b"]]);
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }));
    const payload = copy(h, false);
    act(() => h.controller.select({ row: MAX_ROWS - 1, col: 2 }));
    expect(paste(h, payload)).toBe(false);
    expect(value(h, MAX_ROWS - 1, 2)).toBeNull();
    expect(notice(h)).toContain("past the last row");
    h.unmount();
  });

  it("refuses a cut and paste that would go past the last column and leaves the cut cells in place", async () => {
    const h = await renderGrid((workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a", "b"]]);
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }));
    const payload = copy(h, true);
    act(() => h.controller.select({ row: 3, col: MAX_COLS - 1 }));
    expect(paste(h, payload)).toBe(false);
    expect([value(h, 0, 0), value(h, 0, 1), value(h, 3, MAX_COLS - 1)]).toEqual(["a", "b", null]);
    expect(notice(h)).toContain("past the last column");
    h.unmount();
  });

  it("refuses a cut and paste that would go past the last row", async () => {
    const h = await renderGrid((workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a"], ["b"]]);
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }));
    const payload = copy(h, true);
    act(() => h.controller.select({ row: MAX_ROWS - 1, col: 2 }));
    expect(paste(h, payload)).toBe(false);
    expect([value(h, 0, 0), value(h, 1, 0)]).toEqual(["a", "b"]);
    expect(notice(h)).toContain("past the last row");
    h.unmount();
  });

  it("still pastes a block that ends exactly on the last column", async () => {
    const h = await renderGrid();
    act(() => h.controller.select({ row: 0, col: MAX_COLS - 2 }));
    expect(paste(h, { text: "left\tright", html: "" })).toBe(true);
    expect([value(h, 0, MAX_COLS - 2), value(h, 0, MAX_COLS - 1)]).toEqual(["left", "right"]);
    h.unmount();
  });
});
