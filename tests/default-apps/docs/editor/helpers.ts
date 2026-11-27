/**
 * Helpers of the editor tests: mount the editor core on a real engine
 * document in jsdom and drive it with the events a browser sends.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DocxDocument, ParagraphBlock, TableBlock, TextPosition } from "../../../../home/apps/_shared/office-engine/index";
import { createDocx, createDocxFromMarkdown, openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { EditorCore } from "../../../../home/apps/docs/src/editor/index";
import type { DocumentEditorOptions } from "../../../../home/apps/docs/src/editor/index";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { createFakeFiles } from "../session/fakes";

export const OWNER = "Rae Okafor";
export const OTHER = "Sam Lindqvist";
export const DATE = "2026-11-20T09:00:00Z";
const FIXTURES = path.resolve(__dirname, "../../../office/fixtures");

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

export interface Mounted {
  session: DocumentSession;
  editor: EditorCore;
  host: HTMLElement;
  /** The contenteditable surface. */
  content: HTMLElement;
  doc: DocxDocument;
  unmount(): void;
}

export type Source = { paragraphs: string[] } | { markdown: string } | { fixture: string } | { doc: DocxDocument };

export async function mount(source: Source, options: DocumentEditorOptions & { tracking?: boolean } = {}): Promise<Mounted> {
  let doc: DocxDocument;
  if ("paragraphs" in source) doc = createDocx({ paragraphs: source.paragraphs });
  else if ("markdown" in source) doc = createDocxFromMarkdown(source.markdown);
  else if ("fixture" in source) doc = await openDocx(fixtureBytes(source.fixture));
  else doc = source.doc;
  const session = new DocumentSession({ files: createFakeFiles(), author: OWNER, autosave: false, now: () => new Date("2026-11-23T10:15:42.000Z") });
  await session.adopt(doc, { name: "Test", dirty: false });
  if (options.tracking === true) session.setTracking(true);
  const host = document.createElement("div");
  document.body.append(host);
  const editor = new EditorCore(session, { log: () => undefined, ...options });
  editor.mount(host);
  const content = host.querySelector<HTMLElement>(".doc-content");
  if (content === null) throw new Error("the editor did not render its surface");
  return {
    session,
    editor,
    host,
    content,
    doc,
    unmount() {
      editor.unmount();
      host.remove();
      session.dispose();
    },
  };
}

export function bodyParagraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

export function bodyTables(doc: DocxDocument): TableBlock[] {
  return doc.getView().body.blocks.filter((block): block is TableBlock => block.type === "table");
}

/** The paragraphs of one table cell. */
export function cellParagraphs(table: TableBlock, row: number, cell: number): ParagraphBlock[] {
  return (table.rows[row]?.cells[cell]?.blocks ?? []).filter((block): block is ParagraphBlock => block.type === "paragraph");
}

export function paragraph(doc: DocxDocument, id: string): ParagraphBlock {
  const block = doc.getBlock(id);
  if (block === null || block.type !== "paragraph") throw new Error(`no paragraph ${id}`);
  return block;
}

export function at(blockId: string, offset: number): TextPosition {
  return { blockId, offset };
}

/** Places the caret through the editor, as a click would. */
export function caret(mounted: Mounted, blockId: string, offset: number): void {
  if (!mounted.editor.setSelection(at(blockId, offset))) throw new Error("the caret could not be placed");
}

export function select(mounted: Mounted, anchor: TextPosition, focus: TextPosition): void {
  if (!mounted.editor.setSelection({ anchor, focus })) throw new Error("the selection could not be placed");
}

export interface InputInit {
  data?: string | null;
  /** Clipboard content by MIME type, exposed as `dataTransfer`. */
  transfer?: Record<string, string>;
  targetRange?: StaticRangeInit;
}

/** Dispatches the `beforeinput` a browser sends before it would change the DOM. */
export function beforeInput(mounted: Mounted, inputType: string, init: InputInit = {}): InputEvent {
  const event = new InputEvent("beforeinput", { inputType, data: init.data ?? null, bubbles: true, cancelable: true });
  if (init.transfer !== undefined) {
    const transfer = init.transfer;
    Object.defineProperty(event, "dataTransfer", { value: { getData: (type: string) => transfer[type] ?? "" } });
  }
  if (init.targetRange !== undefined) {
    const range = { ...init.targetRange, collapsed: init.targetRange.startContainer === init.targetRange.endContainer && init.targetRange.startOffset === init.targetRange.endOffset };
    Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  }
  mounted.content.dispatchEvent(event);
  return event;
}

/** Types text one character at a time. */
export function type(mounted: Mounted, text: string): void {
  for (const character of text) beforeInput(mounted, "insertText", { data: character });
}

export function keydown(mounted: Mounted, key: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: modifiers.ctrl ?? false, metaKey: modifiers.meta ?? false, shiftKey: modifiers.shift ?? false, bubbles: true, cancelable: true });
  mounted.content.dispatchEvent(event);
  return event;
}

export function finalText(mounted: Mounted): string {
  return mounted.doc.getPlainText({ view: "final" });
}

export function originalText(mounted: Mounted): string {
  return mounted.doc.getPlainText({ view: "original" });
}

/** The caret as the editor reports it; fails when the selection is not collapsed. */
export function caretOf(mounted: Mounted): TextPosition {
  const selection = mounted.editor.getSelection();
  if (selection === null || !selection.collapsed) throw new Error("expected a caret");
  return selection.focus;
}

/** The DOM selection translated back to an engine position, bypassing what the editor remembers. */
export function domCaret(mounted: Mounted): TextPosition | null {
  const selection = document.getSelection();
  if (selection === null || selection.focusNode === null) return null;
  const range = { startContainer: selection.focusNode, startOffset: selection.focusOffset, endContainer: selection.focusNode, endOffset: selection.focusOffset };
  return mounted.editor.selectionOfRange(range)?.focus ?? null;
}
