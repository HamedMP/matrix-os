import { MemoryIcon } from "./MemoryIcon.js";
import { MemoryEmpty } from "./MemoryEmpty.js";
import { headingStyle } from "./styles.js";
import {
  memoryStatusLabel,
  type MemorySource,
  type MemorySnapshot,
  type MemorySourceKind,
} from "./model.js";
type Props = {
  query: string;
  setQuery(value: string): void;
  kind: MemorySourceKind | "all";
  setKind(value: MemorySourceKind | "all"): void;
  loading: boolean;
  snapshot: MemorySnapshot | null;
  setImporting(value: boolean): void;
  sources: MemorySource[];
  collection: string | null;
  source: MemorySource | null;
  openSource(id: string): Promise<void>;
  paging: boolean;
  load(append?: boolean): Promise<boolean>;
  readerBusy: boolean;
  onBack(): void;
  canUseInChat: boolean;
  actionBusy: boolean;
  useSource(): Promise<void>;
  setEditor(value: "new" | "edit" | null): void;
  setDeletePrompt(value: boolean): void;
  deletePrompt: boolean;
  removeSource(): Promise<void>;
};
export function MemoryLibrary({
  query,
  setQuery,
  kind,
  setKind,
  loading,
  snapshot,
  setImporting,
  sources,
  collection,
  source,
  openSource,
  paging,
  load,
  readerBusy,
  onBack,
  canUseInChat,
  actionBusy,
  useSource,
  setEditor,
  setDeletePrompt,
  deletePrompt,
  removeSource,
}: Props) {
  return (
    <>
      <div className="mw-toolbar">
        <div className="mw-search">
          <MemoryIcon name="search" size={16} />
          <input
            type="search"
            aria-label="Search Library"
            placeholder="Search your originals…"
            value={query}
            maxLength={500}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div aria-label="Source types">
          {(["all", "note", "email", "calendar", "document"] as const).map(
            (value) => (
              <button
                className="mw-filter"
                key={value}
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {value === "all"
                  ? "All"
                  : value === "note"
                    ? "Notes"
                    : value === "email"
                      ? "Mail"
                      : value === "calendar"
                        ? "Calendar"
                        : "Docs"}
              </button>
            ),
          )}
        </div>
      </div>
      <div className="mw-body">
        {loading ? (
          <MemoryEmpty
            title="Opening your Library"
            description="Loading your sources and engine status."
          />
        ) : (snapshot?.totalSources ?? snapshot?.sources.length) === 0 ? (
          <MemoryEmpty
            title="Your knowledge starts here"
            description="Bring in a few notes, emails or calendar events. Keep your originals in Library, and explore what each memory engine learns."
            action={
              <button
                className="mw-button mw-button-primary"
                onClick={() => setImporting(true)}
              >
                Import your first sources
              </button>
            }
          />
        ) : (
          <>
            <div className="mw-list" aria-label="Library sources">
              <p className="mw-list-caption">
                {sources.length} of{" "}
                {snapshot?.filteredSources ?? sources.length} sources
                {collection ? ` · ${collection}` : ""}
              </p>
              {sources.map((item) => (
                <button
                  key={item.id}
                  className="mw-source"
                  aria-pressed={source?.id === item.id}
                  onClick={() => void openSource(item.id)}
                >
                  <span className="mw-source-heading">
                    <MemoryIcon name={item.kind} size={16} />
                    {item.title}
                  </span>
                  <span className="mw-source-excerpt">{item.preview}</span>
                  <span className="mw-source-meta">
                    <span>{item.collection}</span>
                    <span>·</span>
                    <span>{item.updatedAt.slice(0, 10)}</span>
                  </span>
                </button>
              ))}
              {snapshot?.hasMore && (
                <button
                  className="mw-button"
                  style={{ width: "100%", marginTop: 12 }}
                  disabled={paging || sources.length >= 1000}
                  onClick={() => void load(true)}
                >
                  {paging
                    ? "Loading…"
                    : sources.length >= 1000
                      ? "Narrow your search to see more"
                      : "Load more sources"}
                </button>
              )}
              {!sources.length && (
                <p className="mw-hint" style={{ padding: 12 }}>
                  No matching originals. Try another search or collection.
                </p>
              )}
            </div>
            {readerBusy ? (
              <MemoryEmpty
                title="Opening source"
                description="Loading the original."
              />
            ) : source ? (
              <article className="mw-reader">
                <button
                  className="mw-button mw-back"
                  style={{ display: "none", marginBottom: 20 }}
                  onClick={() => {
                    onBack();
                  }}
                >
                  Back to Library
                </button>
                <header className="mw-reader-header">
                  <div className="mw-eyebrow">
                    <MemoryIcon name={source.kind} size={16} />
                    {source.kind === "note"
                      ? "Note"
                      : source.kind === "email"
                        ? "Email"
                        : source.kind === "calendar"
                          ? "Calendar event"
                          : "Document"}
                    <span>·</span>
                    {source.collection}
                  </div>
                  <h2 style={headingStyle}>{source.title}</h2>
                  <div className="mw-actions">
                    {canUseInChat && (
                      <button
                        className="mw-button mw-button-primary"
                        disabled={actionBusy}
                        onClick={() => void useSource()}
                      >
                        <MemoryIcon name="chat" size={16} />
                        Use in Chat
                      </button>
                    )}
                    {source.kind === "note" && (
                      <button
                        className="mw-button"
                        onClick={() => setEditor("edit")}
                      >
                        Edit note
                      </button>
                    )}
                    <button
                      className="mw-button mw-button-danger"
                      disabled={actionBusy}
                      onClick={() => setDeletePrompt(true)}
                    >
                      Delete
                    </button>
                  </div>
                  {deletePrompt && (
                    <div
                      role="alert"
                      className="mw-alert"
                      style={{ margin: "18px 0 0" }}
                    >
                      Delete this original and request removal from both
                      engines?{" "}
                      <div className="mw-actions" style={{ marginTop: 12 }}>
                        <button
                          className="mw-button mw-button-danger"
                          disabled={actionBusy}
                          onClick={() => void removeSource()}
                        >
                          Delete source
                        </button>
                        <button
                          className="mw-button"
                          onClick={() => setDeletePrompt(false)}
                        >
                          Keep source
                        </button>
                      </div>
                    </div>
                  )}
                </header>
                <p className="mw-prose">{source.content}</p>
                <footer className="mw-engine-status">
                  <span>Original · revision {source.revision}</span>
                  {(["hindsight", "openviking"] as const).map((engine) => (
                    <span className="mw-status" key={engine}>
                      <span
                        className="mw-dot"
                        data-status={source.ingestion[engine]}
                      />
                      {engine === "hindsight" ? "Hindsight" : "OpenViking"}:{" "}
                      <span>{memoryStatusLabel[source.ingestion[engine]]}</span>
                    </span>
                  ))}
                </footer>
              </article>
            ) : (
              <MemoryEmpty
                title="Room to think"
                description="Choose an original to read, edit a note, or bring its context into a Chat."
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
