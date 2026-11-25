/**
 * Wires the ribbon's actions to the open document: the editor for typing and
 * formatting, the session for table rows, the review controller for changes,
 * and the workspace for panels, find, zoom and the File commands.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RibbonTab } from "../../../../_shared/office-ui";
import { useToast } from "../../../../_shared/office-ui";
import { EDITOR_ORIGIN, type DocumentEditorController, type EditorSnapshot, type ViewMode } from "../../editor/index";
import type { ResolveOutcome, ReviewController, ReviewSnapshot } from "../../review/index";
import type { DocumentSession, SessionState } from "../../session/index";
import type { AssistantRequestId, DocsPanelId } from "../panel-types";
import { caretFormat, documentStyles } from "./caret-format";
import { type ClipboardOutcome, copySelection, noteCopied, pasteText } from "./clipboard";
import { buildDocsRibbon } from "./index";
import { styleChoices } from "./styles-model";
import type { DocsRibbonActions, DocsRibbonState } from "./types";

/** What the workspace owns and the ribbon drives. */
export interface WorkspaceControls {
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  zoom: number;
  setZoom(zoom: number): void;
  findOpen: boolean;
  openFind(): void;
  toggleFind(): void;
  outlineOpen: boolean;
  toggleOutline(): void;
  panel: DocsPanelId | null;
  openPanel(id: DocsPanelId): void;
  togglePanel(): void;
  requestComment(): void;
  requestAssistant(id: AssistantRequestId): void;
}

export type FileControls = Pick<
  DocsRibbonActions,
  "newBlank" | "newFromMarkdown" | "openFromMatrix" | "openFromComputer" | "save" | "saveCopy" | "downloadCopy" | "exportAs" | "close"
>;

export interface UseDocsRibbonInput {
  session: DocumentSession;
  state: SessionState;
  editor: DocumentEditorController | null;
  snapshot: EditorSnapshot;
  review: ReviewController | null;
  /** Bumps on every content change (caret format). */
  contentVersion: number;
  /** Bumps after edits settle (document styles). */
  derivedVersion: number;
  controls: WorkspaceControls;
  file: FileControls;
}

/** What the colour buttons apply before the owner has chosen a colour: red text, yellow highlight. */
const FIRST_COLORS = { font: "#dc2626" as string | null, highlight: "#ffff00" as string | null };

const noSubscription = () => () => undefined;
const noReview = (): ReviewSnapshot | null => null;

export function useDocsRibbon(input: UseDocsRibbonInput): RibbonTab[] {
  const { session, state, editor, snapshot, review, contentVersion, derivedVersion, controls, file } = input;
  const toast = useToast();
  const [colors, setColors] = useState(FIRST_COLORS);
  const reviewState = useSyncExternalStore(review?.subscribe ?? noSubscription, review ? review.getSnapshot : noReview);
  const focusBlock = snapshot.selection?.focus.blockId ?? null;
  const focusOffset = snapshot.selection?.focus.offset ?? 0;
  const inTable = snapshot.activeFormat?.inTable ?? false;
  const caret = useMemo(
    () => caretFormat(session.document, focusBlock === null ? null : { blockId: focusBlock, offset: focusOffset }, inTable),
    // contentVersion stands for the document content.
    [session, focusBlock, focusOffset, inTable, contentVersion],
  );
  const styles = useMemo(() => styleChoices(documentStyles(session.document)), [session, derivedVersion]);

  // Ctrl+C and Ctrl+X in the document count as copied here too, for a later Paste from the ribbon.
  useEffect(() => {
    if (editor === null) return undefined;
    const remember = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".docs-pane") !== null) noteCopied(editor);
    };
    document.addEventListener("copy", remember, true);
    document.addEventListener("cut", remember, true);
    return () => {
      document.removeEventListener("copy", remember, true);
      document.removeEventListener("cut", remember, true);
    };
  }, [editor]);

  const ribbonState: DocsRibbonState = {
    hasEditor: editor !== null,
    editable: editor !== null && !snapshot.readOnly,
    hasSelection: snapshot.selection?.collapsed === false,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    format: snapshot.activeFormat,
    caret,
    styles,
    tracking: state.tracking,
    viewMode: controls.viewMode,
    revisions: { total: reviewState?.items.length ?? 0, shown: reviewState?.visible.length ?? 0 },
    zoom: controls.zoom,
    findOpen: controls.findOpen,
    outlineOpen: controls.outlineOpen,
    panel: controls.panel,
    source: state.source,
    hasPath: state.path !== null,
    saving: state.saveStatus === "saving",
    colors,
  };

  const clipboardResult = (outcome: ClipboardOutcome, key: string, verb: string) => {
    if (outcome === "blocked") toast.show({ title: `${verb} with ${key}`, description: `This window cannot use the clipboard directly. Press ${key} in the document.`, tone: "info" });
    else if (outcome === "own" && verb === "Paste") toast.show({ title: "Pasted the text last copied in this document", description: `For text copied in another app, press ${key}.`, tone: "info" });
    else if (outcome === "own") toast.show({ title: `${verb === "Cut" ? "Cut" : "Copied"} for pasting in this document`, description: `To paste in another app, press ${key} instead.`, tone: "info" });
  };
  const reportResolve = (outcome: ResolveOutcome) => {
    if (!outcome.ok && outcome.reason === "failed") toast.show({ title: "That change could not be applied", description: "The document is unchanged.", tone: "danger" });
  };
  const resolveCurrent = (kind: "accept" | "reject") => {
    if (review === null) return;
    if (review.getSnapshot().current !== null) return reportResolve(kind === "accept" ? review.accept() : review.reject());
    const outcome = kind === "accept" ? review.acceptSelection() : review.rejectSelection();
    // Nothing at the caret: step to the next change, so the next click resolves it.
    if (!outcome.ok && outcome.reason === "nothing") review.next();
    else reportResolve(outcome);
  };
  const tableRow = (where: "above" | "below" | "delete") => {
    const row = caret?.row ?? null;
    if (row === null) return;
    const op =
      where === "delete"
        ? { type: "deleteTableRow" as const, tableId: row.tableId, rowIndex: row.rowIndex }
        : { type: "insertTableRow" as const, tableId: row.tableId, rowIndex: where === "above" ? row.rowIndex : row.rowIndex + 1 };
    try {
      session.apply([op], { origin: EDITOR_ORIGIN });
    } catch (error) {
      console.warn("docs: the table row could not be changed", error instanceof Error ? error.name : error);
      toast.show({ title: "The table could not be changed", description: "The document is unchanged.", tone: "warning" });
    }
    editor?.focus();
  };
  const edit = (run: (target: DocumentEditorController) => boolean | void) => {
    if (editor === null) return;
    run(editor);
    editor.focus();
  };

  const actions: DocsRibbonActions = {
    ...file,
    undo: () => edit((target) => target.undo()),
    redo: () => edit((target) => target.redo()),
    cut: () => editor && void copySelection(editor, true).then((outcome) => clipboardResult(outcome, "Ctrl+X", "Cut")),
    copy: () => editor && void copySelection(editor, false).then((outcome) => clipboardResult(outcome, "Ctrl+C", "Copy")),
    paste: () => editor && void pasteText(editor).then((outcome) => clipboardResult(outcome, "Ctrl+V", "Paste")),
    toggleFormat: (format) => edit((target) => target.format(format)),
    setRunFormat: (patch) => edit((target) => target.format(patch)),
    setFontColor: (color) => {
      setColors((current) => ({ ...current, font: color }));
      edit((target) => target.format({ color }));
    },
    setHighlight: (color) => {
      setColors((current) => ({ ...current, highlight: color }));
      edit((target) => target.format({ highlight: color }));
    },
    setParagraphStyle: (patch) =>
      edit((target) => {
        if (!target.setParagraphStyle(patch)) toast.show({ title: "Could not change the paragraph", description: "Place the cursor in the document first.", tone: "warning" });
      }),
    applyStyle: (id) => {
      const choice = styles.find((style) => style.id === id);
      if (choice === undefined) return;
      edit((target) => {
        if (!target.setParagraphStyle(choice.patch)) {
          toast.show({ title: `Could not apply ${choice.label}`, description: "Place the cursor in the document first, or this document has no such style.", tone: "warning" });
        }
      });
    },
    openFind: controls.openFind,
    toggleFind: controls.toggleFind,
    insertText: (text) => edit((target) => target.insertText(text)),
    insertParagraph: () => edit((target) => target.insertParagraph()),
    insertTableRow: (where) => tableRow(where),
    deleteTableRow: () => tableRow("delete"),
    newComment: controls.requestComment,
    setTracking: (enabled) => editor?.setTracking(enabled),
    setViewMode: controls.setViewMode,
    previousChange: () => review?.previous(),
    nextChange: () => review?.next(),
    acceptChange: () => resolveCurrent("accept"),
    rejectChange: () => resolveCurrent("reject"),
    acceptAll: () => review && reportResolve(review.acceptAll()),
    rejectAll: () => review && reportResolve(review.rejectAll()),
    openPanel: controls.openPanel,
    setZoom: controls.setZoom,
    toggleOutline: controls.toggleOutline,
    togglePanel: controls.togglePanel,
    assistant: controls.requestAssistant,
  };

  return buildDocsRibbon({ state: ribbonState, actions });
}
