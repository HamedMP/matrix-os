import { useMemo, useState } from "react";
import { Editor, EvidenceDrawer, ImportDialog } from "./Dialogs";
import { exportRecords, filterRecords, readRecords } from "./model";
import { useRecords } from "./useRecords";
import Sidebar from "./Sidebar";
import WorkspaceContent from "./WorkspaceContent";
import { useSync } from "./useSync";
import SyncProgress from "./SyncProgress";
import type { Definition, OwnerRecord } from "./types";
function connectionNotice(records: boolean, connected: boolean, app: Definition) {
  if (!records) return "The app connection is not ready. Reopen the app in Matrix to use saved records and imports.";
  if (app.services.length && !connected) return "The import connection is not ready. Reopen the app in Matrix or use manual entries.";
  return "";
}
export default function App({ app }: { app: Definition }) {
  const { records, error, loading, limited, reload, save, archive } =
    useRecords();
  const canUseRecords = !!window.MatrixOS?.db,
    canImport =
      canUseRecords &&
      !!window.MatrixOS?.gatewayFetch &&
      !!window.MatrixOS?.integrations;
  const sync = useSync(app.id, canImport && app.services.length > 0, reload);
  const unavailable = connectionNotice(canUseRecords, canImport, app);
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState<"all" | "personal" | "work">("all"),
    [account, setAccount] = useState(""),
    [editor, setEditor] = useState<OwnerRecord | null | undefined>(undefined),
    [evidence, setEvidence] = useState<OwnerRecord | null>(null),
    [importing, setImporting] = useState(false),
    [exportError, setExportError] = useState("");
  const creationScope = scope === "all" ? (app.collection === "business" ? "work" : "personal") : scope;
  const visible = useMemo(
    () => filterRecords(records, { query, scope, account }),
    [records, query, scope, account],
  );
  const accounts = useMemo(() => {
    const all = records.flatMap((r) => r.accounts);
    return all
      .filter(
        (a, i) =>
          all.findIndex(
            (b) => b.service === a.service && b.label === a.label,
          ) === i,
      )
      .slice(0, 100);
  }, [records]);
  function download() {
    try {
      const blob = new Blob([exportRecords(app, visible)], {
          type: "text/csv;charset=utf-8",
        }),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `${app.id}-records.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError("");
    } catch (cause) {
      console.error("Record export failed", cause);
      setExportError("Records could not be exported. Try again.");
    }
  }
  return (
    <div className="workbench" data-accent={app.accent} data-app={app.id} data-view={app.view}>
      <Sidebar
        app={app}
        count={canUseRecords ? records.length : null}
        canUseRecords={canUseRecords}
        canImport={canImport}
        accounts={accounts}
        query={query}
        setQuery={setQuery}
        scope={scope}
        setScope={setScope}
        account={account}
        setAccount={setAccount}
        onImport={() => setImporting(true)}
        onAdd={() => setEditor(null)}
      />
      <div className="main-column">
        <header className="topbar">
          <span>
            {app.category}
            <span className="divider">/</span>
            {app.name}
          </span>
          <div>
            <button
              disabled={loading || !canUseRecords}
              onClick={() => void reload()}
            >
              {loading ? "Checking…" : "Check records"}
            </button>
            <button disabled={!visible.length} onClick={download}>
              Export CSV
            </button>
            <button
              className="primary"
              disabled={!canUseRecords}
              onClick={() => setEditor(null)}
            >
              + Add {app.entity}
            </button>
          </div>
        </header>
        <SyncProgress name={app.name} snapshot={sync.snapshot} error={sync.error} busy={sync.busy}
          onRefresh={() => void sync.refresh()} onConfigure={() => setImporting(true)}
          onAction={action => { void sync.action(action).catch(cause => console.warn("Sync action failed", cause)); }} />
        <WorkspaceContent
          app={app}
          records={records}
          visible={visible}
          creationScope={creationScope}
          error={error}
          exportError={exportError}
          loading={loading}
          limited={limited}
          unavailable={unavailable}
          canUseRecords={canUseRecords}
          onEdit={setEditor}
          onEvidence={setEvidence}
          onAdd={() => setEditor(null)}
          onImport={() => setImporting(true)}
          canImport={canImport}
          onSave={save}
        />
      </div>
      {editor !== undefined && (
        <Editor
          app={app}
          record={editor ?? undefined}
          creationScope={creationScope}
          onSave={save}
          onLoadLatest={async draftId => {
            const db = window.MatrixOS?.db;
            if (!db?.findOne) throw new Error("Current record unavailable");
            const row = await db.findOne("records", editor?.rowId ?? draftId);
            return readRecords(row ? [row] : []).find(record => record.id === draftId && !record.archivedAt) ?? null;
          }}
          onArchive={archive}
          onClose={() => setEditor(undefined)}
        />
      )}
      {evidence && (
        <EvidenceDrawer record={evidence} onClose={() => setEvidence(null)} />
      )}
      {importing && (
        <ImportDialog app={app} onClose={() => setImporting(false)} onStart={input => sync.action("start", input)} progress={sync.snapshot} />
      )}
    </div>
  );
}
