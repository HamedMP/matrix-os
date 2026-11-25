/**
 * The Docs app: one document session, the start screen or the open
 * document, the Open and Save dialogs, opening files from the computer (the
 * chooser or a drop on the window), and "Open with" requests from Files.
 */

import { FileText } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { MatrixOSBridge, MatrixOSFiles } from "../../../_shared/matrix-os";
import { AppFrame, EmptyState, FileDropZone, LocalFileError, Spinner, createStartFolderMemory, pickLocalFile, useToast, type StartFolderMemory } from "../../../_shared/office-ui";
import { useSessionState } from "../editor/index";
import { MarkdownDialog, SaveAsDialog, UnsavedDialog } from "./dialogs";
import { DocsWorkspace, type WorkspaceFileCommands } from "./DocsWorkspace";
import { FilePickerDialog } from "./FilePickerDialog";
import { DOCS_ACCEPT } from "./accept";
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
  // The folder the owner last browsed, kept in Docs' own key-value store.
  const folderMemory = useMemo(() => createStartFolderMemory(bridge), [bridge]);
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
  return <DocsHome handles={handles} files={files} author={author} folderMemory={folderMemory} />;
}

interface SaveAsRequest {
  mode: "save" | "copy";
  /** Runs after the document was written (for example: then close it). */
  after?: () => void;
}

function DocsHome({ handles, files, author, folderMemory }: { handles: SessionHandles; files: MatrixOSFiles; author: string; folderMemory: StartFolderMemory | undefined }) {
  const { session } = handles;
  const toast = useToast();
  const state = useSessionState(session);
  const [saveAs, setSaveAs] = useState<SaveAsRequest | null>(null);
  const requestSaveAs = useCallback((after: () => void) => setSaveAs({ mode: "save", after }), []);
  const actions = useDocumentActions(handles, author, { requestSaveAs });
  const recents = useRecentDocuments(handles.recents, state.documentKey);
  const [markdownOpen, setMarkdownOpen] = useState(false);
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

  const { openPath, openLocalFile } = actions;
  const openWithPicker = useCallback(async () => {
    const path = await pickDocument();
    if (path !== null) await openPath(path);
  }, [pickDocument, openPath]);

  const rejectLocal = useCallback(
    (error: unknown) => {
      if (error instanceof LocalFileError) toast.show({ title: "The file could not be opened", description: error.message, tone: "danger" });
      else {
        console.warn("docs: reading a file from the computer failed", error instanceof Error ? error.name : error);
        toast.show({ title: "The file could not be opened", description: "Try again, or choose another file.", tone: "danger" });
      }
    },
    [toast],
  );
  const openFromComputer = useCallback(async () => {
    try {
      const file = await pickLocalFile({ accept: DOCS_ACCEPT });
      if (file !== null) await openLocalFile(file);
    } catch (error) {
      rejectLocal(error);
    }
  }, [openLocalFile, rejectLocal]);

  useOpenRequests(files, (path) => void openPath(path));

  const commands: WorkspaceFileCommands = {
    home: () => void actions.closeDocument(),
    newBlank: () => void actions.newBlank(),
    newFromMarkdown: () => setMarkdownOpen(true),
    openFromMatrix: () => void openWithPicker(),
    openFromComputer: () => void openFromComputer(),
    saveAs: (mode) => setSaveAs({ mode }),
  };

  const copyToMatrix = saveAs?.mode === "copy" && state.source === "local";
  const hasDocument = session.document !== null && state.status !== "empty" && state.status !== "error";
  return (
    <>
      {hasDocument ? (
        <DocsWorkspace session={session} state={state} file={commands} pickDocument={pickDocument} />
      ) : (
        <StartScreen
          files={files}
          folderMemory={folderMemory}
          recents={recents.items}
          recentsLoading={recents.loading}
          onRemoveRecent={recents.remove}
          loading={state.status === "loading"}
          error={state.status === "error" ? state.error : null}
          onTemplate={(id) => void actions.newFromTemplate(id)}
          onOpenLocal={commands.openFromComputer}
          onNewFromMarkdown={commands.newFromMarkdown}
          onOpenPath={(path) => void openPath(path)}
        />
      )}
      <FileDropZone
        accept={DOCS_ACCEPT}
        label="Drop a Word document to open it"
        disabled={state.status === "loading"}
        onFile={(file) => void openLocalFile(file)}
        onReject={rejectLocal}
      />
      <FilePickerDialog open={pickerTitle !== null} title={pickerTitle ?? undefined} files={files} memory={folderMemory} onPick={finishPicker} onClose={() => finishPicker(null)} />
      <MarkdownDialog open={markdownOpen} onClose={() => setMarkdownOpen(false)} onCreate={(markdown) => void actions.newFromMarkdown(markdown)} />
      <SaveAsDialog
        open={saveAs !== null}
        session={session}
        title={copyToMatrix ? "Save a copy to Matrix" : undefined}
        description={copyToMatrix ? "Choose where in your home to keep this document. You then edit it there, and it saves as you work." : undefined}
        onClose={() => setSaveAs(null)}
        onSaved={(path) => {
          const after = saveAs?.after;
          if (copyToMatrix) toast.show({ title: "Saved to Matrix", description: `Now editing ${path}.`, tone: "success" });
          after?.();
        }}
      />
      <UnsavedDialog pending={actions.pending} onSave={() => void actions.savePending()} onDiscard={actions.discardPending} onCancel={actions.cancelPending} />
    </>
  );
}
