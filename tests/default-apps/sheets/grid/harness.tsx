import { act, fireEvent, render } from "@testing-library/react";
import React from "react";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { SheetGrid, type SheetGridController, type SheetGridProps, createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "../../../../home/apps/sheets/src/grid/geometry";
import { type SheetSession, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness } from "../session/fakes";

/** Default column width and row height of a new workbook, and the header sizes, in pixels. */
export const COL = 64;
export const ROW = 20;
export const HEAD_W = ROW_HEADER_WIDTH_PX;
export const HEAD_H = HEADER_HEIGHT_PX;

export interface GridHarness {
  session: SheetSession;
  sheet: string;
  controller: SheetGridController;
  grid: HTMLElement;
  container: HTMLElement;
  unmount(): void;
}

/**
 * Renders the grid over a workbook built by `build`. The default workbook is
 * A1..A3 = 1, 2, 3; B1 = SUM(A1:A3); C1 = "note".
 */
export async function renderGrid(build?: (workbook: Workbook, sheet: string) => void, props: Partial<SheetGridProps> = {}): Promise<GridHarness> {
  const h = harness();
  const workbook = createXlsx();
  const first = workbook.listSheets()[0]!.id;
  if (build === undefined) {
    workbook.setRange(first, { row: 0, col: 0 }, [[1], [2], [3]]);
    workbook.setFormula(first, { row: 0, col: 1 }, "SUM(A1:A3)");
    workbook.setCell(first, { row: 0, col: 2 }, "note");
  } else {
    build(workbook, first);
  }
  workbook.recalc();
  h.files.put("Book.xlsx", await workbook.save());
  const session = await openSheetSession({ ...h.deps, autosaveDelayMs: 60_000 }, "Book.xlsx");
  session.setAutosave(false);
  const controller = createSheetGridController(session);
  const view = render(<SheetGrid session={session} controller={controller} {...props} />);
  const grid = view.container.querySelector<HTMLElement>("[role='grid']")!;
  act(() => grid.focus());
  return { session, sheet: session.getState().activeSheetId, controller, grid, container: view.container, unmount: view.unmount };
}

/** Client coordinates of the middle of a cell, for mouse events. */
export function at(row: number, col: number): { clientX: number; clientY: number } {
  return { clientX: HEAD_W + col * COL + COL / 2, clientY: HEAD_H + row * ROW + ROW / 2 };
}

export function press(target: Element, key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}): void {
  fireEvent.keyDown(target, { key, ...modifiers });
}

/** The in-cell editor, or null when no cell is being edited. */
export function editor(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea");
}

export function formulaBar(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(".sg-input--bar textarea")!;
}

/** Replaces the editor's text as typing does, with the caret at the end. */
export function type(input: HTMLTextAreaElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
}

export function cellElement(container: HTMLElement, row: number, col: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[role='gridcell'][data-row='${row}'][data-col='${col}']`);
}

export function cellText(container: HTMLElement, row: number, col: number): string {
  return cellElement(container, row, col)?.textContent ?? "";
}

export function liveText(container: HTMLElement): string {
  return container.querySelector(".sg-live")?.textContent ?? "";
}

export function click(grid: HTMLElement, row: number, col: number, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}): void {
  fireEvent.mouseDown(grid, { button: 0, ...at(row, col), ...modifiers });
  fireEvent.mouseUp(grid.ownerDocument.defaultView!, at(row, col));
}

export function drag(grid: HTMLElement, from: [number, number], to: [number, number], start?: Element): void {
  fireEvent.mouseDown(start ?? grid, { button: 0, ...at(from[0], from[1]) });
  fireEvent.mouseMove(grid.ownerDocument.defaultView!, at(to[0], to[1]));
  fireEvent.mouseUp(grid.ownerDocument.defaultView!, at(to[0], to[1]));
}
