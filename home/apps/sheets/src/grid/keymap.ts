/**
 * Keyboard model: which command a key means, as pure functions.
 *
 * `gridKeyCommand` is for the grid when no cell is being edited;
 * `editorKeyCommand` is for the in-cell editor and the formula bar. A null
 * result means the key is not handled and the browser keeps its default
 * (typing in the editor, the clipboard shortcuts, which arrive as clipboard
 * events).
 */

import type { Direction } from "./navigation";

export interface KeyInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Ctrl, or Command on a Mac. */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export type GridCommand =
  | { type: "move"; direction: Direction; extend: boolean; jump: boolean }
  | { type: "page"; direction: "up" | "down"; extend: boolean }
  /** Home: first column of the row; with `sheet`, cell A1. */
  | { type: "home"; extend: boolean; sheet: boolean }
  /** End with Ctrl: last used cell. */
  | { type: "end"; extend: boolean }
  | { type: "tab"; back: boolean }
  | { type: "enter"; back: boolean }
  /** Start editing. `initial` replaces the content; null keeps it (F2). */
  | { type: "edit"; initial: string | null }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "selectAll" }
  | { type: "selectRow" }
  | { type: "selectColumn" }
  | { type: "fill"; direction: "down" | "right" }
  | { type: "format"; toggle: "bold" | "italic" | "underline" }
  /** Escape: drop the copy marker. */
  | { type: "escape" };

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** One character a key types: a single code point, not a named key such as `Enter`. */
function isPrintable(key: string): boolean {
  return key.length === 1 || (key.length === 2 && key.codePointAt(0)! > 0xffff);
}

/**
 * True when Alt (Option on a Mac) or AltGr (Ctrl+Alt on Windows) typed a
 * character: `€`, `@`, `{`, `å`. A plain letter or digit with these keys is a
 * shortcut, not typing.
 */
function isAltCharacter(key: string, alt: boolean): boolean {
  return alt && isPrintable(key) && !/^[a-z0-9]$/i.test(key);
}

/** Keys that begin a composed character: a dead key (accents) or an input method. */
export function isCompositionKey(key: string, keyCode?: number): boolean {
  return key === "Dead" || key === "Process" || keyCode === 229;
}

export function gridKeyCommand(input: KeyInput): GridCommand | null {
  const { key, ctrl, shift, alt } = input;
  const arrow = ARROWS[key];
  if (arrow !== undefined) return alt ? null : { type: "move", direction: arrow, extend: shift, jump: ctrl };
  if (isAltCharacter(key, alt)) return { type: "edit", initial: key };
  if (alt) return null;
  switch (key) {
    case "Tab":
      return ctrl ? null : { type: "tab", back: shift };
    case "Enter":
      return ctrl ? null : { type: "enter", back: shift };
    case "F2":
      return { type: "edit", initial: null };
    case "Delete":
    case "Backspace":
      return ctrl ? null : { type: "clear" };
    case "Escape":
      return { type: "escape" };
    case "PageUp":
      return { type: "page", direction: "up", extend: shift };
    case "PageDown":
      return { type: "page", direction: "down", extend: shift };
    case "Home":
      return { type: "home", extend: shift, sheet: ctrl };
    case "End":
      return ctrl ? { type: "end", extend: shift } : null;
    default:
      break;
  }
  if (ctrl) {
    switch (key.toLowerCase()) {
      case "z":
        return shift ? { type: "redo" } : { type: "undo" };
      case "y":
        return { type: "redo" };
      case "a":
        return { type: "selectAll" };
      case "d":
        return { type: "fill", direction: "down" };
      case "r":
        return { type: "fill", direction: "right" };
      case "b":
        return { type: "format", toggle: "bold" };
      case "i":
        return { type: "format", toggle: "italic" };
      case "u":
        return { type: "format", toggle: "underline" };
      case " ":
        return { type: "selectColumn" };
      default:
        return null;
    }
  }
  if (key === " " && shift) return { type: "selectRow" };
  // A printable character starts editing and replaces the content.
  if (isPrintable(key)) return { type: "edit", initial: key };
  return null;
}

export interface EditorKeyContext {
  /**
   * `enter`: editing started by typing; arrows leave the cell.
   * `edit`: started with F2, a double click or in the formula bar; arrows move the caret.
   */
  mode: "enter" | "edit";
  /** True when the caret is where a formula takes a reference, so arrows point at cells instead. */
  canPoint: boolean;
  /** True when the function list is showing. */
  completionOpen: boolean;
  /** True when the owner moved through the function list with the arrows. */
  completionChosen: boolean;
}

export type EditorCommand =
  /** Store the text and move the active cell (null: stay). */
  | { type: "commit"; move: Direction | null }
  | { type: "cancel" }
  /** F4: cycle the reference at the caret through `$A$1`, `A$1`, `$A1`, `A1`. */
  | { type: "toggleAbsolute" }
  /** Move the cell a formula is pointing at. */
  | { type: "point"; direction: Direction; extend: boolean }
  | { type: "completion"; action: "next" | "previous" | "accept" | "close" }
  /** Switch between leaving the cell with arrows and moving the caret with them (F2). */
  | { type: "toggleMode" };

export function editorKeyCommand(input: KeyInput, context: EditorKeyContext): EditorCommand | null {
  const { key, ctrl, shift, alt } = input;
  if (context.completionOpen && !ctrl && !alt) {
    if (key === "ArrowDown") return { type: "completion", action: "next" };
    if (key === "ArrowUp") return { type: "completion", action: "previous" };
    if (key === "Tab" && !shift) return { type: "completion", action: "accept" };
    if (key === "Enter" && !shift && context.completionChosen) return { type: "completion", action: "accept" };
    if (key === "Escape") return { type: "completion", action: "close" };
  }
  if (key === "Escape") return { type: "cancel" };
  if (key === "Enter") return alt ? null : { type: "commit", move: ctrl ? null : shift ? "up" : "down" };
  if (key === "Tab") return { type: "commit", move: shift ? "left" : "right" };
  if (key === "F4") return { type: "toggleAbsolute" };
  if (key === "F2") return { type: "toggleMode" };
  const arrow = ARROWS[key];
  if (arrow !== undefined && !alt && !ctrl && context.mode === "enter") {
    if (context.canPoint) return { type: "point", direction: arrow, extend: shift };
    return shift ? null : { type: "commit", move: arrow };
  }
  return null;
}

/** The fields of a DOM keyboard event the key model needs. */
export function keyInputOf(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): KeyInput {
  return { key: event.key, ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey };
}
