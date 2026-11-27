// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { tabLookKey } from "../../../../home/apps/sheets/src/ui/sheet-tabs-model";
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

function openTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function chooseColor(name: string, swatch: string): void {
  fireEvent.click(screen.getByRole("button", { name: `${name} options` }));
  fireEvent.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: swatch }));
}

describe("Sheets ribbon", () => {
  it("shows the menu bar tabs with the Home tab first", async () => {
    await renderWithWorkbook();
    const tabs = within(screen.getByRole("tablist", { name: "Menu bar" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["File", "Home", "Insert", "Formulas", "Data", "Review", "View", "Assistant"]);
    expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("title")).toContain("Ctrl+B");
    expect(screen.getByRole("button", { name: /^Undo/ }).getAttribute("aria-keyshortcuts")).toBe("Ctrl+Z");
  });

  it("sends Home formatting commands to the engine for the selection", async () => {
    const app = await renderWithWorkbook();
    selectDown(app, 2);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(styleAt(app, 0, 0).font.bold).toBe(true);
    expect(styleAt(app, 2, 0).font.bold).toBe(true);
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");

    const size = screen.getByRole("combobox", { name: "Font size" });
    fireEvent.change(size, { target: { value: "14" } });
    fireEvent.keyDown(size, { key: "Enter" });
    expect(styleAt(app, 1, 0).font.sizePt).toBe(14);
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "Georgia" } });
    expect(styleAt(app, 1, 0).font.name).toBe("Georgia");
    fireEvent.change(screen.getByRole("combobox", { name: "Number format" }), { target: { value: "currency" } });
    expect(styleAt(app, 2, 0).numberFormat).toBe("$#,##0.00");
    fireEvent.click(screen.getByRole("button", { name: "Increase decimals" }));
    expect(styleAt(app, 2, 0).numberFormat).toBe("$#,##0.000");
    fireEvent.click(screen.getByRole("button", { name: "Percent" }));
    expect(styleAt(app, 2, 0).numberFormat).toBe("0%");
    chooseColor("Fill colour", "Yellow");
    expect(styleAt(app, 0, 0).fill.color).toBe("#fff2a8");
    chooseColor("Text colour", "Red");
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

  it("inserts rows, freezes panes and sorts from the Home, View and Data tabs", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    await pick("Insert", "Insert row above");
    expect(session.cell(sheet, 1, 0).value).toBe(1);
    openTab("View");
    await pick("Freeze panes", "Freeze top row");
    expect(session.sheet(sheet).frozen).toEqual({ rows: 1, cols: 0 });
    act(() => {
      session.setInputs(sheet, { row: 0, col: 5 }, [["3"], ["1"], ["2"]]);
    });
    const box = screen.getByLabelText(/^Name box/);
    fireEvent.change(box, { target: { value: "F1:F3" } });
    fireEvent.keyDown(box, { key: "Enter" });
    openTab("Data");
    fireEvent.click(screen.getByRole("button", { name: "Sort Z to A" }));
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 5).value)).toEqual([3, 2, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Sort A to Z" }));
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 5).value)).toEqual([1, 2, 3]);
  });

  it("shows that a filter is on as soon as it is set, and lets it be cleared without moving the selection", async () => {
    await renderWithWorkbook();
    const box = screen.getByLabelText(/^Name box/);
    fireEvent.change(box, { target: { value: "A2" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await pick("Filter", "Show rows with the selected value");
    expect(screen.getByRole("button", { name: "Filter, on" })).toBeTruthy();
    await pick("Filter, on", "Show all rows");
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();

    openTab("Data");
    const toggle = () => screen.getByRole("button", { name: "Filter by selected value" });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the formula bar and gridlines from the View tab", async () => {
    const app = await renderWithWorkbook();
    openTab("View");
    expect(screen.getByLabelText(/^Name box/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Formula bar" }));
    expect(screen.queryByLabelText(/^Name box/)).toBeNull();
    expect(app.container.querySelector(".sg-bar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Gridlines" }));
    expect(app.container.querySelector(".sheets-grid-host")?.className).toContain("is-gridless");
    expect(screen.getByRole("button", { name: "Gridlines" }).getAttribute("aria-pressed")).toBe("false");
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
    const stored = app.bridge.kv[tabLookKey("Budget.xlsx")] as { path: string; order: string[]; colors: Record<string, string> };
    const totalsId = session.sheets().find((sheet) => sheet.name === "Totals")!.id;
    expect(stored).toMatchObject({ path: "Budget.xlsx", colors: { [totalsId]: "green" } });
    expect(stored.order[0]).toBe(totalsId);
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
    const names = document.getElementById(box.getAttribute("list") ?? "");
    expect(names?.querySelector("option")?.getAttribute("value")).toBe("Inputs");
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
  it("opens the real review and assistant panels and keeps the assistant conversation across panel switches", async () => {
    await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [[10], [20]]);
      workbook.setFormula(sheet, { row: 2, col: 0 }, "A1+A2+5");
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await flush();
    const review = screen.getByRole("complementary", { name: "Review changes" });
    expect(within(review).getByText("No changes to review")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await flush();
    const assistant = screen.getByRole("complementary", { name: "Assistant" });
    // No `ai` on the bridge: model actions are off, the checks still work.
    expect((within(assistant).getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(assistant).getByRole("button", { name: "Check for hard-coded values" }));
    await flush();
    const before = assistant.textContent ?? "";
    expect(before).toContain("No hard-coded values or mismatched totals found");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await flush();
    expect(screen.getByRole("complementary", { name: "Assistant" }).textContent).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("Sheets panels and tabs with text in the cell editor", () => {
  function typeInCell(app: Awaited<ReturnType<typeof renderWithWorkbook>>, text: string): HTMLTextAreaElement {
    const grid = gridOf(app.container);
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "x" });
    const input = app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")!;
    fireEvent.change(input, { target: { value: text } });
    return input;
  }

  it("replaces only after the text being typed is stored, and not while the editor refuses it", async () => {
    const app = await renderWithWorkbook("Budget.xlsx", (workbook, sheet) => {
      workbook.setRange(sheet, { row: 0, col: 0 }, [["pear"], ["apple"]]);
    });
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    const input = typeInCell(app, "=1+*");
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Find" }), { target: { value: "apple" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "cherry" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(session.cell(sheet, 1, 0).value).toBe("apple");
    expect(input.value).toBe("=1+*");

    // A1 is being typed over with the word the bar looks for: it is stored first, then replaced too.
    fireEvent.change(input, { target: { value: "apple" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(app.container.querySelector(".sg-input--cell textarea")).toBeNull();
    expect([session.cell(sheet, 0, 0).value, session.cell(sheet, 1, 0).value]).toEqual(["cherry", "cherry"]);
  });

  it("adds a sheet only after the text being typed is stored", async () => {
    const app = await renderWithWorkbook();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    const input = typeInCell(app, "=1+*");
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    await flush();
    expect(session.sheets()).toHaveLength(1);
    expect(input.value).toBe("=1+*");

    fireEvent.change(input, { target: { value: "typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    await flush();
    expect(session.sheets()).toHaveLength(2);
    expect(session.cell(sheet, 0, 0).value).toBe("typed");
  });
});
