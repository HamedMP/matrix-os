/**
 * Listens to the editing surface and turns every input into an editor
 * command. The browser is never allowed to change the document DOM itself:
 * `beforeinput` is always cancelled, and what the event asks for is done
 * through the engine instead.
 *
 * The one exception is IME composition, which browsers do not let a page
 * cancel. While it lasts the DOM of the paragraph is left to the browser;
 * when it ends the editor discards that DOM, renders the paragraph from the
 * model again and inserts the composed text (`compositionend.data`) through
 * the engine.
 */

import { type PasteContent, readClipboard } from "./paste";
import { SKIP } from "./render-paragraph";
import type { EditorSelection, ToggleFormat } from "./types";
import type { StepUnit } from "./visibility";

/** What the controller drives. Every method that edits returns false when it did nothing. */
export interface InputTarget {
  isEditable(): boolean;
  isComposing(): boolean;
  /** The selection a DOM range of the surface stands for, or null. */
  selectionOfRange(range: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number }): EditorSelection | null;
  insertText(text: string, selection?: EditorSelection | null): boolean;
  insertParagraph(): boolean;
  /** `reported` is the range the browser would delete, for a delete the model cannot measure (a line). */
  deleteStep(direction: "backward" | "forward", unit: StepUnit, reported?: EditorSelection | null): boolean;
  deleteSelection(): boolean;
  paste(content: PasteContent): boolean;
  toggleFormat(name: ToggleFormat): boolean;
  undo(): boolean;
  redo(): boolean;
  getSelectedText(): string;
  moveInTable(backward: boolean): boolean;
  beginComposition(): void;
  /**
   * The text the composition replaces, as the browser reported it before it
   * first touched the DOM. An IME can take over a word that is already there.
   */
  noteCompositionRange(selection: EditorSelection): void;
  endComposition(text: string): void;
  /** The DOM changed without the editor's doing: render the affected text from the model again. */
  repair(): void;
  selectionMoved(): void;
  /** Puts the caret at the place in the text nearest to a node that is not text. */
  placeAt(node: Node): void;
  focusChanged(focused: boolean): void;
  openLink(href: string): void;
}

/**
 * Characters and words are stepped over in the model, which knows what the
 * view hides. Where a line ends depends on layout, so for line deletes the
 * range the browser reports is used when there is one.
 */
const DELETES: Record<string, { direction: "backward" | "forward"; unit: StepUnit }> = {
  deleteContentBackward: { direction: "backward", unit: "character" },
  deleteContentForward: { direction: "forward", unit: "character" },
  deleteWordBackward: { direction: "backward", unit: "word" },
  deleteWordForward: { direction: "forward", unit: "word" },
  deleteSoftLineBackward: { direction: "backward", unit: "line" },
  deleteSoftLineForward: { direction: "forward", unit: "line" },
  deleteHardLineBackward: { direction: "backward", unit: "line" },
  deleteHardLineForward: { direction: "forward", unit: "line" },
  deleteEntireSoftLine: { direction: "backward", unit: "line" },
  deleteContent: { direction: "backward", unit: "character" },
};

const FORMATS: Record<string, ToggleFormat> = {
  formatBold: "bold",
  formatItalic: "italic",
  formatUnderline: "underline",
  formatStrikeThrough: "strike",
};

const SHORTCUT_FORMATS: Record<string, ToggleFormat> = { b: "bold", i: "italic", u: "underline" };

const COMPOSITION_INPUTS: ReadonlySet<string> = new Set(["insertCompositionText", "deleteCompositionText", "insertFromComposition"]);
// Drops are not pasted: text drops are cancelled at `drop`, and a file drop belongs to the app.
const PASTE_INPUTS: ReadonlySet<string> = new Set(["insertFromPaste", "insertFromPasteAsQuotation", "insertFromYank"]);

type TargetRange = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number; collapsed: boolean };

/** The range the browser would change for this input, when it reports one that is not just the caret. */
function targetSelection(event: InputEvent, target: InputTarget): EditorSelection | null {
  if (typeof event.getTargetRanges !== "function") return null;
  const range = (event.getTargetRanges() as TargetRange[])[0];
  if (range === undefined || range.collapsed) return null;
  const selection = target.selectionOfRange(range);
  return selection === null || selection.collapsed ? null : selection;
}

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types as ArrayLike<string>).includes("Files");
}

export class InputController {
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly surface: HTMLElement,
    private readonly target: InputTarget,
  ) {}

  attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void): void => {
      this.surface.addEventListener(type, handler);
      this.listeners.push(() => this.surface.removeEventListener(type, handler));
    };
    on("beforeinput", (event) => this.onBeforeInput(event));
    on("input", () => this.onInput());
    on("compositionstart", () => this.target.beginComposition());
    on("compositionend", (event) => this.target.endComposition(event.data ?? ""));
    on("keydown", (event) => this.onKeyDown(event));
    on("paste", (event) => this.onPaste(event));
    on("copy", (event) => this.onCopy(event, false));
    on("cut", (event) => this.onCopy(event, true));
    // Dragging text would move document content behind the engine's back.
    on("dragstart", (event) => event.preventDefault());
    // Files dragged in from outside the page go on to the app, which opens them.
    on("drop", (event) => {
      if (!carriesFiles(event)) event.preventDefault();
    });
    on("click", (event) => this.onClick(event));
    on("mousedown", (event) => this.onMouseDown(event));
    on("focusin", () => this.target.focusChanged(true));
    on("focusout", () => this.target.focusChanged(false));
    const doc = this.surface.ownerDocument;
    const moved = (): void => this.target.selectionMoved();
    doc.addEventListener("selectionchange", moved);
    this.listeners.push(() => doc.removeEventListener("selectionchange", moved));
  }

  detach(): void {
    for (const remove of this.listeners.splice(0)) remove();
  }

  private onBeforeInput(event: InputEvent): void {
    const type = event.inputType;
    // Composition input cannot be cancelled; it is reconciled when the composition ends.
    if (this.target.isComposing() || COMPOSITION_INPUTS.has(type)) {
      const replaced = type === "insertCompositionText" ? targetSelection(event, this.target) : null;
      if (replaced !== null) this.target.noteCompositionRange(replaced);
      return;
    }
    event.preventDefault();
    if (type === "historyUndo") {
      this.target.undo();
      return;
    }
    if (type === "historyRedo") {
      this.target.redo();
      return;
    }
    if (!this.target.isEditable()) return;
    const format = FORMATS[type];
    const deletion = DELETES[type];
    if (type === "insertText") this.target.insertText(event.data ?? "");
    else if (type === "insertReplacementText") this.target.insertText(event.data ?? event.dataTransfer?.getData("text/plain") ?? "", targetSelection(event, this.target));
    else if (type === "insertParagraph") this.target.insertParagraph();
    else if (type === "insertLineBreak") this.target.insertText("\n");
    else if (type === "deleteByCut" || type === "deleteByDrag") this.target.deleteSelection();
    else if (deletion !== undefined) this.target.deleteStep(deletion.direction, deletion.unit, deletion.unit === "line" ? targetSelection(event, this.target) : null);
    else if (PASTE_INPUTS.has(type)) this.pasteFrom(event.dataTransfer);
    else if (format !== undefined) this.target.toggleFormat(format);
    // Every other input type (lists, indent, colours, ...) is not supported and stays cancelled.
  }

  private onInput(): void {
    if (this.target.isComposing()) return;
    // An input that could not be cancelled got through.
    this.target.repair();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || this.target.isComposing()) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && !event.altKey) {
      const format = SHORTCUT_FORMATS[key];
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) this.target.redo();
        else this.target.undo();
      } else if (key === "y") {
        event.preventDefault();
        this.target.redo();
      } else if (format !== undefined && !event.shiftKey) {
        event.preventDefault();
        if (this.target.isEditable()) this.target.toggleFormat(format);
      }
      return;
    }
    if (event.key === "Tab" && !event.altKey && this.target.isEditable()) {
      event.preventDefault();
      if (!this.target.moveInTable(event.shiftKey) && !event.shiftKey) this.target.insertText("\t");
    }
  }

  private pasteFrom(source: { getData(type: string): string } | null | undefined): void {
    const content = readClipboard(source);
    if (content !== null) this.target.paste(content);
  }

  private onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    if (this.target.isEditable() && !this.target.isComposing()) this.pasteFrom(event.clipboardData);
  }

  private onCopy(event: ClipboardEvent, cut: boolean): void {
    const text = this.target.getSelectedText();
    if (text === "" || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    if (cut && this.target.isEditable()) this.target.deleteSelection();
  }

  private onMouseDown(event: MouseEvent): void {
    const decoration = (event.target as Element | null)?.closest?.(`[${SKIP}]`) ?? null;
    if (decoration === null || event.button !== 0) return;
    // Decoration cannot hold the caret; without this the click would leave it wherever it was.
    event.preventDefault();
    this.target.placeAt(decoration);
  }

  private onClick(event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest?.("a.doc-link") ?? null;
    if (link === null) return;
    // A document link never navigates the app; Ctrl or Cmd with a click opens it.
    event.preventDefault();
    const href = link.getAttribute("href");
    if (href !== null && (event.ctrlKey || event.metaKey)) this.target.openLink(href);
  }
}
