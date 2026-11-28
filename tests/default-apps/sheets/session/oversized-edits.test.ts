import { describe, expect, it } from "vitest";
import { type SessionEvent, type SheetSession, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { MAX_TRANSACTION_CELLS } from "../../../../home/apps/sheets/src/session/recorder";
import { harness, sampleXlsx } from "./fakes";

// Fault: an edit larger than the undo record went ahead, so a later failure left cells changed that nothing could put back.

async function open(): Promise<{ session: SheetSession; sheet: string; events: SessionEvent[] }> {
  const h = harness();
  h.files.put("Budget.xlsx", await sampleXlsx());
  const session = await openSheetSession(h.deps, "Budget.xlsx");
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, sheet: session.getState().activeSheetId, events };
}

/** `count` blocks of 1000 rows by 100 columns, one under the other: each small enough that no clamp cuts it. */
function blocks(count: number): Array<{ start: { row: number; col: number }; end: { row: number; col: number } }> {
  return Array.from({ length: count }, (_, i) => ({ start: { row: 10 + i * 1000, col: 0 }, end: { row: 10 + i * 1000 + 999, col: 99 } }));
}

describe("edits too large to take back", () => {
  it("refuses a format of several ranges that together touch more cells than one step keeps, before writing any", async () => {
    const { session, sheet, events } = await open();
    const ranges = blocks(Math.ceil(MAX_TRANSACTION_CELLS / 100_000) + 1);

    const result = session.setStyle(sheet, ranges, { font: { bold: true } });

    expect(result).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 10, 0).styleId).toBe(0);
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
    expect(events).toEqual([]);
  });

  it("checks every range of a format before it writes the first", async () => {
    const { session, sheet, events } = await open();
    // The second range is a whole sheet: cut to the used area plus a margin it is still far too large.
    session.transact("Seed", (tx) => tx.workbook.setCell(sheet, { row: 1_048_575, col: 16_383 }, 1));
    events.length = 0;
    const whole = { start: { row: 0, col: 0 }, end: { row: 1_048_575, col: 16_383 } };

    const result = session.setStyle(sheet, [{ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, whole], { font: { bold: true } });

    expect(result).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 0, 0).styleId).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses cell edits and pasted text past the limit before writing any", async () => {
    const { session, sheet } = await open();
    const edits = Array.from({ length: MAX_TRANSACTION_CELLS + 1 }, (_, i) => ({ sheet, row: 10 + Math.floor(i / 1000), col: i % 1000, value: 1 }));
    expect(session.applyEdits(edits)).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 10, 0).value).toBeNull();

    const rows = Array.from({ length: Math.floor(MAX_TRANSACTION_CELLS / 1000) + 1 }, () => Array.from({ length: 1000 }, () => "1"));
    expect(session.setInputs(sheet, { row: 10, col: 0 }, rows)).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 10, 0).value).toBeNull();
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
  });

  it("refuses to clear more stored cells than one step keeps, before clearing any", async () => {
    const { session, sheet } = await open();
    const ranges = blocks(Math.ceil(MAX_TRANSACTION_CELLS / 100_000) + 1);
    for (const range of ranges) session.workbook.setStyle(sheet, range, { font: { bold: true } });
    const styled = session.cell(sheet, 10, 0).styleId;
    expect(styled).not.toBe(0);

    expect(session.clear(sheet, ranges, "formats")).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 10, 0).styleId).toBe(styled);
    // A few stored cells in a vast range are cleared as usual.
    expect(session.clear(sheet, [{ start: { row: 0, col: 0 }, end: { row: 2, col: 16_383 } }], "all")).toEqual({ ok: true });
    expect(session.cell(sheet, 0, 0).value).toBeNull();
  }, 60_000);

  it("counts what a step already claimed when another edit joins it", async () => {
    const { session, sheet } = await open();
    const result = session.transact("Joined", (tx) => {
      tx.reserve(MAX_TRANSACTION_CELLS);
      tx.workbook.setCell(sheet, { row: 0, col: 0 }, 5);
      const inner = session.applyEdits([{ sheet, row: 1, col: 0, value: 6 }]);
      if (!inner.ok) throw new Error("joined edit refused");
    });
    expect(result).toMatchObject({ ok: false, code: "too_many_cells" });
    expect(session.cell(sheet, 0, 0).value).toBe(1);
    expect(session.cell(sheet, 1, 0).value).toBe(2);
  });

  it("marks the workbook changed and drops the history when a failed step changed more than it could put back", async () => {
    const { session, sheet, events } = await open();
    const result = session.transact("Too big", (tx) => {
      for (const range of blocks(Math.ceil(MAX_TRANSACTION_CELLS / 100_000) + 1)) tx.workbook.setStyle(sheet, range, { font: { bold: true } });
      throw new Error("boom");
    });
    expect(result).toMatchObject({ ok: false });
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: false });
    expect(events.some((event) => event.type === "change")).toBe(true);
  }, 120_000);
});
