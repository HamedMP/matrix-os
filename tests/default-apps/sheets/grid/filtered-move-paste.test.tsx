// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { type GridHarness, renderGrid } from "./harness";

afterEach(cleanup);

/** Region/Amount: East 1, West 2, East 3, West 4, filtered to East. */
async function filteredEast(): Promise<GridHarness> {
  const h = await renderGrid((workbook: Workbook, sheet: string) => {
    workbook.setRange(sheet, { row: 0, col: 0 }, [["Region", "Amount"], ["East", 1], ["West", 2], ["East", 3], ["West", 4]]);
  });
  act(() => h.controller.filter({ range: { start: { row: 0, col: 0 }, end: { row: 4, col: 1 } }, criteria: [{ col: 0, values: ["East"] }] }));
  return h;
}

const value = (h: GridHarness, row: number, col: number) => h.session.workbook.getCell(h.sheet, { row, col }).value;

describe("actions on a filtered range leave hidden rows alone", () => {
  it("Delete clears only the visible cells", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 1, col: 1 }, end: { row: 5, col: 1 } }));
    act(() => h.controller.clear());
    expect([value(h, 1, 1), value(h, 2, 1), value(h, 3, 1), value(h, 4, 1)]).toEqual([null, 2, null, 4]);
    h.unmount();
  });

  it("Copy takes the visible rows only, and pasting it back writes those rows", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 1, col: 1 }, end: { row: 5, col: 1 } }));
    let payload: ReturnType<typeof h.controller.copy> = null;
    act(() => {
      payload = h.controller.copy();
    });
    expect(payload!.text.replace(/\n+$/, "")).toBe("1\n3");
    act(() => h.controller.select({ row: 0, col: 3 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([value(h, 0, 3), value(h, 1, 3)]).toEqual([1, 3]);
    h.unmount();
  });

  it("Fill down skips hidden rows", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 1, col: 1 }, end: { row: 3, col: 1 } }));
    act(() => h.controller.fill("down"));
    expect([value(h, 1, 1), value(h, 2, 1), value(h, 3, 1)]).toEqual([1, 2, 1]);
    h.unmount();
  });

  it("Paste into a filtered range fills the visible rows in order", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ row: 1, col: 1 }));
    act(() => {
      h.controller.paste({ text: "10\n30", html: "" });
    });
    expect([value(h, 1, 1), value(h, 2, 1), value(h, 3, 1), value(h, 4, 1)]).toEqual([10, 2, 30, 4]);
    h.unmount();
  });
});

describe("cut and paste moves cells", () => {
  it("rewrites the formulas that refer to the moved cells", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 10);
      workbook.setFormula(sheet, { row: 0, col: 1 }, "A1*2");
    });
    act(() => h.controller.select({ row: 0, col: 0 }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.select({ row: 0, col: 2 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    const b1 = h.session.workbook.getCell(h.sheet, { row: 0, col: 1 });
    expect(value(h, 0, 0)).toBeNull();
    expect(value(h, 0, 2)).toBe(10);
    expect(b1.formula).toBe("C1*2");
    expect(b1.value).toBe(20);
    act(() => {
      h.controller.undo();
    });
    expect(h.session.workbook.getCell(h.sheet, { row: 0, col: 1 }).formula).toBe("A1*2");
    expect(value(h, 0, 0)).toBe(10);
    h.unmount();
  });

  it("moves references inside the moved block with it", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 4);
      workbook.setFormula(sheet, { row: 1, col: 0 }, "A1+1");
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.select({ row: 0, col: 3 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect(h.session.workbook.getCell(h.sheet, { row: 1, col: 3 }).formula).toBe("D1+1");
    expect(value(h, 1, 3)).toBe(5);
    h.unmount();
  });
});

describe("pasting cells copied in another window", () => {
  it("keeps full values and text that looks like a number", async () => {
    const source = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 3.14159265);
      workbook.setStyle(sheet, { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, { numberFormat: "0.00" });
      workbook.setCell(sheet, { row: 0, col: 1 }, "007");
      workbook.setCell(sheet, { row: 0, col: 2 }, 1234567.5);
      workbook.setStyle(sheet, { start: { row: 0, col: 2 }, end: { row: 0, col: 2 } }, { numberFormat: "#,##0.00" });
      workbook.setCell(sheet, { row: 0, col: 3 }, true);
    });
    act(() => source.controller.select({ start: { row: 0, col: 0 }, end: { row: 0, col: 3 } }));
    let payload: ReturnType<typeof source.controller.copy> = null;
    act(() => {
      payload = source.controller.copy();
    });
    expect(payload!.text).toContain("3.14");
    source.unmount();

    const target = await renderGrid((workbook: Workbook, sheet: string) => workbook.setCell(sheet, { row: 9, col: 9 }, 0));
    act(() => target.controller.select({ row: 2, col: 0 }));
    act(() => {
      target.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([value(target, 2, 0), value(target, 2, 1), value(target, 2, 2), value(target, 2, 3)]).toEqual([3.14159265, "007", 1234567.5, true]);
    target.unmount();
  });
});
