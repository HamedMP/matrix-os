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
});
