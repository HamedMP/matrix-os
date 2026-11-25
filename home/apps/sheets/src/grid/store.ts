/**
 * The grid's own state: what is selected, how far each sheet is scrolled,
 * the text being edited, and the short-lived things around it (fill drag,
 * copy marker, context menu, a column being resized).
 *
 * It is a small external store: `getState()` returns an immutable snapshot
 * that is replaced on every change, so React can subscribe to it with
 * `useSyncExternalStore`. Nothing here touches the workbook.
 */

import type { CellAddress, CellRange, SheetId } from "../session/engine";
import type { FillDirection } from "./fill";
import { type Selection, selectCell } from "./selection";
import type { FilterSpec } from "./sort-filter";

export interface FilterView {
  spec: FilterSpec;
  /** Rows the filter hides, ascending. */
  hidden: number[];
}

/** What the grid remembers per sheet. */
export interface SheetView {
  selection: Selection;
  scrollTop: number;
  scrollLeft: number;
  filter: FilterView | null;
}

/** A reference a formula is pointing at with the mouse or the arrow keys. */
export interface Pointing {
  /** Offsets of the reference text in the edited text, end exclusive. */
  start: number;
  end: number;
  sheet: SheetId;
  anchor: CellAddress;
  focus: CellAddress;
}

export interface EditState {
  /** The cell that will receive the text. */
  sheet: SheetId;
  cell: CellAddress;
  text: string;
  /** The text the edit started with; committing it unchanged writes nothing. */
  initial: string;
  selectionStart: number;
  selectionEnd: number;
  /** `enter`: started by typing, arrows leave the cell. `edit`: arrows move the caret. */
  mode: "enter" | "edit";
  /** Which input has the caret. */
  target: "cell" | "bar";
  pointing: Pointing | null;
  /** Highlighted entry of the function list. */
  completionIndex: number;
  /** True once the owner moved through the list with the arrows. */
  completionChosen: boolean;
  /** True after Escape closed the list; typing shows it again. */
  completionHidden: boolean;
  /** Why the last commit failed, to show beside the editor. */
  error: string | null;
}

export interface FillDrag {
  source: CellRange;
  target: CellRange | null;
  direction: FillDirection | null;
}

export interface CopyMark {
  sheet: SheetId;
  range: CellRange;
  cut: boolean;
}

export interface MenuState {
  /** Position inside the grid, in pixels. */
  x: number;
  y: number;
  area: "cells" | "rows" | "cols";
}

export interface ResizeState {
  axis: "row" | "col";
  index: number;
  /** Size in pixels while dragging. */
  size: number;
}

export interface GridState {
  views: Record<SheetId, SheetView>;
  edit: EditState | null;
  fill: FillDrag | null;
  copy: CopyMark | null;
  menu: MenuState | null;
  resizing: ResizeState | null;
  /** Size of the cell area in pixels. */
  width: number;
  height: number;
  /** Grows when decorations change. */
  decorations: number;
  /** A short notice for the owner (an edit that was refused); also read out by screen readers. */
  notice: string | null;
}

/** Most sheets whose view is remembered; a workbook holds far fewer. */
const MAX_VIEWS = 512;
const MAX_LISTENERS = 64;

export const DEFAULT_GRID_WIDTH = 960;
export const DEFAULT_GRID_HEIGHT = 480;

export function defaultView(): SheetView {
  return { selection: selectCell({ row: 0, col: 0 }), scrollTop: 0, scrollLeft: 0, filter: null };
}

export class GridStore {
  private state: GridState = {
    views: {},
    edit: null,
    fill: null,
    copy: null,
    menu: null,
    resizing: null,
    width: DEFAULT_GRID_WIDTH,
    height: DEFAULT_GRID_HEIGHT,
    decorations: 0,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();

  getState = (): GridState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("too many grid listeners");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the fields given. Does nothing when none of them differs. */
  set(patch: Partial<GridState>): void {
    const current = this.state as unknown as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) if (current[key] !== value) changed = true;
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** The view of a sheet; a sheet seen for the first time starts at A1. */
  view(sheet: SheetId): SheetView {
    return this.state.views[sheet] ?? DEFAULT_VIEW;
  }

  setView(sheet: SheetId, patch: Partial<SheetView>): void {
    const current = this.view(sheet);
    const entries = Object.entries(patch) as Array<[keyof SheetView, unknown]>;
    if (this.state.views[sheet] !== undefined && entries.every(([key, value]) => current[key] === value)) return;
    const views = { ...this.state.views, [sheet]: { ...current, ...patch } };
    const ids = Object.keys(views);
    // Views of sheets that are gone pile up only in pathological sessions; drop the oldest.
    if (ids.length > MAX_VIEWS) delete views[ids[0] as string];
    this.set({ views });
  }

  /** Forgets the views of sheets that no longer exist. */
  retain(sheets: readonly SheetId[]): void {
    const keep = new Set(sheets);
    const ids = Object.keys(this.state.views);
    if (ids.every((id) => keep.has(id))) return;
    const views: Record<SheetId, SheetView> = {};
    for (const id of ids) if (keep.has(id)) views[id] = this.state.views[id] as SheetView;
    this.set({ views });
  }
}

const DEFAULT_VIEW: SheetView = defaultView();
