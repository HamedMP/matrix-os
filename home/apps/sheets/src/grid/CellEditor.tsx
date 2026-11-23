import type { KeyboardEvent, ReactNode } from "react";
import { updateEditCaret, updateEditText } from "./actions-edit";
import { CELL_PADDING_PX, DEFAULT_FONT_PX, textWidth } from "./cell-look";
import type { GridContext, GridLayout } from "./context";
import { FormulaInput } from "./FormulaInput";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { mergeAt } from "./selection";
import type { EditState } from "./store";
import { rangeOnScreen } from "./viewport";

export interface CellEditorProps {
  ctx: GridContext;
  layout: GridLayout;
  edit: EditState;
  /** Width of the cell area, which the editor does not grow past. */
  areaWidth: number;
  listId: string;
  activeOptionId: string | undefined;
  onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** Builds the function list at a position inside the grid surface. */
  popupAt(left: number, top: number): ReactNode;
}

const EDITOR_FONT = { fontPx: DEFAULT_FONT_PX, bold: false, italic: false, fontFamily: "system-ui, sans-serif" };
const LINE_PX = DEFAULT_FONT_PX + 6;
const OFF_SCREEN = { x: -20_000, y: -20_000, width: 80, height: 20 };

/**
 * The text input over the cell being edited. It starts at the size of the
 * cell (or of its merged range) and grows with the text. While the cell is
 * on another sheet or scrolled out of view the input is kept out of sight and
 * the text shows in the formula bar.
 */
export function CellEditor({ ctx, layout, edit, areaWidth, listId, activeOptionId, onKey, popupAt }: CellEditorProps) {
  const here = edit.sheet === layout.sheet;
  const merge = here ? mergeAt(layout.info.mergedRanges, edit.cell.row, edit.cell.col) : null;
  const shown = here ? rangeOnScreen(layout.axes, layout.viewport, merge ?? { start: edit.cell, end: edit.cell }) : null;
  // Off screen the input stays mounted, out of sight, so that it keeps the keyboard.
  const rect = shown ?? OFF_SCREEN;
  const lines = edit.text.split("\n");
  const longest = lines.reduce((a, b) => (a.length >= b.length ? a : b), "");
  const wanted = textWidth(longest, EDITOR_FONT) + CELL_PADDING_PX + 12;
  const width = Math.min(Math.max(rect.width + 1, wanted), Math.max(rect.width + 1, areaWidth - rect.x));
  const height = Math.max(rect.height + 1, lines.length * LINE_PX + 4);
  const inCell = edit.target === "cell";
  return (
    <>
      <FormulaInput
        className={`sg-input--cell${edit.error === null ? "" : " is-invalid"}`}
        style={{ left: ROW_HEADER_WIDTH_PX + rect.x - 1, top: HEADER_HEIGHT_PX + rect.y - 1, width, height }}
        label="Cell editor"
        value={edit.text}
        selectionStart={edit.selectionStart}
        selectionEnd={edit.selectionEnd}
        focused={inCell}
        invalid={edit.error !== null}
        listId={inCell ? listId : undefined}
        activeOptionId={inCell ? activeOptionId : undefined}
        onInput={(text, start, end) => updateEditText(ctx, text, start, end)}
        onCaret={(start, end) => {
          if (ctx.store.getState().edit?.target === "cell") updateEditCaret(ctx, start, end, "cell");
        }}
        onFocus={() => {
          const current = ctx.store.getState().edit;
          if (current !== null && current.target !== "cell") updateEditCaret(ctx, current.selectionStart, current.selectionEnd, "cell");
        }}
        onKey={onKey}
      />
      {inCell && shown !== null ? popupAt(ROW_HEADER_WIDTH_PX + rect.x, HEADER_HEIGHT_PX + rect.y + height + 2) : null}
    </>
  );
}
