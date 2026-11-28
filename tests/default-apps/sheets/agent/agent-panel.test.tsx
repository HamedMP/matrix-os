// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetsAssistant, bridgeSheetsAi } from "../../../../home/apps/sheets/src/agent";
import { SheetsAgentPanel, selectionFromGrid } from "../../../../home/apps/sheets/src/ui/agent";
import { FakeGrid, openModel } from "../review/fixture";
import { NOW, envelope } from "./fake-ai";

type Win = Window & { MatrixOS?: unknown };

afterEach(() => {
  cleanup();
  delete (window as Win).MatrixOS;
});

/** A fake `window.MatrixOS` whose `ai.generate` answers from a queue and records prompts. */
function installBridge(...replies: string[]): { prompts: string[] } {
  const record = { prompts: [] as string[] };
  (window as Win).MatrixOS = {
    ai: {
      generate: async ({ prompt }: { prompt: string }) => {
        record.prompts.push(prompt);
        return { text: replies.shift() ?? "" };
      },
    },
  };
  return record;
}

async function setup(...replies: string[]) {
  const bridge = installBridge(...replies);
  const model = await openModel();
  const grid = new FakeGrid();
  const reviewed: string[] = [];
  const assistant = new SheetsAssistant({ session: model.session, ai: bridgeSheetsAi(window), grid, now: NOW, onReview: (proposalId) => reviewed.push(proposalId) });
  const selection = { sheet: model.sheets.summary, range: { start: { row: 3, col: 1 }, end: { row: 3, col: 1 } } };
  render(<SheetsAgentPanel assistant={assistant} getSelection={() => selection} />);
  return { ...model, bridge, grid, assistant, reviewed };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SheetsAgentPanel", () => {
  it("checks for hard-coded values, links the total and accepts the fix", async () => {
    const { session, sheets, assistant } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Check for hard-coded values" }));
    await settle();
    expect(screen.getByText("Summary!B2 shows 725,000 but Projection!N4 calculates 709,601.48.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Link Summary!B2 to its calculation" }));
    await settle();
    const card = screen.getByRole("article", { name: "Link Summary!B2 to its calculation" });
    expect(within(card).getByText("1 change · Matrix Assistant")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Accept all" }));
    expect(within(card).getByText("Accepted")).toBeTruthy();
    expect(session.cell(sheets.summary, 1, 1).formula).toBe("Projection!N4");
    expect(session.workbook.listChanges()).toEqual([]);
    assistant.dispose();
  });

  // Outcome: when Check could not read a sheet, the card says the check is incomplete and names it.
  // Fault: the card says every total adds up although that sheet was never checked.
  it("says the check is incomplete and names the sheets too large to check", async () => {
    const { session, sheets, assistant } = await setup();
    act(() => {
      session.mutate((workbook) => workbook.setCell(sheets.summary, { row: 999, col: 299 }, 1));
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for hard-coded values" }));
    await settle();
    const panel = document.body;
    expect(panel.textContent).not.toContain("Every total adds up");
    expect(panel.textContent).not.toContain("No hard-coded values or mismatched totals found");
    expect(panel.textContent).toContain("Check incomplete");
    expect(panel.textContent).toContain("Not checked, too large to read: Summary.");
    assistant.dispose();
  });

  it("sends a typed instruction through MatrixOS.ai and offers review of the proposal", async () => {
    const { session, sheets, bridge, reviewed, assistant } = await setup(envelope([{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.05, expect: "3.0%" }], "Raises growth to 5%."));
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "Set growth to 5%" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await settle();
    expect(bridge.prompts).toHaveLength(1);
    expect(screen.getByText("Raises growth to 5%.")).toBeTruthy();
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.05);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(reviewed).toEqual([session.workbook.listChanges()[0]!.proposalId]);
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.03);
    assistant.dispose();
  });

  it("explains the selected formula and highlights its sources", async () => {
    const { grid, assistant } = await setup("It divides net income by revenue.");
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await settle();
    expect(screen.getByText("It divides net income by revenue.")).toBeTruthy();
    expect(grid.layers.get("assistant-sources")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear highlights" }));
    expect(grid.layers.size).toBe(0);
    assistant.dispose();
  });

  it("asks for a selection when there is none", async () => {
    installBridge();
    const model = await openModel();
    const assistant = new SheetsAssistant({ session: model.session, ai: bridgeSheetsAi(window), now: NOW });
    render(<SheetsAgentPanel assistant={assistant} getSelection={() => selectionFromGrid(null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Format as table" }));
    expect(screen.getByRole("status").textContent).toBe("Select a cell or a range on the sheet first.");
    assistant.dispose();
  });

  it("turns AI actions off when the host has no model", async () => {
    const model = await openModel();
    const assistant = new SheetsAssistant({ session: model.session, ai: bridgeSheetsAi(window), now: NOW });
    render(<SheetsAgentPanel assistant={assistant} getSelection={() => null} aiAvailable={false} />);
    expect((screen.getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Check for hard-coded values" }) as HTMLButtonElement).disabled).toBe(false);
    assistant.dispose();
  });

  it("does nothing when the cell editor's text was refused", async () => {
    installBridge();
    const model = await openModel();
    const assistant = new SheetsAssistant({ session: model.session, ai: bridgeSheetsAi(window), now: NOW });
    const selection = { sheet: model.sheets.summary, range: { start: { row: 3, col: 1 }, end: { row: 3, col: 1 } } };
    render(<SheetsAgentPanel assistant={assistant} getSelection={() => selection} beforeAction={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for hard-coded values" }));
    fireEvent.click(screen.getByRole("button", { name: "Format as table" }));
    await settle();
    expect(assistant.getState().messages).toEqual([]);
    expect(model.session.workbook.listChanges()).toEqual([]);
    assistant.dispose();
  });

  // Outcome: a result card button commits the cell editor first and does nothing when its text is refused.
  // Fault: Link to calculation proposes a formula under a still-open editor, whose Enter then writes the old draft over it.
  it("commits the cell editor before every result card button and stops when it is refused", async () => {
    installBridge("It divides net income by revenue.");
    const model = await openModel();
    const grid = new FakeGrid();
    const reviewed: string[] = [];
    const assistant = new SheetsAssistant({ session: model.session, ai: bridgeSheetsAi(window), grid, now: NOW, onReview: (id) => reviewed.push(id) });
    const selection = { sheet: model.sheets.summary, range: { start: { row: 3, col: 1 }, end: { row: 3, col: 1 } } };
    let refuse = false;
    let commits = 0;
    const beforeAction = () => {
      commits++;
      return !refuse;
    };
    render(<SheetsAgentPanel assistant={assistant} getSelection={() => selection} beforeAction={beforeAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check for hard-coded values" }));
    await settle();

    refuse = true;
    commits = 0;
    const selectedBefore = grid.selected.length;
    fireEvent.click(screen.getByRole("button", { name: "Link Summary!B2 to its calculation" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Go to Summary!B2" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Clear highlights" }));
    await settle();
    expect(commits).toBe(3);
    expect(model.session.workbook.listChanges()).toEqual([]);
    expect(screen.queryByRole("article", { name: "Link Summary!B2 to its calculation" })).toBeNull();
    expect(grid.selected.length).toBe(selectedBefore);
    expect(grid.layers.get("assistant-sources")).toHaveLength(2);

    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Link Summary!B2 to its calculation" }));
    await settle();
    const card = screen.getByRole("article", { name: "Link Summary!B2 to its calculation" });

    refuse = true;
    commits = 0;
    for (const name of ["Accept all", "Reject all", "Review"]) fireEvent.click(within(card).getByRole("button", { name }));
    expect(commits).toBe(3);
    expect(model.session.workbook.listChanges()).toHaveLength(1);
    expect(reviewed).toEqual([]);
    assistant.dispose();
  });
});
