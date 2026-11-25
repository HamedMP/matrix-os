/**
 * Decorations: marks other parts of the app put on cells.
 *
 * A decoration names a cell and a state. The grid draws it and adds it to
 * the cell's description for screen readers. Decorations live in named
 * layers; setting a layer replaces what it held, so each feature (review,
 * formula tracing, search) owns one layer and never disturbs the others.
 */

import type { SheetId } from "../session/engine";

export type DecorationKind =
  /** A proposed change waiting for review. Give `oldValue` and `newValue` as display text. */
  | "proposed"
  /** A cell the formula of the inspected cell reads. */
  | "precedent"
  /** A cell whose formula reads the inspected cell. */
  | "dependent"
  /** A search result. */
  | "search"
  /** The search result the owner is on. */
  | "search-active";

export interface CellDecoration {
  sheet: SheetId;
  row: number;
  col: number;
  kind: DecorationKind;
  /** For `proposed`: what the cell showed before and shows now. */
  oldValue?: string;
  newValue?: string;
  /** For `proposed`: the id of the change, passed back when the owner picks the cell. */
  changeId?: string;
  /** Extra words for the tooltip and for screen readers, such as who proposed it. */
  label?: string;
}

/** Most layers kept and most decorations per layer; more are dropped. */
export const MAX_DECORATION_LAYERS = 16;
export const MAX_DECORATIONS_PER_LAYER = 100_000;

function keyOf(sheet: SheetId, row: number, col: number): string {
  return `${sheet}|${row}|${col}`;
}

export class DecorationStore {
  private readonly layers = new Map<string, Map<string, CellDecoration>>();
  private current = 0;

  /** Grows on every change; the grid redraws when it differs. */
  get version(): number {
    return this.current;
  }

  /** Replaces the decorations of a layer. An empty list removes the layer. */
  set(layer: string, decorations: readonly CellDecoration[]): void {
    if (decorations.length === 0) {
      if (this.layers.delete(layer)) this.current++;
      return;
    }
    if (!this.layers.has(layer) && this.layers.size >= MAX_DECORATION_LAYERS) {
      const oldest = this.layers.keys().next().value;
      if (oldest !== undefined) this.layers.delete(oldest);
    }
    const cells = new Map<string, CellDecoration>();
    for (const decoration of decorations) {
      if (cells.size >= MAX_DECORATIONS_PER_LAYER) break;
      cells.set(keyOf(decoration.sheet, decoration.row, decoration.col), decoration);
    }
    this.layers.set(layer, cells);
    this.current++;
  }

  /** Removes one layer, or all of them. */
  clear(layer?: string): void {
    if (layer === undefined) {
      if (this.layers.size === 0) return;
      this.layers.clear();
      this.current++;
    } else if (this.layers.delete(layer)) {
      this.current++;
    }
  }

  /** The decorations on a cell, one per layer at most, in layer order. */
  at(sheet: SheetId, row: number, col: number): CellDecoration[] {
    if (this.layers.size === 0) return NONE;
    const key = keyOf(sheet, row, col);
    let found: CellDecoration[] | null = null;
    for (const cells of this.layers.values()) {
      const decoration = cells.get(key);
      if (decoration !== undefined) (found ??= []).push(decoration);
    }
    return found ?? NONE;
  }

  get(layer: string): CellDecoration[] {
    return [...(this.layers.get(layer)?.values() ?? [])];
  }

  /** Every decorated cell of a sheet inside a block of rows and columns. */
  within(sheet: SheetId, rowStart: number, rowEnd: number, colStart: number, colEnd: number): CellDecoration[] {
    const out: CellDecoration[] = [];
    for (const cells of this.layers.values()) {
      for (const decoration of cells.values()) {
        if (
          decoration.sheet === sheet &&
          decoration.row >= rowStart &&
          decoration.row <= rowEnd &&
          decoration.col >= colStart &&
          decoration.col <= colEnd
        ) {
          out.push(decoration);
        }
      }
    }
    return out;
  }
}

const NONE: CellDecoration[] = [];

const WORDS: Record<DecorationKind, string> = {
  proposed: "Proposed change",
  precedent: "Read by the formula",
  dependent: "Depends on the cell",
  search: "Search result",
  "search-active": "Current search result",
};

/** What a decoration says in a tooltip and to a screen reader. */
export function describeDecoration(decoration: CellDecoration): string {
  let text = WORDS[decoration.kind];
  if (decoration.kind === "proposed" && (decoration.oldValue !== undefined || decoration.newValue !== undefined)) {
    const was = decoration.oldValue === undefined || decoration.oldValue === "" ? "empty" : decoration.oldValue;
    const now = decoration.newValue === undefined || decoration.newValue === "" ? "empty" : decoration.newValue;
    text += `: was ${was}, now ${now}`;
  }
  return decoration.label === undefined || decoration.label === "" ? text : `${text} (${decoration.label})`;
}
