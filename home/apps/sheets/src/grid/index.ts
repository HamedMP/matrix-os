/**
 * The Sheets grid.
 *
 * ```tsx
 * import { SheetGrid, createSheetGridController } from "./grid";
 *
 * const controller = useMemo(() => createSheetGridController(session), [session]);
 * useEffect(() => () => controller.dispose(), [controller]);
 *
 * <SheetGrid session={session} controller={controller} />
 * ```
 *
 * `<SheetGrid session />` draws the session's active sheet
 * (`session.getState().activeSheetId`; switch with `session.setActiveSheet`)
 * and fills its parent, which must have a height. Props: `controller?`,
 * `ref?` (receives the controller, also when the grid makes its own),
 * `showFormulaBar?` (default true), `readOnly?`, `label?`, `className?`,
 * `onSelectionChange?`. It imports its own stylesheet and uses the shared
 * `--app-*` tokens.
 *
 * What the grid does on its own
 * - Renders only the cells on screen, in up to four panes for frozen rows and
 *   columns, so it stays quick on sheets of 100 000 rows by 500 columns and
 *   beyond. Merged cells, hidden rows and columns, cell styles, number
 *   formats, text running over empty neighbours and error values are drawn as
 *   the engine describes them.
 * - Selection: click, drag, Shift to extend, Ctrl to add ranges, row and
 *   column headers, the corner for the whole sheet.
 * - Keys: arrows, Ctrl+arrows to the edge of data, Shift to extend, Tab and
 *   Enter (with Shift backwards), Page Up/Down, Home, Ctrl+Home, Ctrl+End,
 *   F2 or a double click to edit, typing to replace, Escape, Delete,
 *   Ctrl+Z / Ctrl+Y, Ctrl+C / X / V (tab-separated text and HTML tables both
 *   ways), Ctrl+D / Ctrl+R to fill, Ctrl+B / I / U, Ctrl+A, Shift+Space,
 *   Ctrl+Space. Command works as Ctrl on a Mac.
 * - Editing in the cell or in the formula bar: references are coloured and
 *   outlined on the grid, a click, a drag or the arrow keys put a reference
 *   into the formula, F4 cycles `$`, function names complete from the engine's
 *   registry with argument hints.
 * - The fill handle continues series (numbers, dates, text with numbers,
 *   weekday and month names) and moves relative references.
 * - Drag a header edge to resize, double click it to fit; the context menu
 *   inserts and deletes rows and columns, sorts and filters.
 * - Accessibility: `role="grid"` with row and column indexes, the active cell
 *   as `aria-activedescendant`, and a live region that reads the active
 *   cell's address, content, formula and marks.
 *
 * The controller (`SheetGridController`)
 * - Selection and view: `getSelection()`, `getActiveRange()`,
 *   `select(cellOrRange, sheet?)`, `scrollTo(cell, sheet?)`,
 *   `onSelectionChange(listener)`, `focus()`.
 * - Cells: `setCell(address, input, sheet?)`, `applyEdits(edits, label?)`
 *   (one undo step), `clear(what?)`, `format(stylePatch)`,
 *   `toggleFormat("bold" | "italic" | "underline")`, `fill("down" | "right")`,
 *   `undo()`, `redo()`.
 * - Editing: `isEditing`, `startEdit(initial?)`, `commitEdit()`,
 *   `cancelEdit()`. Call `commitEdit()` before an action that reads the
 *   workbook (save, send to the agent) so that text still in the editor counts.
 * - Clipboard for toolbar buttons: `copy()`, `cut()` return
 *   `{ text, html }`; `paste({ text, html })`.
 * - Structure: `insertRows(where?)`, `deleteRows()`, `insertColumns(where?)`,
 *   `deleteColumns()`, `toggleMerge()`, `toggleFreeze()`.
 * - Sort and filter: `sort(descending?)`, `sortRange(range, keys, hasHeader?)`,
 *   `filter(spec | null)`, `filterByValue()`, `isFiltered`. A filter hides
 *   rows in this view only; nothing in the file changes.
 * - Decorations, for change review, formula tracing and search:
 *   `decorate(layer, decorations)` replaces one named layer and
 *   `clearDecorations(layer?)` removes it. A decoration is
 *   `{ sheet, row, col, kind, oldValue?, newValue?, changeId?, label? }` with
 *   `kind` one of `proposed`, `precedent`, `dependent`, `search`,
 *   `search-active`. Cells with a pending change in the engine's journal are
 *   tinted without any decoration; a `proposed` decoration adds the old and
 *   new value to the tooltip and to what a screen reader hears. Decorated
 *   cells carry `data-change-id`, `data-row` and `data-col`.
 *
 * Typing on the grid: AltGr and Option characters start editing; a dead key
 * or an input method key opens an empty editor and the browser composes the
 * character into it, and the Enter that confirms a conversion does not commit
 * the cell.
 *
 * Limits of this version: touch input is not handled; a double click on a row edge resets the row to the default
 * height instead of measuring wrapped text; whole-row and whole-column
 * formats reach the used area plus a margin, not the end of the sheet.
 */

export { SheetGrid } from "./SheetGrid";
export type { SheetGridProps } from "./SheetGrid";
export { SheetGridController, createSheetGridController } from "./controller";
export type { GridSelection } from "./controller";
export type { ClipboardPayload } from "./actions-clipboard";
export { DecorationStore, describeDecoration } from "./decorations";
export type { CellDecoration, DecorationKind } from "./decorations";
export type { RangeKind, SelRange, Selection } from "./selection";
export type { FilterCriterion, FilterSpec, SortKey } from "./sort-filter";
export { formatReference, scanReferences } from "./formula-edit";
export type { FormulaRef } from "./formula-edit";
export { createFunctionCatalog } from "./function-hints";
export type { FunctionCatalog, FunctionHint } from "./function-hints";
export { editTextOf } from "./actions-edit";
export { readSystemClipboard, writeSystemClipboard } from "./system-clipboard";
export type { ClickCopyOutcome, ClickPasteOutcome } from "./click-clipboard";
