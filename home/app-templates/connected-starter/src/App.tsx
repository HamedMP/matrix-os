import { useMemo, useState } from "react";
import { Editor, EvidenceDrawer, ImportDialog } from "./Dialogs";
import { exportRecords, filterRecords } from "./model";
import { useRecords } from "./useRecords";
import Sidebar from "./Sidebar";
import WorkspaceContent from "./WorkspaceContent";
import type { Definition, OwnerRecord } from "./types";
export default function App({ app }: { app: Definition }) {
  const { records, error, loading, limited, reload, save, archive } =
    useRecords();
  const canUseRecords = !!window.MatrixOS?.db,
    canImport =
      canUseRecords &&
      !!window.MatrixOS?.generate &&
      !!window.MatrixOS?.integrations;
  const unavailable = !canUseRecords
    ? "The app connection is not ready. Reopen the app in Matrix to use saved records and imports."
    : app.services.length && !canImport
      ? "The import connection is not ready. Reopen the app in Matrix or use manual entries."
      : "";
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState<"all" | "personal" | "work">("all"),
    [account, setAccount] = useState(""),
    [editor, setEditor] = useState<OwnerRecord | null | undefined>(undefined),
    [evidence, setEvidence] = useState<OwnerRecord | null>(null),
    [importing, setImporting] = useState(false),
    [exportError, setExportError] = useState("");
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
        <WorkspaceContent
          app={app}
          records={records}
          visible={visible}
          creationScope={scope === "all" ? (app.collection === "business" ? "work" : "personal") : scope}
          error={error}
          exportError={exportError}
          loading={loading}
          limited={limited}
          unavailable={unavailable}
          canUseRecords={canUseRecords}
          onEdit={setEditor}
          onEvidence={setEvidence}
          onAdd={() => setEditor(null)}
          onSave={save}
        />
      </div>
      {editor !== undefined && (
        <Editor
          app={app}
          record={editor ?? undefined}
          onSave={save}
          onArchive={archive}
          onClose={() => setEditor(undefined)}
        />
      )}
      {evidence && (
        <EvidenceDrawer record={evidence} onClose={() => setEvidence(null)} />
      )}
      {importing && (
        <ImportDialog app={app} onClose={() => setImporting(false)} />
      )}
    </div>
  );
}
