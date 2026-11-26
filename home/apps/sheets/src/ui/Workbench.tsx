/**
 * One open workbook: title bar with the way back to the start screen, the
 * menu bar ribbon, grid with name box, sheet tabs, status bar, find and
 * replace and the right panel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AiAccess, AppFrame, aiAccessMessage, useToast, watchLeave } from "../../../_shared/office-ui";
import { SheetGrid, createSheetGridController } from "../grid";
import type { SheetsAi } from "../agent";
import type { SheetSession } from "../session/session";
import { useAssistantState } from "./agent";
import { logFailure } from "./bridge";
import { type Download, type Notify, downloadActiveSheetCsv, downloadWorkbook, saveCopyNow, saveDocument } from "./file-actions";
import { FindReplace } from "./FindReplace";
import { useGridFiltered, useGridSelection, useSessionState } from "./hooks";
import { NameBox } from "./NameBox";
import { AgentPanelSlot, ReviewPanelSlot, useSheetPanels } from "./panel-slots";
import { useReviewState } from "./review";
import { type FileCommands, type PanelId, type SheetCommandContext, type ViewOptions } from "./ribbon/commands";
import { namesFor } from "./ribbon/formula-tools";
import { SheetsRibbon } from "./ribbon/SheetsRibbon";
import { activeStyle } from "./ribbon-commands";
import { SaveBanner } from "./SaveBanner";
import { SheetTabs } from "./SheetTabs";
import { useTabLook } from "./tab-look";
import type { TabLookStore } from "./sheet-tabs-model";
import { StatusBar } from "./StatusBar";
import { SheetsTitleBar } from "./TitleActions";

/** What the app shell does for the workbook: other documents, pickers and choosing a Matrix path. */
export interface WorkbenchFiles {
  newWorkbook(): void;
  openFromMatrix(): void;
  openFromComputer(): void;
  importCsv(): void;
  /** Asks for a Matrix path: to save a workbook without one, or to save a copy of a local one. */
  saveAs(purpose: "save" | "copy"): void;
  /** Back to the start screen, asking first when edits cannot be saved. */
  close(): void;
  /** Lets the shell commit the cell editor before it replaces or closes this workbook. Returns the function that stops it. */
  holdEditor?(session: SheetSession, commit: () => boolean): () => void;
}

export interface WorkbenchProps {
  session: SheetSession;
  tabLooks: TabLookStore;
  /** The model behind the assistant, or null when this host has none. */
  ai: SheetsAi | null;
  /** Whether the owner allowed AI for Sheets. Default `available`. */
  aiAccess?: AiAccess;
  files: WorkbenchFiles;
  download: Download;
}

const DEFAULT_VIEW: ViewOptions = { formulaBar: true, gridlines: true };

export function Workbench({ session, tabLooks, ai, aiAccess = "available", files, download }: WorkbenchProps) {
  const toast = useToast();
  const state = useSessionState(session);
  const controller = useMemo(() => createSheetGridController(session), [session]);
  useEffect(() => {
    controller.attach();
    // A newly opened workbook takes the keyboard straight away.
    controller.focus();
    return () => controller.dispose();
  }, [controller]);
  // Opening another file or closing commits the text still being typed first, and stops when it is refused.
  const { holdEditor } = files;
  useEffect(() => holdEditor?.(session, () => controller.commitEdit()), [holdEditor, session, controller]);
  // The shell may remove the window at any moment: store the cell being typed and save as soon as it loses focus or is hidden.
  useEffect(
    () =>
      watchLeave(window, {
        flush: () => {
          controller.commitEdit();
          void session.flush();
        },
        dirty: () => session.getState().dirty || controller.context.store.getState().edit !== null,
        log: logFailure,
      }),
    [session, controller],
  );
  const reported = useGridSelection(controller);
  const filtered = useGridFiltered(controller);
  const { revision } = state;
  // Right after the active sheet changes (one was removed), the last reported selection may name the old sheet.
  const selection = reported.sheet === state.activeSheetId ? reported : controller.getSelection();
  const style = useMemo(() => {
    void revision; // Formatting changes the style without moving the selection.
    return activeStyle(session, selection);
  }, [session, selection, revision]);
  // `revision` refreshes the list when names change with an edit or reload.
  const names = useMemo(() => (revision >= 0 ? namesFor(session.workbook, selection.sheet) : []), [session, revision, selection.sheet]);
  const [look, setLook] = useTabLook(tabLooks, state.path);
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [view, setViewState] = useState<ViewOptions>(DEFAULT_VIEW);
  const pendingChanges = useMemo(() => (revision >= 0 ? session.sheets().reduce((sum, sheet) => sum + sheet.pendingChangeCount, 0) : 0), [session, revision]);

  const notify: Notify = useCallback((message, tone = "info") => {
    toast.show({ title: message, tone });
  }, [toast]);

  const save = useCallback(() => {
    // Text the editor refused stays there with its message; saving now would leave it out.
    if (!controller.commitEdit()) return;
    void saveDocument(session, download, notify).then((result) => {
      if (result === "needs-path") files.saveAs("save");
    });
  }, [session, controller, download, notify, files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        save();
      } else if (key === "f" || key === "h") {
        event.preventDefault();
        setFind((current) => ({ replace: key === "h" || (current?.replace ?? false) }));
      }
    };
    // Capture, so the shortcuts work while the cell editor has the focus.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  const togglePanel = useCallback((id: PanelId): void => setPanel((current) => (current === id ? null : id)), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const openReview = useCallback(() => setPanel("review"), []);
  const { review, assistant } = useSheetPanels(session, controller, ai, openReview);
  const reviewState = useReviewState(review);
  const assistantBusy = useAssistantState(assistant).busy;
  const aiAvailable = ai !== null && aiAccess === "available";

  const fileCommands: FileCommands = useMemo(() => {
    // A file command runs only once the editor's text is stored: a refused formula keeps the editor open and stops it.
    const commit = (action: () => void) => () => {
      if (controller.commitEdit()) action();
    };
    return {
      newWorkbook: commit(files.newWorkbook),
      openFromMatrix: commit(files.openFromMatrix),
      openFromComputer: commit(files.openFromComputer),
      importCsv: commit(files.importCsv),
      save,
      saveCopy: commit(() => {
        if (session.getState().path === null) files.saveAs("copy");
        else void saveCopyNow(session, controller, notify);
      }),
      downloadXlsx: commit(() => void downloadWorkbook(session, download, notify, "xlsx")),
      downloadCsv: commit(() => void downloadActiveSheetCsv(session, download, notify)),
      close: commit(files.close),
    };
  }, [files, save, session, controller, download, notify]);

  const context = useMemo<Omit<SheetCommandContext, "openFunctionPicker">>(
    () => ({
      controller,
      style,
      review,
      assistant,
      notify,
      file: fileCommands,
      togglePanel,
      openPanel: setPanel,
      view,
      setView: (patch) => setViewState((current) => ({ ...current, ...patch })),
      openFind: (replace) => setFind({ replace }),
    }),
    [controller, style, review, assistant, notify, fileCommands, togglePanel, view],
  );
  const model = useMemo(
    () => ({ state, style, review: reviewState, panel, view, filtered, names, aiAvailable, assistantBusy }),
    [state, style, reviewState, panel, view, filtered, names, aiAvailable, assistantBusy],
  );

  return (
    <AppFrame
      className="sheets-app"
      titleBar={<SheetsTitleBar state={state} pendingChanges={pendingChanges} panel={panel} onHome={fileCommands.close} onSave={save} onPanel={togglePanel} />}
      toolbar={<SheetsRibbon context={context} model={model} />}
      banner={<SaveBanner session={session} state={state} controller={controller} notify={notify} />}
      rightPanel={
        panel === null ? undefined : panel === "review" ? (
          <ReviewPanelSlot review={review} onClose={closePanel} />
        ) : (
          <AgentPanelSlot
            assistant={assistant}
            grid={controller}
            aiAvailable={aiAvailable}
            unavailableMessage={aiAccessMessage(ai === null ? "unavailable" : aiAccess, "Sheets", "sheets")}
            onClose={closePanel}
          />
        )
      }
      rightPanelLabel={panel === "review" ? "Review changes" : "Assistant"}
      statusBar={<StatusBar session={session} state={state} selection={selection} filtered={filtered} />}
    >
      <div className="sheets-main">
        {find !== null && (
          <FindReplace
            session={session}
            controller={controller}
            selection={selection}
            revision={revision}
            showReplace={find.replace}
            onToggleReplace={() => setFind((current) => ({ replace: !(current?.replace ?? false) }))}
            onClose={() => setFind(null)}
            onMessage={notify}
          />
        )}
        <div className={`sheets-grid-host${view.gridlines ? "" : " is-gridless"}${view.formulaBar ? "" : " is-barless"}`}>
          <SheetGrid session={session} controller={controller} showFormulaBar={view.formulaBar} label={`${state.name}, ${session.sheet(state.activeSheetId).name}`} />
          {view.formulaBar && <NameBox controller={controller} selection={selection} revision={revision} onFailure={(message) => notify(message, "warning")} />}
        </div>
        <SheetTabs session={session} activeSheetId={state.activeSheetId} revision={revision} look={look} onLookChange={setLook} onFailure={(message) => notify(message, "warning")} />
      </div>
    </AppFrame>
  );
}
