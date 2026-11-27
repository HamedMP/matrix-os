// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { removeDuplicateRows, splitTextToColumns } from "../../../../home/apps/sheets/src/ui/ribbon/data-tools";
import { type GridHarness, renderGrid } from "./harness";

afterEach(cleanup);

const notice = (h: GridHarness) => h.container.querySelector(".sg-notice")?.textContent ?? "";
const value = (h: GridHarness, row: number, col: number) => h.session.workbook.getCell(h.sheet, { row, col }).value;
const grid = (h: GridHarness, rows: number, cols: number) =>
  Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => value(h, row, col)));

/** A1:B1 merged holding "z"; A2 = "a", B2 = "b". */
async function mergedTop(): Promise<GridHarness> {
  return renderGrid((workbook: Workbook, sheet: string) => {
    workbook.setRange(sheet, { row: 0, col: 0 }, [["z", null], ["a", "b"]]);
    workbook.mergeCells(sheet, { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } });
  });
}

// Outcome: a data tool that moves rows never writes a value into a cell a merge hides.
// Fault: the moved value lands in the covered half of a merged cell and the owner loses it.
describe("data tools refuse ranges with merged cells", () => {
  it("Sort refuses a range that holds a merged cell and changes nothing", async () => {
    const h = await mergedTop();
    let sorted = true;
    act(() => {
      sorted = h.controller.sortRange({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }, [{ col: 0, descending: false }], false);
    });
    expect(sorted).toBe(false);
    expect(notice(h)).toContain("merged");
    expect(grid(h, 2, 2)).toEqual([["z", null], ["a", "b"]]);
    expect(h.session.getState().canUndo).toBe(false);
    h.unmount();
  });

  it("Sort refuses a range a merge only partly overlaps", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["z", null], ["a", "b"]]);
      workbook.mergeCells(sheet, { start: { row: 0, col: 1 }, end: { row: 0, col: 2 } });
    });
    let sorted = true;
    act(() => {
      sorted = h.controller.sortRange({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }, [{ col: 0, descending: false }], false);
    });
    expect(sorted).toBe(false);
    expect(grid(h, 2, 2)).toEqual([["z", null], ["a", "b"]]);
    h.unmount();
  });

  it("Sort still works on a range next to a merge", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["z"], ["a"]]);
      workbook.mergeCells(sheet, { start: { row: 0, col: 1 }, end: { row: 0, col: 2 } });
    });
    act(() => {
      h.controller.sortRange({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }, [{ col: 0, descending: false }], false);
    });
    expect(grid(h, 2, 1)).toEqual([["a"], ["z"]]);
    h.unmount();
  });

  it("Remove duplicates refuses a range that holds a merged cell and changes nothing", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["x", "y"], ["x", "y"], ["a", "b"]]);
      workbook.mergeCells(sheet, { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } });
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 2, col: 1 } }));
    let result: ReturnType<typeof removeDuplicateRows> | null = null;
    act(() => {
      result = removeDuplicateRows(h.controller);
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("merged");
    expect(h.session.getState().canUndo).toBe(false);
    h.unmount();
  });

  it("Fill down refuses to write into a merged cell and changes nothing", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a", "b"]]);
      workbook.mergeCells(sheet, { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } });
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }));
    act(() => h.controller.fill("down"));
    expect(notice(h)).toContain("merged");
    expect(grid(h, 2, 2)).toEqual([["a", "b"], [null, null]]);
    expect(h.session.getState().canUndo).toBe(false);
    h.unmount();
  });

  it("Split text to columns refuses to put a part under a merged cell", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 1, col: 0 }, "x,y");
      workbook.mergeCells(sheet, { start: { row: 0, col: 1 }, end: { row: 1, col: 1 } });
    });
    act(() => h.controller.select({ row: 1, col: 0 }));
    let result: ReturnType<typeof splitTextToColumns> | null = null;
    act(() => {
      result = splitTextToColumns(h.controller, "comma");
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("merged");
    expect(grid(h, 2, 2)).toEqual([[null, null], ["x,y", null]]);
    h.unmount();
  });
});

// Outcome: a paste never puts a value where a merged cell hides it. Fault: the pasted value is written
// into the covered half of a merge and vanishes from the sheet.
describe("paste and move into merged cells", () => {
  const mergedSecondRow = () =>
    renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 3 }, [["p", "q"]]);
      workbook.mergeCells(sheet, { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } });
    });

  it("refuses a pasted row that would land under a merged cell", async () => {
    const h = await mergedSecondRow();
    act(() => h.controller.select({ row: 1, col: 0 }));
    let pasted = true;
    act(() => {
      pasted = h.controller.paste({ text: "1\t2", html: "" });
    });
    expect(pasted).toBe(false);
    expect(notice(h)).toContain("merged");
    expect([value(h, 1, 0), value(h, 1, 1)]).toEqual([null, null]);
    h.unmount();
  });

  it("refuses a copied block that would land under a merged cell", async () => {
    const h = await mergedSecondRow();
    act(() => h.controller.select({ start: { row: 0, col: 3 }, end: { row: 0, col: 4 } }));
    let payload: ReturnType<typeof h.controller.copy> = null;
    act(() => {
      payload = h.controller.copy();
    });
    act(() => h.controller.select({ row: 1, col: 0 }));
    let pasted = true;
    act(() => {
      pasted = h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect(pasted).toBe(false);
    expect([value(h, 1, 0), value(h, 1, 1)]).toEqual([null, null]);
    h.unmount();
  });

  it("refuses a cut block that would land under a merged cell and keeps the cut cells", async () => {
    const h = await mergedSecondRow();
    act(() => h.controller.select({ start: { row: 0, col: 3 }, end: { row: 0, col: 4 } }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.select({ row: 1, col: 0 }));
    let pasted = true;
    act(() => {
      pasted = h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect(pasted).toBe(false);
    expect(notice(h)).toContain("merged");
    expect([value(h, 0, 3), value(h, 0, 4), value(h, 1, 0), value(h, 1, 1)]).toEqual(["p", "q", null, null]);
    h.unmount();
  });

  it("still pastes one value into a merged cell", async () => {
    const h = await mergedSecondRow();
    act(() => h.controller.select({ start: { row: 1, col: 0 }, end: { row: 1, col: 1 } }));
    act(() => {
      h.controller.paste({ text: "5", html: "" });
    });
    expect(value(h, 1, 0)).toBe(5);
    h.unmount();
  });
});
