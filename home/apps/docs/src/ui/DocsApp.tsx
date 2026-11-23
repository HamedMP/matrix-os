/**
 * The Docs app: one document session, the start screen or the open
 * document, the Open dialog, and "Open with" requests from Files.
 */

import { FileText } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { MatrixOSBridge, MatrixOSFiles } from "../../../_shared/matrix-os";
import { AppFrame, EmptyState, Spinner } from "../../../_shared/office-ui";
import { useSessionState } from "../editor/index";
import { MarkdownDialog, SaveAsDialog, UnsavedDialog } from "./dialogs";
import { DocsWorkspace } from "./DocsWorkspace";
import { FilePickerDialog } from "./FilePickerDialog";
import { StartScreen } from "./StartScreen";
import { type SessionHandles, useDocsSession, useDocumentActions, useRecentDocuments } from "./use-docs-session";
import { useOpenRequests } from "./use-open-requests";

export interface DocsAppProps {
  bridge: MatrixOSBridge | undefined;
  /** Author of the owner's revisions and comments. */
  author: string;
  autosave: boolean;
}

export function DocsApp({ bridge, author, autosave }: DocsAppProps) {
  const handles = useDocsSession(bridge, author, autosave);
  const files = bridge?.files;
  if (files === undefined) {
    return (
      <AppFrame title="Docs" titleIcon={<FileText size={18} />}>
        <EmptyState icon={<FileText />} headline="Files are not available here" description="Docs needs access to the files in your home. Open it from the Matrix OS desktop." />
      </AppFrame>
    );
  }
  if (handles === null) {
    return (
      <AppFrame title="Docs" titleIcon={<FileText size={18} />}>
        <Spinner label="Starting Docs" />
      </AppFrame>
    );
  }
  return <DocsHome handles={handles} files={files} author={author} />;
}

function DocsHome({ handles, files, author }: { handles: SessionHandles; files: MatrixOSFiles; author: string }) {
  const { session } = handles;
  const state = useSessionState(session);
  const actions = useDocumentActions(handles, author);
  const recents = useRecentDocuments(handles.recents, state.documentKey);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [pickerTitle, setPickerTitle] = useState<string | null>(null);
  const resolver = useRef<((path: string | null) => void) | null>(null);

  const pickDocument = useCallback(
    (options?: { title?: string }) =>
      new Promise<string | null>((resolve) => {
        resolver.current?.(null);
        resolver.current = resolve;
        setPickerTitle(options?.title ?? "Open a document");
      }),
    [],
  );
  const finishPicker = useCallback((path: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPickerTitle(null);
    resolve?.(path);
  }, []);

  const { openPath } = actions;
  const openWithPicker = useCallback(async () => {
    const path = await pickDocument();
    if (path !== null) await openPath(path);
  }, [pickDocument, openPath]);

  useOpenRequests(files, (path) => void openPath(path));

  const onNew = (kind: "blank" | "markdown") => {
    if (kind === "markdown") setMarkdownOpen(true);
    else void actions.newBlank();
  };

  const hasDocument = session.document !== null && state.status !== "empty" && state.status !== "error";
  return (
    <>
      {hasDocument ? (
        <DocsWorkspace
          session={session}
          state={state}
          onOpen={() => void openWithPicker()}
          onNew={onNew}
          onClose={() => void actions.closeDocument()}
          onSaveAs={() => setSaveAsOpen(true)}
          pickDocument={pickDocument}
        />
      ) : (
        <StartScreen
          recents={recents}
          loading={state.status === "loading"}
          error={state.status === "error" ? state.error : null}
          onNewBlank={() => void actions.newBlank()}
          onOpen={() => void openWithPicker()}
          onNewFromMarkdown={() => setMarkdownOpen(true)}
          onOpenRecent={(path) => void openPath(path)}
        />
      )}
      <FilePickerDialog open={pickerTitle !== null} title={pickerTitle ?? undefined} files={files} onPick={finishPicker} onClose={() => finishPicker(null)} />
      <MarkdownDialog open={markdownOpen} onClose={() => setMarkdownOpen(false)} onCreate={(markdown) => void actions.newFromMarkdown(markdown)} />
      <SaveAsDialog open={saveAsOpen} session={session} onClose={() => setSaveAsOpen(false)} onSaved={() => undefined} />
      <UnsavedDialog reason={actions.pending?.reason ?? null} onCancel={actions.cancelPending} onDiscard={() => actions.pending?.proceed()} />
    </>
  );
}
