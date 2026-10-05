"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterMemorySources,
  memoryCollections,
  memoryStatusLabel,
  safeMemoryMessage,
  type MemorySnapshot,
  type MemorySource,
  type MemorySourceKind,
  type MemoryWorkspaceClient,
} from "./model.js";
import { MemoryEmpty } from "./MemoryEmpty.js";
import { MemoryLibrary } from "./MemoryLibrary.js";
import { MemoryIcon } from "./MemoryIcon.js";
import { MemorySearch } from "./MemorySearch.js";
import { MemoryEditor } from "./MemoryEditor.js";
import {
  MemoryImport,
  type MemoryNativeImportAdapter,
} from "./MemoryImport.js";
import { headingStyle, workspaceStyle } from "./styles.js";
export type MemoryWorkspaceProps = {
  client: MemoryWorkspaceClient;
  identity: string;
  onUseInChat?(sourceIds: string[]): Promise<void> | void;
  nativeImport?: MemoryNativeImportAdapter;
  onOpenFiles?(): void;
};
/** Identity-keyed body prevents private state and in-flight results crossing runtime/account boundaries. */
export function MemoryWorkspace(props: MemoryWorkspaceProps) {
  return <WorkspaceBody key={props.identity} {...props} />;
}
function WorkspaceBody({
  client,
  onUseInChat,
  nativeImport,
  onOpenFiles,
}: MemoryWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<
    "library" | "memory" | "compare" | "activity"
  >("library");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const pageCount = useRef(1);
  const [paging, setPaging] = useState(false);
  const [kind, setKind] = useState<MemorySourceKind | "all">("all");
  const [collection, setCollection] = useState<string | null>(null);
  const [source, setSource] = useState<MemorySource | null>(null);
  const [readerBusy, setReaderBusy] = useState(false);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [importing, setImporting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  const live = useRef(true);
  const loadVersion = useRef(0);
  const selectionVersion = useRef(0);
  const sources = useMemo(
    () =>
      snapshot?.filteredSources !== undefined
        ? snapshot.sources
        : filterMemorySources(snapshot?.sources ?? [], kind, collection, query),
    [snapshot, kind, collection, query],
  );
  const collections = useMemo(
    () => snapshot?.collections ?? memoryCollections(snapshot?.sources ?? []),
    [snapshot],
  );
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  async function load(append = false) {
    const version = ++loadVersion.current;
    const options = {
      limit: 100,
      q: debouncedQuery,
      ...(kind === "all" ? {} : { kind }),
      ...(collection ? { collection } : {}),
    };
    try {
      if (append) setPaging(true);
      let next = await client.snapshot({
        ...options,
        ...(append && snapshot?.nextCursor
          ? { cursor: snapshot.nextCursor }
          : {}),
      });
      let all =
        append && snapshot
          ? [...snapshot.sources, ...next.sources]
          : next.sources;
      if (!append)
        for (
          let page = 1;
          page < pageCount.current && next.hasMore && next.nextCursor;
          page++
        ) {
          next = await client.snapshot({ ...options, cursor: next.nextCursor });
          all = [...all, ...next.sources];
          if (!live.current || version !== loadVersion.current) return false;
        }
      const seen = new Set<string>();
      all = all
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .slice(0, 1000);
      if (live.current && version === loadVersion.current) {
        if (append) pageCount.current = Math.min(10, pageCount.current + 1);
        setSnapshot({ ...next, sources: all });
        setSource((current) => {
          if (!current) return null;
          const updated = all.find((item) => item.id === current.id);
          return updated?.revision === current.revision
            ? { ...current, ingestion: updated.ingestion }
            : current;
        });
        setError(null);
      }
      return true;
    } catch (failure) {
      if (live.current && version === loadVersion.current)
        setError(safeMemoryMessage(failure));
      return false;
    } finally {
      if (live.current && version === loadVersion.current) {
        setLoading(false);
        setPaging(false);
      }
    }
  }
  useEffect(() => {
    live.current = true;
    pageCount.current = 1;
    setReaderBusy(false);
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live.current = false;
      loadVersion.current++;
      selectionVersion.current++;
      clearInterval(timer);
    };
  }, [client, debouncedQuery, kind, collection]);
  async function openSource(id: string) {
    const version = ++selectionVersion.current;
    setReaderBusy(true);
    setSource(null);
    setDeletePrompt(false);
    setView("library");
    try {
      const next = await client.getSource(id);
      if (live.current && version === selectionVersion.current) setSource(next);
    } catch (failure) {
      if (live.current && version === selectionVersion.current)
        setError(safeMemoryMessage(failure));
    } finally {
      if (live.current && version === selectionVersion.current)
        setReaderBusy(false);
    }
  }
  async function useSource() {
    if (!source || actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      await onUseInChat?.([source.id]);
    } catch (failure) {
      if (live.current) setError(safeMemoryMessage(failure));
    } finally {
      if (live.current) setActionBusy(false);
    }
  }
  async function removeSource() {
    if (!source || actionBusy) return;
    const id = source.id;
    const selection = selectionVersion.current;
    setActionBusy(true);
    setError(null);
    try {
      await client.deleteSource(id);
      if (live.current) {
        setSource((current) => (current?.id === id ? null : current));
        if (selection === selectionVersion.current) {
          selectionVersion.current++;
          setReaderBusy(false);
          setDeletePrompt(false);
        }
        await load();
      }
    } catch (failure) {
      if (live.current) setError(safeMemoryMessage(failure));
    } finally {
      if (live.current) setActionBusy(false);
    }
  }
  async function jobAction(id: string, action: "retry" | "cancel") {
    if (actionBusy || !client.actJob) return;
    setActionBusy(true);
    setError(null);
    try {
      await client.actJob(id, action);
      if (live.current) await load();
    } catch (failure) {
      if (live.current) setError(safeMemoryMessage(failure));
    } finally {
      if (live.current) setActionBusy(false);
    }
  }
  function navigate(next: typeof view) {
    setView(next);
    setDeletePrompt(false);
  }
  const title = {
    library: "Library",
    memory: "Memory",
    compare: "Compare engines",
    activity: "Learning activity",
  }[view];
  const subtitle = {
    library: "The originals you keep. The knowledge you build.",
    memory: "What your sources have taught your memory.",
    compare: "Two perspectives on the same knowledge.",
    activity: "Follow each source from import to usable memory.",
  }[view];
  return (
    <section
      className="mw"
      style={{ ...workspaceStyle, position: "relative" }}
      aria-label="Memory and Sources"
    >
      <aside className="mw-sidebar">
        <div className="mw-brand" style={headingStyle}>
          <MemoryIcon name="memory" size={25} />
          <span>Memory</span>
        </div>
        <nav aria-label="Memory workspace">
          <button
            className="mw-nav"
            aria-current={view === "library" ? "page" : undefined}
            onClick={() => navigate("library")}
            aria-label="Library"
          >
            <MemoryIcon name="library" />
            <span className="mw-nav-label">Library</span>
            <span className="mw-nav-count">
              {snapshot?.totalSources ?? snapshot?.sources.length ?? 0}
            </span>
          </button>
          <button
            className="mw-nav"
            aria-current={view === "memory" ? "page" : undefined}
            onClick={() => navigate("memory")}
            aria-label="Memory"
          >
            <MemoryIcon name="memory" />
            <span className="mw-nav-label">Memory</span>
          </button>
          <button
            className="mw-nav"
            aria-current={view === "compare" ? "page" : undefined}
            onClick={() => navigate("compare")}
            aria-label="Compare engines"
          >
            <MemoryIcon name="compare" />
            <span className="mw-nav-label">Compare engines</span>
          </button>
          <button
            className="mw-nav"
            aria-current={view === "activity" ? "page" : undefined}
            onClick={() => navigate("activity")}
            aria-label="Learning activity"
          >
            <MemoryIcon name="activity" />
            <span className="mw-nav-label">Activity</span>
          </button>
        </nav>
        <div className="mw-collections">
          <p className="mw-sidebar-label">Collections</p>
          <button
            className="mw-collection"
            aria-pressed={collection === null}
            onClick={() => {
              setCollection(null);
              navigate("library");
            }}
          >
            All sources
            <span>
              {snapshot?.totalSources ?? snapshot?.sources.length ?? 0}
            </span>
          </button>
          {snapshot?.collectionsTruncated && (
            <p className="mw-hint" style={{ padding: "0 12px" }}>
              Showing the first 200 collections.
            </p>
          )}
          {collections.map((item) => (
            <button
              className="mw-collection"
              key={item.name}
              aria-pressed={collection === item.name}
              onClick={() => {
                setCollection(item.name);
                navigate("library");
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.name}
              </span>
              <span>{item.count}</span>
            </button>
          ))}
        </div>
        {onOpenFiles && (
          <button
            className="mw-nav"
            onClick={onOpenFiles}
            aria-label="Open Files"
          >
            <MemoryIcon name="document" />
            <span className="mw-nav-label">Files & shared drives</span>
          </button>
        )}
        <div className="mw-owner">
          <strong
            style={{
              display: "block",
              color: "var(--mw-primary)",
              marginBottom: 4,
            }}
          >
            Your knowledge, your VPS
          </strong>
          Originals stay yours. Cloud models can help your memory learn.
        </div>
      </aside>
      <main className="mw-main">
        <header className="mw-header">
          <div>
            <h1 style={headingStyle}>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="mw-actions">
            <button className="mw-button" onClick={() => setEditor("new")}>
              <MemoryIcon name="plus" size={16} />
              New note
            </button>
            <button
              className="mw-button mw-button-primary"
              onClick={() => setImporting(true)}
            >
              <MemoryIcon name="upload" size={16} />
              Import
            </button>
          </div>
        </header>
        {error && (
          <div className="mw-alert" role="alert">
            {error}{" "}
            <button className="mw-button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {view === "library" ? (
          <MemoryLibrary
            query={query}
            setQuery={setQuery}
            kind={kind}
            setKind={setKind}
            loading={loading}
            snapshot={snapshot}
            setImporting={setImporting}
            sources={sources}
            collection={collection}
            source={source}
            openSource={openSource}
            paging={paging}
            load={load}
            readerBusy={readerBusy}
            onBack={() => {
              selectionVersion.current++;
              setSource(null);
            }}
            canUseInChat={Boolean(onUseInChat)}
            actionBusy={actionBusy}
            useSource={useSource}
            setEditor={setEditor}
            setDeletePrompt={setDeletePrompt}
            deletePrompt={deletePrompt}
            removeSource={removeSource}
          />
        ) : view === "memory" || view === "compare" ? (
          <MemorySearch
            key={view}
            client={client}
            compare={view === "compare"}
            onOpenSource={(id) => void openSource(id)}
            onUseInChat={onUseInChat}
          />
        ) : (
          <div className="mw-panel">
            <p className="mw-hint">
              Each engine learns independently from the same source revisions.
              Ready means that ingestion job completed; it does not rate memory
              quality.
            </p>
            {snapshot?.jobs.length ? (
              snapshot.jobs.map((job) => (
                <div className="mw-activity-row" key={job.id}>
                  <MemoryIcon name="activity" />
                  <div style={{ flex: 1 }}>
                    <strong>
                      {snapshot.sources.find((item) => item.id === job.sourceId)
                        ?.title ?? "Removed source"}
                    </strong>
                    <p className="mw-hint" style={{ margin: "4px 0 0" }}>
                      {job.engine === "hindsight" ? "Hindsight" : "OpenViking"}{" "}
                      · revision {job.revision} ·{" "}
                      {job.operation === "delete" ? "Removal" : "Ingestion"}
                    </p>
                  </div>
                  <span className="mw-status">
                    <span className="mw-dot" data-status={job.status} />
                    {memoryStatusLabel[job.status]}
                  </span>
                  {client.actJob &&
                    (job.status === "failed" ||
                      (job.status === "pending" &&
                        job.operation === "upsert")) && (
                      <button
                        className="mw-button"
                        disabled={actionBusy}
                        onClick={() =>
                          void jobAction(
                            job.id,
                            job.status === "failed" ? "retry" : "cancel",
                          )
                        }
                      >
                        {job.status === "failed" ? "Retry" : "Cancel"}
                      </button>
                    )}
                </div>
              ))
            ) : (
              <MemoryEmpty
                title="Learning starts with your sources"
                description="Import or edit a source to follow its progress here."
              />
            )}
          </div>
        )}
      </main>
      {editor && (
        <MemoryEditor
          source={editor === "edit" ? source : null}
          client={client}
          onClose={() => setEditor(null)}
          onSaved={async (saved) => {
            if (live.current) setSource(saved);
            if (!(await load())) throw new Error("reload_failed");
            if (live.current) {
              setView("library");
              setEditor(null);
            }
          }}
        />
      )}
      {importing && (
        <MemoryImport
          client={client}
          native={nativeImport}
          onClose={() => setImporting(false)}
          onImported={async () => {
            if (!(await load())) throw new Error("reload_failed");
            if (live.current) setImporting(false);
          }}
        />
      )}
    </section>
  );
}
