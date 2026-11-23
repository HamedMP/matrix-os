// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TAB_LOOK_KEY } from "../../../../home/apps/sheets/src/ui/sheet-tabs-model";
import { flush, gridOf, pick, renderWithWorkbook } from "./harness";

afterEach(cleanup);

function styleAt(app: Awaited<ReturnType<typeof renderWithWorkbook>>, row: number, col: number) {
  const session = app.session();
  const sheet = session.getState().activeSheetId;
  return session.workbook.getStyle(session.cell(sheet, row, col).styleId);
}

function selectDown(app: Awaited<ReturnType<typeof renderWithWorkbook>>, steps: number): void {
  const grid = gridOf(app.container);
  act(() => grid.focus());
  for (let i = 0; i < steps; i++) fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
}

describe("Sheets toolbar", () => {
  it("sends formatting commands to the engine for the selection", async () => {
    const app = await renderWithWorkbook();
    selectDown(app, 2);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(styleAt(app, 0, 0).font.bold).toBe(true);
    expect(styleAt(app, 2, 0).font.bold).toBe(true);
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");

    await pick(/^Font size/, "14");
    expect(styleAt(app, 1, 0).font.sizePt).toBe(14);
    await pick(/^Font,/, "Georgia");
    expect(styleAt(app, 1, 0).font.name).toBe("Georgia");
    await pick("Number format", "Currency");
    expect(styleAt(app, 2, 0).numberFormat).toBe("$#,##0.00");
    fireEvent.click(screen.getByRole("button", { name: "Increase decimals" }));
    expect(styleAt(app, 2, 0).numberFormat).toBe("$#,##0.000");
    await pick("Fill colour", "Yellow");
    expect(styleAt(app, 0, 0).fill.color).toBe("#fff2a8");
    await pick("Text colour", "Red");
    expect(styleAt(app, 0, 0).font.color).toBe("#c00000");
    fireEvent.click(screen.getByRole("button", { name: "Center" }));
    fireEvent.click(screen.getByRole("button", { name: "Wrap text" }));
    expect(styleAt(app, 1, 0).alignment).toMatchObject({ horizontal: "center", wrapText: true });

    await pick("Borders", "Outside borders");
    expect(styleAt(app, 0, 0).border.top.style).toBe("thin");
    expect(styleAt(app, 1, 0).border.top.style).toBe("none");
    expect(styleAt(app, 2, 0).border.bottom.style).toBe("thin");
    expect(styleAt(app, 1, 0).border.left.style).toBe("thin");

    fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
    expect(styleAt(app, 1, 0).border.left.style).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: /^Redo/ }));
    expect(styleAt(app, 1, 0).border.left.style).toBe("thin");
  });

  it("inserts rows, freezes panes and sorts through the toolbar", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    await pick("Rows", "Insert row above");
    expect(session.cell(sheet, 1, 0).value).toBe(1);
    await pick("Freeze panes", "Freeze top row");
    expect(session.sheet(sheet).frozen).toEqual({ rows: 1, cols: 0 });
    act(() => {
      session.setInputs(sheet, { row: 0, col: 5 }, [["3"], ["1"], ["2"]]);
    });
    const box = screen.getByLabelText(/^Name box/);
    fireEvent.change(box, { target: { value: "F1:F3" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sort Z to A" }));
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 5).value)).toEqual([3, 2, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Sort A to Z" }));
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 5).value)).toEqual([1, 2, 3]);
  });
});

describe("Sheets tabs", () => {
  it("adds, renames, reorders, colours and deletes sheets with confirmation", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    await flush();
    const tabs = () => within(screen.getByRole("tablist", { name: "Sheets" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs()).toEqual(["Sheet1", "Sheet2"]);
    expect(session.sheet(session.getState().activeSheetId).name).toBe("Sheet2");

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Sheet2" }));
    const input = screen.getByLabelText("New name for Sheet2");
    fireEvent.change(input, { target: { value: "Totals" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(tabs()).toEqual(["Sheet1", "Totals"]);
    expect(session.sheets().map((sheet) => sheet.name)).toEqual(["Sheet1", "Totals"]);

    await pick("Options for Totals", "Move left");
    expect(tabs()).toEqual(["Totals", "Sheet1"]);
    await pick("Options for Totals", "Colour: Green");
    await flush();
    const stored = app.bridge.kv[TAB_LOOK_KEY] as { files: Array<{ path: string; order: string[]; colors: Record<string, string> }> };
    const totalsId = session.sheets().find((sheet) => sheet.name === "Totals")!.id;
    expect(stored.files[0]).toMatchObject({ path: "Budget.xlsx", colors: { [totalsId]: "green" } });
    expect(stored.files[0]!.order[0]).toBe(totalsId);
    expect(screen.getByRole("tab", { name: "Totals" }).parentElement?.className).toContain("sheets-tab-color--green");

    await pick("Options for Totals", "Delete");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("cannot be undone");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(tabs()).toEqual(["Totals", "Sheet1"]);
    await pick("Options for Totals", "Delete");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete sheet" }));
    await flush();
    expect(tabs()).toEqual(["Sheet1"]);
    expect(session.sheets()).toHaveLength(1);
  });

  it("refuses a bad sheet name with the engine's reason", async () => {
    const app = await renderWithWorkbook();
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Sheet2" }));
    const input = screen.getByLabelText("New name for Sheet2");
    fireEvent.change(input, { target: { value: "sheet1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(app.session().sheets().map((sheet) => sheet.name)).toEqual(["Sheet1", "Sheet2"]);
    const toast = document.querySelector(".oui-toast--warning .oui-toast__title");
    expect(toast?.textContent?.length ?? 0).toBeGreaterThan(0);
    expect(toast?.textContent).not.toMatch(/Error|undefined/);
  });
});

describe("Sheets status bar and name box", () => {
  it("shows sum, average and count of the selection and follows edits", async () => {
    const app = await renderWithWorkbook();
    selectDown(app, 2);
    const stats = screen.getByTestId("selection-stats");
    expect(stats.textContent).toContain("Sum: 6");
    expect(stats.textContent).toContain("Average: 2");
    expect(stats.textContent).toContain("Count: 3");
    act(() => {
      app.session().setCellInput(app.session().getState().activeSheetId, { row: 2, col: 0 }, "9");
    });
    expect(stats.textContent).toContain("Sum: 12");
  });

  it("goes to an address or a defined name", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, 1);
      workbook.setDefinedName({ name: "Inputs", refersTo: "Sheet1!$C$2:$D$4", scope: null });
    });
    const box = screen.getByLabelText(/^Name box/) as HTMLInputElement;
    expect(box.value).toBe("A1");
    fireEvent.change(box, { target: { value: "inputs" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("C2:D4");
    fireEvent.change(box, { target: { value: "B7" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("B7");
    expect(app.container.querySelector("datalist option")?.getAttribute("value")).toBe("Inputs");
  });
});

describe("Sheets find and replace", () => {
  it("finds matches across the sheet, steps through them and replaces", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["apple", "pear"], ["Apple pie", "plum"], [null, "apple"]]);
    });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const find = screen.getByRole("searchbox", { name: "Find" });
    fireEvent.change(find, { target: { value: "apple" } });
    expect(app.container.querySelector("search")!.textContent).toContain("1 of 3");
    expect(app.container.querySelectorAll("[data-row]").length).toBeGreaterThan(0);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(app.container.querySelector("search")!.textContent).toContain("2 of 3");
    expect((screen.getByLabelText(/^Name box/) as HTMLInputElement).value).toBe("A2");

    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
    expect(app.container.querySelector("search")!.textContent).toContain("of 2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "cherry" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await flush();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    expect([session.cell(sheet, 0, 0).value, session.cell(sheet, 1, 0).value, session.cell(sheet, 2, 1).value]).toEqual(["cherry", "cherry pie", "cherry"]);
    expect(app.container.querySelector("search")!.textContent).toContain("No matches");
    fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
    expect(session.cell(sheet, 1, 0).value).toBe("Apple pie");
  });
});

describe("Sheets right panel", () => {
  it("opens and closes the review and assistant panels, with a fallback when a module is missing", async () => {
    await renderWithWorkbook();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await flush();
    expect(screen.getByRole("complementary", { name: "Review changes" })).toBeTruthy();
    expect(screen.queryByText("Change review is not available")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await flush();
    expect(screen.getByRole("complementary", { name: "Assistant" })).toBeTruthy();
    expect(screen.queryByText("The assistant is not available")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    expect(screen.queryByRole("complementary")).toBeNull();

    const { lazyPanel } = await import("../../../../home/apps/sheets/src/ui/panel-slots");
    const Fallback = () => null;
    expect(lazyPanel({}, "Missing", Fallback)).toBe(Fallback);
  });
});
