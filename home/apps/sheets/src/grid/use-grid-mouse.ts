/**
 * Mouse handling for the grid surface: selecting cells, rows and columns by
 * click and drag, pointing at cells from a formula, the fill handle, resizing
 * and auto-fitting headers, and opening the context menu.
 */

import { type MouseEvent as ReactMouseEvent, type RefObject, useEffect, useRef } from "react";
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
  timer: ReturnType<typeof setInterval> | null;
  stop(): void;
}

const AUTOSCROLL_MS = 60;

function modeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  return event.shiftKey ? "extend" : event.ctrlKey || event.metaKey ? "add" : "replace";
}

function datasetOf(target: EventTarget | null, name: string): DOMStringMap | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(`[data-${name}]`);
  return element === null ? null : element.dataset;
}

export interface GridMouse {
  onMouseDown(event: ReactMouseEvent<HTMLElement>): void;
  onDoubleClick(event: ReactMouseEvent<HTMLElement>): void;
  onContextMenu(event: ReactMouseEvent<HTMLElement>): void;
}

export function useGridMouse(ctx: GridContext, surface: RefObject<HTMLElement | null>, readOnly: boolean): GridMouse {
  const tracking = useRef<Tracking | null>(null);

  useEffect(
    () => () => {
      tracking.current?.stop();
      tracking.current = null;
    },
    [],
  );

  /** Pointer position relative to the top-left cell. */
  const locate = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = surface.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0) - ROW_HEADER_WIDTH_PX,
      y: event.clientY - (rect?.top ?? 0) - HEADER_HEIGHT_PX,
    };
  };

  /** The cell at a point; a point outside the cell area gives the cell one step beyond the edge, so that a drag keeps scrolling. */
  const cellFor = (x: number, y: number): CellAddress => {
    const layout = ctx.layout();
    const { width, height } = layout.viewportInput;
    const cell = cellAtPoint(layout.axes, layout.viewport, Math.min(Math.max(x, 0), Math.max(0, width - 1)), Math.min(Math.max(y, 0), Math.max(0, height - 1)));
    const lastRow = layout.axes.rows.count - 1;
    const lastCol = layout.axes.cols.count - 1;
    return {
      row: Math.min(lastRow, Math.max(0, cell.row + (y < 0 ? -1 : y >= height ? 1 : 0))),
      col: Math.min(lastCol, Math.max(0, cell.col + (x < 0 ? -1 : x >= width ? 1 : 0))),
    };
  };

  const apply = (current: Tracking): void => {
    const drag = current.drag;
    if (drag.kind === "resize") {
      const position = drag.axis === "col" ? current.x : current.y;
      const min = drag.axis === "col" ? MIN_COLUMN_PX : MIN_ROW_PX;
      ctx.store.set({ resizing: { axis: drag.axis, index: drag.index, size: Math.max(min, Math.round(drag.size + position - drag.origin)) } });
      return;
    }
    const cell = cellFor(current.x, current.y);
    if (drag.kind === "select") pickCell(ctx, cell, "extend");
    else if (drag.kind === "point") pointAt(ctx, cell, true);
    else if (drag.kind === "fill") dragFillTo(ctx, cell);
    else if (drag.kind === "rows") pickRow(ctx, cell.row, "extend");
    else pickColumn(ctx, cell.col, "extend");
  };

  const begin = (drag: Drag, x: number, y: number): void => {
    tracking.current?.stop();
    const view = surface.current?.ownerDocument.defaultView;
    if (view === null || view === undefined) return;
    const onMove = (event: MouseEvent): void => {
      const current = tracking.current;
      if (current === null) return;
      const point = locate(event);
      current.x = point.x;
      current.y = point.y;
      apply(current);
    };
    const onUp = (): void => {
      const current = tracking.current;
      tracking.current = null;
      current?.stop();
      if (current === null) return;
      if (current.drag.kind === "fill") endFillDrag(ctx);
      if (current.drag.kind === "resize") {
        const resizing = ctx.store.getState().resizing;
        ctx.store.set({ resizing: null });
        if (resizing !== null && resizing.size !== current.drag.size) {
          if (resizing.axis === "col") resizeColumn(ctx, resizing.index, resizing.size);
          else resizeRow(ctx, resizing.index, resizing.size);
        }
      }
    };
    const current: Tracking = {
      drag,
      x,
      y,
      timer: null,
      stop: () => {
        view.removeEventListener("mousemove", onMove, true);
        view.removeEventListener("mouseup", onUp, true);
        if (current.timer !== null) clearInterval(current.timer);
        current.timer = null;
      },
    };
    view.addEventListener("mousemove", onMove, true);
    view.addEventListener("mouseup", onUp, true);
    if (drag.kind !== "resize") {
      // Keeps a drag growing while the pointer rests outside the cell area.
      current.timer = setInterval(() => {
        const { width, height } = ctx.layout().viewportInput;
        if (current.x < 0 || current.y < 0 || current.x >= width || current.y >= height) apply(current);
      }, AUTOSCROLL_MS);
    }
    tracking.current = current;
  };

  /** Stores the cell being edited before the selection moves. False when the text was refused. */
  const settleEdit = (): boolean => ctx.store.getState().edit === null || commitEdit(ctx, null);

  const onMouseDown = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("textarea, input, [role='menu'], [role='listbox']") !== null) return;
    const point = locate(event);
    const focusGrid = (): void => surface.current?.focus({ preventScroll: true });
    if (ctx.store.getState().menu !== null) ctx.store.set({ menu: null });

    const grip = datasetOf(target, "resize");
    if (grip !== null) {
      event.preventDefault();
      if (readOnly) return;
      const axis = grip.resize === "row" ? "row" : "col";
      const index = Number(grip.index);
      const axes = ctx.layout().axes;
      begin({ kind: "resize", axis, index, origin: axis === "col" ? point.x : point.y, size: axis === "col" ? axes.cols.sizeOf(index) : axes.rows.sizeOf(index) }, point.x, point.y);
      return;
    }
    if (datasetOf(target, "fill-handle") !== null) {
      event.preventDefault();
      if (readOnly || !settleEdit()) return;
      beginFillDrag(ctx);
      begin({ kind: "fill" }, point.x, point.y);
      return;
    }
    const header = datasetOf(target, "header");
    if (header !== null) {
      event.preventDefault();
      if (!settleEdit()) return;
      focusGrid();
      if (header.header === "all") selectEverything(ctx);
      else if (header.header === "col") {
        pickColumn(ctx, Number(header.index), modeOf(event));
        begin({ kind: "cols" }, point.x, point.y);
      } else {
        pickRow(ctx, Number(header.index), modeOf(event));
        begin({ kind: "rows" }, point.x, point.y);
      }
      return;
    }
    if (point.x < 0 || point.y < 0) return;
    event.preventDefault();
    const cell = cellFor(point.x, point.y);
    if (ctx.store.getState().edit !== null) {
      if (canPoint(ctx) && pointAt(ctx, cell, false)) {
        // The focus stays in the editor: the formula is still being typed.
        begin({ kind: "point" }, point.x, point.y);
        return;
      }
      if (!settleEdit()) return;
    }
    focusGrid();
    pickCell(ctx, cell, modeOf(event));
    begin({ kind: "select" }, point.x, point.y);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (readOnly) return;
    const target = event.target;
    if (target instanceof Element && target.closest("textarea, input, [role='menu']") !== null) return;
    const grip = datasetOf(target, "resize");
    if (grip !== null) {
      if (grip.resize === "row") autoFitRow(ctx, Number(grip.index));
      else autoFitColumn(ctx, Number(grip.index));
      return;
    }
    if (datasetOf(target, "header") !== null || datasetOf(target, "fill-handle") !== null) return;
    const point = locate(event);
    if (point.x < 0 || point.y < 0 || ctx.store.getState().edit !== null) return;
    startEdit(ctx, null);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (target instanceof Element && target.closest("textarea, input") !== null) return;
    event.preventDefault();
    if (!settleEdit()) return;
    const rect = surface.current?.getBoundingClientRect();
    const point = locate(event);
    const header = datasetOf(target, "header");
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
    } else if (point.x >= 0 && point.y >= 0) {
      const cell = cellFor(point.x, point.y);
      if (!selectionContains(selection, cell.row, cell.col)) pickCell(ctx, cell, "replace");
    }
    surface.current?.focus({ preventScroll: true });
    ctx.store.set({ menu: { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0), area } });
  };

  return { onMouseDown, onDoubleClick, onContextMenu };
}
