import { describe, expect, it } from "vitest";
import { buildReviewGroups, markupDecorations, reviewOrder } from "../../../../home/apps/sheets/src/review";
import { openModel, proposeOnModel } from "./fixture";

describe("review model", () => {
  it("groups the journal's pending changes by proposal with sheet, address, old and new values", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const groups = buildReviewGroups(model.session.workbook);

    expect(groups.map((group) => [group.author, group.label, group.items.length])).toEqual([
      ["Matrix Assistant", "Link the total revenue", 2],
      ["Alex", "Higher costs", 1],
    ]);
    const [growth, total] = groups[0]!.items;
    // Ordered by sheet tab, then row and column.
    expect(growth).toMatchObject({ sheetName: "Assumptions", address: "B3", location: "Assumptions!B3", oldDisplay: "3.0%", newDisplay: "5.0%", oldFormula: null, newFormula: null, kind: "cell" });
    expect(total).toMatchObject({ sheetName: "Summary", address: "B2", oldDisplay: "725,000", oldFormula: null, newFormula: "Projection!N4", stale: false });
    // The new value is the recalculated result of the proposed formula, with the proposed 5% growth.
    expect(total!.newDisplay).toBe("795,856");
    expect(groups[1]!.items[0]).toMatchObject({ location: "Assumptions!B5", oldDisplay: "18000", newDisplay: "20000" });
  });

  it("orders the changes for stepping and builds markup decorations with old and new text", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const groups = buildReviewGroups(model.session.workbook);
    const order = reviewOrder(groups);
    expect(order.map((item) => item.location)).toEqual(["Assumptions!B3", "Summary!B2", "Assumptions!B5"]);

    const decorations = markupDecorations(order);
    expect(decorations).toHaveLength(3);
    expect(decorations[1]).toEqual({
      sheet: model.sheets.summary,
      row: 1,
      col: 1,
      kind: "proposed",
      oldValue: "725,000",
      newValue: "795,856",
      changeId: order[1]!.id,
      label: "Matrix Assistant: Link the total revenue",
    });
  });

  it("returns no groups for a workbook without proposals", async () => {
    const model = await openModel();
    expect(buildReviewGroups(model.session.workbook)).toEqual([]);
    expect(markupDecorations([])).toEqual([]);
  });

  it("lists structural changes with their summary and no cell decoration", async () => {
    const model = await openModel();
    model.session.mutate((workbook) => {
      workbook.beginProposal({ author: "Matrix Assistant", date: "2026-11-20T10:00:00Z", label: "Add a sheet" });
      workbook.addSheet("Notes");
      workbook.endProposal();
    });
    const order = reviewOrder(buildReviewGroups(model.session.workbook));
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({ kind: "addSheet", address: "", sheetName: "Notes" });
    expect(order[0]!.summary).not.toBe("");
    expect(markupDecorations(order)).toEqual([]);
  });
});
