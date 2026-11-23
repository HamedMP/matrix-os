/**
 * The app's one `DocumentSession`, its recent-documents store, and the
 * actions that replace the active document (open, new, close) with the
 * "unsaved changes" question when the session refuses to leave the current one.
 */

import { useCallback, useEffect, useState } from "react";
import type { MatrixOSBridge } from "../../../_shared/matrix-os";
import { createDocxFromMarkdown } from "../../../_shared/office-engine/docx/index";
import { useToast, watchLeave } from "../../../_shared/office-ui";
import { DocumentSession, type OpenResult, type RecentFile, RecentFilesStore } from "../session/index";
import { isDocxPath } from "./file-picker-model";

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

/** The recent documents, read again whenever another document becomes active. */
export function useRecentDocuments(recents: RecentFilesStore | null, documentKey: number): RecentFile[] {
  const [list, setList] = useState<RecentFile[]>([]);
  useEffect(() => {
    if (recents === null) return undefined;
    let live = true;
    // The store logs and swallows its own failures and resolves an empty list.
    void recents.list().then((entries) => {
      if (live) setList(entries);
    });
    return () => {
      live = false;
    };
  }, [recents, documentKey]);
  return list;
}

export type BlockedReason = "unsaved_changes" | "conflict" | "save_failed";

export interface PendingReplace {
  reason: BlockedReason;
  /** Runs the action again, dropping the current document's unsaved changes. */
  proceed: () => void;
}

export interface DocumentActions {
  openPath(path: string): Promise<void>;
  newBlank(): Promise<void>;
  newFromMarkdown(markdown: string): Promise<void>;
  closeDocument(): Promise<void>;
  pending: PendingReplace | null;
  cancelPending(): void;
}

type Attempt = (discardChanges: boolean) => Promise<OpenResult>;

function titleFromMarkdown(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.replace(/[*_`~[\]]/g, "").trim() ?? "";
  const safe = heading.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").slice(0, 80).trim();
  return safe === "" ? "Untitled" : safe;
}

export function useDocumentActions(handles: SessionHandles | null, author: string): DocumentActions {
  const toast = useToast();
  const [pending, setPending] = useState<PendingReplace | null>(null);
  const session = handles?.session ?? null;
  const recents = handles?.recents ?? null;

  const run = useCallback(
    async (attempt: Attempt, path: string | null): Promise<void> => {
      if (session === null) return;
      const settle = (result: OpenResult): void => {
        if (result.status === "blocked") {
          setPending({
            reason: result.reason,
            proceed: () => {
              setPending(null);
              void attempt(true).then(settle);
            },
          });
          return;
        }
        if (result.status !== "error") return;
        if (result.error.code === "not_found" && path !== null) void recents?.remove(path);
        // Without a document the start screen shows the session's error; with one, the document stays open.
        if (session.document !== null) toast.show({ title: "The document could not be opened", description: result.error.message, tone: "danger" });
      };
      settle(await attempt(false));
    },
    [session, recents, toast],
  );

  const openPath = useCallback(
    async (path: string) => {
      if (!isDocxPath(path)) {
        toast.show({ title: "Docs opens .docx documents", description: "Open this file with another app.", tone: "warning" });
        return;
      }
      await run((discardChanges) => session!.open(path, { discardChanges }), path);
    },
    [run, session, toast],
  );

  const newBlank = useCallback(() => run((discardChanges) => session!.createNew({ discardChanges }), null), [run, session]);

  const newFromMarkdown = useCallback(
    async (markdown: string) => {
      const source = markdown.slice(0, MAX_MARKDOWN_LENGTH);
      const title = titleFromMarkdown(source);
      await run((discardChanges) => session!.adopt(createDocxFromMarkdown(source, { title, author }), { name: title, discardChanges }), null);
    },
    [run, session, author],
  );

  const closeDocument = useCallback(() => run((discardChanges) => session!.close({ discardChanges }), null), [run, session]);
  const cancelPending = useCallback(() => setPending(null), []);

  return { openPath, newBlank, newFromMarkdown, closeDocument, pending, cancelPending };
}
