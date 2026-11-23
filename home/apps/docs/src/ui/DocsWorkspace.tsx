/**
 * An open document: title bar, ribbon, outline, editor with defined-term and
 * cross-reference previews, side panels and status bar.
 */

import { FileText } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useCallback, useRef, useState } from "react";
import { AppFrame, useToast } from "../../../_shared/office-ui";
import { DocumentEditor, type DocumentEditorController, type ViewMode, useEditorSnapshot } from "../editor/index";
import type { DocumentSession, SessionState } from "../session/index";
import { DocsToolbar } from "./DocsToolbar";
import { ConflictBanner, SaveErrorBanner, StatusBar, TitleActions } from "./DocumentChrome";
import { type ExportFormat, buildExport, downloadFile } from "./exports";
import { FindReplaceBar } from "./FindReplaceBar";
import { useDocVersion } from "./hooks";
import { OutlinePane } from "./OutlinePane";
import type { DocsPanelId } from "./panel-types";
import { ReferenceLayer } from "./ReferenceLayer";
import { useReviewController } from "./review-integration";
import { ReviewDocumentLayer } from "./ReviewIntegration";
import { SidePanels } from "./SidePanels";

/** Quiet time before outline, references and word count are rebuilt after an edit. */
const DERIVED_DELAY_MS = 250;
const FIND_DELAY_MS = 100;

export interface DocsWorkspaceProps {
  session: DocumentSession;
  state: SessionState;
  onOpen: () => void;
  onNew: (kind: "blank" | "markdown") => void;
  onClose: () => void;
  /** Opens the save dialog for a document without a path (or for Save a copy of one). */
  onSaveAs: () => void;
  pickDocument: (options?: { title?: string }) => Promise<string | null>;
}

export function DocsWorkspace({ session, state, onOpen, onNew, onClose, onSaveAs, pickDocument }: DocsWorkspaceProps) {
  const toast = useToast();
  const [editor, setEditor] = useState<DocumentEditorController | null>(null);
  const snapshot = useEditorSnapshot(editor);
  const [viewMode, setViewMode] = useState<ViewMode>("markup");
  const [zoom, setZoom] = useState(100);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [panel, setPanel] = useState<DocsPanelId | null>(null);
  const lastPanel = useRef<DocsPanelId>("review");
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const derivedVersion = useDocVersion(session, DERIVED_DELAY_MS);
  const findVersion = useDocVersion(session, FIND_DELAY_MS);
  const review = useReviewController(session, editor);

  const save = useCallback(async () => {
    if (session.getState().path === null) {
      onSaveAs();
      return;
    }
    const result = await session.save();
    if (result.status === "error") console.warn("docs: save failed", result.error.code);
  }, [session, onSaveAs]);

  const saveCopy = useCallback(async () => {
    if (session.getState().path === null) {
      onSaveAs();
      return;
    }
    const result = await session.saveCopy();
    if (result.status === "saved") toast.show({ title: "Saved a copy", description: `Now editing ${result.path}. The original file was not changed.`, tone: "success" });
  }, [session, onSaveAs, toast]);

  const reload = useCallback(async () => {
    const result = await session.reload();
    if (result.status === "error") toast.show({ title: "The file could not be reloaded", description: result.error.message, tone: "danger" });
  }, [session, toast]);

  const exportAs = useCallback(
    (format: ExportFormat) => {
      const doc = session.document;
      if (doc === null) return;
      try {
        downloadFile(buildExport(doc, format, viewMode, session.getState().name));
      } catch (error) {
        console.warn("docs: export failed", error);
        toast.show({ title: "Export failed", description: "The document could not be exported.", tone: "danger" });
      }
    },
    [session, viewMode, toast],
  );

  const openFind = () => {
    setFindOpen(true);
    setFindFocus((value) => value + 1);
  };

  const togglePanel = () => {
    if (panel === null) setPanel(lastPanel.current);
    else {
      lastPanel.current = panel;
      setPanel(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save();
    } else if (key === "f" || key === "h") {
      event.preventDefault();
      openFind();
    }
  };

  const readOnly = snapshot.readOnly && editor !== null;
  const caretBlockId = snapshot.selection?.focus.blockId ?? null;
  const banner = (
    <>
      {state.conflict !== null && <ConflictBanner onReload={() => void reload()} onSaveCopy={() => void saveCopy()} />}
      {state.conflict === null && state.saveStatus === "error" && state.saveError !== null && <SaveErrorBanner message={state.saveError.message} onRetry={() => void save()} />}
      {findOpen && (
        <FindReplaceBar
          session={session}
          editor={editor}
          viewMode={viewMode}
          docVersion={findVersion}
          focusToken={findFocus}
          readOnly={viewMode === "original"}
          onClose={() => {
            setFindOpen(false);
            editor?.focus();
          }}
        />
      )}
    </>
  );

  return (
    // Keyboard shortcuts of the whole document window (Save, Find) bubble up to here.
    <div className="docs-workspace" onKeyDown={onKeyDown}>
      <AppFrame
        title={state.name}
        titleIcon={<FileText size={18} />}
        titleActions={
          <TitleActions
            state={state}
            outlineOpen={outlineOpen}
            panelOpen={panel !== null}
            onSave={() => void save()}
            onSaveCopy={() => void saveCopy()}
            onOpen={onOpen}
            onNew={onNew}
            onClose={onClose}
            onToggleOutline={() => setOutlineOpen((open) => !open)}
            onTogglePanel={togglePanel}
          />
        }
        toolbar={
          <DocsToolbar
            editor={editor}
            state={state}
            activeFormat={snapshot.activeFormat}
            readOnly={readOnly}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            zoom={zoom}
            onZoomChange={setZoom}
            findOpen={findOpen}
            onToggleFind={() => (findOpen ? setFindOpen(false) : openFind())}
            onExport={exportAs}
          />
        }
        banner={state.conflict !== null || state.saveStatus === "error" || findOpen ? banner : undefined}
        leftRail={outlineOpen ? <OutlinePane session={session} editor={editor} docVersion={derivedVersion} caretBlockId={caretBlockId} /> : undefined}
        leftRailLabel="Outline"
        rightPanel={
          panel === null ? undefined : (
            <SidePanels
              active={panel}
              onChange={setPanel}
              session={session}
              editor={editor}
              pickDocument={pickDocument}
              review={review}
              readOnly={readOnly}
              onClose={() => {
                lastPanel.current = panel;
                setPanel(null);
              }}
            />
          )
        }
        rightPanelLabel="Review, assistant and compare"
        statusBar={<StatusBar session={session} state={state} docVersion={derivedVersion} />}
      >
        <div ref={setPane} className="docs-pane" style={{ "--docs-zoom": zoom / 100 } as CSSProperties}>
          <DocumentEditor session={session} ref={setEditor} viewMode={viewMode} ariaLabel="Document" />
          <ReferenceLayer session={session} editor={editor} docVersion={derivedVersion} container={pane} />
          <ReviewDocumentLayer controller={review} container={pane} readOnly={readOnly} />
        </div>
      </AppFrame>
    </div>
  );
}
