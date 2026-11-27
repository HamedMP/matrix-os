/**
 * Docs editor: an editable rendering of a `.docx`, driven by the document
 * engine. The engine document held by the `DocumentSession` is the single
 * source of truth; the DOM is output only.
 *
 * ## Use
 *
 * ```tsx
 * import { DocumentEditor, useEditorSnapshot, type DocumentEditorController } from "./editor";
 * import { DocumentSession } from "./session";
 *
 * const session = new DocumentSession({ files: window.MatrixOS.files, author: "Rae Okafor" });
 * await session.open("Documents/plan.docx");
 *
 * const [editor, setEditor] = useState<DocumentEditorController | null>(null);
 * const { selection, activeFormat, viewMode } = useEditorSnapshot(editor);
 * <DocumentEditor session={session} ref={setEditor} />
 * ```
 *
 * `main.tsx` needs no extra import: the component loads `editor.css` itself.
 * The host element fills its parent and scrolls; give the parent a height.
 *
 * ## Controller (`DocumentEditorController`)
 *
 * | Member | Purpose |
 * | --- | --- |
 * | `applyOps(ops, options?)` | Engine operations through the session, then the caret goes where the last one says. |
 * | `insertText`, `insertParagraph`, `deleteSelection`, `paste(content)` | The same commands the keyboard runs, on the current selection. |
 * | `format("bold" \| "italic" \| "underline" \| "strike" \| patch)` | Toggle or set character formatting; with a caret it arms the next typed text. |
 * | `setParagraphStyle(patch)` | Heading level, alignment, indents on the selected paragraphs. |
 * | `undo()`, `redo()` | The session history. |
 * | `getSelection()`, `setSelection(target, { scroll, focus })`, `getSelectedText()` | The selection as engine positions (`TextPosition`, `TextRange`). |
 * | `onSelectionChange(cb)`, `subscribe(cb)` + `getSnapshot()` | Selection and toolbar state (`useEditorSnapshot`). |
 * | `scrollTo(blockId \| position \| range)` | Scroll a block or place into view. |
 * | `setHighlights(layer, ranges)`, `clearHighlights(layer?)` | Paint ranges: `search`, `comment`, `proposal` or any layer name. |
 * | `setViewMode("markup" \| "final" \| "original")` | All markup, final (no markup), or original (read-only). |
 * | `setTracking(on)` | The Track changes toggle (`session.setTracking`). |
 * | `getBlockElement(id)`, `getRangeRects(range)` | DOM anchors for popovers and margin notes. |
 *
 * Edits made elsewhere (`session.apply` by the agent, accepting a revision in
 * a review panel, undo from a toolbar) re-render by themselves and keep the
 * owner's selection in place.
 *
 * ## DOM contract (for styling and hit testing; never write to it)
 *
 * - Block elements carry `data-block-id` and `data-block-type`
 *   (`paragraph`, `table`, `sectionBreak`).
 * - Text spans carry `data-s` and `data-l`: start and length in the
 *   paragraph's markup text.
 * - Tracked changes in the `markup` view: `.doc-rev-insert`, `.doc-rev-delete`,
 *   `.doc-rev-moveFrom`, `.doc-rev-moveTo`, `.doc-rev-format`, each with
 *   `data-revision-id` (or `data-format-revision-id`) and `data-author-color`
 *   (1 to 8). A paragraph with any change has `.doc-changed` (the margin bar);
 *   a changed paragraph mark is `.doc-mark`.
 * - Comment ranges: `.doc-comment` with `data-comment-ids`.
 * - Highlights: `.doc-hl.doc-hl-<layer>` with `data-hl-id`.
 *
 * ## How editing works
 *
 * One contenteditable surface. Every `beforeinput` is cancelled and translated
 * into engine operations at positions computed from the DOM selection
 * (`./position-map.ts`); the session applies them, tracked or not by its
 * Track changes toggle; the changed blocks are rendered again and the caret is
 * put back at the remapped position. IME composition is the one input the
 * browser performs itself: when it ends, the paragraph is rendered from the
 * model again and the composed text is inserted through the engine.
 *
 * ## Behaviour worth knowing
 *
 * - `getSelection()` keeps returning the last selection in the document while
 *   focus is in a toolbar or a side panel, so their commands still apply to it.
 * - In the `final` view pending deletions are hidden and edits leave them
 *   alone; paragraphs joined by a pending change are shown as one line.
 * - Highlight ranges are engine coordinates and do not move when the text
 *   before them changes: set them again after `session.onChange`.
 * - A selection that crosses a table boundary deletes text on both sides but
 *   never removes cells or the table; Backspace after a table does nothing.
 * - Without React: `new EditorCore(session, options)`, `mount(element)`,
 *   `unmount()`. It is the same object the component hands out.
 *
 * ## Limits
 *
 * - The `original` view is read-only.
 * - Pagination is not computed: the document is one continuous sheet of page
 *   width. Images show as placeholders. Headers and footers are shown
 *   read-only (first section, default type).
 * - Drag and drop of text is disabled. Paste keeps text, paragraphs, bold,
 *   italic and underline only.
 * - Lists, indent and colour input types are cancelled; use
 *   `setParagraphStyle` and `format` for what the engine supports.
 */

export { DocumentEditor, useEditorSnapshot, useSessionState } from "./DocumentEditor";
export type { DocumentEditorProps } from "./DocumentEditor";
export { EditorCore } from "./editor-core";
export { EDITOR_ORIGIN } from "./commands";
export { AUTHOR_COLOR_COUNT, authorColorSlot } from "./authors";
export { MAX_HIGHLIGHTS_PER_LAYER, MAX_HIGHLIGHT_LAYERS } from "./highlights";
export { ModelIndex } from "./model-index";
export { domFromOffset, positionFromDom } from "./position-map";
export { MAX_PASTE_CHARACTERS, PASTE_TOO_LARGE, parsePlainText, pasteFits, readClipboard } from "./paste";
export type { PasteContent, PasteSegment, PasteTooLarge } from "./paste";
export type {
  ActiveFormat,
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
