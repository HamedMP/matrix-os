/**
 * Moving between documents: opening from Matrix or from this computer,
 * starting a new workbook, going back to the start screen, and the two
 * questions that can come up on the way (edits that are not saved, and
 * where in Matrix to save).
 *
 * The host saves a Matrix document's edits by itself before it leaves it.
 * Only edits it cannot save (a new workbook, a local document, a failed
 * write) stop the move: the owner then picks Save, Discard or Cancel. A
 * failed save keeps the document open and shows why. Both questions belong
 * to the workbook they were asked for and are dropped when another one is
 * shown (see `useSessionBound`).
 */
import { useCallback } from "react";
import { LocalFileError, type LocalFile, pickLocalFile, useToast } from "../../../_shared/office-ui";
import { type RecentFiles, type SessionHost, fileName } from "../session";
import type { Workbook } from "../session/engine";
import { logFailure } from "./bridge";
import { type Download, describeSave, saveDocument } from "./file-actions";
import { useSessionBound } from "./session-bound";
import { type SheetsTemplateId, buildTemplate, sheetsTemplate } from "./templates";

export type DocumentAction =
  | { kind: "open"; path: string }
  | { kind: "new"; rows?: string[][]; template?: SheetsTemplateId }
  | { kind: "local"; name: string; bytes: Uint8Array }
  | { kind: "close" };

/** What "Open from this computer" and dropping a file accept. */
export const LOCAL_ACCEPT: readonly string[] = [".xlsx", ".csv", ".tsv"];

export interface SaveAsRequest {
  purpose: "save" | "copy";
  /** Runs after the save worked, e.g. the close that asked for it. */
  then: DocumentAction | null;
}

export interface DocumentFlow {
  run(action: DocumentAction, discardUnsaved?: boolean): Promise<void>;
  /** The move waiting on the unsaved-edits question, or null. */
  pending: DocumentAction | null;
  cancelPending(): void;
  discardPending(): void;
  savePending(): Promise<void>;
  saveAs: SaveAsRequest | null;
  requestSaveAs(purpose: "save" | "copy"): void;
  cancelSaveAs(): void;
  /** Resolves with a message when saving failed, or null when it worked. */
  submitSaveAs(path: string): Promise<string | null>;
  /** Opens the system file chooser; call from a click or key handler. */
  openFromComputer(): void;
  openLocalFile(file: LocalFile): void;
  rejectLocalFile(error: LocalFileError): void;
}

/** Name and starting content of a new workbook: imported rows, a template, or blank. */
function newWorkbookOptions(action: { rows?: string[][]; template?: SheetsTemplateId }): { name?: string; template?: () => Workbook | null } {
  if (action.rows) return { name: "Imported.xlsx" };
  const template = action.template === undefined ? null : sheetsTemplate(action.template);
  if (template === null || template.id === "blank") return {};
  return { name: template.name, template: () => buildTemplate(template.id) };
}

export function useDocumentFlow(host: SessionHost, recents: RecentFiles, download: Download): DocumentFlow {
  const toast = useToast();
  const { value: pending, set: setPending, current: currentPending } = useSessionBound<DocumentAction>(host);
  const { value: saveAs, set: setSaveAs, current: currentSaveAs } = useSessionBound<SaveAsRequest>(host);
  const notify = useCallback((message: string, tone: "info" | "success" | "warning" | "danger" = "info") => void toast.show({ title: message, tone }), [toast]);

  const run = useCallback(
    async (action: DocumentAction, discardUnsaved = false): Promise<void> => {
      if (action.kind === "close") {
        // The start screen lists the document it comes back from.
        const session = host.session;
        const path = session?.getState().path ?? null;
        if (path !== null && !discardUnsaved) await recents.touch(path);
        // Another workbook took the window while the list was updated: this Close was not asked for it.
        if (host.session !== session) return;
        // A refused cell editor keeps its text and message on screen: nothing else to ask.
        if ((await host.close({ discardUnsaved })).status === "unsaved") setPending(action);
        return;
      }
      const result =
        action.kind === "open"
          ? await host.open(action.path, { discardUnsaved })
          : action.kind === "local"
            ? await host.openLocal(action.name, action.bytes, { discardUnsaved })
            : await host.openNew({ discardUnsaved, ...newWorkbookOptions(action) });
      if (result.status === "unsaved") {
        setPending(action);
        return;
      }
      // The cell editor refused its text and shows why; the move stops there.
      if (result.status === "editing") return;
      if (result.status === "error") {
        if (action.kind === "open") {
          if (result.code === "not_found") void recents.remove(action.path);
          // With a workbook still open, the error view is not shown: say it here.
          if (host.session !== null) toast.show({ title: `${fileName(action.path)} could not be opened`, description: result.message, tone: "danger" });
        } else if (action.kind === "local") {
          toast.show({ title: `${fileName(action.name)} could not be opened`, description: result.message, tone: "danger" });
        }
        return;
      }
      if (result.status === "opened" && action.kind === "new" && action.rows !== undefined) {
        const session = result.session;
        const imported = session.setInputs(session.getState().activeSheetId, { row: 0, col: 0 }, action.rows, "Import CSV");
        if (!imported.ok) toast.show({ title: "The text could not be imported", description: imported.message, tone: "danger" });
      }
    },
    [host, recents, toast, setPending],
  );

  const savePending = useCallback(async (): Promise<void> => {
    // Read now, not from the render: a question asked for another workbook is never answered for this one.
    const action = currentPending();
    setPending(null);
    const session = host.session;
    if (action === null || session === null) return;
    const result = await saveDocument(session, download, notify);
    if (host.session !== session) return;
    if (result === "saved") await run(action);
    else if (result === "needs-path") setSaveAs({ purpose: "save", then: action });
  }, [currentPending, setPending, setSaveAs, host, download, notify, run]);

  const submitSaveAs = useCallback(
    async (path: string): Promise<string | null> => {
      const session = host.session;
      const request = currentSaveAs();
      if (session === null || request === null) {
        setSaveAs(null);
        return null;
      }
      const outcome = await session.saveAs(path);
      // Another workbook took the window while this one was written: its own question is not answered here.
      if (host.session !== session) return null;
      if (outcome.status === "saved") {
        setSaveAs(null);
        const text = describeSave(outcome);
        if (text !== null) notify(text.message, text.tone);
        if (request.then !== null) await run(request.then);
        return null;
      }
      if (outcome.status === "error") return outcome.code === "exists" ? "A file with that name already exists in this folder." : outcome.message;
      return describeSave(outcome)?.message ?? null;
    },
    [host, currentSaveAs, setSaveAs, notify, run],
  );

  const requestSaveAs = useCallback((purpose: "save" | "copy") => setSaveAs({ purpose, then: null }), [setSaveAs]);
  const rejectLocalFile = useCallback((error: LocalFileError) => notify(error.message, "danger"), [notify]);
  const openLocalFile = useCallback((file: LocalFile) => void run({ kind: "local", name: file.name, bytes: file.bytes }), [run]);

  const openFromComputer = useCallback(() => {
    pickLocalFile({ accept: LOCAL_ACCEPT }).then(
      (file) => {
        if (file !== null) openLocalFile(file);
      },
      (error: unknown) => {
        if (error instanceof LocalFileError) rejectLocalFile(error);
        else logFailure("local file pick failed", error);
      },
    );
  }, [openLocalFile, rejectLocalFile]);

  return {
    run,
    pending,
    cancelPending: () => setPending(null),
    discardPending: () => {
      const action = currentPending();
      setPending(null);
      if (action !== null) void run(action, true);
    },
    savePending,
    saveAs,
    requestSaveAs,
    cancelSaveAs: () => setSaveAs(null),
    submitSaveAs,
    openFromComputer,
    openLocalFile,
    rejectLocalFile,
  };
}
