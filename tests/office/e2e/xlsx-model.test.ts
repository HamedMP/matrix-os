/**
 * Acceptance check 4, first half: a `.xlsx` with formulas recalculates
 * after an edit; an agent edit shows old and new values per cell and can be
 * accepted or rejected.
 */

import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../packages/office/src/index.js";
import { applySheetEdits, describeSheet, listJournalChanges, openXlsx, parseA1, parseAgentEdits, toSheetEdits } from "../../../packages/office/src/index.js";
import { AGENT, AGENT_PROPOSAL, DATE, changedParts, keepOutput, loadFixture, sheetId, valueAt } from "./helpers.js";

/** Revenue of the twelve months for a starting revenue and a monthly growth rate. */
function totalRevenue(start: number, growth: number): number {
  let total = 0;
  for (let month = 0; month < 12; month++) total += start * (1 + growth) ** month;
  return total;
}

function cell(workbook: Workbook, sheet: string, a1: string) {
  return workbook.getCell(sheetId(workbook, sheet), parseA1(a1));
}

/** What an agent would answer after reading the sheets. */
function agentAnswer(): string {
  return JSON.stringify({
    kind: "sheet",
    edits: [
      { op: "setCell", sheet: "Assumptions", cell: "B5", value: 20000, expect: "18000" },
      { op: "setCell", sheet: "Summary", cell: "B2", value: "=Projection!N4", expect: "725,000" },
      { op: "setCell", sheet: "Summary", cell: "C2", value: "Projection", expect: "Board pack (typed in)" },
      // Stale: the agent quotes a value the cell does not hold.
      { op: "setCell", sheet: "Assumptions", cell: "B6", value: 0.19, expect: "30.0%" },
    ],
    summary: "Raises monthly costs and links the total revenue to the projection.",
  });
}

describe("the financial model", () => {
  it("recalculates through three sheets when the owner edits an assumption", async () => {
    const workbook = await openXlsx(loadFixture("model.xlsx"));
    expect(valueAt(workbook, "Projection", "N4")).toBeCloseTo(totalRevenue(50000, 0.03), 4);
    const assumptions = sheetId(workbook, "Assumptions");
    // What reads the growth rate, and what the first projected month reads.
    expect(workbook.dependents(assumptions, parseA1("B3")).length).toBeGreaterThanOrEqual(11);
    expect(workbook.precedents(sheetId(workbook, "Projection"), parseA1("C4")).map((ref) => ref.sheet)).toContain(assumptions);

    workbook.setCell(assumptions, parseA1("B3"), 0.05);
    // Nothing is calculated until recalc runs.
    expect(valueAt(workbook, "Projection", "N4")).toBeCloseTo(totalRevenue(50000, 0.03), 4);
    const result = workbook.recalc();
    expect(result).toMatchObject({ complete: true, circular: [] });
    expect(result.changed.length).toBeGreaterThan(50);
    const revenue = totalRevenue(50000, 0.05);
    expect(valueAt(workbook, "Projection", "N4")).toBeCloseTo(revenue, 4);
    expect(valueAt(workbook, "Projection", "B4")).toBe(50000);
    expect(valueAt(workbook, "Projection", "M4")).toBeCloseTo(50000 * 1.05 ** 11, 6);
    // Net income = (revenue × 60% − 12 × 18 000) × 75%, shown on the summary through a cross-sheet reference.
    expect(valueAt(workbook, "Summary", "B3")).toBeCloseTo((revenue * 0.6 - 12 * 18000) * 0.75, 4);
    expect(cell(workbook, "Summary", "B3").display).toBe(Math.round((revenue * 0.6 - 12 * 18000) * 0.75).toLocaleString("en-US"));
    // A second recalc has nothing to do.
    expect(workbook.recalc().changed).toEqual([]);
  });

  it("takes agent edits as pending changes with old and new content, resolved one by one", async () => {
    const source = loadFixture("model.xlsx");
    const workbook = await openXlsx(source);
    // The owner's own edit first: it is not a proposal.
    workbook.setCell(sheetId(workbook, "Assumptions"), parseA1("B3"), 0.05);
    workbook.recalc();
    expect(workbook.listChanges()).toEqual([]);

    const description = describeSheet(workbook, sheetId(workbook, "Assumptions"), null, { maxChars: 4000 });
    expect(description.text).toContain("B3: 5.0%");
    expect(description.text).toContain("B5: 18000");

    const parsed = parseAgentEdits(agentAnswer(), "sheet");
    if (!parsed.ok || parsed.envelope.kind !== "sheet") throw new Error("the agent answer did not parse");
    const plan = toSheetEdits(workbook, parsed.envelope.edits);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[3, "stale_reference"]]);
    const netBefore = valueAt(workbook, "Summary", "B3") as number;
    const applied = applySheetEdits(workbook, plan.edits, AGENT_PROPOSAL);
    expect(applied.changeIds).toHaveLength(3);

    // Each change shows the cell, who proposed it, and the old and the new content.
    const changes = workbook.listChanges();
    const summary = sheetId(workbook, "Summary");
    const assumptions = sheetId(workbook, "Assumptions");
    expect(changes.map((change) => [change.sheet, change.row, change.col, change.oldValue, change.oldFormula, change.newFormula, change.author, change.date, change.label])).toEqual([
      [assumptions, 4, 1, 18000, null, null, AGENT, DATE, AGENT_PROPOSAL.label],
      [summary, 1, 1, 725000, null, "Projection!N4", AGENT, DATE, AGENT_PROPOSAL.label],
      [summary, 1, 2, "Board pack (typed in)", null, null, AGENT, DATE, AGENT_PROPOSAL.label],
    ]);
    expect(changes[0]?.newValue).toBe(20000);
    expect(changes[2]?.newValue).toBe("Projection");
    expect(listJournalChanges(workbook).map((change) => [change.oldDisplay, change.newDisplay])).toEqual([
      ["18000", "20000"],
      ["725,000", cell(workbook, "Summary", "B2").display],
      ["Board pack (typed in)", "Projection"],
    ]);
    expect(workbook.listProposals()).toEqual([{ id: applied.proposalId, ...AGENT_PROPOSAL, pendingCount: 3 }]);
    expect(workbook.getSheet(summary).pendingChangeCount).toBe(2);
    expect(cell(workbook, "Assumptions", "B5").pendingChangeId).toBe(changes[0]?.id);

    // The cells already hold the new content, so the owner sees its effect before deciding.
    const revenue = totalRevenue(50000, 0.05);
    expect(valueAt(workbook, "Summary", "B2")).toBeCloseTo(revenue, 4);
    expect(valueAt(workbook, "Summary", "B5")).toBe(20000);
    expect(valueAt(workbook, "Summary", "B3")).toBeCloseTo(netBefore - 12 * 2000 * 0.75, 4);

    // The owner rejects the higher costs and accepts the linked total; the label change stays pending.
    const rejected = workbook.rejectChanges([changes[0]?.id ?? ""]);
    expect(rejected.resolvedIds).toEqual([changes[0]?.id]);
    expect(rejected.restored).toEqual([{ sheet: assumptions, row: 4, col: 1 }]);
    workbook.recalc();
    expect(valueAt(workbook, "Assumptions", "B5")).toBe(18000);
    expect(valueAt(workbook, "Summary", "B3")).toBeCloseTo(netBefore, 4);
    workbook.acceptChanges([changes[1]?.id ?? ""]);
    expect(cell(workbook, "Summary", "B2")).toMatchObject({ formula: "Projection!N4", pendingChangeId: null });
    expect(workbook.listChanges().map((change) => change.id)).toEqual([changes[2]?.id]);
    expect(() => workbook.acceptChanges([changes[0]?.id ?? ""])).toThrow();

    const saved = await workbook.save();
    keepOutput("agent-review-model.xlsx", saved);
    const changedPartNames = await changedParts(source, saved);
    expect(changedPartNames).toContain("/matrix/changeJournal.json");
    expect(changedPartNames).not.toContain("/xl/styles.xml");

    // Reopened: the values, the formula and the one pending change are all there.
    const reopened = await openXlsx(saved);
    expect(valueAt(reopened, "Assumptions", "B3")).toBe(0.05);
    expect(valueAt(reopened, "Assumptions", "B5")).toBe(18000);
    expect(cell(reopened, "Summary", "B2").formula).toBe("Projection!N4");
    expect(valueAt(reopened, "Summary", "B2")).toBeCloseTo(revenue, 4);
    expect(reopened.listChanges().map((change) => [change.id, change.sheet, change.row, change.col, change.oldValue, change.newValue, change.author])).toEqual([
      [changes[2]?.id, summary, 1, 2, "Board pack (typed in)", "Projection", AGENT],
    ]);
    expect(reopened.recalc().changed).toEqual([]);
    reopened.rejectChanges("all");
    expect(valueAt(reopened, "Summary", "C2")).toBe("Board pack (typed in)");
    expect(reopened.listProposals()).toEqual([]);
    const final = await reopened.save();
    keepOutput("agent-review-model-resolved.xlsx", final);
    // With nothing pending the journal part is gone from the file.
    expect((await openXlsx(final)).package.hasPart("/matrix/changeJournal.json")).toBe(false);
  });
});
