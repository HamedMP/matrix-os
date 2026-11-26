/**
 * The inner half of the editor: what it holds (the view, the model index, the
 * remembered selection), how it mounts, and how it keeps the DOM in step with
 * the session. `./editor-core.ts` builds the public controller and the input
 * handling on top of it.
 */

import type { BlockId, ParagraphBlock, ResolvedParagraphStyle, RunFormat, TextPosition } from "../../../_shared/office-engine/index";
import type { DocumentChange, DocumentSession } from "../session/index";
import * as commands from "./commands";
import { DocumentView } from "./document-view";
import { EditorStore } from "./editor-store";
import { HighlightLayers } from "./highlights";
import { InputController, type InputTarget } from "./input-controller";
import { ModelIndex } from "./model-index";
import { clampSelection, readSelection, sameSelection, toSelection, writeSelection } from "./selection";
import type { DocumentEditorOptions, EditorSelection, EditorSnapshot, ViewMode } from "./types";
import { revealCaret } from "./viewport";

export type Command = (selection: EditorSelection) => commands.CommandOutcome | null;

export abstract class EditorBase {
  readonly session: DocumentSession;
  protected readonly options: DocumentEditorOptions;
  protected readonly log: (message: string, error: unknown) => void;
  protected view: DocumentView | null = null;
  /** The element the editor is mounted in; it is the scrolling area. */
  protected host: HTMLElement | null = null;
  /** Formatting before each formatting revision, built when the `original` view first needs it. */
  protected formatsBefore: Map<string, Partial<RunFormat>> | null = null;
  /** Paragraph styles before each pending paragraph change, built when the `original` view first needs them. */
  protected stylesBefore: Map<BlockId, ResolvedParagraphStyle> | null = null;
  protected input: InputController | null = null;
  protected index = ModelIndex.empty();
  protected readonly store: EditorStore;
  protected readOnly: boolean;
  protected mode: ViewMode;
  protected focused = false;
  /** The last selection seen inside the document; kept while focus is elsewhere (a toolbar). */
  protected lastSelection: EditorSelection | null = null;
  /** Formatting armed with a collapsed selection, for the text typed next. */
  protected pendingFormat: Partial<RunFormat> | null = null;
  protected composition: { selection: EditorSelection | null; rangeNoted: boolean } | null = null;
  /** The document changed during a composition; render when it ends. */
  protected deferredRender = false;
  /** True while one of the editor's own commands runs: it places the selection itself. */
  protected applying = false;
  protected readonly highlights = new HighlightLayers();
  protected readonly cleanups: Array<() => void> = [];

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
    this.host = host;
    const view = new DocumentView(host, {
      ariaLabel: this.options.ariaLabel ?? "Document",
      formatBefore: (revisionId) => this.formatBefore(revisionId),
      styleBefore: (blockId) => this.styleBefore(blockId),
    });
    this.view = view;
    view.setMode(this.mode);
    this.input = new InputController(view.content, this.inputTarget());
    this.input.attach();
    this.cleanups.push(this.session.onChange((change) => this.onSessionChange(change)));
    this.session.setSelectionSource(() => {
      // While composing, the DOM holds the browser's uncommitted text: the place the composition goes is the one to carry through edits.
      // With the browser selection outside the document (a panel or a toolbar), the remembered one is carried.
      const selection = this.composition !== null ? this.composition.selection : this.getSelection();
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
    this.host = null;
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

  // ---------------------------------------------------------------- selection

  getSelection(): EditorSelection | null {
    return this.liveSelection() ?? this.validSelection(this.lastSelection);
  }

  // ---------------------------------------------------------------- internals

  protected commandHost(): commands.CommandHost {
    return { session: this.session, index: () => this.index, mode: () => this.mode, paragraph: (id) => this.paragraph(id) };
  }

  protected paragraph(id: BlockId): ParagraphBlock | null {
    const block = this.session.document?.getBlock(id) ?? null;
    return block !== null && block.type === "paragraph" ? block : null;
  }

  protected formatBefore(revisionId: string): Partial<RunFormat> | null {
    if (this.formatsBefore === null) {
      this.formatsBefore = new Map();
      for (const revision of this.session.document?.listRevisions() ?? []) {
        if (revision.formatChange !== null) this.formatsBefore.set(revision.id, revision.formatChange.before);
      }
    }
    return this.formatsBefore.get(revisionId) ?? null;
  }

  /**
   * The paragraph style that rejecting the paragraph's pending format change
   * would restore (its `w:pPrChange`), or null when it has none. The engine
   * reads it: the pending paragraph changes are rejected on the open document,
   * which is put back from a snapshot at once, as undo does. A change over
   * several paragraphs records old values for each of them, which
   * `Revision.formatChange` (the first paragraph's) cannot tell apart.
   */
  protected styleBefore(blockId: BlockId): ResolvedParagraphStyle | null {
    if (this.stylesBefore === null) {
      this.stylesBefore = new Map();
      const doc = this.session.document;
      const changes = doc?.listRevisions().filter((revision) => revision.scope === "paragraphFormat") ?? [];
      if (doc !== null && changes.length > 0) {
        const snapshot = doc.snapshot();
        try {
          doc.rejectRevisions(changes.map((revision) => revision.id));
          for (const id of changes.flatMap((revision) => revision.blockIds)) {
            const block = doc.getBlock(id);
            if (block !== null && block.type === "paragraph") this.stylesBefore.set(id, block.style);
          }
        } catch (error) {
          this.log("docs editor: the original paragraph styles could not be read", error);
          this.stylesBefore.clear();
        } finally {
          doc.restore(snapshot);
        }
      }
    }
    return this.stylesBefore.get(blockId) ?? null;
  }

  /** Runs one of the editor's own commands and puts the selection where it says. */
  protected run(command: Command, given?: EditorSelection | null): boolean {
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
    if (this.host !== null) revealCaret(this.host);
    return true;
  }

  protected onSessionChange(change: DocumentChange): void {
    if (this.view === null) return;
    this.formatsBefore = null;
    this.stylesBefore = null;
    if (change.kind === "load" || change.kind === "close") {
      this.highlights.clear();
      this.lastSelection = null;
      this.pendingFormat = null;
      this.composition = null;
    }
    if (this.composition !== null) {
      this.deferredRender = true;
      // Someone else's edit moved the text around the composition: the composed text goes where its place moved to.
      const carried = change.selection;
      const document = this.session.document;
      if (carried !== null && this.composition.selection !== null && document !== null) {
        this.composition.selection = toSelection(ModelIndex.build(document.getView(), this.mode), carried.anchor, carried.focus);
      }
      return;
    }
    const live = this.applying ? null : this.liveSelection();
    const before = this.applying ? null : (change.selection ?? live);
    const structural = change.full || change.createdBlockIds.length > 0 || change.removedBlockIds.length > 0;
    const getBlock = (id: BlockId) => this.session.document?.getBlock(id) ?? null;
    // A table that now shows other rows changes what the index holds: build it again with the view.
    if (structural || !this.view.refresh(change.changedBlockIds, getBlock) || this.index.tableLayoutChanged(change.changedBlockIds, getBlock)) this.renderAll();
    // The owner's selection stays where it was while someone else edits, and returns after undo and redo.
    // When the browser selection is elsewhere, only the remembered one moves: writing the DOM selection would take focus.
    if (before !== null && live !== null) this.place(before.anchor, before.focus);
    else if (before !== null) this.remember(before.anchor, before.focus);
    this.publish();
  }

  /** Renders the whole document and rebuilds everything derived from its structure. */
  protected renderAll(): void {
    const view = this.view;
    if (view === null) return;
    const model = this.session.document?.getView() ?? null;
    this.index = model === null ? ModelIndex.empty() : ModelIndex.build(model, this.mode);
    this.highlights.rebuild(this.index);
    view.setSpans(this.highlights.spans);
    view.setEditable(this.isEditable());
    view.render(model);
    this.deferredRender = false;
  }

  /** Renders the paragraphs of a selection from the model again, whatever the DOM holds now. */
  protected rebuild(selection: EditorSelection | null): void {
    const view = this.view;
    if (view === null) return;
    const ids = selection === null ? [] : this.index.between(selection.start.blockId, selection.end.blockId).map((entry) => entry.id);
    view.invalidate(ids);
    if (this.deferredRender || ids.length === 0 || !view.refresh(ids, (id) => this.session.document?.getBlock(id) ?? null)) {
      if (ids.length === 0) view.invalidate(this.index.paragraphs.map((entry) => entry.id));
      this.renderAll();
    }
  }

  protected applyHighlights(): void {
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
  protected keepingSelection(render: () => void): void {
    const selection = this.liveSelection();
    render();
    if (selection !== null) this.place(selection.anchor, selection.focus);
  }

  protected liveSelection(): EditorSelection | null {
    return this.view === null ? null : readSelection(this.view, this.index);
  }

  /** A remembered selection, when both of its ends still exist. Offsets are clamped. */
  protected validSelection(selection: EditorSelection | null): EditorSelection | null {
    return selection === null ? null : clampSelection(this.index, selection, (id) => this.paragraph(id)?.text.length ?? null);
  }

  /** Moves the DOM selection and records it. */
  protected place(anchor: TextPosition, focus: TextPosition): boolean {
    if (this.view === null || !writeSelection(this.view, this.index, anchor, focus)) return false;
    const selection = toSelection(this.index, anchor, focus);
    const changed = !sameSelection(selection, this.lastSelection);
    this.lastSelection = selection;
    this.publish();
    if (changed) this.announceSelection();
    return true;
  }

  /** Records a selection without touching the DOM selection, for when the browser's is outside the document. */
  protected remember(anchor: TextPosition, focus: TextPosition): void {
    const selection = this.validSelection(toSelection(this.index, anchor, focus));
    const changed = !sameSelection(selection, this.lastSelection);
    this.lastSelection = selection;
    if (changed) this.announceSelection();
  }

  protected announceSelection(): void {
    this.store.announceSelection(this.lastSelection);
  }

  protected publish(): void {
    const selection = this.validSelection(this.lastSelection);
    const activeFormat = selection === null ? null : commands.activeFormat(this.commandHost(), selection, this.pendingFormat);
    this.store.publish({ viewMode: this.mode, readOnly: !this.isEditable(), focused: this.focused, selection, activeFormat });
  }

  /** The object that receives input events: the editor itself. */
  protected abstract inputTarget(): InputTarget;
}
