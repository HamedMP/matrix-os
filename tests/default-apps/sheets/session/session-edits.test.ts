import { describe, expect, it } from "vitest";
import { opc } from "../../../../home/apps/_shared/office-engine/index";
import { type SessionEvent, type SheetSession, createSheetSession, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness, sampleXlsx, settle } from "./fakes";

async function open(): Promise<{ session: SheetSession; sheet: string; events: SessionEvent[] }> {
  const h = harness();
  h.files.put("Budget.xlsx", await sampleXlsx());
  const session = await openSheetSession(h.deps, "Budget.xlsx");
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, sheet: session.getState().activeSheetId, events };
}

function value(session: SheetSession, sheet: string, a1: string): unknown {
  const col = a1.charCodeAt(0) - 65;
  const row = Number(a1.slice(1)) - 1;
  return session.cell(sheet, row, col).value;
}

describe("sheet session editing", () => {
  it("commits typed input to the engine and recalculates dependents before listeners hear of it", async () => {
    const { session, sheet, events } = await open();
    expect(value(session, sheet, "B1")).toBe(6);

    const result = session.setCellInput(sheet, { row: 0, col: 0 }, "10");

    expect(result).toEqual({ ok: true });
    expect(value(session, sheet, "A1")).toBe(10);
    expect(value(session, sheet, "B1")).toBe(15);
    const change = events.find((event) => event.type === "change");
    expect(change).toMatchObject({ type: "change", cause: "edit" });
    expect(change?.type === "change" && change.recalculated.map((cell) => [cell.row, cell.col, cell.value])).toEqual([[0, 1, 15]]);
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false, undoLabel: "Typing" });
  });

  it("types formulas, percentages and text as a spreadsheet does", async () => {
    const { session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 2 }, "=A1*2");
    session.setCellInput(sheet, { row: 1, col: 2 }, "25%");
    session.setCellInput(sheet, { row: 2, col: 2 }, "'0123");
    expect(session.cell(sheet, 0, 2)).toMatchObject({ value: 2, formula: "A1*2" });
    expect(session.cell(sheet, 1, 2)).toMatchObject({ value: 0.25, display: "25%" });
    expect(session.cell(sheet, 2, 2).value).toBe("0123");
  });

  it("refuses a formula that does not parse and leaves the cell and the history alone", async () => {
    const { session, sheet, events } = await open();
    const result = session.setCellInput(sheet, { row: 0, col: 0 }, "=SUM(");
    expect(result).toMatchObject({ ok: false, code: "formula" });
    expect(value(session, sheet, "A1")).toBe(1);
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
    expect(events).toEqual([]);
  });

  it("undoes and redoes an edit, recalculating each time", async () => {
    const { session, sheet, events } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "10");
    events.length = 0;

    expect(session.undo()).toEqual({ ok: true });
    expect(value(session, sheet, "A1")).toBe(1);
    expect(value(session, sheet, "B1")).toBe(6);
    expect(session.getState()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: "Typing" });
    expect(events[0]).toMatchObject({ type: "change", cause: "undo", affected: { sheet, start: { row: 0, col: 0 }, end: { row: 0, col: 0 } } });

    expect(session.redo()).toEqual({ ok: true });
    expect(value(session, sheet, "A1")).toBe(10);
    expect(value(session, sheet, "B1")).toBe(15);
    expect(session.getState()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it("makes one undo step of a transaction and keeps the first content of a cell edited twice", async () => {
    const { session, sheet } = await open();
    session.transact("Fill", (tx) => {
      tx.workbook.setCell(sheet, { row: 0, col: 0 }, 5);
      tx.workbook.setCell(sheet, { row: 0, col: 0 }, 7);
      tx.workbook.setCell(sheet, { row: 1, col: 0 }, 8);
    });
    expect(value(session, sheet, "B1")).toBe(18);
    session.undo();
    expect([value(session, sheet, "A1"), value(session, sheet, "A2"), value(session, sheet, "B1")]).toEqual([1, 2, 6]);
    expect(session.getState().canUndo).toBe(false);
  });

  it("takes back every edit of a transaction that throws", async () => {
    const { session, sheet } = await open();
    const result = session.transact("Broken", (tx) => {
      tx.workbook.setCell(sheet, { row: 0, col: 0 }, 99);
      tx.workbook.setFormula(sheet, { row: 1, col: 0 }, "((");
    });
    expect(result).toMatchObject({ ok: false, code: "formula" });
    expect(value(session, sheet, "A1")).toBe(1);
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
  });

  it("clears and restores contents and formats", async () => {
    const { session, sheet } = await open();
    session.setStyle(sheet, [{ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }], { font: { bold: true } });
    const styled = session.cell(sheet, 0, 0).styleId;
    expect(session.workbook.getStyle(styled).font.bold).toBe(true);
    session.clear(sheet, [{ start: { row: 0, col: 0 }, end: { row: 2, col: 1 } }], "all");
    expect(session.cell(sheet, 0, 0)).toMatchObject({ value: null, styleId: 0 });
    session.undo();
    expect(session.cell(sheet, 0, 0)).toMatchObject({ value: 1, styleId: styled });
    expect(session.cell(sheet, 0, 1)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
  });

  it("cuts a whole-column format to the used area instead of styling a million cells", async () => {
    const { session, sheet } = await open();
    const result = session.setStyle(sheet, [{ start: { row: 0, col: 0 }, end: { row: 1_048_575, col: 0 } }], { font: { italic: true } });
    expect(result).toEqual({ ok: true });
    expect(session.workbook.getStyle(session.cell(sheet, 999, 0).styleId).font.italic).toBe(true);
    expect(session.cell(sheet, 1000, 0).styleId).toBe(0);
  });

  it("inserts rows, moves formulas with them and undoes the insertion", async () => {
    const { session, sheet } = await open();
    session.insertRows(sheet, 1, 2);
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A5)");
    expect(value(session, sheet, "A4")).toBe(2);
    session.undo();
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");
    expect(value(session, sheet, "A2")).toBe(2);
    session.redo();
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A5)");
  });

  it("restores deleted rows with their cells, sizes and the formulas that pointed at them", async () => {
    const { session, sheet } = await open();
    session.setCellInput(sheet, { row: 4, col: 0 }, "=A2*10");
    session.setCellInput(sheet, { row: 5, col: 0 }, "=SUM(A2:A3)");
    session.setRowHeights(sheet, [1], 40);
    expect(value(session, sheet, "A5")).toBe(20);

    session.deleteRows(sheet, 1, 1);
    expect(value(session, sheet, "A2")).toBe(3);
    expect(session.cell(sheet, 3, 0).value).toMatchObject({ kind: "error", code: "#REF!" });
    expect(session.sheet(sheet).rows).toEqual([]);

    expect(session.undo()).toEqual({ ok: true });
    expect([value(session, sheet, "A1"), value(session, sheet, "A2"), value(session, sheet, "A3")]).toEqual([1, 2, 3]);
    expect(session.cell(sheet, 4, 0)).toMatchObject({ formula: "A2*10", value: 20 });
    expect(session.cell(sheet, 5, 0)).toMatchObject({ formula: "SUM(A2:A3)", value: 5 });
    expect(session.cell(sheet, 0, 1)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(session.sheet(sheet).rows).toEqual([{ index: 1, heightPt: 40, hidden: false }]);

    session.redo();
    expect(value(session, sheet, "A2")).toBe(3);
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A2)");
  });

  it("restores deleted columns and their widths", async () => {
    const { session, sheet } = await open();
    session.setColumnWidths(sheet, [0], 20);
    session.deleteColumns(sheet, 0, 1);
    expect(session.cell(sheet, 0, 0).value).toMatchObject({ kind: "error", code: "#REF!" });
    session.undo();
    expect(session.cell(sheet, 0, 1)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(session.sheet(sheet).columns).toEqual([{ index: 0, width: 20, hidden: false }]);
    session.undo();
    expect(session.sheet(sheet).columns).toEqual([]);
  });

  it("undoes merges, frozen panes and sheet names", async () => {
    const { session, sheet } = await open();
    const range = { start: { row: 0, col: 0 }, end: { row: 1, col: 0 } };
    session.mergeCells(sheet, range);
    expect(session.sheet(sheet).mergedRanges).toEqual([range]);
    expect(value(session, sheet, "A2")).toBe(null);
    session.setFrozenPanes(sheet, { rows: 1, cols: 0 });
    session.renameSheet(sheet, "Plan");

    session.undo();
    expect(session.sheet(sheet).name).toBe("Sheet1");
    session.undo();
    expect(session.sheet(sheet).frozen).toEqual({ rows: 0, cols: 0 });
    session.undo();
    expect(session.sheet(sheet).mergedRanges).toEqual([]);
    expect(value(session, sheet, "A2")).toBe(2);
    session.redo();
    expect(session.sheet(sheet).mergedRanges).toEqual([range]);
    expect(value(session, sheet, "A2")).toBe(null);
  });

  it("keeps pasted text that only looks like a formula as text", async () => {
    const { session, sheet } = await open();
    const result = session.setInputs(sheet, { row: 5, col: 0 }, [["=SUM(", "7"], ["=A1+1"]]);
    expect(result).toEqual({ ok: true });
    expect(session.cell(sheet, 5, 0)).toMatchObject({ value: "=SUM(", formula: null });
    expect(session.cell(sheet, 5, 1).value).toBe(7);
    expect(session.cell(sheet, 6, 0)).toMatchObject({ formula: "A1+1", value: 2 });
    session.undo();
    expect(session.isBlank(sheet, 5, 0)).toBe(true);
  });

  it("records proposals without undo history and resolves them through the session", async () => {
    const { session, sheet } = await open();
    session.setCellInput(sheet, { row: 2, col: 0 }, "30");
    session.mutate((workbook) => {
      workbook.beginProposal({ author: "agent", date: "2026-11-20T10:00:00Z", label: "Raise" });
      workbook.setCell(sheet, { row: 0, col: 0 }, 100);
      workbook.endProposal();
    });
    expect(session.getState().canUndo).toBe(false);
    expect(value(session, sheet, "B1")).toBe(132);
    expect(session.cell(sheet, 0, 0).pendingChangeId).not.toBeNull();

    session.rejectChanges("all");
    expect(value(session, sheet, "A1")).toBe(1);
    expect(value(session, sheet, "B1")).toBe(33);
    expect(session.workbook.listChanges()).toEqual([]);
  });

  it("explains why rows cannot move, or be put back, while proposed changes wait on the sheet", async () => {
    const { session, sheet } = await open();
    session.insertRows(sheet, 0, 1);
    session.workbook.beginProposal({ author: "agent", date: "2026-11-20T10:00:00Z", label: "Raise" });
    session.workbook.setCell(sheet, { row: 1, col: 0 }, 100);
    session.workbook.endProposal();

    const refused = session.deleteRows(sheet, 3, 1);
    expect(refused).toEqual({ ok: false, code: "not_allowed", message: "Accept or reject the proposed changes on this sheet first." });
    expect(session.cell(sheet, 3, 0).value).toBe(3);

    session.acceptChanges("all");
    expect(session.deleteRows(sheet, 3, 1)).toEqual({ ok: true });
  });

  it("refuses to change one cell of an array formula and says what to do", async () => {
    // An array formula over C1:C3, written into the sheet part of the sample file.
    const h = harness();
    const pkg = await opc.openPackage(await sampleXlsx());
    const part = pkg.listParts().map((entry) => entry.name).find((name) => name.includes("/worksheets/"))!;
    const xml = await pkg.getPartText(part);
    const withArray = xml.replace(/(<row[^>]*r="1"[^>]*>)([\s\S]*?)(<\/row>)/, '$1$2<c r="C1"><f t="array" ref="C1:C3">A1:A3*2</f><v>2</v></c>$3');
    expect(withArray).not.toBe(xml);
    pkg.setPart(part, withArray);
    h.files.put("Array.xlsx", await pkg.save());
    const session = await openSheetSession(h.deps, "Array.xlsx");
    const sheet = session.getState().activeSheetId;
    expect(session.cell(sheet, 1, 2).arrayRange).toEqual({ start: { row: 0, col: 2 }, end: { row: 2, col: 2 } });

    expect(session.setCellInput(sheet, { row: 1, col: 2 }, "9")).toEqual({
      ok: false,
      code: "not_allowed",
      message: "This cell is part of an array formula. Change the whole range at once.",
    });
    expect(session.getState().dirty).toBe(false);
    // An address outside the sheet keeps the general message and does not throw.
    expect(session.setCellInput(sheet, { row: -1, col: 0 }, "1")).toMatchObject({ ok: false, code: "not_allowed", message: "This change is not possible here." });
  });

  it("keeps a bounded undo history", async () => {
    const { session, sheet } = await open();
    for (let i = 0; i < 230; i++) session.setCellInput(sheet, { row: 10, col: 0 }, String(i));
    let undone = 0;
    while (session.getState().canUndo) {
      session.undo();
      undone++;
    }
    expect(undone).toBe(200);
    expect(session.cell(sheet, 10, 0).value).toBe(29);
  });

  it("notices a direct workbook edit: recalculates, marks dirty and drops the history", async () => {
    const { session, sheet, events } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "2");
    events.length = 0;
    session.workbook.setCell(sheet, { row: 1, col: 0 }, 40);
    await settle();
    expect(value(session, sheet, "B1")).toBe(45);
    expect(events.filter((event) => event.type === "change")).toHaveLength(1);
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: false });
  });

  it("adds a sheet, activates it and falls back when the active sheet is removed", async () => {
    const { session, sheet } = await open();
    const added = session.addSheet();
    expect(added.ok).toBe(true);
    expect(session.sheets().map((entry) => entry.name)).toEqual(["Sheet1", "Sheet2"]);
    expect(session.getState().activeSheetId).toBe(added.sheet);
    expect(session.removeSheet(added.sheet as string)).toEqual({ ok: true });
    expect(session.getState().activeSheetId).toBe(sheet);
    expect(session.removeSheet(sheet)).toMatchObject({ ok: false, code: "not_allowed" });
  });

  it("keeps the same state object until something changes", async () => {
    const { session, sheet } = await open();
    const first = session.getState();
    expect(session.getState()).toBe(first);
    session.setCellInput(sheet, { row: 0, col: 0 }, "1");
    expect(session.getState()).toBe(first);
    session.setCellInput(sheet, { row: 0, col: 0 }, "2");
    expect(session.getState()).not.toBe(first);
    expect(session.getState().revision).toBe(first.revision + 1);
  });

  it("starts a new workbook without a path and never autosaves it", async () => {
    const h = harness();
    const session = createSheetSession(h.deps);
    const sheet = session.getState().activeSheetId;
    session.setCellInput(sheet, { row: 0, col: 0 }, "x");
    expect(session.getState()).toMatchObject({ path: null, name: "Untitled.xlsx", dirty: true, saveState: "idle" });
    expect(h.timers.pending.size).toBe(0);
    expect(await session.save()).toMatchObject({ status: "error", code: "invalid_path" });
  });
});
