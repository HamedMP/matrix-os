import Library from "./Library";
import CleanupApproval from "./CleanupApproval";
import CleanupNotice from "./CleanupNotice";
import { useMemo, useState } from "react";
import { filterEditions } from "./model";
import { useEdition } from "./useEdition";
import Reader from "./Reader";
import EditionSidebar from "./Sidebar";
import Setup from "./Setup";
import type { EditionScope, EditionView } from "./types";
import "./edition.css";
export default function Edition() {
  const [view, setView] = useState<EditionView>("latest"),
    [scope, setScope] = useState<EditionScope>("all"),
    [query, setQuery] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [publication, setPublication] = useState(""),
    [setup, setSetup] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  const data = useEdition({ view, scope, query, sourceId });
  const visible = useMemo(
    () =>
      filterEditions(data.messages, data.sources, {
        view,
        scope,
        query,
        sourceId: sourceId || undefined,
      }).filter((m) => !publication || m.publication === publication),
    [data.messages, data.sources, view, scope, query, sourceId, publication],
  );
  function switchView(next: EditionView) {
    setView(next);
    setPublication("");
    setSelected([]);
    data.close();
  }
  return (
    <div className="edition-app" data-app="edition">
      <EditionSidebar
        view={view}
        count={visible.length}
        sourceCount={data.sources.length}
        disabled={!data.available || data.preview || data.offline}
        onView={switchView}
        onSetup={() => setSetup(true)}
      />
      <main className="edition-main">
        <header className="edition-topbar">
          <div>
            <span>Reading</span>
            <span className="edition-topbar-slash">/</span>
            <b>Edition</b>
          </div>
          <div className="edition-topbar-actions">
            <button
              disabled={!data.available || data.preview || data.offline}
              aria-label="Add email account"
              onClick={() => setSetup(true)}
            >
              + Email
            </button>
            <span className="edition-private">◈ Your private reading room</span>
            <button
              disabled={!data.sources.length || data.busy || data.offline}
              onClick={() => void data.sync(sourceId || data.sources[0].id)}
            >
              {data.busy ? "Working…" : "Sync now"} <span>↻</span>
            </button>
          </div>
        </header>
        {data.preview && (
          <div className="edition-preview-banner">
            Fictional preview · no email changes
          </div>
        )}
        {data.offline && (
          <div className="edition-preview-banner">
            {data.downloaded.length
              ? "Offline · downloaded editions are available. Inbox cleanup requires a connection."
              : "Offline · reconnect to your Matrix computer to restore your reading session."}
          </div>
        )}
        {data.error && (
          <div className="edition-alert" role="alert">
            {data.error}{" "}
            <button disabled={data.busy} onClick={() => void data.reload()}>
              Try again
            </button>
          </div>
        )}
        <CleanupNotice data={data} />
        {data.active ? (
          <Reader
            key={data.active.id}
            message={data.active}
            source={data.sources.find((s) => s.id === data.active!.sourceId)}
            busy={data.busy}
            offline={data.offline}
            downloaded={data.downloaded.includes(data.active.id)}
            canDownload={data.canDownload}
            onClose={data.close}
            onReading={data.reading}
            onCorrect={data.correct}
            onDownload={data.download}
            onRemoveDownload={data.removeDownload}
            onExport={data.exportEdition}
            onDelete={data.deleteEdition}
            preview={data.preview}
          />
        ) : (
          <Library
            data={data}
            visible={visible}
            view={view}
            scope={scope}
            query={query}
            sourceId={sourceId}
            publication={publication}
            selected={selected}
            setScope={setScope}
            setQuery={setQuery}
            setSourceId={setSourceId}
            setPublication={setPublication}
            setSelected={setSelected}
            onSetup={() => setSetup(true)}
          />
        )}
      </main>
      {setup && data.bridge && (
        <Setup
          bridge={data.bridge}
          existingSources={data.sources}
          onClose={() => setSetup(false)}
          onConnected={data.reload}
        />
      )}{" "}
      <CleanupApproval data={data} />
    </div>
  );
}
