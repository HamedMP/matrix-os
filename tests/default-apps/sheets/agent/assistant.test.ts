import { describe, expect, it } from "vitest";
import { FINDINGS_LAYER, SOURCES_LAYER, SheetsAssistant, routeInstruction } from "../../../../home/apps/sheets/src/agent";
import { FakeGrid, openModel } from "../review/fixture";
import { FakeAi, NOW, envelope } from "./fake-ai";

const B2 = { start: { row: 1, col: 1 }, end: { row: 1, col: 1 } };

describe("routing typed instructions", () => {
  it.each([
    ["Explain this formula", "explain"],
    ["What does B4 calculate?", "explain"],
    ["Trace this value", "trace"],
    ["Where does net income come from?", "trace"],
    ["Check for hard-coded values", "check"],
    ["Format as table", "format-table"],
    ["Clean and normalise the selected column", "clean-column"],
    ["Build a table of monthly costs", "build-table"],
    ["Set growth to 5%", "edit"],
  ])("%s -> %s", (text, intent) => {
    expect(routeInstruction(text)).toBe(intent);
  });
});

describe("SheetsAssistant", () => {
  it("turns an instruction into a proposal card that accepts all of its changes", async () => {
    const { session, sheets } = await openModel();
    const ai = new FakeAi(envelope([{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05, expect: "3.0%" }, { op: "setCell", sheet: "Assumptions", cell: "B5", value: 20000 }], "Raises growth and costs."));
    const assistant = new SheetsAssistant({ session, ai, now: NOW });
    await assistant.ask("Raise growth to 5% and costs to 20000", { sheet: sheets.assumptions, range: B2 });
    const state = assistant.getState();
    expect(state.busy).toBe(false);
    expect(state.messages.map((message) => message.role)).toEqual(["user", "agent"]);
    expect(state.statusLines.every((line) => line.state === "done")).toBe(true);
    expect(state.results).toHaveLength(1);
    const card = state.results[0]!;
    expect(card).toMatchObject({ kind: "proposal", status: "proposed", changeCount: 2, summary: "Raises growth and costs." });

    assistant.acceptResult(card.id);
    expect(assistant.getState().results[0]).toMatchObject({ status: "accepted" });
    expect(session.workbook.listChanges()).toEqual([]);
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.05);
    assistant.dispose();
  });

  it("rejects all of a proposal and follows review done elsewhere", async () => {
    const { session, sheets } = await openModel();
    const reply = envelope([{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05 }]);
    const ai = new FakeAi(reply, reply);
    const reviewed: Array<[string, string | null]> = [];
    const assistant = new SheetsAssistant({ session, ai, now: NOW, onReview: (proposal, change) => reviewed.push([proposal, change]) });
    await assistant.ask("Raise growth", { sheet: sheets.assumptions, range: B2 });
    const first = assistant.getState().results[0]!;
    assistant.rejectResult(first.id);
    expect(assistant.getState().results[0]).toMatchObject({ status: "rejected" });
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.03);

    await assistant.ask("Raise growth", { sheet: sheets.assumptions, range: B2 });
    const second = assistant.getState().results[1]!;
    assistant.reviewResult(second.id);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]![1]).toBe(session.workbook.listChanges()[0]!.id);
    // Resolved in the review panel: the card follows.
    session.rejectChanges("all");
    expect(assistant.getState().results[1]).toMatchObject({ status: "rejected", pending: 0 });
    assistant.dispose();
  });

  it("explains with the sources highlighted on the grid", async () => {
    const { session, sheets } = await openModel();
    const grid = new FakeGrid();
    const assistant = new SheetsAssistant({ session, ai: new FakeAi("It divides net income by revenue."), grid, now: NOW });
    await assistant.explain({ sheet: sheets.summary, range: { start: { row: 3, col: 1 }, end: { row: 3, col: 1 } } });
    expect(assistant.getState().results[0]).toMatchObject({ kind: "answer", subject: "Summary!B4", text: "It divides net income by revenue." });
    const sources = grid.layers.get(SOURCES_LAYER)!;
    expect(sources.every((decoration) => decoration.kind === "precedent")).toBe(true);
    expect(sources).toHaveLength(2);
    assistant.clearHighlights();
    expect(grid.layers.size).toBe(0);
    assistant.dispose();
  });

  it("checks for hard-coded values without a model, marks and selects the findings, and proposes a fix", async () => {
    const { session, sheets } = await openModel();
    const grid = new FakeGrid();
    const assistant = new SheetsAssistant({ session, ai: null, grid, now: NOW });
    await assistant.check();
    const card = assistant.getState().results[0]!;
    expect(card.kind).toBe("findings");
    if (card.kind !== "findings") return;
    expect(card.findings.map((finding) => finding.location)).toEqual(["Summary!B2", "Summary!B2"]);
    expect(grid.layers.get(FINDINGS_LAYER)).toHaveLength(1);
    expect(grid.selected[0]).toEqual({ target: { row: 1, col: 1 }, sheet: sheets.summary });

    await assistant.fix(card.findings.find((finding) => finding.kind === "total-mismatch")!);
    expect(assistant.getState().results[1]).toMatchObject({ kind: "proposal", status: "proposed" });
    expect(session.cell(sheets.summary, 1, 1).formula).toBe("Projection!N4");
    assistant.dispose();
  });

  it("formats a table and cleans a column as proposals, without a model", async () => {
    const { session, sheets } = await openModel();
    const assistant = new SheetsAssistant({ session, ai: null, now: NOW });
    await assistant.formatTable({ sheet: sheets.assumptions, range: B2 });
    session.mutate((workbook) => workbook.setRange(sheets.summary, { row: 10, col: 4 }, [["Amount"], [" 1,200 "], ["50"]]));
    await assistant.cleanColumn({ sheet: sheets.summary, range: { start: { row: 10, col: 4 }, end: { row: 10, col: 4 } } }, "Clean the selected column");
    expect(assistant.getState().results.map((result) => result.kind)).toEqual(["proposal", "proposal"]);
    expect(session.cell(sheets.summary, 11, 4).value).toBe(1200);
    assistant.dispose();
  });

  it("reports a model failure safely and applies nothing", async () => {
    const { session, sheets } = await openModel();
    const assistant = new SheetsAssistant({ session, ai: new FakeAi(new Error("upstream 503 with secrets")), now: NOW });
    await assistant.ask("Raise growth", { sheet: sheets.assumptions, range: B2 });
    const state = assistant.getState();
    expect(state.messages.at(-1)!.text).toBe("The assistant could not answer. Try again.");
    expect(state.statusLines.some((line) => line.state === "error")).toBe(true);
    expect(state.results).toEqual([]);
    expect(session.workbook.listChanges()).toEqual([]);
    assistant.dispose();
  });

  it("says nothing changed when the reply is invalid", async () => {
    const { session, sheets } = await openModel();
    const assistant = new SheetsAssistant({ session, ai: new FakeAi("{ not json"), now: NOW });
    await assistant.ask("Raise growth", { sheet: sheets.assumptions, range: B2 });
    expect(assistant.getState().messages.at(-1)!.text).toMatch(/^Nothing was changed/);
    expect(session.workbook.listChanges()).toEqual([]);
    assistant.dispose();
  });

  it("stops a running request and ignores new ones while busy", async () => {
    const { session, sheets } = await openModel();
    let release: (text: string) => void = () => undefined;
    const ai = { prompts: 0, generate: () => new Promise<string>((resolve) => { ai.prompts += 1; release = resolve; }) };
    const assistant = new SheetsAssistant({ session, ai, now: NOW });
    const running = assistant.ask("Raise growth", { sheet: sheets.assumptions, range: B2 });
    expect(assistant.getState().busy).toBe(true);
    await assistant.ask("Something else", { sheet: sheets.assumptions, range: B2 });
    expect(ai.prompts).toBe(1);
    assistant.cancel();
    await running;
    release(envelope([{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05 }]));
    expect(assistant.getState().messages.at(-1)!.text).toBe("Stopped.");
    expect(session.workbook.listChanges()).toEqual([]);
    assistant.dispose();
  });
});
