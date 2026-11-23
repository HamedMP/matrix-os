/**
 * The editor without React: mounts the document view into a host element,
 * wires input to commands, keeps the DOM in step with the session, and
 * implements `DocumentEditorController`.
 */

import type { ApplyResult, BlockId, DocxOp, ParagraphBlock, ParagraphStylePatch, RunFormat, TextPosition, TextRange } from "../../../_shared/office-engine/index";
import type { DocumentChange, DocumentSession, SessionApplyOptions } from "../session/index";
import * as commands from "./commands";
import { DocumentView } from "./document-view";
import { EditorStore } from "./editor-store";
import { HighlightLayers } from "./highlights";
import { InputController, type InputTarget } from "./input-controller";
import { ModelIndex } from "./model-index";
import type { PasteContent } from "./paste";
import { positionFromDom } from "./position-map";
import { domPointOf, domRangeOf, endsOf, readSelection, sameSelection, toSelection, writeSelection } from "./selection";
import type {
  DocumentEditorController,
  DocumentEditorOptions,
  EditorHighlight,
  EditorSelection,
  EditorSnapshot,
  ScrollOptions,
  SelectionTarget,
  SetSelectionOptions,
  ToggleFormat,
  ViewMode,
} from "./types";
import type { StepUnit } from "./visibility";

type Command = (selection: EditorSelection) => commands.CommandOutcome | null;

export class EditorCore implements DocumentEditorController, InputTarget {
  readonly session: DocumentSession;
  private readonly options: DocumentEditorOptions;
  private readonly log: (message: string, error: unknown) => void;
  private view: DocumentView | null = null;
  private input: InputController | null = null;
  private index = ModelIndex.empty();
  private readonly store: EditorStore;
  private readOnly: boolean;
  private mode: ViewMode;
  private focused = false;
  /** The last selection seen inside the document; kept while focus is elsewhere (a toolbar). */
  private lastSelection: EditorSelection | null = null;
  /** Formatting armed with a collapsed selection, for the text typed next. */
  private pendingFormat: Partial<RunFormat> | null = null;
  private composition: { selection: EditorSelection | null } | null = null;
  /** The document changed during a composition; render when it ends. */
  private deferredRender = false;
  /** True while one of the editor's own commands runs: it places the selection itself. */
  private applying = false;
  private readonly highlights = new HighlightLayers();
  private readonly cleanups: Array<() => void> = [];

  constructor(session: DocumentSession, options: DocumentEditorOptions = {}) {
    this.session = session;
    this.options = options;
    this.log = options.log ?? ((message, error) => console.warn(message, error));
    this.mode = options.viewMode ?? "markup";
    this.readOnly = options.readOnly ?? false;
    this.store = new EditorStore({ viewMode: this.mode, readOnly: !this.isEditable(), focused: false, selection: null, activeFormat: null }, this.log);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Renders the document into `host` and starts listening. Safe to call again after `unmount`. */
  mount(host: HTMLElement): void {
    if (this.view !== null) this.unmount();
    host.classList.add("doc-editor");
    const view = new DocumentView(host, {
      ariaLabel: this.options.ariaLabel ?? "Document",
      formatBefore: (revisionId) => this.formatBefore(revisionId),
    });
    this.view = view;
    view.setMode(this.mode);
    this.input = new InputController(view.content, this);
    this.input.attach();
    this.cleanups.push(this.session.onChange((change) => this.onSessionChange(change)));
    this.session.setSelectionSource(() => {
      const selection = this.liveSelection();
      return selection === null ? null : { anchor: selection.anchor, focus: selection.focus };
    });
    this.cleanups.push(() => {
      this.session.setSelectionSource(null);
      this.input?.detach();
      this.input = null;
      view.page.remove();
      host.classList.remove("doc-editor");
    });
    this.renderAll();
    this.publish();
  }

  unmount(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.view = null;
    this.composition = null;
    this.index = ModelIndex.empty();
  }

  // ---------------------------------------------------------------- state

  getSnapshot = (): EditorSnapshot => this.store.getSnapshot();

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void {
    return this.store.onSelectionChange(listener);
  }

  isEditable(): boolean {
    return !this.readOnly && this.mode !== "original" && this.session.document !== null;
  }

  isComposing(): boolean {
    return this.composition !== null;
  }

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

  getSelection(): EditorSelection | null {
    return this.liveSelection() ?? this.validSelection(this.lastSelection);
  }

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

  deleteStep(direction: "backward" | "forward", unit: StepUnit, selection?: EditorSelection | null): boolean {
    return this.run((current) => commands.deleteStep(this.commandHost(), current, direction, unit), selection);
  }

  paste(content: PasteContent): boolean {
    return this.run((selection) => commands.paste(this.commandHost(), selection, content));
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
    this.composition = { selection: this.isEditable() ? this.getSelection() : null };
  }

  endComposition(text: string): void {
    const composition = this.composition;
    if (composition === null) return;
    this.composition = null;
    const selection = composition.selection;
    // Whatever the browser wrote into the paragraph while composing is discarded.
    this.rebuild(selection);
    if (selection === null) return;
    if (text === "" && selection.collapsed) this.place(selection.anchor, selection.focus);
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
    this.publish();
    this.announceSelection();
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
    if (this.view === null) return false;
    let element: Element | null;
    if (typeof target === "string") element = this.view.element(target);
    else {
      const point = domPointOf(this.view, this.index, endsOf(target).focus);
      element = point === null ? null : point.node.nodeType === 1 ? (point.node as Element) : point.node.parentElement;
    }
    if (element === null) return false;
    if (typeof element.scrollIntoView === "function") element.scrollIntoView({ behavior: options.behavior ?? "auto", block: options.block ?? "center" });
    return true;
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
    const domRange = this.view === null ? null : domRangeOf(this.view, this.index, range);
    if (domRange === null || typeof domRange.getClientRects !== "function") return [];
    return Array.from(domRange.getClientRects());
  }

  // ---------------------------------------------------------------- internals

  private commandHost(): commands.CommandHost {
    return { session: this.session, index: () => this.index, mode: () => this.mode, paragraph: (id) => this.paragraph(id) };
  }

  private paragraph(id: BlockId): ParagraphBlock | null {
    const block = this.session.document?.getBlock(id) ?? null;
    return block !== null && block.type === "paragraph" ? block : null;
  }

  private formatBefore(revisionId: string): Partial<RunFormat> | null {
    const revision = this.session.document?.listRevisions().find((candidate) => candidate.id === revisionId);
    return revision?.formatChange?.before ?? null;
  }

  /** Runs one of the editor's own commands and puts the selection where it says. */
  private run(command: Command, given?: EditorSelection | null): boolean {
    if (this.view === null || !this.isEditable() || this.composition !== null) return false;
    const selection = given ?? this.getSelection();
    if (selection === null) return false;
    let outcome: commands.CommandOutcome | null;
    this.applying = true;
    try {
      outcome = command(selection);
    } catch (error) {
      // The engine refused the edit and left the document as it was.
      this.log("docs: the edit could not be applied", error);
      this.applying = false;
      this.rebuild(selection);
      this.place(selection.anchor, selection.focus);
      return false;
    } finally {
      this.applying = false;
    }
    if (outcome === null) return false;
    this.place(outcome.anchor, outcome.focus);
    this.session.noteSelection({ anchor: outcome.anchor, focus: outcome.focus });
    return true;
  }

  private onSessionChange(change: DocumentChange): void {
    if (this.view === null) return;
    if (change.kind === "load" || change.kind === "close") {
      this.highlights.clear();
      this.lastSelection = null;
      this.pendingFormat = null;
      this.composition = null;
    }
    if (this.composition !== null) {
      this.deferredRender = true;
      return;
    }
    const before = this.applying ? null : (change.selection ?? this.liveSelection());
    const structural = change.full || change.createdBlockIds.length > 0 || change.removedBlockIds.length > 0;
    if (structural || !this.view.refresh(change.changedBlockIds, (id) => this.session.document?.getBlock(id) ?? null)) this.renderAll();
    // The owner's selection stays where it was while someone else edits, and returns after undo and redo.
    if (before !== null) this.place(before.anchor, before.focus);
    this.publish();
  }

  /** Renders the whole document and rebuilds everything derived from its structure. */
  private renderAll(): void {
    const view = this.view;
    if (view === null) return;
    const model = this.session.document?.getView() ?? null;
    this.index = model === null ? ModelIndex.empty() : ModelIndex.build(model);
    this.highlights.rebuild(this.index);
    view.setSpans(this.highlights.spans);
    view.setEditable(this.isEditable());
    view.render(model);
    this.deferredRender = false;
  }

  /** Renders the paragraphs of a selection from the model again, whatever the DOM holds now. */
  private rebuild(selection: EditorSelection | null): void {
    const view = this.view;
    if (view === null) return;
    const ids = selection === null ? [] : this.index.between(selection.start.blockId, selection.end.blockId).map((entry) => entry.id);
    view.invalidate(ids);
    if (this.deferredRender || ids.length === 0 || !view.refresh(ids, (id) => this.session.document?.getBlock(id) ?? null)) {
      if (ids.length === 0) view.invalidate(this.index.paragraphs.map((entry) => entry.id));
      this.renderAll();
    }
  }

  private applyHighlights(): void {
    const view = this.view;
    if (view === null) return;
    if (this.composition !== null) {
      this.deferredRender = true;
      return;
    }
    const changed = this.highlights.rebuild(this.index);
    view.setSpans(this.highlights.spans);
    if (changed.length === 0) return;
    this.keepingSelection(() => {
      if (!view.refresh(changed.filter((id) => view.element(id) !== null), (id) => this.session.document?.getBlock(id) ?? null)) this.renderAll();
    });
  }

  /** Runs a re-render and puts the DOM selection back where it was in the document. */
  private keepingSelection(render: () => void): void {
    const selection = this.liveSelection();
    render();
    if (selection !== null) this.place(selection.anchor, selection.focus);
  }

  private liveSelection(): EditorSelection | null {
    return this.view === null ? null : readSelection(this.view, this.index);
  }

  /** A remembered selection, when both of its ends still exist. Offsets are clamped. */
  private validSelection(selection: EditorSelection | null): EditorSelection | null {
    if (selection === null) return null;
    const clamp = (position: TextPosition): TextPosition | null => {
      const block = this.paragraph(position.blockId);
      return block === null ? null : { blockId: block.id, offset: Math.min(position.offset, block.text.length) };
    };
    const anchor = clamp(selection.anchor);
    const focus = clamp(selection.focus);
    return anchor === null || focus === null ? null : toSelection(this.index, anchor, focus);
  }

  /** Moves the DOM selection and records it. */
  private place(anchor: TextPosition, focus: TextPosition): boolean {
    if (this.view === null || !writeSelection(this.view, this.index, anchor, focus)) return false;
    const selection = toSelection(this.index, anchor, focus);
    const changed = !sameSelection(selection, this.lastSelection);
    this.lastSelection = selection;
    this.publish();
    if (changed) this.announceSelection();
    return true;
  }

  private announceSelection(): void {
    this.store.announceSelection(this.lastSelection);
  }

  private publish(): void {
    const selection = this.validSelection(this.lastSelection);
    const activeFormat = selection === null ? null : commands.activeFormat(this.commandHost(), selection, this.pendingFormat);
    this.store.publish({ viewMode: this.mode, readOnly: !this.isEditable(), focused: this.focused, selection, activeFormat });
  }
}
