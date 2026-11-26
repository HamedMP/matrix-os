import { type KeyboardEvent, type ReactNode, useState } from "react";
import { usesDate1904 } from "../session/date-system";
import { formatA1, isOfficeError, parseSheetRange } from "../session/engine";
import { editTextOf, startEdit, updateEditCaret, updateEditText } from "./actions-edit";
import { goToRange } from "./actions-move";
import type { GridContext } from "./context";
import { FormulaInput } from "./FormulaInput";
import type { EditState } from "./store";

export interface FormulaBarProps {
  ctx: GridContext;
  edit: EditState | null;
  readOnly: boolean;
  listId: string;
  activeOptionId: string | undefined;
  /** Keys of the formula input, handled by the grid. */
  onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** Called after the name box moved the selection, to put the focus back on the grid. */
  onNavigate(): void;
  /** The function list, when it belongs to this input. */
  popup: ReactNode;
}

/**
 * The bar above the grid: the address of the active cell, which also takes a
 * typed address or range to go to, and the content of the active cell, which
 * can be edited here with the same help as in the cell.
 */
export function FormulaBar({ ctx, edit, readOnly, listId, activeOptionId, onKey, onNavigate, popup }: FormulaBarProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const sheet = ctx.sheet;
  const active = ctx.selection.active;
  const cell = ctx.cell(sheet, active.row, active.col);
  const workbook = ctx.session.workbook;
  const shown = edit !== null ? edit.text : editTextOf(cell, workbook.getStyle(cell.styleId).numberFormat, usesDate1904(workbook));
  const inBar = edit !== null && edit.target === "bar";

  const go = (text: string): void => {
    try {
      const parsed = parseSheetRange(text.trim());
      if (parsed.sheetName !== null) {
        const target = ctx.session.workbook.getSheetByName(parsed.sheetName);
        if (target === null) {
          ctx.notice("There is no sheet with that name.");
          return;
        }
        ctx.session.setActiveSheet(target.id);
      }
      goToRange(ctx, parsed.range);
      setDraft(null);
      onNavigate();
    } catch (error: unknown) {
      if (!isOfficeError(error)) throw error;
      ctx.notice("Type a cell such as B7 or a range such as A1:C10.");
    }
  };

  return (
    <div className="sg-bar">
      <input
        className="sg-bar__name"
        type="text"
        aria-label="Cell reference. Type a cell or range and press Enter to go there."
        spellCheck={false}
        autoComplete="off"
        value={draft ?? formatA1(active)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            go(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
            onNavigate();
          }
        }}
      />
      <span className="sg-bar__fx" aria-hidden="true">
        fx
      </span>
      <div className="sg-bar__input">
        <FormulaInput
          className="sg-input--bar"
          label="Cell content"
          value={shown}
          selectionStart={inBar && edit !== null ? edit.selectionStart : shown.length}
          selectionEnd={inBar && edit !== null ? edit.selectionEnd : shown.length}
          focused={inBar}
          invalid={edit !== null && edit.error !== null}
          listId={inBar ? listId : undefined}
          activeOptionId={inBar ? activeOptionId : undefined}
          onFocus={() => {
            if (readOnly) return;
            const current = ctx.store.getState().edit;
            if (current === null) startEdit(ctx, null, "bar");
            else if (current.target !== "bar") updateEditCaret(ctx, current.text.length, current.text.length, "bar");
          }}
          onInput={(text, start, end) => {
            if (ctx.store.getState().edit !== null) updateEditText(ctx, text, start, end);
          }}
          onCaret={(start, end) => {
            const current = ctx.store.getState().edit;
            if (current !== null && current.target === "bar") updateEditCaret(ctx, start, end, "bar");
          }}
          onKey={onKey}
        />
        {inBar ? popup : null}
      </div>
    </div>
  );
}
