/**
 * One open workbook: title bar, toolbar, grid with name box, sheet tabs,
 * status bar, find and replace and the right panel.
 */
import { FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppFrame, useToast } from "../../../_shared/office-ui";
import { SheetGrid, createSheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import { FindReplace } from "./FindReplace";
import { type Notify, csvOfActiveSheet, describeSave, downloadText, saveCopyNow, saveNow } from "./file-actions";
import { useGridSelection, useSessionState } from "./hooks";
import { NameBox } from "./NameBox";
import { AgentPanelSlot, ReviewPanelSlot } from "./panel-slots";
import { Ribbon } from "./Ribbon";
import { activeStyle } from "./ribbon-commands";
import { SaveAsDialog } from "./SaveAsDialog";
import { SaveBanner } from "./SaveBanner";
import { SheetTabs } from "./SheetTabs";
import { EMPTY_LOOK, type TabLook, type TabLookStore } from "./sheet-tabs-model";
import { StatusBar } from "./StatusBar";
import { type FileMenuId, type PanelId, TitleActions } from "./TitleActions";

export interface WorkbenchProps {
  session: SheetSession;
  tabLooks: TabLookStore;
  onNew: () => void;
  onOpen: () => void;
  onClose: () => void;
}

/** Tab order and colours of the open file, loaded once per path. */
function useTabLook(store: TabLookStore, path: string | null): [TabLook, (look: TabLook) => void] {
  const [entry, setEntry] = useState<{ path: string | null; look: TabLook }>({ path, look: EMPTY_LOOK });
  useEffect(() => {
    if (path === null) return undefined;
    let live = true;
    void store.load(path).then((look) => {
      if (live) setEntry((current) => (current.path === null && current.look !== EMPTY_LOOK ? { path, look: current.look } : { path, look }));
    });
    return () => {
      live = false;
    };
  }, [store, path]);
  const look = entry.path === path || entry.path === null ? entry.look : EMPTY_LOOK;
  const change = useCallback(
    (next: TabLook) => {
      setEntry({ path, look: next });
      if (path !== null) void store.save(path, next);
    },
    [store, path],
  );
  return [look, change];
}

export function Workbench({ session, tabLooks, onNew, onOpen, onClose }: WorkbenchProps) {
  const toast = useToast();
  const state = useSessionState(session);
  const controller = useMemo(() => createSheetGridController(session), [session]);
  useEffect(() => {
    controller.attach();
    return () => controller.dispose();
  }, [controller]);
  const reported = useGridSelection(controller);
  const { revision } = state;
  // Right after the active sheet changes (one was removed), the last reported selection may name the old sheet.
  const selection = reported.sheet === state.activeSheetId ? reported : controller.getSelection();
  const style = useMemo(() => {
    void revision; // Formatting changes the style without moving the selection.
    return activeStyle(session, selection);
  }, [session, selection, revision]);
  const [look, setLook] = useTabLook(tabLooks, state.path);
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const pendingChanges = useMemo(() => (revision >= 0 ? session.sheets().reduce((sum, sheet) => sum + sheet.pendingChangeCount, 0) : 0), [session, revision]);

  const notify: Notify = useCallback((message, tone = "info") => {
    toast.show({ title: message, tone });
  }, [toast]);

  const save = useCallback(() => {
    if (session.getState().path === null) setSaveAsOpen(true);
    else void saveNow(session, controller, notify);
  }, [session, controller, notify]);

  const onFileMenu = (id: FileMenuId): void => {
    if (id === "new") onNew();
    else if (id === "open") onOpen();
    else if (id === "close") onClose();
    else if (id === "copy") {
      if (session.getState().path === null) setSaveAsOpen(true);
      else void saveCopyNow(session, controller, notify);
    } else if (id === "csv") {
      controller.commitEdit();
      const csv = csvOfActiveSheet(session);
      if (!downloadText(csv.name, csv.text)) notify("This window cannot download files. Save a copy as .csv instead.", "warning");
    }
  };

  const saveAs = async (path: string): Promise<string | null> => {
    controller.commitEdit();
    const outcome = await session.saveAs(path);
    if (outcome.status === "saved") {
      setSaveAsOpen(false);
      const text = describeSave(outcome);
      if (text !== null) notify(text.message, text.tone);
      return null;
    }
    if (outcome.status === "error") return outcome.code === "exists" ? "A file with that name already exists in this folder." : outcome.message;
    return describeSave(outcome)?.message ?? null;
  };

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

  const togglePanel = (id: PanelId): void => setPanel((current) => (current === id ? null : id));
  const closePanel = useCallback(() => setPanel(null), []);
  const panelProps = { session, controller, onClose: closePanel };

  return (
    <AppFrame
      className="sheets-app"
      title={<span className="sheets-title">{state.name}</span>}
      titleIcon={<FileSpreadsheet size={18} />}
      titleActions={<TitleActions state={state} pendingChanges={pendingChanges} panel={panel} onSave={save} onFileMenu={onFileMenu} onPanel={togglePanel} />}
      toolbar={<Ribbon controller={controller} state={state} style={style} onFailure={(message) => notify(message, "warning")} onFind={() => setFind({ replace: false })} />}
      banner={<SaveBanner session={session} state={state} controller={controller} notify={notify} />}
      rightPanel={panel === null ? undefined : panel === "review" ? <ReviewPanelSlot {...panelProps} /> : <AgentPanelSlot {...panelProps} />}
      rightPanelLabel={panel === "review" ? "Review changes" : "Assistant"}
      statusBar={<StatusBar session={session} state={state} selection={selection} filtered={controller.isFiltered} />}
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
        <div className="sheets-grid-host">
          <SheetGrid session={session} controller={controller} label={`${state.name}, ${session.sheet(state.activeSheetId).name}`} />
          <NameBox controller={controller} selection={selection} revision={revision} onFailure={(message) => notify(message, "warning")} />
        </div>
        <SheetTabs session={session} activeSheetId={state.activeSheetId} revision={revision} look={look} onLookChange={setLook} onFailure={(message) => notify(message, "warning")} />
      </div>
      <SaveAsDialog open={saveAsOpen} initialName={state.name} onCancel={() => setSaveAsOpen(false)} onSave={saveAs} />
    </AppFrame>
  );
}
