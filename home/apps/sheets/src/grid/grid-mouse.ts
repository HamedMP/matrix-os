/**
 * Mouse handling for the grid surface: selecting cells, rows and columns by
 * click and drag, pointing at cells from a formula, the fill handle, resizing
 * and auto-fitting headers, and opening the context menu.
 *
 * One instance belongs to one grid. While a button is held it listens on the
 * window, so a drag keeps working outside the grid; `dispose` drops those
 * listeners and the auto-scroll timer.
 */

import type { CellAddress } from "../session/engine";
import { autoFitColumn, autoFitRow, beginFillDrag, dragFillTo, endFillDrag, resizeColumn, resizeRow } from "./actions-data";
import { canPoint, commitEdit, pointAt, startEdit } from "./actions-edit";
import { pickCell, pickColumn, pickRow, selectEverything } from "./actions-move";
import type { GridContext } from "./context";
import { HEADER_HEIGHT_PX, MIN_COLUMN_PX, MIN_ROW_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { type SelectMode, selectionContains } from "./selection";
import { cellAtPoint } from "./viewport";

type Drag =
  | { kind: "select" | "point" | "fill" | "rows" | "cols" }
  | { kind: "resize"; axis: "row" | "col"; index: number; origin: number; size: number };

interface Tracking {
  drag: Drag;
  /** Last pointer position relative to the cell area. */
  x: number;
  y: number;
  stop(): void;
}

/** The fields of a mouse event the grid reads; React's and the DOM's events both fit. */
export interface GridMouseEvent {
  button: number;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

const AUTOSCROLL_MS = 60;
const OWN_CONTROLS = "textarea, input, [role='menu'], [role='listbox']";

function modeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  return event.shiftKey ? "extend" : event.ctrlKey || event.metaKey ? "add" : "replace";
}

function datasetOf(target: EventTarget | null, name: string): DOMStringMap | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(`[data-${name}]`);
  return element === null ? null : element.dataset;
}

function inOwnControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_CONTROLS) !== null;
}

export class GridMouse {
  private tracking: Tracking | null = null;

  constructor(
    private readonly ctx: GridContext,
    private readonly surface: () => HTMLElement | null,
  ) {}

  dispose(): void {
    this.tracking?.stop();
    this.tracking = null;
  }

  /** Pointer position relative to the top-left cell. */
  private locate(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.surface()?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0) - ROW_HEADER_WIDTH_PX,
      y: event.clientY - (rect?.top ?? 0) - HEADER_HEIGHT_PX,
    };
  }

  /** The cell at a point; a point outside the cell area gives the cell one step beyond the edge, so that a drag keeps scrolling. */
  private cellFor(x: number, y: number): CellAddress {
    const layout = this.ctx.layout();
    const { width, height } = layout.viewportInput;
    const inside = cellAtPoint(layout.axes, layout.viewport, Math.min(Math.max(x, 0), Math.max(0, width - 1)), Math.min(Math.max(y, 0), Math.max(0, height - 1)));
    return {
      row: Math.min(layout.axes.rows.count - 1, Math.max(0, inside.row + (y < 0 ? -1 : y >= height ? 1 : 0))),
      col: Math.min(layout.axes.cols.count - 1, Math.max(0, inside.col + (x < 0 ? -1 : x >= width ? 1 : 0))),
    };
  }

  private apply(current: Tracking): void {
    const ctx = this.ctx;
    const drag = current.drag;
    if (drag.kind === "resize") {
      const position = drag.axis === "col" ? current.x : current.y;
      const min = drag.axis === "col" ? MIN_COLUMN_PX : MIN_ROW_PX;
      ctx.store.set({ resizing: { axis: drag.axis, index: drag.index, size: Math.max(min, Math.round(drag.size + position - drag.origin)) } });
      return;
    }
    const cell = this.cellFor(current.x, current.y);
    if (drag.kind === "select") pickCell(ctx, cell, "extend");
    else if (drag.kind === "point") pointAt(ctx, cell, true);
    else if (drag.kind === "fill") dragFillTo(ctx, cell);
    else if (drag.kind === "rows") pickRow(ctx, cell.row, "extend");
    else pickColumn(ctx, cell.col, "extend");
  }

  private finish(current: Tracking): void {
    const ctx = this.ctx;
    if (current.drag.kind === "fill") endFillDrag(ctx);
    if (current.drag.kind !== "resize") return;
    const resizing = ctx.store.getState().resizing;
    ctx.store.set({ resizing: null });
    if (resizing === null || resizing.size === current.drag.size) return;
    if (resizing.axis === "col") resizeColumn(ctx, resizing.index, resizing.size);
    else resizeRow(ctx, resizing.index, resizing.size);
  }

  private begin(drag: Drag, x: number, y: number): void {
    this.tracking?.stop();
    const view = this.surface()?.ownerDocument.defaultView;
    if (view === null || view === undefined) return;
    const onMove = (event: MouseEvent): void => {
      const current = this.tracking;
      if (current === null) return;
      const point = this.locate(event);
      current.x = point.x;
      current.y = point.y;
      this.apply(current);
    };
    const onUp = (): void => {
      const current = this.tracking;
      this.tracking = null;
      if (current === null) return;
      current.stop();
      this.finish(current);
    };
    // Keeps a drag growing while the pointer rests outside the cell area.
    const timer =
      drag.kind === "resize"
        ? null
        : setInterval(() => {
            const current = this.tracking;
            if (current === null) return;
            const { width, height } = this.ctx.layout().viewportInput;
            if (current.x < 0 || current.y < 0 || current.x >= width || current.y >= height) this.apply(current);
          }, AUTOSCROLL_MS);
    view.addEventListener("mousemove", onMove, true);
    view.addEventListener("mouseup", onUp, true);
    this.tracking = {
      drag,
      x,
      y,
      stop: () => {
        view.removeEventListener("mousemove", onMove, true);
        view.removeEventListener("mouseup", onUp, true);
        if (timer !== null) clearInterval(timer);
      },
    };
  }

  /** Stores the cell being edited before the selection moves. False when the text was refused. */
  private settleEdit(): boolean {
    return this.ctx.store.getState().edit === null || commitEdit(this.ctx, null);
  }

  private focusGrid(): void {
    this.surface()?.focus({ preventScroll: true });
  }

  private downOnHeader(event: GridMouseEvent, header: DOMStringMap, x: number, y: number): void {
    const ctx = this.ctx;
    event.preventDefault();
    if (!this.settleEdit()) return;
    this.focusGrid();
    if (header.header === "all") {
      selectEverything(ctx);
    } else if (header.header === "col") {
      pickColumn(ctx, Number(header.index), modeOf(event));
      this.begin({ kind: "cols" }, x, y);
    } else {
      pickRow(ctx, Number(header.index), modeOf(event));
      this.begin({ kind: "rows" }, x, y);
    }
  }

  private downOnCell(event: GridMouseEvent, x: number, y: number): void {
    const ctx = this.ctx;
    event.preventDefault();
    const cell = this.cellFor(x, y);
    if (ctx.store.getState().edit !== null) {
      if (canPoint(ctx) && pointAt(ctx, cell, false)) {
        // The focus stays in the editor: the formula is still being typed.
        this.begin({ kind: "point" }, x, y);
        return;
      }
      if (!this.settleEdit()) return;
    }
    this.focusGrid();
    pickCell(ctx, cell, modeOf(event));
    this.begin({ kind: "select" }, x, y);
  }

  down(event: GridMouseEvent, readOnly: boolean): void {
    if (event.button !== 0 || inOwnControl(event.target)) return;
    const ctx = this.ctx;
    const { x, y } = this.locate(event);
    if (ctx.store.getState().menu !== null) ctx.store.set({ menu: null });
    const grip = datasetOf(event.target, "resize");
    if (grip !== null) {
      event.preventDefault();
      if (readOnly) return;
      const axis = grip.resize === "row" ? "row" : "col";
      const index = Number(grip.index);
      const axes = ctx.layout().axes;
      const size = axis === "col" ? axes.cols.sizeOf(index) : axes.rows.sizeOf(index);
      this.begin({ kind: "resize", axis, index, origin: axis === "col" ? x : y, size }, x, y);
      return;
    }
    if (datasetOf(event.target, "fill-handle") !== null) {
      event.preventDefault();
      if (readOnly || !this.settleEdit()) return;
      beginFillDrag(ctx);
      this.begin({ kind: "fill" }, x, y);
      return;
    }
    const header = datasetOf(event.target, "header");
    if (header !== null) this.downOnHeader(event, header, x, y);
    else if (x >= 0 && y >= 0) this.downOnCell(event, x, y);
  }

  doubleClick(event: GridMouseEvent, readOnly: boolean): void {
    if (readOnly || inOwnControl(event.target)) return;
    const ctx = this.ctx;
    const grip = datasetOf(event.target, "resize");
    if (grip !== null) {
      if (grip.resize === "row") autoFitRow(ctx, Number(grip.index));
      else autoFitColumn(ctx, Number(grip.index));
      return;
    }
    if (datasetOf(event.target, "header") !== null || datasetOf(event.target, "fill-handle") !== null) return;
    const { x, y } = this.locate(event);
    if (x < 0 || y < 0 || ctx.store.getState().edit !== null) return;
    startEdit(ctx, null);
  }

  contextMenu(event: GridMouseEvent): void {
    if (event.target instanceof Element && event.target.closest("textarea, input") !== null) return;
    event.preventDefault();
    if (!this.settleEdit()) return;
    const ctx = this.ctx;
    const rect = this.surface()?.getBoundingClientRect();
    const { x, y } = this.locate(event);
    const header = datasetOf(event.target, "header");
    const selection = ctx.selection;
    let area: "cells" | "rows" | "cols" = "cells";
    if (header !== null && header.header === "row") {
      area = "rows";
      const row = Number(header.index);
      if (!selection.ranges.some((range) => range.kind === "rows" && row >= range.start.row && row <= range.end.row)) pickRow(ctx, row, "replace");
    } else if (header !== null && header.header === "col") {
      area = "cols";
      const col = Number(header.index);
      if (!selection.ranges.some((range) => range.kind === "cols" && col >= range.start.col && col <= range.end.col)) pickColumn(ctx, col, "replace");
    } else if (x >= 0 && y >= 0) {
      const cell = this.cellFor(x, y);
      if (!selectionContains(selection, cell.row, cell.col)) pickCell(ctx, cell, "replace");
    }
    this.focusGrid();
    ctx.store.set({ menu: { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0), area } });
  }
}
