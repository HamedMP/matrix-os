/**
 * Public types of the Docs editor. See `./index.ts` for the overview.
 */

import type {
  ApplyResult,
  BlockId,
  DocxOp,
  ParagraphAlignment,
  ParagraphStylePatch,
  RunFormat,
  TextPosition,
  TextRange,
} from "../../../_shared/office-engine/index";
import type { DocumentSession, SessionApplyOptions } from "../session/index";

/**
 * What the document shows.
 * - `markup`: everything, with tracked changes marked inline.
 * - `final`: the document as if every change were accepted, without marks.
 * - `original`: the document as if every change were rejected. Read-only.
 */
export type ViewMode = "markup" | "final" | "original";

/** A selection in engine coordinates. `anchor` is where it started, `focus` the moving end. */
export interface EditorSelection {
  anchor: TextPosition;
  focus: TextPosition;
  /** The earlier end in document order. */
  start: TextPosition;
  /** The later end in document order. */
  end: TextPosition;
  collapsed: boolean;
  /** True when the focus is before the anchor. */
  backward: boolean;
}

/** Anything `setSelection` and `scrollTo` accept as a place in the document. */
export type SelectionTarget = TextPosition | TextRange | { anchor: TextPosition; focus: TextPosition };

/** A range to paint. Highlights never change the document or the selection. */
export interface EditorHighlight {
  /** Reported back as `data-hl-id` on the painted spans, for hit testing. */
  id?: string;
  range: TextRange;
  /** Extra class on the painted spans, beside `doc-hl` and `doc-hl-<layer>`. */
  className?: string;
}

/** Character and paragraph formatting at the selection, for toolbar state. */
export interface ActiveFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 0 for body text, 1 to 9 for a heading; null when the selection mixes levels. */
  headingLevel: number | null;
  alignment: ParagraphAlignment | null;
  styleName: string | null;
  /** True when the selection is inside a table cell. */
  inTable: boolean;
}

/** Immutable. Replaced on every change, so it works with `useSyncExternalStore`. */
export interface EditorSnapshot {
  viewMode: ViewMode;
  /** True when input is ignored: `readOnly` was requested, or the view mode is `original`. */
  readOnly: boolean;
  focused: boolean;
  selection: EditorSelection | null;
  activeFormat: ActiveFormat | null;
}

export type ToggleFormat = "bold" | "italic" | "underline" | "strike";

export interface ScrollOptions {
  behavior?: "auto" | "smooth";
  /** Where the target ends up in the viewport. Default `center`. */
  block?: "start" | "center" | "end" | "nearest";
}

export interface SetSelectionOptions {
  /** Also scroll the selection into view. Default false. */
  scroll?: boolean;
  /** Also move keyboard focus into the document. Default false. */
  focus?: boolean;
}

export interface DocumentEditorOptions {
  /** Initial view mode. Default `markup`. */
  viewMode?: ViewMode;
  readOnly?: boolean;
  /** Accessible name of the editing surface. Default `Document`. */
  ariaLabel?: string;
  /** Called for Ctrl/Cmd+click on a link with a safe address. Default: open it in a new window. */
  onOpenLink?: (href: string) => void;
  /** Receives problems that were handled (an edit the engine refused, a failed listener). */
  log?: (message: string, error: unknown) => void;
}

/**
 * The imperative handle of a mounted `<DocumentEditor>`.
 *
 * Every edit goes through the session, so it is undoable, marks the document
 * dirty and follows the Track changes toggle. Positions and ranges are engine
 * coordinates (`TextPosition`: block id and offset in the paragraph's markup
 * text).
 */
export interface DocumentEditorController {
  readonly session: DocumentSession;

  // ---- state
  getSnapshot(): EditorSnapshot;
  /** Calls back after the snapshot changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;

  // ---- editing
  /**
   * Applies engine operations (as `session.apply` does), then puts the caret
   * where the last operation says it belongs. Use it for edits that act on
   * the selection; use `session.apply` for edits that should leave it alone.
   */
  applyOps(ops: readonly DocxOp[], options?: SessionApplyOptions): ApplyResult;
  /** Replaces the selection with text. `\n` is a line break, `\t` a tab. Returns false when nothing was done. */
  insertText(text: string): boolean;
  /** Splits the paragraph at the caret (the Enter key). */
  insertParagraph(): boolean;
  /** Deletes the selection, or does nothing when it is collapsed. */
  deleteSelection(): boolean;
  /**
   * Formats the selection. A name toggles that property; a patch sets it.
   * With a collapsed selection the format applies to the text typed next.
   */
  format(format: ToggleFormat | Partial<RunFormat>): boolean;
  /** Sets paragraph properties on every paragraph the selection touches. */
  setParagraphStyle(style: Partial<ParagraphStylePatch>): boolean;
  undo(): boolean;
  redo(): boolean;

  // ---- selection
  getSelection(): EditorSelection | null;
  setSelection(target: SelectionTarget, options?: SetSelectionOptions): boolean;
  /** The selected text as the current view mode shows it; paragraphs are separated by `\n`. */
  getSelectedText(): string;
  /** Calls back when the selection changes, with null when it leaves the document. */
  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void;
  focus(): void;

  // ---- view
  /** Scrolls a block, position or range into view. False when it is not shown. */
  scrollTo(target: BlockId | SelectionTarget, options?: ScrollOptions): boolean;
  /**
   * Replaces the highlights of one layer. Layers are independent: `search`,
   * `comment`, `proposal` or any other name. Spans get the classes `doc-hl`
   * and `doc-hl-<layer>`. An empty list clears the layer.
   */
  setHighlights(layer: string, highlights: readonly EditorHighlight[]): void;
  clearHighlights(layer?: string): void;
  getViewMode(): ViewMode;
  setViewMode(mode: ViewMode): void;
  /** Same as `session.setTracking`. */
  setTracking(enabled: boolean): void;
  setReadOnly(readOnly: boolean): void;
  /** The element that renders a block, or null when the current view does not show it. */
  getBlockElement(blockId: BlockId): HTMLElement | null;
  /** Client rectangles of a range, for placing popovers. Empty when it is not shown. */
  getRangeRects(range: TextRange): DOMRect[];
}
