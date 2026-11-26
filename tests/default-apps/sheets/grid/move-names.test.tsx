// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { type GridHarness, renderGrid } from "./harness";

afterEach(cleanup);

/** A1 = 5 named Total, B1 = Total*2; C1 = 7 named Rate on this sheet only; D1 named Gone. */
async function namedCells(): Promise<GridHarness> {
  return renderGrid((workbook: Workbook, sheet: string) => {
    const name = workbook.getSheet(sheet).name;
    workbook.setCell(sheet, { row: 0, col: 0 }, 5);
    workbook.setFormula(sheet, { row: 0, col: 1 }, "Total*2");
    workbook.setCell(sheet, { row: 0, col: 2 }, 7);
    workbook.setDefinedName({ name: "Total", refersTo: `${name}!$A$1`, scope: null });
    workbook.setDefinedName({ name: "Rate", refersTo: "$C$1", scope: sheet });
    workbook.setDefinedName({ name: "Gone", refersTo: `${name}!$F$5`, scope: null });
  });
}

function names(h: GridHarness): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of h.session.workbook.listDefinedNames()) out[name.name] = name.refersTo;
  return out;
}

function cutAndPaste(h: GridHarness, from: { start: { row: number; col: number }; end: { row: number; col: number } }, to: { row: number; col: number }): void {
  act(() => h.controller.select(from));
  let payload: ReturnType<typeof h.controller.cut> = null;
  act(() => {
    payload = h.controller.cut();
  });
  act(() => h.controller.select(to));
  act(() => {
    h.controller.paste({ text: payload!.text, html: payload!.html });
  });
}

describe("cut and paste moves defined names with their cells", () => {
  it("points a name at the cell's new place, and undo and redo put it back and again", async () => {
    const h = await namedCells();
    const sheetName = h.session.workbook.getSheet(h.sheet).name;
    // A1 and C1 move to E5 and G5: Total and the sheet's own Rate follow; Gone named F5, which the paste overwrites.
    cutAndPaste(h, { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } }, { row: 4, col: 4 });
    expect(names(h)).toEqual({ Total: `${sheetName}!$E$5`, Rate: "$G$5", Gone: "#REF!" });
    expect(h.session.cell(h.sheet, 4, 5)).toMatchObject({ formula: "Total*2", value: 10 });

    act(() => {
      h.session.undo();
    });
    expect(names(h)).toEqual({ Total: `${sheetName}!$A$1`, Rate: "$C$1", Gone: `${sheetName}!$F$5` });
    expect(h.session.cell(h.sheet, 0, 1)).toMatchObject({ formula: "Total*2", value: 10 });

    act(() => {
      h.session.redo();
    });
    expect(names(h)).toEqual({ Total: `${sheetName}!$E$5`, Rate: "$G$5", Gone: "#REF!" });
    h.unmount();
  });

  it("leaves names that read other cells as they are", async () => {
    const h = await namedCells();
    const sheetName = h.session.workbook.getSheet(h.sheet).name;
    cutAndPaste(h, { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } }, { row: 9, col: 9 });
    expect(names(h)).toEqual({ Total: `${sheetName}!$A$1`, Rate: "$C$1", Gone: `${sheetName}!$F$5` });
    expect(h.session.cell(h.sheet, 9, 9)).toMatchObject({ formula: "Total*2", value: 10 });
    h.unmount();
  });
});
