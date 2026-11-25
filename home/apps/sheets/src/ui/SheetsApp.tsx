/**
 * The Sheets shell: the start screen or the open workbook, opening files
 * that Files asks for (on load and while running) or that come from this
 * computer (picked or dropped), and the dialogs for opening, importing,
 * saving to Matrix and leaving unsaved edits.
 */
import { Table } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppFrame, FileDropZone, Spinner, createStartFolderMemory, downloadBytes, useAiAccess } from "../../../_shared/office-ui";
import type { OpenRequest } from "../../../_shared/matrix-os";
import { bridgeSheetsAi } from "../agent";
import { SessionHost, createRecentFiles, fileName, type SessionDeps } from "../session";
import { logFailure, type SheetsBridge } from "./bridge";
import { LOCAL_ACCEPT, useDocumentFlow } from "./document-flow";
import type { Download } from "./file-actions";
import { FilePicker } from "./FilePicker";
import { useHostState } from "./hooks";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { OpenError } from "./OpenError";
import { SaveAsDialog } from "./SaveAsDialog";
import { TabLookStore } from "./sheet-tabs-model";
import { StartScreen } from "./StartScreen";
import { UnsavedDialog } from "./UnsavedDialog";
import { Workbench, type WorkbenchFiles } from "./Workbench";

export interface SheetsAppProps {
  bridge: SheetsBridge;
  /** Overrides for the session (timers, clock, autosave delay), for tests. */
  sessionDeps?: Partial<SessionDeps>;
  /** A host made by the caller, for tests that read the open session. */
  host?: SessionHost;
  /** Saves a file on this computer. Default: a download through the browser. */
  download?: Download;
}

/** `openRequest()` hands a request out once, so every mount of the app shares one call per bridge. */
const firstRequests = new WeakMap<object, Promise<OpenRequest | null>>();

function firstOpenRequest(files: SheetsBridge["files"]): Promise<OpenRequest | null> {
  let pending = firstRequests.get(files);
  if (pending === undefined) {
    pending = typeof files.openRequest === "function" ? files.openRequest().catch((error: unknown) => {
      logFailure("open request failed", error);
      return null;
    }) : Promise.resolve(null);
    firstRequests.set(files, pending);
  }
  return pending;
}

const sessionKeys = new WeakMap<object, number>();
let nextSessionKey = 1;

/** A React key per session, so each workbook starts with fresh panels and find state. */
function sessionKey(session: object): number {
  let key = sessionKeys.get(session);
  if (key === undefined) {
    key = nextSessionKey++;
    sessionKeys.set(session, key);
  }
  return key;
}

export function SheetsApp({ bridge, sessionDeps, host: givenHost, download = downloadBytes }: SheetsAppProps) {
  const host = useMemo(() => givenHost ?? new SessionHost({ files: bridge.files, db: bridge.db ?? null, log: logFailure, ...sessionDeps }), [givenHost, bridge, sessionDeps]);
  const recents = useMemo(() => createRecentFiles(bridge.db ?? null, { log: logFailure }), [bridge]);
  const tabLooks = useMemo(() => new TabLookStore(bridge, logFailure), [bridge]);
  // The folder the owner last browsed, kept in Sheets' own key-value store.
  const folderMemory = useMemo(() => createStartFolderMemory(bridge, logFailure), [bridge]);
  const ai = useMemo(() => bridgeSheetsAi({ MatrixOS: bridge }), [bridge]);
  // The host answers only apps the owner allowed: ask before offering the assistant.
  const aiAccess = useAiAccess(bridge, undefined, logFailure);
  const hostState = useHostState(host);
  const flow = useDocumentFlow(host, recents, download);
  const { run, openFromComputer, requestSaveAs } = flow;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void firstOpenRequest(bridge.files).then((request) => {
      if (live && request !== null) void run({ kind: "open", path: request.path });
    });
    const stop = typeof bridge.files.onOpenRequest === "function" ? bridge.files.onOpenRequest((request) => void run({ kind: "open", path: request.path })) : () => undefined;
    return () => {
      live = false;
      stop();
    };
  }, [bridge, run]);

  // Pending edits are written when the window goes away.
  useEffect(() => () => void host.session?.flush(), [host]);

  const files = useMemo<WorkbenchFiles>(
    () => ({
      newWorkbook: () => void run({ kind: "new" }),
      openFromMatrix: () => setPickerOpen(true),
      openFromComputer,
      importCsv: () => setImportOpen(true),
      saveAs: requestSaveAs,
      close: () => void run({ kind: "close" }),
    }),
    [run, openFromComputer, requestSaveAs],
  );

  const session = hostState.session;
  const sessionState = session?.getState() ?? null;
  const dialogs = (
    <>
      <FilePicker
        open={pickerOpen}
        files={bridge.files}
        memory={folderMemory}
        onCancel={() => setPickerOpen(false)}
        onPick={(path) => {
          setPickerOpen(false);
          void run({ kind: "open", path });
        }}
      />
      <ImportCsvDialog
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImport={(rows) => {
          setImportOpen(false);
          void run({ kind: "new", rows });
        }}
      />
      <SaveAsDialog
        key={flow.saveAs === null ? "closed" : `${flow.saveAs.purpose}-${sessionState?.name ?? ""}`}
        open={flow.saveAs !== null && session !== null}
        title={flow.saveAs?.purpose === "copy" ? "Save a copy to Matrix" : "Save workbook"}
        initialName={(sessionState?.name ?? "Untitled.xlsx").replace(/\.(csv|tsv)$/i, ".xlsx")}
        onCancel={flow.cancelSaveAs}
        onSave={flow.submitSaveAs}
      />
      <UnsavedDialog state={sessionState} open={flow.pending !== null} onSave={() => void flow.savePending()} onDiscard={flow.discardPending} onCancel={flow.cancelPending} />
      <FileDropZone accept={LOCAL_ACCEPT} onFile={flow.openLocalFile} onReject={flow.rejectLocalFile} label="Drop a spreadsheet to open it" />
    </>
  );

  if (session !== null) {
    return (
      <>
        <Workbench key={sessionKey(session)} session={session} tabLooks={tabLooks} ai={ai} aiAccess={aiAccess} files={files} download={download} />
        {dialogs}
      </>
    );
  }

  const error = hostState.error;
  return (
    <AppFrame className="sheets-app" title="Sheets" titleIcon={<Table size={18} />}>
      {hostState.opening !== null ? (
        <div className="sheets-opening">
          <Spinner label={`Opening ${fileName(hostState.opening)}`} />
          <span>Opening {fileName(hostState.opening)}</span>
        </div>
      ) : error !== null ? (
        <OpenError code={error.code} path={error.path} onRetry={() => void run({ kind: "open", path: error.path })} onBack={() => void host.close()} />
      ) : (
        <StartScreen
          recents={recents}
          files={bridge.files}
          folderMemory={folderMemory}
          opening={hostState.opening}
          onTemplate={(template) => void run({ kind: "new", template })}
          onOpenLocal={openFromComputer}
          onImport={() => setImportOpen(true)}
          onOpenPath={(path) => void run({ kind: "open", path })}
        />
      )}
      {dialogs}
    </AppFrame>
  );
}
