import { describe, expect, it } from "vitest";
import {
  ASSISTANT_AUTHOR,
  OPEN_MARKER,
  checkWorkbook,
  cleanColumn,
  explainSelection,
  fixFinding,
  formatAsTable,
  narrateTrace,
  normaliseColumn,
  numberFromText,
} from "../../../../home/apps/sheets/src/agent";
import { openModel } from "../review/fixture";
import { FakeAi, NOW, envelope } from "./fake-ai";

const cell = (row: number, col: number) => ({ start: { row, col }, end: { row, col } });

describe("explaining", () => {
  it("explains a formula with its inputs and highlights the cells it reads", async () => {
    const { session, sheets } = await openModel();
    const ai = new FakeAi("Net margin divides net income by total revenue.\u0007");
    const outcome = await explainSelection({ session, ai }, { sheet: sheets.summary, range: cell(3, 1) });
    expect(outcome.subject).toBe("Summary!B4");
    expect(outcome.text).toBe("Net margin divides net income by total revenue.");
    expect(outcome.highlights).toEqual(
      expect.arrayContaining([
        { sheet: sheets.summary, row: 2, col: 1 },
        { sheet: sheets.projection, row: 3, col: 13 },
      ]),
    );
    const prompt = ai.prompts[0]!;
    expect(prompt).toContain("Summary!B4 = B3/Projection!N4 => 22.2%");
    expect(prompt).toContain("Projection!N4: =SUM(B4:M4) => 709,601");
    expect(prompt.indexOf("Summary!B4 = B3")).toBeGreaterThan(prompt.indexOf(`${OPEN_MARKER}\nBlock:`));
    // Explaining never proposes changes.
    expect(session.workbook.listChanges()).toEqual([]);
  });

  it("narrates a trace computed in code and highlights every source", async () => {
    const { session, sheets } = await openModel();
    const ai = new FakeAi("Net income comes from revenue less costs and tax.");
    const outcome = await narrateTrace({ session, ai }, sheets.summary, { row: 2, col: 1 });
    expect(outcome.trace.inputs).toHaveLength(5);
    expect(outcome.highlights.length).toBe(outcome.trace.cells.length);
    expect(ai.prompts[0]).toContain("Assumptions!B6: 25.0% (typed-in input)");
    expect(outcome.text).toBe("Net income comes from revenue less costs and tax.");
  });

  it("needs no model to trace a typed-in value", async () => {
    const { session, sheets } = await openModel();
    const ai = new FakeAi();
    const outcome = await narrateTrace({ session, ai }, sheets.summary, { row: 1, col: 1 });
    expect(outcome.text).toContain("typed-in value");
    expect(ai.prompts).toEqual([]);
  });
});

describe("fixing a finding", () => {
  it("links the planted total to the projection in a reviewable proposal", async () => {
    const { session, sheets } = await openModel();
    const finding = checkWorkbook(session.workbook).find((entry) => entry.kind === "total-mismatch")!;
    const outcome = fixFinding({ session, ai: null, now: NOW }, finding);
    expect(outcome).toMatchObject({ status: "proposed", summary: "Summary!B2 becomes =Projection!N4." });
    expect(session.cell(sheets.summary, 1, 1).formula).toBe("Projection!N4");
    expect(session.workbook.listChanges()[0]!.author).toBe(ASSISTANT_AUTHOR);
    // After the fix the check no longer finds a mismatch.
    expect(checkWorkbook(session.workbook).filter((entry) => entry.kind === "total-mismatch")).toEqual([]);
  });
});

describe("formatting as a table", () => {
  it("proposes header, band and border styles that rejecting takes back", async () => {
    const { session, sheets } = await openModel();
    const before = session.cell(sheets.assumptions, 0, 0).styleId;
    const outcome = formatAsTable({ session, ai: null, now: NOW }, { sheet: sheets.assumptions, range: cell(0, 0) });
    expect(outcome.status).toBe("proposed");
    if (outcome.status !== "proposed") return;
    expect(outcome.label).toBe("Assistant: format A1:C6 as a table");
    const header = session.workbook.getStyle(session.cell(sheets.assumptions, 0, 0).styleId);
    expect(header.font.bold).toBe(true);
    expect(header.fill.color?.toUpperCase()).toBe("#2F5D8A");
    expect(outcome.changeIds).toHaveLength(18);
    session.rejectChanges(outcome.changeIds);
    expect(session.cell(sheets.assumptions, 0, 0).styleId).toBe(before);
  });
});

describe("cleaning a column", () => {
  it("turns numbers typed as text into numbers and tidies spaces", async () => {
    expect(numberFromText(" 1,200 ")).toBe(1200);
    expect(numberFromText("£50.5")).toBe(50.5);
    expect(numberFromText("(300)")).toBe(-300);
    expect(numberFromText("12%")).toBeCloseTo(0.12);
    expect(numberFromText("1,20")).toBeNull();
    expect(numberFromText("abc")).toBeNull();

    const { session, sheets } = await openModel();
    session.mutate((workbook) => workbook.setRange(sheets.summary, { row: 10, col: 4 }, [["Amount"], [" 1,200 "], ["£50"], [7], ["n/a​  "]]));
    const edits = normaliseColumn(session.workbook, sheets.summary, 4);
    expect(edits.map((edit) => [edit.row, edit.value])).toEqual([
      [11, 1200],
      [12, 50],
      [14, "n/a"],
    ]);
  });

  it("merges the model's column edits with the deterministic ones in one proposal", async () => {
    const { session, sheets } = await openModel();
    session.mutate((workbook) => workbook.setRange(sheets.summary, { row: 10, col: 4 }, [["Country"], ["uk "], ["United  Kingdom"], ["France"]]));
    const ai = new FakeAi(envelope([{ op: "setCell", sheet: "Summary", cell: "E12", value: "United Kingdom", expect: "uk" }], "Spells out country names."));
    const outcome = await cleanColumn({ session, ai, now: NOW }, sheets.summary, 4, "Use full country names");
    expect(outcome).toMatchObject({ status: "proposed", summary: "Spells out country names." });
    expect(session.cell(sheets.summary, 11, 4).value).toBe("United Kingdom");
    expect(session.cell(sheets.summary, 12, 4).value).toBe("United Kingdom");
    expect(new Set(session.workbook.listChanges().map((change) => change.proposalId)).size).toBe(1);
  });

  it("applies nothing when the model writes outside the column", async () => {
    const { session, sheets } = await openModel();
    session.mutate((workbook) => workbook.setRange(sheets.summary, { row: 10, col: 4 }, [["Country"], ["uk "]]));
    const ai = new FakeAi(envelope([{ op: "setCell", sheet: "Summary", cell: "B2", value: 1 }]));
    const outcome = await cleanColumn({ session, ai, now: NOW }, sheets.summary, 4, "Normalise");
    expect(outcome.status).toBe("invalid");
    expect(session.workbook.listChanges()).toEqual([]);
    expect(session.cell(sheets.summary, 11, 4).value).toBe("uk ");
  });
});
