// @vitest-environment jsdom
/** Ribbon commands the old toolbar did not have, run through the real app against the engine. */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProposal } from "../../../../home/apps/sheets/src/agent";
import { MAX_COLS } from "../../../../home/apps/sheets/src/session/engine";
import { flush, pick, renderWithWorkbook } from "./harness";

afterEach(cleanup);

function openTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function goTo(address: string): void {
  const box = screen.getByLabelText(/^Name box/);
  fireEvent.change(box, { target: { value: address } });
  fireEvent.keyDown(box, { key: "Enter" });
}

function toastText(): string {
  return Array.from(document.querySelectorAll(".oui-toast__title")).map((node) => node.textContent).join(" | ");
}

describe("Formulas tab", () => {
  it("adds an AutoSum over the numbers above and offers other functions", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    goTo("A4");
    openTab("Formulas");
    fireEvent.click(screen.getByRole("button", { name: "AutoSum" }));
    expect(session.cell(sheet, 3, 0)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    goTo("A1:A3");
    await pick("AutoSum options", "Max");
    expect(session.cell(sheet, 3, 0)).toMatchObject({ formula: "MAX(A1:A3)", value: 3 });
  });

  it("inserts a function chosen from the searchable list into the active cell", async () => {
    const app = await renderWithWorkbook();
    goTo("D1");
    openTab("Formulas");
    fireEvent.click(screen.getByRole("button", { name: "Insert function" }));
    const dialog = screen.getByRole("dialog", { name: "Insert function" });
    fireEvent.change(within(dialog).getByLabelText("Search functions"), { target: { value: "vlook" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^VLOOKUP\(/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(screen.queryByRole("dialog", { name: "Insert function" })).toBeNull();
    const editor = app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea");
    expect(editor?.value).toBe("=VLOOKUP(");
  });

  it("marks the precedents and dependents of the active cell and removes the marks", async () => {
    const app = await renderWithWorkbook();
    const marked = (kind: string) => Array.from(app.container.querySelectorAll(`.sg-cell.is-${kind}`)).map((cell) => `${cell.getAttribute("data-row")},${cell.getAttribute("data-col")}`);
    goTo("B1");
    openTab("Formulas");
    fireEvent.click(screen.getByRole("button", { name: "Trace precedents" }));
    expect(marked("precedent").sort()).toEqual(["0,0", "1,0", "2,0"]);
    goTo("A2");
    fireEvent.click(screen.getByRole("button", { name: "Trace dependents" }));
    expect(marked("dependent")).toEqual(["0,1"]);
    expect(marked("precedent")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove arrows" }));
    expect(marked("dependent")).toEqual([]);
    goTo("C1");
    fireEvent.click(screen.getByRole("button", { name: "Trace precedents" }));
    await flush();
    expect(toastText()).toContain("has no formula that reads other cells");
  });

  // Fault: a trace past the marking limit marked only the first cells and said nothing about the rest.
  it("says when a trace marks only the first part of the cells", async () => {
    await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setCell(sheet, { row: 11_999, col: 0 }, 1);
      workbook.setFormula(sheet, { row: 0, col: 1 }, "SUM(A1:A12000)");
    });
    goTo("B1");
    openTab("Formulas");
    fireEvent.click(screen.getByRole("button", { name: "Trace precedents" }));
    await flush();
    expect(toastText()).toContain("Marked the first 10,000 cells");
  });

  it("goes to a defined name and recalculates on request without marking the file edited", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 1);
      workbook.setDefinedName({ name: "Inputs", refersTo: "Sheet1!$C$2:$D$4", scope: null });
    });
    openTab("Formulas");
    await pick("Go to name", "Inputs");
    expect((screen.getByLabelText(/^Name box/) as HTMLInputElement).value).toBe("C2:D4");
    fireEvent.click(screen.getByRole("button", { name: "Calculate now" }));
    await flush();
    expect(app.session().getState().dirty).toBe(false);
    expect(toastText()).toContain("Recalculated");
  });
});

describe("Data tab", () => {
  it("removes duplicate rows of values as one undo step", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["Tea", 3], ["Cake", 5], ["Tea", 3], ["Tea", 4]]);
    });
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    goTo("A1:B4");
    openTab("Data");
    fireEvent.click(screen.getByRole("button", { name: "Remove duplicates" }));
    await flush();
    expect([0, 1, 2, 3].map((row) => session.cell(sheet, row, 0).value)).toEqual(["Tea", "Cake", "Tea", null]);
    expect(session.cell(sheet, 2, 1).value).toBe(4);
    expect(toastText()).toContain("Removed 1 duplicate row");
    act(() => {
      session.undo();
    });
    expect(session.cell(sheet, 3, 0).value).toBe("Tea");
  });

  it("splits a column of text into columns and refuses to write over cells", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["Ada,Lovelace,1815"], ["Alan,Turing,1912"], ["Grace"]]);
      workbook.setCell(sheet, { row: 0, col: 5 }, "a,b");
      workbook.setCell(sheet, { row: 0, col: 6 }, "taken");
    });
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    goTo("A1:A3");
    openTab("Data");
    await pick("Text to columns", "Split at comma");
    expect([session.cell(sheet, 1, 0).value, session.cell(sheet, 1, 1).value, session.cell(sheet, 1, 2).value]).toEqual(["Alan", "Turing", 1912]);
    expect(session.cell(sheet, 2, 0).value).toBe("Grace");
    goTo("F1");
    await pick("Text to columns", "Split at comma");
    await flush();
    expect(session.cell(sheet, 0, 6).value).toBe("taken");
    expect(toastText()).toContain("not empty");
  });

  // Outcome: splitting text in the last column tells the owner why nothing happened.
  // Fault: the cells to the right were read before the split was checked to fit, which threw past the last column and the ribbon failed silently.
  it("says the split does not fit when the parts would go past the last column", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setCell(sheet, { row: 0, col: MAX_COLS - 1 }, "a,b");
    });
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    goTo("XFD1");
    openTab("Data");
    await pick("Text to columns", "Split at comma");
    await flush();
    expect(session.cell(sheet, 0, MAX_COLS - 1).value).toBe("a,b");
    expect(toastText()).toContain("past the last column");
  });
});

describe("Review tab", () => {
  it("steps through proposed changes and accepts them all", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    act(() => {
      runProposal(session, "Raise", "2026-11-23T10:00:00.000Z", [], (workbook) => {
        workbook.setCell(sheet, { row: 0, col: 0 }, 10);
        workbook.setCell(sheet, { row: 1, col: 0 }, 20);
      });
    });
    await flush();
    openTab("Review");
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect((screen.getByRole("button", { name: "Accept change" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show markup" }));
    expect(screen.getByRole("button", { name: "Show markup" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await flush();
    expect(session.workbook.listChanges()).toEqual([]);
    expect(session.cell(sheet, 1, 0).value).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Review panel" }));
    expect(screen.getByRole("complementary", { name: "Review changes" })).toBeTruthy();
  });
});

describe("Assistant tab", () => {
  it("opens the assistant panel and runs its checks", async () => {
    await renderWithWorkbook();
    openTab("Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Check hard-coded values" }));
    await flush();
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(panel.textContent).toContain("No hard-coded values or mismatched totals found");
    expect((screen.getByRole("button", { name: "Explain selection" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("says how to paste when the window may not read the clipboard and nothing was copied here", async () => {
    await renderWithWorkbook();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await flush();
    expect(toastText()).toContain("Ctrl+V");
  });

  it("copies and pastes inside the workbook when the window may not use the clipboard, and says so", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    goTo("B1");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await flush();
    expect(toastText()).toContain("Copied for pasting in this workbook");
    goTo("B5");
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await flush();
    // The copied formula moved with its references.
    expect(session.cell(sheet, 4, 1)).toMatchObject({ formula: "SUM(A5:A7)" });
    expect(toastText()).not.toContain("Ctrl+V");

    goTo("C1");
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    await flush();
    goTo("D4");
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await flush();
    expect(session.cell(sheet, 3, 3).value).toBe("apple");
    expect(session.cell(sheet, 0, 2).value).toBeNull();
  });

  it("copies through the browser's own copy command, which needs no clipboard permission", async () => {
    await renderWithWorkbook();
    const copied: Record<string, string> = {};
    (document as { execCommand?: unknown }).execCommand = vi.fn((command: string) => {
      const event = new Event(command, { bubbles: true, cancelable: true });
      Object.assign(event, { clipboardData: { setData: (type: string, data: string) => void (copied[type] = data), getData: () => "" } });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    });
    goTo("C1");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await flush();
    expect(copied["text/plain"]).toBe("apple");
    expect(copied["text/html"]).toContain("apple");
    expect(toastText()).toBe("");
  });

  it("pastes the system clipboard when the window may read it", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => "x\ty", writeText: async () => undefined } });
    goTo("E1");
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await flush();
    const sheet = session.getState().activeSheetId;
    expect([session.cell(sheet, 0, 4).value, session.cell(sheet, 0, 5).value]).toEqual(["x", "y"]);
  });
});
