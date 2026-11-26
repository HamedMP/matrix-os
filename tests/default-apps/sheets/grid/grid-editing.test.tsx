// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { at, cellElement, cellText, click, drag, editor, formulaBar, liveText, press, renderGrid, type } from "./harness";

afterEach(cleanup);

describe("SheetGrid editing", () => {
  it("commits typed text to the engine, recalculates dependents and moves down", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    expect(cellText(container, 0, 1)).toBe("6");

    press(grid, "9");
    const input = editor(container)!;
    expect(input.value).toBe("9");
    expect(input.ownerDocument.activeElement).toBe(input);
    type(input, "95");
    press(input, "Enter");

    expect(editor(container)).toBeNull();
    expect(session.cell(sheet, 0, 0).value).toBe(95);
    expect(session.cell(sheet, 0, 1).value).toBe(100);
    expect(cellText(container, 0, 0)).toBe("95");
    expect(cellText(container, 0, 1)).toBe("100");
    expect(session.getState()).toMatchObject({ dirty: true, undoLabel: "Typing" });
    expect(liveText(container)).toMatch(/^A2, 2/);
    expect(grid.ownerDocument.activeElement).toBe(grid);
  });

  it("keeps the content with F2, cancels with Escape and writes nothing for an unchanged commit", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 1);
    press(grid, "F2");
    expect(editor(container)!.value).toBe("=SUM(A1:A3)");
    type(editor(container)!, "=SUM(A1:A3)*2");
    press(editor(container)!, "Escape");
    expect(editor(container)).toBeNull();
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");

    press(grid, "F2");
    press(editor(container)!, "Enter");
    expect(session.getState().dirty).toBe(false);
  });

  it("opens the editor on a double click and breaks the line with Alt+Enter", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 2);
    fireEvent.doubleClick(grid, at(0, 2));
    const input = editor(container)!;
    expect(input.value).toBe("note");
    // Arrows belong to the caret now; they do not leave the cell.
    press(input, "ArrowLeft");
    expect(editor(container)).not.toBeNull();
    press(input, "Enter", { altKey: true });
    expect(editor(container)!.value).toBe("note\n");
    type(editor(container)!, "note\ntwo");
    press(editor(container)!, "Enter");
    expect(session.cell(sheet, 0, 2).value).toBe("note\ntwo");
  });

  it("commits with Tab to the right and with the arrows after typing", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 4, 0);
    press(grid, "a");
    press(editor(container)!, "Tab");
    expect(session.cell(sheet, 4, 0).value).toBe("a");
    expect(liveText(container)).toMatch(/^B5/);
    press(grid, "b");
    press(editor(container)!, "ArrowDown");
    expect(session.cell(sheet, 4, 1).value).toBe("b");
    expect(liveText(container)).toMatch(/^B6/);
  });

  it("keeps the editor open with an explanation when a formula does not parse", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    press(grid, "=");
    type(editor(container)!, "=1+*");
    press(editor(container)!, "Enter");
    expect(editor(container)).not.toBeNull();
    expect(editor(container)!.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("formula");
    expect(session.cell(sheet, 0, 0).value).toBe(1);

    type(editor(container)!, "=1+2");
    press(editor(container)!, "Enter");
    expect(session.cell(sheet, 0, 0)).toMatchObject({ formula: "1+2", value: 3 });
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("closes brackets left open in a formula", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 5, 0);
    press(grid, "=");
    type(editor(container)!, "=SUM(A1:A3");
    press(editor(container)!, "Enter");
    expect(session.cell(sheet, 5, 0)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
  });

  it("puts a clicked cell and a dragged range into the formula and outlines them", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 5, 2);
    press(grid, "=");
    click(grid, 1, 0);
    expect(editor(container)!.value).toBe("=A2");
    expect(container.querySelectorAll(".sg-reference")).toHaveLength(1);
    // The owner keeps typing in the editor: the click did not move the focus or the active cell.
    expect(liveText(container)).toMatch(/^C6/);
    type(editor(container)!, "=A2+SUM(");
    drag(grid, [0, 0], [2, 0]);
    expect(editor(container)!.value).toBe("=A2+SUM(A1:A3");
    expect(container.querySelectorAll(".sg-reference")).toHaveLength(2);
    expect(container.querySelectorAll(".sg-input--cell .sg-ref-text")).toHaveLength(2);
    press(editor(container)!, "Enter");
    expect(session.cell(sheet, 5, 2)).toMatchObject({ formula: "A2+SUM(A1:A3)", value: 8 });
    expect(container.querySelectorAll(".sg-reference")).toHaveLength(0);
  });

  it("takes a reference from another sheet while the formula is typed", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    let other = "";
    act(() => {
      other = session.addSheet("My data").sheet as string;
      session.setCellInput(other, { row: 1, col: 1 }, "40");
      session.setActiveSheet(sheet);
    });
    click(grid, 5, 0);
    press(grid, "=");
    type(editor(container)!, "=A1+");
    act(() => session.setActiveSheet(other));
    // The editor stays alive, out of sight, while another sheet is shown.
    expect(editor(container)).not.toBeNull();
    click(grid, 1, 1);
    expect(editor(container)!.value).toBe("=A1+'My data'!B2");
    press(editor(container)!, "Enter");
    expect(session.getState().activeSheetId).toBe(sheet);
    expect(session.cell(sheet, 5, 0)).toMatchObject({ formula: "A1+'My data'!B2", value: 41 });
  });

  it("points at cells with the arrow keys and cycles absolute references with F4", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 3, 1);
    press(grid, "=");
    press(editor(container)!, "ArrowUp");
    expect(editor(container)!.value).toBe("=B3");
    press(editor(container)!, "ArrowLeft");
    expect(editor(container)!.value).toBe("=A3");
    press(editor(container)!, "ArrowUp", { shiftKey: true });
    expect(editor(container)!.value).toBe("=A2:A3");
    press(editor(container)!, "F4");
    expect(editor(container)!.value).toBe("=$A$2:$A$3");
    press(editor(container)!, "Enter");
    expect(session.cell(sheet, 3, 1).formula).toBe("$A$2:$A$3");
  });

  it("completes function names and shows the arguments of the call", async () => {
    const { grid, container } = await renderGrid();
    click(grid, 5, 0);
    press(grid, "=");
    type(editor(container)!, "=su");
    const options = [...container.querySelectorAll("[role='option']")].map((option) => option.querySelector(".sg-popup__name")?.textContent);
    expect(options[0]).toBe("SUM");
    expect(options).toContain("SUMIF");
    expect(editor(container)!.getAttribute("aria-activedescendant")).toBe(container.querySelector("[role='option']")!.id);

    press(editor(container)!, "ArrowDown");
    expect(container.querySelector("[role='option'][aria-selected='true'] .sg-popup__name")?.textContent).toBe(options[1]);
    press(editor(container)!, "ArrowUp");
    press(editor(container)!, "Tab");
    expect(editor(container)!.value).toBe("=SUM(");
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(container.querySelector(".sg-popup__hint")?.textContent).toContain("SUM(number1, [number2], …)");
    expect(container.querySelector(".sg-popup__arg.is-active")?.textContent).toBe("number1");

    type(editor(container)!, "=SUM(1,");
    expect(container.querySelector(".sg-popup__arg.is-active")?.textContent).toBe("[number2]");
  });

  it("edits in the formula bar with the same commit", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 1, 0);
    const bar = formulaBar(container);
    expect(bar.value).toBe("2");
    act(() => bar.focus());
    type(bar, "=A1+40");
    expect(editor(container)!.value).toBe("=A1+40");
    press(bar, "Enter");
    expect(session.cell(sheet, 1, 0)).toMatchObject({ formula: "A1+40", value: 41 });
    expect(session.cell(sheet, 0, 1).value).toBe(45);
  });

  it("goes to a typed address from the name box", async () => {
    const { container } = await renderGrid();
    const name = container.querySelector<HTMLInputElement>(".sg-bar__name")!;
    expect(name.value).toBe("A1");
    fireEvent.change(name, { target: { value: "c3:d4" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(liveText(container)).toMatch(/^C3, empty, 2 by 2 cells selected/);
    fireEvent.change(name, { target: { value: "not a cell" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(container.querySelector("[role='alert']")?.textContent).toContain("B7");
  });

  it("clears with Delete, undoes with Ctrl+Z back to the cells it touched, and redoes", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 0);
    click(grid, 2, 0, { shiftKey: true });
    press(grid, "Delete");
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 0).value)).toEqual([null, null, null]);
    expect(cellText(container, 0, 1)).toBe("0");

    click(grid, 8, 5);
    press(grid, "z", { ctrlKey: true });
    expect([0, 1, 2].map((row) => session.cell(sheet, row, 0).value)).toEqual([1, 2, 3]);
    expect(liveText(container)).toMatch(/^A1, 1, 3 by 1 cells selected/);
    press(grid, "y", { ctrlKey: true });
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    press(grid, "Z", { ctrlKey: true, shiftKey: true });
    press(grid, "z", { metaKey: true });
    expect(session.cell(sheet, 0, 0).value).toBe(1);
  });

  it("fills down and right from the edge of the selection and toggles formats", async () => {
    const { session, sheet, grid } = await renderGrid();
    click(grid, 0, 1);
    click(grid, 0, 3, { shiftKey: true });
    press(grid, "r", { ctrlKey: true });
    expect(session.cell(sheet, 0, 2).formula).toBe("SUM(B1:B3)");
    expect(session.cell(sheet, 0, 3).formula).toBe("SUM(C1:C3)");

    click(grid, 2, 0);
    click(grid, 4, 0, { shiftKey: true });
    press(grid, "d", { ctrlKey: true });
    expect([3, 4].map((row) => session.cell(sheet, row, 0).value)).toEqual([3, 3]);

    press(grid, "b", { ctrlKey: true });
    press(grid, "i", { ctrlKey: true });
    press(grid, "u", { ctrlKey: true });
    const font = session.workbook.getStyle(session.cell(sheet, 3, 0).styleId).font;
    expect(font).toMatchObject({ bold: true, italic: true, underline: true });
    press(grid, "b", { ctrlKey: true });
    expect(session.workbook.getStyle(session.cell(sheet, 3, 0).styleId).font.bold).toBe(false);
  });

  it("continues a series when the fill handle is dragged", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 0);
    click(grid, 1, 0, { shiftKey: true });
    const handle = container.querySelector(".sg-fill-handle")!;
    drag(grid, [1, 0], [5, 0], handle);
    expect([0, 1, 2, 3, 4, 5].map((row) => session.cell(sheet, row, 0).value)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(session.getState().undoLabel).toBe("Fill");
    expect(liveText(container)).toContain("6 by 1 cells selected");
    press(grid, "z", { ctrlKey: true });
    expect(session.cell(sheet, 5, 0).value).toBeNull();
    expect(session.cell(sheet, 2, 0).value).toBe(3);
  });

  it("copies as text and HTML and pastes its own cells with adjusted formulas", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 0);
    click(grid, 0, 1, { shiftKey: true });
    const setData = vi.fn();
    fireEvent.copy(grid, { clipboardData: { setData } });
    const text = setData.mock.calls.find((call) => call[0] === "text/plain")?.[1] as string;
    const html = setData.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    expect(text).toBe("1\t6");
    expect(html).toContain('data-sheets-formula="SUM(A1:A3)"');
    expect(container.querySelector(".sg-copy")).not.toBeNull();

    click(grid, 5, 3);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? text : html) } });
    expect(session.cell(sheet, 5, 3).value).toBe(1);
    expect(session.cell(sheet, 5, 4).formula).toBe("SUM(D6:D8)");
    expect(session.getState().undoLabel).toBe("Paste");
    expect(liveText(container)).toContain("1 by 2 cells selected");
  });

  it("moves cells with cut and paste and keeps their references", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    click(grid, 0, 1);
    const setData = vi.fn();
    fireEvent.cut(grid, { clipboardData: { setData } });
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");
    const text = setData.mock.calls.find((call) => call[0] === "text/plain")?.[1] as string;
    const html = setData.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    click(grid, 6, 4);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? text : html) } });
    expect(session.cell(sheet, 0, 1).value).toBeNull();
    expect(session.cell(sheet, 6, 4)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(container.querySelector(".sg-copy")).toBeNull();
    press(grid, "z", { ctrlKey: true });
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");
    expect(session.cell(sheet, 6, 4).value).toBeNull();
  });

  it("pastes what the clipboard holds when another copy replaced a cut there, even with the same text", async () => {
    const { session, sheet, grid } = await renderGrid();
    click(grid, 0, 1);
    const setData = vi.fn();
    fireEvent.cut(grid, { clipboardData: { setData } });
    const cutHtml = setData.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    expect(cutHtml).toMatch(/data-sheets-clip="[0-9a-f]{32}"/);

    // Another window copied a literal 6, which reads like the cut formula's result.
    const other = cutHtml.replace(/data-sheets-clip="[0-9a-f]{32}"/, `data-sheets-clip="${"0".repeat(32)}"`).replace(/ data-sheets-formula="[^"]*"/, ' data-sheets-type="n" data-sheets-value="6"');
    click(grid, 6, 4);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? "6" : other) } });
    expect(session.cell(sheet, 6, 4)).toMatchObject({ formula: null, value: 6 });
    expect(session.cell(sheet, 0, 1)).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });

    // Plain text alone does not prove the cut is still on the clipboard either: it is typed in.
    click(grid, 0, 1);
    fireEvent.cut(grid, { clipboardData: { setData: vi.fn() } });
    click(grid, 7, 4);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? "6" : "") } });
    expect(session.cell(sheet, 7, 4)).toMatchObject({ formula: null, value: 6 });
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");
  });

  it("gives each copy its own mark, so an older copy of the same cells is not taken for the newer one", async () => {
    const { session, sheet, grid } = await renderGrid();
    click(grid, 0, 1);
    const first = vi.fn();
    fireEvent.copy(grid, { clipboardData: { setData: first } });
    const firstHtml = first.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    const second = vi.fn();
    fireEvent.cut(grid, { clipboardData: { setData: second } });
    const secondHtml = second.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    expect(firstHtml).not.toBe(secondHtml);

    // The clipboard still holds the first copy: a paste copies the formula and leaves the cut cells in place.
    click(grid, 6, 4);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? "6" : firstHtml) } });
    expect(session.cell(sheet, 6, 4).formula).toBe("SUM(D7:D9)");
    expect(session.cell(sheet, 0, 1).formula).toBe("SUM(A1:A3)");
  });

  it("moves cut cells in a mostly empty sheet without reading every position of it", async () => {
    const { session, sheet, grid } = await renderGrid((workbook, id) => {
      workbook.setRange(id, { row: 0, col: 0 }, [[1], [2], [3]]);
      workbook.setFormula(id, { row: 0, col: 1 }, "A1*2");
      workbook.setCell(id, { row: 1_048_575, col: 16_383 }, "far corner");
    });
    click(grid, 0, 0);
    const setData = vi.fn();
    fireEvent.cut(grid, { clipboardData: { setData } });
    const text = setData.mock.calls.find((call) => call[0] === "text/plain")?.[1] as string;
    const html = setData.mock.calls.find((call) => call[0] === "text/html")?.[1] as string;
    click(grid, 5, 3);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? text : html) } });
    expect(session.cell(sheet, 5, 3).value).toBe(1);
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    expect(session.cell(sheet, 0, 1)).toMatchObject({ formula: "D6*2", value: 2 });
  });

  it("pastes text and tables from other programs as typed values", async () => {
    const { session, sheet, grid } = await renderGrid();
    click(grid, 4, 0);
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/plain" ? "10\tx\r\n25%\t=A5*2\r\n" : "") } });
    expect(session.cell(sheet, 4, 0).value).toBe(10);
    expect(session.cell(sheet, 4, 1).value).toBe("x");
    expect(session.cell(sheet, 5, 0)).toMatchObject({ value: 0.25, display: "25%" });
    expect(session.cell(sheet, 5, 1)).toMatchObject({ formula: "A5*2", value: 20 });

    click(grid, 8, 0);
    const html = "<table><tr><td>a</td><td><b>b</b></td></tr><tr><td colspan=2>wide</td></tr></table>";
    fireEvent.paste(grid, { clipboardData: { getData: (kind: string) => (kind === "text/html" ? html : "ignored") } });
    expect([session.cell(sheet, 8, 0).value, session.cell(sheet, 8, 1).value, session.cell(sheet, 9, 0).value]).toEqual(["a", "b", "wide"]);
  });

  it("changes nothing when it is read-only", async () => {
    const { session, sheet, grid, container } = await renderGrid(undefined, { readOnly: true });
    press(grid, "9");
    expect(editor(container)).toBeNull();
    press(grid, "Delete");
    fireEvent.paste(grid, { clipboardData: { getData: () => "7" } });
    fireEvent.doubleClick(grid, { clientX: 70, clientY: 30 });
    expect(editor(container)).toBeNull();
    expect(session.cell(sheet, 0, 0).value).toBe(1);
    expect(session.getState().dirty).toBe(false);
    press(grid, "ArrowDown");
    expect(liveText(container)).toMatch(/^A2/);
    expect(cellElement(container, 1, 0)).not.toBeNull();
  });
});
