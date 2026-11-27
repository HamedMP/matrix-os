/**
 * An open document: title bar with the way back home, the ribbon, outline,
 * editor with defined-term and cross-reference previews, side panels and
 * status bar.
 */

import { FileText } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { AppFrame, DocumentTitleBar, Ribbon, useToast } from "../../../_shared/office-ui";
import { DocumentEditor, type DocumentEditorController, type ViewMode, useEditorSnapshot } from "../editor/index";
import type { DocumentSession, SessionState } from "../session/index";
import type { AssistantStore } from "./agent/assistant-store";
import { ConflictBanner, SaveErrorBanner, StatusBar, TitleBarActions } from "./DocumentChrome";
import { DocumentSlot } from "./document-slot";
import { type ExportFormat, buildExport, downloadFile } from "./exports";
import { FindReplaceBar } from "./FindReplaceBar";
import { useDocVersion } from "./hooks";
import { OutlinePane } from "./OutlinePane";
import { COMPACT_QUERY, NARROW_QUERY, mediaMatches, outlineVisible, useMediaQuery } from "./pane-layout";
import type { AssistantRequest, AssistantRequestId, DocsPanelId } from "./panel-types";
import { ReferenceLayer } from "./ReferenceLayer";
import { useReviewController } from "./review/index";
import { ReviewDocumentLayer } from "./ReviewIntegration";
import { clipboardRefusedNotice } from "./ribbon/clipboard";
import { type FileControls, type WorkspaceControls, useDocsRibbon } from "./ribbon/use-docs-ribbon";
import { SidePanels } from "./SidePanels";

/** Quiet time before outline, references and word count are rebuilt after an edit. */
const DERIVED_DELAY_MS = 250;
const FIND_DELAY_MS = 100;

/** What the app shell does for an open document: leaving it, replacing it, and saving it to the home. */
export interface WorkspaceFileCommands {
  /** Back to the start screen; asks first when there are unsaved changes. */
  home(): void;
  newBlank(): void;
  newFromMarkdown(): void;
  openFromMatrix(): void;
  openFromComputer(): void;
  /** Asks where in the home to save: `save` for a new document, `copy` for a copy of a local one. */
  saveAs(mode: "save" | "copy"): void;
}

/** The answer of a save or reload, or null (logged) when it threw instead of answering. */
async function settled<T>(work: Promise<T>, action: string): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    console.warn(`docs: ${action} failed`, error instanceof Error ? error.name : error);
    return null;
  }
}

export interface DocsWorkspaceProps {
  session: DocumentSession;
  state: SessionState;
  file: WorkspaceFileCommands;
  pickDocument: (options?: { title?: string }) => Promise<string | null>;
}

export function DocsWorkspace({ session, state, file, pickDocument }: DocsWorkspaceProps) {
  const toast = useToast();
  const [editor, setEditor] = useState<DocumentEditorController | null>(null);
  const snapshot = useEditorSnapshot(editor);
  const [viewMode, setViewMode] = useState<ViewMode>("markup");
  const [zoom, setZoom] = useState(100);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(() => !mediaMatches(COMPACT_QUERY));
  const [panel, setPanel] = useState<DocsPanelId | null>(null);
  const [assistantRequest, setAssistantRequest] = useState<AssistantRequest | null>(null);
  const [composeComment, setComposeComment] = useState(false);
  const [ribbonTab, setRibbonTab] = useState("home");
  const [ribbonCollapsed, setRibbonCollapsed] = useState(false);
  const lastPanel = useRef<DocsPanelId>("review");
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const derivedVersion = useDocVersion(session, DERIVED_DELAY_MS);
  const findVersion = useDocVersion(session, FIND_DELAY_MS);
  const contentVersion = useDocVersion(session, 0);
  const review = useReviewController(session, editor);
  // The Assistant's conversation outlives its tab and the side panel; it ends with the document.
  const [assistantSlot] = useState(() => new DocumentSlot<AssistantStore>());
  useEffect(() => {
    // The kept store follows undo and Review while its panel is not shown.
    const stop = session.onChange((change) => assistantSlot.current()?.documentChanged(change));
    return () => {
      stop();
      assistantSlot.clear();
    };
  }, [session, assistantSlot]);

  const save = useCallback(async () => {
    const current = session.getState();
    if (current.source === "matrix" && current.path === null) {
      file.saveAs("save");
      return;
    }
    const result = await settled(session.save(), "save");
    if (result === null) toast.show({ title: "The document could not be saved", description: "Try again.", tone: "danger" });
    else if (result.status === "downloaded") toast.show({ title: `Downloaded ${result.name}`, description: "The updated file is in this computer's downloads.", tone: "success" });
    else if (result.status === "error") console.warn("docs: save failed", result.error.code);
  }, [session, file, toast]);

  const saveCopy = useCallback(async () => {
    const current = session.getState();
    if (current.source === "local" || current.path === null) {
      file.saveAs(current.source === "local" ? "copy" : "save");
      return;
    }
    const result = await settled(session.saveCopy(), "save a copy");
    if (result === null) toast.show({ title: "The copy could not be saved", description: "Try again.", tone: "danger" });
    else if (result.status === "saved") toast.show({ title: "Saved a copy", description: `Now editing ${result.path}. The original file was not changed.`, tone: "success" });
  }, [session, file, toast]);

  const downloadCopy = useCallback(async () => {
    const result = await settled(session.downloadCopy(), "download a copy");
    if (result === null) toast.show({ title: "The download could not start", description: "Try again.", tone: "danger" });
    else if (result.status === "error") toast.show({ title: "The download could not start", description: result.error.message, tone: "danger" });
  }, [session, toast]);

  const reload = useCallback(async () => {
    const result = await settled(session.reload(), "reload");
    if (result === null) toast.show({ title: "The file could not be reloaded", description: "Try again.", tone: "danger" });
    else if (result.status === "error") toast.show({ title: "The file could not be reloaded", description: result.error.message, tone: "danger" });
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
  const closePanel = () => {
    if (panel !== null) lastPanel.current = panel;
    setPanel(null);
  };
  const togglePanel = () => (panel === null ? setPanel(lastPanel.current) : closePanel());
  // A narrow window shows the outline or the side panel, not both.
  const narrow = useMediaQuery(NARROW_QUERY);
  const outlineShown = outlineVisible(outlineOpen, panel !== null, narrow);
  const toggleOutline = () => {
    if (outlineShown) return setOutlineOpen(false);
    setOutlineOpen(true);
    if (narrow) closePanel();
  };

  const controls: WorkspaceControls = {
    viewMode,
    setViewMode,
    zoom,
    setZoom,
    findOpen,
    openFind,
    toggleFind: () => (findOpen ? setFindOpen(false) : openFind()),
    outlineOpen: outlineShown,
    toggleOutline,
    panel,
    openPanel: setPanel,
    togglePanel,
    requestComment: () => {
      setPanel("review");
      setComposeComment(true);
    },
    requestAssistant: (id: AssistantRequestId) => {
      setPanel("assistant");
      setAssistantRequest({ id });
    },
  };
  const fileControls: FileControls = {
    newBlank: file.newBlank,
    newFromMarkdown: file.newFromMarkdown,
    openFromMatrix: file.openFromMatrix,
    openFromComputer: file.openFromComputer,
    save: () => void save(),
    saveCopy: () => void saveCopy(),
    downloadCopy: () => void downloadCopy(),
    exportAs,
    close: file.home,
  };
  const tabs = useDocsRibbon({ session, state, editor, snapshot, review, contentVersion, derivedVersion, controls, file: fileControls });

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
  const showBanner = state.conflict !== null || state.saveStatus === "error" || findOpen;
  const banner = (
    <>
      {state.conflict !== null && <ConflictBanner onReload={() => void reload()} onSaveCopy={() => void saveCopy()} />}
      {state.conflict === null && state.saveStatus === "error" && state.saveError !== null && <SaveErrorBanner message={state.saveError.message} onRetry={() => void save()} />}
      {findOpen && (
        <FindReplaceBar
          key={state.documentKey}
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
        titleBar={
          <DocumentTitleBar appName="Docs" onHome={file.home} name={state.name} leading={<FileText size={16} />} actions={<TitleBarActions state={state} onSave={() => void save()} />} />
        }
        toolbar={
          <Ribbon
            label="Document ribbon"
            tabs={tabs}
            activeTab={ribbonTab}
            onTabChange={setRibbonTab}
            collapsed={ribbonCollapsed}
            onToggleCollapsed={() => setRibbonCollapsed((value) => !value)}
          />
        }
        banner={showBanner ? banner : undefined}
        leftRail={outlineShown ? <OutlinePane session={session} editor={editor} docVersion={derivedVersion} caretBlockId={caretBlockId} /> : undefined}
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
              setViewMode={setViewMode}
              onClose={closePanel}
              assistantRequest={assistantRequest}
              onAssistantRequestHandled={() => setAssistantRequest(null)}
              assistantSlot={assistantSlot}
              composeComment={composeComment}
              onComposeHandled={() => setComposeComment(false)}
            />
          )
        }
        rightPanelLabel="Review, assistant and compare"
        statusBar={<StatusBar session={session} state={state} docVersion={derivedVersion} />}
      >
        <div ref={setPane} className="docs-pane" style={{ "--docs-zoom": zoom / 100 } as CSSProperties}>
          <DocumentEditor
            session={session}
            ref={setEditor}
            viewMode={viewMode}
            ariaLabel="Document"
            onClipboardRefused={(kind) => toast.show({ ...clipboardRefusedNotice(kind), tone: "warning" })}
          />
          <ReferenceLayer key={state.documentKey} session={session} editor={editor} docVersion={derivedVersion} container={pane} />
          <ReviewDocumentLayer controller={review} container={pane} readOnly={readOnly} onRequestComment={controls.requestComment} />
        </div>
      </AppFrame>
    </div>
  );
}
