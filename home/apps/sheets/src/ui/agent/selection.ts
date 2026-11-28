/** The selection the assistant acts on, read from the grid. */
import type { SheetSelection } from "../../agent";
import type { CellRange, SheetId } from "../../session/engine";

/** The parts of `SheetGridController` the panel reads the selection from. */
export interface SelectionSource {
  getSelection(): { sheet: SheetId };
  getActiveRange(): CellRange;
}

/** The grid's current selection as the assistant takes it. */
export function selectionFromGrid(grid: SelectionSource | null): SheetSelection | null {
  if (grid === null) return null;
  return { sheet: grid.getSelection().sheet, range: grid.getActiveRange() };
}
