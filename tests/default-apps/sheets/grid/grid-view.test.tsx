// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COL, HEAD_H, HEAD_W, ROW, at, cellElement, cellText, click, drag, editor, liveText, press, renderGrid } from "./harness";

afterEach(cleanup);

describe("SheetGrid view and selection", () => {
  it("is an aria grid with the active cell as its descendant and a live description", async () => {
    const { grid, container } = await renderGrid();
    expect(grid.getAttribute("aria-rowcount")).toBe("201");
    expect(grid.getAttribute("aria-colcount")).toBe("27");
    const active = container.ownerDocument.getElementById(grid.getAttribute("aria-activedescendant")!);
    expect(active?.getAttribute("role")).toBe("gridcell");
    expect(active?.dataset).toMatchObject({ row: "0", col: "0" });
    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.getAttribute("aria-colindex")).toBe("2");
    expect(active?.parentElement?.getAttribute("role")).toBe("row");
    expect(active?.parentElement?.getAttribute("aria-rowindex")).toBe("2");
    expect(liveText(container)).toBe("A1, 1");
    expect(container.querySelector(".sg-live")?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("[role='columnheader']")?.textContent).toBe("A");
    expect(container.querySelector("[role='rowheader']")?.textContent).toBe("1");

    press(grid, "ArrowRight");
    expect(liveText(container)).toBe("B1, 6, formula =SUM(A1:A3)");
  });

  it("moves with the keys a spreadsheet user expects", async () => {
    const { grid, container } = await renderGrid();
    const where = () => liveText(container).split(",")[0];
    press(grid, "ArrowDown");
    press(grid, "ArrowDown");
    expect(where()).toBe("A3");
    press(grid, "ArrowDown", { ctrlKey: true });
    expect(where()).toBe("A1048576");
    press(grid, "ArrowUp", { ctrlKey: true });
    expect(where()).toBe("A3");
    press(grid, "ArrowUp", { ctrlKey: true });
    expect(where()).toBe("A1");
    press(grid, "ArrowRight", { ctrlKey: true });
    expect(where()).toBe("C1");
    press(grid, "Tab");
    expect(where()).toBe("D1");
    press(grid, "Tab", { shiftKey: true });
    press(grid, "Enter");
    expect(where()).toBe("C2");
    press(grid, "Enter", { shiftKey: true });
    expect(where()).toBe("C1");
    press(grid, "End", { ctrlKey: true });
    expect(where()).toBe("C3");
    press(grid, "Home");
    expect(where()).toBe("A3");
    press(grid, "PageDown");
    expect(where()).toBe("A26");
    press(grid, "Home", { ctrlKey: true });
    expect(where()).toBe("A1");
  });

  it("extends with Shift, selects rows, columns and everything", async () => {
    const { grid, container, controller } = await renderGrid();
    press(grid, "ArrowDown", { shiftKey: true });
    press(grid, "ArrowRight", { shiftKey: true });
    expect(liveText(container)).toBe("A1, 1, 2 by 2 cells selected");
    expect(controller.getSelection().ranges).toEqual([{ start: { row: 0, col: 0 }, end: { row: 1, col: 1 }, kind: "cells" }]);
    expect(cellElement(container, 1, 0)?.getAttribute("aria-selected")).toBe("true");
    expect(cellElement(container, 2, 0)?.getAttribute("aria-selected")).toBe("false");

    // Column B has no data below B1: Ctrl+Shift+Down extends to the end of the sheet.
    press(grid, "ArrowDown", { shiftKey: true, ctrlKey: true });
    expect(controller.getSelection().ranges[0]).toMatchObject({ end: { row: 1_048_575, col: 1 } });

    press(grid, " ", { shiftKey: true });
    expect(controller.getSelection().ranges[0]?.kind).toBe("rows");
    press(grid, " ", { ctrlKey: true });
    expect(controller.getSelection().ranges[0]?.kind).toBe("cols");
    press(grid, "a", { ctrlKey: true });
    expect(controller.getSelection().ranges[0]?.kind).toBe("all");
    expect(liveText(container)).toContain("whole sheet selected");
    expect(controller.getActiveRange()).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
  });

  it("selects by click, shift-click, ctrl-click, drag and headers", async () => {
    const { grid, container, controller } = await renderGrid();
    const onChange = vi.fn();
    controller.onSelectionChange(onChange);
    click(grid, 2, 1);
    expect(liveText(container)).toMatch(/^B3/);
    click(grid, 4, 3, { shiftKey: true });
    expect(controller.getSelection().ranges).toEqual([{ start: { row: 2, col: 1 }, end: { row: 4, col: 3 }, kind: "cells" }]);
    click(grid, 7, 0, { ctrlKey: true });
    expect(controller.getSelection().ranges).toHaveLength(2);
    expect(controller.getSelection().active).toEqual({ row: 7, col: 0 });
    expect(container.querySelectorAll(".sg-selection")).toHaveLength(2);

    drag(grid, [1, 1], [3, 2]);
    expect(controller.getSelection().ranges).toEqual([{ start: { row: 1, col: 1 }, end: { row: 3, col: 2 }, kind: "cells" }]);
    expect(onChange).toHaveBeenCalled();

    const headers = [...container.querySelectorAll<HTMLElement>("[data-header='col']")];
    fireEvent.mouseDown(headers[2]!, { button: 0, clientX: HEAD_W + 2 * COL + 5, clientY: 5 });
    fireEvent.mouseUp(window);
    expect(controller.getSelection().ranges[0]).toMatchObject({ kind: "cols", start: { col: 2 }, end: { col: 2 } });
    expect(headers[2]!.className).toContain("is-selected");
    fireEvent.mouseDown(container.querySelector("[data-header='all']")!, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(window);
    expect(controller.getSelection().ranges[0]?.kind).toBe("all");
  });

  it("renders a bounded number of cells for a sheet of 100 000 rows by 500 columns and reaches any cell", async () => {
    const { grid, container, controller, session, sheet } = await renderGrid((workbook, id) => {
      const rows: number[][] = [];
      for (let r = 0; r < 300; r++) rows.push(Array.from({ length: 40 }, (_, c) => r * 40 + c));
      workbook.setRange(id, { row: 0, col: 0 }, rows);
      workbook.setCell(id, { row: 99_999, col: 499 }, "far corner");
      workbook.setCell(id, { row: 50_000, col: 250 }, "middle");
    });
    expect(grid.getAttribute("aria-rowcount")).toBe("100101");
    expect(grid.getAttribute("aria-colcount")).toBe("514");
    const drawn = container.querySelectorAll("[role='gridcell']").length;
    expect(drawn).toBeGreaterThan(200);
    expect(drawn).toBeLessThan(700);
    expect(cellElement(container, 50_000, 250)).toBeNull();

    act(() => controller.select({ row: 50_000, col: 250 }));
    expect(cellText(container, 50_000, 250)).toBe("middle");
    expect(cellElement(container, 0, 0)).toBeNull();
    expect(container.querySelectorAll("[role='gridcell']").length).toBeLessThan(700);
    expect(liveText(container)).toBe("IQ50001, middle");

    act(() => controller.scrollTo({ row: 99_999, col: 499 }));
    expect(cellText(container, 99_999, 499)).toBe("far corner");
    // Scrolling did not move the selection.
    expect(controller.getSelection().active).toEqual({ row: 50_000, col: 250 });
    expect(session.cell(sheet, 299, 39).value).toBe(11_999);
  });

  it("follows the scrollbar", async () => {
    const { container } = await renderGrid((workbook, id) => {
      workbook.setCell(id, { row: 150, col: 0 }, "deep");
    });
    const scroller = container.querySelector<HTMLElement>(".sg-scroller")!;
    expect(cellElement(container, 150, 0)).toBeNull();
    scroller.scrollTop = 150 * ROW;
    fireEvent.scroll(scroller);
    expect(cellText(container, 150, 0)).toBe("deep");
    expect([...container.querySelectorAll("[data-header='row']")].map((head) => head.textContent)).toContain("151");
  });

  it("keeps frozen rows and columns in place and draws merged cells once", async () => {
    const { container, controller } = await renderGrid((workbook, id) => {
      workbook.setRange(id, { row: 0, col: 0 }, [["Name", "Q1", "Q2"], ["North", 1, 2]]);
      workbook.setCell(id, { row: 4, col: 1 }, "merged title");
      workbook.mergeCells(id, { start: { row: 4, col: 1 }, end: { row: 5, col: 3 } });
      workbook.setFrozenPanes(id, { rows: 1, cols: 1 });
      workbook.setCell(id, { row: 120, col: 30 }, "x");
    });
    expect(container.querySelector(".sg-pane--corner [data-row='0'][data-col='0']")?.textContent).toBe("Name");
    expect(container.querySelector(".sg-pane--top [data-row='0'][data-col='1']")?.textContent).toBe("Q1");
    expect(container.querySelector(".sg-pane--left [data-row='1'][data-col='0']")?.textContent).toBe("North");
    const merged = cellElement(container, 4, 1)!;
    expect(merged.className).toContain("is-merged");
    expect(merged.style.width).toBe(`${3 * COL}px`);
    expect(merged.style.height).toBe(`${2 * ROW}px`);
    expect(cellElement(container, 5, 2)).toBeNull();

    act(() => controller.select({ row: 120, col: 30 }));
    expect(container.querySelector(".sg-pane--corner [data-row='0'][data-col='0']")?.textContent).toBe("Name");
    expect(container.querySelector(".sg-pane--left [data-row='120'][data-col='0']")).toBeNull();
    expect(container.querySelector(".sg-pane--main [data-row='120'][data-col='30']")?.textContent).toBe("x");
    expect(container.querySelector(".sg-freeze--h")).not.toBeNull();

    act(() => controller.select({ row: 5, col: 2 }));
    expect(controller.getSelection().active).toEqual({ row: 4, col: 1 });
  });

  it("shows styles, number formats, errors and text running over empty neighbours", async () => {
    const { container } = await renderGrid((workbook, id) => {
      workbook.setCell(id, { row: 0, col: 0 }, 0.256);
      workbook.setStyle(id, { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, { numberFormat: "0.0%", font: { bold: true }, fill: { color: "#ffee00" } });
      workbook.setFormula(id, { row: 1, col: 0 }, "1/0");
      workbook.setCell(id, { row: 2, col: 0 }, "a long text that does not fit its column");
      workbook.setCell(id, { row: 3, col: 0 }, "blocked by a neighbour that holds a value");
      workbook.setCell(id, { row: 3, col: 1 }, 7);
      workbook.setCell(id, { row: 4, col: 0 }, 1234567890123);
      workbook.setStyle(id, { start: { row: 4, col: 0 }, end: { row: 4, col: 0 } }, { numberFormat: "#,##0.00" });
    });
    const styled = cellElement(container, 0, 0)!;
    expect(styled.textContent).toBe("25.6%");
    expect(styled.style.fontWeight).toBe("700");
    expect(styled.style.backgroundColor).toBe("rgb(255, 238, 0)");
    expect(styled.style.justifyContent).toBe("flex-end");

    const error = cellElement(container, 1, 0)!;
    expect(error.textContent).toBe("#DIV/0!");
    expect(error.className).toContain("is-error");
    expect(error.getAttribute("title")).toBe("Division by zero.");

    const overflowing = cellElement(container, 2, 0)!;
    expect(overflowing.className).toContain("is-overflow");
    expect(Number.parseInt(overflowing.style.width, 10)).toBeGreaterThan(COL);
    expect(cellElement(container, 3, 0)!.style.width).toBe(`${COL}px`);
    expect(cellElement(container, 4, 0)!.textContent).toBe("####");
  });

  it("resizes a column by dragging its edge and fits it on a double click", async () => {
    const { session, sheet, container } = await renderGrid((workbook, id) => {
      workbook.setCell(id, { row: 0, col: 1 }, "a fairly long heading in column B");
    });
    const grip = container.querySelector<HTMLElement>("[data-resize='col'][data-index='0']")!;
    fireEvent.mouseDown(grip, { button: 0, clientX: HEAD_W + COL, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: HEAD_W + COL + 40, clientY: 10 });
    expect(container.querySelector<HTMLElement>("[data-header='col'][data-index='0']")!.style.width).toBe(`${COL + 40}px`);
    fireEvent.mouseUp(window, { clientX: HEAD_W + COL + 40, clientY: 10 });
    expect(session.sheet(sheet).columns).toEqual([{ index: 0, width: expect.closeTo(14.14, 1), hidden: false }]);
    expect(session.getState().undoLabel).toBe("Column width");

    fireEvent.doubleClick(container.querySelector("[data-resize='col'][data-index='1']")!);
    const fitted = session.sheet(sheet).columns.find((column) => column.index === 1)!;
    expect(fitted.width).toBeGreaterThan(20);
    fireEvent.doubleClick(container.querySelector("[data-resize='row'][data-index='0']")!);
    expect(session.sheet(sheet).rows).toEqual([]);
  });

  it("inserts, deletes, sorts and filters from the context menu", async () => {
    const { session, sheet, grid, container, controller } = await renderGrid((workbook, id) => {
      workbook.setRange(id, { row: 0, col: 0 }, [["Fruit", "Qty"], ["Pear", 3], ["Apple", 9], ["Pear", 1]]);
    });
    const open = (row: number, col: number) => fireEvent.contextMenu(grid, at(row, col));
    const pick = (label: string) => fireEvent.click([...container.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent === label)!);

    open(1, 0);
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    pick("Insert rows above");
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(session.cell(sheet, 1, 0).value).toBeNull();
    expect(session.cell(sheet, 2, 0).value).toBe("Pear");
    open(1, 0);
    pick("Delete rows");
    expect(session.cell(sheet, 1, 0).value).toBe("Pear");

    open(2, 1);
    pick("Sort A to Z");
    expect([1, 2, 3].map((row) => [session.cell(sheet, row, 0).value, session.cell(sheet, row, 1).value])).toEqual([["Pear", 1], ["Pear", 3], ["Apple", 9]]);
    expect(session.cell(sheet, 0, 0).value).toBe("Fruit");
    expect(session.getState().undoLabel).toBe("Sort");

    open(1, 0);
    pick("Filter by this value");
    expect(controller.isFiltered).toBe(true);
    expect([...container.querySelectorAll("[data-header='row']")].slice(0, 4).map((head) => head.textContent)).toEqual(["1", "2", "3", "5"]);
    expect(cellElement(container, 3, 0)).toBeNull();
    expect(session.getState().undoLabel).toBe("Sort");
    open(1, 0);
    pick("Clear filter");
    expect(cellText(container, 3, 0)).toBe("Apple");

    open(0, 1);
    pick("Insert columns left");
    expect(session.cell(sheet, 0, 2).value).toBe("Qty");
    open(0, 1);
    fireEvent.keyDown(container.querySelector("[role='menu']")!, { key: "Escape" });
    expect(container.querySelector("[role='menu']")).toBeNull();
  });

  it("marks cells for review, tracing and search through the controller", async () => {
    const { session, sheet, grid, container, controller } = await renderGrid();
    act(() => {
      controller.decorate("review", [{ sheet, row: 0, col: 0, kind: "proposed", oldValue: "1", newValue: "5", changeId: "change-7", label: "Agent" }]);
      controller.decorate("trace", [
        { sheet, row: 1, col: 0, kind: "precedent" },
        { sheet, row: 6, col: 6, kind: "search-active" },
      ]);
    });
    const proposed = cellElement(container, 0, 0)!;
    expect(proposed.className).toContain("is-proposed");
    expect(proposed.dataset.changeId).toBe("change-7");
    expect(proposed.getAttribute("title")).toBe("Proposed change: was 1, now 5 (Agent)");
    expect(liveText(container)).toBe("A1, 1, Proposed change: was 1, now 5 (Agent)");
    expect(cellElement(container, 1, 0)!.className).toContain("is-precedent");
    // An empty cell is drawn when it carries a mark.
    expect(cellElement(container, 6, 6)!.className).toContain("is-search-active");

    act(() => controller.clearDecorations("trace"));
    expect(cellElement(container, 6, 6)).toBeNull();
    expect(cellElement(container, 0, 0)!.className).toContain("is-proposed");
    act(() => controller.clearDecorations());
    expect(cellElement(container, 0, 0)!.className).not.toContain("is-proposed");

    // A pending change in the engine's journal is tinted without any decoration.
    act(() => {
      session.mutate((workbook) => {
        workbook.beginProposal({ author: "agent", date: "2026-11-20T10:00:00Z", label: "Raise" });
        workbook.setCell(sheet, { row: 2, col: 0 }, 30);
        workbook.endProposal();
      });
    });
    const pending = cellElement(container, 2, 0)!;
    expect(pending.className).toContain("is-pending");
    expect(pending.dataset.changeId).toBe(session.cell(sheet, 2, 0).pendingChangeId);
    expect(cellText(container, 0, 1)).toBe("33");
    press(grid, "ArrowDown");
    press(grid, "ArrowDown");
    expect(liveText(container)).toBe("A3, 30, Proposed change");
  });

  it("drives cells, formats and structure through the controller", async () => {
    const { session, sheet, container, controller } = await renderGrid();
    act(() => {
      expect(controller.setCell({ row: 0, col: 0 }, "=10*2")).toEqual({ ok: true });
      expect(controller.applyEdits([{ sheet, row: 5, col: 0, input: "x" }, { sheet, row: 5, col: 1, value: 4, style: { font: { bold: true } } }], "Agent edit")).toEqual({ ok: true });
    });
    expect(cellText(container, 0, 1)).toBe("25");
    expect(session.getState().undoLabel).toBe("Agent edit");
    expect(cellElement(container, 5, 1)!.style.fontWeight).toBe("700");

    act(() => {
      controller.select({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } });
      controller.toggleMerge();
    });
    expect(session.sheet(sheet).mergedRanges).toHaveLength(1);
    act(() => controller.toggleMerge());
    expect(session.sheet(sheet).mergedRanges).toHaveLength(0);

    act(() => {
      controller.select({ row: 1, col: 1 });
      controller.toggleFreeze();
    });
    expect(session.sheet(sheet).frozen).toEqual({ rows: 1, cols: 1 });
    act(() => controller.toggleFreeze());
    expect(session.sheet(sheet).frozen).toEqual({ rows: 0, cols: 0 });

    act(() => {
      controller.startEdit("typed");
    });
    expect(editor(container)!.value).toBe("typed");
    expect(controller.isEditing).toBe(true);
    act(() => {
      expect(controller.commitEdit()).toBe(true);
    });
    expect(session.cell(sheet, 1, 1).value).toBe("typed");
    expect(controller.copy()).toMatchObject({ text: "typed" });
  });

  it("switches sheets with the session and remembers each sheet's selection", async () => {
    const { session, grid, container } = await renderGrid();
    click(grid, 2, 0);
    let second = "";
    act(() => {
      second = session.addSheet("Other").sheet as string;
    });
    expect(liveText(container)).toBe("A1, empty");
    expect(cellElement(container, 2, 0)).toBeNull();
    press(grid, "x");
    press(editor(container)!, "Enter");
    expect(session.cell(second, 0, 0).value).toBe("x");
    act(() => session.setActiveSheet(session.sheets()[0]!.id));
    expect(liveText(container)).toBe("A3, 3");
  });

  it("leaves its session listeners when it unmounts", async () => {
    const { session, sheet, unmount, controller } = await renderGrid();
    unmount();
    controller.dispose();
    expect(() => session.setCellInput(sheet, { row: 0, col: 0 }, "5")).not.toThrow();
    expect(HEAD_H).toBe(24);
  });
});
