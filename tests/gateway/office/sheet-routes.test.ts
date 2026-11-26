import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SheetChangesListReplySchema, SheetDescribeReplySchema, SheetProposeEditsReplySchema, SheetReadRangeReplySchema,
  SheetResolveChangesReplySchema,
} from "../../../packages/contracts/src/office-documents";
import { createOfficeHarness, FIXED_NOW, json, type OfficeHarness } from "./helpers";

let h: OfficeHarness;
beforeEach(async () => { h = await createOfficeHarness(); });
afterEach(async () => { await h.cleanup(); });

const AGENT = "Matrix Agent";

function cellOf(workbook: Awaited<ReturnType<OfficeHarness["xlsx"]>>, sheet: string, row: number, col: number) {
  const info = workbook.getSheetByName(sheet)!;
  return workbook.getCell(info.id, { row, col });
}

async function proposeRevenueFix(path: string) {
  return h.post("/sheets/propose-edits", {
    path, author: AGENT, label: "Fix typed-in revenue",
    edits: [
      { op: "setCell", sheet: "Summary", cell: "B2", value: "=Projection!N4", expect: "725,000" },
      { op: "setCell", sheet: "Assumptions", cell: "B2", value: 60000 },
    ],
  });
}

describe("POST /api/office/sheets/describe", () => {
  it("describes the first sheet with the list of sheets", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/describe", { path });
    expect(response.status).toBe(200);
    const body = SheetDescribeReplySchema.parse(await json(response));
    expect(body.trust).toBe("untrusted");
    expect(body.sheets.map((sheet) => sheet.name)).toEqual(["Assumptions", "Projection", "Summary"]);
    expect(body.sheet).toBe("Assumptions");
    expect(body.text).toContain("A2: Starting monthly revenue");
    expect(body.range).toBe("A1:C6");
  });

  it("describes a named sheet and range", async () => {
    const path = await h.copyFixture("model.xlsx");
    const body = SheetDescribeReplySchema.parse(await json(await h.post("/sheets/describe", { path, sheet: "Summary", range: "A3:B3" })));
    expect(body.text).toContain("B3: =Projection!N10 => 157,321");
    expect(body.text).not.toContain("A2:");
  });

  it("reads a csv file", async () => {
    const path = await h.copyFixture("data.csv");
    const body = SheetDescribeReplySchema.parse(await json(await h.post("/sheets/describe", { path })));
    expect(body.text).toContain("A1:");
  });

  it("answers an unknown sheet with not_found", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/describe", { path, sheet: "Nope" });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/office/sheets/read-range", () => {
  it("returns values, formulas and display text", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/read-range", { path, sheet: "Summary", range: "A2:B3" });
    expect(response.status).toBe(200);
    const body = SheetReadRangeReplySchema.parse(await json(response));
    expect(body.range).toBe("A2:B3");
    expect(body.cells).toHaveLength(2);
    expect(body.cells[0]![1]).toMatchObject({ value: 725000, formula: null, display: "725,000" });
    expect(body.cells[1]![1]).toMatchObject({ formula: "Projection!N10", display: "157,321" });
  });

  it("serialises formula errors as JSON", async () => {
    const path = await h.copyFixture("formulas.xlsx");
    const workbook = await h.xlsx(path);
    let errorAt: string | null = null;
    for (const sheet of workbook.listSheets()) {
      const dims = sheet.dimensions;
      if (!dims) continue;
      workbook.getRange(sheet.id, dims).forEach((row, r) => row.forEach((cell, c) => {
        if (!errorAt && cell.value !== null && typeof cell.value === "object") errorAt = `${sheet.name}|${r + dims.start.row}|${c + dims.start.col}`;
      }));
    }
    expect(errorAt).not.toBeNull();
    const [sheet, row, col] = errorAt!.split("|");
    const label = String.fromCharCode(65 + Number(col)) + String(Number(row) + 1);
    const body = SheetReadRangeReplySchema.parse(await json(await h.post("/sheets/read-range", { path, sheet, range: label })));
    expect(body.cells[0]![0]!.value).toEqual({ error: "#N/A" });
  });

  // Fault detected: the request schema refused whole-row ranges such as `2:3` that the engine reads.
  it("reads whole rows cut down to the used columns", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/read-range", { path, sheet: "Summary", range: "2:3" });
    expect(response.status).toBe(200);
    const body = SheetReadRangeReplySchema.parse(await json(response));
    const columns = await h.post("/sheets/read-range", { path, sheet: "Summary", range: "A2:B3" });
    const rectangle = SheetReadRangeReplySchema.parse(await json(columns));
    expect(body.cells).toHaveLength(2);
    expect(body.cells.map((row) => row.slice(0, 2))).toEqual(rectangle.cells);
    expect((await h.post("/sheets/read-range", { path, sheet: "Summary", range: "$2:$2" })).status).toBe(200);
    expect((await h.post("/sheets/describe", { path, sheet: "Summary", range: "3:3" })).status).toBe(200);
  });

  it("refuses text that is not a cell, column or row range", async () => {
    const path = await h.copyFixture("model.xlsx");
    for (const range of ["A", "5", "A:5", "1:B", "A1:B", "2:", ":3"]) {
      const response = await h.post("/sheets/read-range", { path, sheet: "Summary", range });
      expect(response.status, range).toBe(400);
    }
  });

  it("refuses a range over the cell cap", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/read-range", { path, sheet: "Summary", range: "A1:Z1000" });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/office/sheets/propose-edits", () => {
  it("records the edits in the journal, recalculates and saves", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await proposeRevenueFix(path);
    expect(response.status).toBe(200);
    const body = SheetProposeEditsReplySchema.parse(await json(response));
    expect(body.saved).toBe(true);
    expect(body.changeIds).toHaveLength(2);
    expect(body.rejected).toEqual([]);

    const saved = await h.xlsx(path);
    const changes = saved.listChanges();
    expect(changes.map((change) => change.id).sort()).toEqual([...body.changeIds].sort());
    expect(changes.every((change) => change.author === AGENT && change.label === "Fix typed-in revenue" && change.date === FIXED_NOW.toISOString())).toBe(true);
    expect(cellOf(saved, "Summary", 1, 1).formula).toBe("Projection!N4");
    expect(cellOf(saved, "Assumptions", 1, 1).value).toBe(60000);
    // Net income depends on the assumption and was recalculated.
    expect(cellOf(saved, "Summary", 2, 1).value).not.toBeCloseTo(157320.67, 1);
  });

  it("rejects an edit whose expectation is stale and applies the rest", async () => {
    const path = await h.copyFixture("model.xlsx");
    const body = SheetProposeEditsReplySchema.parse(await json(await h.post("/sheets/propose-edits", {
      path, author: AGENT, label: "Mixed",
      edits: [
        { op: "setCell", sheet: "Summary", cell: "B2", value: 1, expect: "999" },
        { op: "setCell", sheet: "Summary", cell: "C2", value: "Checked" },
      ],
    })));
    expect(body.rejected).toEqual([{ index: 0, code: "stale_reference" }]);
    expect(body.appliedEdits).toEqual([1]);
    expect(body.changeIds).toHaveLength(1);
  });

  it("clears whole rows as pending changes", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/propose-edits", {
      path, author: AGENT, label: "Clear row", edits: [{ op: "clearRange", sheet: "Summary", range: "2:2" }],
    });
    expect(response.status).toBe(200);
    const body = SheetProposeEditsReplySchema.parse(await json(response));
    expect(body.changeIds.length).toBeGreaterThan(0);
    const changes = (await h.xlsx(path)).listChanges();
    expect(changes.every((change) => change.row === 1)).toBe(true);
  });

  it("refuses a csv target", async () => {
    const path = await h.copyFixture("data.csv");
    const response = await h.post("/sheets/propose-edits", {
      path, author: AGENT, label: "x", edits: [{ op: "setCell", sheet: "Sheet1", cell: "A1", value: 1 }],
    });
    expect(response.status).toBe(400);
  });
});

describe("sheet changes list, accept and reject", () => {
  it("lists pending changes with old and new values", async () => {
    const path = await h.copyFixture("model.xlsx");
    await proposeRevenueFix(path);
    const body = SheetChangesListReplySchema.parse(await json(await h.post("/sheets/changes/list", { path })));
    expect(body.total).toBe(2);
    const revenue = body.changes.find((change) => change.sheet === "Summary")!;
    expect(revenue).toMatchObject({ cell: "B2", oldValue: 725000, oldFormula: null, newFormula: "Projection!N4", label: "Fix typed-in revenue" });
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ author: AGENT, pendingCount: 2 });
  });

  it("lists row, column and sheet changes with their kind, count, summary and affected range", async () => {
    const path = await h.copyFixture("model.xlsx");
    const workbook = await h.xlsx(path);
    const assumptions = workbook.getSheetByName("Assumptions")!.id;
    const projection = workbook.getSheetByName("Projection")!.id;
    workbook.beginProposal({ author: AGENT, date: FIXED_NOW.toISOString(), label: "Restructure" });
    workbook.insertRows(assumptions, 1, 2);
    workbook.deleteColumns(projection, 2, 1);
    workbook.addSheet("Notes");
    workbook.endProposal();
    await writeFile(join(h.home, path), await workbook.save());

    const body = SheetChangesListReplySchema.parse(await json(await h.post("/sheets/changes/list", { path })));
    const byKind = Object.fromEntries(body.changes.map((change) => [change.kind, change]));
    expect(byKind.insertRows).toMatchObject({ sheet: "Assumptions", cell: null, range: "2:3", count: 2, summary: "Insert rows 2-3" });
    expect(byKind.deleteColumns).toMatchObject({ sheet: "Projection", cell: null, range: "C:C", count: 1, summary: "Delete column C" });
    expect(byKind.addSheet).toMatchObject({ sheet: "Notes", cell: null, range: null, count: 1, summary: "Add sheet Notes" });
  });

  it("keeps a cell change's cell and reports it as a one-cell range", async () => {
    const path = await h.copyFixture("model.xlsx");
    await proposeRevenueFix(path);
    const body = SheetChangesListReplySchema.parse(await json(await h.post("/sheets/changes/list", { path })));
    const revenue = body.changes.find((change) => change.sheet === "Summary")!;
    expect(revenue).toMatchObject({ kind: "cell", cell: "B2", range: "B2", count: 1, summary: "Edit cell" });
  });

  it("accepts one change and keeps the other pending", async () => {
    const path = await h.copyFixture("model.xlsx");
    const proposed = SheetProposeEditsReplySchema.parse(await json(await proposeRevenueFix(path)));
    const listed = SheetChangesListReplySchema.parse(await json(await h.post("/sheets/changes/list", { path })));
    const revenue = listed.changes.find((change) => change.sheet === "Summary")!;
    const body = SheetResolveChangesReplySchema.parse(await json(await h.post("/sheets/changes/accept", {
      path, ids: [revenue.id], ifVersion: proposed.version,
    })));
    expect(body.resolvedIds).toEqual([revenue.id]);
    const saved = await h.xlsx(path);
    expect(saved.listChanges().map((change) => change.id)).toEqual(listed.changes.filter((c) => c.id !== revenue.id).map((c) => c.id));
    expect(cellOf(saved, "Summary", 1, 1).formula).toBe("Projection!N4");
  });

  it("rejects all changes and restores the old values", async () => {
    const path = await h.copyFixture("model.xlsx");
    await proposeRevenueFix(path);
    const body = SheetResolveChangesReplySchema.parse(await json(await h.post("/sheets/changes/reject", { path, ids: "all" })));
    expect(body.resolvedIds).toHaveLength(2);
    expect(body.staleIds).toEqual([]);
    const saved = await h.xlsx(path);
    expect(saved.listChanges()).toEqual([]);
    expect(cellOf(saved, "Summary", 1, 1)).toMatchObject({ value: 725000, formula: null });
    expect(cellOf(saved, "Assumptions", 1, 1).value).toBe(50000);
    expect(cellOf(saved, "Summary", 2, 1).value).toBeCloseTo(157320.67, 1);
  });

  it("answers an unknown change id with stale_reference", async () => {
    const path = await h.copyFixture("model.xlsx");
    const response = await h.post("/sheets/changes/accept", { path, ids: ["c-unknown"] });
    expect(response.status).toBe(409);
  });
});
