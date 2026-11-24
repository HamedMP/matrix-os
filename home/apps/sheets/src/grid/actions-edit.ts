/**
 * Editing a cell as text: starting, typing, pointing at cells from a
 * formula, completing function names, committing and cancelling.
 */

import { type Cell, type CellAddress, type CellRange, type SheetId, xlsx } from "../session/engine";
import { advance } from "./actions-move";
import type { GridContext } from "./context";
import {
  type Completion,
  applyCompletion,
  callAt,
  canInsertReference,
  completionAt,
  cycleAbsolute,
  formatReference,
  insertReference,
  isFormulaText,
  matchFunctions,
} from "./formula-edit";
import { type FunctionHint, activeHintArg } from "./function-hints";
import { type EditorCommand, type KeyInput, editorKeyCommand } from "./keymap";
import { type Direction, step } from "./navigation";
import { boundingRange, expandToMerges, mergeAt } from "./selection";
import type { EditState } from "./store";

const LOOKS_TYPED = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?%?|\d{4}-\d{2}-\d{2}.*|true|false)$/i;

/**
 * The text to edit for a cell: the formula with `=`, or the value written so
 * that typing it back gives the same value (a percentage as `25%`, a date as
 * `2026-01-31`, text that would read as a number with a leading `'`).
 */
export function editTextOf(cell: Pick<Cell, "value" | "formula">, numberFormat: string): string {
  if (cell.formula !== null) return `=${cell.formula}`;
  const value = cell.value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return value.code;
  if (typeof value === "string") {
    return value.startsWith("=") || value.startsWith("'") || LOOKS_TYPED.test(value.trim()) ? `'${value}` : value;
  }
  if (numberFormat.includes("%")) return `${Number((value * 100).toPrecision(15))}%`;
  if (xlsx.isDateFormat(numberFormat)) {
    const iso = xlsx.serialToIso(value);
    if (iso !== null) return iso.replace("T", " ");
  }
  return String(value);
}

function blankEdit(sheet: SheetId, cell: CellAddress, text: string, initial: string, mode: "enter" | "edit", target: "cell" | "bar"): EditState {
  return {
    sheet,
    cell,
    text,
    initial,
    selectionStart: text.length,
    selectionEnd: text.length,
    mode,
    target,
    pointing: null,
    completionIndex: 0,
    completionChosen: false,
    completionHidden: false,
    error: null,
  };
}

/**
 * Starts editing the active cell. With `initial` the content is replaced by
 * it (typing over a cell); with null the content is kept and arrows move the
 * caret (F2, double click, the formula bar).
 */
export function startEdit(ctx: GridContext, initial: string | null, target: "cell" | "bar" = "cell"): void {
  if (ctx.store.getState().edit !== null) return;
  const sheet = ctx.sheet;
  const active = ctx.selection.active;
  const merge = mergeAt(ctx.info().mergedRanges, active.row, active.col);
  const cell = merge === null ? active : merge.start;
  const current = ctx.cell(sheet, cell.row, cell.col);
  const existing = editTextOf(current, ctx.session.workbook.getStyle(current.styleId).numberFormat);
  const text = initial ?? existing;
  ctx.reveal(cell);
  ctx.store.set({ edit: blankEdit(sheet, cell, text, existing, initial === null ? "edit" : "enter", target), menu: null, notice: null });
}

function patchEdit(ctx: GridContext, patch: Partial<EditState>): void {
  const edit = ctx.store.getState().edit;
  if (edit !== null) ctx.store.set({ edit: { ...edit, ...patch } });
}

/** The owner typed or deleted text. */
export function updateEditText(ctx: GridContext, text: string, selectionStart: number, selectionEnd: number): void {
  const edit = ctx.store.getState().edit;
  if (edit === null) return;
  if (edit.text === text && edit.selectionStart === selectionStart && edit.selectionEnd === selectionEnd) return;
  if (edit.text !== text && edit.error !== null) ctx.notice(null);
  patchEdit(ctx, {
    text,
    selectionStart,
    selectionEnd,
    pointing: null,
    completionIndex: 0,
    completionChosen: false,
    completionHidden: edit.text === text ? edit.completionHidden : false,
    error: null,
  });
}

/** The caret moved without the text changing. */
export function updateEditCaret(ctx: GridContext, selectionStart: number, selectionEnd: number, target?: "cell" | "bar"): void {
  const edit = ctx.store.getState().edit;
  if (edit === null) return;
  const sameTarget = target === undefined || target === edit.target;
  if (edit.selectionStart === selectionStart && edit.selectionEnd === selectionEnd && sameTarget) return;
  const pointing = edit.pointing !== null && selectionStart === edit.pointing.end && selectionEnd === selectionStart ? edit.pointing : null;
  patchEdit(ctx, { selectionStart, selectionEnd, pointing, target: target ?? edit.target });
}

function closeBrackets(text: string): string {
  let open = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") open++;
    else if (!quoted && ch === ")") open--;
  }
  return open > 0 && !quoted ? text + ")".repeat(open) : text;
}

/**
 * Stores the edited text in its cell. Returns false, and keeps the editor
 * open with a message, when the text is refused (a formula that does not
 * parse). A formula with brackets left open is closed first.
 */
export function commitEdit(ctx: GridContext, move: Direction | null): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null) return true;
  if (edit.text !== edit.initial) {
    let result = ctx.session.setCellInput(edit.sheet, edit.cell, edit.text);
    if (!result.ok && result.code === "formula" && isFormulaText(edit.text)) {
      const closed = closeBrackets(edit.text);
      if (closed !== edit.text) result = ctx.session.setCellInput(edit.sheet, edit.cell, closed);
    }
    if (!result.ok) {
      patchEdit(ctx, { error: result.message, pointing: null });
      ctx.notice(result.message);
      return false;
    }
  }
  ctx.store.set({ edit: null, notice: null });
  // Pointing at another sheet may have switched the tab: go back to the cell that was edited.
  if (ctx.sheet !== edit.sheet) ctx.session.setActiveSheet(edit.sheet);
  if (move !== null) advance(ctx, move);
  else ctx.reveal(edit.cell);
  return true;
}

export function cancelEdit(ctx: GridContext): void {
  const edit = ctx.store.getState().edit;
  if (edit === null) return;
  ctx.store.set({ edit: null });
  if (ctx.sheet !== edit.sheet) ctx.session.setActiveSheet(edit.sheet);
}

/** True when a click or an arrow should put a reference into the formula being edited. */
export function canPoint(ctx: GridContext): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null || !isFormulaText(edit.text)) return false;
  if (edit.pointing !== null) return true;
  return edit.selectionStart === edit.selectionEnd && canInsertReference(edit.text, edit.selectionStart);
}

/**
 * Puts a reference to a cell of the active sheet into the formula, or moves
 * the one being pointed. With `extend` the reference grows from where the
 * pointing started. Returns false when the formula takes no reference here.
 */
export function pointAt(ctx: GridContext, cell: CellAddress, extend: boolean): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null || !canPoint(ctx)) return false;
  const sheet = ctx.sheet;
  const info = ctx.info();
  const previous = edit.pointing !== null && edit.pointing.sheet === sheet ? edit.pointing : null;
  const anchor = extend && previous !== null ? previous.anchor : cell;
  const merge = mergeAt(info.mergedRanges, cell.row, cell.col);
  const range: CellRange = extend || merge === null ? expandToMerges(boundingRange(anchor, cell), extend ? info.mergedRanges : []) : { start: merge.start, end: merge.start };
  const reference = formatReference(range, sheet === edit.sheet ? null : info.name);
  const start = edit.pointing?.start ?? edit.selectionStart;
  const end = edit.pointing?.end ?? edit.selectionEnd;
  const next = insertReference(edit.text, start, end, reference);
  patchEdit(ctx, {
    text: next.text,
    selectionStart: next.caret,
    selectionEnd: next.caret,
    pointing: { start, end: next.caret, sheet, anchor, focus: cell },
    completionHidden: true,
    error: null,
  });
  ctx.reveal(cell);
  return true;
}

/** Arrow keys while a formula expects a reference: point at the next cell. */
export function pointStep(ctx: GridContext, direction: Direction, extend: boolean): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null || !canPoint(ctx)) return false;
  const sheet = ctx.sheet;
  const from = edit.pointing !== null && edit.pointing.sheet === sheet ? edit.pointing.focus : sheet === edit.sheet ? edit.cell : ctx.selection.active;
  return pointAt(ctx, step(from, direction, ctx.navContext()), extend);
}

export interface CompletionView {
  completion: Completion;
  items: string[];
  index: number;
}

/** The function list to show for the text at the caret, or null. */
export function completionView(ctx: GridContext): CompletionView | null {
  const edit = ctx.store.getState().edit;
  if (edit === null || edit.completionHidden || edit.selectionStart !== edit.selectionEnd) return null;
  const completion = completionAt(edit.text, edit.selectionStart);
  if (completion === null) return null;
  const items = matchFunctions(completion.prefix, ctx.catalog.names);
  if (items.length === 0) return null;
  return { completion, items, index: Math.min(edit.completionIndex, items.length - 1) };
}

/** The hint for the function call the caret is in, with the argument to highlight. */
export function argumentHint(ctx: GridContext): { hint: FunctionHint; active: number } | null {
  const edit = ctx.store.getState().edit;
  if (edit === null) return null;
  const call = callAt(edit.text, edit.selectionStart);
  if (call === null) return null;
  const hint = ctx.catalog.hint(call.name);
  return hint === null ? null : { hint, active: activeHintArg(hint, call.argument) };
}

export function acceptCompletion(ctx: GridContext, name?: string): boolean {
  const edit = ctx.store.getState().edit;
  const view = completionView(ctx);
  if (edit === null || view === null) return false;
  const chosen = name ?? view.items[view.index];
  if (chosen === undefined) return false;
  const next = applyCompletion(edit.text, view.completion, chosen);
  patchEdit(ctx, {
    text: next.text,
    selectionStart: next.caret,
    selectionEnd: next.caret,
    pointing: null,
    completionIndex: 0,
    completionChosen: false,
    completionHidden: false,
    error: null,
  });
  return true;
}

function runEditorCommand(ctx: GridContext, command: EditorCommand): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null) return false;
  switch (command.type) {
    case "commit":
      commitEdit(ctx, command.move);
      return true;
    case "cancel":
      cancelEdit(ctx);
      return true;
    case "toggleAbsolute": {
      const next = cycleAbsolute(edit.text, edit.selectionStart);
      if (next !== null) patchEdit(ctx, { text: next.text, selectionStart: next.caret, selectionEnd: next.caret, pointing: null });
      return true;
    }
    case "toggleMode":
      patchEdit(ctx, { mode: edit.mode === "enter" ? "edit" : "enter", pointing: null });
      return true;
    case "point":
      return pointStep(ctx, command.direction, command.extend);
    case "completion": {
      const view = completionView(ctx);
      if (view === null) return false;
      if (command.action === "accept") return acceptCompletion(ctx);
      if (command.action === "close") {
        patchEdit(ctx, { completionHidden: true });
        return true;
      }
      const stepBy = command.action === "next" ? 1 : view.items.length - 1;
      patchEdit(ctx, { completionIndex: (view.index + stepBy) % view.items.length, completionChosen: true });
      return true;
    }
  }
}

/** A key pressed in the in-cell editor or the formula bar. Returns true when it was handled. */
export function editorKey(ctx: GridContext, input: KeyInput): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null) return false;
  const command = editorKeyCommand(input, {
    mode: edit.mode,
    canPoint: canPoint(ctx),
    completionOpen: completionView(ctx) !== null,
    completionChosen: edit.completionChosen,
  });
  return command === null ? false : runEditorCommand(ctx, command);
}
