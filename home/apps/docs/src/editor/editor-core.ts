/**
 * The editor without React: the public controller (`DocumentEditorController`)
 * and the handling of input events (`InputTarget`), on top of the state and
 * rendering in `./editor-base.ts`.
 */

import type { ApplyResult, BlockId, DocxOp, ParagraphStylePatch, RunFormat, TextRange } from "../../../_shared/office-engine/index";
import type { SessionApplyOptions } from "../session/index";
import * as commands from "./commands";
import { EditorBase } from "./editor-base";
import type { InputTarget } from "./input-controller";
import type { PasteContent } from "./paste";
import { positionFromDom } from "./position-map";
import { endsOf, sameSelection, toSelection } from "./selection";
import type { DocumentEditorController, EditorHighlight, EditorSelection, ScrollOptions, SelectionTarget, SetSelectionOptions, ToggleFormat, ViewMode } from "./types";
import { rangeRects, scrollIntoView } from "./viewport";
import type { StepUnit } from "./visibility";

export class EditorCore extends EditorBase implements DocumentEditorController, InputTarget {
  protected inputTarget(): InputTarget {
    return this;
  }

  // ---------------------------------------------------------------- view mode

  getViewMode(): ViewMode {
    return this.mode;
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pendingFormat = null;
    this.keepingSelection(() => {
      this.view?.setMode(mode);
      this.renderAll();
    });
    this.publish();
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.view?.setEditable(this.isEditable());
    this.publish();
  }

  setTracking(enabled: boolean): void {
    this.session.setTracking(enabled);
  }

  // ---------------------------------------------------------------- selection

  setSelection(target: SelectionTarget, options: SetSelectionOptions = {}): boolean {
    if (this.view === null) return false;
    const { anchor, focus } = endsOf(target);
    if (options.focus === true) this.view.content.focus();
    if (!this.place(anchor, focus)) return false;
    if (options.scroll === true) this.scrollTo({ anchor, focus }, { block: "nearest" });
    return true;
  }

  getSelectedText(): string {
    const selection = this.getSelection();
    return selection === null ? "" : commands.selectedText(this.commandHost(), selection);
  }

  focus(): void {
    if (this.view === null) return;
    this.view.content.focus();
    if (this.liveSelection() !== null) return;
    const selection = this.validSelection(this.lastSelection);
    const first = this.index.paragraphs.find((entry) => entry.storyKind === "body");
    if (selection !== null) this.place(selection.anchor, selection.focus);
    else if (first !== undefined) this.place({ blockId: first.id, offset: 0 }, { blockId: first.id, offset: 0 });
  }

  selectionOfRange(range: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number }): EditorSelection | null {
    if (this.view === null) return null;
    const start = positionFromDom(this.view.content, range.startContainer, range.startOffset);
    const end = positionFromDom(this.view.content, range.endContainer, range.endOffset);
    return start === null || end === null ? null : toSelection(this.index, start, end);
  }

  // ---------------------------------------------------------------- editing

  applyOps(ops: readonly DocxOp[], options: SessionApplyOptions = {}): ApplyResult {
    const result = this.session.apply(ops, { origin: commands.EDITOR_ORIGIN, ...options });
    for (let at = result.results.length - 1; at >= 0; at--) {
      const caret = result.results[at]?.caret ?? null;
      if (caret === null) continue;
      this.place(caret, caret);
      break;
    }
    return result;
  }

  insertText(text: string, selection?: EditorSelection | null): boolean {
    const format = this.pendingFormat;
    const done = this.run((current) => commands.insertText(this.commandHost(), current, text, format), selection);
    if (done && format !== null) {
      this.pendingFormat = null;
      this.publish();
    }
    return done;
  }

  insertParagraph(): boolean {
    return this.run((selection) => commands.insertParagraph(this.commandHost(), selection));
  }

  deleteSelection(): boolean {
    return this.run((selection) => commands.deleteSelection(this.commandHost(), selection));
  }

  deleteStep(direction: "backward" | "forward", unit: StepUnit, reported?: EditorSelection | null): boolean {
    return this.run((selection) => {
      const host = this.commandHost();
      // A reported range applies to a caret only, and only inside the caret's paragraph.
      const usable = reported != null && selection.collapsed && reported.start.blockId === reported.end.blockId && reported.start.blockId === selection.focus.blockId;
      return usable ? commands.deleteReported(host, reported, direction) : commands.deleteStep(host, selection, direction, unit);
    });
  }

  paste(content: PasteContent): boolean {
    return this.run((selection) => commands.paste(this.commandHost(), selection, content));
  }

  clipboardRefused(kind: "paste" | "cut"): void {
    this.log(`docs: the ${kind} was refused: the text is larger than one paste inserts`, null);
    this.options.onClipboardRefused?.(kind);
  }

  toggleFormat(name: ToggleFormat): boolean {
    return this.format(name);
  }

  format(format: ToggleFormat | Partial<RunFormat>): boolean {
    const selection = this.getSelection();
    if (selection === null || !this.isEditable()) return false;
    const host = this.commandHost();
    let patch: Partial<RunFormat>;
    if (typeof format !== "string") patch = format;
    else if (selection.collapsed) patch = { [format]: !(commands.activeFormat(host, selection, this.pendingFormat)?.[format] ?? false) };
    else patch = { [format]: commands.toggleValue(host, selection, format) };
    if (selection.collapsed) {
      this.pendingFormat = { ...this.pendingFormat, ...patch };
      this.publish();
      return true;
    }
    return this.run((current) => commands.setRunFormat(host, current, patch), selection);
  }

  setParagraphStyle(style: Partial<ParagraphStylePatch>): boolean {
    return this.run((selection) => commands.setParagraphStyle(this.commandHost(), selection, style));
  }

  undo(): boolean {
    return this.session.undo();
  }

  redo(): boolean {
    return this.session.redo();
  }

  /** Tab in a table: moves to the next or previous cell. False outside a table. */
  moveInTable(backward: boolean): boolean {
    const selection = this.getSelection();
    const target = selection === null ? undefined : commands.adjacentCell(this.index, selection.focus.blockId, backward);
    if (target === undefined) return false;
    if (target !== null) this.place(target, target);
    return true;
  }

  // ---------------------------------------------------------------- composition and repair

  beginComposition(): void {
    this.composition = { selection: this.isEditable() ? this.getSelection() : null, rangeNoted: false };
  }

  noteCompositionRange(selection: EditorSelection): void {
    const composition = this.composition;
    // Only the first report counts: later ones describe a DOM the browser has already changed.
    if (composition === null || composition.rangeNoted || composition.selection === null) return;
    composition.rangeNoted = true;
    composition.selection = selection;
  }

  endComposition(text: string): void {
    const composition = this.composition;
    if (composition === null) return;
    this.composition = null;
    const selection = composition.selection;
    // Whatever the browser wrote into the paragraph while composing is discarded.
    this.rebuild(selection);
    if (selection === null) return;
    // An empty result is a cancelled composition: the text it would have replaced stays as it was.
    if (text === "") this.place(selection.anchor, selection.focus);
    else this.insertText(text, selection);
  }

  repair(): void {
    const selection = this.validSelection(this.lastSelection);
    this.rebuild(selection);
    if (selection !== null) this.place(selection.anchor, selection.focus);
  }

  selectionMoved(): void {
    if (this.view === null || this.composition !== null || this.applying) return;
    const selection = this.liveSelection();
    if (selection === null || sameSelection(selection, this.lastSelection)) return;
    this.lastSelection = selection;
    this.pendingFormat = null;
    // Typing somewhere else starts a new undo step.
    this.session.sealUndoStep();
    this.publish();
    this.announceSelection();
  }

  /** A click on decoration (a numbering label, a paragraph mark): the caret goes beside it. */
  placeAt(node: Node): void {
    const selection = this.selectionOfRange({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 0 });
    if (selection === null || this.view === null) return;
    this.view.content.focus();
    this.pendingFormat = null;
    this.session.sealUndoStep();
    this.place(selection.focus, selection.focus);
  }

  focusChanged(focused: boolean): void {
    this.focused = focused;
    this.publish();
  }

  openLink(href: string): void {
    if (this.options.onOpenLink !== undefined) this.options.onOpenLink(href);
    else this.view?.content.ownerDocument.defaultView?.open(href, "_blank", "noopener,noreferrer");
  }

  // ---------------------------------------------------------------- view

  scrollTo(target: BlockId | SelectionTarget, options: ScrollOptions = {}): boolean {
    return this.view !== null && scrollIntoView(this.view, this.index, target, options);
  }

  setHighlights(layer: string, highlights: readonly EditorHighlight[]): void {
    this.highlights.set(layer, highlights);
    this.applyHighlights();
  }

  clearHighlights(layer?: string): void {
    this.highlights.clear(layer);
    this.applyHighlights();
  }

  getBlockElement(blockId: BlockId): HTMLElement | null {
    return this.view?.element(blockId) ?? null;
  }

  getRangeRects(range: TextRange): DOMRect[] {
    return this.view === null ? [] : rangeRects(this.view, this.index, range);
  }
}
