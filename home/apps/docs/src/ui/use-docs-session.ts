/**
 * The app's one `DocumentSession`, its recent-documents store, and the
 * actions that replace the active document (open, open from the computer,
 * new, close) with the "unsaved changes" question (Save, Discard, Cancel)
 * when the session refuses to leave the current one, or before closing.
 */

import { useCallback, useEffect, useState } from "react";
import type { MatrixOSBridge } from "../../../_shared/matrix-os";
import { createDocxFromMarkdown } from "../../../_shared/office-engine/docx/index";
import { isOfficeError } from "../../../_shared/office-engine/index";
import { useToast, watchLeave } from "../../../_shared/office-ui";
import { DocumentSession, type LocalFileInput, type OpenResult, type RecentFile, RecentFilesStore } from "../session/index";
import { isDocxPath } from "./file-picker-model";
import { saveForLeave } from "./leave-flow";
import { DOCS_TEMPLATES, type DocsTemplateId, templateMarkdown } from "./templates";

/** Longest Markdown accepted for a new document. */
export const MAX_MARKDOWN_LENGTH = 1_000_000;

export interface SessionHandles {
  session: DocumentSession;
  recents: RecentFilesStore | null;
}

export function useDocsSession(bridge: MatrixOSBridge | undefined, author: string, autosave: boolean): SessionHandles | null {
  const [handles, setHandles] = useState<SessionHandles | null>(null);
  useEffect(() => {
    const files = bridge?.files;
    if (files === undefined) return undefined;
    const recents = bridge?.db === undefined ? null : new RecentFilesStore({ db: bridge.db });
    const session = new DocumentSession({ files, author, recents, autosave });
    setHandles({ session, recents });
    // The shell may remove the window at any moment: save as soon as it loses focus or is hidden.
    const stopLeave =
      typeof window === "undefined"
        ? () => undefined
        : watchLeave(window, {
            flush: () => {
              const state = session.getState();
              if (state.dirty && state.path !== null) void session.flush();
            },
            dirty: () => session.getState().dirty,
            log: (message, error) => console.warn(`[docs] ${message}`, error instanceof Error ? error.name : error),
          });
    return () => {
      stopLeave();
      // Unsaved work of a closing app is saved when possible; the session is then dropped.
      void session.flush().finally(() => session.dispose());
    };
  }, [bridge, author, autosave]);
  return handles;
}

export interface RecentDocuments {
  items: RecentFile[];
  /** True until the first read finished. */
  loading: boolean;
  /** Forgets a document, then reads the list again. */
  remove(path: string): Promise<void>;
}

/** The recent documents, read again whenever another document becomes active. */
export function useRecentDocuments(recents: RecentFilesStore | null, documentKey: number): RecentDocuments {
  const [items, setItems] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState(recents !== null);
  useEffect(() => {
    if (recents === null) return undefined;
    let live = true;
    // The store logs and swallows its own failures and resolves an empty list.
    void recents.list().then((entries) => {
      if (!live) return;
      setItems(entries);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [recents, documentKey]);
  const remove = useCallback(
    async (path: string) => {
      if (recents === null) return;
      // The list shows what the store holds after the delete, so a failed delete keeps the entry.
      try {
        await recents.remove(path);
        setItems(await recents.list());
      } catch (error) {
        console.warn("[docs] forgetting a recent document failed", error instanceof Error ? error.name : error);
      }
    },
    [recents],
  );
  return { items, loading, remove };
}

/** Shown in the unsaved-changes question when Save threw instead of answering. */
export const SAVE_FAILED_MESSAGE = "The document could not be saved. Try again, or discard your changes.";

export type BlockedReason = "unsaved_changes" | "conflict" | "save_failed";

/** The question asked before the current document is left with unsaved changes. */
export interface PendingLeave {
  reason: BlockedReason;
  /** Name of the document being left. */
  name: string;
  /** True for a document from the computer: Save downloads it. */
  local: boolean;
  /** A save is running. */
  busy: boolean;
  /** Why the last Save failed, safe to show. */
  error: string | null;
}

export interface DocumentActions {
  openPath(path: string): Promise<void>;
  /** Opens a file from the computer as a local document. */
  openLocalFile(file: LocalFileInput): Promise<void>;
  newBlank(): Promise<void>;
  newFromMarkdown(markdown: string): Promise<void>;
  /** Starts a document from a start-screen template. */
  newFromTemplate(id: DocsTemplateId): Promise<void>;
  /** Back to the start screen (the home button, File > Close). Asks first when there are unsaved changes. */
  closeDocument(): Promise<void>;
  pending: PendingLeave | null;
  /** Saves the document, then continues: back home, or to the document that was asked for. */
  savePending(): Promise<void>;
  /** Drops the unsaved changes and continues. */
  discardPending(): void;
  /** Keeps the document open. */
  cancelPending(): void;
}

export interface DocumentActionOptions {
  /** Asks where in the home to save a new document; `onSaved` runs after it was written. */
  requestSaveAs: (onSaved: () => void) => void;
}

type Attempt = (discardChanges: boolean) => Promise<OpenResult>;

/** What the owner is told when an action threw instead of answering; never the error's own text. */
interface Failure {
  title: string;
  description: string;
}

const OPEN_FAILURE: Failure = { title: "The document could not be opened", description: "Try again, or choose another document." };
const CLOSE_FAILURE: Failure = { title: "The document could not be closed", description: "Try again." };

/** The failure of a new document; Markdown over the engine's limits says so. */
function createFailure(error: unknown): Failure {
  if (isOfficeError(error) && error.code === "limit_exceeded") {
    return { title: "The document could not be created", description: "The Markdown is too large for one document. Split it into smaller documents." };
  }
  return { title: "The document could not be created", description: "Try again." };
}

type FailureOf = (error: unknown) => Failure;
const openFailure: FailureOf = () => OPEN_FAILURE;
const closeFailure: FailureOf = () => CLOSE_FAILURE;

function titleFromMarkdown(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.replace(/[*_`~[\]]/g, "").trim() ?? "";
  const safe = heading.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").slice(0, 80).trim();
  return safe === "" ? "Untitled" : safe;
}

export function useDocumentActions(handles: SessionHandles | null, author: string, options: DocumentActionOptions): DocumentActions {
  const toast = useToast();
  const [pending, setPending] = useState<(PendingLeave & { attempt: Attempt; path: string | null; failure: FailureOf }) | null>(null);
  const session = handles?.session ?? null;
  const recents = handles?.recents ?? null;
  const { requestSaveAs } = options;

  const settle = useCallback(
    (attempt: Attempt, path: string | null, failure: FailureOf, result: OpenResult): void => {
      if (session === null) return;
      if (result.status === "blocked") {
        const state = session.getState();
        setPending({ reason: result.reason, name: state.name, local: state.source === "local", busy: false, error: null, attempt, path, failure });
        return;
      }
      if (result.status !== "error") return;
      if (result.error.code === "not_found" && path !== null) void recents?.remove(path);
      // Without a document the start screen shows the session's error; with one, the document stays open.
      if (session.document !== null) toast.show({ title: "The document could not be opened", description: result.error.message, tone: "danger" });
    },
    [session, recents, toast],
  );

  /** Runs an attempt and settles its answer. A throw (e.g. Markdown the engine refuses) is logged and shown as a fixed message. */
  const attemptAndSettle = useCallback(
    async (attempt: Attempt, path: string | null, failure: FailureOf, discardChanges: boolean): Promise<void> => {
      let result: OpenResult;
      try {
        result = await attempt(discardChanges);
      } catch (error) {
        console.warn("[docs] replacing the document failed", error instanceof Error ? error.name : error);
        toast.show({ ...failure(error), tone: "danger" });
        return;
      }
      settle(attempt, path, failure, result);
    },
    [settle, toast],
  );

  const run = useCallback(
    async (attempt: Attempt, path: string | null, failure: FailureOf): Promise<void> => {
      if (session === null) return;
      await attemptAndSettle(attempt, path, failure, false);
    },
    [session, attemptAndSettle],
  );

  const openPath = useCallback(
    async (path: string) => {
      if (!isDocxPath(path)) {
        toast.show({ title: "Docs opens .docx documents", description: "Open this file with another app.", tone: "warning" });
        return;
      }
      await run((discardChanges) => session!.open(path, { discardChanges }), path, openFailure);
    },
    [run, session, toast],
  );

  const openLocalFile = useCallback((file: LocalFileInput) => run((discardChanges) => session!.openLocal(file, { discardChanges }), null, openFailure), [run, session]);

  const newBlank = useCallback(() => run((discardChanges) => session!.createNew({ discardChanges }), null, createFailure), [run, session]);

  const newFromMarkdown = useCallback(
    async (markdown: string) => {
      const source = markdown.slice(0, MAX_MARKDOWN_LENGTH);
      const title = titleFromMarkdown(source);
      await run((discardChanges) => session!.adopt(createDocxFromMarkdown(source, { title, author }), { name: title, discardChanges }), null, createFailure);
    },
    [run, session, author],
  );

  const newFromTemplate = useCallback(
    async (id: DocsTemplateId) => {
      const template = DOCS_TEMPLATES.find((entry) => entry.id === id);
      const markdown = template === undefined ? null : templateMarkdown(template.id, { author, date: new Date() });
      if (template === undefined || markdown === null) {
        await newBlank();
        return;
      }
      await run((discardChanges) => session!.adopt(createDocxFromMarkdown(markdown, { title: template.name, author }), { name: template.name, discardChanges }), null, createFailure);
    },
    [run, session, author, newBlank],
  );

  const closeDocument = useCallback(async () => {
    if (session === null) return;
    const attempt: Attempt = (discardChanges) => session.close({ discardChanges });
    const state = session.getState();
    // Closing never saves on its own: the owner chooses Save, Discard or Cancel.
    if (state.dirty) {
      setPending({ reason: state.conflict !== null ? "conflict" : "unsaved_changes", name: state.name, local: state.source === "local", busy: false, error: null, attempt, path: null, failure: closeFailure });
      return;
    }
    await run(attempt, null, closeFailure);
  }, [session, run]);

  const savePending = useCallback(async () => {
    if (session === null || pending === null || pending.busy) return;
    const current = pending;
    setPending({ ...current, busy: true, error: null });
    let outcome: Awaited<ReturnType<typeof saveForLeave>>;
    try {
      outcome = await saveForLeave(session);
    } catch (error) {
      console.warn("[docs] saving before leaving failed", error instanceof Error ? error.name : error);
      outcome = { status: "failed", message: SAVE_FAILED_MESSAGE };
    }
    if (outcome.status === "failed") {
      setPending({ ...current, busy: false, error: outcome.message });
      return;
    }
    setPending(null);
    if (outcome.status === "needs-path") requestSaveAs(() => void run(current.attempt, current.path, current.failure));
    else await run(current.attempt, current.path, current.failure);
  }, [session, pending, requestSaveAs, run]);

  const discardPending = useCallback(() => {
    if (pending === null || pending.busy) return;
    const current = pending;
    setPending(null);
    void attemptAndSettle(current.attempt, current.path, current.failure, true);
  }, [pending, attemptAndSettle]);

  const cancelPending = useCallback(() => setPending(null), []);

  const publicPending: PendingLeave | null = pending === null ? null : { reason: pending.reason, name: pending.name, local: pending.local, busy: pending.busy, error: pending.error };
  return { openPath, openLocalFile, newBlank, newFromMarkdown, newFromTemplate, closeDocument, pending: publicPending, savePending, discardPending, cancelPending };
}
