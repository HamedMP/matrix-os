import { describe, expect, it } from "vitest";
import { runProposal } from "../../../../home/apps/sheets/src/agent";
import { openSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness, sampleXlsx } from "./fakes";

async function proposed() {
  const h = harness();
  h.files.put("model.xlsx", await sampleXlsx());
  const session = await openSheetSession({ ...h.deps, autosaveDelayMs: 60_000 }, "model.xlsx");
  const sheet = session.getState().activeSheetId;
  session.setCellInput(sheet, { row: 1, col: 1 }, "50000");
  runProposal(session, "Lower the price", "2026-11-23T10:00:00.000Z", (workbook) => workbook.setCell(sheet, { row: 1, col: 1 }, 999));
  expect(session.workbook.listChanges()).toMatchObject([{ oldValue: 50000, newValue: 999 }]);
  return { session, sheet };
}

describe("undo after the owner types over a cell the assistant proposed", () => {
  it("brings the proposal back for review, so reject still restores the original", async () => {
    const { session, sheet } = await proposed();
    expect(session.setCellInput(sheet, { row: 1, col: 1 }, "555")).toMatchObject({ ok: true });
    expect(session.workbook.listChanges()).toEqual([]);

    expect(session.undo()).toMatchObject({ ok: true });
    expect(session.cell(sheet, 1, 1).value).toBe(999);
    const back = session.workbook.listChanges();
    expect(back).toMatchObject([{ row: 1, col: 1, oldValue: 50000, newValue: 999, author: "Matrix Assistant", label: "Lower the price" }]);

    session.rejectChanges("all");
    expect(session.cell(sheet, 1, 1).value).toBe(50000);
  });

  it("redo applies the owner's value again and accepts the proposal again", async () => {
    const { session, sheet } = await proposed();
    session.setCellInput(sheet, { row: 1, col: 1 }, "555");
    session.undo();
    expect(session.redo()).toMatchObject({ ok: true });
    expect(session.cell(sheet, 1, 1).value).toBe(555);
    expect(session.workbook.listChanges()).toEqual([]);
    session.undo();
    expect(session.cell(sheet, 1, 1).value).toBe(999);
    expect(session.workbook.listChanges()).toHaveLength(1);
  });
});
