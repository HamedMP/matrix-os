/** Types and constants of the dependency graph. See `graph.ts`. */

import type { FormulaError, FunctionRegistry, NameResolution, RangeBounds } from "../../../api/formula.js";
import { makeError } from "../coerce.js";

/** The value of a cell that is part of a circular reference. */
export const CIRCULAR_REFERENCE: FormulaError = Object.freeze(makeError("#REF!", "circular reference"));

/** The most formula cells one graph tracks. */
export const MAX_GRAPH_FORMULAS = 4_000_000;
/** The most sheets one graph keeps an index for: sheets with formulas or with cells a formula reads. */
export const MAX_GRAPH_SHEETS = 16_384;
/** The most value cells held as out of date; past it every formula is taken as out of date instead. */
export const MAX_GRAPH_DIRTY_CELLS = 65_536;

export interface CellRef {
  sheet: string;
  row: number;
  col: number;
}

export type Precedent =
  | ({ kind: "cell" } & CellRef)
  | { kind: "range"; bounds: RangeBounds }
  | { kind: "name"; name: string };

export interface GraphOptions {
  /** Finds the volatile functions. Without it no formula is volatile. */
  functions?: FunctionRegistry;
  /**
   * Resolves a defined name as seen from a sheet. The references of the
   * name's formula become precedents of the formulas that use the name.
   * Without it a name is a precedent on its own (see `markNameDirty`).
   */
  resolveName?: (name: string, sheet: string) => NameResolution | null;
  /** Sheet names in workbook order, for references across a span of sheets. Without it such a formula is recalculated on every run. */
  sheetNames?: () => readonly string[];
}

export interface RecalcHandlers {
  /**
   * Calculates and stores one cell. Return false when the stored value did
   * not change: formulas that read only unchanged cells are then skipped.
   */
  compute(cell: CellRef): boolean | void;
  /** Stores {@link CIRCULAR_REFERENCE} in a cell that is part of a circle. */
  circular(cell: CellRef): void;
}

export interface GraphRecalcOptions {
  /** Most cells to hand to the handlers in this run. The rest stays out of date. Default: no limit. */
  maxCells?: number;
  /** Longest chain of formulas reading each other. Cells further down stay out of date. Default: no limit. */
  maxDepth?: number;
  /** False leaves volatile formulas alone unless something they read changed. Default true. */
  volatile?: boolean;
}

export interface GraphRecalcResult {
  /** Cells handed to `compute`. */
  computed: number;
  /** Out-of-date cells that were not computed because nothing they read changed. */
  skipped: number;
  /** Cells handed to `circular`, in calculation order. */
  circular: CellRef[];
  /** False when a limit stopped the run; `remaining` cells are still out of date. */
  complete: boolean;
  remaining: number;
}

export interface RecalcStep extends CellRef {
  circular: boolean;
}
