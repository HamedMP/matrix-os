// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { removeDuplicateRows } from "../../../../home/apps/sheets/src/ui/ribbon/data-tools";
import { type GridHarness, editor, press, renderGrid } from "./harness";

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

  it("Paste that starts on a hidden row writes from the first visible row below it", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ row: 2, col: 1 }));
    act(() => {
      h.controller.paste({ text: "30", html: "" });
    });
    expect([value(h, 2, 1), value(h, 3, 1)]).toEqual([2, 30]);
    expect(h.controller.getActiveRange()).toEqual({ start: { row: 3, col: 1 }, end: { row: 3, col: 1 } });
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

// Outcome: Enter and Tab inside a selected range stop only on rows the filter shows, so typing lands on
// the next visible record. Fault: the active cell moves onto a hidden row and typing changes it unseen.
describe("moving through a selected range on a filtered sheet", () => {
  it("skips hidden rows with Enter and Shift+Enter, and typing lands on the visible record", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 1, col: 1 }, end: { row: 3, col: 1 } }));
    press(h.grid, "Enter");
    expect(h.controller.getSelection().active).toEqual({ row: 3, col: 1 });
    press(h.grid, "Enter", { shiftKey: true });
    expect(h.controller.getSelection().active).toEqual({ row: 1, col: 1 });
    press(h.grid, "Enter", { shiftKey: true });
    expect(h.controller.getSelection().active).toEqual({ row: 3, col: 1 });
    act(() => h.controller.startEdit("30"));
    press(editor(h.container)!, "Enter");
    expect([value(h, 2, 1), value(h, 3, 1)]).toEqual([2, 30]);
    expect(h.controller.getSelection().active).toEqual({ row: 1, col: 1 });
    h.unmount();
  });

  it("skips hidden rows with Tab and Shift+Tab", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 1, col: 0 }, end: { row: 3, col: 1 } }));
    const visits: string[] = [];
    for (let i = 0; i < 4; i++) {
      press(h.grid, "Tab");
      const { row, col } = h.controller.getSelection().active;
      visits.push(`${row},${col}`);
    }
    expect(visits).toEqual(["1,1", "3,0", "3,1", "1,0"]);
    press(h.grid, "Tab", { shiftKey: true });
    expect(h.controller.getSelection().active).toEqual({ row: 3, col: 1 });
    h.unmount();
  });
});

// Outcome: after a sort the filter still shows exactly the records it matches. Fault: the hidden row
// numbers stay where they were, so a rejected record shows and a matching one disappears.
describe("sorting a filtered range", () => {
  async function filteredUnsorted(): Promise<GridHarness> {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["Region", "Amount"], ["East", 3], ["West", 1], ["East", 2]]);
    });
    act(() => h.controller.filter({ range: { start: { row: 0, col: 0 }, end: { row: 3, col: 1 } }, criteria: [{ col: 0, values: ["East"] }] }));
    return h;
  }
  const regionsShown = (h: GridHarness) => {
    const hidden = new Set(h.controller.context.view.filter?.hidden ?? []);
    return [1, 2, 3].filter((row) => !hidden.has(row)).map((row) => value(h, row, 0));
  };

  it("hides the rows the filter rejects after Sort, Undo and Redo", async () => {
    const h = await filteredUnsorted();
    expect(regionsShown(h)).toEqual(["East", "East"]);
    act(() => {
      h.controller.sortRange({ start: { row: 0, col: 0 }, end: { row: 3, col: 1 } }, [{ col: 1 }], true);
    });
    expect([value(h, 1, 1), value(h, 2, 1), value(h, 3, 1)]).toEqual([1, 2, 3]);
    expect(h.controller.isFiltered).toBe(true);
    expect(regionsShown(h)).toEqual(["East", "East"]);
    act(() => {
      h.controller.undo();
    });
    expect(regionsShown(h)).toEqual(["East", "East"]);
    act(() => {
      h.controller.redo();
    });
    expect(regionsShown(h)).toEqual(["East", "East"]);
    h.unmount();
  });

  it("hides the rows the filter rejects after sorting by the active column", async () => {
    const h = await filteredUnsorted();
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 3, col: 1 } }));
    act(() => h.controller.sort(true));
    expect(value(h, 1, 0)).toBe("West");
    expect(regionsShown(h)).toEqual(["East", "East"]);
    h.unmount();
  });

  it("drops the filter when columns are inserted, as it does for the other changes that move its columns", async () => {
    const h = await filteredUnsorted();
    act(() => h.controller.select({ row: 0, col: 0 }));
    act(() => h.controller.insertColumns("before"));
    expect(h.controller.isFiltered).toBe(false);
    h.unmount();
  });
});

// Outcome: after Remove duplicates the filter still shows exactly the records it matches. Fault: the
// records move up but the hidden row numbers stay, so a rejected record shows.
describe("removing duplicates in a filtered range", () => {
  it("hides the rows the filter rejects after the records move up", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["Region", "Amount"], ["East", 1], ["West", 2], ["East", 1], ["West", 3]]);
    });
    act(() => h.controller.filter({ range: { start: { row: 0, col: 0 }, end: { row: 4, col: 1 } }, criteria: [{ col: 0, values: ["East"] }] }));
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 4, col: 1 } }));
    let result: ReturnType<typeof removeDuplicateRows> | null = null;
    act(() => {
      result = removeDuplicateRows(h.controller);
    });
    expect(result).toMatchObject({ ok: true });
    expect([1, 2, 3].map((row) => value(h, row, 0))).toEqual(["East", "West", "West"]);
    const hidden = new Set(h.controller.context.view.filter?.hidden ?? []);
    expect([1, 2, 3].filter((row) => !hidden.has(row)).map((row) => value(h, row, 0))).toEqual(["East"]);
    h.unmount();
  });
});

// Outcome: Ctrl+D never copies a record the filter hides. Fault: a hidden row is the copy source.
describe("fill down on a filtered sheet", () => {
  it("copies a single cell from the nearest visible row above it", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ row: 3, col: 1 }));
    act(() => h.controller.fill("down"));
    expect([value(h, 2, 1), value(h, 3, 1)]).toEqual([2, 1]);
    h.unmount();
  });

  it("starts the copy at the first visible row of the selection", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ start: { row: 2, col: 1 }, end: { row: 4, col: 1 } }));
    act(() => h.controller.fill("down"));
    expect([value(h, 2, 1), value(h, 3, 1), value(h, 4, 1)]).toEqual([2, 1, 4]);
    h.unmount();
  });
});

describe("pasting a table that is too large", () => {
  it("says so and writes nothing when its spans cover too many cells", async () => {
    const h = await renderGrid();
    act(() => h.controller.select({ row: 0, col: 4 }));
    let pasted = true;
    act(() => {
      pasted = h.controller.paste({ text: "x", html: `<table><tr><td colspan="2000">x</td></tr>${"<tr></tr>".repeat(999)}</table>` });
    });
    expect(pasted).toBe(false);
    expect(value(h, 0, 4)).toBeNull();
    expect(h.container.querySelector("[role='alert']")?.textContent).toContain("That is too many cells for one step.");
    h.unmount();
  });
});

describe("cut and paste too large for one step", () => {
  // Fault: the move emptied the cut cells and filled the target past what one undo step keeps, so a failure could not put them back.
  it("refuses a move whose emptied and filled cells together pass the limit, before moving anything", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, "kept");
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 2999, col: 99 } }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.select({ row: 0, col: 200 }));
    let pasted = true;
    act(() => {
      pasted = h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect(pasted).toBe(false);
    expect(value(h, 0, 0)).toBe("kept");
    expect(value(h, 0, 200)).toBeNull();
    expect(h.container.querySelector("[role='alert']")?.textContent).toContain("That is too many cells for one step.");
    h.unmount();
  }, 60_000);
});

describe("cut on a filtered range", () => {
  function cutAndPaste(h: GridHarness, range: { start: { row: number; col: number }; end: { row: number; col: number } }): void {
    act(() => h.controller.select(range));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.select({ row: 0, col: 3 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
  }

  it("moves only the visible run when hidden rows follow it in the selection", async () => {
    const h = await filteredEast();
    cutAndPaste(h, { start: { row: 3, col: 1 }, end: { row: 4, col: 1 } });
    expect([value(h, 0, 3), value(h, 1, 3)]).toEqual([3, null]);
    expect([value(h, 3, 1), value(h, 4, 1)]).toEqual([null, 4]);
    h.unmount();
  });

  it("moves only the visible run when hidden rows come before it in the selection", async () => {
    const h = await filteredEast();
    cutAndPaste(h, { start: { row: 2, col: 1 }, end: { row: 3, col: 1 } });
    expect([value(h, 0, 3), value(h, 1, 3)]).toEqual([3, null]);
    expect([value(h, 2, 1), value(h, 3, 1)]).toEqual([2, null]);
    h.unmount();
  });

  // Outcome: a cut pasted at a row the filter hides lands in the first visible row below it, where the
  // selection then points. Fault: the hidden row is overwritten out of sight and the selection disagrees.
  it("moves into the first visible row when the paste starts on a hidden row", async () => {
    const h = await filteredEast();
    act(() => h.controller.select({ row: 3, col: 1 }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    // Row 3 (West, 2) is hidden; the name box can still select D3.
    act(() => h.controller.select({ row: 2, col: 3 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([value(h, 2, 3), value(h, 3, 3)]).toEqual([null, 3]);
    expect(value(h, 3, 1)).toBeNull();
    expect(h.controller.getActiveRange()).toEqual({ start: { row: 3, col: 3 }, end: { row: 3, col: 3 } });
    h.unmount();
  });

  it("refuses the move when a filter hid cut rows before the paste", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["Region", "Amount"], ["East", 1], ["West", 2], ["East", 3]]);
    });
    act(() => h.controller.select({ start: { row: 1, col: 1 }, end: { row: 2, col: 1 } }));
    let payload: ReturnType<typeof h.controller.cut> = null;
    act(() => {
      payload = h.controller.cut();
    });
    act(() => h.controller.filter({ range: { start: { row: 0, col: 0 }, end: { row: 3, col: 1 } }, criteria: [{ col: 0, values: ["East"] }] }));
    act(() => h.controller.select({ row: 0, col: 3 }));
    act(() => {
      h.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([value(h, 1, 1), value(h, 2, 1)]).toEqual([1, 2]);
    expect([value(h, 0, 3), value(h, 1, 3)]).toEqual([null, null]);
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

  const formulaAt = (h: GridHarness, row: number, col: number) => h.session.workbook.getCell(h.sheet, { row, col }).formula;

  it("moves the formula of every copied column by the distance it travelled", async () => {
    const source = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 5);
      workbook.setFormula(sheet, { row: 0, col: 1 }, "A1*2");
      workbook.setFormula(sheet, { row: 0, col: 2 }, "A1+B1");
    });
    act(() => source.controller.select({ start: { row: 0, col: 0 }, end: { row: 0, col: 2 } }));
    let payload: ReturnType<typeof source.controller.copy> = null;
    act(() => {
      payload = source.controller.copy();
    });
    source.unmount();

    const target = await renderGrid();
    act(() => target.controller.select({ row: 0, col: 3 }));
    act(() => {
      target.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([formulaAt(target, 0, 4), formulaAt(target, 0, 5)]).toEqual(["D1*2", "D1+E1"]);
    expect(value(target, 0, 4)).toBe(10);
    target.unmount();
  });

  it("moves the formula of each copied row from the row it was copied from, across rows a filter hid", async () => {
    const source = await filteredEast();
    act(() => {
      source.session.mutate((workbook) => {
        for (let row = 1; row <= 4; row++) workbook.setFormula(source.sheet, { row, col: 2 }, `B${row + 1}*10`);
      });
    });
    act(() => source.controller.select({ start: { row: 1, col: 1 }, end: { row: 4, col: 2 } }));
    let payload: ReturnType<typeof source.controller.copy> = null;
    act(() => {
      payload = source.controller.copy();
    });
    source.unmount();

    const target = await renderGrid();
    act(() => target.controller.select({ row: 0, col: 4 }));
    act(() => {
      target.controller.paste({ text: payload!.text, html: payload!.html });
    });
    expect([formulaAt(target, 0, 5), formulaAt(target, 1, 5)]).toEqual(["E1*10", "E2*10"]);
    expect([value(target, 0, 5), value(target, 1, 5)]).toEqual([10, 30]);
    target.unmount();
  });
});
