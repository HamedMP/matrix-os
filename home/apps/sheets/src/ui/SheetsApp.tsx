/**
 * The Sheets shell: the start screen or the open workbook, opening files
 * that Files asks for (on load and while running), and the dialogs for
 * opening, importing and leaving unsaved edits.
 */
import { Table } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppFrame, Dialog, Spinner, useAiAccess, useToast } from "../../../_shared/office-ui";
import type { OpenRequest } from "../../../_shared/matrix-os";
import { bridgeSheetsAi } from "../agent";
import { SessionHost, createRecentFiles, fileName, type SessionDeps } from "../session";
import { logFailure, type SheetsBridge } from "./bridge";
import { FilePicker } from "./FilePicker";
import { useHostState } from "./hooks";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { OpenError } from "./OpenError";
import { TabLookStore } from "./sheet-tabs-model";
import { StartScreen } from "./StartScreen";
import { Workbench } from "./Workbench";

export interface SheetsAppProps {
  bridge: SheetsBridge;
  /** Overrides for the session (timers, clock, autosave delay), for tests. */
  sessionDeps?: Partial<SessionDeps>;
  /** A host made by the caller, for tests that read the open session. */
  host?: SessionHost;
}

type Action = { kind: "open"; path: string } | { kind: "new"; rows?: string[][] } | { kind: "close" };

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

export function SheetsApp({ bridge, sessionDeps, host: givenHost }: SheetsAppProps) {
  const toast = useToast();
  const host = useMemo(() => givenHost ?? new SessionHost({ files: bridge.files, db: bridge.db ?? null, log: logFailure, ...sessionDeps }), [givenHost, bridge, sessionDeps]);
  const recents = useMemo(() => createRecentFiles(bridge.db ?? null, { log: logFailure }), [bridge]);
  const tabLooks = useMemo(() => new TabLookStore(bridge, logFailure), [bridge]);
  const ai = useMemo(() => bridgeSheetsAi({ MatrixOS: bridge }), [bridge]);
  // The host answers only apps the owner allowed: ask before offering the assistant.
  const aiAccess = useAiAccess(bridge, undefined, logFailure);
  const hostState = useHostState(host);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);

  const run = useCallback(
    async (action: Action, discardUnsaved = false): Promise<void> => {
      if (action.kind === "close") {
        if (!(await host.close({ discardUnsaved }))) setPending(action);
        return;
      }
      const result = action.kind === "open" ? await host.open(action.path, { discardUnsaved }) : await host.openNew({ discardUnsaved, name: action.rows ? "Imported.xlsx" : undefined });
      if (result.status === "unsaved") {
        setPending(action);
        return;
      }
      if (result.status === "error" && action.kind === "open") {
        if (result.code === "not_found") void recents.remove(action.path);
        // With a workbook still open, the error view is not shown: say it here.
        if (host.session !== null) toast.show({ title: `${fileName(action.path)} could not be opened`, description: result.message, tone: "danger" });
        return;
      }
      if (result.status === "opened" && action.kind === "new" && action.rows !== undefined) {
        const session = result.session;
        const imported = session.setInputs(session.getState().activeSheetId, { row: 0, col: 0 }, action.rows, "Import CSV");
        if (!imported.ok) toast.show({ title: "The text could not be imported", description: imported.message, tone: "danger" });
      }
    },
    [host, recents, toast],
  );

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

  const session = hostState.session;
  const pendingName = session?.getState().name ?? "this workbook";
  const neverSaved = session?.getState().path === null;
  const dialogs = (
    <>
      <FilePicker
        open={pickerOpen}
        files={bridge.files}
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
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        role="alertdialog"
        size="sm"
        title={`Edits to ${pendingName} are not saved`}
        description={
          neverSaved
            ? "This workbook was never saved. Cancel and use Save to keep it, or discard it."
            : "They could not be written to the file. Cancel to keep working on them, or discard them."
        }
        footer={
          <>
            <button type="button" className="oui-button oui-button--ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="oui-button oui-button--danger"
              onClick={() => {
                const action = pending;
                setPending(null);
                if (action !== null) void run(action, true);
              }}
            >
              Discard edits
            </button>
          </>
        }
      />
    </>
  );

  if (session !== null) {
    return (
      <>
        <Workbench
          key={sessionKey(session)}
          session={session}
          tabLooks={tabLooks}
          ai={ai}
          aiAccess={aiAccess}
          onNew={() => void run({ kind: "new" })}
          onOpen={() => setPickerOpen(true)}
          onClose={() => void run({ kind: "close" })}
        />
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
          opening={hostState.opening}
          onNew={() => void run({ kind: "new" })}
          onOpen={() => setPickerOpen(true)}
          onImport={() => setImportOpen(true)}
          onOpenPath={(path) => void run({ kind: "open", path })}
        />
      )}
      {dialogs}
    </AppFrame>
  );
}
