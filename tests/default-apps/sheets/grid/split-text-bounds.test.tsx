// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { MAX_ACTION_CELLS } from "../../../../home/apps/sheets/src/grid/actions-data";
import { splitTextToColumns } from "../../../../home/apps/sheets/src/ui/ribbon/data-tools";
import { renderGrid } from "./harness";

afterEach(cleanup);

// Outcome: Text to columns on text with very many parts is refused as soon as it would write more cells
// than one step can hold, so the tab stays responsive. Fault: every part of every cell is read, kept and
// checked before the total is compared, which freezes the tab on large selections.
describe("Text to columns stops at the cell limit", () => {
  it("refuses once the parts reach the limit, without reading the rest of the selection", async () => {
    const fields = 16_000;
    const rowsToLimit = Math.floor(MAX_ACTION_CELLS / fields);
    const rows = rowsToLimit + 8;
    const text = `${"x,".repeat(fields - 1)}x`;
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, Array.from({ length: rows }, () => [text]));
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: rows - 1, col: 0 } }));
    const raw = vi.spyOn(h.session, "raw");
    const isBlank = vi.spyOn(h.session, "isBlank");
    let result: ReturnType<typeof splitTextToColumns> | null = null;
    act(() => {
      result = splitTextToColumns(h.controller, "comma");
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("too many cells");
    // The row that would pass the limit is read, but none after it, and none of its destinations are checked.
    expect(raw.mock.calls.filter(([, , col]) => col === 0).length).toBeLessThanOrEqual(rowsToLimit + 1);
    expect(isBlank.mock.calls.length).toBeLessThanOrEqual(rowsToLimit * (fields - 1));
    expect(h.session.workbook.getCell(h.sheet, { row: 0, col: 1 }).value).toBeNull();
    h.unmount();
  });

  it("still refuses a cell whose parts would pass the last column", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, ",".repeat(20_000));
    });
    act(() => h.controller.select({ row: 0, col: 0 }));
    let result: ReturnType<typeof splitTextToColumns> | null = null;
    act(() => {
      result = splitTextToColumns(h.controller, "comma");
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("past the last column");
    h.unmount();
  });

  it("splits text that fits", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["a, b"], ["c,d,e"]]);
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }));
    let result: ReturnType<typeof splitTextToColumns> | null = null;
    act(() => {
      result = splitTextToColumns(h.controller, "comma");
    });
    expect(result!.ok).toBe(true);
    const value = (row: number, col: number) => h.session.workbook.getCell(h.sheet, { row, col }).value;
    expect([value(0, 0), value(0, 1), value(1, 0), value(1, 1), value(1, 2)]).toEqual(["a", "b", "c", "d", "e"]);
    h.unmount();
  });
});
