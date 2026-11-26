import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "../../../../home/apps/_shared/office-engine/index";
import { editorKeyCommand, gridKeyCommand, type KeyInput } from "../../../../home/apps/sheets/src/grid/keymap";
import { type NavContext, jump, lastUsedCell, moveRows, step } from "../../../../home/apps/sheets/src/grid/navigation";
import {
  activeRange,
  addCell,
  clipToUsed,
  columnFullySelected,
  expandToMerges,
  extendTo,
  isSingleCell,
  moveWithinSelection,
  rowFullySelected,
  rowTouched,
  selectAll,
  selectCell,
  selectColumns,
  selectRows,
  selectionContains,
} from "../../../../home/apps/sheets/src/grid/selection";

const cell = (row: number, col: number) => ({ row, col });
const range = (r1: number, c1: number, r2: number, c2: number) => ({ start: cell(r1, c1), end: cell(r2, c2) });

describe("selection model", () => {
  it("selects a cell and extends from the anchor in any direction", () => {
    const start = selectCell(cell(4, 4));
    expect(start).toMatchObject({ active: cell(4, 4), anchor: cell(4, 4), ranges: [{ ...range(4, 4, 4, 4), kind: "cells" }] });
    const up = extendTo(start, cell(2, 1));
    expect(up.ranges).toEqual([{ ...range(2, 1, 4, 4), kind: "cells" }]);
    expect(up.active).toEqual(cell(4, 4));
    expect(up.focus).toEqual(cell(2, 1));
    // Extending again replaces the range instead of growing it.
    expect(extendTo(up, cell(6, 5)).ranges).toEqual([{ ...range(4, 4, 6, 5), kind: "cells" }]);
    expect(isSingleCell(start)).toBe(true);
    expect(isSingleCell(up)).toBe(false);
  });

  it("keeps earlier ranges when adding with ctrl and extends only the last", () => {
    const multi = addCell(extendTo(selectCell(cell(0, 0)), cell(1, 1)), cell(5, 5));
    expect(multi.ranges).toHaveLength(2);
    expect(multi.active).toEqual(cell(5, 5));
    const grown = extendTo(multi, cell(6, 7));
    expect(grown.ranges).toEqual([
      { ...range(0, 0, 1, 1), kind: "cells" },
      { ...range(5, 5, 6, 7), kind: "cells" },
    ]);
    expect(selectionContains(grown, 1, 1)).toBe(true);
    expect(selectionContains(grown, 3, 3)).toBe(false);
    expect(activeRange(grown)).toMatchObject(range(5, 5, 6, 7));
  });

  it("selects whole rows, columns and the sheet", () => {
    const rows = selectRows(null, 3);
    expect(rows.ranges).toEqual([{ ...range(3, 0, 3, MAX_COLS - 1), kind: "rows" }]);
    expect(selectRows(rows, 6, "extend").ranges).toEqual([{ ...range(3, 0, 6, MAX_COLS - 1), kind: "rows" }]);
    expect(selectRows(rows, 9, "add").ranges).toHaveLength(2);
    expect(rowFullySelected(rows, 3)).toBe(true);
    expect(rowFullySelected(selectCell(cell(3, 0)), 3)).toBe(false);
    expect(rowTouched(selectCell(cell(3, 0)), 3)).toBe(true);

    const cols = selectColumns(null, 2);
    expect(cols.ranges).toEqual([{ ...range(0, 2, MAX_ROWS - 1, 2), kind: "cols" }]);
    expect(selectColumns(cols, 0, "extend").ranges).toEqual([{ ...range(0, 0, MAX_ROWS - 1, 2), kind: "cols" }]);
    expect(columnFullySelected(cols, 2)).toBe(true);

    const all = selectAll(cell(2, 2));
    expect(all.ranges[0]).toMatchObject({ ...range(0, 0, MAX_ROWS - 1, MAX_COLS - 1), kind: "all" });
    expect(all.active).toEqual(cell(2, 2));
    expect(clipToUsed(all.ranges, range(0, 0, 9, 3))).toEqual([range(0, 0, 9, 3)]);
    expect(clipToUsed(all.ranges, null)).toEqual([]);
  });

  it("treats a merged range as one cell", () => {
    const merges = [range(1, 1, 2, 3)];
    const inside = selectCell(cell(2, 2), merges);
    expect(inside.active).toEqual(cell(1, 1));
    expect(inside.ranges).toEqual([{ ...range(1, 1, 2, 3), kind: "cells" }]);
    expect(isSingleCell(inside, merges)).toBe(true);
    expect(extendTo(selectCell(cell(0, 0)), cell(1, 2), merges).ranges).toEqual([{ ...range(0, 0, 2, 3), kind: "cells" }]);
    expect(expandToMerges(range(0, 3, 1, 4), [range(1, 1, 2, 3), range(2, 0, 5, 1)])).toEqual(range(0, 0, 5, 4));
  });

  it("walks through the selected cells with tab and enter, wrapping between ranges", () => {
    let selection = addCell(extendTo(selectCell(cell(0, 0)), cell(1, 1)), cell(5, 5));
    selection = { ...selection, active: cell(0, 0) };
    const visit = (direction: "right" | "left" | "down" | "up", times: number) => {
      const seen: string[] = [];
      for (let i = 0; i < times; i++) {
        selection = moveWithinSelection(selection, direction);
        seen.push(`${selection.active.row},${selection.active.col}`);
      }
      return seen;
    };
    expect(visit("right", 5)).toEqual(["0,1", "1,0", "1,1", "5,5", "0,0"]);
    expect(visit("down", 4)).toEqual(["1,0", "0,1", "1,1", "5,5"]);
    expect(visit("left", 2)).toEqual(["1,1", "1,0"]);
    expect(selection.ranges).toHaveLength(2);
  });

  // Outcome: Tab and Enter inside a range stop only on cells that are on screen. Fault: the active cell
  // lands in a hidden row or column, where typing changes a cell the owner cannot see.
  it("skips hidden rows and columns when walking through the selected cells", () => {
    const hidden = { isRowHidden: (row: number) => row === 1, isColHidden: (col: number) => col === 1 };
    let selection = { ...extendTo(selectCell(cell(0, 0)), cell(2, 2)), active: cell(0, 0) };
    const visit = (direction: "right" | "left" | "down" | "up", times: number) => {
      const seen: string[] = [];
      for (let i = 0; i < times; i++) {
        selection = moveWithinSelection(selection, direction, [], hidden);
        seen.push(`${selection.active.row},${selection.active.col}`);
      }
      return seen;
    };
    expect(visit("right", 4)).toEqual(["0,2", "2,0", "2,2", "0,0"]);
    expect(visit("down", 4)).toEqual(["2,0", "0,2", "2,2", "0,0"]);
    expect(visit("left", 2)).toEqual(["2,2", "2,0"]);
    expect(visit("up", 2)).toEqual(["0,0", "2,2"]);
  });

  it("skips a long run of hidden rows in a whole-column selection without stopping on one", () => {
    const hidden = { isRowHidden: (row: number) => row > 0 && row < 500_000, isColHidden: () => false };
    const selection = { ...selectColumns(null, 0), active: cell(0, 0) };
    expect(moveWithinSelection(selection, "down", [], hidden).active).toEqual(cell(500_000, 0));
    expect(moveWithinSelection(selection, "up", [], hidden).active).toEqual(cell(MAX_ROWS - 1, 0));
  });

  it("stays put when every other selected cell is hidden", () => {
    const hidden = { isRowHidden: (row: number) => row !== 0, isColHidden: (col: number) => col !== 0 };
    const selection = { ...extendTo(selectCell(cell(0, 0)), cell(3, 3)), active: cell(0, 0) };
    expect(moveWithinSelection(selection, "right", [], hidden).active).toEqual(cell(0, 0));
    expect(moveWithinSelection(selection, "down", [], hidden).active).toEqual(cell(0, 0));
  });
});

function context(rows: string[], overrides: Partial<NavContext> = {}): NavContext {
  const width = Math.max(...rows.map((row) => row.length));
  return {
    merges: [],
    used: { start: cell(0, 0), end: cell(rows.length - 1, width - 1) },
    isBlank: (row, col) => (rows[row]?.[col] ?? ".") === ".",
    isRowHidden: () => false,
    isColHidden: () => false,
    ...overrides,
  };
}

describe("keyboard navigation", () => {
  it("steps one cell and stops at the edges of the sheet", () => {
    const ctx = context(["x"]);
    expect(step(cell(3, 3), "down", ctx)).toEqual(cell(4, 3));
    expect(step(cell(3, 3), "left", ctx)).toEqual(cell(3, 2));
    expect(step(cell(0, 0), "up", ctx)).toEqual(cell(0, 0));
    expect(step(cell(MAX_ROWS - 1, MAX_COLS - 1), "right", ctx)).toEqual(cell(MAX_ROWS - 1, MAX_COLS - 1));
  });

  it("skips hidden rows and columns", () => {
    const ctx = context(["x"], { isRowHidden: (row) => row === 4 || row === 5, isColHidden: (col) => col === 1 });
    expect(step(cell(3, 0), "down", ctx)).toEqual(cell(6, 0));
    expect(step(cell(6, 0), "up", ctx)).toEqual(cell(3, 0));
    expect(step(cell(0, 0), "right", ctx)).toEqual(cell(0, 2));
    expect(moveRows(cell(0, 0), 5, ctx)).toEqual(cell(3, 0));
  });

  it("crosses a merged range in one step and lands on its first cell", () => {
    const ctx = context(["x"], { merges: [range(2, 1, 3, 2)] });
    expect(step(cell(1, 2), "down", ctx)).toEqual(cell(2, 1));
    expect(step(cell(2, 1), "down", ctx)).toEqual(cell(4, 1));
    expect(step(cell(2, 1), "right", ctx)).toEqual(cell(2, 3));
    expect(step(cell(3, 3), "left", ctx)).toEqual(cell(2, 1));
  });

  it("jumps to the edges of blocks of data with ctrl and an arrow", () => {
    //            0123456
    const rows = ["xxx..xx", ".......", "x.....x", "x......", "......."];
    const ctx = context(rows);
    // Inside a block: to its last cell.
    expect(jump(cell(0, 0), "right", ctx)).toEqual(cell(0, 2));
    // At the end of a block: to the start of the next one.
    expect(jump(cell(0, 2), "right", ctx)).toEqual(cell(0, 5));
    expect(jump(cell(0, 5), "right", ctx)).toEqual(cell(0, 6));
    // No more data that way: the edge of the sheet.
    expect(jump(cell(0, 6), "right", ctx)).toEqual(cell(0, MAX_COLS - 1));
    expect(jump(cell(0, 6), "left", ctx)).toEqual(cell(0, 5));
    expect(jump(cell(0, 5), "left", ctx)).toEqual(cell(0, 2));
    expect(jump(cell(0, 0), "left", ctx)).toEqual(cell(0, 0));
    // From an empty cell: to the next cell with data.
    expect(jump(cell(1, 0), "down", ctx)).toEqual(cell(2, 0));
    expect(jump(cell(2, 0), "down", ctx)).toEqual(cell(3, 0));
    expect(jump(cell(3, 0), "down", ctx)).toEqual(cell(MAX_ROWS - 1, 0));
    expect(jump(cell(3, 0), "up", ctx)).toEqual(cell(2, 0));
    expect(jump(cell(2, 0), "up", ctx)).toEqual(cell(0, 0));
    // Coming back from far outside the used area.
    expect(jump(cell(900, 0), "up", ctx)).toEqual(cell(3, 0));
    expect(jump(cell(900, 50), "up", ctx)).toEqual(cell(0, 50));
    expect(jump(cell(0, 0), "down", context([], { used: null }))).toEqual(cell(MAX_ROWS - 1, 0));
    expect(lastUsedCell(ctx)).toEqual(cell(4, 6));
  });
});

const key = (name: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: name, ctrl: false, shift: false, alt: false, ...mods });

describe("keyboard model", () => {
  it("maps navigation keys", () => {
    expect(gridKeyCommand(key("ArrowDown"))).toEqual({ type: "move", direction: "down", extend: false, jump: false });
    expect(gridKeyCommand(key("ArrowLeft", { shift: true, ctrl: true }))).toEqual({ type: "move", direction: "left", extend: true, jump: true });
    expect(gridKeyCommand(key("Tab"))).toEqual({ type: "tab", back: false });
    expect(gridKeyCommand(key("Tab", { shift: true }))).toEqual({ type: "tab", back: true });
    expect(gridKeyCommand(key("Enter", { shift: true }))).toEqual({ type: "enter", back: true });
    expect(gridKeyCommand(key("PageDown"))).toEqual({ type: "page", direction: "down", extend: false });
    expect(gridKeyCommand(key("Home", { ctrl: true }))).toEqual({ type: "home", extend: false, sheet: true });
    expect(gridKeyCommand(key("End", { ctrl: true, shift: true }))).toEqual({ type: "end", extend: true });
  });

  it("maps editing and command keys", () => {
    expect(gridKeyCommand(key("F2"))).toEqual({ type: "edit", initial: null });
    expect(gridKeyCommand(key("a"))).toEqual({ type: "edit", initial: "a" });
    expect(gridKeyCommand(key("="))).toEqual({ type: "edit", initial: "=" });
    expect(gridKeyCommand(key("Delete"))).toEqual({ type: "clear" });
    expect(gridKeyCommand(key("Backspace"))).toEqual({ type: "clear" });
    expect(gridKeyCommand(key("z", { ctrl: true }))).toEqual({ type: "undo" });
    expect(gridKeyCommand(key("Z", { ctrl: true, shift: true }))).toEqual({ type: "redo" });
    expect(gridKeyCommand(key("y", { ctrl: true }))).toEqual({ type: "redo" });
    expect(gridKeyCommand(key("d", { ctrl: true }))).toEqual({ type: "fill", direction: "down" });
    expect(gridKeyCommand(key("r", { ctrl: true }))).toEqual({ type: "fill", direction: "right" });
    expect(gridKeyCommand(key("b", { ctrl: true }))).toEqual({ type: "format", toggle: "bold" });
    expect(gridKeyCommand(key("i", { ctrl: true }))).toEqual({ type: "format", toggle: "italic" });
    expect(gridKeyCommand(key("u", { ctrl: true }))).toEqual({ type: "format", toggle: "underline" });
    expect(gridKeyCommand(key("a", { ctrl: true }))).toEqual({ type: "selectAll" });
    expect(gridKeyCommand(key(" ", { shift: true }))).toEqual({ type: "selectRow" });
    expect(gridKeyCommand(key(" ", { ctrl: true }))).toEqual({ type: "selectColumn" });
    expect(gridKeyCommand(key("Escape"))).toEqual({ type: "escape" });
  });

  it("leaves the clipboard shortcuts and bare modifiers to the browser", () => {
    for (const name of ["c", "x", "v"]) expect(gridKeyCommand(key(name, { ctrl: true }))).toBeNull();
    expect(gridKeyCommand(key("Shift", { shift: true }))).toBeNull();
    expect(gridKeyCommand(key("F5"))).toBeNull();
  });

  it("commits, cancels and moves from the editor", () => {
    const typing = { mode: "enter" as const, canPoint: false, completionOpen: false, completionChosen: false };
    expect(editorKeyCommand(key("Enter"), typing)).toEqual({ type: "commit", move: "down" });
    expect(editorKeyCommand(key("Enter", { shift: true }), typing)).toEqual({ type: "commit", move: "up" });
    expect(editorKeyCommand(key("Tab"), typing)).toEqual({ type: "commit", move: "right" });
    expect(editorKeyCommand(key("Tab", { shift: true }), typing)).toEqual({ type: "commit", move: "left" });
    expect(editorKeyCommand(key("Escape"), typing)).toEqual({ type: "cancel" });
    expect(editorKeyCommand(key("ArrowRight"), typing)).toEqual({ type: "commit", move: "right" });
    expect(editorKeyCommand(key("F4"), typing)).toEqual({ type: "toggleAbsolute" });
    expect(editorKeyCommand(key("a"), typing)).toBeNull();
    // After F2 the arrows move the caret in the text.
    expect(editorKeyCommand(key("ArrowRight"), { ...typing, mode: "edit" })).toBeNull();
    // While a formula expects a reference the arrows point at cells.
    expect(editorKeyCommand(key("ArrowUp", { shift: true }), { ...typing, canPoint: true })).toEqual({ type: "point", direction: "up", extend: true });
  });

  it("drives the function list before anything else", () => {
    const open = { mode: "enter" as const, canPoint: false, completionOpen: true, completionChosen: false };
    expect(editorKeyCommand(key("ArrowDown"), open)).toEqual({ type: "completion", action: "next" });
    expect(editorKeyCommand(key("Tab"), open)).toEqual({ type: "completion", action: "accept" });
    expect(editorKeyCommand(key("Escape"), open)).toEqual({ type: "completion", action: "close" });
    // Enter stores the cell unless the owner picked an entry with the arrows.
    expect(editorKeyCommand(key("Enter"), open)).toEqual({ type: "commit", move: "down" });
    expect(editorKeyCommand(key("Enter"), { ...open, completionChosen: true })).toEqual({ type: "completion", action: "accept" });
  });
});
