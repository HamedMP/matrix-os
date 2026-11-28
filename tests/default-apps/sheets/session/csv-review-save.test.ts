import { describe, expect, it } from "vitest";
import { runProposal } from "../../../../home/apps/sheets/src/agent";
import { openSheetSession } from "../../../../home/apps/sheets/src/session";
import { encode, harness, settle } from "./fakes";

async function csvWithProposal(path = "data.csv", text = "name,amount\nA,10\nB,20\n") {
  const h = harness();
  h.files.put(path, encode(text));
  const session = await openSheetSession(h.deps, path);
  const sheet = session.getState().activeSheetId;
  runProposal(session, "Raise A", "2026-11-23T10:00:00.000Z", [], (workbook) => workbook.setCell(sheet, { row: 1, col: 1 }, 999));
  expect(session.workbook.listChanges()).toHaveLength(1);
  return { h, session, sheet, path, text };
}

describe("a CSV or TSV file with assistant changes waiting for review", () => {
  it("does not autosave the unreviewed value into the file", async () => {
    const { h, session, path, text } = await csvWithProposal();
    h.timers.fire();
    await settle();
    expect(h.files.text(path)).toBe(text);
    expect(session.getState().saveState).toBe("error");
    expect(session.getState().saveError?.code).toBe("review_pending");
  });

  it("refuses an explicit save and a save as CSV, and allows a save as .xlsx that keeps the review", async () => {
    const { h, session, path, text } = await csvWithProposal("data.tsv", "name\tamount\nA\t10\n");
    expect(await session.save()).toMatchObject({ status: "error", code: "review_pending" });
    expect(await session.saveAs("other.csv")).toMatchObject({ status: "error", code: "review_pending" });
    expect(h.files.store.has("other.csv")).toBe(false);
    expect(h.files.text(path)).toBe(text);
    expect(await session.saveAs("data.xlsx")).toMatchObject({ status: "saved", path: "data.xlsx" });
    expect(session.workbook.listChanges()).toHaveLength(1);
  });

  it("saves again once the review is finished", async () => {
    const { h, session, path } = await csvWithProposal();
    h.timers.fire();
    await settle();
    session.rejectChanges("all");
    h.timers.fire();
    await settle();
    expect(session.getState()).toMatchObject({ saveState: "saved", saveError: null });
    expect(h.files.text(path)).toBe("name,amount\nA,10\nB,20\n");

    const sheet = session.getState().activeSheetId;
    runProposal(session, "Raise B", "2026-11-23T10:00:00.000Z", [], (workbook) => workbook.setCell(sheet, { row: 2, col: 1 }, 50));
    session.acceptChanges("all");
    h.timers.fire();
    await settle();
    expect(h.files.text(path)).toBe("name,amount\nA,10\nB,50\n");
  });
});
